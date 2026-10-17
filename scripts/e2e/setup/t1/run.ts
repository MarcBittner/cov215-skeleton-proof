import { runTagFor } from "../../contract/constants.js"
import type { SetupPlan } from "../../contract/types.js"
import type { PreviewDeployment } from "./control-plane.js"
import { RUN_KINDS, TargetRefused, checkTarget, type DenyList, type RunKind } from "./target.js"

export type RunDeployment = SetupPlan["deployment"]

export type RunPlan = Pick<SetupPlan, "setup_run_id" | "run_tag" | "kind" | "pr" | "pr_sha" | "branch" | "deployment">

export interface RunUser {
  email: string
  created_at: number
  deleted: boolean
  tenant: string | null
}

export interface RunTicket {
  user_id: string
  minted_at: number
  used: boolean
}

export interface RunSession {
  user_id: string
  opened_at: number
  source: "setup" | "recorded"
}

export interface RunTenant {
  recipe: string
  test_id: string
  name: string
  created_at: number
  deleted: boolean
  users: string[]
}

export interface RunState {
  version: 1
  setup_run_id: string
  run_tag: string
  kind: RunKind
  branch: string
  pr: number | null
  pr_sha: string
  deployment: RunDeployment
  started_at: number
  deadline: number
  users: Record<string, RunUser>
  tickets: Record<string, RunTicket>
  sessions: Record<string, RunSession>
  tenants: Record<string, RunTenant>
  usage: { users: number; tenants: number; ai_calls: number; ticket_mints: number[] }
}

export const DEFAULT_RUN_DEADLINE_MS = 90 * 60 * 1000

const RUN_ID = /^[1-9]\d{0,19}$/
const SHA = /^[0-9a-f]{40}$/

export interface PullRequestRepos {
  head_repo: string
  base_repo: string
}

export interface TargetDeps {
  reportedConvexUrl: (deployment: RunDeployment) => Promise<string | null>
  resolvePreview: (previewName: string) => Promise<PreviewDeployment>
  deny?: DenyList
}

export interface VerifiedTarget {
  deploymentName: string
  url: string
  adminKey: string
}

const verifiedTargets = new WeakMap<RunState, VerifiedTarget>()

function normUrl(u: string | null | undefined): string {
  return String(u ?? "").trim().replace(/\/+$/, "").toLowerCase()
}

export function verifiedTarget(state: RunState, action = "authenticated call"): VerifiedTarget {
  const t = verifiedTargets.get(state)
  if (!t) {
    throw new TargetRefused(action, state.deployment.convex_deployment, "unverified", "run target not confirmed through the Convex control plane")
  }
  return t
}

export function assertCallerTarget(state: RunState, caller: { url?: unknown } | null | undefined, action: string): void {
  const t = verifiedTarget(state, action)
  const url = typeof caller?.url === "string" ? caller.url : ""
  if (!url || normUrl(url) !== normUrl(t.url)) {
    throw new TargetRefused(action, state.deployment.convex_deployment, "target-mismatch", `caller targets ${url || "no URL"}, run is ${t.url}`)
  }
}

export async function verifyRunTarget(state: RunState, deps: TargetDeps): Promise<VerifiedTarget> {
  const d = state.deployment
  checkTarget(state, d, "create-run", deps.deny)
  const served = await deps.reportedConvexUrl(d)
  const resolved = await deps.resolvePreview(state.branch)
  const want = normUrl(resolved.url)
  if (normUrl(served) !== want || normUrl(d.convex_url) !== want || d.convex_deployment !== resolved.deploymentName) {
    throw new TargetRefused(
      "create-run",
      d.convex_deployment,
      "target-mismatch",
      `preview ${state.branch} is ${resolved.url} per the Convex control plane; page serves ${served ?? "none"}, run.json names ${d.convex_url}`,
    )
  }
  checkTarget(state, { convex_deployment: resolved.deploymentName, convex_url: resolved.url }, "create-run", deps.deny)
  const t = { deploymentName: resolved.deploymentName, url: resolved.url, adminKey: resolved.adminKey }
  verifiedTargets.set(state, t)
  return t
}

export function assertSameRepoPr(run: Pick<RunPlan, "kind" | "deployment">, repos: PullRequestRepos | undefined): void {
  if (run.kind !== "pr") return
  const name = run.deployment?.convex_deployment ?? ""
  if (!repos || !repos.head_repo || !repos.base_repo) throw new TargetRefused("create-run", name, "fork-pr", "PR head and base repository are unknown")
  if (repos.head_repo.toLowerCase() !== repos.base_repo.toLowerCase()) {
    throw new TargetRefused("create-run", name, "fork-pr", `head ${repos.head_repo} is not ${repos.base_repo}`)
  }
}

export async function createRun(
  run: RunPlan,
  deps: TargetDeps & {
    pullRequest?: PullRequestRepos
    now?: () => number
    deadlineMs?: number
  },
): Promise<RunState> {
  const runId = String(run.setup_run_id ?? "")
  if (!RUN_ID.test(runId)) throw new Error(`run.json setup_run_id must be a GitHub run id, got "${runId}"`)
  if (!(RUN_KINDS as readonly string[]).includes(run.kind)) throw new Error(`run.json kind "${run.kind}" is unknown`)
  if (!SHA.test(String(run.pr_sha ?? ""))) throw new Error("run.json pr_sha must be a 40-char sha")
  if (run.kind === "pr" && !(typeof run.pr === "number" && run.pr > 0)) throw new Error("a pr run needs its PR number")
  const d = run.deployment
  if (!d || !d.convex_deployment || !d.convex_url || !d.vercel_deployment_id || !d.url) {
    throw new Error("run.json deployment is incomplete")
  }
  if (run.run_tag !== runTagFor(runId)) throw new Error(`run_tag must be ${runTagFor(runId)}, got "${run.run_tag}"`)
  assertSameRepoPr(run, deps.pullRequest)
  checkTarget(run, d, "create-run", deps.deny)
  const now = (deps.now ?? Date.now)()
  const state: RunState = {
    version: 1,
    setup_run_id: runId,
    run_tag: run.run_tag,
    kind: run.kind,
    branch: run.branch,
    pr: run.pr ?? null,
    pr_sha: run.pr_sha,
    deployment: { ...d },
    started_at: now,
    deadline: now + (deps.deadlineMs ?? DEFAULT_RUN_DEADLINE_MS),
    users: {},
    tickets: {},
    sessions: {},
    tenants: {},
    usage: { users: 0, tenants: 0, ai_calls: 0, ticket_mints: [] },
  }
  await verifyRunTarget(state, deps)
  return state
}

export function serializeRunState(state: RunState): string {
  return JSON.stringify(state, null, 2)
}

export function parseRunState(raw: string): RunState {
  const s = JSON.parse(raw) as RunState
  if (!s || s.version !== 1) throw new Error("run state: unsupported version")
  if (!RUN_ID.test(String(s.setup_run_id)) || s.run_tag !== runTagFor(String(s.setup_run_id))) {
    throw new Error("run state: bad run id or tag")
  }
  for (const k of ["users", "tickets", "sessions", "tenants"] as const) {
    if (!s[k] || typeof s[k] !== "object") throw new Error(`run state: ${k} missing`)
  }
  return s
}
