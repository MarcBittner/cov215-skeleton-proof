import { isIdOfKind, testKindOf } from "../../../e2e/map/ids.js"
import { CONTRACT_MAJOR, MAX_DISPATCH_INPUT_BYTES, TICKET_TTL_SECONDS, runTagFor } from "./constants.js"
import {
  bundleEnvelopeSchema,
  bundleSchema,
  commentRowsSchema,
  controlSchema,
  reportRequestSchema,
  runRecordSchema,
  runRequestSchema,
  selectionSchema,
  setupPlanSchema,
  shardPlanSchema,
} from "./schemas.generated.js"
import type {
  Bundle,
  BundleEnvelope,
  CommentRows,
  Control,
  ReportRequest,
  RunRecord,
  RunRequest,
  Selection,
  SetupPlan,
  Shard,
  ShardPlan,
} from "./types.js"
import { tenantBaseKey, tenantKeyOf, tenantKeyOfTitle, titlePathOfTestId } from "./tenant-key.js"
import { type ValidationResult, canonicalJson, checkDocument, schemaErrors } from "./validate.js"

const FORBIDDEN_VALUE = /(sk_live_|sk_test_|sk-ant-|lin_api_|x-vercel-protection-bypass|-----BEGIN [A-Z ]*PRIVATE KEY-----)/

function plain<T>(schema: Parameters<typeof schemaErrors>[0], value: unknown, semantic: (v: T) => string[]): ValidationResult<T> {
  const errors = schemaErrors(schema, value)
  if (errors.length > 0) return { ok: false, errors }
  const more = semantic(value as T)
  return more.length > 0 ? { ok: false, errors: more } : { ok: true, value: value as T }
}

function sortedUnique(values: string[], at: string): string[] {
  const errors: string[] = []
  for (let i = 1; i < values.length; i++) {
    if (values[i - 1] === values[i]) errors.push(`${at}: duplicate ${values[i]}`)
    else if (values[i - 1] > values[i]) errors.push(`${at}: not sorted at ${values[i]}`)
  }
  return errors
}

function exactTestIds(ids: string[], at: string): string[] {
  return ids.filter((id) => testKindOf(id) === null).map((id) => `${at}: ${id} is not a valid test id`)
}

function shardErrors(shards: Shard[], at: string): string[] {
  const errors: string[] = []
  const byKey = new Map<string, Shard[]>()
  for (const s of shards) byKey.set(s.run_key, [...(byKey.get(s.run_key) ?? []), s])
  for (const [key, group] of byKey) {
    const ai = group.filter((s) => s.role === "ai")
    if (group.length - ai.length > 16) errors.push(`${at}: run_key ${key} has more than 16 shards`)
    if (ai.length > 1) errors.push(`${at}: run_key ${key} has more than one ai shard`)
    const sorted = group.map((s) => s.index).sort((a, b) => a - b)
    sorted.forEach((n, i) => {
      if (n !== i + 1) errors.push(`${at}: run_key ${key} shard indexes must be 1..${sorted.length} without gaps`)
    })
    if (ai.length === 1 && ai[0].index !== sorted.length) errors.push(`${at}: run_key ${key} ai shard must be the last shard`)
  }
  const seen = new Set<string>()
  shards.forEach((s, si) =>
    s.tests.forEach((t, ti) => {
      const where = `${at}/${si}/tests/${ti}`
      const kind = testKindOf(t.id)
      if (kind === null) errors.push(`${where}: ${t.id} is not a valid test id`)
      else if (!isIdOfKind(t.id, "test")) errors.push(`${where}: ${t.id} must be planned as test:e2e/generated/<file>::<gen id>`)
      else if (kind !== t.kind) errors.push(`${where}: kind ${t.kind} does not match id kind ${kind}`)
      if (seen.has(t.id)) errors.push(`${where}: ${t.id} is planned twice`)
      seen.add(t.id)
    }),
  )
  return [...new Set(errors)]
}

