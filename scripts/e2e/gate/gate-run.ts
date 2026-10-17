import fs from "fs"
import path from "path"
import { pathToFileURL } from "url"
import { createHash, randomBytes } from "crypto"
import { INJECTED_BREAKS } from "../contract/constants.js"
import type { GateEntry, InjectedBreak } from "../contract/types.js"
import { checkDraftSpec, sourceStates, type DraftCheckResult, type SourceCheck } from "./checker.js"

export const GATE_BRANCH_PREFIX = "e2e/gate/"
export const DRAFT_SPEC_DIR = "e2e/drafts"

const GAP_ID = /^[a-z0-9][a-z0-9-]{0,62}$/
const SHA256 = /^[0-9a-f]{64}$/

export type GateRef = GateEntry

export function assertInjectedBreak(value: unknown): InjectedBreak | null {
  if (value === null) return null
  if (typeof value === "string" && (INJECTED_BREAKS as readonly string[]).includes(value)) return value as InjectedBreak
  throw new Error(`gate break must be null or one of ${INJECTED_BREAKS.join(", ")}; got ${JSON.stringify(value)}`)
}

export function specSha256(spec: string | Uint8Array): string {
  return createHash("sha256").update(spec).digest("hex")
}

export function parseGateBranch(ref: string): { gapId: string; attempt: number } | null {
  if (!ref.startsWith(GATE_BRANCH_PREFIX)) return null
  const m = /^([a-z0-9][a-z0-9-]{0,62})-([1-9][0-9]?)$/.exec(ref.slice(GATE_BRANCH_PREFIX.length))
  if (!m || !GAP_ID.test(m[1])) return null
  return { gapId: m[1], attempt: Number(m[2]) }
}

export function draftSpecPath(gapId: string): string {
  if (!GAP_ID.test(gapId)) throw new Error(`invalid gap id "${gapId}"`)
  return `${DRAFT_SPEC_DIR}/${gapId}.spec.ts`
}

export function assertGateRef(gate: unknown): GateRef {
  if (!gate || typeof gate !== "object") throw new Error("plan has no gate entry")
  const g = gate as Record<string, unknown>
  const parsed = typeof g.ref === "string" ? parseGateBranch(g.ref) : null
  if (typeof g.ref !== "string" || !parsed) {
    throw new Error(`gate ref must be ${GATE_BRANCH_PREFIX}<gapId>-<n>`)
  }
  const expected = draftSpecPath(parsed.gapId)
  if (g.path !== expected) throw new Error(`gate path must be ${expected}`)
  if (typeof g.sha256 !== "string" || !SHA256.test(g.sha256)) {
    throw new Error("gate sha256 must be 64 lowercase hex characters")
  }
  if (!("break" in g)) throw new Error("gate entry has no break; use null for a clean run")
  return { ref: g.ref, path: expected, sha256: g.sha256, break: assertInjectedBreak(g.break) }
}

export interface GateRunPlan {
  kind: "gate"
  gate: GateRef
  run_key?: string
  pr_sha?: string
  tooling_sha?: string
}

export function assertGateRunPlan(run: unknown): GateRunPlan {
  if (!run || typeof run !== "object") throw new Error("run.json is not an object")
  const r = run as Record<string, unknown>
  if (r.kind !== "gate") throw new Error(`run kind is ${String(r.kind)}, not gate`)
  const gate = assertGateRef(r.gate)
  const out: GateRunPlan = { kind: "gate", gate }
  if (r.run_key !== undefined) {
    if (typeof r.run_key !== "string") throw new Error("run_key must be a string")
    out.run_key = r.run_key
  }
  if (r.pr_sha !== undefined && r.pr_sha !== null) {
    if (typeof r.pr_sha !== "string") throw new Error("pr_sha must be a string")
    out.pr_sha = r.pr_sha
  }
  if (r.tooling_sha !== undefined && r.tooling_sha !== null) {
    if (typeof r.tooling_sha !== "string") throw new Error("tooling_sha must be a string")
    out.tooling_sha = r.tooling_sha
  }
  return out
}

export type GateSpecCheck =
  | { ok: true; gapId: string; path: string; sha256: string; break: InjectedBreak | null }
  | { ok: false; reason: string; path?: string; sha256?: string }

