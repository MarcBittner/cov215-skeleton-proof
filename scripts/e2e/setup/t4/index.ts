import fs from "node:fs"
import path from "node:path"
import { pathToFileURL } from "node:url"
import { ARTIFACTS, FILES } from "../../contract/constants.js"
import type { Selection } from "../../contract/types.js"
import { issueKeyOf } from "../t2/base-preview.js"
import type { SetupLiveInputs, SetupStep, SetupStepContext } from "../t2/step.js"
import { realExec, runAiStep, runSelectStep, type AiStepInput, type AiStepResult, type ChildEnv, type Exec, type SelectStepInput } from "./select-step.js"

export { buildAiInput, widenWithGenerated, type AiInputParts, type AiMapTest } from "../../select/ai-input.js"

export { mergeRunRecords, runAiStep, runSelectStep, type AiStepInput, type SelectStepInput } from "./select-step.js"

export const AI_INPUT_FILE = "ai-input.json"

const CHILD_ENV_KEYS = ["PATH", "HOME", "TMPDIR", "RUNNER_TEMP", "LANG", "NODE_OPTIONS"] as const

export function childEnv(env: SetupLiveInputs["env"], extra: Record<string, string | undefined> = {}): ChildEnv {
  const out: ChildEnv = {}
  for (const k of CHILD_ENV_KEYS) if (env[k] !== undefined) out[k] = env[k]
  for (const [k, v] of Object.entries(extra)) if (v !== undefined && v !== "") out[k] = v
  return out
}

export function gitEnv(env: SetupLiveInputs["env"]): ChildEnv {
  const token = env.GITHUB_TOKEN
  const auth = token
    ? {
        GIT_CONFIG_COUNT: "1",
        GIT_CONFIG_KEY_0: `http.${env.GITHUB_SERVER_URL ?? "https://github.com"}/.extraheader`,
        GIT_CONFIG_VALUE_0: `AUTHORIZATION: basic ${Buffer.from(`x-access-token:${token}`).toString("base64")}`,
      }
    : {}
  return childEnv(env, { GIT_TERMINAL_PROMPT: "0", ...auth })
}

export function selectInputFor(ctx: SetupStepContext, live: SetupLiveInputs): SelectStepInput {
  return {
    harnessDir: live.harnessDir,
    harnessSha: live.harnessSha,
    repoDir: live.harnessDir,
    stagingSha: live.harnessSha,
    pr: live.pr!,
    prSha: live.prSha!,
    prKey: issueKeyOf(live.headRef ?? "", live.prTitle ?? ""),
    setupRunId: ctx.setupRunId,
    outDir: path.join(ctx.workDir, "t4"),
    aiInputPath: path.join(ctx.workDir, "t4", AI_INPUT_FILE),
    selectMode: live.env.E2E_SELECT_MODE,
    now: live.now,
    map: live.map ?? { dir: null, mapSha: null, fullRun: null },
    precompiled: true,
    fetchHistory: true,
    gitEnv: gitEnv(live.env),
    childEnv: childEnv(live.env),
  }
}

export async function writeRecords(records: readonly unknown[], dir: string): Promise<number> {
  fs.rmSync(dir, { recursive: true, force: true })
  fs.mkdirSync(dir, { recursive: true })
  records.forEach((r, i) => fs.writeFileSync(path.join(dir, `${String(i).padStart(6, "0")}.json`), JSON.stringify(r)))
  return records.length
}

