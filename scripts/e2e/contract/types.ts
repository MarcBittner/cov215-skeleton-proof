export type RunKind = "pr" | "postmerge" | "nightly" | "gate" | "mut" | "fallback" | "fresh" | "base"
export type SelectMode = "full" | "select"
export type TestKind = "functional" | "screen" | "snapshot"
export type TestResult = "passed" | "failed" | "flaky" | "not-run"

export type RunRequest = { setup_run_id: string; run_key: string }
export type ReportRequest = { setup_run_id: string }

export type InjectedBreak = "alter-query-field" | "drop-mutation-frame"
export type GateEntry = { ref: string; path: string; sha256: string; break: InjectedBreak | null }

export type SetupPlanState = "planned" | "dispatched" | "refused" | "failed" | "superseded" | "skipped"

export type SetupPlan = {
  schema_version: string
  setup_run_id: string
  run_tag: string
  workflow_sha: string
  created_at: string
  kind: RunKind
  fixture: boolean
  select_mode: SelectMode
  pr: number | null
  pr_sha: string
  base_sha: string | null
  target_sha?: string
  tooling_sha?: string | null
  branch: string
  deployment: {
    github_deployment_id: number
    vercel_deployment_id: string
    url: string
    convex_deployment: string
    convex_url: string
  }
  gate: GateEntry | null
  mail: { contained: boolean; effective_catch_all: string | null }
  tenants: { test_id: string; org_id: string }[]
  dispatches: Dispatch[]
  supersedes: { setup_run_id: string; pr_sha: string }[]
  state: SetupPlanState
  reason: string | null
}

export type Dispatch = {
  run_key: string
  role: "main" | "ai"
  bundle_artifact: "e2e-bundle" | "e2e-bundle-ai"
  ref: string
  dispatched_run_id: string | null
  dispatched_at: string | null
}

export type PlannedTest = { id: string; kind: TestKind; file: string; project: string; predicted_ms: number }
export type Shard = { run_key: string; index: number; role?: "ai"; predicted_ms: number; tests: PlannedTest[] }

export type ShardPlan = {
  schema_version: string
  setup_run_id: string
  select_mode: SelectMode
  full_run: string | null
  shards: Shard[]
}

export type TenantMember = { kind: string; user_id: string; convex_user_id?: string; external?: true; email: string; role: string }
export type BundleTenant = { title: string; org_id: string; org_name: string; recipe: string; members: TenantMember[] }

export type Bundle = {
  schema_version: string
  setup_run_id: string
  run_key: string
  run_tag: string
  kind: RunKind
  sha: string
  vercel_deployment_id: string
  base_url: string
  convex_url: string
  select_mode: SelectMode
  selection: Selection | null
  shard_plan: Shard[]
  tenants: Record<string, BundleTenant>
  tickets: Record<string, Record<string, string>>
  users: Record<string, string>
  issued_at: string
  expires_at: string
}

export type BundleEnvelope = {
  format: "cov215-e2e-bundle"
  version: 1
  alg: "RSA-OAEP-256+A256GCM"
  key_id: string
  setup_run_id: string
  run_key: string
  sha: string
  wrapped_key: string
  iv: string
  tag: string
  ciphertext: string
}

export type TableDigest = { count: number; sha256: string }

export type Control = {
  schema_version: string
  setup_run_id: string
  run_tag: string
  convex_deployment: string
  mail: {
    projection: { emailEnabled: boolean; catchAllAddress: string; catchAllSource: "database" | "default" }
    adopted_from_setup_run_id: string | null
    contained: boolean
    contained_at: string | null
  } | null
  seed_integrity: {
    read_at: string
    tables: { projects: TableDigest; contracts: TableDigest; changeOrders: TableDigest; rfis: TableDigest }
  } | null
  created: {
    users: { user_id: string; email: string }[]
    tenants: { org_id: string; test_id: string; recipe: string }[]
  }
  limiter: {
    user_creates_per_s: number
    ticket_mints_per_s: number
    max_users: number
    max_tickets_per_min: number
    max_tenants: number
    deadline_at: string
  }
  persona_windows?: Record<string, { from: number; to: number }[]>
  seeded_escape: { function_id: string; break_sha: string; branch: string; dropped: string[] } | null
}

export type CommentTask = "t3" | "t4" | "t5"
export type CommentRow = { text: string; level: "info" | "warn" | "fail"; ids: string[] }
export type CommentGroup = { id: string; title: string; rows: CommentRow[] }

export type CommentRows = {
  schema_version: string
  task: CommentTask
  setup_run_id: string
  section: string
  status: "ok" | "error"
  detail: string | null
  groups: CommentGroup[]
}

export type FullRunCode =
  | "map-stale"
  | "map-untrusted"
  | "map-fetch-failed"
  | "diff-mismatch"
  | "manifest-schema-invalid"
  | "schema-unparsed"
  | "schema-unmapped"
  | "helper-fanout"
  | "selector-error"
  | "server-unexecuted"
  | "server-code"
  | "unplaceable"
  | "threshold"
  | "trigger"
  | "seed"

export type SelectedTest = { id: string; kind: TestKind; reasons: string[] }

export type Selection = {
  schemaVersion: string
  harnessSha: string
  pr: number | null
  baseSha: string
  headSha: string
  mapSha: string | null
  mode: SelectMode
  rule: "function" | "interim-static" | null
  fullRun: string | null
  tests: SelectedTest[]
  alwaysRun: string[]
  unplaced: string[]
  ignored: string[]
  untestedVariants: { functionId: string; dimension: "role" | "flag"; value: string }[]
  changedWithoutFunctionalTest: { node: string; files: string[] }[]
  catalogue: { functional: number; screen: number; snapshot: number }
  predictedDurationMs: number
  shardPlan: { overheadMs: number; shards: { index: number; ids: string[]; predictedMs: number }[] } | null
}

export type RunRecord = {
  schemaVersion: string
  setupRunId: string
  runId: string | null
  kind: RunKind
  pr: number | null
  headSha: string
  baseSha: string | null
  mergeCommitSha: string | null
  treeEqual: boolean | null
  recordedAt: string
  groundTruth: boolean
  sampled: boolean | null
  selection: {
    mode: SelectMode
    rule: "function" | "interim-static" | null
    fullRun: string | null
    mapSha: string | null
    selected: string[]
  } | null
  results: { id: string; kind: TestKind; result: TestResult; quarantined: boolean; retries: number }[]
  ai: {
    mode: "shadow" | "det+ai"
    outcome: "ok" | "refusal" | "max-tokens" | "timeout" | "parse-error" | "limit" | "error"
    cached: boolean
    cacheKey: string
    model: string
    additions: string[]
    usage: { inputTokens: number; outputTokens: number; cacheReadInputTokens: number; cacheCreationInputTokens: number }
    costUsd: number
  } | null
  control: { kind: "seeded-escape"; functionId: string; breakSha: string; branch: string; dropped: string[] } | null
}
