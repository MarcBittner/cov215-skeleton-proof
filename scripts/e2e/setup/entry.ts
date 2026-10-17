import { createHash } from "node:crypto"
import { existsSync, mkdirSync, writeFileSync } from "node:fs"
import { dirname, join } from "node:path"
import { pathToFileURL } from "node:url"

import { CONTRACT_VERSION, FILES, newRunKey, runTagFor } from "../contract/constants.js"
import { validateRunRequest, validateSetupPlan, validateShardPlan } from "../contract/formats.js"
import type { RunKind, SetupPlan } from "../contract/types.js"
import { type GitHub, env, gitHubClient, output, readJsonFile, summary } from "../lib/github.js"
import { planShards, planSummary, shardPlanDoc } from "../plan-shards.mjs"
import { catalogueFromList } from "../report/id.mjs"
import { readSetupPlan } from "../report/cli.js"
import { FIXTURE_CASES, KINDS, type FixtureCase, deploymentKey, parseSetupInputs, runTaskSteps } from "./t2/skeleton.js"
import type { SetupStepContext, SetupTask } from "./t2/step.js"
import { runSetupStep as t3 } from "./t3/index.js"
import { runSetupStep as t4 } from "./t4/index.js"
import { runSetupStep as t5 } from "./t5/index.js"

export const LIVE_SETUP_VARIABLE = "E2E_LIVE_SETUP"
export const FIXTURE_FILE = "fixture.json"
export const FIXTURE_PROJECT = "fixture"
export const FIXTURE_SPECS: [string, string[]][] = [
  ["fixture/dashboard.spec.ts", ["dashboard", "loads the dashboard"]],
  ["fixture/dashboard.spec.ts", ["dashboard", "lists projects"]],
  ["fixture/rfi.spec.ts", ["RFIs", "creates an RFI"]],
  ["fixture/rfi.spec.ts", ["RFIs", "answers an RFI"]],
  ["fixture/co.spec.ts", ["change orders", "submits a change order"]],
  ["fixture/co.spec.ts", ["change orders", "approves a change order"]],
]
export const FIXTURE_DEPLOYMENT: SetupPlan["deployment"] = {
  github_deployment_id: 1,
  vercel_deployment_id: "dpl_fixture000000",
  url: "https://fixture.invalid",
  convex_deployment: "fixture-preview-1",
  convex_url: "https://fixture-preview-1.convex.cloud",
}

export interface FixtureJson {
  case: FixtureCase
  fan_in: boolean
}

export interface LiveSetupContext {
  kind: RunKind
  setupRunId: string
  workDir: string
  bundleDir: string
  controlDir: string
  sha: string
  branch: string
  event: string
  eventPath: string | null
  gh: GitHub
}

export type LiveSetup = (ctx: LiveSetupContext) => Promise<{ dispatch: boolean }>

export const loadLiveSetup = async (): Promise<LiveSetup> => {
  const mod = (await import(new URL("./t2/live.js", import.meta.url).href)) as { runLiveSetup?: LiveSetup }
  if (typeof mod.runLiveSetup !== "function") throw new Error("scripts/e2e/setup/t2/live has no runLiveSetup export")
  return mod.runLiveSetup
}

const STEPS = { t3, t4, t5 }

export function fixtureCatalogue() {
  const byFile = new Map<string, { title: string; specs: { title: string; file: string; line: number; tests: { projectName: string }[] }[]; suites: unknown[] }>()
  for (const [file, titles] of FIXTURE_SPECS) {
    if (!byFile.has(file)) byFile.set(file, { title: file, specs: [], suites: [] })
    const root = byFile.get(file)!
    const [describe, title] = titles
    let suite = root.suites.find((s) => (s as { title: string }).title === describe) as { title: string; specs: unknown[] } | undefined
    if (!suite) {
      suite = { title: describe, specs: [] }
      root.suites.push(suite)
    }
    suite.specs.push({ title, file, line: 1, tests: [{ projectName: FIXTURE_PROJECT }] })
  }
  return catalogueFromList({ suites: [...byFile.values()] })
}