function scanForSecrets(value: unknown, at: string, errors: string[]): void {
  if (typeof value === "string") {
    if (FORBIDDEN_VALUE.test(value)) errors.push(`${at}: holds a value shaped like a key or bypass secret`)
  } else if (Array.isArray(value)) {
    value.forEach((v, i) => scanForSecrets(v, `${at}/${i}`, errors))
  } else if (typeof value === "object" && value !== null) {
    for (const [k, v] of Object.entries(value)) scanForSecrets(v, `${at}/${k}`, errors)
  }
}

export function validateRunRequest(value: unknown): ValidationResult<RunRequest> {
  return plain<RunRequest>(runRequestSchema, value, (v) =>
    Buffer.byteLength(JSON.stringify(v), "utf8") > MAX_DISPATCH_INPUT_BYTES ? [`/: inputs exceed ${MAX_DISPATCH_INPUT_BYTES} bytes`] : [],
  )
}

export function validateReportRequest(value: unknown): ValidationResult<ReportRequest> {
  return plain<ReportRequest>(reportRequestSchema, value, () => [])
}

export function validateSetupPlan(value: unknown): ValidationResult<SetupPlan> {
  return checkDocument<SetupPlan>(setupPlanSchema, "schema_version", CONTRACT_MAJOR, value, (p) => {
    const errors: string[] = []
    if (p.run_tag !== runTagFor(p.setup_run_id)) errors.push(`/run_tag: must be ${runTagFor(p.setup_run_id)}`)
    errors.push(...exactTestIds(p.tenants.map((t) => t.test_id), "/tenants"))
    errors.push(...sortedUnique(p.tenants.map((t) => t.test_id), "/tenants"))
    const keys = p.dispatches.map((d) => d.run_key)
    if (new Set(keys).size !== keys.length) errors.push("/dispatches: run_key used twice")
    const roles = p.dispatches.map((d) => d.role)
    if (new Set(roles).size !== roles.length) errors.push("/dispatches: role used twice")
    if (roles.includes("ai") && !roles.includes("main")) errors.push("/dispatches: an ai dispatch needs a main dispatch")
    p.dispatches.forEach((d, i) => {
      const expected = d.role === "main" ? "e2e-bundle" : "e2e-bundle-ai"
      if (d.bundle_artifact !== expected) errors.push(`/dispatches/${i}/bundle_artifact: must be ${expected}`)
      if (d.dispatched_run_id !== null && d.dispatched_at === null) {
        errors.push(`/dispatches/${i}: dispatched_run_id without dispatched_at`)
      }
    })
    const main = p.dispatches.find((d) => d.role === "main")
    if (p.state === "dispatched" && (!main || main.dispatched_at === null)) {
      errors.push("/state: dispatched needs a main dispatch with dispatched_at")
    }
    if (p.state !== "dispatched" && p.dispatches.some((d) => d.dispatched_at !== null)) {
      errors.push(`/state: ${p.state} but a dispatch was sent`)
    }
    if (p.mail.contained && p.mail.effective_catch_all === null) errors.push("/mail: contained needs effective_catch_all")
    if (p.state === "dispatched" && !p.fixture && !p.mail.contained) errors.push("/mail: a keyed run is dispatched only after mail is contained")
    const older = p.supersedes.map((s) => s.setup_run_id)
    if (new Set(older).size !== older.length) errors.push("/supersedes: setup_run_id listed twice")
    for (const id of older) {
      if (BigInt(id) >= BigInt(p.setup_run_id)) errors.push(`/supersedes: ${id} is not older than ${p.setup_run_id}`)
    }
    return errors
  })
}

export function validateShardPlan(value: unknown): ValidationResult<ShardPlan> {
  return checkDocument<ShardPlan>(shardPlanSchema, "schema_version", CONTRACT_MAJOR, value, (p) => shardErrors(p.shards, "/shards"))
}

