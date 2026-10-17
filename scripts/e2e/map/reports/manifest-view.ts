import { parseId } from "../../../../e2e/map/ids.js"
import { type Manifest, validateManifest } from "../../contract/manifest.js"

export const REPORTS_SCHEMA_MAJOR = 1

export type CellStatus =
  | "captured"
  | "redirected"
  | "could-not-sign-in"
  | "unreachable"
  | "unresolved-id"

export type TestKind = "functional" | "screen" | "snapshot"
export type TestResult = "passed" | "failed" | "flaky" | "not-run"
export type SnapshotStatus = "recorded" | "unstable" | "not-snapshotted"

export interface MapCell {
  id: string
  route: string
  role: string
  recordState: string
  flagSet: string
  status: CellStatus
}

export interface MapControl {
  id: string
  cell: string
  key: string
  actionClass?: string
  snapshotStatus?: SnapshotStatus
  snapshotReason?: string
}

export interface MapTest {
  id: string
  file: string
  title: string
  kind: TestKind
  roles: string[]
  flagSet: string
  nodes: string[]
  functions: string[]
  udfPaths: string[]
  controls: string[]
  tags?: string[]
  result: TestResult
}

export type HealthValue = number | string | boolean | null

export function coverageText(v: unknown): string | null {
  if (!isRecord(v)) return null
  const pct = typeof v.mappedPct === "number" ? ` (${v.mappedPct}% source-mapped)` : ""
  return `${String(v.status)}${pct}`
}

function healthValue(k: string, v: unknown): unknown {
  if (Array.isArray(v)) return v.length
  if (k === "coverage") return coverageText(v) ?? v
  return v
}

export interface ReportManifest {
  schemaVersion: string
  stagingSha: string
  cells: MapCell[]
  controls: MapControl[]
  tests: MapTest[]
  health?: Record<string, HealthValue>
}

const CELL_STATUSES = new Set<string>([
  "captured",
  "redirected",
  "could-not-sign-in",
  "unreachable",
  "unresolved-id",
])
const TEST_KINDS = new Set<string>(["functional", "screen", "snapshot"])
const TEST_RESULTS = new Set<string>(["passed", "failed", "flaky", "not-run"])
const SNAPSHOT_STATUSES = new Set<string>(["recorded", "unstable", "not-snapshotted"])

function isRecord(v: unknown): v is Record<string, unknown> {
  return typeof v === "object" && v !== null && !Array.isArray(v)
}

function isStringArray(v: unknown): v is string[] {
  return Array.isArray(v) && v.every((x) => typeof x === "string")
}

export function fromContractManifest(m: Manifest): ReportManifest {
  const meta = new Map((m.controls ?? []).map((c) => [c.id, c]))
  const cells: MapCell[] = []
  const controls: MapControl[] = []
  for (const c of m.cells) {
    const cell = parseId(c.id)
    if (cell?.kind !== "cell") throw new Error(`${c.id} is not a cell id`)
    cells.push({ id: c.id, route: cell.route, role: cell.role, recordState: cell.recordState, flagSet: cell.flagSet, status: c.status })
    for (const id of c.controls) {
      const control = parseId(id)
      if (control?.kind !== "control") throw new Error(`${id} is not a control id`)
      const k = meta.get(id)
      controls.push({
        id,
        cell: c.id,
        key: control.controlKey,
        ...(k ? { actionClass: k.actionClass, snapshotStatus: k.snapshotStatus } : {}),
        ...(k?.snapshotReason ? { snapshotReason: k.snapshotReason } : {}),
      })
    }
  }
  return {
    schemaVersion: m.schemaVersion,
    stagingSha: m.stagingSha,
    cells,
    controls,
    tests: m.tests.map((t) => ({
      id: t.id,
      file: t.file,
      title: t.title,
      kind: t.kind,
      roles: t.roles,
      flagSet: t.flagSet,
      nodes: t.nodes,
      functions: t.functions,
      udfPaths: t.udfPaths,
      controls: t.controls,
      result: t.result,
    })),
    health: Object.fromEntries(Object.entries(m.health).map(([k, v]) => [k, healthValue(k, v) as HealthValue])),
  }
}