export function fixtureRunJson(args: {
  setupRunId: string
  runKey: string
  kind: RunKind
  pr: number | null
  sha: string
  branch: string
  createdAt: string
}): SetupPlan {
  const { setupRunId, runKey, kind, pr, sha, branch, createdAt } = args
  if (kind === "pr" && pr === null) throw new Error("a fixture run of kind pr needs fixture_pr (a pull request number in this repository)")
  return {
    schema_version: CONTRACT_VERSION,
    setup_run_id: setupRunId,
    run_tag: runTagFor(setupRunId),
    workflow_sha: sha,
    created_at: createdAt,
    kind,
    fixture: true,
    select_mode: "full",
    pr,
    pr_sha: sha,
    base_sha: null,
    branch,
    deployment: FIXTURE_DEPLOYMENT,
    gate: kind === "gate" ? { ref: "artifact:fixture-gate", path: "e2e/fixture/gate.spec.ts", sha256: createHash("sha256").update("fixture").digest("hex") } : null,
    mail: { contained: false, effective_catch_all: null },
    tenants: [],
    dispatches: [{ run_key: runKey, role: "main", bundle_artifact: "e2e-bundle", ref: branch, dispatched_run_id: null, dispatched_at: null }],
    supersedes: [],
    state: "planned",
    reason: null,
  }
}

function checked(run: SetupPlan) {
  const result = validateSetupPlan(run)
  if (!result.ok) throw new Error(`run.json is invalid: ${result.errors.join("; ")}`)
  return result.value
}

export async function prepareFixture(args: { outDir: string; setupRunId: string; kind: RunKind; fixtureCase: FixtureCase; pr: number | null; sha: string; branch: string; now?: Date }) {
  const { outDir, setupRunId, kind, fixtureCase, pr, sha, branch } = args
  const ctx: SetupStepContext = { kind, mode: "fixture", setupRunId, workDir: outDir }
  const steps = await runTaskSteps(ctx, async (task: SetupTask) => ({ runSetupStep: STEPS[task] }))
  const runKey = newRunKey()
  const run = checked(fixtureRunJson({ setupRunId, runKey, kind, pr, sha, branch, createdAt: (args.now ?? new Date()).toISOString() }))
  const catalogue = fixtureCatalogue()
  const plan = planShards({ catalogue, forceFullReason: "fixture run" })
  const planned = validateShardPlan(shardPlanDoc(plan, catalogue, { setupRunId, runKey }))
  if (!planned.ok) throw new Error(`plan.json is invalid: ${planned.errors.join("; ")}`)
  const doc = planned.value
  const lineOf = new Map(catalogue.map((t: { id: string; listLine: string }) => [t.id, t.listLine]))
  mkdirSync(outDir, { recursive: true })
  writeFileSync(join(outDir, FILES.setupPlan), JSON.stringify(run, null, 2) + "\n")
  writeFileSync(join(outDir, FILES.shardPlan), JSON.stringify(doc, null, 2) + "\n")
  writeFileSync(join(outDir, "plan-summary.json"), JSON.stringify(planSummary(plan), null, 2) + "\n")
  for (const s of plan.shards) writeFileSync(join(outDir, `shard-${s.shard}.txt`), s.ids.map((id: string) => lineOf.get(id)).join("\n") + "\n")
  const fixture: FixtureJson = { case: fixtureCase, fan_in: fixtureCase !== "no-fan-in" }
  writeFileSync(join(outDir, FIXTURE_FILE), JSON.stringify(fixture, null, 2) + "\n")
  return { run, doc, steps }
}

export async function dispatchRun(gh: GitHub, planDir: string, now: () => Date = () => new Date()) {
  const run = readSetupPlan(planDir)
  const main = run.dispatches.find((d) => d.role === "main")
  if (!main) throw new Error("run.json has no main dispatch")
  if (main.dispatched_run_id) throw new Error(`run.json already records dispatched run ${main.dispatched_run_id}`)
  const inputs = { setup_run_id: run.setup_run_id, run_key: main.run_key }
  const request = validateRunRequest(inputs)
  if (!request.ok) throw new Error(`run request is invalid: ${request.errors.join("; ")}`)
  const { status, body } = await gh.send<{ workflow_run_id?: number; html_url?: string }>("POST", "/actions/workflows/e2e-run.yml/dispatches", { ref: main.ref, inputs }, "2026-03-10")
  if (!body?.workflow_run_id) throw new Error(`dispatch of e2e-run.yml returned ${status} with no workflow_run_id`)
  const updated: SetupPlan = {
    ...run,
    state: "dispatched",
    dispatches: run.dispatches.map((d) => (d === main ? { ...d, dispatched_run_id: String(body.workflow_run_id), dispatched_at: now().toISOString() } : d)),
  }
  writeFileSync(join(planDir, FILES.setupPlan), JSON.stringify(checked(updated), null, 2) + "\n")
  return { runId: String(body.workflow_run_id), htmlUrl: body.html_url ?? null, ref: main.ref }
}

