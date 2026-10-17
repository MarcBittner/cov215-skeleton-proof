import { validateCommentRows } from "../contract/formats.js"
import { escapeInline, codeBlock, inlineCode } from "./escape.mjs"
import { SEP } from "./id.mjs"

export const COMMENT_LIMIT = 65_536
export const MARKER = "<!-- e2e-report -->"
export const ROW_LEVEL_PREFIX = { fail: "**failed:** ", warn: "**warning:** ", info: "" }
export const SECTIONS = [
  ["t3", "Map and generated tests"],
  ["t4", "Test selection"],
  ["t5", "Drafted tests"],
]

export function scopeLine(scope) {
  if (!scope) return "Full run: selection schema failure"
  if (scope.mode === "selected") return `Selected run: ${scope.selected} of ${scope.total}`
  return `Full run: ${scope.reason ?? "no reason recorded"}`
}

export function bindingMarker(binding) {
  if (!binding) return null
  const { headSha, diffHash } = binding
  if (!/^[0-9a-f]{40}$/.test(String(headSha))) throw new Error(`bad head sha "${headSha}"`)
  if (!/^[0-9a-f]{64}$/.test(String(diffHash))) throw new Error(`bad diff hash "${diffHash}"`)
  return `<!-- e2e-accept-binding head=${headSha} diff=${diffHash} -->`
}

function display(row) {
  const where = row.project && row.file ? `${row.project}, ${row.file}` : ""
  if (row.titles) return { title: row.titles.join(SEP), where }
  const sep = String(row.id).indexOf("::")
  return { title: String(row.id).startsWith("test:") && sep !== -1 ? row.id.slice(sep + 2) : row.id, where }
}

function clip(text, max) {
  const s = String(text ?? "")
  return s.length > max ? `${s.slice(0, max - 1)}…` : s
}

function rowHeading(row, esc, max) {
  const { title, where } = display(row)
  return `${row.ai ? "AI-added: " : ""}**${esc(clip(title, max))}** (${esc(where)})`
}

export function countsLine(counts) {
  return `${counts.passed} passed · ${counts.failed} failed · ${counts.flaky} flaky · ${counts.notRun} not run · ${counts.quarantined} known broken (of ${counts.planned} planned)`
}

function failedBlock(row, esc, level, shotUrl) {
  const lines = [`- ${rowHeading(row, esc, level >= 3 ? 120 : 300)}${row.reason ? ` — ${esc(row.reason)}` : ""}`]
  if (level >= 3) {
    if (row.expected != null || row.actual != null) lines.push(`  Expected ${inlineCode(clip(row.expected ?? "", 80))}, actual ${inlineCode(clip(row.actual ?? "", 80))}`)
    return lines.join("\n")
  }
  const steps = (row.steps ?? []).filter((s) => level === 0 || s.failed)
  if (steps.length) {
    lines.push(`  Steps: ${steps.slice(0, 30).map((s) => `${s.failed ? "**failed:** " : ""}${esc(clip(s.title, 120))}`).join(" → ")}`)
  }
  if (row.expected != null || row.actual != null) {
    lines.push(`  Expected ${inlineCode(clip(row.expected ?? "", 300))}, actual ${inlineCode(clip(row.actual ?? "", 300))}`)
  }
  if (row.error && level <= 1) {
    const text = level === 0 ? row.error : row.error.split("\n").slice(0, 3).join("\n")
    lines.push(codeBlock(clip(text, 2000)).split("\n").map((l) => `  ${l}`).join("\n"))
  }
  if (level <= 2) {
    for (const [i, p] of (row.screenshots ?? []).entries()) {
      const url = shotUrl ? shotUrl(p, row, i) : null
      lines.push(url ? `  ![screenshot ${i + 1}](${url})` : `  Screenshot ${i + 1}: in the run artifacts`)
    }
  }
  return lines.join("\n")
}

export function readRows(doc, task, setupRunId) {
  if (doc === undefined) return { state: "missing" }
  if (doc instanceof Error) return { state: "unreadable", reason: doc.message }
  const valid = validateCommentRows(doc)
  if (!valid.ok) return { state: "unreadable", reason: valid.errors[0] }
  if (valid.value.task !== task) return { state: "unreadable", reason: `rows are for ${valid.value.task}` }
  if (setupRunId != null && valid.value.setup_run_id !== String(setupRunId)) return { state: "unreadable", reason: `rows are from setup run ${valid.value.setup_run_id}` }
  return { state: "ok", doc: valid.value }
}

