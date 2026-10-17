import { appendFileSync, existsSync, mkdirSync, writeFileSync } from "node:fs"
import { dirname, join } from "node:path"
import { pathToFileURL } from "node:url"

import { FILES } from "../contract/constants.js"
import { validateSetupPlan, validateShardPlan } from "../contract/formats.js"
import type { PlannedTest, SetupPlan, ShardPlan } from "../contract/types.js"
import { readJsonFile } from "../lib/github.js"
import { SEP, TEST_DIR, lineFromContractId } from "../report/id.mjs"

export const FIXTURE_FILE = "fixture.json"
export const FIXTURE_SCREENSHOT = Buffer.from(
  "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8DwHwAFBQIAX8jx0gAAAABJRU5ErkJggg==",
  "base64",
)

export interface FixtureJson {
  case: "pass" | "fail" | "drop" | "no-fan-in"
  fan_in: boolean
}

export type InputsCheck =
  | { ok: true; shards: number[]; fanIn: boolean; live: boolean; bundleSha: string; baseUrl: string }
  | { ok: false; reason: string }

export function checkRunInputs(args: { setupRunId: string; runKey: string; sha: string; run: unknown; plan: unknown; fixture: FixtureJson | null }): InputsCheck {
  const runResult = validateSetupPlan(args.run)
  if (!runResult.ok) return { ok: false, reason: `run.json is invalid: ${runResult.errors[0]}` }
  const planResult = validateShardPlan(args.plan)
  if (!planResult.ok) return { ok: false, reason: `plan.json is invalid: ${planResult.errors[0]}` }
  const run = runResult.value
  const plan = planResult.value
  if (run.setup_run_id !== args.setupRunId) return { ok: false, reason: `plan belongs to setup run ${run.setup_run_id}, not ${args.setupRunId}` }
  if (plan.setup_run_id !== args.setupRunId) return { ok: false, reason: `plan.json belongs to setup run ${plan.setup_run_id}` }
  if (!run.dispatches.some((d) => d.run_key === args.runKey)) return { ok: false, reason: "run_key does not match the setup plan" }
  if (args.sha !== run.pr_sha && !(run.tooling_sha && args.sha === run.tooling_sha)) {
    return { ok: false, reason: `planned sha ${run.pr_sha}${run.tooling_sha ? ` (tooling ${run.tooling_sha})` : ""} is not this run's sha ${args.sha}` }
  }
  if (run.fixture && !args.fixture) return { ok: false, reason: "a fixture run has no fixture.json" }
  if (!run.fixture && args.fixture) return { ok: false, reason: "a live run carries a fixture.json" }
  if (!run.fixture && !run.mail.contained) return { ok: false, reason: "a live run whose mail is not contained is not run" }
  const shards = plan.shards.filter((s) => s.run_key === args.runKey).map((s) => s.index)
  if (!shards.length) return { ok: false, reason: "plan has no shards for this run_key" }
  return { ok: true, shards, fanIn: args.fixture ? args.fixture.fan_in : true, live: !run.fixture, bundleSha: run.pr_sha, baseUrl: run.deployment.url }
}

export function shardTestList(plan: ShardPlan, runKey: string, index: number): string[] {
  const shard = plan.shards.find((s) => s.run_key === runKey && s.index === index)
  if (!shard) throw new Error(`shard ${index} is not in the plan`)
  return shard.tests.map((t) => lineFromContractId(t.id, t.project))
}

function where(test: PlannedTest) {
  const sep = test.id.indexOf("::")
  return { file: test.file.slice(`${TEST_DIR}/`.length), titles: test.id.slice(sep + 2).split(SEP) }
}

type Spec = { title: string; file: string; line: number; column: number; tests: unknown[] }
type Suite = { title: string; file: string; specs: Spec[]; suites: Suite[] }

