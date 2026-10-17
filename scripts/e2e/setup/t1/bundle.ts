import { sealBundle } from "../../contract/bundle.js"
import { CONTRACT_VERSION, TICKET_TTL_SECONDS } from "../../contract/constants.js"
import { validateBundle } from "../../contract/formats.js"
import { tenantKey } from "../../contract/tenant-key.js"
import type { Bundle, BundleEnvelope, BundleTenant, SelectMode, Selection, Shard } from "../../contract/types.js"
import { orThrow } from "../../contract/validate.js"
import type { RunState } from "./run.js"
import type { CreatedTenant } from "./tenants.js"
import { isAdminPersona, type PersonaAllowlist } from "./users.js"

export interface BundleInput {
  run_key: string
  select_mode: SelectMode
  selection: Selection | null
  shard_plan: Shard[]
  tenants: readonly CreatedTenant[]
  tickets: Record<string, Record<string, string>>
  issued_at: number
}

export function toBundleTenant(t: CreatedTenant): BundleTenant {
  return {
    title: t.title,
    org_id: t.org_id,
    org_name: t.org_name,
    recipe: t.recipe,
    members: t.members.map((m) => ({
      kind: m.kind,
      user_id: m.clerk_user_id,
      ...(m.user_id ? { convex_user_id: m.user_id } : { external: true as const }),
      email: m.email.toLowerCase(),
      role: m.role,
    })),
  }
}

export function bundleTenants(created: readonly CreatedTenant[]): Record<string, BundleTenant> {
  const out: Record<string, BundleTenant> = {}
  const seen = new Map<string, number>()
  for (const t of created) {
    const n = (seen.get(t.key) ?? 0) + 1
    seen.set(t.key, n)
    out[tenantKey(t.key, n)] = toBundleTenant(t)
  }
  return out
}

export function bundleUsers(state: RunState, allow: PersonaAllowlist): Record<string, string> {
  const out: Record<string, string> = {}
  for (const [id, email] of Object.entries(allow.personas)) {
    if (!allow.staff.includes(id) && !isAdminPersona(allow, id)) out[id] = email.toLowerCase()
  }
  for (const [id, u] of Object.entries(state.users)) if (!u.deleted) out[id] = u.email.toLowerCase()
  return out
}

export function assembleBundle(state: RunState, allow: PersonaAllowlist, input: BundleInput): Bundle {
  return orThrow(
    "bundle",
    validateBundle({
      schema_version: CONTRACT_VERSION,
      setup_run_id: state.setup_run_id,
      run_key: input.run_key,
      run_tag: state.run_tag,
      kind: state.kind,
      sha: state.pr_sha,
      vercel_deployment_id: state.deployment.vercel_deployment_id,
      base_url: state.deployment.url,
      convex_url: state.deployment.convex_url,
      select_mode: input.select_mode,
      selection: input.selection,
      shard_plan: input.shard_plan,
      tenants: bundleTenants(input.tenants),
      tickets: input.tickets,
      users: bundleUsers(state, allow),
      issued_at: new Date(input.issued_at).toISOString(),
      expires_at: new Date(input.issued_at + TICKET_TTL_SECONDS * 1000).toISOString(),
    }),
  )
}

export function sealRunBundle(
  state: RunState,
  allow: PersonaAllowlist,
  input: BundleInput,
  recipientPublicKey: string,
): BundleEnvelope {
  return sealBundle(assembleBundle(state, allow, input), recipientPublicKey)
}
