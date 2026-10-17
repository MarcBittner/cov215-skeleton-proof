export function classifyAttempts(test) {
  const results = [...(test.results ?? [])].sort((a, b) => (a.retry ?? 0) - (b.retry ?? 0))
  if (results.length === 0) return { status: "not-run", attempts: 0 }
  const expected = test.expectedStatus ?? "passed"
  const ok = (r) => r.status === expected
  const final = results[results.length - 1]
  if (results.every((r) => r.status === "skipped")) return { status: "skipped", attempts: results.length }
  if (ok(final)) {
    const earlierBad = results.slice(0, -1).some((r) => !ok(r) && r.status !== "skipped")
    return { status: earlierBad ? "flaky" : "passed", attempts: results.length }
  }
  return { status: "failed", attempts: results.length }
}

export function finalAttempt(test) {
  const results = [...(test.results ?? [])].sort((a, b) => (a.retry ?? 0) - (b.retry ?? 0))
  return results.length ? results[results.length - 1] : null
}