export function fixtureShardReport(run: SetupPlan, plan: ShardPlan, fixture: FixtureJson, index: number, runKey: string) {
  const shards = plan.shards.filter((s) => s.run_key === runKey)
  const shard = shards.find((s) => s.index === index)
  if (!shard) throw new Error(`shard ${index} is not in the plan`)
  const last = shards[shards.length - 1]
  const tests = fixture.case === "drop" && shard.index === last.index ? shard.tests.slice(0, -1) : shard.tests
  const files = new Map<string, Suite>()
  const shots: string[] = []
  tests.forEach((t, i) => {
    const { file, titles } = where(t)
    if (!files.has(file)) files.set(file, { title: file, file, specs: [], suites: [] })
    let suite = files.get(file)!
    for (const title of titles.slice(0, -1)) {
      let child = suite.suites.find((s) => s.title === title)
      if (!child) {
        child = { title, file, specs: [], suites: [] }
        suite.suites.push(child)
      }
      suite = child
    }
    const failed = fixture.case === "fail" && shard.index === shards[0].index && i === 0
    const shot = `test-results/fixture-${index}-${i}/screenshot-1.png`
    if (failed) shots.push(shot)
    const result = failed
      ? {
          retry: 0,
          status: "failed",
          duration: 1_200,
          errors: [],
          error: { message: 'Error: expect(locator).toHaveText(expected) failed\n\nExpected string: "Approved"\nReceived string: "Pending"' },
          steps: [{ title: "open the page" }, { title: "read status chip", error: { message: "failed" } }],
          attachments: [{ name: "screenshot", contentType: "image/png", path: `/runner/work/repo/${shot}` }],
        }
      : { retry: 0, status: "passed", duration: 1_000, errors: [], steps: [{ title: "open the page" }], attachments: [] }
    suite.specs.push({
      title: titles[titles.length - 1],
      file,
      line: 1,
      column: 1,
      tests: [{ projectName: t.project, projectId: t.project, expectedStatus: "passed", status: failed ? "unexpected" : "expected", results: [result] }],
    })
  })
  return { report: { config: { rootDir: `/runner/work/repo/${TEST_DIR}` }, suites: [...files.values()], stats: {} }, shots, ran: tests.length }
}

const env = (name: string) => {
  const v = process.env[name]
  if (!v) throw new Error(`${name} is not set`)
  return v
}

export async function main(argv: string[]) {
  const [cmd, planDir, outDir] = argv
  const fixtureFile = join(planDir, FIXTURE_FILE)
  const fixture = existsSync(fixtureFile) ? readJsonFile<FixtureJson>(fixtureFile) : null
  const run = readJsonFile<unknown>(join(planDir, FILES.setupPlan))
  const plan = readJsonFile<unknown>(join(planDir, FILES.shardPlan))
  const check = checkRunInputs({ setupRunId: env("SETUP_RUN_ID"), runKey: env("RUN_KEY"), sha: env("GITHUB_SHA"), run, plan, fixture })
  if (!check.ok) throw new Error(check.reason)
  if (cmd === "inputs") {
    appendFileSync(
      env("GITHUB_OUTPUT"),
      `shards=${JSON.stringify(check.shards)}\nfan_in=${check.fanIn}\nlive=${check.live}\nbundle_sha=${check.bundleSha}\nbase_url=${check.baseUrl}\n`,
    )
    return
  }
  if (cmd === "tests") {
    if (!check.live) throw new Error("a fixture run has no Playwright test list")
    const lines = shardTestList(plan as ShardPlan, env("RUN_KEY"), Number(env("SHARD")))
    mkdirSync(dirname(outDir), { recursive: true })
    writeFileSync(outDir, lines.join("\n") + "\n")
    return
  }
  if (cmd === "shard") {
    if (check.live) throw new Error("a live shard runs Playwright, not the fixture reporter")
    const index = Number(env("SHARD"))
    const { report, shots, ran } = fixtureShardReport(run as SetupPlan, plan as ShardPlan, fixture as FixtureJson, index, env("RUN_KEY"))
    mkdirSync(outDir, { recursive: true })
    writeFileSync(join(outDir, "report.json"), JSON.stringify(report, null, 2))
    for (const shot of shots) {
      mkdirSync(join(outDir, shot, ".."), { recursive: true })
      writeFileSync(join(outDir, shot), FIXTURE_SCREENSHOT)
    }
    if (process.env.GITHUB_STEP_SUMMARY) appendFileSync(process.env.GITHUB_STEP_SUMMARY, `Shard ${index}: ran ${ran} fixture test(s).\n`)
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
