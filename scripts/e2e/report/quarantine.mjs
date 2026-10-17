import { checkId } from "./json.mjs"

const KEY = /^[a-z0-9][a-z0-9-]{1,63}$/
const DATE = /^\d{4}-\d{2}-\d{2}$/

export function validateQuarantine(doc, catalogueIds) {
  const problems = []
  if (!doc || doc.schemaVersion !== 1 || !Array.isArray(doc.entries)) {
    return { problems: ["e2e/quarantine.json: expected {schemaVersion: 1, entries: []}"], ids: new Set() }
  }
  const known = catalogueIds ? new Set(catalogueIds) : null
  const ids = new Set()
  const keys = new Set()
  doc.entries.forEach((e, i) => {
    const where = `e2e/quarantine.json entries[${i}]`
    if (!e || typeof e !== "object") return problems.push(`${where}: not an object`)
    if (!checkId(e.id, where, problems)) return
    if (ids.has(e.id)) problems.push(`${where}: duplicate id ${e.id}`)
    if (typeof e.key !== "string" || !KEY.test(e.key)) problems.push(`${where}: key must match ${KEY}`)
    else if (keys.has(e.key)) problems.push(`${where}: duplicate key ${e.key}`)
    if (typeof e.reason !== "string" || !e.reason.trim()) problems.push(`${where}: reason is required`)
    if (typeof e.added !== "string" || !DATE.test(e.added)) problems.push(`${where}: added must be YYYY-MM-DD`)
    if (known && !known.has(e.id)) problems.push(`${where}: stale id, no such test at head: ${e.id}`)
    ids.add(e.id)
    if (typeof e.key === "string") keys.add(e.key)
  })
  return { problems, ids }
}
