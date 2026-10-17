import { spawnSync } from "node:child_process"
import fs from "node:fs"
import path from "node:path"
import { validateSelection } from "../../contract/formats.js"
import type { CommentRows, Selection } from "../../contract/types.js"
import { canonicalJson } from "../../contract/validate.js"
import { MAX_DISTANCE as MAP_DISTANCE } from "../../select/map-lookup.js"
import { buildRows, errorRows } from "../../select/rows.js"

export const DIST_TSCONFIG = "scripts/e2e/tsconfig.dist.json"
export const DIST_DIR = "scripts/e2e/dist"
export const SELECT_ENTRY = `${DIST_DIR}/scripts/e2e/select/select.js`
export const AI_ENTRY = `${DIST_DIR}/scripts/e2e/setup/t4/select-ai/main.js`
export const COMPILE_TIMEOUT_MS = 180_000
export const SELECT_TIMEOUT_MS = 60_000
export const AI_TIMEOUT_MS = 150_000
export const HISTORY_DEPTH = 100
export const HISTORY_DEEPEN: readonly number[] = [400, 1600]

export interface ExecResult {
  code: number | null
  timedOut: boolean
  stdout: string
  stderr: string
}

export type ChildEnv = Record<string, string | undefined>

export type Exec = (cmd: string, args: string[], opts: { cwd: string; timeoutMs: number; env?: ChildEnv }) => ExecResult

export const realExec: Exec = (cmd, args, opts) => {
  const r = spawnSync(cmd, args, { cwd: opts.cwd, timeout: opts.timeoutMs, encoding: "utf8", env: (opts.env ?? process.env) as NodeJS.ProcessEnv, maxBuffer: 64 * 1024 * 1024 })
  const timedOut = (r.error as NodeJS.ErrnoException | undefined)?.code === "ETIMEDOUT" || r.signal === "SIGTERM"
  return { code: r.status, timedOut, stdout: r.stdout ?? "", stderr: r.stderr ?? (r.error ? String(r.error) : "") }
}

export interface SelectStepInput {
  harnessDir: string
  harnessSha: string
  repoDir: string
  stagingSha: string
  pr: number
  prSha: string
  prKey: string | null
  setupRunId: string
  outDir: string
  selectMode: string | undefined
  now: string
  map: { dir: string | null; mapSha: string | null; fullRun: string | null; candidatesDir?: string | null }
  aiInputPath?: string
  precompiled?: boolean
  fetchHistory?: boolean
  gitEnv?: ChildEnv
  childEnv?: ChildEnv
}

export interface SelectStepResult {
  selection: Selection
  rows: CommentRows
  selectionPath: string
  rowsPath: string
  fallback: string | null
}

const tail = (s: string) => s.trim().split("\n").slice(-3).join(" | ").slice(0, 300)

export function fallbackSelection(input: SelectStepInput, reason: string): Selection {
  return {
    schemaVersion: "1.0",
    harnessSha: input.harnessSha,
    pr: input.pr,
    baseSha: input.stagingSha,
    headSha: input.prSha,
    mapSha: null,
    mode: "full",
    rule: null,
    fullRun: reason.replace(/[\r\n]+/g, " ").slice(0, 500),
    tests: [],
    alwaysRun: [],
    unplaced: [],
    ignored: [],
    untestedVariants: [],
    changedWithoutFunctionalTest: [],
    catalogue: { functional: 0, screen: 0, snapshot: 0 },
    predictedDurationMs: 0,
    shardPlan: null,
  }
}

export function compileSelector(harnessDir: string, exec: Exec): string | null {
  const r = exec("npx", ["--no-install", "tsc", "-p", DIST_TSCONFIG], { cwd: harnessDir, timeoutMs: COMPILE_TIMEOUT_MS })
  if (r.timedOut) return "tsc compile timed out"
  if (r.code !== 0) return `tsc compile failed: ${tail(r.stdout || r.stderr)}`
  fs.mkdirSync(path.join(harnessDir, DIST_DIR), { recursive: true })
  fs.writeFileSync(path.join(harnessDir, DIST_DIR, "package.json"), `${JSON.stringify({ type: "module" })}\n`)
  return null
}

