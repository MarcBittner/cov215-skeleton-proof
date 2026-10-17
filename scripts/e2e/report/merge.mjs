import { walkReport } from "./id.mjs"
import { classifyAttempts, finalAttempt } from "./flaky.mjs"

const ANSI = /\u001b\[[0-9;]*[A-Za-z]/g
const MAX_ERROR_LINES = 12

export function stripAnsi(text) {
  return String(text ?? "").replace(ANSI, "")
}

export function errorSummary(error) {
  if (!error) return null
  const message = stripAnsi(error.message ?? error.value ?? "")
  const lines = []
  for (const line of message.split("\n")) {
    if (/^\s*(>?\s*\d+ \||\|)/.test(line) || /^\s+at /.test(line)) break
    lines.push(line)
  }
  while (lines.length && !lines[lines.length - 1].trim()) lines.pop()
  return lines.slice(0, MAX_ERROR_LINES).join("\n")
}

export function expectedActual(message) {
  let expected = null
  let actual = null
  const minus = []
  const plus = []
  for (const line of stripAnsi(message).split("\n")) {
    const e = /^\s*Expected(?: [a-z]+)?:\s?(.*)$/.exec(line)
    const r = /^\s*Received(?: [a-z]+)?:\s?(.*)$/.exec(line)
    if (e && expected === null) expected = e[1]
    if (r && actual === null) actual = r[1]
    if (/^- Expected\b/.test(line) || /^\+ Received\b/.test(line)) continue
    const d = /^([-+])\s+(.*\S)\s*$/.exec(line)
    if (d) (d[1] === "-" ? minus : plus).push(d[2])
  }
  if (expected === null && actual === null && (minus.length || plus.length)) {
    expected = minus.join(" ")
    actual = plus.join(" ")
  }
  return { expected, actual }
}

export function flattenSteps(steps, depth = 0, out = []) {
  for (const step of steps ?? []) {
    out.push({ title: step.title, depth, failed: Boolean(step.error) })
    flattenSteps(step.steps, depth + 1, out)
  }
  return out
}

function screenshotsOf(result) {
  return (result?.attachments ?? [])
    .filter((a) => a.name === "screenshot" && typeof a.path === "string" && /^image\//.test(a.contentType ?? ""))
    .map((a) => a.path)
}

function detailOf(test, status) {
  const results = [...(test.results ?? [])].sort((a, b) => (a.retry ?? 0) - (b.retry ?? 0))
  const final = finalAttempt(test)
  const source = status === "flaky" ? results.find((r) => r.status !== (test.expectedStatus ?? "passed")) ?? final : final
  const error = source?.error ?? source?.errors?.[0] ?? null
  const summary = errorSummary(error)
  const { expected, actual } = summary ? expectedActual(error.message ?? "") : { expected: null, actual: null }
  return {
    durationMs: final?.duration ?? 0,
    error: summary,
    expected,
    actual,
    steps: flattenSteps(source?.steps),
    screenshots: [...new Set([...screenshotsOf(source), ...screenshotsOf(final)])],
  }
}

/** @param {{ plan: any, reports: { shard: number | null, report: any }[], quarantineIds?: Set<string> }} args @returns {{ verdict: string, counts: Record<string, number>, aiCounts?: Record<string, number>, rows: any[], problems: string[], unplanned: string[] }} */
export function mergeResults({ plan, reports, quarantineIds = new Set() }) {
  const problems = []
  const planned = new Map()
  for (const shard of plan.shards ?? []) {
    for (const t of shard.tests ?? []) {
      if (planned.has(t.id)) problems.push(`plan lists ${t.id} in more than one shard`)
      planned.set(t.id, { shard: shard.index, project: t.project, file: t.file, ai: shard.role === "ai" })
    }
  }
  const seen = new Map()
  const unplanned = []
  for (const { shard, report } of reports) {
    let entries
    try {
      entries = [...walkReport(report)]
    } catch (e) {
      problems.push(`shard ${shard ?? "?"} report unreadable: ${e.message}`)
      continue
    }
    for (const entry of entries) {
      const id = entry.contractId
      const want = planned.get(id)
      if (!want || want.project !== entry.project) {
        unplanned.push(entry.id)
        continue
      }
      if (shard != null && want.shard !== shard) {
        problems.push(`result for ${id} came from shard ${shard}, planned in shard ${want.shard}`)
      }
      if (!seen.has(id)) seen.set(id, [])
      seen.get(id).push({ ...entry, shard })
    }
  }
  const rows = []
  for (const [id, { shard, project, file, ai }] of planned) {
    const got = seen.get(id) ?? []
    const quarantined = quarantineIds.has(id)
    const tag = ai ? { ai: true } : {}
    if (got.length === 0) {
      problems.push(`planned test has no result: ${id}`)
      rows.push({ id, shard, project, file, ...tag, status: "not-run", reason: "no result", quarantined, attempts: 0 })
      continue
    }
    if (got.length > 1) {
      problems.push(`duplicate result for ${id} (${got.length} results)`)
      rows.push({ id, shard, project, file, ...tag, status: "failed", reason: "duplicate result", quarantined, attempts: 0 })
      continue
    }
    const { test, titles } = got[0]
    const { status, attempts } = classifyAttempts(test)
    const base = { id, shard, project, file, ...tag, titles, attempts, quarantined }
    if (status === "not-run") {
      problems.push(`planned test has no attempt: ${id}`)
      rows.push({ ...base, status: "not-run", reason: "no attempt" })
    } else if (status === "skipped") {
      if (quarantined) rows.push({ ...base, status: "quarantined", reason: "known broken" })
      else {
        problems.push(`skipped without a quarantine entry: ${id}`)
        rows.push({ ...base, status: "not-run", reason: "skipped without a quarantine entry" })
      }
    } else if (quarantined && status === "failed") {
      rows.push({ ...base, ...detailOf(test, status), status: "quarantined", reason: "known broken, failed" })
    } else {
      rows.push({ ...base, ...detailOf(test, status), status })
    }
  }
  rows.sort((a, b) => (a.id < b.id ? -1 : a.id > b.id ? 1 : 0))
  const counts = countRows(rows.filter((r) => !r.ai))
  const aiRows = rows.filter((r) => r.ai)
  const aiCounts = aiRows.length ? countRows(aiRows) : null
  const verdict = problems.length || counts.failed || counts.notRun || aiCounts?.failed || aiCounts?.notRun ? "failed" : "passed"
  return { verdict, counts, ...(aiCounts ? { aiCounts } : {}), rows, problems, unplanned: [...new Set(unplanned)].sort() }
}

export function countRows(rows) {
  const counts = { planned: rows.length, passed: 0, failed: 0, flaky: 0, notRun: 0, quarantined: 0 }
  for (const row of rows) {
    if (row.status === "passed") counts.passed += 1
    else if (row.status === "failed") counts.failed += 1
    else if (row.status === "flaky") counts.flaky += 1
    else if (row.status === "not-run") counts.notRun += 1
    else if (row.status === "quarantined") counts.quarantined += 1
  }
  return counts
}
