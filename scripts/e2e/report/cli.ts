import { createHash } from "node:crypto"
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs"
import { join } from "node:path"
import { pathToFileURL } from "node:url"

import { ARTIFACTS, FILES } from "../contract/constants.js"
import { validateRunRecord, validateSelection, validateSetupPlan, validateShardPlan } from "../contract/formats.js"
import type { RunRecord, Selection, SetupPlan, ShardPlan, TestKind } from "../contract/types.js"
import { sampledPush } from "../measure/ground-truth.js"
import { type Artifact, type GitHub, artifactFile, env, gitHubClient, output, readJsonFile, runArtifactJson, runArtifacts, summary } from "../lib/github.js"
import { MARKER } from "./comment.mjs"
import { hasLiveMention } from "./escape.mjs"
import { contractIdFromLine } from "./id.mjs"
import { proposeQuarantine } from "./flake-rate.mjs"
import { priorOutcomeFor, type PriorOutcome } from "../map/accept/report.js"
import { NIGHT_FILE, type NightEntry } from "../map/nightly/store-index.js"
import { type ReportHooks, type ReportTrigger, reportHooks } from "./hooks.js"
import { findShardReports, readRowFiles, recount } from "./recount.mjs"
import { scrubDirectory } from "./scrub.mjs"
import { SHOTS_BRANCH } from "./shots.mjs"
import { REPORT_WORKFLOW, TRUSTED_BRANCH, TRUSTED_BRANCH_EVENTS, checkPlanBinding, checkRunTrust, checkSetupRun, runVerifier } from "./trust.mjs"

export const REPORT_BOT = "github-actions[bot]"
export const CHECK_NAME = "e2e / staging report"
export const BASE_ROWS_FILE = "base-rows.json"
export const NO_PR_POST_KINDS = new Set(["base", "postmerge"])
export const OUTCOME_ARTIFACT = (setupRunId: string) => `e2e-outcome-${setupRunId}`
export const SUMMARY_FILE = "plan-summary.json"
export const MAX_SHOTS = 40
export const MAX_SHOT_BYTES = 2_000_000
export const RUN_RECORD_ARTIFACT = (setupRunId: string) => `${ARTIFACTS.runRecord}-${setupRunId}`
export const RUN_RECORD_FILE = "run-record.json"
export const RUN_RECORDS_DIR = "run-records"
export const DRAFTS_ARTIFACT = "e2e-drafts"
export const DRAFTS_STATE_FILE = "drafts-state.json"
export const DRAFTS_SOURCE_FILE = "drafts-state-source.json"
export const DRAFTS_WINDOW_MS = 30 * 24 * 3600 * 1000
const RUN_ID = /^[1-9][0-9]{0,19}$/

interface ApiRun {
  id: number
  path: string
  event?: string
  pull_requests?: { base?: { ref?: string; repo?: { id?: number } } }[]
  head_branch: string | null
  head_sha: string
  status: string | null
  conclusion: string | null
}

export interface Target {
  setup_run_id: string
  mode: "fixture" | "live"
  plan_artifact: string
  deployment: string
}

export function readSetupPlan(dir: string): SetupPlan {
  const result = validateSetupPlan(readJsonFile(join(dir, FILES.setupPlan)))
  if (!result.ok) throw new Error(`run.json is invalid: ${result.errors.join("; ")}`)
  return result.value
}

export function readShardPlan(dir: string): ShardPlan {
  const result = validateShardPlan(readJsonFile(join(dir, FILES.shardPlan)))
  if (!result.ok) throw new Error(`plan.json is invalid: ${result.errors.join("; ")}`)
  return result.value
}

export const OUTCOME_WINDOW_MS = 8 * 24 * 3600 * 1000

export interface Trusted {
  verify: (run: ApiRun | null, path?: string) => Promise<string | null>
  outcomes: () => Promise<Map<string, Artifact>>
  runRecords: () => Promise<Map<string, Artifact>>
}

const trustedCache = new WeakMap<GitHub, Trusted>()

export function trustedOf(gh: GitHub, now = Date.now()): Trusted {
  const hit = trustedCache.get(gh)
  if (hit) return hit
  const check = runVerifier((p: string) => gh.get(p ? `/${p}` : ""))
  const verify = async (run: ApiRun | null, path?: string) => (run ? check(run, path) : "no such run")
  let loaded: Promise<{ outcomes: Map<string, Artifact>; runRecords: Map<string, Artifact> }> | null = null
  const load = async () => {
    const since = new Date(now - OUTCOME_WINDOW_MS).toISOString()
    const outcomes = new Map<string, Artifact>()
    const runRecords = new Map<string, Artifact>()
    for (let page = 1; page <= 10; page += 1) {
      const body = await gh.get<{ workflow_runs: ApiRun[] }>(`/actions/workflows/e2e-report.yml/runs?created=>=${since}&per_page=100&page=${page}`)
      const runs = body?.workflow_runs ?? []
      for (const r of runs) {
        if (await verify(r, REPORT_WORKFLOW)) continue
        for (const a of await runArtifacts(gh, String(r.id))) {
          if (a.name.startsWith("e2e-outcome-") && !outcomes.has(a.name)) outcomes.set(a.name, a)
          if (a.name.startsWith(`${ARTIFACTS.runRecord}-`) && !runRecords.has(a.name)) runRecords.set(a.name, a)
        }
      }
      if (runs.length < 100) break
    }
    return { outcomes, runRecords }
  }
  const t: Trusted = {
    verify,
    outcomes: async () => (await (loaded ??= load())).outcomes,
    runRecords: async () => (await (loaded ??= load())).runRecords,
  }
  trustedCache.set(gh, t)
  return t
}