export function fetchHistory(input: SelectStepInput, exec: Exec): string | null {
  const opts = { cwd: input.repoDir, timeoutMs: SELECT_TIMEOUT_MS, env: input.gitEnv }
  const wants = ["origin", input.stagingSha, input.prSha]
  const first = exec("git", ["fetch", "--no-tags", `--depth=${HISTORY_DEPTH}`, ...wants], opts)
  if (first.code !== 0) return `history fetch failed: ${tail(first.stderr || first.stdout) || "git fetch failed"}`
  for (const deepen of [0, ...HISTORY_DEEPEN]) {
    if (deepen) {
      const more = exec("git", ["fetch", "--no-tags", `--deepen=${deepen}`, ...wants], opts)
      if (more.code !== 0) return `history fetch failed: ${tail(more.stderr || more.stdout) || "git fetch --deepen failed"}`
    }
    const base = exec("git", ["merge-base", input.stagingSha, input.prSha], opts)
    if (base.code === 0 && base.stdout.trim()) {
      const below = exec("git", ["fetch", "--no-tags", `--deepen=${MAP_DISTANCE + 1}`, ...wants], opts)
      return below.code === 0 ? null : `history fetch failed: ${tail(below.stderr || below.stdout) || "git fetch --deepen failed"}`
    }
  }
  return `no merge base of ${input.stagingSha} and ${input.prSha} within the fetched history`
}

export const NO_MAP_REASON = "map-fetch-failed: setup loaded no verified map"

function selectorRun(input: SelectStepInput, exec: Exec, selectionPath: string): { selection: Selection } | { fallback: string } {
  if (input.map.fullRun !== null) return { fallback: input.map.fullRun }
  if (input.map.dir === null || input.map.mapSha === null) return { fallback: NO_MAP_REASON }
  if (input.precompiled) {
    if (!fs.existsSync(path.join(input.harnessDir, SELECT_ENTRY))) return { fallback: `selector-error: ${SELECT_ENTRY} is not compiled in the harness` }
  } else {
    const compileError = compileSelector(input.harnessDir, exec)
    if (compileError) return { fallback: `selector-error: ${compileError}` }
  }
  if (input.fetchHistory) {
    const historyError = fetchHistory(input, exec)
    if (historyError) return { fallback: `selector-error: ${historyError}` }
  }

  const args = [
    path.join(input.harnessDir, SELECT_ENTRY),
    "--repo", input.repoDir,
    "--staging", input.stagingSha,
    "--head", input.prSha,
    "--pr", String(input.pr),
    "--always-run", path.join(input.harnessDir, "e2e/always-run.json"),
    "--timings", input.harnessDir,
    "--harness-sha", input.harnessSha,
    "--select-mode", input.selectMode === "select" || input.selectMode === "det+ai" ? "select" : "full",
    "--now", input.now,
    "--map-dir", input.map.dir,
    "--map-sha", input.map.mapSha,
    ...(input.map.candidatesDir ? ["--map-candidates", input.map.candidatesDir] : []),
    "--out", selectionPath,
    ...(input.prKey ? ["--pr-key", input.prKey] : []),
    ...(input.aiInputPath ? ["--ai-input", input.aiInputPath] : []),
  ]
  if (input.aiInputPath) fs.rmSync(input.aiInputPath, { force: true })
  const r = exec("node", args, { cwd: input.harnessDir, timeoutMs: SELECT_TIMEOUT_MS, env: input.childEnv })
  if (r.timedOut) return { fallback: `selector-error: timed out after ${SELECT_TIMEOUT_MS / 1000} s` }
  if (r.code !== 0) return { fallback: `selector-error: exit ${r.code}: ${tail(r.stderr || r.stdout)}` }
  if (!fs.existsSync(selectionPath)) return { fallback: "selector-error: selection.json not written" }
  let parsed: unknown
  try {
    parsed = JSON.parse(fs.readFileSync(selectionPath, "utf8"))
  } catch (e) {
    return { fallback: `selector-error: selection.json is not JSON (${(e as Error).message})` }
  }
  const checked = validateSelection(parsed)
  if (!checked.ok) return { fallback: `selector-error: selection.json invalid: ${checked.errors.slice(0, 2).join("; ")}` }
  if (checked.value.harnessSha !== input.harnessSha) {
    return { fallback: `selector-error: selection names harness ${checked.value.harnessSha}, setup runs ${input.harnessSha}` }
  }
  if (checked.value.headSha !== input.prSha) return { fallback: `selector-error: selection is for ${checked.value.headSha}, not ${input.prSha}` }
  return { selection: checked.value }
}

