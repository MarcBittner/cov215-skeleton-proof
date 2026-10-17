import { SPEC_TENANT_RECIPES } from "../../../../e2e/helpers/tenant-recipes.js"
import { E2E_TEST_DIR, tenantKeyOf, tenantTitle, titlePathOfTestId } from "../../contract/tenant-key.js"
import type { ConvexCaller, ConvexFactory } from "./convex.js"
import { CapacityError } from "./limiter.js"
import { assertCallerTarget, type RunState } from "./run.js"
import {
  assertOperation,
  assertOwnDeployment,
  assertOwnTenant,
  assertTableAllowed,
  charge,
  OutOfScopeError,
  RUN_LIMITS,
} from "./scope.js"
import { checkTarget } from "./target.js"
import {
  createRunUser,
  deleteRunUser,
  grantCoverAdmin,
  isAdminPersona,
  openUserCaller,
  type ClerkDeps,
  type PersonaAllowlist,
} from "./users.js"

export type MemberRole = "owner" | "construction_manager" | "billing_contact" | "assistant"

export const MEMBER_PERMISSIONS = ["approveRejectCOs"] as const
export type MemberPermission = (typeof MEMBER_PERMISSIONS)[number]

export const TENANT_FEATURE_FLAGS = ["demoMode"] as const
export type TenantFeatureFlag = (typeof TENANT_FEATURE_FLAGS)[number]

export interface RecipeMember {
  kind: string
  role: MemberRole
  verifier?: boolean
  external?: boolean
  coverAdmin?: boolean
  permissions?: readonly MemberPermission[]
}

export interface TenantRecipe {
  members: readonly RecipeMember[]
  rfiThreadModel?: boolean
  featureFlags?: readonly TenantFeatureFlag[]
}

const VERIFIER: RecipeMember = { kind: "verifier", role: "construction_manager", verifier: true }
const MEMBER: RecipeMember = { kind: "member", role: "construction_manager" }
const ADMIN: RecipeMember = { kind: "admin", role: "owner", coverAdmin: true }

export const TENANT_RECIPES: Readonly<Record<string, TenantRecipe>> = {
  owner: { members: [] },
  "owner-rfithread": { members: [], rfiThreadModel: true },
  "owner-member": { members: [MEMBER] },
  "owner-member-admin": { members: [MEMBER, ADMIN] },
  "owner-approver": { members: [{ kind: "approver", role: "owner" }] },
  "owner-billing": { members: [{ kind: "billing", role: "billing_contact" }] },
  "owner-approver-billing": {
    members: [
      { kind: "approver", role: "owner" },
      { kind: "billing", role: "billing_contact" },
    ],
  },
  "owner-approver-billing-admin": {
    members: [
      { kind: "approver", role: "owner" },
      { kind: "billing", role: "billing_contact" },
      ADMIN,
    ],
  },
  "owner-admin": { members: [ADMIN] },
  "owner-verifier": { members: [VERIFIER] },
  "owner-verifier-demomode": { members: [VERIFIER], featureFlags: ["demoMode"] },
  "owner-verifier-member": { members: [VERIFIER, MEMBER] },
  "owner-verifier-member-approvecos": { members: [VERIFIER, { ...MEMBER, permissions: ["approveRejectCOs"] }] },
  "owner-verifier-member-admin-rfithread": { members: [VERIFIER, MEMBER, ADMIN], rfiThreadModel: true },
  "owner-two-verifiers": {
    members: [VERIFIER, { kind: "verifiertwo", role: "construction_manager", verifier: true }],
  },
  "owner-outside": { members: [{ kind: "outside", role: "owner", external: true }] },
}

export interface TenantMember {
  kind: string
  role: MemberRole
  clerk_user_id: string
  user_id: string
  email: string
  verifier: boolean
}

export interface CreatedTenant {
  key: string
  title: string
  org_id: string
  org_name: string
  test_id: string
  recipe: string
  members: TenantMember[]
}

export interface TenantDeps extends ClerkDeps {
  admin: ConvexCaller
  deployAdmin: ConvexCaller
  convexFor: ConvexFactory
  personas: PersonaAllowlist
}

export async function openSetupAdmin(
  state: RunState,
  adminUserId: string,
  deps: ClerkDeps & { convexFor: ConvexFactory; personas: PersonaAllowlist; deployAdmin: ConvexCaller },
): Promise<ConvexCaller> {
  if (!isAdminPersona(deps.personas, adminUserId)) throw new OutOfScopeError(`${adminUserId} is not a registry CO-Ver admin persona`)
  await grantCoverAdmin(state, deps.personas, adminUserId, deps)
  return openUserCaller(state, deps.personas, adminUserId, { ...deps, adminIds: [adminUserId] })
}