export function validateSelection(value: unknown): ValidationResult<Selection> {
  return checkDocument<Selection>(selectionSchema, "schemaVersion", CONTRACT_MAJOR, value, (s) => {
    const errors: string[] = []
    const ids = s.tests.map((t) => t.id)
    errors.push(...exactTestIds(ids, "/tests"))
    errors.push(...sortedUnique(ids, "/tests"))
    s.tests.forEach((t, i) => {
      const kind = testKindOf(t.id)
      if (kind !== null && kind !== t.kind) errors.push(`/tests/${i}: kind ${t.kind} does not match id kind ${kind}`)
      errors.push(...sortedUnique(t.reasons, `/tests/${i}/reasons`))
    })
    errors.push(...exactTestIds(s.alwaysRun, "/alwaysRun"))
    errors.push(...sortedUnique(s.alwaysRun, "/alwaysRun"))
    errors.push(...sortedUnique(s.unplaced, "/unplaced"))
    errors.push(...sortedUnique(s.ignored, "/ignored"))
    for (const p of s.unplaced) if (s.ignored.includes(p)) errors.push(`/unplaced: ${p} is also ignored`)
    errors.push(
      ...sortedUnique(
        s.untestedVariants.map((v) => `${v.functionId}\u0000${v.dimension}\u0000${v.value}`),
        "/untestedVariants",
      ),
    )
    s.untestedVariants.forEach((v, i) => {
      if (!isIdOfKind(v.functionId, "fn")) errors.push(`/untestedVariants/${i}/functionId: ${v.functionId} is not a valid fn id`)
    })
    errors.push(...sortedUnique(s.changedWithoutFunctionalTest.map((g) => g.node), "/changedWithoutFunctionalTest"))
    s.changedWithoutFunctionalTest.forEach((g, i) => {
      if (!isIdOfKind(g.node, "route", "feature")) errors.push(`/changedWithoutFunctionalTest/${i}/node: ${g.node} is not a node id`)
      errors.push(...sortedUnique(g.files, `/changedWithoutFunctionalTest/${i}/files`))
    })
    for (const kind of ["functional", "screen", "snapshot"] as const) {
      const n = s.tests.filter((t) => t.kind === kind).length
      if (n > s.catalogue[kind]) errors.push(`/catalogue/${kind}: ${n} selected but catalogue has ${s.catalogue[kind]}`)
    }
    if (s.fullRun !== null) {
      if (s.tests.length > 0) errors.push("/tests: a full run carries no partial selection")
      if (s.shardPlan !== null) errors.push("/shardPlan: a full run is planned from the catalogue, not from the selection")
    } else {
      if (s.rule === null) errors.push("/rule: a selection names its rule")
      if (s.mapSha === null) errors.push("/mapSha: a selection names its map")
      const selected = new Set(ids)
      for (const id of s.alwaysRun) if (!selected.has(id)) errors.push(`/alwaysRun: ${id} is not selected`)
      if (s.unplaced.length > 0) errors.push("/fullRun: an unplaced file forces a full run")
    }
    if (s.shardPlan !== null) {
      const planned = s.shardPlan.shards.flatMap((sh) => sh.ids)
      const indexes = s.shardPlan.shards.map((sh) => sh.index)
      indexes.forEach((n, i) => {
        if (n !== i + 1) errors.push("/shardPlan/shards: indexes must be 1..n in order")
      })
      if (new Set(planned).size !== planned.length) errors.push("/shardPlan: a test is planned twice")
      const plannedSet = new Set(planned)
      for (const id of ids) if (!plannedSet.has(id)) errors.push(`/shardPlan: ${id} is selected but not planned`)
      for (const id of planned) if (!ids.includes(id)) errors.push(`/shardPlan: ${id} is planned but not selected`)
    }
    return [...new Set(errors)]
  })
}

export function serializeSelection(selection: Selection): string {
  return canonicalJson(selection)
}

