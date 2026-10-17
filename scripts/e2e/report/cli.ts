import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs"
import { join } from "node:path"
import { pathToFileURL } from "node:url"

import { ARTIFACTS, FILES } from "../contract/constants.js"
import { validateSetupPlan, validateShardPlan } from "../contract/formats.js"
import type { SetupPlan, ShardPlan } from "../contract/types.js"
import { type GitHub, artifactFile, env, gitHubClient, output, readJsonFile, runArtifactJson, runArtifacts, summary } from "../lib/github.js"
import { MARKER } from "./comment.mjs"
import { hasLiveMention } from "./escape.mjs"
import { proposeQuarantine } from "./flake-rate.mjs"
import { type ReportHooks, type ReportTrigger, reportHooks } from "./hooks.js"
import { findShardReports, readRowFiles, recount } from "./recount.mjs"
import { scrubDirectory } from "./scrub.mjs"
import { SHOTS_BRANCH } from "./shots.mjs"
import { TRUSTED_BRANCH, checkPlanBinding, checkRunTrust, checkSetupRun } from "./trust.mjs"

export const REPORT_BOT = "github-actions[bot]"
export const CHECK_NAME = "e2e"
export const OUTCOME_ARTIFACT = (setupRunId: string) => `e2e-outcome-${setupRunId}`
export const SUMMARY_FILE = "plan-summary.json"
export const MAX_SHOTS = 40
export const MAX_SHOT_BYTES = 2_000_000

interface ApiRun {
  id: number
  path: string
  head_branch: string | null
  head_sha: string
  status: string | null
  conclusion: string | null
}

