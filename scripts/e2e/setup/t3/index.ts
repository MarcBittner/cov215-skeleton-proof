import { generatedTenantKey, generatedTestId } from "../../contract/generated-tenant.js"
import { isPlatformWideControl } from "../../contract/platform-wide.js"
import { tenantTitle, titlePathOfTestId } from "../../contract/tenant-key.js"
import type { BundleTenant, Control } from "../../contract/types.js"
import { formatId, parseId } from "../../../../e2e/map/ids.js"
import { toBundleTenant } from "../t1/bundle.js"
import type { ConvexCaller } from "../t1/convex.js"
import { assertCallerTarget, type RunState } from "../t1/run.js"
import { assertOperation, assertOwnDeployment } from "../t1/scope.js"
import { checkTarget, type DenyList } from "../t1/target.js"
import { createTenants, type CreatedTenant, type TenantDeps, type TenantRequest, type TenantSetupInputs } from "../t1/tenants.js"
import { readMail, type ContainedMail } from "../t2/mail.js"
import type { SetupStep } from "../t2/step.js"

export type MailRecord = NonNullable<Control["mail"]>
export type MailReadBack = { emailEnabled: boolean; catchAllAddress: string }

export interface MailStep {
  contain(caller: ConvexCaller): Promise<MailRecord>
  readBack(caller: ConvexCaller): Promise<MailReadBack>
}

export type PrepareDeps = {
  mail: MailStep
  mailCaller: ConvexCaller
  tenants: TenantDeps
  tenantInputs?: TenantSetupInputs & { log?: (line: string) => void }
  deny?: DenyList
}

export type SnapshotPrepareInput = {
  setupRunId: string
  deployment: string
  controls: string[]
  maxTenants: number
}

export type NightlyPrepareInput = SnapshotPrepareInput & { pass: 1 | 2 }

export type Skipped = { id: string; status: "not-snapshotted: platform-wide" | "not-snapshotted: tenant limit" }

export type SnapshotPrepareResult = {
  deployment: string
  mail: MailRecord
  tenants: Record<string, BundleTenant>
  made: CreatedTenant[]
  created: { org_id: string; test_id: string; tenant_key: string; recipe: string }[]
  skipped: Skipped[]
}

export type NightlyPrepareResult = SnapshotPrepareResult & { pass: 1 | 2 }

export class PrepareError extends Error {
  constructor(
    message: string,
    readonly created: SnapshotPrepareResult["created"],
  ) {
    super(message)
    this.name = "PrepareError"
  }
}

const ROLE_RECIPES: Record<string, string> = { owner: "owner", "construction-manager": "owner-member", "billing-contact": "owner-billing" }

export function recipeForRole(role: string): string | null {
  return ROLE_RECIPES[role] ?? null
}

export function planControls(controls: string[], maxTenants: number): { take: string[]; skipped: Skipped[] } {
  const ids: string[] = []
  const skipped: Skipped[] = []
  for (const raw of [...new Set(controls)].sort()) {
    const control = parseId(raw)
    if (control?.kind !== "control" || formatId(control) !== raw) throw new Error(`not a control id: ${raw}`)
    const id = formatId({ kind: "gen-snapshot", control })
    if (isPlatformWideControl(control)) skipped.push({ id, status: "not-snapshotted: platform-wide" })
    else ids.push(id)
  }
  const take = ids.slice(0, Math.max(0, maxTenants))
  for (const id of ids.slice(take.length)) skipped.push({ id, status: "not-snapshotted: tenant limit" })
  return { take, skipped: skipped.sort((a, b) => (a.id < b.id ? -1 : a.id > b.id ? 1 : 0)) }
}

type Planned = { id: string; testId: string; key: string; recipe: string; role: string }

function plan(take: string[]): Planned[] {
  return take.map((id) => {
    const parsed = parseId(id)
    if (parsed?.kind !== "gen-snapshot") throw new Error(`not a snapshot id: ${id}`)
    const role = parsed.control.cell.role
    const recipe = recipeForRole(role)
    if (!recipe) throw new Error(`no tenant recipe gives an internal ${role} member, for ${id}`)
    return { id, testId: generatedTestId(id), key: generatedTenantKey(id), recipe, role }
  })
}

