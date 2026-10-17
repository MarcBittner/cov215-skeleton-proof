export const SETUP_WORKFLOW = ".github/workflows/e2e-setup.yml"
export const RUN_WORKFLOW = ".github/workflows/e2e-run.yml"
export const TRUSTED_BRANCH = "staging"

function workflowPath(run) {
  return String(run?.path ?? "").replace(/@.*$/, "")
}

export function recordedDispatches(runRecord) {
  return (runRecord?.dispatches ?? [])
    .filter((d) => d && d.run_key && d.dispatched_run_id != null)
    .map((d) => ({ run_key: String(d.run_key), role: d.role, run_id: String(d.dispatched_run_id) }))
}

export function runShas(runRecord) {
  return [runRecord?.pr_sha, runRecord?.tooling_sha].filter((sha) => typeof sha === "string" && sha.length > 0)
}

export const TRUSTED_BRANCH_EVENTS = ["schedule", "workflow_dispatch"]

export function untrustedSetupRun(setupRun) {
  if (!setupRun || workflowPath(setupRun) !== SETUP_WORKFLOW) return `setup run is not ${SETUP_WORKFLOW}`
  if (setupRun.event === "pull_request_target") return null
  if (!TRUSTED_BRANCH_EVENTS.includes(setupRun.event)) return `setup run event ${setupRun.event} is not trusted`
  if (setupRun.head_branch !== TRUSTED_BRANCH) return `setup run is from ${setupRun.head_branch}, not ${TRUSTED_BRANCH}`
  return null
}

export function checkSetupRun({ setupRun, runRecord }) {
  const untrusted = untrustedSetupRun(setupRun)
  if (untrusted) return untrusted
  if (!runRecord || String(runRecord.setup_run_id) !== String(setupRun.id)) return "run.json does not belong to this setup run"
  return null
}

/** @param {{ setupRun: any, runRecord: any, run: any, jobs?: { status: string }[] }} args @returns {{ decision: string, reason: string | null, run_key?: string }} */
export function checkRunTrust({ setupRun, runRecord, run, jobs = [] }) {
  const refuse = (reason) => ({ decision: "refuse", reason })
  const setupProblem = checkSetupRun({ setupRun, runRecord })
  if (setupProblem) return refuse(setupProblem)
  if (!run) return refuse("no e2e-run run")
  const dispatch = recordedDispatches(runRecord).find((d) => d.run_id === String(run.id))
  if (!dispatch) return refuse(`e2e-run ${run.id} is not recorded in setup's run.json`)
  if (workflowPath(run) !== RUN_WORKFLOW) return refuse(`run ${run.id} is not ${RUN_WORKFLOW}`)
  if (!runShas(runRecord).includes(run.head_sha)) return refuse(`run head ${run.head_sha} differs from setup's pr_sha ${runRecord.pr_sha}${runRecord.tooling_sha ? ` and tooling_sha ${runRecord.tooling_sha}` : ""}`)
  if (run.status !== "completed") return { decision: "wait", reason: `run ${run.id} is ${run.status}` }
  const open = jobs.filter((j) => j.status !== "completed")
  if (open.length) return { decision: "wait", reason: `${open.length} job(s) still in progress` }
  return { decision: "report", reason: null, run_key: dispatch.run_key }
}

export function checkPlanBinding(plan, runKey) {
  if (!plan || !Array.isArray(plan.shards) || plan.shards.length === 0) return "plan.json has no shards"
  if (plan.setup_run_id == null) return "plan.json names no setup run"
  const other = plan.shards.find((s) => s.run_key !== runKey)
  return other ? `plan.json shard ${other.index} belongs to run_key ${other.run_key}, not the dispatched ${runKey}` : null
}

export function restoreScope(runRecord) {
  return {
    deployment: runRecord?.deployment?.convex_deployment ?? null,
    mail: Boolean(runRecord?.mail?.contained),
    tenants: (runRecord?.tenants ?? []).map((t) => t.org_id).sort(),
  }
}

/** @param {{ runRecord: any, others: { runRecord: any, status: string | null }[] }} args */
export function mayRestore({ runRecord, others }) {
  const scope = restoreScope(runRecord)
  if (!scope.deployment) return { ok: false, reason: "run.json lists no deployment", scope }
  if (!scope.mail && scope.tenants.length === 0) return { ok: false, reason: "nothing in run.json to restore", scope }
  const busy = others.find(
    (o) => String(o.runRecord?.setup_run_id) !== String(runRecord.setup_run_id) && o.runRecord?.deployment?.convex_deployment === scope.deployment && o.status !== "completed",
  )
  if (busy) return { ok: false, reason: `setup run ${busy.runRecord.setup_run_id} on ${scope.deployment} is still in flight`, scope }
  return { ok: true, reason: null, scope }
}