export async function isReported(gh: GitHub, setupRunId: string) {
  return (await trustedOf(gh).outcomes()).has(OUTCOME_ARTIFACT(setupRunId))
}

export async function listTargets(gh: GitHub, requested: string | undefined, now = Date.now()): Promise<{ targets: Target[]; checked: number }> {
  const ids: string[] = []
  let checked = 0
  if (requested) {
    if (!/^[1-9][0-9]{0,19}$/.test(requested)) throw new Error(`setup_run_id "${requested}" is not a run id`)
    ids.push(requested)
  } else {
    const since = new Date(now - 24 * 3600 * 1000).toISOString()
    const body = await gh.get<{ workflow_runs: ApiRun[] }>(`/actions/workflows/e2e-setup.yml/runs?status=completed&created=>=${since}&per_page=100`)
    for (const r of body?.workflow_runs ?? []) {
      checked += 1
      if (await trustedOf(gh).verify(r)) continue
      const names = (await runArtifacts(gh, String(r.id))).map((a) => a.name)
      if (names.includes(ARTIFACTS.plan) && !(await isReported(gh, String(r.id)))) ids.push(String(r.id))
    }
  }
  const targets: Target[] = []
  for (const id of ids) {
    const final = await runArtifactJson<unknown>(gh, id, ARTIFACTS.planFinal, FILES.setupPlan).catch(() => null)
    const doc = final ?? (await runArtifactJson<unknown>(gh, id, ARTIFACTS.plan, FILES.setupPlan).catch(() => null))
    const run = doc ? validateSetupPlan(doc) : null
    if (!requested && !(run?.ok && run.value.state === "dispatched")) continue
    targets.push({
      setup_run_id: id,
      mode: run?.ok && !run.value.fixture ? "live" : "fixture",
      plan_artifact: final ? ARTIFACTS.planFinal : ARTIFACTS.plan,
      deployment: run?.ok ? run.value.deployment.convex_deployment : `setup-${id}`,
    })
  }
  return { targets, checked }
}

export type TrustOutcome = { ok: true; runId: string; runKey: string } | { ok: false; record: boolean; reason: string }

export async function trustRun(args: {
  gh: GitHub
  setupRunId: string
  planDir: string
  waitMs: number
  sleep?: (ms: number) => Promise<void>
  now?: () => number
}): Promise<TrustOutcome> {
  const { gh, setupRunId, planDir, waitMs } = args
  const sleep = args.sleep ?? ((ms: number) => new Promise<void>((r) => setTimeout(r, ms)))
  const now = args.now ?? Date.now
  if (await isReported(gh, setupRunId)) return { ok: false, record: false, reason: `setup run ${setupRunId} already has a report` }
  const setupRun = await gh.get<ApiRun>(`/actions/runs/${setupRunId}`)
  const untrusted = await trustedOf(gh).verify(setupRun)
  const genuine = !checkSetupRun({ setupRun, runRecord: { setup_run_id: setupRunId }, untrusted })
  let runRecord: SetupPlan
  let plan: ShardPlan
  try {
    runRecord = readSetupPlan(planDir)
    plan = readShardPlan(planDir)
  } catch (e) {
    return { ok: false, record: genuine, reason: e instanceof Error ? e.message : String(e) }
  }
  const setupProblem = checkSetupRun({ setupRun, runRecord, untrusted })
  if (setupProblem) return { ok: false, record: genuine, reason: setupProblem }
  const main = runRecord.dispatches.find((d) => d.role === "main" && d.dispatched_run_id)
  if (!main?.dispatched_run_id) return { ok: false, record: true, reason: `setup run ${setupRunId} recorded no dispatched run (state ${runRecord.state})` }
  const deadline = now() + waitMs
  for (;;) {
    const run = await gh.get<ApiRun>(`/actions/runs/${main.dispatched_run_id}`)
    const jobs = run ? ((await gh.get<{ jobs: { status: string }[] }>(`/actions/runs/${run.id}/jobs?per_page=100`))?.jobs ?? []) : []
    const decision = checkRunTrust({ setupRun, untrusted, runRecord, run, jobs })
    if (decision.decision === "report") {
      const binding = checkPlanBinding(plan, decision.run_key ?? "")
      if (binding) return { ok: false, record: true, reason: binding }
      return { ok: true, runId: main.dispatched_run_id, runKey: decision.run_key ?? "" }
    }
    if (decision.decision === "refuse") return { ok: false, record: true, reason: decision.reason ?? "refused" }
    if (now() >= deadline) return { ok: false, record: false, reason: `${decision.reason}; the scheduled sweep retries` }
    await sleep(10_000)
  }
}

