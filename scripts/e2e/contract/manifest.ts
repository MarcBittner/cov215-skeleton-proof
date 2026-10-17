import { manifestIndexSchema, manifestSchema } from "./schemas.generated.js"
import { type ValidationResult, checkDocument, parseJsonDocument, parseVersion } from "./validate.js"
import { isIdOfKind, type MapIdKind, parseId, testKindOf, TITLE_SEPARATOR, type TestKind } from "../../../e2e/map/ids.js"

export const MANIFEST_MAJOR = 1
export const MANIFEST_VERSION = "1.1"
export const FUNCTION_KINDS: readonly MapIdKind[] = ["fn", "udf", "cron", "http"]

export type TestRecord = {
  id: string
  file: string
  title: string
  kind: TestKind
  provenance: "human" | "approved-draft"
  roles: string[]
  flagSet: string
  recordStates: string[]
  nodes: string[]
  functions: string[]
  udfPaths: string[]
  controls: string[]
  durationMs: number
  result: "passed" | "failed" | "flaky" | "not-run"
}

export type SnapshotStatus = "recorded" | "unstable" | "not-snapshotted"
export type ControlRecord = { id: string; actionClass: string; snapshotStatus: SnapshotStatus; snapshotReason: string | null }

export type CellStatus = "captured" | "redirected" | "could-not-sign-in" | "unreachable" | "unresolved-id"
export type ConvexEdgeKind = "ctx-run" | "scheduler" | "cron" | "http-route" | "helper-import" | "src-caller"

export type Manifest = {
  schemaVersion: string
  stagingSha: string
  builtAt: string
  seedHash: string
  tests: TestRecord[]
  nodes: { id: string; files: string[] }[]
  cells: { id: string; status: CellStatus; controls: string[] }[]
  controls?: ControlRecord[]
  tablesToFunctions: Record<string, string[]>
  convexEdges: { from: string; to: string; kind: ConvexEdgeKind }[]
  alwaysRun: string[]
  gaps: { node: string; files: string[]; reason: "no-functional-test" }[]
  health: {
    apiRefsResolved: number
    apiRefsTotal: number
    cronEdges: number
    cronEdgesIndependent: number
    httpEdges: number
    unresolvedImports: string[]
    cellsExpected: number
    cellsReturned: number
    testsListed: number
    testsReported: number
    coverage?: { status: "available" | "unavailable"; mappedPct: number | null }
  }
}

export type IndexStatus = "published" | "failed-partition" | "failed-job"
export type IndexEntry = { stagingSha: string; builtAt: string; schemaVersion: string; status: IndexStatus; reason: string | null }
export type ManifestIndex = { schemaVersion: string; latest: string | null; entries: IndexEntry[] }

function sortedUnique(values: string[], at: string): string[] {
  const errors: string[] = []
  for (let i = 1; i < values.length; i++) {
    if (values[i - 1] === values[i]) errors.push(`${at}: duplicate ${values[i]}`)
    else if (values[i - 1] > values[i]) errors.push(`${at}: not sorted at ${values[i]}`)
  }
  return errors
}

function idsOfKind(ids: string[], at: string, ...kinds: MapIdKind[]): string[] {
  return ids.filter((id) => !isIdOfKind(id, ...kinds)).map((id) => `${at}: ${id} is not a valid ${kinds.join("|")} id`)
}

