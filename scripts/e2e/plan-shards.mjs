#!/usr/bin/env node
import { existsSync, mkdirSync, writeFileSync } from "node:fs"
import path from "node:path"
import { fileURLToPath } from "node:url"
import { validateShardPlan } from "./contract/formats.js"
import { CONTRACT_VERSION } from "./contract/constants.js"
import { catalogueFromList, weigher, packTestIds } from "./report/id.mjs"
import { readJson } from "./report/json.mjs"
import { validateQuarantine } from "./report/quarantine.mjs"
import { validateAlwaysRun } from "./report/always-run-audit.mjs"

export const SHARD_CAP = 16
export const SHARD_BUDGET_MS = 180_000
export const OVERHEAD_CAP_MS = 150_000
export const DEFAULT_OVERHEAD_MS = 60_000

export function shardCount({ selected, predictedMs, overheadMs, cap = SHARD_CAP }) {
  if (selected === 0) return 0
  if (overheadMs >= OVERHEAD_CAP_MS) return Math.min(cap, selected)
  const byTime = Math.max(1, Math.ceil(predictedMs / (SHARD_BUDGET_MS - overheadMs)))
  return Math.min(cap, selected, byTime)
}

export function readSelection(doc, catalogueIds) {
  if (doc === undefined) return { fullRun: "selection missing" }
  const valid =
    doc &&
    typeof doc === "object" &&
    !Array.isArray(doc) &&
    (doc.mode === "full" || doc.mode === "select") &&
    (doc.fullRun === null || doc.fullRun === undefined || typeof doc.fullRun === "string") &&
    Array.isArray(doc.tests) &&
    doc.tests.every((t) => t && typeof t.id === "string") &&
    (doc.alwaysRun === undefined || (Array.isArray(doc.alwaysRun) && doc.alwaysRun.every((id) => typeof id === "string")))
  if (!valid) return { fullRun: "selection schema failure" }
  if (typeof doc.fullRun === "string" && doc.fullRun.trim()) return { fullRun: doc.fullRun }
  if (doc.mode === "full") return { fullRun: "selection chose a full run" }
  const known = new Set(catalogueIds)
  const ids = [...doc.tests.map((t) => t.id), ...(doc.alwaysRun ?? [])]
  const unknown = ids.find((id) => !known.has(id))
  if (unknown) return { fullRun: `selection names a test that does not exist: ${unknown}` }
  return { fullRun: null, ids }
}

/** @param {{ catalogue: any[], selection?: any, selectMode?: string, durations?: Record<string, number>, alwaysRunIds?: string[], quarantineIds?: string[], overheadMs?: number, forceFullReason?: string | null, cap?: number }} args */
export function planShards({
  catalogue,
  selection,
  selectMode,
  durations = {},
  alwaysRunIds = [],
  quarantineIds = [],
  overheadMs = DEFAULT_OVERHEAD_MS,
  forceFullReason = null,
  cap = SHARD_CAP,
}) {
  const all = catalogue.map((t) => t.id)
  if (all.length === 0) throw new Error("the catalogue is empty: playwright --list found no tests")
  let fullRun
  let chosen
  if (forceFullReason) fullRun = forceFullReason
  else if (selectMode !== "select") fullRun = "selection not live yet"
  else {
    const sel = readSelection(selection, all)
    fullRun = sel.fullRun
    chosen = sel.ids
  }
  const ids = fullRun ? all : [...new Set([...chosen, ...alwaysRunIds])].sort()
  const projectOf = new Map(catalogue.map((t) => [t.id, t.project]))
  const { weights, unknown } = weigher(durations, ids, (id) => projectOf.get(id))
  const predictedMs = ids.reduce((sum, id) => sum + weights.get(id), 0)
  const count = shardCount({ selected: ids.length, predictedMs, overheadMs, cap })
  const { bins, loads } = count ? packTestIds(ids, weights, count) : { bins: [], loads: [] }
  const kindOf = new Map(catalogue.map((t) => [t.id, t.kind]))
  const countsByKind = { functional: 0, screen: 0, snapshot: 0 }
  for (const id of ids) countsByKind[kindOf.get(id) ?? "functional"] += 1
  const quarantined = new Set(quarantineIds)
  return {
    schemaVersion: 1,
    selectMode: selectMode === "select" ? "select" : "full",
    scope: fullRun
      ? { mode: "full", reason: fullRun, selected: ids.length, total: all.length }
      : { mode: "selected", reason: null, selected: ids.length, total: all.length },
    countsByKind,
    predictedMs: Math.round(predictedMs),
    overheadMs,
    unknownTimings: unknown.length,
    alwaysRun: [...alwaysRunIds].sort(),
    quarantined: ids.filter((id) => quarantined.has(id)),
    shards: bins.map((shardIds, i) => ({ shard: i + 1, ids: [...shardIds].sort(), predictedMs: Math.round(loads[i]) })),
    testMs: Object.fromEntries(ids.map((id) => [id, Math.round(weights.get(id))])),
  }
}