export function gitBlobSha(data: Buffer) {
  return createHash("sha1").update(`blob ${data.length}\0`).update(data).digest("hex")
}

export async function pushShots(gh: GitHub, shots: { from: string; to: string }[], message: string) {
  const files = shots.filter((s) => existsSync(s.from)).slice(0, MAX_SHOTS)
  const head = await gh.get<{ object: { sha: string } }>(`/git/ref/heads/${SHOTS_BRANCH}`)
  const existing = new Map<string, string>()
  if (head) {
    const tree = await gh.get<{ tree: { path: string; type: string; sha: string }[] }>(`/git/trees/${head.object.sha}?recursive=1`)
    for (const e of tree?.tree ?? []) if (e.type === "blob") existing.set(e.path, e.sha)
  }
  const known = new Set(existing.values())
  const entries: { path: string; mode: "100644"; type: "blob"; sha: string }[] = []
  for (const f of files) {
    const data = readFileSync(f.from)
    if (data.length > MAX_SHOT_BYTES) continue
    const sha = gitBlobSha(data)
    if (existing.get(f.to) === sha) continue
    if (!known.has(sha)) {
      const { body } = await gh.send<{ sha: string }>("POST", "/git/blobs", { content: data.toString("base64"), encoding: "base64" })
      known.add(body.sha)
    }
    entries.push({ path: f.to, mode: "100644", type: "blob", sha })
  }
  if (!entries.length) return 0
  for (let attempt = 0; ; attempt += 1) {
    const ref = await gh.get<{ object: { sha: string } }>(`/git/ref/heads/${SHOTS_BRANCH}`)
    const parent = ref?.object.sha ?? null
    const baseTree = parent ? (await gh.get<{ tree: { sha: string } }>(`/git/commits/${parent}`))?.tree.sha : undefined
    const tree = await gh.send<{ sha: string }>("POST", "/git/trees", baseTree ? { base_tree: baseTree, tree: entries } : { tree: entries })
    const commit = await gh.send<{ sha: string }>("POST", "/git/commits", { message, tree: tree.body.sha, parents: parent ? [parent] : [] })
    try {
      if (parent) await gh.send("PATCH", `/git/refs/heads/${SHOTS_BRANCH}`, { sha: commit.body.sha, force: false })
      else await gh.send("POST", "/git/refs", { ref: `refs/heads/${SHOTS_BRANCH}`, sha: commit.body.sha })
      return entries.length
    } catch (e) {
      if (attempt >= 2) throw e
    }
  }
}

export async function upsertComment(gh: GitHub, pr: number, body: string) {
  if (!body.includes(MARKER)) throw new Error("comment has no report marker")
  if (hasLiveMention(body)) throw new Error("comment holds a live @mention; refusing to post")
  for (let page = 1; page <= 10; page += 1) {
    const comments = (await gh.get<{ id: number; body?: string; user?: { login?: string } }[]>(`/issues/${pr}/comments?per_page=100&page=${page}`)) ?? []
    const mine = comments.find((c) => c.user?.login === REPORT_BOT && String(c.body ?? "").includes(MARKER))
    if (mine) {
      await gh.send("PATCH", `/issues/comments/${mine.id}`, { body })
      return { action: "updated" as const, id: mine.id }
    }
    if (comments.length < 100) break
  }
  const { body: created } = await gh.send<{ id: number }>("POST", `/issues/${pr}/comments`, { body })
  return { action: "created" as const, id: created.id }
}

export async function createCheck(gh: GitHub, sha: string, verdict: string, text: string) {
  const title = verdict === "passed" ? "Browser tests passed" : "Browser tests failed"
  await gh.send("POST", "/check-runs", {
    name: CHECK_NAME,
    head_sha: sha,
    status: "completed",
    conclusion: verdict === "passed" ? "success" : "failure",
    output: { title, summary: text.length > 65_000 ? `${text.slice(0, 64_900)}\n\n(cut)` : text },
  })
}

export interface ReportArgs {
  gh: GitHub
  hooks: ReportHooks
  setupRunId: string
  runId: string
  trigger: ReportTrigger
  planDir: string
  shardsDir: string
  rowsDir: string | null
  outDir: string
  alwaysRunFile: string
  quarantineFile: string
}

export async function priorAcceptOutcome(gh: GitHub, pr: number): Promise<PriorOutcome | null> {
  const newest = [...(await trustedOf(gh).outcomes()).values()].sort((a, b) => Date.parse(b.created_at ?? "") - Date.parse(a.created_at ?? ""))
  for (const a of newest) {
    const text = await artifactFile(gh, a, "outcome.json").catch(() => null)
    const found = text ? priorOutcomeFor([JSON.parse(text) as unknown], pr) : null
    if (found) return found
  }
  return null
}