async function linkMember(
  state: RunState,
  userId: string,
  deps: TenantDeps,
): Promise<{ caller: ConvexCaller; convexUserId: string }> {
  const caller = await openUserCaller(state, deps.personas, userId, deps)
  const convexUserId = await caller.mutation<string | null>("users:linkPendingUser", {})
  if (!convexUserId) throw new Error(`users:linkPendingUser found no pending row for run user ${userId}`)
  return { caller, convexUserId }
}

interface OrgFlagRow {
  orgId?: string
  rfiThreadModelEnabled?: boolean
  flags?: Record<string, unknown>
}

async function orgFlagRow(admin: ConvexCaller, orgId: string): Promise<OrgFlagRow> {
  const rows = await admin.query<OrgFlagRow[] | null>("admin:listOrgFeatureFlags", {})
  const row = (rows ?? []).find((r) => r.orgId === orgId)
  if (!row) throw new Error(`admin:listOrgFeatureFlags has no row for ${orgId}`)
  return row
}

async function applyRecipeOptions(orgId: string, recipe: TenantRecipe, admin: ConvexCaller): Promise<void> {
  if (recipe.rfiThreadModel) {
    await admin.mutation("admin:setOrgRfiThreadModel", { organizationId: orgId, enabled: true })
    if ((await orgFlagRow(admin, orgId)).rfiThreadModelEnabled !== true) {
      throw new Error(`admin:setOrgRfiThreadModel did not enable the RFI thread model on ${orgId}`)
    }
  }
  for (const flag of recipe.featureFlags ?? []) {
    await admin.mutation("admin:setOrgFeatureFlag", { organizationId: orgId, flag, enabled: true })
    const flags = (await orgFlagRow(admin, orgId)).flags
    if (!flags || flags[flag] !== true) throw new Error(`admin:setOrgFeatureFlag did not enable ${flag} on ${orgId}`)
  }
}

async function grantPermissions(
  orgId: string,
  convexUserId: string,
  memberCaller: ConvexCaller,
  permissions: readonly MemberPermission[],
  admin: ConvexCaller,
): Promise<void> {
  const rows = await admin.query<Array<{ _id?: string; userId?: string; user?: { _id?: string }; permissions?: Record<string, unknown> }> | null>(
    "admin:listOrgMembers",
    { orgId },
  )
  const row = (rows ?? []).find((m) => (m.user?._id ?? m.userId) === convexUserId)
  if (!row?._id || !row.permissions) throw new Error(`admin:listOrgMembers has no membership with permissions for ${convexUserId} in ${orgId}`)
  const next: Record<string, unknown> = { ...row.permissions }
  for (const p of permissions) next[p] = { view: true, edit: true }
  await admin.mutation("admin:updateOrgMember", { membershipId: row._id, permissions: next })
  const mine = await memberCaller.query<{ permissions?: Record<string, boolean | { edit?: boolean }> } | null>("account:getMyMembership", {})
  for (const p of permissions) {
    const v = mine?.permissions?.[p]
    if (!(v === true || (typeof v === "object" && v?.edit === true))) throw new Error(`admin:updateOrgMember did not grant ${p} to ${convexUserId}`)
  }
}

