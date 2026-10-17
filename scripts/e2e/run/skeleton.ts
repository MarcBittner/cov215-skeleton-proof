import { appendFileSync, mkdirSync, readFileSync, writeFileSync } from "node:fs"
import { join } from "node:path"
import { pathToFileURL } from "node:url"

interface RunJson {
  run_id: string
  run_key: string
  mode: "fixture" | "live"
  fixture_case: "pass" | "fail" | "drop" | "no-fan-in" | null
  fan_in: boolean
  pr_sha: string
}

interface PlanJson {
  shards: { index: number; tests: string[] }[]
}

interface TestResult {
  id: string
  status: "passed" | "failed" | "skipped"
}

export type InputsCheck = { ok: true; shards: number[]; fanIn: boolean } | { ok: false; reason: string }

export function checkRunInputs(args: { setupRunId: string; runKey: string; sha: string; run: RunJson; plan: PlanJson }): InputsCheck {
  const { setupRunId, runKey, sha, run, plan } = args
  if (run.run_id !== setupRunId) return { ok: false, reason: `plan belongs to setup run ${run.run_id}, not ${setupRunId}` }
  if (!run.run_key || run.run_key !== runKey) return { ok: false, reason: "run_key does not match the setup plan" }
  if (run.pr_sha !== sha) return { ok: false, reason: `planned sha ${run.pr_sha} is not this run's sha ${sha}` }
  if (run.mode !== "fixture") return { ok: false, reason: "live runs are not built yet" }
  if (!plan.shards.length) return { ok: false, reason: "plan has no shards" }
  return { ok: true, shards: plan.shards.map((s) => s.index), fanIn: run.fan_in }
}

export function fixtureShardResults(run: RunJson, plan: PlanJson, index: number): TestResult[] {
  const shard = plan.shards.find((s) => s.index === index)
  if (!shard) throw new Error(`shard ${index} is not in the plan`)
  const last = plan.shards[plan.shards.length - 1]
  const tests = run.fixture_case === "drop" && shard.index === last.index ? shard.tests.slice(0, -1) : shard.tests
  return tests.map((id, i) => ({
    id,
    status: run.fixture_case === "fail" && shard.index === plan.shards[0].index && i === 0 ? "failed" : "passed",
  }))
}

const env = (name: string) => {
  const v = process.env[name]
  if (!v) throw new Error(`${name} is not set`)
  return v
}

const readJson = <T>(path: string): T => JSON.parse(readFileSync(path, "utf8")) as T

export async function main(argv: string[]) {
  const [cmd, planDir, outDir] = argv
  const run = readJson<RunJson>(join(planDir, "run.json"))
  const plan = readJson<PlanJson>(join(planDir, "plan.json"))
  if (cmd === "inputs") {
    const check = checkRunInputs({ setupRunId: env("SETUP_RUN_ID"), runKey: env("RUN_KEY"), sha: env("GITHUB_SHA"), run, plan })
    if (!check.ok) throw new Error(check.reason)
    appendFileSync(env("GITHUB_OUTPUT"), `shards=${JSON.stringify(check.shards)}\nfan_in=${check.fanIn}\n`)
    return
  }
  if (cmd === "shard") {
    const index = Number(env("SHARD"))
    const results = fixtureShardResults(run, plan, index)
    mkdirSync(outDir, { recursive: true })
    writeFileSync(join(outDir, `shard-${index}.json`), JSON.stringify({ shard: index, results }, null, 2))
    if (process.env.GITHUB_STEP_SUMMARY) {
      appendFileSync(process.env.GITHUB_STEP_SUMMARY, `Shard ${index}: ${results.map((r) => `${r.status} \`${r.id}\``).join(", ")}\n`)
    }
    return
  }
  throw new Error(`unknown command "${cmd}"`)
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  main(process.argv.slice(2)).catch((err: unknown) => {
    console.error(err instanceof Error ? err.message : err)
    process.exit(1)
  })
}