export interface Target {
  setup_run_id: string
  mode: "fixture" | "live"
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

export async function isReported(gh: GitHub, setupRunId: string) {
  const body = await gh.get<{ total_count: number }>(`/actions/artifacts?name=${OUTCOME_ARTIFACT(setupRunId)}&per_page=1`)
  return (body?.total_count ?? 0) > 0
}

export async function listTargets(gh: GitHub, requested: string | undefined, now = Date.now()): Promise<{ targets: Target[]; checked: number }> {
  const ids: string[] = []
  let checked = 0
  if (requested) {
    if (!/^[1-9][0-9]{0,19}$/.test(requested)) throw new Error(`setup_run_id "${requested}" is not a run id`)
    ids.push(requested)
  } else {
    const since = new Date(now - 24 * 3600 * 1000).toISOString()
    const body = await gh.get<{ workflow_runs: { id: number }[] }>(
      `/actions/workflows/e2e-setup.yml/runs?branch=${TRUSTED_BRANCH}&status=completed&created=>=${since}&per_page=100`,
    )
    for (const r of body?.workflow_runs ?? []) {
      checked += 1
      const names = (await runArtifacts(gh, String(r.id))).map((a) => a.name)
      if (names.includes(ARTIFACTS.plan) && !(await isReported(gh, String(r.id)))) ids.push(String(r.id))
    }
  }
  const targets: Target[] = []
  for (const id of ids) {
    const doc = await runArtifactJson<unknown>(gh, id, ARTIFACTS.plan, FILES.setupPlan).catch(() => null)
    const run = doc ? validateSetupPlan(doc) : null
    if (!requested && !(run?.ok && run.value.state === "dispatched")) continue
    targets.push({ setup_run_id: id, mode: run?.ok && !run.value.fixture ? "live" : "fixture" })
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
  const genuine = !!setupRun && !checkSetupRun({ setupRun, runRecord: { setup_run_id: setupRunId } })
  let runRecord: SetupPlan
  let plan: ShardPlan
  try {
    runRecord = readSetupPlan(planDir)
    plan = readShardPlan(planDir)
  } catch (e) {
    return { ok: false, record: genuine, reason: e instanceof Error ? e.message : String(e) }
  }
  const setupProblem = checkSetupRun({ setupRun, runRecord })
  if (setupProblem) return { ok: false, record: genuine, reason: setupProblem }
  const main = runRecord.dispatches.find((d) => d.role === "main" && d.dispatched_run_id)
  if (!main?.dispatched_run_id) return { ok: false, record: true, reason: `setup run ${setupRunId} recorded no dispatched run (state ${runRecord.state})` }
  const deadline = now() + waitMs
  for (;;) {
    const run = await gh.get<ApiRun>(`/actions/runs/${main.dispatched_run_id}`)
    const jobs = run ? ((await gh.get<{ jobs: { status: string }[] }>(`/actions/runs/${run.id}/jobs?per_page=100`))?.jobs ?? []) : []
    const decision = checkRunTrust({ setupRun, runRecord, run, jobs })
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

export async function pushShots(gh: GitHub, shots: { from: string; to: string }[], message: string) {
  const files = shots.filter((s) => existsSync(s.from)).slice(0, MAX_SHOTS)
  const entries: { path: string; mode: "100644"; type: "blob"; sha: string }[] = []
  for (const f of files) {
    const data = readFileSync(f.from)
    if (data.length > MAX_SHOT_BYTES) continue
    const { body } = await gh.send<{ sha: string }>("POST", "/git/blobs", { content: data.toString("base64"), encoding: "base64" })
    entries.push({ path: f.to, mode: "100644", type: "blob", sha: body.sha })
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
}

export async function writeReport(args: ReportArgs) {
  const { gh, hooks, setupRunId, runId, trigger, planDir, shardsDir, rowsDir, outDir } = args
  const run = readSetupPlan(planDir)
  const plan = readShardPlan(planDir)
  const summaryFile = join(planDir, SUMMARY_FILE)
  const planSummary = existsSync(summaryFile) ? readJsonFile<unknown>(summaryFile) : null
  const scrub = existsSync(shardsDir) ? await scrubDirectory(shardsDir, {}) : { leaks: [] as string[], removed: [] as string[] }
  const problems = scrub.leaks.map((l: string) => `artifact scrub left a secret in ${l}`)
  const rowFiles = readRowFiles(rowsDir) as Record<string, unknown>
  const binding = run.pr && run.kind === "pr" ? await hooks.rebind({ gh, pr: run.pr, headSha: run.pr_sha, setupRunId, trigger, rowFiles }) : null
  const meta = { setupRunId, runTag: run.run_tag, workflowSha: run.workflow_sha, prSha: run.pr_sha, repo: gh.repo, binding: binding ? { headSha: run.pr_sha, diffHash: binding.diffHash } : null }
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
  if (scrub.leaks.length) posted.refused = "a secret survived scrubbing; nothing was posted"
  else {
    posted.shots = await pushShots(gh, shots, `e2e screenshots for setup run ${setupRunId}`)
    if (run.pr) posted.comment = await upsertComment(gh, run.pr, comment)
    await createCheck(gh, run.pr_sha, results.verdict, comment)
    posted.check = true
  }
  const outcome = {
    setup_run_id: setupRunId,
    run_id: runId,
    trigger,
    verdict: results.verdict,
    counts: results.counts,
    problems: results.problems.length,
    posted,
    finished: true,
    restored: run.fixture || !run.mail.contained ? "not-contained" : "not-built",
  }
  writeFileSync(join(outDir, "outcome.json"), JSON.stringify(outcome, null, 2) + "\n")
  return { outcome, comment }
}

export async function flakeProposals(gh: GitHub, quarantineIds: Set<string>, now = Date.now(), maxRuns = 60) {
  const since = now - 7 * 24 * 3600 * 1000
  const found: { id: number; name: string; expired: boolean; created_at?: string }[] = []
  for (let page = 1; page <= 5; page += 1) {
    const body = await gh.get<{ artifacts: { id: number; name: string; expired: boolean; created_at?: string }[] }>(`/actions/artifacts?per_page=100&page=${page}`)
    const items = body?.artifacts ?? []
    found.push(...items.filter((a) => a.name.startsWith("e2e-outcome-") && !a.expired && Date.parse(a.created_at ?? "") >= since))
    if (items.length < 100) break
  }
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
      if (!requested) summary(`## e2e report sweep\n\nChecked ${checked} setup runs on \`${TRUSTED_BRANCH}\` from the last 24 h; ${targets.length} to report: ${targets.map((t) => t.setup_run_id).join(", ") || "none"}.`, source)
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
      })
      summary(comment, source)
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