export async function createTenant(
  state: RunState,
  input: { recipe: string; testId: string; deployment?: string },
  deps: TenantDeps,
): Promise<CreatedTenant> {
  assertOperation("tenantCreate")
  assertOwnDeployment(state, input.deployment)
  checkTarget(state, state.deployment, "tenant-create", deps.deny)
  assertCallerTarget(state, deps.admin, "tenant-create")
  assertCallerTarget(state, deps.deployAdmin, "tenant-create")
  const recipe = TENANT_RECIPES[input.recipe]
  if (!recipe) throw new Error(`unknown tenant recipe "${input.recipe}"`)
  const titlePath = titlePathOfTestId(input.testId)
  if (!titlePath) throw new Error(`bad test id "${input.testId}"`)
  const now = (deps.now ?? Date.now)()
  charge(state, "tenants", now)
  const n = state.usage.tenants

  const owner = await createRunUser(state, { slug: "owner", lastName: "Owner" }, deps)
  const orgName = `E2E ${state.run_tag} t${n}`
  const orgId = await deps.admin.mutation<string>("admin:createOrganization", { name: orgName, adminEmail: owner.email })
  if (typeof orgId !== "string" || !orgId) throw new Error("admin:createOrganization returned no id")
  state.tenants[orgId] = { recipe: input.recipe, test_id: input.testId, name: orgName, created_at: now, deleted: false, users: [owner.id] }
  state.users[owner.id].tenant = orgId

  const members: TenantMember[] = []
  const ownerLink = await linkMember(state, owner.id, deps)
  members.push({ kind: "owner", role: "owner", clerk_user_id: owner.id, user_id: ownerLink.convexUserId, email: owner.email, verifier: false })
  await applyRecipeOptions(orgId, recipe, deps.admin)

  for (const m of recipe.members) {
    const lastName = m.kind.charAt(0).toUpperCase() + m.kind.slice(1)
    const u = await createRunUser(state, { slug: m.kind, lastName, tenant: orgId }, deps)
    state.tenants[orgId].users.push(u.id)
    if (m.external) {
      members.push({ kind: m.kind, role: m.role, clerk_user_id: u.id, user_id: "", email: u.email, verifier: false })
      continue
    }
    if (m.coverAdmin) {
      const homeName = `${orgName} ${m.kind}`
      const homeId = await deps.admin.mutation<string>("admin:createOrganization", { name: homeName, adminEmail: u.email })
      if (typeof homeId !== "string" || !homeId) throw new Error("admin:createOrganization returned no id")
      state.tenants[homeId] = { recipe: `${input.recipe}/${m.kind}`, test_id: input.testId, name: homeName, created_at: now, deleted: false, users: [] }
      const link = await linkMember(state, u.id, deps)
      await grantCoverAdmin(state, deps.personas, u.id, deps)
      members.push({ kind: m.kind, role: m.role, clerk_user_id: u.id, user_id: link.convexUserId, email: u.email, verifier: false })
      continue
    }
    await deps.admin.mutation("admin:inviteUser", { orgId, email: u.email, firstName: "E2E", lastName, role: m.role })
    const link = await linkMember(state, u.id, deps)
    if (m.verifier) await grantCoverAdmin(state, deps.personas, u.id, deps)
    if (m.permissions?.length) await grantPermissions(orgId, link.convexUserId, link.caller, m.permissions, deps.admin)
    members.push({ kind: m.kind, role: m.role, clerk_user_id: u.id, user_id: link.convexUserId, email: u.email, verifier: m.verifier === true })
  }
  return {
    key: tenantKeyOf(titlePath),
    title: tenantTitle(titlePath),
    org_id: orgId,
    org_name: orgName,
    test_id: input.testId,
    recipe: input.recipe,
    members,
  }
}

export const DEFAULT_TENANT_CONCURRENCY = 8
export const DEFAULT_MAX_CLERK_USERS_PER_RUN = 300

export interface TenantRequest {
  recipe: string
  testId: string
}

export interface TenantSetupInputs {
  tenantConcurrency?: number
  maxClerkUsersPerRun?: number
}

export interface TenantPreflight {
  tenants: number
  clerkUsers: number
  maxClerkUsersPerRun: number
}

function positiveInt(name: string, v: number): number {
  if (!Number.isInteger(v) || v < 1) throw new Error(`${name} must be a positive integer, got ${v}`)
  return v
}

export function recipeClerkUsers(recipe: string): number {
  const r = TENANT_RECIPES[recipe]
  if (!r) throw new Error(`unknown tenant recipe "${recipe}"`)
  return 1 + r.members.length
}

export function estimateClerkUsers(requests: readonly TenantRequest[]): number {
  return requests.reduce((sum, r) => sum + recipeClerkUsers(r.recipe), 0)
}

export function tenantRequestsFor(testIds: readonly string[]): TenantRequest[] {
  const out: TenantRequest[] = []
  for (const testId of testIds) {
    const titlePath = titlePathOfTestId(testId)
    if (!titlePath) continue
    const recipe = SPEC_TENANT_RECIPES[`${E2E_TEST_DIR}/${titlePath[0]}`]
    if (recipe) out.push({ recipe, testId })
  }
  return out
}