function createdSince(state: RunState, before: ReadonlySet<string>, planned: Planned[]): SnapshotPrepareResult["created"] {
  const order = new Map(planned.map((p, i) => [p.testId, i]))
  const out: (SnapshotPrepareResult["created"][number] & { i: number })[] = []
  for (const [orgId, t] of Object.entries(state.tenants)) {
    const i = order.get(t.test_id)
    if (before.has(orgId) || i === undefined) continue
    out.push({ i, org_id: orgId, test_id: planned[i].id, tenant_key: planned[i].key, recipe: t.recipe })
  }
  return out.sort((a, b) => a.i - b.i).map(({ i: _, ...c }) => c)
}

export async function prepareNight(state: RunState, input: NightlyPrepareInput, deps: PrepareDeps): Promise<NightlyPrepareResult> {
  if (input.pass !== 1 && input.pass !== 2) throw new Error(`pass must be 1 or 2, got ${String(input.pass)}`)
  assertOperation("nightlyPrepare")
  if (state.kind !== "nightly") throw new Error(`nightly prepare needs a nightly run, run ${state.setup_run_id} is ${state.kind}`)
  return { ...(await prepareSnapshots(state, input, deps)), pass: input.pass }
}

export async function prepareSnapshots(state: RunState, input: SnapshotPrepareInput, deps: PrepareDeps): Promise<SnapshotPrepareResult> {
  if (!/^[1-9][0-9]{0,19}$/.test(input.setupRunId)) throw new Error(`bad setup run id ${input.setupRunId}`)
  if (!Number.isInteger(input.maxTenants) || input.maxTenants < 0) throw new Error(`bad maxTenants ${input.maxTenants}`)
  assertOperation("tenantCreate")
  if (input.setupRunId !== state.setup_run_id) throw new Error(`setup run id ${input.setupRunId} is not run ${state.setup_run_id}`)
  assertOwnDeployment(state, input.deployment)
  const { take, skipped } = planControls(input.controls, input.maxTenants)
  const planned = plan(take)

  checkTarget(state, state.deployment, "mail-contain", deps.deny)
  assertCallerTarget(state, deps.mailCaller, "mail-contain")
  const mail = await deps.mail.contain(deps.mailCaller)
  if (!mail.contained) throw new Error(`mail not contained on ${input.deployment}`)
  const readBack = await deps.mail.readBack(deps.mailCaller)
  if (readBack.emailEnabled) throw new Error(`emailEnabled is true on ${input.deployment} after containment`)
  if (readBack.catchAllAddress !== mail.projection.catchAllAddress) {
    throw new Error(`catch-all on ${input.deployment} is ${readBack.catchAllAddress}, contained as ${mail.projection.catchAllAddress}`)
  }

  const tenants: Record<string, BundleTenant> = {}
  const made: CreatedTenant[] = []
  const before = new Set(Object.keys(state.tenants))
  try {
    checkTarget(state, state.deployment, "tenant-create", deps.deny)
    const requests: TenantRequest[] = planned.map((p) => ({ recipe: p.recipe, testId: p.testId }))
    const created = planned.length === 0 ? [] : await createTenants(state, requests, deps.tenants, deps.tenantInputs)
    for (const [i, p] of planned.entries()) {
      const t = created[i]
      const title = tenantTitle(titlePathOfTestId(p.testId)!)
      if (t.test_id !== p.testId || t.key !== p.key) throw new Error(`tenant ${t.org_id} was created for ${t.test_id}, not ${p.id}`)
      if (t.title !== title) throw new Error(`tenant ${t.org_id} for ${p.id} is titled "${t.title}", not "${title}"`)
      const tenant = toBundleTenant(t)
      if (!tenant.members.some((m) => m.external !== true && m.role.toLowerCase().replace(/_/g, "-") === p.role)) {
        throw new Error(`tenant ${t.org_id} for ${p.id} has no internal ${p.role} member`)
      }
      tenants[p.key] = tenant
      made.push(t)
    }
  } catch (e) {
    throw new PrepareError(e instanceof Error ? e.message : String(e), createdSince(state, before, planned))
  }
  return { deployment: input.deployment, mail, tenants, made, created: createdSince(state, before, planned), skipped }
}

export function containedMailStep(contained: ContainedMail): MailStep {
  return {
    contain: async () => ({
      projection: { emailEnabled: false, catchAllAddress: contained.effective_catch_all, catchAllSource: "database" },
      adopted_from_setup_run_id: contained.adopted_from_setup_run_id,
      contained: true,
      contained_at: contained.contained_at,
    }),
    readBack: async (caller) => {
      const back = await readMail(caller)
      return { emailEnabled: back.emailEnabled, catchAllAddress: back.catchAllAddress }
    },
  }
}

export const runSetupStep: SetupStep = async () => ({ task: "t3", status: "stub" })