/** @param {any} plan @param {any[]} catalogue @param {{ setupRunId: string, runKey: string }} ids */
export function shardPlanDoc(plan, catalogue, { setupRunId, runKey }) {
  const byId = new Map(catalogue.map((t) => [t.id, t]))
  return {
    schema_version: CONTRACT_VERSION,
    setup_run_id: String(setupRunId),
    select_mode: plan.selectMode === "select" ? "select" : "full",
    full_run: plan.scope.mode === "full" ? plan.scope.reason : null,
    shards: plan.shards.map((s) => ({
      run_key: runKey,
      index: s.shard,
      predicted_ms: s.predictedMs,
      tests: s.ids.map((id) => {
        const t = byId.get(id)
        if (!t) throw new Error(`planned test ${id} is not in the catalogue`)
        return { id, kind: t.kind, file: t.file, project: t.project, predicted_ms: plan.testMs[id] ?? 0 }
      }),
    })),
  }
}

export function planSummary(plan) {
  const { shards, testMs: _testMs, ...rest } = plan
  return { ...rest, shards: shards.map((s) => ({ shard: s.shard, tests: s.ids.length, predictedMs: s.predictedMs })) }
}

function arg(argv, name) {
  const i = argv.indexOf(name)
  return i === -1 ? undefined : argv[i + 1]
}

/** @param {string[]} [argv] @param {Record<string, string | undefined>} [env] */
export function main(argv = process.argv.slice(2), env = process.env) {
  const listFile = arg(argv, "--list")
  const outDir = arg(argv, "--out-dir")
  const setupRunId = arg(argv, "--setup-run-id")
  const runKey = arg(argv, "--run-key")
  if (!listFile || !outDir || !setupRunId || !runKey) {
    throw new Error("usage: plan-shards.mjs --list <list.json> --out-dir <dir> --setup-run-id <id> --run-key <key> [--selection f] [--timings f] [--quarantine f] [--always-run f] [--overhead-ms n] [--full-reason text]")
  }
  const catalogue = catalogueFromList(readJson(listFile))
  const ids = catalogue.map((t) => t.id)
  const problems = []
  const quarantine = validateQuarantine(readJson(arg(argv, "--quarantine") ?? "e2e/quarantine.json"), ids)
  const alwaysRun = validateAlwaysRun(readJson(arg(argv, "--always-run") ?? "e2e/always-run.json"), ids)
  problems.push(...quarantine.problems, ...alwaysRun.problems)
  if (problems.length) {
    for (const p of problems) console.error(p)
    return 1
  }
  const selectionFile = arg(argv, "--selection")
  let selection
  if (selectionFile && existsSync(selectionFile)) {
    try {
      selection = readJson(selectionFile)
    } catch {
      selection = null
    }
  }
  const timingsFile = arg(argv, "--timings") ?? "e2e/test-timings.json"
  const durations = existsSync(timingsFile) ? readJson(timingsFile).durations ?? {} : {}
  const overhead = arg(argv, "--overhead-ms")
  const plan = planShards({
    catalogue,
    selection,
    selectMode: env.E2E_SELECT_MODE,
    durations,
    alwaysRunIds: alwaysRun.ids,
    quarantineIds: [...quarantine.ids],
    overheadMs: overhead === undefined ? DEFAULT_OVERHEAD_MS : Number(overhead),
    forceFullReason: arg(argv, "--full-reason") ?? null,
  })
  if (plan.shards.length === 0) {
    console.error("nothing to run: the plan has no tests")
    return 1
  }
  const doc = shardPlanDoc(plan, catalogue, { setupRunId, runKey })
  const valid = validateShardPlan(doc)
  if (!valid.ok) {
    for (const e of valid.errors) console.error(`plan.json: ${e}`)
    return 1
  }
  const lineOf = new Map(catalogue.map((t) => [t.id, t.listLine]))
  mkdirSync(outDir, { recursive: true })
  writeFileSync(path.join(outDir, "plan.json"), JSON.stringify(doc, null, 2) + "\n")
  writeFileSync(path.join(outDir, "plan-summary.json"), JSON.stringify(planSummary(plan), null, 2) + "\n")
  for (const shard of plan.shards) {
    writeFileSync(path.join(outDir, `shard-${shard.shard}.txt`), shard.ids.map((id) => lineOf.get(id)).join("\n") + "\n")
  }
  const line = plan.scope.mode === "full" ? `Full run: ${plan.scope.reason}` : `Selected run: ${plan.scope.selected} of ${plan.scope.total}`
  console.log(`${line}; ${plan.shards.length} shard(s); predicted ${Math.round(plan.predictedMs / 1000)} s; ${plan.unknownTimings} test(s) without a recorded time`)
  return 0
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  process.exitCode = main()
}