export const NIGHT_JOB_CONCLUSIONS = new Set(["success", "failure", "cancelled", "skipped"])

export async function nightRunJobs(gh: GitHub, runId: string): Promise<{ job: string; result: string }[]> {
  const jobs = (await gh.get<{ jobs: { name: string; conclusion: string | null }[] }>(`/actions/runs/${runId}/jobs?per_page=100`))?.jobs ?? []
  return jobs
    .filter((j) => j.name.split(" ")[0] !== "fan-in")
    .map((j) => ({ job: j.name, result: j.conclusion && NIGHT_JOB_CONCLUSIONS.has(j.conclusion) ? j.conclusion : j.conclusion === null ? "cancelled" : "failure" }))
}

export async function setupNights(gh: GitHub, now = Date.now()): Promise<NightEntry[]> {
  const since = new Date(now - OUTCOME_WINDOW_MS).toISOString()
  const body = await gh.get<{ workflow_runs: ApiRun[] }>(`/actions/workflows/e2e-setup.yml/runs?status=completed&created=>=${since}&per_page=100`)
  const out: NightEntry[] = []
  for (const r of body?.workflow_runs ?? []) {
    if (await trustedOf(gh).verify(r)) continue
    const [head] = await runArtifacts(gh, String(r.id), "e2e-head")
    const text = head ? await artifactFile(gh, head, NIGHT_FILE).catch(() => null) : null
    if (!text) continue
    const doc = JSON.parse(text) as { setup_run_id?: unknown; entry?: NightEntry }
    if (doc.setup_run_id === String(r.id) && doc.entry && doc.entry.status !== "published") out.push(doc.entry)
  }
  return out.sort((a, b) => Date.parse(a.builtAt) - Date.parse(b.builtAt))
}

export async function trustedRunRecords(gh: GitHub, log: (line: string) => void = () => {}): Promise<RunRecord[]> {
  const out: RunRecord[] = []
  for (const [name, a] of [...(await trustedOf(gh).runRecords()).entries()].sort(([x], [y]) => (x < y ? -1 : x > y ? 1 : 0))) {
    const id = name.slice(ARTIFACTS.runRecord.length + 1)
    if (!RUN_ID.test(id)) continue
    const text = await artifactFile(gh, a, RUN_RECORD_FILE).catch(() => null)
    if (text === null) {
      log(`run record ${name}: no ${RUN_RECORD_FILE}`)
      continue
    }
    let checked
    try {
      checked = validateRunRecord(JSON.parse(text))
    } catch (e) {
      log(`run record ${name}: ${(e as Error).message}`)
      continue
    }
    if (!checked.ok) log(`run record ${name}: ${checked.errors.slice(0, 3).join("; ")}`)
    else if (checked.value.setupRunId !== id) log(`run record ${name} names setup run ${checked.value.setupRunId}`)
    else out.push(checked.value)
  }
  return out
}

const RESULT_OF: Record<string, RunRecord["results"][number]["result"]> = { passed: "passed", failed: "failed", flaky: "flaky", "not-run": "not-run" }

type ResultRow = { id: string; status: string; reason?: string; attempts?: number; quarantined?: boolean; ai?: boolean }

export function recordResults(plan: ShardPlan, rows: readonly ResultRow[]): RunRecord["results"] {
  const kinds = new Map<string, TestKind>()
  for (const shard of plan.shards) for (const t of shard.tests) kinds.set(t.id, t.kind)
  const out: RunRecord["results"] = []
  for (const row of rows) {
    const kind = kinds.get(row.id)
    if (!kind) continue
    const result = row.status === "quarantined" ? (row.reason === "known broken, failed" ? "failed" : "not-run") : RESULT_OF[row.status]
    if (!result) continue
    out.push({ id: row.id, kind, result, quarantined: row.quarantined === true || row.status === "quarantined", retries: Math.max(0, (row.attempts ?? 0) - 1) })
  }
  return out.sort((a, b) => (a.id < b.id ? -1 : a.id > b.id ? 1 : 0))
}

export function readSelection(planDir: string): Selection | null {
  const file = join(planDir, FILES.selection)
  if (!existsSync(file)) return null
  const checked = validateSelection(readJsonFile(file))
  if (!checked.ok) throw new Error(`${FILES.selection} is invalid: ${checked.errors.slice(0, 3).join("; ")}`)
  return checked.value
}

async function treeOf(gh: GitHub, sha: string): Promise<string | null> {
  const c = await gh.get<{ tree?: { sha?: string } }>(`/git/commits/${sha}`).catch(() => null)
  return c?.tree?.sha ?? null
}