export function assertReportManifest(value: unknown, label: string): ReportManifest {
  const fail = (why: string): never => {
    throw new Error(`${label}: not a reportable map manifest: ${why}`)
  }
  if (isRecord(value) && "seedHash" in value) {
    const checked = validateManifest(value)
    if (!checked.ok) return fail(checked.errors.slice(0, 5).join("; "))
    return fromContractManifest(checked.value)
  }
  if (!isRecord(value)) fail("not an object")
  const m = value as Record<string, unknown>
  if (typeof m.schemaVersion !== "string") fail("schemaVersion missing")
  const major = Number((m.schemaVersion as string).split(".")[0])
  if (major !== REPORTS_SCHEMA_MAJOR) {
    fail(`schemaVersion ${m.schemaVersion} has major ${major}, reports read ${REPORTS_SCHEMA_MAJOR}`)
  }
  if (typeof m.stagingSha !== "string" || m.stagingSha === "") fail("stagingSha missing")
  if (!Array.isArray(m.cells)) fail("cells is not an array")
  if (!Array.isArray(m.controls)) fail("controls is not an array")
  if (!Array.isArray(m.tests)) fail("tests is not an array")

  ;(m.cells as unknown[]).forEach((c, i) => {
    if (!isRecord(c)) return fail(`cells[${i}] is not an object`)
    for (const k of ["id", "route", "role", "recordState", "flagSet"]) {
      if (typeof c[k] !== "string") fail(`cells[${i}].${k} is not a string`)
    }
    if (!CELL_STATUSES.has(c.status as string)) fail(`cells[${i}].status ${String(c.status)} is unknown`)
  })
  ;(m.controls as unknown[]).forEach((c, i) => {
    if (!isRecord(c)) return fail(`controls[${i}] is not an object`)
    for (const k of ["id", "cell", "key"]) {
      if (typeof c[k] !== "string") fail(`controls[${i}].${k} is not a string`)
    }
    if (c.actionClass !== undefined && typeof c.actionClass !== "string") {
      fail(`controls[${i}].actionClass is not a string`)
    }
    if (c.snapshotStatus !== undefined && !SNAPSHOT_STATUSES.has(c.snapshotStatus as string)) {
      fail(`controls[${i}].snapshotStatus ${String(c.snapshotStatus)} is unknown`)
    }
  })
  ;(m.tests as unknown[]).forEach((t, i) => {
    if (!isRecord(t)) return fail(`tests[${i}] is not an object`)
    for (const k of ["id", "file", "title", "flagSet"]) {
      if (typeof t[k] !== "string") fail(`tests[${i}].${k} is not a string`)
    }
    if (!TEST_KINDS.has(t.kind as string)) fail(`tests[${i}].kind ${String(t.kind)} is unknown`)
    if (!TEST_RESULTS.has(t.result as string)) fail(`tests[${i}].result ${String(t.result)} is unknown`)
    for (const k of ["roles", "nodes", "functions", "udfPaths", "controls"]) {
      if (!isStringArray(t[k])) fail(`tests[${i}].${k} is not a string array`)
    }
    if (t.tags !== undefined && !isStringArray(t.tags)) fail(`tests[${i}].tags is not a string array`)
  })
  if (m.health !== undefined) {
    if (!isRecord(m.health)) fail("health is not an object")
    const health = Object.fromEntries(Object.entries(m.health as Record<string, unknown>).map(([k, v]) => [k, k === "coverage" ? (coverageText(v) ?? v) : v]))
    for (const [key, v] of Object.entries(health)) {
      if (v !== null && !["number", "string", "boolean"].includes(typeof v)) fail(`health.${key} is not a scalar`)
    }
    return { ...(value as ReportManifest), health: health as Record<string, HealthValue> }
  }
  return value as ReportManifest
}

export function isActionControl(control: MapControl): boolean {
  return control.actionClass !== undefined && control.actionClass !== "none"
}

export function ran(test: MapTest): boolean {
  return test.result !== "not-run"
}

export function screenKey(route: string, role: string): string {
  return `${route}|${role}`
}

export interface ManifestIndex {
  cells: Map<string, MapCell>
  controls: Map<string, MapControl>
}

export function indexManifest(manifest: ReportManifest): ManifestIndex {
  return {
    cells: new Map(manifest.cells.map((c) => [c.id, c])),
    controls: new Map(manifest.controls.map((c) => [c.id, c])),
  }
}

export function capturedCells(manifest: ReportManifest): MapCell[] {
  return manifest.cells.filter((c) => c.status === "captured")
}

export function cellOfControl(controlId: string, index: ManifestIndex): MapCell | undefined {
  const control = index.controls.get(controlId)
  return index.cells.get(control ? control.cell : cellIdOfControl(controlId))
}

export function routesReached(test: MapTest, index: ManifestIndex): Set<string> {
  const routes = new Set<string>()
  for (const node of test.nodes) {
    if (node.startsWith("route:")) routes.add(node.slice("route:".length))
  }
  for (const controlId of test.controls) {
    const cell = cellOfControl(controlId, index)
    if (cell) routes.add(cell.route)
  }
  return routes
}

export function cellIdOfControl(controlId: string): string {
  const body = controlId.startsWith("control:") ? controlId.slice("control:".length) : controlId
  const parts = body.split("|")
  return parts.slice(0, 4).join("|")
}

export function sortedUnique(values: Iterable<string>): string[] {
  return [...new Set(values)].sort()
}