export function preflightTenants(requests: readonly TenantRequest[], inputs: TenantSetupInputs = {}): TenantPreflight {
  const max = positiveInt("maxClerkUsersPerRun", inputs.maxClerkUsersPerRun ?? DEFAULT_MAX_CLERK_USERS_PER_RUN)
  const clerkUsers = estimateClerkUsers(requests)
  const plan = `${requests.length} tenant(s) needing ${clerkUsers} Clerk user(s)`
  if (requests.length > RUN_LIMITS.tenants) {
    throw new CapacityError(`${plan}: more than the per-run tenant cap of ${RUN_LIMITS.tenants}`)
  }
  if (clerkUsers > max) {
    throw new CapacityError(`${plan}: more than maxClerkUsersPerRun ${max}`)
  }
  if (clerkUsers > RUN_LIMITS.users) {
    throw new CapacityError(`${plan}: more than the per-run user cap of ${RUN_LIMITS.users}`)
  }
  return { tenants: requests.length, clerkUsers, maxClerkUsersPerRun: max }
}

export async function mapBounded<T, R>(items: readonly T[], limit: number, fn: (item: T, index: number) => Promise<R>): Promise<R[]> {
  positiveInt("concurrency", limit)
  const out = new Array<R>(items.length)
  let next = 0
  const errors: unknown[] = []
  const worker = async () => {
    while (errors.length === 0 && next < items.length) {
      const i = next++
      try {
        out[i] = await fn(items[i], i)
      } catch (error) {
        errors.push(error)
      }
    }
  }
  await Promise.all(Array.from({ length: Math.min(limit, items.length) }, worker))
  if (errors.length > 0) throw errors[0]
  return out
}

export async function createTenants(
  state: RunState,
  requests: readonly TenantRequest[],
  deps: TenantDeps,
  inputs: TenantSetupInputs & { log?: (line: string) => void } = {},
): Promise<CreatedTenant[]> {
  const concurrency = positiveInt("tenantConcurrency", inputs.tenantConcurrency ?? DEFAULT_TENANT_CONCURRENCY)
  const log = inputs.log ?? ((line: string) => process.stdout.write(`${line}\n`))
  let pre: TenantPreflight
  try {
    pre = preflightTenants(requests, inputs)
  } catch (e) {
    log(`setup t1 preflight: refused, ${(e as Error).message}`)
    throw e
  }
  log(
    `setup t1 preflight: ${pre.tenants} tenant(s), ${pre.clerkUsers} Clerk user(s) estimated ` +
      `(max ${pre.maxClerkUsersPerRun}), ${concurrency} concurrent`,
  )
  return mapBounded(requests, concurrency, (r) => createTenant(state, r, deps))
}

export async function deleteTenant(
  state: RunState,
  orgId: string,
  deps: ClerkDeps & { admin: ConvexCaller },
): Promise<{ removed_memberships: number; archived: boolean; users_deleted: number }> {
  assertOperation("tenantDelete")
  assertOwnTenant(state, orgId)
  checkTarget(state, state.deployment, "tenant-delete", deps.deny)
  assertCallerTarget(state, deps.admin, "tenant-delete")
  let removed = 0
  const members = await deps.admin.query<Array<{ _id?: string }> | null>("admin:listOrgMembers", { orgId })
  for (const m of members ?? []) {
    if (!m._id) continue
    try {
      await deps.admin.mutation("admin:removeOrgMember", { membershipId: m._id })
      removed += 1
    } catch {
      continue
    }
  }
  await deps.admin.mutation("admin:setOrganizationArchived", { orgId, archived: true })
  let usersDeleted = 0
  for (const uid of state.tenants[orgId].users) {
    if (state.users[uid] && !state.users[uid].deleted) {
      await deleteRunUser(state, uid, deps)
      usersDeleted += 1
    }
  }
  state.tenants[orgId].deleted = true
  return { removed_memberships: removed, archived: true, users_deleted: usersDeleted }
}

export const TENANT_ROW_SOURCES: Readonly<Record<string, string>> = {
  organizations: "admin:getOrganization",
  userOrganizations: "admin:listOrgMembers",
}

export async function tenantRows(
  state: RunState,
  orgId: string,
  table: string,
  deps: { admin: ConvexCaller; denylist: ReadonlySet<string> },
): Promise<unknown[]> {
  assertOperation("tenantRows")
  if (!state.tenants[orgId]) throw new OutOfScopeError(`tenant ${orgId} was not created by run ${state.setup_run_id}`)
  assertTableAllowed(table, deps.denylist)
  assertCallerTarget(state, deps.admin, "tenant-rows")
  const fn = TENANT_ROW_SOURCES[table]
  if (!fn) throw new OutOfScopeError(`table ${table} is not readable through tenantRows`)
  const out = await deps.admin.query<unknown>(fn, { orgId })
  if (out === null || out === undefined) return []
  return Array.isArray(out) ? out : [out]
}