export async function buildRunRecord(args: {
  gh: GitHub
  setupRunId: string
  runId: string | null
  planDir: string
  outcomeDir: string
  now?: number
  log?: (line: string) => void
}): Promise<RunRecord | null> {
  const { gh, setupRunId, planDir, outcomeDir } = args
  const log = args.log ?? (() => {})
  const run = readSetupPlan(planDir)
  if (run.fixture) return null
  if (run.setup_run_id !== setupRunId) throw new Error(`run.json is for setup run ${run.setup_run_id}, not ${setupRunId}`)
  const plan = readShardPlan(planDir)
  const results = readJsonFile<{ rows?: ResultRow[] }>(join(outcomeDir, "results.json"))
  const selection = readSelection(planDir)
  const aiDoc = await runArtifactJson<{ setupRunId?: unknown; runRecordAi?: unknown }>(gh, setupRunId, ARTIFACTS.selectAi, FILES.selectAi).catch(() => null)
  const ai = aiDoc && aiDoc.setupRunId === setupRunId && aiDoc.runRecordAi ? (aiDoc.runRecordAi as RunRecord["ai"]) : null
  const controlDoc = await runArtifactJson<{ setup_run_id?: unknown; seeded_escape?: { function_id: string; break_sha: string; branch: string; dropped: string[] } | null }>(
    gh,
    setupRunId,
    ARTIFACTS.control,
    FILES.control,
  ).catch(() => null)
  const escape = controlDoc && controlDoc.setup_run_id === setupRunId ? (controlDoc.seeded_escape ?? null) : null
  let headSha = run.pr_sha
  let mergeCommitSha: string | null = null
  let treeEqual: boolean | null = null
  if (run.kind === "postmerge" && run.pr) {
    mergeCommitSha = run.target_sha ?? run.pr_sha
    const pull = await gh.get<{ head?: { sha?: string } }>(`/pulls/${run.pr}`).catch(() => null)
    const head = pull?.head?.sha
    if (head && /^[0-9a-f]{40}$/.test(head)) {
      headSha = head
      const [a, b] = [await treeOf(gh, head), await treeOf(gh, mergeCommitSha)]
      treeEqual = a !== null && b !== null ? a === b : null
    }
  }
  const record: RunRecord = {
    schemaVersion: "1.0",
    setupRunId,
    runId: args.runId && RUN_ID.test(args.runId) ? args.runId : null,
    kind: run.kind,
    pr: run.pr,
    headSha,
    baseSha: selection?.baseSha ?? run.base_sha ?? null,
    mergeCommitSha,
    treeEqual,
    recordedAt: new Date(args.now ?? Date.now()).toISOString(),
    groundTruth: plan.select_mode === "full",
    sampled: run.kind === "pr" && run.pr ? sampledPush(run.pr, headSha) : null,
    selection: selection
      ? { mode: selection.mode, rule: selection.rule, fullRun: selection.fullRun, mapSha: selection.mapSha, selected: [...new Set(selection.tests.map((t) => t.id))].sort() }
      : null,
    results: recordResults(plan, results.rows ?? []),
    ai,
    control: escape ? { kind: "seeded-escape", functionId: escape.function_id, breakSha: escape.break_sha, branch: escape.branch, dropped: [...escape.dropped] } : null,
  }
  const checked = validateRunRecord(record)
  if (checked.ok) return checked.value
  if (record.ai !== null) {
    const without = validateRunRecord({ ...record, ai: null })
    if (without.ok) {
      log(`::warning::the AI part of run record ${setupRunId} is invalid and was left out: ${checked.errors.slice(0, 3).join("; ")}`)
      return without.value
    }
  }
  throw new Error(`run record ${setupRunId} is invalid: ${checked.errors.slice(0, 5).join("; ")}`)
}

const draftsStateOk = (text: string) => {
  try {
    const s = JSON.parse(text) as { version?: unknown; pending?: unknown }
    return !!s && typeof s === "object" && s.version === 1 && Array.isArray(s.pending)
  } catch {
    return false
  }
}

export async function trustedDraftsState(gh: GitHub, setupRunId: string, now = Date.now()): Promise<{ setupRunId: string; text: string } | null> {
  if (!RUN_ID.test(setupRunId)) throw new Error(`setup run id "${setupRunId}" is not a run id`)
  const since = new Date(now - DRAFTS_WINDOW_MS).toISOString()
  const runs: ApiRun[] = []
  for (let page = 1; page <= 10; page += 1) {
    const body = await gh.get<{ workflow_runs: ApiRun[] }>(`/actions/workflows/e2e-setup.yml/runs?status=completed&created=>=${since}&per_page=100&page=${page}`)
    const list = body?.workflow_runs ?? []
    runs.push(...list)
    if (list.length < 100) break
  }
  const earlier = runs
    .filter((r) => RUN_ID.test(String(r.id)) && BigInt(r.id) < BigInt(setupRunId) && TRUSTED_BRANCH_EVENTS.includes(String(r.event)))
    .sort((a, b) => (BigInt(a.id) < BigInt(b.id) ? 1 : -1))
  for (const r of earlier) {
    if (await trustedOf(gh).verify(r)) continue
    const [artifact] = (await runArtifacts(gh, String(r.id), DRAFTS_ARTIFACT)).filter((a) => a.name === DRAFTS_ARTIFACT)
    if (!artifact) continue
    const text = await artifactFile(gh, artifact, DRAFTS_STATE_FILE).catch(() => null)
    if (text !== null && draftsStateOk(text)) return { setupRunId: String(r.id), text }
  }
  return null
}

