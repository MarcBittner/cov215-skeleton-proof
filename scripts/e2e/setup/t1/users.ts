import personaRegistry from "../../../../e2e/helpers/personas.json" with { type: "json" }
import { clerkErrorCode, listData, type ClerkClient } from "./clerk.js"
import type { ConvexCaller, ConvexFactory } from "./convex.js"
import type { ClerkLimiter } from "./limiter.js"
import { assertCallerTarget, verifiedTarget, type RunState } from "./run.js"
import { assertOwnUser, assertRunTagged, charge, OutOfScopeError } from "./scope.js"
import { checkTarget, type DenyList } from "./target.js"

export const RUN_USER_EMAIL_DOMAIN = "e2e.coverpoc.dev"
const USER_ID = /^user_[A-Za-z0-9]+$/
const SESSION_ID = /^sess_[A-Za-z0-9]+$/
const NAME = /^[A-Za-z0-9 .'_-]{0,64}$/

export interface PersonaAllowlist {
  personas: Readonly<Record<string, string>>
  staff: readonly string[]
  admins: readonly string[]
}

export interface ClerkDeps {
  clerk: ClerkClient
  limiter: ClerkLimiter
  now?: () => number
  deny?: DenyList
}

export interface RunUserRef {
  id: string
  email: string
}

function nowOf(deps: { now?: () => number }): number {
  return (deps.now ?? Date.now)()
}

export function runUserEmail(state: RunState, slug: string): { email: string; username: string } {
  const clean = slug.toLowerCase().replace(/[^a-z0-9]/g, "").slice(0, 12)
  const n = state.usage.users + 1
  const username = `e2e${clean}${state.run_tag}n${n}`.slice(0, 48)
  return { email: `${username}+clerk_test@${RUN_USER_EMAIL_DOMAIN}`, username }
}

export async function createRunUser(
  state: RunState,
  input: { slug: string; firstName?: string; lastName?: string; tenant?: string | null },
  deps: ClerkDeps,
): Promise<RunUserRef> {
  checkTarget(state, state.deployment, "user-create", deps.deny)
  const firstName = input.firstName ?? "E2E"
  const lastName = input.lastName ?? "User"
  if (!NAME.test(firstName) || !NAME.test(lastName)) throw new Error("bad first or last name")
  const { email, username } = runUserEmail(state, input.slug)
  assertRunTagged(state, email)
  charge(state, "users", nowOf(deps))
  await deps.limiter.assertUserHeadroom(async () => {
    const res = await deps.limiter.call("other", () => deps.clerk.call("GET", "/v1/users/count"))
    const n = (res.body as { total_count?: unknown } | null)?.total_count
    if (res.status !== 200 || typeof n !== "number") throw new Error(`Clerk user count failed: HTTP ${res.status}`)
    return n
  })
  const res = await deps.limiter.call("userCreate", () =>
    deps.clerk.call("POST", "/v1/users", {
      body: {
        email_address: [email],
        username,
        first_name: firstName,
        last_name: lastName,
        skip_password_requirement: true,
        skip_password_checks: true,
      },
    }),
  )
  const id = (res.body as { id?: unknown } | null)?.id
  if (res.status !== 200 || typeof id !== "string" || !USER_ID.test(id)) {
    throw new Error(`Clerk create user failed: HTTP ${res.status} ${clerkErrorCode(res.body)}`.trim())
  }
  state.users[id] = { email, created_at: nowOf(deps), deleted: false, tenant: input.tenant ?? null }
  return { id, email }
}

export async function usersByEmail(email: string, deps: ClerkDeps): Promise<string[]> {
  const res = await deps.limiter.call("other", () =>
    deps.clerk.call("GET", "/v1/users", { query: { email_address: email } }),
  )
  if (res.status !== 200) throw new Error(`Clerk user lookup failed: HTTP ${res.status}`)
  return listData<{ id?: string }>(res.body).map((u) => String(u.id ?? ""))
}

export async function activeSessions(userId: string, deps: ClerkDeps): Promise<Array<{ id: string; created_at?: number }>> {
  const out: Array<{ id: string; created_at?: number }> = []
  for (let offset = 0; ; offset += 100) {
    const res = await deps.limiter.call("other", () =>
      deps.clerk.call("GET", "/v1/sessions", { query: { user_id: userId, status: "active", limit: 100, offset } }),
    )
    if (res.status !== 200) throw new Error(`Clerk list sessions for ${userId} failed: HTTP ${res.status}`)
    const page = listData<{ id?: string; created_at?: number }>(res.body)
    for (const s of page) if (typeof s.id === "string") out.push({ id: s.id, created_at: s.created_at })
    if (page.length < 100) return out
  }
}

export async function revokeSession(sessionId: string, deps: ClerkDeps): Promise<number> {
  const res = await deps.limiter.call("other", () =>
    deps.clerk.call("POST", `/v1/sessions/${encodeURIComponent(sessionId)}/revoke`),
  )
  return res.status
}

export async function deleteRunUser(state: RunState, userId: string, deps: ClerkDeps): Promise<{ status: number; readback: number }> {
  assertOwnUser(state, userId)
  checkTarget(state, state.deployment, "user-delete", deps.deny)
  const u = state.users[userId]
  const res = await deps.limiter.call("other", () =>
    deps.clerk.call("DELETE", `/v1/users/${encodeURIComponent(userId)}`),
  )
  if (res.status !== 200 && res.status !== 404) {
    throw new Error(`Clerk delete user ${userId} failed: HTTP ${res.status}`)
  }
  const remaining = await usersByEmail(u.email, deps)
  if (remaining.length === 0) u.deleted = true
  return { status: res.status, readback: remaining.length }
}

export const REGISTRY_ADMIN_EMAILS: readonly string[] = (personaRegistry.personas as Array<{ email: string; isCOVerAdmin?: boolean }>)
  .filter((p) => p.isCOVerAdmin === true)
  .map((p) => p.email.toLowerCase())

export function assertAdminAllowlist(allow: PersonaAllowlist, registryAdmins: readonly string[] = REGISTRY_ADMIN_EMAILS): void {
  if (!Array.isArray(allow.admins) || allow.admins.length === 0) {
    throw new OutOfScopeError("persona allowlist names no admins; refusing to treat any persona as non-admin")
  }
  for (const email of registryAdmins) {
    const ids = Object.entries(allow.personas)
      .filter(([, e]) => e.toLowerCase() === email)
      .map(([id]) => id)
    if (ids.length === 0 || ids.some((id) => !allow.admins.includes(id))) {
      throw new OutOfScopeError(`registry admin persona ${email} is not listed in the allowlist's admins`)
    }
  }
}

export function isAdminPersona(allow: PersonaAllowlist, userId: string): boolean {
  assertAdminAllowlist(allow)
  return allow.admins.includes(userId)
}

export function isPersona(allow: PersonaAllowlist, userId: string): boolean {
  return Object.prototype.hasOwnProperty.call(allow.personas, userId) && !allow.staff.includes(userId)
}

export function assertSignInSubject(state: RunState, allow: PersonaAllowlist, userId: string): void {
  if (allow.staff.includes(userId)) throw new OutOfScopeError(`${userId} is a staff persona`)
  if (isPersona(allow, userId)) return
  assertOwnUser(state, userId)
}

export async function recordSession(
  state: RunState,
  allow: PersonaAllowlist,
  userId: string,
  sessionId: string,
  deps: ClerkDeps,
): Promise<void> {
  assertSignInSubject(state, allow, userId)
  if (!SESSION_ID.test(sessionId)) throw new Error(`not a Clerk session id: ${sessionId}`)
  const res = await deps.limiter.call("other", () =>
    deps.clerk.call("GET", `/v1/sessions/${encodeURIComponent(sessionId)}`),
  )
  const owner = (res.body as { user_id?: unknown } | null)?.user_id
  if (res.status !== 200) throw new Error(`Clerk session lookup failed: HTTP ${res.status}`)
  if (owner !== userId) throw new OutOfScopeError(`session ${sessionId} belongs to another user`)
  state.sessions[sessionId] = { user_id: userId, opened_at: nowOf(deps), source: "recorded" }
  for (const t of Object.values(state.tickets)) {
    if (t.user_id === userId && !t.used) {
      t.used = true
      break
    }
  }
}

export async function openUserCaller(
  state: RunState,
  allow: PersonaAllowlist,
  userId: string,
  deps: ClerkDeps & { convexFor: ConvexFactory; adminIds?: readonly string[] },
): Promise<ConvexCaller> {
  if (!(deps.adminIds ?? []).includes(userId)) assertSignInSubject(state, allow, userId)
  const target = verifiedTarget(state, "user-session")
  assertCallerTarget(state, deps.convexFor(target.url, ""), "user-session")
  const sess = await deps.limiter.call("other", () =>
    deps.clerk.call("POST", "/v1/sessions", { body: { user_id: userId } }),
  )
  const sid = (sess.body as { id?: unknown } | null)?.id
  if (sess.status !== 200 || typeof sid !== "string") throw new Error(`Clerk create session failed: HTTP ${sess.status}`)
  state.sessions[sid] = { user_id: userId, opened_at: nowOf(deps), source: "setup" }
  const tok = await deps.limiter.call("other", () =>
    deps.clerk.call("POST", `/v1/sessions/${encodeURIComponent(sid)}/tokens/convex`),
  )
  const jwt = (tok.body as { jwt?: unknown } | null)?.jwt
  if (tok.status !== 200 || typeof jwt !== "string") throw new Error(`Clerk convex token failed: HTTP ${tok.status}`)
  const caller = deps.convexFor(target.url, jwt)
  assertCallerTarget(state, caller, "user-session")
  return caller
}

export function openDeployAdmin(state: RunState, factory: (target: { url: string; adminKey: string }) => ConvexCaller): ConvexCaller {
  const caller = factory(verifiedTarget(state, "deploy-admin"))
  assertCallerTarget(state, caller, "deploy-admin")
  return caller
}

export async function grantCoverAdmin(
  state: RunState,
  allow: PersonaAllowlist,
  userId: string,
  deps: { deployAdmin: ConvexCaller; deny?: DenyList },
): Promise<void> {
  checkTarget(state, state.deployment, "tenant-create", deps.deny)
  assertCallerTarget(state, deps.deployAdmin, "tenant-create")
  let email: string
  if (isAdminPersona(allow, userId)) email = allow.personas[userId]
  else {
    assertOwnUser(state, userId)
    email = state.users[userId].email
  }
  if (!email) throw new OutOfScopeError(`${userId} has no email to grant`)
  const id = await deps.deployAdmin.mutation<string | null>("bootstrap:makeCOVerAdmin", { email: email.toLowerCase() })
  if (typeof id !== "string" || !id) throw new Error(`bootstrap:makeCOVerAdmin found no users row for ${email}`)
}
