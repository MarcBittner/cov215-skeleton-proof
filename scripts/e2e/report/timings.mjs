#!/usr/bin/env node
import { writeFileSync } from "node:fs"
import path from "node:path"
import { fileURLToPath } from "node:url"
import { walkReport, catalogueFromList } from "./id.mjs"
import { finalAttempt } from "./flaky.mjs"
import { readJson } from "./json.mjs"

/** @returns {Map<string, number>} */
export function finalDurations(report) {
  const out = new Map()
  for (const { id, test } of walkReport(report)) {
    const last = finalAttempt(test)
    if (!last || last.status === "skipped" || typeof last.duration !== "number") continue
    out.set(id, last.duration)
  }
  return out
}

/** @param {{ catalogueIds: string[], runs: any[], previous?: Record<string, number> }} args @returns {{ schemaVersion: number, durations: Record<string, number> }} */
export function buildTimings({ catalogueIds, runs, previous = {} }) {
  const samples = new Map()
  for (const run of runs) {
    for (const [id, ms] of finalDurations(run)) {
      if (!samples.has(id)) samples.set(id, [])
      samples.get(id).push(ms)
    }
  }
  const durations = {}
  for (const id of [...catalogueIds].sort()) {
    const s = samples.get(id)
    if (s && s.length) durations[id] = Math.round(s.reduce((a, b) => a + b, 0) / s.length)
    else if (typeof previous[id] === "number") durations[id] = previous[id]
  }
  return { schemaVersion: 1, durations }
}

export function main(argv = process.argv.slice(2)) {
  const i = argv.indexOf("--list")
  const o = argv.indexOf("--out")
  if (i === -1 || o === -1) throw new Error("usage: timings.mjs --list <list.json> --out e2e/test-timings.json <report.json>...")
  const listFile = argv[i + 1]
  const outFile = argv[o + 1]
  const reports = argv.filter((_, k) => k !== i && k !== i + 1 && k !== o && k !== o + 1)
  const catalogueIds = catalogueFromList(readJson(listFile)).map((t) => t.id)
  let previous = {}
  try {
    previous = readJson(outFile).durations ?? {}
  } catch {
    previous = {}
  }
  const doc = buildTimings({ catalogueIds, runs: reports.map(readJson), previous })
  writeFileSync(outFile, JSON.stringify(doc, null, 2) + "\n")
  const n = Object.keys(doc.durations).length
  console.log(`${n} of ${catalogueIds.length} --list tests have a timing`)
  return 0
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  process.exitCode = main()
}
