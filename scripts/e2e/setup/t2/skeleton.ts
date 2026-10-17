import { execFileSync } from "node:child_process"
import { randomBytes } from "node:crypto"
import { appendFileSync, existsSync, mkdirSync, readdirSync, readFileSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { pathToFileURL } from "node:url"

import type { SetupKind, SetupMode, SetupStep, SetupStepContext, SetupStepResult, SetupTask } from "./step.js"

export const KINDS: SetupKind[] = ["pr", "postmerge", "nightly", "gate", "mut", "fallback", "fresh", "base"]
export const FIXTURE_CASES = ["pass", "fail", "drop", "no-fan-in"] as const
export type FixtureCase = (typeof FIXTURE_CASES)[number]
export const TASK_STEPS: SetupTask[] = ["t3", "t4", "t5"]
export const SETUP_WORKFLOW_PATH = ".github/workflows/e2e-setup.yml"
export const RUN_WORKFLOW_PATH = ".github/workflows/e2e-run.yml"
export const TRUSTED_BRANCH = "staging"
export const FIXTURE_TESTS = [
  "fixture/dashboard.spec.ts > loads the dashboard",
  "fixture/dashboard.spec.ts > lists projects",
  "fixture/rfi.spec.ts > creates an RFI",
  "fixture/rfi.spec.ts > answers an RFI",
  "fixture/co.spec.ts > submits a change order",
  "fixture/co.spec.ts > approves a change order",
]
export const FIXTURE_SHARDS = 2

export interface SetupInputs {
  mode: SetupMode
  kind: SetupKind
  fixtureCase: FixtureCase
}

export interface RunJson {
  run_id: string
  run_tag: string
  run_key: string
  mode: SetupMode
  kind: SetupKind
  fixture_case: FixtureCase | null
  fan_in: boolean
  pr: number | null
  pr_sha: string
  branch: string
  deployment: { vercel_deployment_id: string | null; url: string | null; convex_deployment: string | null; convex_url: string | null }
  gate: { ref: string; sha256: string } | null
  steps: SetupStepResult[]
}

export interface PlanJson {
  shards: { index: number; tests: string[] }[]
}

export interface DispatchJson {
  setup_run_id: string
  run_key: string
  run_id: string
  html_url: string | null
}

export interface TestResult {
  id: string
  status: "passed" | "failed" | "skipped"
}

export interface ShardResults {
  shard: number
  results: TestResult[]
}

export interface ApiRun {
  id: number
  path: string
  head_branch: string | null
  head_sha: string
  status: string | null
  conclusion: string | null
}

export type TrustResult =
  | { ok: true; runId: string }
  | { ok: false; terminal: boolean; reason: string }

export interface Recount {
  planned: number
  passed: string[]
  failed: string[]
  notRun: string[]
  duplicates: string[]
  unplanned: string[]
  verdict: "passed" | "failed"
}

const pick = <T extends string>(value: string | undefined, allowed: readonly T[], fallback: T): T => {
  if (!value) return fallback
  if (!(allowed as readonly string[]).includes(value)) throw new Error(`unknown value "${value}"; expected one of ${allowed.join(", ")}`)
  return value as T
}

export function parseSetupInputs(event: string, inputs: Record<string, string | undefined>): SetupInputs {
  if (event !== "workflow_dispatch") return { mode: "live", kind: event === "schedule" ? "nightly" : "pr", fixtureCase: "pass" }
  return {
    mode: pick(inputs.mode, ["fixture", "live"] as const, "fixture"),
    kind: pick(inputs.kind, KINDS, "pr"),
    fixtureCase: pick(inputs.fixture_case, FIXTURE_CASES, "pass"),
  }
}

export function deploymentKey(inputs: SetupInputs, setupRunId: string, pr: number | null) {
  if (inputs.mode === "fixture") return `fixture-${setupRunId}`
  return pr ? `pr-${pr}` : `${inputs.kind}-${setupRunId}`
}

export function planShards(tests: string[], shardCount: number): PlanJson {
  const count = Math.max(1, Math.min(shardCount, tests.length))
  const shards = Array.from({ length: count }, (_, i) => ({ index: i + 1, tests: [] as string[] }))
  tests.forEach((id, i) => shards[i % count].tests.push(id))
  return { shards }
}

export const mintRunKey = () => randomBytes(16).toString("hex")

export function buildRunJson(args: {
  setupRunId: string
  runKey: string
  inputs: SetupInputs
  prSha: string
  branch: string
  pr: number | null
  steps: SetupStepResult[]
}): RunJson {
  const fixture = args.inputs.mode === "fixture"
  return {
    run_id: args.setupRunId,
    run_tag: `e2e-${args.setupRunId}`,
    run_key: args.runKey,
    mode: args.inputs.mode,
    kind: args.inputs.kind,
    fixture_case: fixture ? args.inputs.fixtureCase : null,
    fan_in: !(fixture && args.inputs.fixtureCase === "no-fan-in"),
    pr: args.pr,
    pr_sha: args.prSha,
    branch: args.branch,
    deployment: { vercel_deployment_id: null, url: null, convex_deployment: null, convex_url: null },
    gate: null,
    steps: args.steps,
  }
}

export async function runTaskSteps(ctx: SetupStepContext, load: (task: SetupTask) => Promise<{ runSetupStep: SetupStep }>) {
  const results: SetupStepResult[] = []
  for (const task of TASK_STEPS) {
    const mod = await load(task)
    const result = await mod.runSetupStep(ctx)
    if (result.task !== task) throw new Error(`step ${task} answered as ${result.task}`)
    results.push(result)
  }
  return results
}

export function checkReportTrust(args: {
  setupRunId: string
  setupRun: ApiRun
  run: RunJson
  dispatch: DispatchJson
  dispatchedRun: ApiRun | null
}): TrustResult {
  const { setupRunId, setupRun, run, dispatch, dispatchedRun } = args
  if (String(setupRun.id) !== setupRunId) return { ok: false, terminal: true, reason: `setup run id ${setupRun.id} is not ${setupRunId}` }
  if (setupRun.path !== SETUP_WORKFLOW_PATH) return { ok: false, terminal: true, reason: `setup run path is ${setupRun.path}` }
  if (setupRun.head_branch !== TRUSTED_BRANCH) return { ok: false, terminal: true, reason: `setup ran on ${setupRun.head_branch}, not ${TRUSTED_BRANCH}` }
  if (run.run_id !== setupRunId || dispatch.setup_run_id !== setupRunId) return { ok: false, terminal: true, reason: "plan does not belong to this setup run" }
  if (!run.run_key || dispatch.run_key !== run.run_key) return { ok: false, terminal: true, reason: "dispatch record run_key does not match the plan" }
  if (!dispatchedRun) return { ok: false, terminal: true, reason: `recorded run ${dispatch.run_id} not found` }
  if (String(dispatchedRun.id) !== dispatch.run_id) return { ok: false, terminal: true, reason: `run ${dispatchedRun.id} is not the recorded run ${dispatch.run_id}` }
  if (dispatchedRun.path !== RUN_WORKFLOW_PATH) return { ok: false, terminal: true, reason: `recorded run path is ${dispatchedRun.path}` }
  if (dispatchedRun.head_sha !== run.pr_sha) return { ok: false, terminal: true, reason: `run sha ${dispatchedRun.head_sha} is not planned sha ${run.pr_sha}` }
  if (dispatchedRun.status !== "completed") return { ok: false, terminal: false, reason: `run ${dispatchedRun.id} is ${dispatchedRun.status}` }
  return { ok: true, runId: dispatch.run_id }
}

export function recount(plan: PlanJson, shards: ShardResults[]): Recount {
  const planned = plan.shards.flatMap((s) => s.tests)
  const plannedSet = new Set(planned)
  const seen = new Map<string, TestResult["status"][]>()
  const unplanned: string[] = []
  for (const shard of shards) {
    for (const r of shard.results) {
      if (!plannedSet.has(r.id)) {
        unplanned.push(r.id)
        continue
      }
      seen.set(r.id, [...(seen.get(r.id) ?? []), r.status])
    }
  }
  const passed: string[] = []
  const failed: string[] = []
  const notRun: string[] = []
  const duplicates: string[] = []
  for (const id of planned) {
    const statuses = seen.get(id)
    if (!statuses) notRun.push(id)
    else if (statuses.length > 1) duplicates.push(id)
    else if (statuses[0] === "passed") passed.push(id)
    else failed.push(id)
  }
  const verdict = passed.length === planned.length && unplanned.length === 0 ? "passed" : "failed"
  return { planned: planned.length, passed, failed, notRun, duplicates, unplanned, verdict }
}

export function renderSummary(args: { setupRunId: string; runId: string; run: RunJson; count: Recount; repoUrl: string }) {
  const { setupRunId, runId, run, count, repoUrl } = args
  const lines = [
    `## e2e report: ${count.verdict}`,
    "",
    `Setup run [${setupRunId}](${repoUrl}/actions/runs/${setupRunId}) (${run.mode}, kind ${run.kind}${run.fixture_case ? `, case ${run.fixture_case}` : ""}), test run [${runId}](${repoUrl}/actions/runs/${runId}), sha \`${run.pr_sha}\`.`,
    "",
    "| Planned | Passed | Failed | Not run | Duplicate | Unplanned |",
    "|---|---|---|---|---|---|",
    `| ${count.planned} | ${count.passed.length} | ${count.failed.length} | ${count.notRun.length} | ${count.duplicates.length} | ${count.unplanned.length} |`,
  ]
  const list = (title: string, ids: string[]) => (ids.length ? ["", `**${title}**`, ...ids.map((id) => `- \`${id}\``)] : [])
  return [
    ...lines,
    ...list("Failed", count.failed),
    ...list("Not run (counted as failed)", count.notRun),
    ...list("Duplicate results", count.duplicates),
    ...list("Results for tests not in the plan", count.unplanned),
    "",
  ].join("\n")
}

export function pickSweepTargets(setupRuns: { id: number; artifacts: string[] }[], reported: Set<string>) {
  return setupRuns
    .filter((r) => r.artifacts.includes("e2e-dispatch") && !reported.has(String(r.id)))
    .map((r) => String(r.id))
}

const env = (name: string) => {
  const v = process.env[name]
  if (!v) throw new Error(`${name} is not set`)
  return v
}

const output = (pairs: Record<string, string>) => {
  const file = process.env.GITHUB_OUTPUT
  const text = Object.entries(pairs).map(([k, v]) => `${k}=${v}\n`).join("")
  if (file) appendFileSync(file, text)
  else process.stdout.write(text)
}

const summary = (md: string) => {
  const file = process.env.GITHUB_STEP_SUMMARY
  if (file) appendFileSync(file, md + "\n")
  process.stdout.write(md + "\n")
}

const readJson = <T>(path: string): T => JSON.parse(readFileSync(path, "utf8")) as T

async function api<T>(path: string, init: { method?: string; body?: unknown; version?: string } = {}): Promise<{ status: number; body: T }> {
  const res = await fetch(`${process.env.GITHUB_API_URL ?? "https://api.github.com"}/repos/${env("GITHUB_REPOSITORY")}${path}`, {
    method: init.method ?? "GET",
    headers: {
      authorization: `Bearer ${env("GH_TOKEN")}`,
      accept: "application/vnd.github+json",
      "x-github-api-version": init.version ?? "2022-11-28",
      ...(init.body ? { "content-type": "application/json" } : {}),
    },
    body: init.body ? JSON.stringify(init.body) : undefined,
  })
  const text = await res.text()
  if (res.status >= 400 && res.status !== 404) throw new Error(`${init.method ?? "GET"} ${path}: ${res.status} ${text}`)
  return { status: res.status, body: (text ? JSON.parse(text) : null) as T }
}

async function getRun(id: string) {
  const { status, body } = await api<ApiRun>(`/actions/runs/${id}`)
  return status === 404 ? null : body
}

async function artifactNames(runId: number | string) {
  const { body } = await api<{ artifacts: { name: string; expired: boolean }[] }>(`/actions/runs/${runId}/artifacts?per_page=100`)
  return (body?.artifacts ?? []).filter((a) => !a.expired).map((a) => a.name)
}

async function isReported(setupRunId: string) {
  const { body } = await api<{ total_count: number }>(`/actions/artifacts?name=e2e-outcome-${setupRunId}&per_page=1`)
  return (body?.total_count ?? 0) > 0
}

async function readArtifactFile<T>(runId: string, name: string, file: string): Promise<T | null> {
  const { body } = await api<{ artifacts: { id: number; name: string }[] }>(`/actions/runs/${runId}/artifacts?name=${name}`)
  const artifact = body?.artifacts?.[0]
  if (!artifact) return null
  const res = await fetch(`${process.env.GITHUB_API_URL ?? "https://api.github.com"}/repos/${env("GITHUB_REPOSITORY")}/actions/artifacts/${artifact.id}/zip`, {
    headers: { authorization: `Bearer ${env("GH_TOKEN")}`, accept: "application/vnd.github+json" },
  })
  if (!res.ok) throw new Error(`artifact ${name} of run ${runId}: ${res.status}`)
  const zip = join(tmpdir(), `${name}-${runId}.zip`)
  writeFileSync(zip, Buffer.from(await res.arrayBuffer()))
  return JSON.parse(execFileSync("unzip", ["-p", zip, file], { encoding: "utf8" })) as T
}

async function cmdResolve() {
  const event = env("GITHUB_EVENT_NAME")
  const inputs = parseSetupInputs(event, { mode: process.env.INPUT_MODE, kind: process.env.INPUT_KIND, fixture_case: process.env.INPUT_FIXTURE_CASE })
  const payload = process.env.GITHUB_EVENT_PATH && existsSync(process.env.GITHUB_EVENT_PATH) ? readJson<{ pull_request?: { number: number } }>(process.env.GITHUB_EVENT_PATH) : {}
  const pr = payload.pull_request?.number ?? null
  output({ mode: inputs.mode, kind: inputs.kind, fixture_case: inputs.fixtureCase, deployment: deploymentKey(inputs, env("GITHUB_RUN_ID"), pr) })
}

async function cmdPrepare(outDir: string) {
  const setupRunId = env("GITHUB_RUN_ID")
  const inputs: SetupInputs = {
    mode: pick(process.env.MODE, ["fixture", "live"] as const, "fixture"),
    kind: pick(process.env.KIND, KINDS, "pr"),
    fixtureCase: pick(process.env.FIXTURE_CASE, FIXTURE_CASES, "pass"),
  }
  if (inputs.mode === "live") {
    summary(`## e2e setup (${inputs.kind})\n\nLive setup is not built yet; nothing was dispatched.`)
    output({ dispatch: "false" })
    return
  }
  mkdirSync(outDir, { recursive: true })
  const ctx: SetupStepContext = { kind: inputs.kind, mode: inputs.mode, setupRunId, workDir: outDir }
  const steps = await runTaskSteps(ctx, (task) => import(new URL(`../${task}/index.ts`, import.meta.url).href))
  const run = buildRunJson({ setupRunId, runKey: mintRunKey(), inputs, prSha: env("GITHUB_SHA"), branch: env("GITHUB_REF_NAME"), pr: null, steps })
  const plan = planShards(FIXTURE_TESTS, FIXTURE_SHARDS)
  writeFileSync(join(outDir, "run.json"), JSON.stringify(run, null, 2))
  writeFileSync(join(outDir, "plan.json"), JSON.stringify(plan, null, 2))
  summary(
    [
      `## e2e setup (fixture, kind ${run.kind}, case ${run.fixture_case})`,
      "",
      `Planned ${FIXTURE_TESTS.length} tests in ${plan.shards.length} shards at \`${run.pr_sha}\` on \`${run.branch}\`.`,
      "",
      ...steps.map((s) => `- ${s.task}: ${s.status}`),
    ].join("\n"),
  )
  output({ dispatch: "true", ref: run.branch })
}

async function cmdDispatch(planDir: string, outDir: string) {
  const run = readJson<RunJson>(join(planDir, "run.json"))
  const { status, body } = await api<{ workflow_run_id?: number; html_url?: string }>(`/actions/workflows/e2e-run.yml/dispatches`, {
    method: "POST",
    body: { ref: run.branch, inputs: { setup_run_id: run.run_id, run_key: run.run_key } },
    version: "2026-03-10",
  })
  if (!body?.workflow_run_id) throw new Error(`dispatch of e2e-run.yml returned ${status} with no workflow_run_id`)
  const record: DispatchJson = { setup_run_id: run.run_id, run_key: run.run_key, run_id: String(body.workflow_run_id), html_url: body.html_url ?? null }
  mkdirSync(outDir, { recursive: true })
  writeFileSync(join(outDir, "dispatch.json"), JSON.stringify(record, null, 2))
  summary(`Dispatched e2e-run.yml at \`${run.branch}\`: run [${record.run_id}](${record.html_url ?? ""}).`)
}

async function cmdTargets() {
  const requested = process.env.SETUP_RUN_ID?.trim()
  let ids: string[]
  if (requested) {
    if (!/^\d+$/.test(requested)) throw new Error(`setup_run_id "${requested}" is not a run id`)
    ids = [requested]
  } else {
    const since = new Date(Date.now() - 24 * 3600 * 1000).toISOString()
    const { body } = await api<{ workflow_runs: { id: number }[] }>(
      `/actions/workflows/e2e-setup.yml/runs?branch=${TRUSTED_BRANCH}&status=completed&created=>=${since}&per_page=100`,
    )
    const runs = []
    for (const r of body?.workflow_runs ?? []) runs.push({ id: r.id, artifacts: await artifactNames(r.id) })
    const reported = new Set<string>()
    for (const r of runs) if (await isReported(String(r.id))) reported.add(String(r.id))
    ids = pickSweepTargets(runs, reported)
    summary(`## e2e report sweep\n\nChecked ${runs.length} setup runs on \`${TRUSTED_BRANCH}\` from the last 24 h; ${ids.length} to report: ${ids.join(", ") || "none"}.`)
  }
  const targets = []
  for (const id of ids) {
    const run = await readArtifactFile<RunJson>(id, "e2e-plan", "run.json").catch(() => null)
    targets.push({ setup_run_id: id, mode: run?.mode === "live" ? "live" : "fixture" })
  }
  output({ targets: JSON.stringify(targets), any: targets.length ? "true" : "false" })
}

async function cmdTrust(planDir: string, dispatchDir: string) {
  const setupRunId = env("SETUP_RUN_ID")
  if (await isReported(setupRunId)) {
    summary(`Setup run ${setupRunId} already has a report; nothing to do.`)
    output({ ok: "false", record: "false" })
    return
  }
  const run = readJson<RunJson>(join(planDir, "run.json"))
  const dispatch = readJson<DispatchJson>(join(dispatchDir, "dispatch.json"))
  const setupRun = await getRun(setupRunId)
  if (!setupRun) throw new Error(`setup run ${setupRunId} not found`)
  const waitUntil = Date.now() + Number(process.env.WAIT_SECONDS ?? "0") * 1000
  let result: TrustResult
  for (;;) {
    result = checkReportTrust({ setupRunId, setupRun, run, dispatch, dispatchedRun: await getRun(dispatch.run_id) })
    if (result.ok || result.terminal || Date.now() >= waitUntil) break
    await new Promise((r) => setTimeout(r, 10_000))
  }
  if (result.ok) {
    output({ ok: "true", record: "true", run_id: result.runId })
    return
  }
  summary(`## e2e report: not reported\n\nSetup run ${setupRunId}: ${result.reason}.${result.terminal ? "" : " The scheduled sweep retries."}`)
  output({ ok: "false", record: result.terminal && setupRun.path === SETUP_WORKFLOW_PATH && setupRun.head_branch === TRUSTED_BRANCH ? "true" : "false", reason: result.reason })
}

async function cmdRecount(planDir: string, shardsDir: string, outDir: string) {
  const setupRunId = env("SETUP_RUN_ID")
  const runId = env("RUN_ID")
  const run = readJson<RunJson>(join(planDir, "run.json"))
  const plan = readJson<PlanJson>(join(planDir, "plan.json"))
  const shards = existsSync(shardsDir)
    ? readdirSync(shardsDir).filter((f) => f.endsWith(".json")).map((f) => readJson<ShardResults>(join(shardsDir, f)))
    : []
  const count = recount(plan, shards)
  summary(renderSummary({ setupRunId, runId, run, count, repoUrl: `${env("GITHUB_SERVER_URL")}/${env("GITHUB_REPOSITORY")}` }))
  mkdirSync(outDir, { recursive: true })
  writeFileSync(join(outDir, "outcome.json"), JSON.stringify({ setup_run_id: setupRunId, run_id: runId, verdict: count.verdict, count, finished: true, restored: run.mode === "fixture" ? "not-contained" : null }, null, 2))
}

async function cmdReject(outDir: string) {
  mkdirSync(outDir, { recursive: true })
  writeFileSync(join(outDir, "outcome.json"), JSON.stringify({ setup_run_id: env("SETUP_RUN_ID"), verdict: "rejected", reason: process.env.REASON ?? "", finished: true }, null, 2))
}

export async function main(argv: string[]) {
  const [cmd, ...rest] = argv
  switch (cmd) {
    case "resolve":
      return cmdResolve()
    case "prepare":
      return cmdPrepare(rest[0])
    case "dispatch":
      return cmdDispatch(rest[0], rest[1])
    case "targets":
      return cmdTargets()
    case "trust":
      return cmdTrust(rest[0], rest[1])
    case "recount":
      return cmdRecount(rest[0], rest[1], rest[2])
    case "reject":
      return cmdReject(rest[0])
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