export function verifyGateSpec(opts: {
  run: unknown
  checkoutRef: string
  checkoutSha?: string
  runKey?: string
  readSpec: (path: string) => string | Uint8Array | null
}): GateSpecCheck {
  let plan: GateRunPlan
  try {
    plan = assertGateRunPlan(opts.run)
  } catch (e) {
    return { ok: false, reason: (e as Error).message }
  }
  const parsed = parseGateBranch(plan.gate.ref)
  if (!parsed) return { ok: false, reason: "gate ref is not a gate branch" }
  if (opts.checkoutRef !== plan.gate.ref) {
    return { ok: false, reason: `checkout ref ${opts.checkoutRef} differs from the planned ${plan.gate.ref}` }
  }
  if (plan.run_key !== undefined && opts.runKey !== plan.run_key) {
    return { ok: false, reason: "run_key differs from setup's plan" }
  }
  if (plan.pr_sha && opts.checkoutSha !== plan.pr_sha && !(plan.tooling_sha && opts.checkoutSha === plan.tooling_sha)) {
    return { ok: false, reason: `checkout ${opts.checkoutSha ?? "unknown"} differs from the planned commit ${plan.pr_sha}${plan.tooling_sha ? ` and its marker ${plan.tooling_sha}` : ""}` }
  }
  const specPath = draftSpecPath(parsed.gapId)
  const spec = opts.readSpec(specPath)
  if (spec === null) return { ok: false, reason: `${specPath} is missing from the checkout`, path: specPath }
  const sha256 = specSha256(spec)
  if (sha256 !== plan.gate.sha256) {
    return { ok: false, reason: `spec sha256 ${sha256} differs from the planned ${plan.gate.sha256}`, path: specPath, sha256 }
  }
  return { ok: true, gapId: parsed.gapId, path: specPath, sha256, break: plan.gate.break }
}

export interface GateCheckRecord {
  ok: boolean
  ref: string
  gapId: string | null
  path: string | null
  sha256: string | null
  break: InjectedBreak | null
  transport: GateSpecCheck
  checker: DraftCheckResult | null
}

export interface GateCheckEnv {
  runJsonPath: string
  checkoutRef: string
  checkoutSha?: string
  runKey?: string
  root: string
  previewUrl?: string
  convexUrl?: string
}

function readSpecUnder(root: string) {
  return (rel: string): string | null => {
    const abs = path.resolve(root, rel)
    if (!abs.startsWith(path.resolve(root) + path.sep)) return null
    try {
      const st = fs.lstatSync(abs)
      if (!st.isFile()) return null
      return fs.readFileSync(abs, "utf8")
    } catch {
      return null
    }
  }
}

function sourceExistsUnder(root: string): SourceCheck {
  return (file, line, needles, endLine = line) => {
    const text = readSpecUnder(root)(file)
    return text !== null && sourceStates(text, line, endLine, needles)
  }
}

export function runGateCheck(env: GateCheckEnv): GateCheckRecord {
  let run: unknown
  try {
    run = JSON.parse(fs.readFileSync(env.runJsonPath, "utf8"))
  } catch (e) {
    run = { error: (e as Error).message }
  }
  const read = readSpecUnder(env.root)
  const transport = verifyGateSpec({
    run,
    checkoutRef: env.checkoutRef,
    checkoutSha: env.checkoutSha,
    runKey: env.runKey,
    readSpec: read,
  })
  if (!transport.ok) {
    return {
      ok: false,
      ref: env.checkoutRef,
      gapId: null,
      path: transport.path ?? null,
      sha256: transport.sha256 ?? null,
      break: null,
      transport,
      checker: null,
    }
  }
  const checker = checkDraftSpec(read(transport.path) ?? "", {
    path: transport.path,
    gapId: transport.gapId,
    previewHost: env.previewUrl,
    convexHost: env.convexUrl,
    sourceExists: sourceExistsUnder(env.root),
  })
  return {
    ok: checker.ok,
    ref: env.checkoutRef,
    gapId: transport.gapId,
    path: transport.path,
    sha256: transport.sha256,
    break: transport.break,
    transport,
    checker,
  }
}

export type GateRunStatus = "passed" | "failed" | "timedOut" | "interrupted" | "skipped"

