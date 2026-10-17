import {
  capturedCells,
  cellOfControl,
  indexManifest,
  isActionControl,
  ran,
  routesReached,
  screenKey,
  type ManifestIndex,
  type ReportManifest,
} from "./manifest-view.js"

export type DraftStatus = "drafted" | "possible-bug" | "rejected"
export type GapStatus = "open" | DraftStatus
export type DraftStatusMap = Record<string, DraftStatus>

export interface ScreenGap {
  id: string
  kind: "screen"
  route: string
  role: string
  status: GapStatus
}

export interface ControlGap {
  id: string
  kind: "control"
  route: string
  role: string
  controlId: string
  controlKey: string
  status: GapStatus
}

export type Gap = ScreenGap | ControlGap

export interface UntestedVariant {
  route: string
  role: string
  flagSet: string
}

const DRAFT_STATUSES = new Set<string>(["drafted", "possible-bug", "rejected"])

export function screenGapId(route: string, role: string): string {
  return `screen:${screenKey(route, role)}`
}

export function assertDraftStatusMap(value: unknown): DraftStatusMap {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    throw new Error("draft status map is not an object")
  }
  for (const [id, status] of Object.entries(value)) {
    if (!DRAFT_STATUSES.has(status as string)) {
      throw new Error(`draft status for ${id} is ${String(status)}, expected drafted, possible-bug or rejected`)
    }
  }
  return value as DraftStatusMap
}

export interface FunctionalCoverage {
  screens: Set<string>
  controls: Set<string>
}

export function functionalCoverage(manifest: ReportManifest, index: ManifestIndex): FunctionalCoverage {
  const screens = new Set<string>()
  const controls = new Set<string>()
  for (const test of manifest.tests) {
    if (test.kind !== "functional" || !ran(test)) continue
    for (const route of routesReached(test, index)) {
      for (const role of test.roles) screens.add(screenKey(route, role))
    }
    for (const controlId of test.controls) controls.add(controlId)
  }
  return { screens, controls }
}

export function computeGaps(manifest: ReportManifest, drafts: DraftStatusMap = {}): Gap[] {
  const index = indexManifest(manifest)
  const covered = functionalCoverage(manifest, index)
  const gaps: Gap[] = []
  const seenScreens = new Set<string>()
  for (const cell of capturedCells(manifest)) {
    const key = screenKey(cell.route, cell.role)
    if (seenScreens.has(key)) continue
    seenScreens.add(key)
    if (covered.screens.has(key)) continue
    const id = screenGapId(cell.route, cell.role)
    gaps.push({ id, kind: "screen", route: cell.route, role: cell.role, status: drafts[id] ?? "open" })
  }
  for (const control of manifest.controls) {
    if (!isActionControl(control) || covered.controls.has(control.id)) continue
    const cell = cellOfControl(control.id, index)
    if (!cell || cell.status !== "captured") continue
    gaps.push({
      id: control.id,
      kind: "control",
      route: cell.route,
      role: cell.role,
      controlId: control.id,
      controlKey: control.key,
      status: drafts[control.id] ?? "open",
    })
  }
  return gaps.sort((a, b) => (a.id < b.id ? -1 : a.id > b.id ? 1 : 0))
}

export function untestedVariants(manifest: ReportManifest): UntestedVariant[] {
  const index = indexManifest(manifest)
  const testedRoutes = new Set<string>()
  const testedVariants = new Set<string>()
  for (const test of manifest.tests) {
    if (test.kind !== "functional" || !ran(test)) continue
    for (const route of routesReached(test, index)) {
      testedRoutes.add(route)
      for (const role of test.roles) testedVariants.add(`${route}|${role}|${test.flagSet}`)
    }
  }
  const out = new Map<string, UntestedVariant>()
  for (const cell of capturedCells(manifest)) {
    const key = `${cell.route}|${cell.role}|${cell.flagSet}`
    if (!testedRoutes.has(cell.route) || testedVariants.has(key)) continue
    out.set(key, { route: cell.route, role: cell.role, flagSet: cell.flagSet })
  }
  return [...out.keys()].sort().map((k) => out.get(k)!)
}
