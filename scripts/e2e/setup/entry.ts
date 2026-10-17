import { createHash } from "node:crypto"
import { existsSync, mkdirSync, writeFileSync } from "node:fs"
import { join } from "node:path"
import { pathToFileURL } from "node:url"

import { CONTRACT_VERSION, FILES, newRunKey, runTagFor } from "../contract/constants.js"
import { validateRunRequest, validateSetupPlan, validateShardPlan } from "../contract/formats.js"
import type { GateEntry, RunKind, SetupPlan } from "../contract/types.js"
import { type GitHub, env, gitHubClient, output, readJsonFile, summary } from "../lib/github.js"
import { planShards, planSummary, shardPlanDoc } from "../plan-shards.mjs"
import { catalogueFromList } from "../report/id.mjs"
import { readSetupPlan } from "../report/cli.js"
import { FIXTURE_CASES, KINDS, type FixtureCase, deploymentKey, parseSetupInputs, runTaskSteps } from "./t2/skeleton.js"
import { readConvexTarget } from "./t2/resolve-convex.js"
import { createGitHubReader } from "./t2/resolve-github.js"
import { READY_TIMEOUT_MS, readPreview, type PullRequestTargetEvent } from "./t2/resolve.js"
import { createSetupGitHub } from "./t2/github.js"
import { resolvePullRequestTarget } from "./t2/resolve-target.js"
import { editsBuildRules, skipsBuild } from "./t2/skip.js"
import { parseGateInputs } from "./t2/gate.js"
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
  if (kind === "pr" && pr === null) throw new Error("a fixture run of kind pr needs the pr input (a pull request number in this repository)")
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
    gate: kind === "gate" ? { ref: "artifact:fixture-gate", path: "e2e/fixture/gate.spec.ts", sha256: createHash("sha256").update("fixture").digest("hex"), break: null } : null,
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
  mkdirSync(outDir, { recursive: true })
  writeFileSync(join(outDir, FILES.setupPlan), JSON.stringify(run, null, 2) + "\n")
  writeFileSync(join(outDir, FILES.shardPlan), JSON.stringify(doc, null, 2) + "\n")
  writeFileSync(join(outDir, "plan-summary.json"), JSON.stringify(planSummary(plan, catalogue), null, 2) + "\n")
  for (const s of plan.shards) writeFileSync(join(outDir, `shard-${s.shard}.txt`), s.ids.join("\n") + "\n")
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

export type PrTarget = { ready: string } | { fallback: string } | { refused: string }

export interface ResolveClients {
  branchHead(ref: string): Promise<string | null>
  pull(pr: number): Promise<{ headSha: string; headRepo: string | null; baseRepo: string } | null>
  prTarget(pr: number): Promise<PrTarget>
  baseConvex(sha: string): Promise<string | null>
  mergeBase(sha: string): Promise<string>
}

export interface LiveResolution {
  refused: string | null
  headSha: string
  deployment: string
}

export async function resolveLive(
  a: { kind: RunKind; pr: number | null; setupRunId: string; repo: string; sha: string; gate?: { gate: GateEntry | null; refused: string | null } },
  clients: () => ResolveClients,
): Promise<LiveResolution> {
  if (a.gate?.refused) return { refused: a.gate.refused, headSha: a.sha, deployment: `${a.kind}-${a.setupRunId}` }
  if (a.kind === "gate") {
    if (!a.gate?.gate) return { refused: "a gate run needs gate_ref, gate_sha256 and gate_break", headSha: a.sha, deployment: `gate-${a.setupRunId}` }
    const head = await clients().branchHead(a.gate.gate.ref)
    if (!head) return { refused: `${a.gate.gate.ref} does not exist`, headSha: a.sha, deployment: `gate-${a.setupRunId}` }
    return { refused: null, headSha: head, deployment: `gate-${a.setupRunId}` }
  }
  if (a.pr === null) return { refused: null, headSha: a.sha, deployment: `${a.kind}-${a.setupRunId}` }
  if (!a.repo) throw new Error("GITHUB_REPOSITORY is not set")
  const c = clients()
  const pull = await c.pull(a.pr)
  const refuse = (refused: string): LiveResolution => ({ refused, headSha: a.sha, deployment: `pr-${a.pr}` })
  if (!pull) return refuse(`PR #${a.pr} was not found`)
  if (pull.headRepo !== a.repo || pull.baseRepo !== a.repo) return refuse("fork PRs are not run")
  if (a.kind === "base") {
    const sha12 = (await c.mergeBase(pull.headSha)).slice(0, 12)
    return { refused: null, headSha: pull.headSha, deployment: (await c.baseConvex(sha12)) ?? `base-${sha12}` }
  }
  if (a.kind !== "pr") return { refused: null, headSha: pull.headSha, deployment: `${a.kind}-${a.setupRunId}` }
  const t = await c.prTarget(a.pr)
  if ("refused" in t) return refuse(t.refused)
  return { refused: null, headSha: pull.headSha, deployment: "ready" in t ? t.ready : t.fallback }
}

