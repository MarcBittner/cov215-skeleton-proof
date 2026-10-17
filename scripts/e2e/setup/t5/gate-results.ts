import { ARTIFACTS, FILES } from "../../contract/constants.js"
import { validateSetupPlan } from "../../contract/formats.js"
import type { SetupPlan } from "../../contract/types.js"
import { type GitHub, runArtifactJson } from "../../lib/github.js"
import { SETUP_WORKFLOW, checkRunTrust, runVerifier } from "../../report/trust.mjs"
import type { GateCheckRecord, GateRunStatus } from "../../gate/gate-run.js"
import type { GateRequest, GateResultInput, PendingDraft } from "./types.js"

export const GATE_RESULT_ARTIFACT = "e2e-gate-result"
export const GATE_RESULT_FILE = "gate-result.json"
const STATUSES = new Set<string>(["passed", "failed", "timedOut", "interrupted", "skipped"])

export interface ApiRun {
  id: number
  path?: string
  event?: string
  head_branch?: string | null
  head_sha: string
  status: string | null
}

export interface GateRunReader {
  run(id: string): Promise<ApiRun | null>
  jobs(id: string): Promise<{ status: string }[]>
  artifactJson<T>(runId: string, name: string, file: string): Promise<T | null>
  verify(run: ApiRun | null, path: string): Promise<string | null>
}

export function gateRunReader(gh: GitHub): GateRunReader {
  const verify = runVerifier((p: string) => gh.get(p ? `/${p}` : ""))
  return {
    run: (id) => gh.get<ApiRun>(`/actions/runs/${id}`),
    jobs: async (id) => (await gh.get<{ jobs: { status: string }[] }>(`/actions/runs/${id}/jobs?per_page=100`))?.jobs ?? [],
    artifactJson: (runId, name, file) => runArtifactJson(gh, runId, name, file),
    verify: async (run, path) => (run ? verify(run, path) : "no such run"),
  }
}

export type GateFetch = { ref: string; result: GateResultInput } | { ref: string; skipped: string }

const sameGate = (plan: SetupPlan, g: GateRequest) =>
  !!plan.gate && plan.gate.ref === g.gate.ref && plan.gate.path === g.gate.path && plan.gate.sha256 === g.gate.sha256 && plan.gate.break === g.gate.break

function resultOf(raw: unknown, g: GateRequest, deployment: string): GateResultInput | string {
  if (!raw || typeof raw !== "object") return "gate-result.json is not an object"
  const r = raw as Record<string, unknown>
  const check = r.check as GateCheckRecord | undefined
  if (r.ref !== g.ref || r.sha256 !== g.sha256) return "gate result is bound to another gate or spec"
  if (!check || typeof check !== "object" || check.ref !== g.ref || (check.sha256 !== null && check.sha256 !== g.sha256)) return "gate check record is for another gate or spec"
  if (r.deployment !== deployment) return `gate result deployment ${String(r.deployment)} is not the planned ${deployment}`
  if (typeof r.passed !== "boolean" || typeof r.status !== "string" || !STATUSES.has(r.status)) return "gate result has no status"
  const failedLines = Array.isArray(r.failedLines) ? r.failedLines.filter((l): l is number => Number.isInteger(l)) : []
  const breakAnnotation = typeof r.breakAnnotation === "string" ? r.breakAnnotation : null
  return { ref: g.ref, sha256: g.sha256, deployment, passed: r.passed && check.ok === true, status: r.status as GateRunStatus, failedLines, breakAnnotation, check }
}

export async function fetchGateResult(g: GateRequest, reader: GateRunReader): Promise<GateFetch> {
  const skip = (why: string): GateFetch => ({ ref: g.ref, skipped: why })
  if (!g.setupRunId || !/^[1-9]\d{0,19}$/.test(g.setupRunId)) return skip("no gate setup run recorded")
  const setupRun = await reader.run(g.setupRunId)
  const untrusted = await reader.verify(setupRun, SETUP_WORKFLOW)
  if (untrusted) return skip(`setup run ${g.setupRunId}: ${untrusted}`)
  const doc = validateSetupPlan(
    (await reader.artifactJson<unknown>(g.setupRunId, ARTIFACTS.planFinal, FILES.setupPlan)) ?? null,
  )
  if (!doc.ok) return skip(`setup run ${g.setupRunId} has no valid final run.json`)
  const plan = doc.value
  if (plan.setup_run_id !== g.setupRunId) return skip(`run.json belongs to setup run ${plan.setup_run_id}`)
  if (plan.kind !== "gate" || !sameGate(plan, g)) return skip(`setup run ${g.setupRunId} planned another gate`)
  const main = plan.dispatches.find((d) => d.role === "main" && d.dispatched_run_id)
  if (!main?.dispatched_run_id) return skip(`setup run ${g.setupRunId} dispatched no gate run (${plan.state})`)
  const run = await reader.run(main.dispatched_run_id)
  const decision = checkRunTrust({ setupRun, untrusted: null, runRecord: plan, run, jobs: run ? await reader.jobs(String(run.id)) : [] })
  if (decision.decision !== "report") return skip(decision.reason ?? "gate run not trusted")
  const raw = await reader.artifactJson<unknown>(main.dispatched_run_id, GATE_RESULT_ARTIFACT, GATE_RESULT_FILE)
  if (raw === null) return skip(`gate run ${main.dispatched_run_id} uploaded no ${GATE_RESULT_ARTIFACT}`)
  const result = resultOf(raw, g, plan.deployment.vercel_deployment_id)
  return typeof result === "string" ? skip(result) : { ref: g.ref, result }
}

export async function collectGateResults(pending: readonly PendingDraft[], reader: GateRunReader, log: (line: string) => void = () => {}): Promise<GateResultInput[]> {
  const out: GateResultInput[] = []
  for (const d of pending) {
    for (const g of d.gates) {
      const f = await fetchGateResult(g, reader)
      if ("result" in f) out.push(f.result)
      else log(`gate ${f.ref}: ${f.skipped}`)
    }
  }
  return out
}