export function quarantinedIds(file: string, plan: ShardPlan) {
  const planned = new Set(plan.shards.flatMap((s) => s.tests.map((t) => t.id)))
  const doc = existsSync(file) ? readJsonFile<{ entries?: { id?: unknown }[] }>(file) : { entries: [] }
  const ids: string[] = []
  for (const e of doc.entries ?? []) {
    try {
      ids.push(contractIdFromLine(String(e.id)))
    } catch {
      continue
    }
  }
  return ids.filter((id) => planned.has(id))
}

export async function writeReport(args: ReportArgs) {
  const { gh, hooks, setupRunId, runId, trigger, planDir, shardsDir, rowsDir, outDir } = args
  const run = readSetupPlan(planDir)
  const plan = readShardPlan(planDir)
  const summaryFile = join(planDir, SUMMARY_FILE)
  const planSummary = existsSync(summaryFile) ? readJsonFile<unknown>(summaryFile) : run.fixture ? null : { quarantined: quarantinedIds(args.quarantineFile, plan) }
  const scrub = existsSync(shardsDir) ? await scrubDirectory(shardsDir, {}) : { leaks: [] as string[], removed: [] as string[] }
  const problems = scrub.leaks.map((l: string) => `artifact scrub left a secret in ${l}`)
  const rowFiles = readRowFiles(rowsDir) as Record<string, unknown>
  const reports = findShardReports(shardsDir).flatMap((r: { file: string | null }) => {
    try {
      return r.file ? [readJsonFile<unknown>(r.file)] : []
    } catch {
      return []
    }
  })
  const binding =
    run.pr && run.kind === "pr"
      ? await hooks.rebind({ gh, pr: run.pr, headSha: run.pr_sha, setupRunId, trigger, rowFiles, reports, priorOutcome: (pr) => priorAcceptOutcome(gh, pr) })
      : null
  const baseRows = run.pr && run.kind === "pr" ? await baseRowsFor(gh, run.pr, run.pr_sha) : []
  const meta = {
    setupRunId,
    runTag: run.run_tag,
    workflowSha: run.workflow_sha,
    prSha: run.pr_sha,
    repo: gh.repo,
    binding: binding ? { headSha: run.pr_sha, diffHash: binding.diffHash } : null,
    baseRows,
  }
  const { results, comment, shots } = recount({
    plan,
    summary: planSummary,
    shardReports: findShardReports(shardsDir),
    alwaysRunDoc: run.fixture ? { schemaVersion: 1, tests: [] } : readJsonFile(args.alwaysRunFile),
    rowFiles,
    meta,
    problems,
  })
  mkdirSync(outDir, { recursive: true })
  writeFileSync(join(outDir, "results.json"), JSON.stringify(results, null, 2) + "\n")
  writeFileSync(join(outDir, "comment.md"), comment)
  const posted = { shots: 0, comment: null as null | { action: string; id: number }, check: false, refused: null as string | null }
  let superseded = false
  if (scrub.leaks.length) posted.refused = "a secret survived scrubbing; nothing was posted"
  else if (NO_PR_POST_KINDS.has(run.kind)) {
    writeFileSync(join(outDir, BASE_ROWS_FILE), JSON.stringify({ setup_run_id: setupRunId, kind: run.kind, pr: run.pr, pr_sha: run.pr_sha, rows: baseRowsOf(results.rows) }, null, 2) + "\n")
    posted.refused = `${run.kind} runs post nothing; their rows go into the PR run's comment`
  } else {
    const head = run.pr && !run.fixture ? await gh.get<{ head: { sha: string } }>(`/pulls/${run.pr}`) : null
    if (run.pr && !run.fixture && head?.head.sha !== run.pr_sha) {
      superseded = true
      posted.refused = `superseded: PR #${run.pr} head is ${head?.head.sha.slice(0, 12) ?? "unreadable"}, not ${run.pr_sha.slice(0, 12)}; nothing was posted`
    } else {
      posted.shots = await pushShots(gh, shots, `e2e screenshots for setup run ${setupRunId}`)
      if (run.pr) posted.comment = await upsertComment(gh, run.pr, comment)
      await createCheck(gh, run.pr_sha, results.verdict, comment)
      posted.check = true
    }
  }
  const outcome = {
    setup_run_id: setupRunId,
    run_id: runId,
    trigger,
    verdict: results.verdict,
    counts: results.counts,
    problems: results.problems.length,
    posted,
    superseded,
    finished: true,
    restored: run.fixture || !run.mail.contained ? "not-contained" : null,
    accept: superseded ? null : (binding?.accept ?? null),
  }
  writeFileSync(join(outDir, "outcome.json"), JSON.stringify(outcome, null, 2) + "\n")
  return { outcome, comment }
}