export function validateBundle(value: unknown): ValidationResult<Bundle> {
  const secrets: string[] = []
  scanForSecrets(value, "", secrets)
  if (secrets.length > 0) return { ok: false, errors: secrets }
  return checkDocument<Bundle>(bundleSchema, "schema_version", CONTRACT_MAJOR, value, (b) => {
    const errors: string[] = []
    if (b.run_tag !== runTagFor(b.setup_run_id)) errors.push(`/run_tag: must be ${runTagFor(b.setup_run_id)}`)
    b.shard_plan.forEach((s, i) => {
      if (s.run_key !== b.run_key) errors.push(`/shard_plan/${i}/run_key: must be the bundle's run_key`)
    })
    errors.push(...shardErrors(b.shard_plan, "/shard_plan"))
    const shardIndexes = new Set(b.shard_plan.map((s) => String(s.index)))
    for (const shard of Object.keys(b.tickets)) {
      if (!shardIndexes.has(shard)) errors.push(`/tickets/${shard}: no such shard`)
    }
    for (const [shard, byUser] of Object.entries(b.tickets)) {
      for (const email of Object.keys(byUser)) {
        if (email !== email.toLowerCase()) errors.push(`/tickets/${shard}/${email}: key by the lower-case email`)
      }
    }
    for (const [id, email] of Object.entries(b.users)) {
      if (email !== email.toLowerCase()) errors.push(`/users/${id}: must be the lower-case email`)
    }
    const all = Object.values(b.tickets).flatMap((byUser) => Object.values(byUser))
    if (new Set(all).size !== all.length) errors.push("/tickets: a ticket is listed twice")
    const plannedKeys = new Set<string>()
    for (const s of b.shard_plan) {
      for (const t of s.tests) {
        const titlePath = titlePathOfTestId(t.id)
        if (titlePath) plannedKeys.add(tenantKeyOf(titlePath))
      }
    }
    for (const [key, tenant] of Object.entries(b.tenants)) {
      const base = tenantBaseKey(key)
      if (tenantKeyOfTitle(tenant.title) !== base) errors.push(`/tenants/${key}/title: does not hash to the tenant key`)
      if (!plannedKeys.has(base)) errors.push(`/tenants/${key}: test is not in this bundle's shard plan`)
      const kinds = tenant.members.map((m) => m.kind)
      if (kinds.filter((k) => k === "owner").length !== 1) errors.push(`/tenants/${key}/members: exactly one owner`)
      if (new Set(kinds).size !== kinds.length) errors.push(`/tenants/${key}/members: a kind is listed twice`)
      for (const m of tenant.members) {
        if (b.users[m.user_id] !== m.email) errors.push(`/users/${m.user_id}: must map to member ${m.email}`)
        if (m.external ? m.convex_user_id !== undefined || m.kind === "owner" : m.convex_user_id === undefined) {
          errors.push(`/tenants/${key}/members/${m.kind}: an internal member needs convex_user_id; an external one (never the owner) has none`)
        }
      }
    }
    const ttl = (Date.parse(b.expires_at) - Date.parse(b.issued_at)) / 1000
    if (!(ttl > 0 && ttl <= TICKET_TTL_SECONDS)) errors.push(`/expires_at: must be within ${TICKET_TTL_SECONDS} s after issued_at`)
    if (b.selection !== null) {
      const sel = validateSelection(b.selection)
      if (!sel.ok) errors.push(...sel.errors.map((e) => `/selection${e}`))
    }
    return errors
  })
}

export function validateBundleEnvelope(value: unknown): ValidationResult<BundleEnvelope> {
  return plain<BundleEnvelope>(bundleEnvelopeSchema, value, (e) => {
    const errors: string[] = []
    if (Buffer.from(e.iv, "base64").length !== 12) errors.push("/iv: must be 12 bytes")
    if (Buffer.from(e.tag, "base64").length !== 16) errors.push("/tag: must be 16 bytes")
    if (Buffer.from(e.wrapped_key, "base64").length < 256) errors.push("/wrapped_key: shorter than an RSA-2048 block")
    return errors
  })
}

