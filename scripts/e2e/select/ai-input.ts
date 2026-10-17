import type { Selection, TestKind } from "../contract/types.js"
import { selectGenerated } from "./generated.js"

export interface AiMapTest {
  id: string
  kind: TestKind
  title: string
  nodes: readonly string[]
  functions: readonly string[]
  udfPaths: readonly string[]
}

export interface AiInputParts {
  selection: Selection
  catalogue: readonly AiMapTest[]
  diff: string
  mergeBaseTree: string
  headTree: string
}

export function buildAiInput(p: AiInputParts) {
  const det = p.selection.tests.map((t) => ({ id: t.id, reasons: t.reasons }))
  const detIds = new Set(det.map((d) => d.id))
  const nodes = new Set(p.catalogue.filter((t) => detIds.has(t.id)).flatMap((t) => t.nodes))
  const neighbours = new Map<string, Set<string>>()
  for (const t of p.catalogue) {
    for (const n of t.nodes) {
      if (!nodes.has(n)) continue
      const set = neighbours.get(n) ?? new Set<string>()
      for (const m of t.nodes) if (m !== n) set.add(m)
      neighbours.set(n, set)
    }
  }
  return {
    pr: p.selection.pr,
    headSha: p.selection.headSha,
    mergeBaseTree: p.mergeBaseTree,
    headTree: p.headTree,
    mapSha: p.selection.mapSha ?? "",
    catalogue: p.catalogue
      .filter((t) => t.kind === "functional")
      .map((t) => ({ id: t.id, kind: t.kind, title: t.title, observes: [...t.nodes] })),
    neighbourhoods: [...nodes].sort().map((node) => ({ node, neighbours: [...(neighbours.get(node) ?? [])].sort() })),
    det,
    diff: p.diff,
  }
}

export function widenWithGenerated(additions: readonly string[], catalogue: readonly AiMapTest[], already: ReadonlySet<string>): string[] {
  const added = new Set(additions)
  const observed = catalogue.filter((t) => added.has(t.id)).flatMap((t) => t.nodes)
  const generated = selectGenerated({ catalogue, reachedNodes: observed, changedFunctions: [], changedUdfs: [] })
  return [...new Set([...additions, ...generated.screens.keys()])].filter((id) => !already.has(id)).sort()
}