export interface BaseRow {
  text: string
  level: "info" | "warn" | "fail"
  ids: string[]
}

export function baseRowsOf(rows: { id: string; titles?: string[]; status: string }[]): BaseRow[] {
  return rows.map((r) => {
    const name = r.titles?.length ? r.titles.join(" › ") : r.id
    if (r.status === "failed") return { text: `${name}: fails on base, so it proves the fix`, level: "info", ids: [r.id] }
    if (r.status === "passed") return { text: `${name}: passes on base, so it proves nothing`, level: "warn", ids: [r.id] }
    return { text: `${name}: ${r.status} on base, so it proves nothing`, level: "warn", ids: [r.id] }
  })
}

export async function baseRowsFor(gh: GitHub, pr: number, prSha: string, now = Date.now()): Promise<BaseRow[]> {
  const since = new Date(now - 24 * 3600 * 1000).toISOString()
  const body = await gh.get<{ workflow_runs: ApiRun[] }>(`/actions/workflows/e2e-setup.yml/runs?created=>=${since}&per_page=100`)
  const out: BaseRow[] = []
  for (const r of body?.workflow_runs ?? []) {
    if (await trustedOf(gh).verify(r)) continue
    const id = String(r.id)
    const doc =
      (await runArtifactJson<unknown>(gh, id, ARTIFACTS.planFinal, FILES.setupPlan).catch(() => null)) ??
      (await runArtifactJson<unknown>(gh, id, ARTIFACTS.plan, FILES.setupPlan).catch(() => null))
    const plan = doc ? validateSetupPlan(doc) : null
    if (!plan?.ok || plan.value.kind !== "base" || plan.value.pr !== pr || plan.value.pr_sha !== prSha) continue
    const artifact = (await trustedOf(gh).outcomes()).get(OUTCOME_ARTIFACT(id))
    const text = artifact ? await artifactFile(gh, artifact, BASE_ROWS_FILE).catch(() => null) : null
    if (text) out.push(...(JSON.parse(text) as { rows: BaseRow[] }).rows)
    else out.push({ text: `fail-on-base run ${id} has not reported yet; its rows appear on the next report of this head`, level: "info", ids: [] })
  }
  return out
}

export async function flakeProposals(gh: GitHub, quarantineIds: Set<string>, now = Date.now(), maxRuns = 60) {
  const since = now - 7 * 24 * 3600 * 1000
  const found = [...(await trustedOf(gh, now).outcomes()).values()].filter((a) => Date.parse(a.created_at ?? "") >= since)
  const docs = []
  for (const a of found.slice(0, maxRuns)) {
    const text = await artifactFile(gh, a, "results.json").catch(() => null)
    if (text) docs.push(JSON.parse(text))
  }
  return { runs: docs.length, proposals: proposeQuarantine(docs, quarantineIds, new Date(now).toISOString().slice(0, 10)) }
}