export function runSelectStep(input: SelectStepInput, exec: Exec = realExec): SelectStepResult {
  fs.mkdirSync(input.outDir, { recursive: true })
  const selectionPath = path.join(input.outDir, "selection.json")
  const rowsPath = path.join(input.outDir, "comment-rows-t4.json")
  let out: { selection: Selection } | { fallback: string }
  try {
    out = selectorRun(input, exec, selectionPath)
  } catch (e) {
    out = { fallback: `selector-error: ${(e as Error).message}` }
  }
  const selection = "selection" in out ? out.selection : fallbackSelection(input, out.fallback)
  const rows = "selection" in out ? buildRows({ selection, setupRunId: input.setupRunId }) : errorRows(input.setupRunId, out.fallback)
  fs.writeFileSync(selectionPath, canonicalJson(selection))
  fs.writeFileSync(rowsPath, canonicalJson(rows))
  return { selection, rows, selectionPath, rowsPath, fallback: "fallback" in out ? out.fallback : null }
}

export function mergeRunRecords(dirs: readonly string[], dest: string): number {
  fs.mkdirSync(dest, { recursive: true })
  const seen = new Set<string>()
  let n = 0
  for (const dir of dirs) {
    if (!fs.existsSync(dir)) continue
    for (const name of fs.readdirSync(dir).sort()) {
      if (!name.endsWith(".json")) continue
      let doc: unknown
      try {
        doc = JSON.parse(fs.readFileSync(path.join(dir, name), "utf8"))
      } catch {
        continue
      }
      const d = doc as { setupRunId?: unknown; ai?: { setupRunId?: unknown } | null } | null
      const setupRunId = typeof d?.ai?.setupRunId === "string" ? d.ai.setupRunId : d?.ai && typeof d.setupRunId === "string" ? d.setupRunId : null
      const key = setupRunId !== null ? `ai:${setupRunId}` : `file:${name}`
      if (seen.has(key)) continue
      seen.add(key)
      fs.writeFileSync(path.join(dest, `${String(n).padStart(6, "0")}.json`), JSON.stringify(doc))
      n++
    }
  }
  return n
}

export interface AiStepInput {
  harnessDir: string
  setupRunId: string
  aiInput: unknown
  recordDirs: readonly string[]
  outDir: string
  env: ChildEnv
}

export interface AiStepResult {
  outcome: string
  fellBack: boolean
  runAdditions: boolean
  additions: string[]
  record: unknown
  runRecordAi: unknown
}

export function runAiStep(input: AiStepInput, exec: Exec = realExec): AiStepResult {
  const missing = (why: string): AiStepResult => ({ outcome: why, fellBack: true, runAdditions: false, additions: [], record: null, runRecordAi: null })
  fs.mkdirSync(input.outDir, { recursive: true })
  const inputPath = path.join(input.outDir, "ai-input.json")
  const outPath = path.join(input.outDir, "ai.json")
  const records = path.join(input.outDir, "ai-records")
  fs.rmSync(records, { recursive: true, force: true })
  mergeRunRecords(input.recordDirs, records)
  fs.writeFileSync(inputPath, JSON.stringify(input.aiInput))
  fs.rmSync(outPath, { force: true })
  const r = exec(
    "node",
    [path.join(input.harnessDir, AI_ENTRY), "--input", inputPath, "--records", records, "--out", outPath, "--setup-run-id", input.setupRunId],
    { cwd: input.harnessDir, timeoutMs: AI_TIMEOUT_MS, env: input.env },
  )
  if (r.timedOut) return missing("step-timeout")
  if (!fs.existsSync(outPath)) return missing("missing-output")
  try {
    const doc = JSON.parse(fs.readFileSync(outPath, "utf8")) as Partial<AiStepResult>
    if (typeof doc.outcome !== "string" || !Array.isArray(doc.additions)) return missing("malformed-output")
    return {
      outcome: doc.outcome,
      fellBack: doc.fellBack !== false,
      runAdditions: doc.runAdditions === true && doc.additions.length > 0,
      additions: doc.additions.filter((a): a is string => typeof a === "string"),
      record: doc.record ?? null,
      runRecordAi: doc.runRecordAi ?? null,
    }
  } catch {
    return missing("malformed-output")
  }
}