export interface GateRunResult {
  sha256: string
  deployment: string
  passed: boolean
  injectedBreak: InjectedBreak | null
  status?: GateRunStatus
  failedLines?: number[]
  breakAnnotation?: string | null
}

export interface BreakEffect {
  kind: InjectedBreak
  targets: string[]
  armedContexts: number
  dropped: string[]
  altered: string[]
}

export type GateVerdict =
  | { verdict: "offer"; sha256: string }
  | { verdict: "failing"; sha256: string; line: number; reasons: string[] }
  | { verdict: "rejected" | "flaky" | "incomplete"; sha256: string; reasons: string[] }

export const REQUIRED_CLEAN_PASSES = 3

const strings = (v: unknown): v is string[] => Array.isArray(v) && v.every((x) => typeof x === "string")

export function parseBreakAnnotation(description: string | null | undefined): BreakEffect | null {
  if (!description) return null
  let v: unknown
  try {
    v = JSON.parse(description)
  } catch {
    return null
  }
  if (!v || typeof v !== "object") return null
  const a = v as Record<string, unknown>
  if (typeof a.kind !== "string" || !(INJECTED_BREAKS as readonly string[]).includes(a.kind)) return null
  if (!strings(a.targets) || !strings(a.dropped) || !strings(a.altered) || typeof a.armedContexts !== "number") return null
  return { kind: a.kind as InjectedBreak, targets: a.targets, armedContexts: a.armedContexts, dropped: a.dropped, altered: a.altered }
}

function statusOf(r: GateRunResult): GateRunStatus | "unknown" {
  if (r.status) return r.status
  return r.passed ? "passed" : "unknown"
}

function sourcedFailure(r: GateRunResult, expectLines: ReadonlySet<number>): number | null {
  if (r.passed || statusOf(r) !== "failed") return null
  return r.failedLines?.find((l) => expectLines.has(l)) ?? null
}

function breakRunProblem(b: InjectedBreak, r: GateRunResult, expectLines: ReadonlySet<number>, reachable: ReadonlySet<number>): string | null {
  const effect = parseBreakAnnotation(r.breakAnnotation)
  if (!effect || effect.kind !== b) return `the run under break ${b} has no injected-break annotation`
  if (b === "alter-query-field" && effect.targets.length === 0) return "no break target"
  if (effect.altered.length + effect.dropped.length === 0) return `break ${b} altered or dropped nothing`
  if (r.passed) return null
  const status = statusOf(r)
  if (status !== "failed") return `the run under break ${b} ended ${status}, not at an assertion`
  if (sourcedFailure(r, expectLines) === null) return `the run under break ${b} did not fail at a sourced EXPECT line`
  if (!r.failedLines?.some((l) => expectLines.has(l) && reachable.has(l))) {
    return `the run under break ${b} did not fail at an assertion the break reaches`
  }
  return null
}