function manifestErrors(m: Manifest): string[] {
  const errors: string[] = []
  const testIds = m.tests.map((t) => t.id)
  errors.push(...sortedUnique(testIds, "/tests"))
  m.tests.forEach((t, i) => {
    const at = `/tests/${i}`
    const kind = testKindOf(t.id)
    if (kind === null) {
      errors.push(`${at}/id: ${t.id} is not a valid test id`)
    } else if (kind !== t.kind) {
      errors.push(`${at}/kind: ${t.kind} does not match id kind ${kind}`)
    }
    const parsed = parseId(t.id)
    if (parsed?.kind === "test") {
      if (t.file !== parsed.path) errors.push(`${at}/file: must be ${parsed.path}`)
      if (t.title !== parsed.titlePath.join(TITLE_SEPARATOR)) errors.push(`${at}/title: must be the id's title path`)
    }
    errors.push(...sortedUnique(t.roles, `${at}/roles`))
    errors.push(...sortedUnique(t.recordStates, `${at}/recordStates`))
    errors.push(...sortedUnique(t.nodes, `${at}/nodes`), ...idsOfKind(t.nodes, `${at}/nodes`, "route", "feature"))
    errors.push(...sortedUnique(t.functions, `${at}/functions`), ...idsOfKind(t.functions, `${at}/functions`, "fn"))
    errors.push(...sortedUnique(t.udfPaths, `${at}/udfPaths`), ...idsOfKind(t.udfPaths, `${at}/udfPaths`, "udf"))
    errors.push(...sortedUnique(t.controls, `${at}/controls`), ...idsOfKind(t.controls, `${at}/controls`, "control"))
  })
  errors.push(...sortedUnique(m.nodes.map((n) => n.id), "/nodes"), ...idsOfKind(m.nodes.map((n) => n.id), "/nodes", "route", "feature"))
  errors.push(...sortedUnique(m.cells.map((c) => c.id), "/cells"), ...idsOfKind(m.cells.map((c) => c.id), "/cells", "cell"))
  m.cells.forEach((c, i) => {
    errors.push(...idsOfKind(c.controls, `/cells/${i}/controls`, "control"))
    for (const control of c.controls) {
      if (!control.startsWith(`control:${c.id}|`)) errors.push(`/cells/${i}/controls: ${control} belongs to another cell`)
    }
  })
  if (m.controls) {
    const inCells = new Set(m.cells.flatMap((c) => c.controls))
    errors.push(...sortedUnique(m.controls.map((c) => c.id), "/controls"))
    m.controls.forEach((c, i) => {
      if (!inCells.has(c.id)) errors.push(`/controls/${i}: ${c.id} is not a control of any cell`)
      if (c.snapshotStatus === "not-snapshotted" && c.snapshotReason === null) errors.push(`/controls/${i}: not-snapshotted needs a snapshotReason`)
    })
  }
  for (const [table, fns] of Object.entries(m.tablesToFunctions)) {
    errors.push(...idsOfKind([table], "/tablesToFunctions", "table"))
    errors.push(...idsOfKind(fns, `/tablesToFunctions/${table}`, ...FUNCTION_KINDS))
  }
  m.convexEdges.forEach((e, i) => errors.push(...idsOfKind([e.from, e.to], `/convexEdges/${i}`, ...FUNCTION_KINDS)))
  errors.push(...sortedUnique(m.alwaysRun, "/alwaysRun"))
  const known = new Set(testIds)
  for (const id of m.alwaysRun) if (!known.has(id)) errors.push(`/alwaysRun: ${id} is not in tests`)
  m.gaps.forEach((g, i) => errors.push(...idsOfKind([g.node], `/gaps/${i}/node`, "route", "feature")))
  const h = m.health
  if (h.apiRefsResolved > h.apiRefsTotal) errors.push("/health: apiRefsResolved exceeds apiRefsTotal")
  if (h.cellsReturned > h.cellsExpected) errors.push("/health: cellsReturned exceeds cellsExpected")
  if (h.testsReported > h.testsListed) errors.push("/health: testsReported exceeds testsListed")
  return errors
}

export function validateManifest(value: unknown): ValidationResult<Manifest> {
  return checkDocument<Manifest>(manifestSchema, "schemaVersion", MANIFEST_MAJOR, value, manifestErrors)
}

export function readManifest(text: string): Manifest {
  return parseJsonDocument("manifest", text, validateManifest)
}

export function validateManifestIndex(value: unknown): ValidationResult<ManifestIndex> {
  return checkDocument<ManifestIndex>(manifestIndexSchema, "schemaVersion", MANIFEST_MAJOR, value, (ix) => {
    const errors: string[] = []
    for (let i = 1; i < ix.entries.length; i++) {
      if (Date.parse(ix.entries[i].builtAt) < Date.parse(ix.entries[i - 1].builtAt)) {
        errors.push(`/entries/${i}: builtAt earlier than the entry before it`)
      }
    }
    const published = ix.entries.filter((e) => e.status === "published")
    const newest = published.length > 0 ? published[published.length - 1].stagingSha : null
    if (ix.latest !== newest) errors.push(`/latest: must be ${newest ?? "null"}, the newest published entry`)
    return errors
  })
}

export function readManifestIndex(text: string): ManifestIndex {
  return parseJsonDocument("manifest index", text, validateManifestIndex)
}

export function isReadableEntry(entry: IndexEntry): boolean {
  return parseVersion(entry.schemaVersion)?.major === MANIFEST_MAJOR
}