const pick = <T extends string>(value: string | undefined, allowed: readonly T[], fallback: T): T => {
  if (!value) return fallback
  if (!(allowed as readonly string[]).includes(value)) throw new Error(`unknown value "${value}"; expected one of ${allowed.join(", ")}`)
  return value as T
}

export function parsePr(value: string | undefined) {
  if (!value) return null
  if (!/^[1-9][0-9]{0,9}$/.test(value)) throw new Error(`fixture_pr "${value}" is not a pull request number`)
  return Number(value)
}

export async function main(argv: string[], source: Record<string, string | undefined> = process.env, deps: { gh?: GitHub; liveSetup?: () => Promise<LiveSetup> } = {}) {
  const [cmd, dir] = argv
  const client = () => deps.gh ?? gitHubClient({ repo: env("GITHUB_REPOSITORY", source), token: env("GH_TOKEN", source), apiUrl: source.GITHUB_API_URL })
  switch (cmd) {
    case "resolve": {
      const event = env("GITHUB_EVENT_NAME", source)
      const inputs = parseSetupInputs(event, { mode: source.INPUT_MODE, kind: source.INPUT_KIND, fixture_case: source.INPUT_FIXTURE_CASE })
      const payload = source.GITHUB_EVENT_PATH && existsSync(source.GITHUB_EVENT_PATH) ? readJsonFile<{ pull_request?: { number: number } }>(source.GITHUB_EVENT_PATH) : {}
      const pr = payload.pull_request?.number ?? null
      const live = inputs.mode === "live" && source.LIVE_SETUP === "true"
      output(
        {
          mode: inputs.mode,
          kind: inputs.kind,
          fixture_case: inputs.fixtureCase,
          fixture_pr: inputs.mode === "fixture" ? String(parsePr(source.INPUT_FIXTURE_PR) ?? "") : "",
          deployment: deploymentKey(inputs, env("GITHUB_RUN_ID", source), pr),
          live: String(live),
        },
        source,
      )
      return
    }
    case "prepare": {
      const setupRunId = env("GITHUB_RUN_ID", source)
      const mode = pick(source.MODE, ["fixture", "live"] as const, "fixture")
      const kind = pick(source.KIND, KINDS, "pr")
      if (mode === "live") {
        if (source.LIVE !== "true") {
          summary(`## e2e setup (${kind})\n\nLive setup is off: repository variable \`${LIVE_SETUP_VARIABLE}\` is not \`true\`. Nothing was dispatched.`, source)
          output({ dispatch: "false" }, source)
          return
        }
        const runLiveSetup = await (deps.liveSetup ?? loadLiveSetup)()
        const result = await runLiveSetup({
          kind,
          setupRunId,
          workDir: dir,
          bundleDir: join(dirname(dir), "bundle"),
          controlDir: join(dirname(dir), "control"),
          sha: env("GITHUB_SHA", source),
          branch: env("GITHUB_REF_NAME", source),
          event: env("GITHUB_EVENT_NAME", source),
          eventPath: source.GITHUB_EVENT_PATH ?? null,
          gh: client(),
        })
        output({ dispatch: String(result.dispatch) }, source)
        return
      }
      const fixtureCase = pick(source.FIXTURE_CASE, FIXTURE_CASES, "pass")
      const { run, doc, steps } = await prepareFixture({
        outDir: dir,
        setupRunId,
        kind,
        fixtureCase,
        pr: parsePr(source.FIXTURE_PR),
        sha: env("GITHUB_SHA", source),
        branch: env("GITHUB_REF_NAME", source),
      })
      const tests = doc.shards.reduce((n, s) => n + s.tests.length, 0)
      summary(
        [
          `## e2e setup (fixture, kind ${run.kind}, case ${fixtureCase}${run.pr ? `, PR #${run.pr}` : ""})`,
          "",
          `Planned ${tests} tests in ${doc.shards.length} shards at \`${run.pr_sha}\` on \`${run.branch}\`.`,
          "",
          ...steps.map((s) => `- ${s.task}: ${s.status}`),
        ].join("\n"),
        source,
      )
      output({ dispatch: "true" }, source)
      return
    }
    case "dispatch": {
      const { runId, htmlUrl, ref } = await dispatchRun(client(), dir)
      summary(`Dispatched e2e-run.yml at \`${ref}\`: run [${runId}](${htmlUrl ?? ""}).`, source)
      output({ run_id: runId }, source)
      return
    }
    default:
      throw new Error(`unknown command "${cmd}"`)
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  main(process.argv.slice(2)).catch((err: unknown) => {
    console.error(err instanceof Error ? err.message : err)
    process.exit(1)
  })
}
