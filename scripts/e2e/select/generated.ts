import { parseId } from "../../../e2e/map/ids.js"

export interface GeneratedTest {
  id: string
  kind: "functional" | "screen" | "snapshot"
  functions: readonly string[]
  udfPaths: readonly string[]
}

export interface GeneratedInput {
  catalogue: readonly GeneratedTest[]
  reachedNodes: Iterable<string>
  changedFunctions: Iterable<string>
  changedUdfs: Iterable<string>
}

export interface GeneratedSelection {
  screens: Map<string, string[]>
  snapshots: Map<string, string[]>
}

function routeOf(id: string): string | null {
  const parsed = parseId(id)
  if (parsed?.kind === "gen-screen") return `route:${parsed.cell.route}`
  if (parsed?.kind === "gen-snapshot") return `route:${parsed.control.cell.route}`
  return null
}

export function selectGenerated(input: GeneratedInput): GeneratedSelection {
  const nodes = new Set(input.reachedNodes)
  const fns = new Set(input.changedFunctions)
  const udfs = new Set(input.changedUdfs)
  const screens = new Map<string, string[]>()
  const snapshots = new Map<string, string[]>()
  for (const t of input.catalogue) {
    if (t.kind === "functional") continue
    const node = routeOf(t.id)
    if (node === null || !nodes.has(node)) continue
    if (t.kind === "screen") {
      screens.set(t.id, [`screen-check: ${node}`])
      continue
    }
    const hits = [...t.functions.filter((f) => fns.has(f)), ...t.udfPaths.filter((u) => udfs.has(u))].sort()
    if (hits.length > 0) snapshots.set(t.id, [`behaviour-snapshot: ${hits[0]}`])
  }
  return { screens, snapshots }
}