export async function main(argv: string[], source: Record<string, string | undefined> = process.env, deps: { gh?: GitHub; hooks?: ReportHooks } = {}) {
  const [cmd, ...rest] = argv
  const gh = deps.gh ?? gitHubClient({ repo: env("GITHUB_REPOSITORY", source), token: env("GH_TOKEN", source), apiUrl: source.GITHUB_API_URL })
  switch (cmd) {
    case "targets": {
      const requested = source.SETUP_RUN_ID?.trim() || undefined
      const { targets, checked } = await listTargets(gh, requested)
      if (!requested) summary(`## e2e report sweep\n\nChecked ${checked} setup runs (trusted: pull_request_target, or schedule and dispatch on \`${TRUSTED_BRANCH}\`) from the last 24 h; ${targets.length} to report: ${targets.map((t) => t.setup_run_id).join(", ") || "none"}.`, source)
      output({ targets: JSON.stringify(targets), any: targets.length ? "true" : "false" }, source)
      return
    }
    case "trust": {
      const setupRunId = env("SETUP_RUN_ID", source)
      const result = await trustRun({ gh, setupRunId, planDir: rest[0], waitMs: Number(source.WAIT_SECONDS ?? "0") * 1000 })
      if (result.ok) {
        output({ ok: "true", record: "true", run_id: result.runId }, source)
        return
      }
      summary(`## e2e report: not reported\n\nSetup run ${setupRunId}: ${result.reason}.`, source)
      output({ ok: "false", record: String(result.record), reason: result.reason.replace(/[\r\n]+/g, " ").slice(0, 500) }, source)
      return
    }
    case "report": {
      const [planDir, shardsDir, rowsDir, outDir] = rest
      const failed = (e: unknown) => {
        mkdirSync(outDir, { recursive: true })
        const reason = (e instanceof Error ? e.message : String(e)).slice(0, 500)
        const file = join(outDir, "outcome.json")
        const prior = existsSync(file) ? (readJsonFile(file) as Record<string, unknown>) : {}
        writeFileSync(file, JSON.stringify({ restored: null, ...prior, setup_run_id: env("SETUP_RUN_ID", source), run_id: source.RUN_ID ?? null, verdict: "error", reason, finished: false }, null, 2) + "\n")
        throw e
      }
      const { comment } = await writeReport({
        gh,
        hooks: deps.hooks ?? reportHooks,
        setupRunId: env("SETUP_RUN_ID", source),
        runId: env("RUN_ID", source),
        trigger: source.TRIGGER === "sweep" ? "sweep" : "fan-in",
        planDir,
        shardsDir,
        rowsDir: rowsDir && existsSync(rowsDir) ? rowsDir : null,
        outDir,
        alwaysRunFile: source.ALWAYS_RUN_FILE ?? "e2e/always-run.json",
        quarantineFile: source.QUARANTINE_FILE ?? "e2e/quarantine.json",
      }).catch(failed)
      summary(comment, source)
      return
    }
    case "map-inputs": {
      const [planDir, outDir] = rest
      const run = readSetupPlan(planDir)
      if (run.kind !== "nightly" || run.fixture) {
        output({ map: "false" }, source)
        return
      }
      mkdirSync(outDir, { recursive: true })
      writeFileSync(join(outDir, "run-jobs.json"), JSON.stringify(await nightRunJobs(gh, env("RUN_ID", source)), null, 2) + "\n")
      writeFileSync(join(outDir, "setup-nights.json"), JSON.stringify(await setupNights(gh), null, 2) + "\n")
      const recordsDir = join(outDir, RUN_RECORDS_DIR)
      mkdirSync(recordsDir, { recursive: true })
      const records = await trustedRunRecords(gh, (line) => console.log(line))
      for (const r of records) writeFileSync(join(recordsDir, `${r.setupRunId}.json`), JSON.stringify(r, null, 2) + "\n")
      output({ map: "true", sha: run.pr_sha, built_at: run.created_at }, source)
      return
    }
    case "run-record": {
      const [planDir, outcomeDir, outDir] = rest
      const setupRunId = env("SETUP_RUN_ID", source)
      const record = await buildRunRecord({ gh, setupRunId, runId: source.RUN_ID ?? null, planDir, outcomeDir, log: (line) => console.log(line) })
      if (!record) {
        summary(`Run record: none for fixture setup run ${setupRunId}.`, source)
        return
      }
      mkdirSync(outDir, { recursive: true })
      writeFileSync(join(outDir, RUN_RECORD_FILE), JSON.stringify(record, null, 2) + "\n")
      const ai = record.ai ? `${record.ai.mode} ${record.ai.outcome}, ${record.ai.additions.length} AI-added` : "no AI call"
      summary(`Run record ${RUN_RECORD_ARTIFACT(setupRunId)}: ${record.selection ? `${record.selection.selected.length} selected deterministically` : "no selection"}; ${ai}; ${record.results.length} results.`, source)
      return
    }
    case "drafts-state": {
      const dir = rest[0]
      const setupRunId = env("SETUP_RUN_ID", source)
      if (existsSync(join(dir, DRAFTS_STATE_FILE))) {
        output({ drafts_state: "own" }, source)
        return
      }
      const found = await trustedDraftsState(gh, setupRunId)
      if (!found) {
        summary(`Drafts state: setup run ${setupRunId} wrote none and no earlier trusted setup run has one; the next drafts input starts empty.`, source)
        output({ drafts_state: "none" }, source)
        return
      }
      mkdirSync(dir, { recursive: true })
      writeFileSync(join(dir, DRAFTS_STATE_FILE), found.text)
      writeFileSync(join(dir, DRAFTS_SOURCE_FILE), JSON.stringify({ setup_run_id: found.setupRunId }, null, 2) + "\n")
      summary(`Drafts state: setup run ${setupRunId} wrote none; carried forward from trusted setup run ${found.setupRunId}.`, source)
      output({ drafts_state: `fallback:${found.setupRunId}` }, source)
      return
    }
    case "reject": {
      const outDir = rest[0]
      mkdirSync(outDir, { recursive: true })
      writeFileSync(
        join(outDir, "outcome.json"),
        JSON.stringify({ setup_run_id: env("SETUP_RUN_ID", source), verdict: "rejected", reason: source.REASON ?? "", finished: true }, null, 2) + "\n",
      )
      return
    }
    case "flake": {
      const doc = readJsonFile<{ entries?: { id: string }[] }>(source.QUARANTINE_FILE ?? "e2e/quarantine.json")
      const { runs, proposals } = await flakeProposals(gh, new Set((doc.entries ?? []).map((e) => e.id)))
      const lines = [`## Flake rate over ${runs} reported run(s) from the last 7 days`, ""]
      if (!proposals.length) lines.push("No test crossed the flake threshold.")
      else lines.push("Proposed `e2e/quarantine.json` entries (a person adds them by PR):", "", "```json", JSON.stringify(proposals, null, 2), "```")
      summary(lines.join("\n"), source)
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
