#!/usr/bin/env node
import path from "node:path"
import { fileURLToPath } from "node:url"
import { readJson } from "./json.mjs"

export const MIN_FLAKY = 2
export const MIN_RATE = 0.1
export const MIN_RUNS = 5

export function flakeRates(resultsDocs) {
  const stats = new Map()
  for (const doc of resultsDocs) {
    for (const row of doc.rows ?? []) {
      if (!["passed", "failed", "flaky"].includes(row.status)) continue
      if (!stats.has(row.id)) stats.set(row.id, { id: row.id, runs: 0, flaky: 0, failed: 0 })
      const s = stats.get(row.id)
      s.runs += 1
      if (row.status === "flaky") s.flaky += 1
      if (row.status === "failed") s.failed += 1
    }
  }
  return [...stats.values()].map((s) => ({ ...s, rate: s.runs ? s.flaky / s.runs : 0 })).sort((a, b) => b.rate - a.rate || (a.id < b.id ? -1 : 1))
}

export function proposeQuarantine(resultsDocs, quarantineIds = new Set(), today = new Date().toISOString().slice(0, 10)) {
  return flakeRates(resultsDocs)
    .filter((s) => !quarantineIds.has(s.id))
    .filter((s) => s.flaky >= MIN_FLAKY || (s.runs >= MIN_RUNS && s.rate >= MIN_RATE))
    .map((s) => ({
      id: s.id,
      key: `flaky-${today}-${Math.abs(hash(s.id)).toString(36).slice(0, 6)}`,
      reason: `flaky in ${s.flaky} of ${s.runs} runs this week`,
      added: today,
    }))
}

function hash(text) {
  let h = 0
  for (let i = 0; i < text.length; i += 1) h = (h * 31 + text.charCodeAt(i)) | 0
  return h
}

export function main(argv = process.argv.slice(2)) {
  const q = argv.indexOf("--quarantine")
  const quarantineFile = q === -1 ? "e2e/quarantine.json" : argv[q + 1]
  const files = argv.filter((_, k) => q === -1 || (k !== q && k !== q + 1))
  const quarantineIds = new Set((readJson(quarantineFile).entries ?? []).map((e) => e.id))
  const proposals = proposeQuarantine(files.map(readJson), quarantineIds)
  console.log(`## Flake rate over ${files.length} run(s)`)
  if (!proposals.length) console.log("No test crossed the flake threshold.")
  else {
    console.log("Proposed `e2e/quarantine.json` entries (a person adds them by PR):")
    console.log("```json")
    console.log(JSON.stringify(proposals, null, 2))
    console.log("```")
  }
  return 0
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  process.exitCode = main()
}