export function resolveClients(gh: GitHub, token: string, opts: { setupRunId: string; stagingDir: string; readyBoundMs: number }): ResolveClients {
  const reader = createGitHubReader({ repo: gh.repo, token })
  const setup = createSetupGitHub({ repo: gh.repo, token })
  const fetchText = async (url: string) => {
    if (!url.startsWith("https://")) throw new Error(`refusing ${url}`)
    const res = await fetch(url, { signal: AbortSignal.timeout(30_000) })
    if (!res.ok) throw new Error(`${res.status} for ${new URL(url).pathname}`)
    return res.text()
  }
  return {
    async branchHead(ref) {
      return (await setup.getBranch(ref))?.sha ?? null
    },
    async pull(pr) {
      const p = await gh.get<{ head: { sha: string; repo: { full_name: string } | null }; base: { repo: { full_name: string } } }>(`/pulls/${pr}`)
      return p ? { headSha: p.head.sha, headRepo: p.head.repo?.full_name ?? null, baseRepo: p.base.repo.full_name } : null
    },
    async prTarget(pr) {
      const event = { action: "synchronize", number: pr, pull_request: { number: pr } } as PullRequestTargetEvent
      const r = await resolvePullRequestTarget(event, {
        reader,
        fetchText,
        repo: gh.repo,
        headSkipsBuild: (prSha) => skipsBuild({ github: setup, reader, pr, prSha, stagingDir: opts.stagingDir }),
        wait: { timeoutMs: opts.readyBoundMs },
      })
      if (r.status === "ready") return { ready: r.convex.deployment }
      if (r.status === "skip") return { refused: `not run: ${r.reason}` }
      if (editsBuildRules(await setup.listPullFiles(pr)).length) return { fallback: `fallback-${opts.setupRunId}` }
      return { refused: `no READY preview in time: ${r.reason}` }
    },
    async baseConvex(sha12) {
      try {
        const branch = await setup.getBranch(`e2e/base/${sha12}`)
        if (!branch) return null
        const preview = await readPreview(reader, branch.sha)
        return preview.state === "READY" ? (await readConvexTarget(preview.url, fetchText)).deployment : null
      } catch {
        return null
      }
    },
    async mergeBase(sha) {
      return setup.mergeBase("staging", sha)
    },
  }
}

const pick = <T extends string>(value: string | undefined, allowed: readonly T[], fallback: T): T => {
  if (!value) return fallback
  if (!(allowed as readonly string[]).includes(value)) throw new Error(`unknown value "${value}"; expected one of ${allowed.join(", ")}`)
  return value as T
}

export function parsePr(value: string | undefined) {
  if (!value) return null
  if (!/^[1-9][0-9]{0,9}$/.test(value)) throw new Error(`pr "${value}" is not a pull request number`)
  return Number(value)
}

export async function main(argv: string[], source: Record<string, string | undefined> = process.env, deps: { gh?: GitHub; resolve?: ResolveClients } = {}) {
  const [cmd, dir] = argv
  const client = () => deps.gh ?? gitHubClient({ repo: env("GITHUB_REPOSITORY", source), token: env("GH_TOKEN", source), apiUrl: source.GITHUB_API_URL })
  switch (cmd) {
    case "resolve": {
      const event = env("GITHUB_EVENT_NAME", source)
      const inputs = parseSetupInputs(event, { mode: source.INPUT_MODE, kind: source.INPUT_KIND, fixture_case: source.INPUT_FIXTURE_CASE })
      const payload = source.GITHUB_EVENT_PATH && existsSync(source.GITHUB_EVENT_PATH) ? readJsonFile<{ pull_request?: { number: number } }>(source.GITHUB_EVENT_PATH) : {}
      const inputPr = parsePr(source.INPUT_PR)
      const pr = payload.pull_request?.number ?? null
      const setupRunId = env("GITHUB_RUN_ID", source)
      const gated = inputs.mode === "live" && source.LIVE_SETUP === "true"
      const gate = parseGateInputs(inputs.kind, source)
      const live = gated
        ? await resolveLive(
            { kind: inputs.kind, pr: pr ?? inputPr, setupRunId, repo: source.GITHUB_REPOSITORY ?? "", sha: env("GITHUB_SHA", source), gate },
            () =>
              deps.resolve ??
              resolveClients(client(), env("GH_TOKEN", source), { setupRunId, stagingDir: process.cwd(), readyBoundMs: Number(source.E2E_READY_BOUND_MS ?? READY_TIMEOUT_MS) }),
          )
        : null
      if (live?.refused) summary(`## e2e setup\n\nNot run: ${live.refused}. Nothing keyed ran.`, source)
      output(
        {
          mode: inputs.mode,
          kind: inputs.kind,
          fixture_case: inputs.fixtureCase,
          pr: String(pr ?? inputPr ?? ""),
          deployment: live?.deployment ?? deploymentKey(inputs, setupRunId, pr),
          live: String(gated && !live?.refused),
          refused: live?.refused ?? "",
          head_sha: live?.headSha ?? env("GITHUB_SHA", source),
          gate_spec: live && !live.refused && gate.gate ? gate.gate.path : "",
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
        if (source.LIVE === "true") throw new Error("live setup runs through scripts/e2e/setup/t2/live-env, not this entry")
        summary(`## e2e setup (${kind})\n\nLive setup is off: repository variable \`${LIVE_SETUP_VARIABLE}\` is not \`true\`. Nothing was dispatched.`, source)
        output({ dispatch: "false" }, source)
        return
      }
      const fixtureCase = pick(source.FIXTURE_CASE, FIXTURE_CASES, "pass")
      const { run, doc, steps } = await prepareFixture({
        outDir: dir,
        setupRunId,
        kind,
        fixtureCase,
        pr: parsePr(source.PR),
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