function rowsSection(raw, task, esc, level, setupRunId) {
  const read = readRows(raw, task, setupRunId)
  if (read.state === "missing") return "_not run_"
  if (read.state === "unreadable") return "_not run: row file unreadable_"
  const { doc } = read
  const out = []
  if (doc.status === "error") out.push(`_error: ${esc(clip(doc.detail, 500))}_`)
  else if (doc.detail) out.push(esc(clip(doc.detail, 500)))
  const max = level >= 2 ? 20 : 200
  for (const group of doc.groups) {
    out.push(`**${esc(clip(group.title, 120))}**`)
    if (group.rows.length === 0) out.push("- _no rows_")
    for (const r of group.rows.slice(0, max)) out.push(`- ${ROW_LEVEL_PREFIX[r.level] ?? ""}${esc(clip(r.text, 500))}`)
    if (group.rows.length > max) out.push(`- and ${group.rows.length - max} more`)
  }
  if (out.length === 0) out.push("_no rows_")
  return out.join("\n")
}

function render({ results, scope, rowFiles, meta, esc, shotUrl }, level) {
  const { counts, rows } = results
  const failed = rows.filter((r) => r.status === "failed" || r.status === "not-run")
  const flaky = rows.filter((r) => r.status === "flaky")
  const quarantined = rows.filter((r) => r.status === "quarantined")
  const passed = rows.filter((r) => r.status === "passed")
  const out = [MARKER, `## Browser tests: ${results.verdict === "passed" ? "passed" : "failed"}`, esc(scopeLine(scope))]
  out.push(countsLine(counts))
  if (results.aiCounts) out.push(`AI-added: ${countsLine(results.aiCounts)}; not part of the deterministic selection`)
  if (meta) {
    const bits = []
    if (meta.setupRunId && /^\d+$/.test(String(meta.setupRunId))) {
      bits.push(`setup run [${meta.setupRunId}](https://github.com/${meta.repo ?? "CO-Ver/Co-Ver"}/actions/runs/${meta.setupRunId})`)
    }
    if (meta.workflowSha && /^[0-9a-f]{7,40}$/.test(meta.workflowSha)) bits.push(`setup workflow ${meta.workflowSha.slice(0, 12)}`)
    if (meta.prSha && /^[0-9a-f]{7,40}$/.test(meta.prSha)) bits.push(`head ${meta.prSha.slice(0, 12)}`)
    if (bits.length) out.push(bits.join(" · "))
  }
  if (rows.length === 0) out.push("", "No tests were planned for this run.")
  if (results.problems?.length) {
    out.push("", "### Run problems")
    const shown = level >= 3 ? results.problems.slice(0, 20) : results.problems
    for (const p of shown) out.push(`- ${esc(clip(p, 400))}`)
    if (shown.length < results.problems.length) out.push(`- and ${results.problems.length - shown.length} more`)
  }
  if (failed.length) {
    out.push("", "### Failed and not run")
    for (const row of failed) out.push(failedBlock(row, esc, level, shotUrl))
  }
  if (flaky.length) {
    out.push("", "### Flaky (failed, then passed on retry)")
    for (const row of flaky) out.push(level >= 2 ? `- ${rowHeading(row, esc, 120)}` : failedBlock(row, esc, Math.max(level, 1), shotUrl))
  }
  if (quarantined.length) {
    out.push("", "### Known broken (quarantined)")
    for (const row of quarantined) out.push(`- ${rowHeading(row, esc, 120)} — ${esc(row.reason ?? "known broken")}`)
  }
  if (passed.length) {
    out.push("", "### Passed")
    if (level >= 1) out.push(`${passed.length} passed tests are listed in the run's results artifact.`)
    else out.push("<details><summary>" + `${passed.length} passed` + "</summary>", "", ...passed.map((r) => `- ${rowHeading(r, esc, 200)}`), "", "</details>")
  }
  for (const [task, title] of SECTIONS) {
    out.push("", `### ${title}`, rowsSection(rowFiles?.[task], task, esc, level, meta?.setupRunId))
  }
  if (meta?.baseRows?.length) {
    out.push("", "### Fails on base")
    for (const row of meta.baseRows.slice(0, level >= 3 ? 20 : 200)) out.push(`- ${row.level === "warn" ? "⚠️ " : ""}${esc(clip(String(row.text), 400))}`)
  }
  const marker = bindingMarker(meta?.binding)
  if (marker) out.push("", marker)
  return out.join("\n") + "\n"
}

/** @param {{ results: any, scope: any, rowFiles?: Record<string, any>, meta?: any, escape?: (text: string) => string, shotUrl?: ((path: string, row: any, index: number) => string | null) | null, limit?: number }} args */
export function renderComment({ results, scope, rowFiles = {}, meta = null, escape = escapeInline, shotUrl = null, limit = COMMENT_LIMIT }) {
  const input = { results, scope, rowFiles, meta, esc: escape, shotUrl }
  for (let level = 0; level <= 3; level += 1) {
    const body = render(input, level)
    if (body.length <= limit) return { body, level }
  }
  const body = render(input, 3)
  const marker = bindingMarker(meta?.binding)
  const note = `\n_This comment was cut at GitHub's size limit; the full list is in the run's results artifact._\n${marker ? `${marker}\n` : ""}`
  return { body: body.slice(0, limit - note.length) + note, level: 4 }
}