export function validateControl(value: unknown): ValidationResult<Control> {
  return checkDocument<Control>(controlSchema, "schema_version", CONTRACT_MAJOR, value, (c) => {
    const errors: string[] = []
    if (c.run_tag !== runTagFor(c.setup_run_id)) errors.push(`/run_tag: must be ${runTagFor(c.setup_run_id)}`)
    if (c.mail) {
      if (c.mail.contained && c.mail.projection.emailEnabled) {
        errors.push("/mail: a deployment with emailEnabled true is refused, never contained")
      }
      if (c.mail.contained !== (c.mail.contained_at !== null)) errors.push("/mail/contained_at: set exactly when contained")
      const from = c.mail.adopted_from_setup_run_id
      if (from !== null && BigInt(from) >= BigInt(c.setup_run_id)) errors.push("/mail/adopted_from_setup_run_id: must be an older setup run")
    }
    const emails = c.created.users.map((u) => u.email)
    if (new Set(emails).size !== emails.length) errors.push("/created/users: email listed twice")
    const userIds = c.created.users.map((u) => u.user_id)
    if (new Set(userIds).size !== userIds.length) errors.push("/created/users: user_id listed twice")
    const orgs = c.created.tenants.map((t) => t.org_id)
    if (new Set(orgs).size !== orgs.length) errors.push("/created/tenants: org_id listed twice")
    errors.push(...exactTestIds(c.created.tenants.map((t) => t.test_id), "/created/tenants"))
    if (c.seeded_escape) {
      if (!isIdOfKind(c.seeded_escape.function_id, "fn")) errors.push("/seeded_escape/function_id: not a valid fn id")
      errors.push(...exactTestIds(c.seeded_escape.dropped, "/seeded_escape/dropped"))
    }
    return errors
  })
}

export function validateCommentRows(value: unknown): ValidationResult<CommentRows> {
  return checkDocument<CommentRows>(commentRowsSchema, "schema_version", CONTRACT_MAJOR, value, (r) => {
    const ids = r.groups.map((g) => g.id)
    return new Set(ids).size === ids.length ? [] : ["/groups: group id used twice"]
  })
}

export function validateRunRecord(value: unknown): ValidationResult<RunRecord> {
  return checkDocument<RunRecord>(runRecordSchema, "schemaVersion", CONTRACT_MAJOR, value, (r) => {
    const errors: string[] = []
    const ids = r.results.map((x) => x.id)
    errors.push(...exactTestIds(ids, "/results"))
    errors.push(...sortedUnique(ids, "/results"))
    r.results.forEach((x, i) => {
      const kind = testKindOf(x.id)
      if (kind !== null && kind !== x.kind) errors.push(`/results/${i}: kind ${x.kind} does not match id kind ${kind}`)
    })
    if (r.selection) {
      errors.push(...exactTestIds(r.selection.selected, "/selection/selected"))
      errors.push(...sortedUnique(r.selection.selected, "/selection/selected"))
    }
    if (r.ai) {
      errors.push(...exactTestIds(r.ai.additions, "/ai/additions"))
      if (r.ai.cached && r.ai.costUsd !== 0) errors.push("/ai/costUsd: a cache hit costs nothing")
      if (r.ai.outcome !== "ok" && r.ai.additions.length > 0) errors.push("/ai/additions: only an ok answer adds tests")
    }
    if (r.control) {
      if (!isIdOfKind(r.control.functionId, "fn")) errors.push("/control/functionId: not a valid fn id")
      errors.push(...exactTestIds(r.control.dropped, "/control/dropped"))
    }
    if (r.kind === "postmerge" && r.mergeCommitSha === null) errors.push("/mergeCommitSha: a postmerge run names its merge commit")
    return errors
  })
}
