import { MAX_RUN_TENANTS, MAX_RUN_USERS } from "../../contract/constants.js"
import type { RunState } from "./run.js"

export const OPERATIONS = [
  "createRun",
  "targetCheck",
  "userCreate",
  "userDelete",
  "ticketMint",
  "sessionRecord",
  "tenantCreate",
  "tenantDelete",
  "tenantRows",
  "seedIntegrity",
  "mailContain",
  "mailRestore",
  "mailState",
  "confirmDeployment",
  "nightlyPrepare",
  "selectAi",
  "sweep",
] as const
export type Operation = (typeof OPERATIONS)[number]

export const REFUSED_OPERATIONS = ["convexJwt", "staffConvexJwt", "verifier", "staffVerifier", "staffTicket"] as const

export const RUN_LIMITS = {
  users: MAX_RUN_USERS,
  ticketsPerMinute: 60,
  tenants: MAX_RUN_TENANTS,
  aiCalls: 2,
} as const

export class OutOfScopeError extends Error {
  constructor(message: string) {
    super(`out of run scope: ${message}`)
    this.name = "OutOfScopeError"
  }
}

export class RunLimitError extends Error {
  constructor(
    readonly limit: keyof typeof RUN_LIMITS,
    message: string,
  ) {
    super(message)
    this.name = "RunLimitError"
  }
}

export function assertOperation(name: string): asserts name is Operation {
  if (!(OPERATIONS as readonly string[]).includes(name)) {
    throw new OutOfScopeError(`operation "${name}" is not on the setup operation allowlist`)
  }
}

export function assertOwnUser(state: RunState, userId: string): void {
  const u = state.users[userId]
  if (!u) throw new OutOfScopeError(`user ${userId} was not created by run ${state.setup_run_id}`)
  if (u.deleted) throw new OutOfScopeError(`user ${userId} of run ${state.setup_run_id} is already deleted`)
}

export function assertOwnTenant(state: RunState, orgId: string): void {
  const t = state.tenants[orgId]
  if (!t) throw new OutOfScopeError(`tenant ${orgId} was not created by run ${state.setup_run_id}`)
  if (t.deleted) throw new OutOfScopeError(`tenant ${orgId} of run ${state.setup_run_id} is already deleted`)
}

export function assertOwnDeployment(state: RunState, deployment: string | undefined): void {
  if (deployment !== undefined && deployment !== state.deployment.convex_deployment) {
    throw new OutOfScopeError(`deployment ${deployment} is not run ${state.setup_run_id}'s (${state.deployment.convex_deployment})`)
  }
}

export function assertRunTagged(state: RunState, email: string): void {
  const local = email.split("@")[0] ?? ""
  if (!local.includes(state.run_tag)) throw new OutOfScopeError(`${email} does not carry run tag ${state.run_tag}`)
}

export function charge(state: RunState, kind: "users" | "tenants" | "aiCalls" | "ticketsPerMinute", now: number): void {
  if (kind === "ticketsPerMinute") {
    const recent = state.usage.ticket_mints.filter((t) => now - t < 60_000)
    if (recent.length >= RUN_LIMITS.ticketsPerMinute) {
      throw new RunLimitError(kind, `run ${state.setup_run_id} reached ${RUN_LIMITS.ticketsPerMinute} ticket mints in a minute`)
    }
    recent.push(now)
    state.usage.ticket_mints = recent
    return
  }
  const field = kind === "aiCalls" ? "ai_calls" : kind
  if (state.usage[field] >= RUN_LIMITS[kind]) {
    throw new RunLimitError(kind, `run ${state.setup_run_id} reached its limit of ${RUN_LIMITS[kind]} ${kind}`)
  }
  state.usage[field] += 1
}

export const STATIC_TABLE_DENYLIST = ["commsPlatformConfig", "invitations", "setPasswordOutreach"] as const

const SECRET_FIELD = /key|secret|token|password/i
const STRING_VALIDATOR = /v\.(string|any|bytes)\(\)/

export function secretBearingTables(schemaSource: string): string[] {
  const lines = schemaSource.split("\n")
  const out = new Set<string>()
  let table: string | null = null
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i]
    const start = /^\s{2}([A-Za-z_][\w]*)\s*:\s*defineTable\(/.exec(line)
    if (start) {
      table = start[1]
      continue
    }
    if (!table) continue
    const field = /^\s+([A-Za-z_][\w]*)\s*:\s*(.*)$/.exec(line)
    if (!field || !SECRET_FIELD.test(field[1])) continue
    const opens = (field[2].match(/\(/g) ?? []).length
    const closes = (field[2].match(/\)/g) ?? []).length
    const validator = opens > closes ? `${field[2]} ${lines[i + 1] ?? ""}` : field[2]
    if (STRING_VALIDATOR.test(validator)) out.add(table)
  }
  return [...out].sort()
}

export function tableDenylist(schemaSource: string): Set<string> {
  return new Set<string>([...STATIC_TABLE_DENYLIST, ...secretBearingTables(schemaSource)])
}

export function assertTableAllowed(table: string, denylist: ReadonlySet<string>): void {
  if (denylist.has(table)) throw new OutOfScopeError(`table ${table} is on the denylist`)
}
