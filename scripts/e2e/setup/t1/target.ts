import { DENIED_DEPLOYMENTS, DENY_ENV_VARS } from "./deny.js"

export const RUN_KINDS = ["pr", "postmerge", "nightly", "gate", "mut", "fallback", "fresh", "base"] as const
export type RunKind = (typeof RUN_KINDS)[number]

export const TOOLING_KINDS = ["postmerge", "gate", "mut", "fallback", "fresh", "base"] as const

export const TARGET_ACTIONS = [
  "create-run",
  "seed",
  "reset",
  "mail-contain",
  "mail-restore",
  "tenant-create",
  "tenant-delete",
  "user-create",
  "user-delete",
  "ticket-mint",
  "function-push",
  "sweep",
] as const
export type TargetAction = (typeof TARGET_ACTIONS)[number]

export interface TargetRun {
  kind: RunKind
  branch: string
  deployment: { convex_deployment: string; convex_url: string }
}

export interface Target {
  convex_deployment: string
  convex_url?: string
}

export class TargetRefused extends Error {
  constructor(
    readonly action: string,
    readonly deployment: string,
    readonly reason: string,
    readonly detail?: string,
  ) {
    super(`target refused for ${action} on ${deployment || "<none>"}: ${reason}${detail ? ` (${detail})` : ""}`)
    this.name = "TargetRefused"
  }
}

export type DenyList = ReadonlyMap<string, string>

const DEPLOYMENT_NAME = /^[a-z]+-[a-z]+-\d+$/
const PROTECTED_BRANCHES = new Set(["staging", "main", "master", "production", "prod"])
const NIGHTLY_BRANCH = /^e2e-nightly-\d{8}$/
const TOOLING_BRANCH = /^e2e\/([a-z]+)\/[A-Za-z0-9][A-Za-z0-9._-]{0,63}$/

export function denyList(env: Record<string, string | undefined> = {}, extra: readonly string[] = []): DenyList {
  const out = new Map<string, string>()
  for (const d of DENIED_DEPLOYMENTS) out.set(d.name, d.role)
  for (const key of DENY_ENV_VARS) {
    for (const name of (env[key] ?? "").split(",")) {
      const n = name.trim().toLowerCase()
      if (n && !out.has(n)) out.set(n, key)
    }
  }
  for (const name of extra) {
    const n = name.trim().toLowerCase()
    if (n && !out.has(n)) out.set(n, "deny file")
  }
  return out
}

export function deploymentFromConvexUrl(url: string): string | null {
  let host: string
  try {
    const u = new URL(url)
    if (u.protocol !== "https:") return null
    host = u.hostname.toLowerCase()
  } catch {
    return null
  }
  const m = /^([a-z]+-[a-z]+-\d+)\.convex\.(cloud|site)$/.exec(host)
  return m ? m[1] : null
}

function refuse(action: string, deployment: string, reason: string): never {
  throw new TargetRefused(action, deployment, reason)
}

export function branchMatchesKind(kind: RunKind, branch: string): string | null {
  if (kind === "pr") {
    if (!branch || PROTECTED_BRANCHES.has(branch)) return `branch "${branch}" is not a PR branch`
    if (branch.startsWith("e2e/") || branch.startsWith("e2e-nightly-")) return `tooling branch "${branch}" is not a PR branch`
    return null
  }
  if (kind === "nightly") {
    return NIGHTLY_BRANCH.test(branch) ? null : `nightly branch must be e2e-nightly-<YYYYMMDD>, got "${branch}"`
  }
  const m = TOOLING_BRANCH.exec(branch)
  if (!m || m[1] !== kind) return `${kind} branch must be e2e/${kind}/<id>, got "${branch}"`
  return null
}

export function checkTarget(
  run: TargetRun,
  target: Target,
  action: TargetAction,
  deny: DenyList = denyList(process.env),
): { deployment: string; action: TargetAction } {
  if (!(TARGET_ACTIONS as readonly string[]).includes(action)) refuse(action, target.convex_deployment, "unknown action")
  const name = String(target.convex_deployment ?? "").trim().toLowerCase()
  const runName = String(run.deployment.convex_deployment ?? "").trim().toLowerCase()
  const urlNames = [target.convex_url, run.deployment.convex_url]
    .filter((u): u is string => typeof u === "string" && u.length > 0)
    .map((u) => deploymentFromConvexUrl(u))
  for (const n of [name, runName, ...urlNames]) {
    if (n && deny.has(n)) refuse(action, n, `${n} is ${deny.get(n)} and is never a target`)
  }
  if (!DEPLOYMENT_NAME.test(name)) refuse(action, name, "not a Convex deployment name")
  if (name !== runName) refuse(action, name, `not this run's deployment (${runName})`)
  for (const [i, u] of [target.convex_url, run.deployment.convex_url].entries()) {
    if (i === 0 && u === undefined) continue
    const n = deploymentFromConvexUrl(String(u ?? ""))
    if (n !== name) refuse(action, name, `Convex URL does not name ${name}`)
  }
  if (!(RUN_KINDS as readonly string[]).includes(run.kind)) refuse(action, name, `unknown run kind ${run.kind}`)
  const branchError = branchMatchesKind(run.kind, run.branch)
  if (branchError) refuse(action, name, branchError)
  if (action === "function-push" && run.kind !== "mut") refuse(action, name, "function push is allowed only on a mutation deployment")
  return { deployment: name, action }
}

export async function guarded<T>(
  run: TargetRun,
  target: Target,
  action: TargetAction,
  write: () => Promise<T>,
  deny?: DenyList,
): Promise<T> {
  checkTarget(run, target, action, deny)
  return write()
}
