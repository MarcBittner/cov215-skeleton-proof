import { CONTRACT_VERSION } from "../contract/constants.js"
import type { CommentGroup, CommentRow, CommentRows, Selection } from "../contract/types.js"

export const MAX_IDS = 200
export const MAX_ROWS = 500
const MAX_TEXT = 2000

export interface RowsInput {
  selection: Selection
  setupRunId: string
  catalogue?: readonly string[]
  results?: readonly { id: string; result: "passed" | "failed" | "flaky" | "not-run" }[]
}

const clip = (text: string) => (text.length > MAX_TEXT ? `${text.slice(0, MAX_TEXT - 1)}…` : text)
const row = (text: string, level: CommentRow["level"], ids: readonly string[]): CommentRow => ({
  text: clip(text),
  level,
  ids: [...new Set(ids)].sort().slice(0, MAX_IDS),
})

function chunk(text: string, level: CommentRow["level"], ids: readonly string[]): CommentRow[] {
  const sorted = [...new Set(ids)].sort()
  if (sorted.length <= MAX_IDS) return [row(text, level, sorted)]
  const out: CommentRow[] = []
  for (let i = 0; i < sorted.length; i += MAX_IDS) {
    out.push(row(`${text} (${i / MAX_IDS + 1})`, level, sorted.slice(i, i + MAX_IDS)))
  }
  return out
}

export function buildRows(input: RowsInput): CommentRows {
  const s = input.selection
  const groups: CommentGroup[] = []
  const add = (id: string, title: string, rows: CommentRow[]) => {
    if (rows.length > 0) groups.push({ id, title, rows: rows.slice(0, MAX_ROWS) })
  }

  if (s.fullRun !== null) {
    add("full-run", "Full run", [row(`Every test runs: ${s.fullRun}`, "warn", [])])
  }

  const byReason = new Map<string, string[]>()
  for (const t of s.tests) for (const r of t.reasons) byReason.set(r, [...(byReason.get(r) ?? []), t.id])
  add(
    "why",
    "Why these tests ran",
    [...byReason]
      .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0))
      .flatMap(([reason, ids]) => chunk(reason, "info", ids)),
  )

  add(
    "no-functional-test",
    "Changed with no functional test",
    s.changedWithoutFunctionalTest.map((g) => row(`${g.node} (${g.files.join(", ")}) changed and no functional test covers it`, "warn", [g.node])),
  )

  add(
    "untested-variants",
    "Untested variants",
    s.untestedVariants.map((v) => row(`${v.functionId}: no test for ${v.dimension} ${v.value}`, "warn", [v.functionId])),
  )

  const total = s.catalogue.functional + s.catalogue.screen + s.catalogue.snapshot
  if (s.fullRun === null) {
    const selected = new Set(s.tests.map((t) => t.id))
    const notSelected = (input.catalogue ?? []).filter((id) => !selected.has(id))
    const count = input.catalogue ? notSelected.length : Math.max(0, total - s.tests.length)
    add("not-selected", "Not selected", count > 0 ? chunk(`${count} of ${input.catalogue?.length ?? total} tests not selected`, "info", notSelected) : [])
  }

  if (input.results) {
    const ran = new Set(input.results.filter((r) => r.result !== "not-run").map((r) => r.id))
    const expected = s.fullRun === null ? s.tests.map((t) => t.id) : [...(input.catalogue ?? [])]
    const missing = expected.filter((id) => !ran.has(id))
    add("selected-not-run", "Selected, not run", missing.length > 0 ? chunk(`${missing.length} selected tests did not run`, "fail", missing) : [])
  }

  return {
    schema_version: CONTRACT_VERSION,
    task: "t4",
    setup_run_id: input.setupRunId,
    section: "Test selection",
    status: "ok",
    detail: null,
    groups,
  }
}

export function errorRows(setupRunId: string, detail: string): CommentRows {
  return {
    schema_version: CONTRACT_VERSION,
    task: "t4",
    setup_run_id: setupRunId,
    section: "Test selection",
    status: "error",
    detail: clip(detail),
    groups: [{ id: "full-run", title: "Full run", rows: [row(`Every test runs: ${clip(detail)}`, "warn", [])] }],
  }
}
