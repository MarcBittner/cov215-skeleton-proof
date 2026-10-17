import { CONTRACT_VERSION } from "../../contract/constants.js"
import { validateCommentRows } from "../../contract/formats.js"
import type { CommentGroup, CommentRow, CommentRows } from "../../contract/types.js"
import type { NightReport } from "./orchestrate.js"

export const SECTION = "Test drafts"
const MAX_TEXT = 2000
const MAX_ROWS = 500
const MAX_IDS = 200

const clip = (text: string) => (text.length > MAX_TEXT ? `${text.slice(0, MAX_TEXT - 1)}…` : text)
const row = (text: string, level: CommentRow["level"], ids: string[]): CommentRow => ({
  text: clip(text),
  level,
  ids: [...new Set(ids)].slice(0, MAX_IDS),
})

function outcomeRows(report: NightReport): CommentRow[] {
  return report.applied.map((a) => {
    switch (a.action) {
      case "opened":
        return row(`${a.gapId}: draft PR #${a.pr} opened (${a.labels.join(", ")})`, a.labels.length > 1 ? "warn" : "info", [a.gapId])
      case "dry":
        return row(`${a.gapId}: draft ready, not opened in dry mode (${a.labels.join(", ")})`, a.labels.length > 1 ? "warn" : "info", [a.gapId])
      case "dropped":
        return row(`${a.gapId}: dropped: ${a.reasons.join("; ")}`, "warn", [a.gapId])
      case "waiting":
        return row(`${a.gapId}: waiting: ${a.reasons.join("; ")}`, "info", [a.gapId])
      default: {
        const other = a as { gapId: string; action: string }
        return row(`${other.gapId}: unknown outcome ${other.action}`, "warn", [other.gapId])
      }
    }
  })
}

function draftedRows(report: NightReport): CommentRow[] {
  const gates = new Map<string, number>()
  for (const g of report.gateRequests) gates.set(g.gapId, (gates.get(g.gapId) ?? 0) + 1)
  return report.drafted.map((d) =>
    row(
      `${d.gapId}: drafted in ${d.attempts} attempt(s) for $${d.costUsd.toFixed(2)}, ${gates.get(d.gapId) ?? 0} gate run(s) requested`,
      "info",
      [d.gapId],
    ),
  )
}

function failedRows(report: NightReport): CommentRow[] {
  return report.failed.map((f) => row(`${f.gapId}: not drafted after ${f.attempts} attempt(s): ${f.reason}`, "warn", [f.gapId]))
}

function skippedRows(report: NightReport): CommentRow[] {
  const byReason = new Map<string, string[]>()
  for (const s of report.skipped) byReason.set(s.reason, [...(byReason.get(s.reason) ?? []), s.gapId])
  return [...byReason].map(([reason, ids]) => row(`${ids.length} gap(s) skipped: ${reason}`, "info", ids))
}

function group(id: string, title: string, rows: CommentRow[]): CommentGroup {
  if (rows.length <= MAX_ROWS) return { id, title, rows }
  const kept = rows.slice(0, MAX_ROWS - 1)
  return { id, title, rows: [...kept, row(`${rows.length - kept.length} more not shown`, "info", [])] }
}

function checked(rows: CommentRows): CommentRows {
  const v = validateCommentRows(rows)
  if (!v.ok) throw new Error(`t5 comment rows are invalid: ${v.errors.join("; ")}`)
  return v.value
}

export function commentRows(report: NightReport, setupRunId: string): CommentRows {
  const spend = `$${report.spentUsd.toFixed(2)} spent tonight`
  return checked({
    schema_version: CONTRACT_VERSION,
    task: "t5",
    setup_run_id: setupRunId,
    section: SECTION,
    status: "ok",
    detail: report.dry ? `Dry run: no draft PR is opened. ${spend}.` : `${spend}.`,
    groups: [
      group("gate-outcomes", "Gate outcomes", outcomeRows(report)),
      group("drafted", "Drafted tonight", draftedRows(report)),
      group("not-drafted", "Not drafted", failedRows(report)),
      group("skipped", "Skipped gaps", skippedRows(report)),
    ],
  })
}

export function errorCommentRows(setupRunId: string, message: string): CommentRows {
  return checked({
    schema_version: CONTRACT_VERSION,
    task: "t5",
    setup_run_id: setupRunId,
    section: SECTION,
    status: "error",
    detail: clip(message || "drafting failed"),
    groups: [],
  })
}