export function gateVerdict(opts: {
  sha256: string
  check: GateCheckRecord
  applicableBreaks: InjectedBreak[]
  expectLines: number[]
  breakLines: Partial<Record<InjectedBreak, number[]>>
  results: GateRunResult[]
}): GateVerdict {
  const { sha256 } = opts
  const reasons: string[] = []
  const expectLines = new Set(opts.expectLines)
  if (!opts.check.ok || opts.check.sha256 !== sha256) {
    reasons.push(opts.check.sha256 !== sha256 ? "static check ran on another spec" : "static check failed")
    return { verdict: "rejected", sha256, reasons }
  }
  const foreign = opts.results.filter((r) => r.sha256 !== sha256)
  if (foreign.length > 0) {
    return { verdict: "rejected", sha256, reasons: [`${foreign.length} result(s) are bound to another spec`] }
  }
  if (opts.applicableBreaks.length === 0) {
    return { verdict: "rejected", sha256, reasons: ["no injected break applies, so the draft cannot be shown to fail"] }
  }

  const clean = opts.results.filter((r) => r.injectedBreak === null)
  const deployments = new Set(clean.map((r) => r.deployment))
  if (deployments.size !== clean.length) {
    return { verdict: "rejected", sha256, reasons: ["clean runs must each use a new deployment"] }
  }
  const passes = clean.filter((r) => r.passed).length
  const fails = clean.length - passes
  if (passes > 0 && fails > 0) {
    return { verdict: "flaky", sha256, reasons: [`${passes} of ${clean.length} clean runs passed`] }
  }
  if (fails > 0 && clean.length < REQUIRED_CLEAN_PASSES) {
    return { verdict: "incomplete", sha256, reasons: [`${fails} clean run(s) failed; re-run to ${REQUIRED_CLEAN_PASSES}`] }
  }
  if (fails > 0) {
    const lines = clean.map((r) => sourcedFailure(r, expectLines))
    const line = lines[0]
    if (line !== null && lines.every((l) => l === line)) {
      return { verdict: "failing", sha256, line, reasons: [`all ${clean.length} clean runs failed at line ${line}`] }
    }
    return { verdict: "flaky", sha256, reasons: [`${clean.length} clean runs failed, not all at the same sourced EXPECT line`] }
  }
  if (clean.length < REQUIRED_CLEAN_PASSES) {
    reasons.push(`${clean.length} of ${REQUIRED_CLEAN_PASSES} clean runs`)
  }

  for (const b of opts.applicableBreaks) {
    const runs = opts.results.filter((r) => r.injectedBreak === b)
    if (runs.length === 0) {
      reasons.push(`no run under break ${b}`)
      continue
    }
    const reachable = new Set(opts.breakLines[b] ?? [])
    const problems = runs.map((r) => breakRunProblem(b, r, expectLines, reachable))
    if (runs.some((r, i) => r.passed && problems[i] === null)) {
      return { verdict: "rejected", sha256, reasons: [`still passes under break ${b}`] }
    }
    const passedWithProblem = runs.flatMap((r, i) => (r.passed ? [`a run under break ${b} passed (${problems[i]})`] : []))
    if (passedWithProblem.length > 0) reasons.push(...passedWithProblem)
    else if (!problems.some((p) => p === null)) reasons.push(...new Set(problems.filter((p): p is string => p !== null)))
  }
  const unknown = opts.results.filter((r) => r.injectedBreak !== null && !opts.applicableBreaks.includes(r.injectedBreak))
  if (unknown.length > 0) reasons.push(`results under unplanned breaks: ${unknown.map((r) => r.injectedBreak).join(", ")}`)

  if (reasons.length > 0) return { verdict: "incomplete", sha256, reasons }
  return { verdict: "offer", sha256 }
}

export function newBreakToken(): string {
  return randomBytes(24).toString("base64url")
}

export const GATE_PLAYWRIGHT_ARGS = "--retries=0"

export function gateStepOutputs(record: GateCheckRecord, token: string = record.break ? newBreakToken() : ""): string {
  return [
    `spec=${record.path}`,
    `sha256=${record.sha256}`,
    `break=${record.break ?? ""}`,
    `break_token=${record.break ? token : ""}`,
    `playwright_args=${GATE_PLAYWRIGHT_ARGS}`,
  ].join("\n") + "\n"
}

function main(): number {
  const runJsonPath = process.env.E2E_RUN_JSON
  const checkoutRef = process.env.GITHUB_REF_NAME
  if (!runJsonPath || !checkoutRef) {
    console.error("E2E_RUN_JSON and GITHUB_REF_NAME are required")
    return 2
  }
  const record = runGateCheck({
    runJsonPath,
    checkoutRef,
    checkoutSha: process.env.GITHUB_SHA,
    runKey: process.env.E2E_RUN_KEY,
    root: process.cwd(),
    previewUrl: process.env.E2E_BASE_URL,
    convexUrl: process.env.E2E_CONVEX_URL,
  })
  const out = process.env.E2E_GATE_OUT ?? "gate-check.json"
  fs.writeFileSync(out, JSON.stringify(record, null, 2) + "\n")
  if (!record.transport.ok) console.error(`gate refused: ${record.transport.reason}`)
  for (const v of record.checker?.violations ?? []) {
    console.error(`${record.path}:${v.line} [${v.rule}] ${v.message}`)
  }
  if (record.ok && process.env.GITHUB_OUTPUT) {
    fs.appendFileSync(process.env.GITHUB_OUTPUT, gateStepOutputs(record))
  }
  return record.ok ? 0 : 1
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  process.exitCode = main()
}
