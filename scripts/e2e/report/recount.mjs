#!/usr/bin/env node
import { existsSync, mkdirSync, readdirSync, statSync, writeFileSync } from "node:fs"
import path from "node:path"
import { fileURLToPath } from "node:url"
import { validateShardPlan } from "../contract/formats.js"
import { readJson } from "./json.mjs"
import { contractIdFromLine } from "./id.mjs"
import { mergeResults } from "./merge.mjs"
import { auditAlwaysRun, validateAlwaysRun } from "./always-run-audit.mjs"
import { renderComment, SECTIONS } from "./comment.mjs"
import { planShots, shotUrl } from "./shots.mjs"

const SHARD_DIR = /^(?:e2e-)?shard-(\d+)$/

export function findShardReports(reportsDir) {
  const out = []
  if (!existsSync(reportsDir)) return out
  for (const name of readdirSync(reportsDir).sort()) {
    const m = SHARD_DIR.exec(name)
    const dir = path.join(reportsDir, name)
    if (!m || !statSync(dir).isDirectory()) continue
    const file = path.join(dir, "report.json")
    out.push({ shard: Number(m[1]), dir, file: existsSync(file) ? file : null })
  }
  return out
}

export function readRowFiles(rowsDir) {
  const out = {}
  for (const [task] of SECTIONS) {
    const file = rowsDir ? path.join(rowsDir, `comment-rows-${task}.json`) : null
    if (!file || !existsSync(file)) continue
    try {
      out[task] = readJson(file)
    } catch (e) {
      out[task] = e instanceof Error ? e : new Error(String(e))
    }
  }
  return out
}

export function scopeOf(plan, summary) {
  const selected = (plan.shards ?? []).reduce((n, s) => n + (s.tests?.length ?? 0), 0)
  if (plan.full_run) return { mode: "full", reason: plan.full_run, selected, total: summary?.scope?.total ?? selected }
  return { mode: "selected", reason: null, selected, total: summary?.scope?.total ?? selected }
}

/** @param {{ plan: any, summary?: any, shardReports: { shard: number, dir: string, file: string | null }[], alwaysRunDoc: any, rowFiles?: Record<string, any>, meta?: any, problems?: string[] }} args @returns {{ results: any, comment: string, level: number, shots: any[] }} */
export function recount({ plan, summary = null, shardReports, alwaysRunDoc, rowFiles = {}, meta = null, problems: given = [] }) {
  const reports = []
  const problems = [...given]
  const valid = validateShardPlan(plan)
  if (!valid.ok) {
    const results = { verdict: "failed", counts: { planned: 0, passed: 0, failed: 0, flaky: 0, notRun: 0, quarantined: 0 }, rows: [], problems: [...problems, ...valid.errors.map((e) => `plan.json: ${e}`)], unplanned: [] }
    const { body, level } = renderComment({ results, scope: { mode: "full", reason: "plan.json is invalid" }, rowFiles, meta })
    return { results, comment: body, level, shots: [] }
  }
  for (const s of shardReports) {
    if (!s.file) {
      problems.push(`shard ${s.shard} uploaded no report.json`)
      continue
    }
    try {
      reports.push({ shard: s.shard, report: readJson(s.file) })
    } catch (e) {
      problems.push(`shard ${s.shard} report.json unreadable: ${e.message}`)
    }
  }
  const results = mergeResults({ plan, reports, quarantineIds: new Set(summary?.quarantined ?? []) })
  const planned = plan.shards.flatMap((s) => s.tests.map((t) => t.id))
  const alwaysRun = validateAlwaysRun(alwaysRunDoc, null)
  const alwaysIds = []
  for (const id of alwaysRun.ids) {
    try {
      alwaysIds.push(contractIdFromLine(id))
    } catch (e) {
      alwaysRun.problems.push(`e2e/always-run.json: ${e.message}`)
    }
  }
  const audit = auditAlwaysRun(alwaysIds, planned)
  results.problems.push(...problems, ...alwaysRun.problems, ...audit.problems)
  if (results.problems.length) results.verdict = "failed"
  const runTag = String(meta?.runTag ?? meta?.setupRunId ?? "run")
  const shardDirs = new Map(shardReports.map((s) => [s.shard, s.dir]))
  const shots = planShots(results.rows, runTag, shardDirs)
  const urlFor = new Map(shots.map((s) => [`${s.id}\u0000${s.reported}`, shotUrl(s.to, meta?.repo)]))
  const { body, level } = renderComment({
    results,
    scope: scopeOf(plan, summary),
    rowFiles,
    meta,
    shotUrl: (p, row) => urlFor.get(`${row.id}\u0000${p}`) ?? null,
  })
  return { results, comment: body, level, shots }
}

function arg(argv, name) {
  const i = argv.indexOf(name)
  return i === -1 ? undefined : argv[i + 1]
}

export function main(argv = process.argv.slice(2)) {
  const planFile = arg(argv, "--plan")
  const reportsDir = arg(argv, "--reports")
  const outDir = arg(argv, "--out")
  if (!planFile || !reportsDir || !outDir) {
    throw new Error("usage: recount.mjs --plan <plan.json> --reports <dir> --out <dir> [--summary <plan-summary.json>] [--rows <dir>] [--always-run f] [--meta <json file>]")
  }
  const metaFile = arg(argv, "--meta")
  const summaryFile = arg(argv, "--summary")
  const { results, comment, shots } = recount({
    plan: readJson(planFile),
    summary: summaryFile && existsSync(summaryFile) ? readJson(summaryFile) : null,
    shardReports: findShardReports(reportsDir),
    alwaysRunDoc: readJson(arg(argv, "--always-run") ?? "e2e/always-run.json"),
    rowFiles: readRowFiles(arg(argv, "--rows")),
    meta: metaFile ? readJson(metaFile) : null,
  })
  mkdirSync(outDir, { recursive: true })
  writeFileSync(path.join(outDir, "results.json"), JSON.stringify(results, null, 2) + "\n")
  writeFileSync(path.join(outDir, "comment.md"), comment)
  writeFileSync(path.join(outDir, "shots.json"), JSON.stringify(shots, null, 2) + "\n")
  writeFileSync(path.join(outDir, "verdict.txt"), results.verdict + "\n")
  console.log(`verdict ${results.verdict}: ${JSON.stringify(results.counts)}; ${results.problems.length} problem(s)`)
  return 0
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  process.exitCode = main()
}