export async function liveAi(ctx: SetupStepContext, live: SetupLiveInputs, selection: Selection, exec: Exec): Promise<AiStepResult | null> {
  const outDir = path.join(ctx.workDir, "t4", "ai")
  const inputPath = path.join(ctx.workDir, "t4", AI_INPUT_FILE)
  if (selection.fullRun !== null || !fs.existsSync(inputPath)) return null
  const aiInput = JSON.parse(fs.readFileSync(inputPath, "utf8")) as unknown
  const today = path.join(outDir, "today")
  const mapRuns = path.join(outDir, "map-runs")
  await writeRecords(await live.records(), today)
  await writeRecords(live.mapRecords ? await live.mapRecords() : [], mapRuns)
  return runAiStep(
    {
      harnessDir: live.harnessDir,
      setupRunId: ctx.setupRunId,
      aiInput,
      recordDirs: [today, mapRuns],
      outDir,
      env: childEnv(live.env, { ANTHROPIC_API_KEY: live.env.ANTHROPIC_API_KEY, E2E_SELECT_MODE: live.env.E2E_SELECT_MODE }),
    },
    exec,
  )
}

export interface LiveSelection {
  selection: Selection
  aiAdditions: string[]
}

export async function liveSelectStep(ctx: SetupStepContext, live: SetupLiveInputs, exec: Exec = realExec, log: (line: string) => void = console.log): Promise<LiveSelection> {
  const r = runSelectStep(selectInputFor(ctx, live), exec)
  log(r.fallback ? `select: full run (${r.fallback})` : `select: ${r.selection.fullRun ?? `${r.selection.tests.length} tests`}`)
  await live.stage(ARTIFACTS.commentRows("t4"), { [FILES.commentRows("t4")]: fs.readFileSync(r.rowsPath, "utf8") })
  const det: LiveSelection = { selection: r.selection, aiAdditions: [] }
  if (r.fallback) return det
  let ai: AiStepResult | null
  try {
    ai = await liveAi(ctx, live, r.selection, exec)
  } catch (e) {
    log(`select-ai: not called (${(e as Error).message})`)
    return det
  }
  if (!ai) return det
  log(`select-ai: ${ai.outcome}, ${ai.additions.length} addition(s)${ai.runAdditions ? "; det+ai additions run as the ai shard" : ""}`)
  await live.stage(ARTIFACTS.selectAi, {
    [FILES.selectAi]: `${JSON.stringify({ setupRunId: ctx.setupRunId, ai: ai.record, runRecordAi: ai.runRecordAi, outcome: ai.outcome, additions: ai.additions })}\n`,
  })
  return { selection: r.selection, aiAdditions: ai.runAdditions ? [...ai.additions] : [] }
}

export async function liveSelect(ctx: SetupStepContext, live: SetupLiveInputs, exec: Exec = realExec, log: (line: string) => void = console.log): Promise<Selection> {
  return (await liveSelectStep(ctx, live, exec, log)).selection
}

export const runSetupStep: SetupStep = async (ctx) => {
  const live = ctx.live
  if (ctx.mode !== "live" || !live) return { task: "t4", status: "stub" }
  if (ctx.kind !== "pr" || live.pr === null || !live.prSha) return { task: "t4", status: "skipped" }
  try {
    const r = await liveSelectStep(ctx, live)
    return { task: "t4", status: "ok", output: r.selection, ...(r.aiAdditions.length ? { aiAdditions: r.aiAdditions } : {}) }
  } catch (e) {
    console.log(`::warning title=e2e select::the select step failed; setup falls back to a full run (${(e as Error).message})`)
    return { task: "t4", status: "ok" }
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  const [step, file] = process.argv.slice(2)
  const args = file ? JSON.parse(fs.readFileSync(file, "utf8")) : null
  if (step === "select" && args) {
    const r = runSelectStep(args as SelectStepInput)
    console.log(r.fallback ? `::warning title=e2e select::full run: ${r.fallback}` : `selection: ${r.selection.fullRun ?? `${r.selection.tests.length} tests`}`)
  } else if (step === "ai" && args) {
    const r = runAiStep({ ...(args as AiStepInput), env: process.env })
    console.log(`${r.fellBack ? "::warning title=select-ai::" : ""}AI step: ${r.outcome}, ${r.additions.length} additions`)
  } else {
    console.error("usage: index.js select|ai <args.json>")
    process.exitCode = 2
  }
}
