import { checkId } from "./json.mjs"

export function validateAlwaysRun(doc, catalogueIds) {
  const problems = []
  if (!doc || doc.schemaVersion !== 1 || !Array.isArray(doc.tests)) {
    return { problems: ["e2e/always-run.json: expected {schemaVersion: 1, tests: []}"], ids: [] }
  }
  const known = catalogueIds ? new Set(catalogueIds) : null
  const ids = []
  doc.tests.forEach((e, i) => {
    const where = `e2e/always-run.json tests[${i}]`
    if (!e || typeof e !== "object") return problems.push(`${where}: not an object`)
    if (!checkId(e.id, where, problems)) return
    if (ids.includes(e.id)) problems.push(`${where}: duplicate id ${e.id}`)
    if (typeof e.reason !== "string" || !e.reason.trim()) problems.push(`${where}: reason is required`)
    if (known && !known.has(e.id)) problems.push(`${where}: no such test at head (renamed or removed without a list edit): ${e.id}`)
    ids.push(e.id)
  })
  return { problems, ids }
}

export function auditAlwaysRun(alwaysRunIds, plannedIds) {
  const planned = new Set(plannedIds)
  const missing = alwaysRunIds.filter((id) => !planned.has(id))
  return {
    ok: alwaysRunIds.every((id) => planned.has(id)),
    problems: missing.map((id) => `always-run test missing from the shard plan: ${id}`),
  }
}
