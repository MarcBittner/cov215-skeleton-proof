export const SETUP_WORKFLOW = ".github/workflows/e2e-setup.yml"
export const RUN_WORKFLOW = ".github/workflows/e2e-run.yml"
export const REPORT_WORKFLOW = ".github/workflows/e2e-report.yml"
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

/**
 * @param {(path: string) => Promise<any>} get repo-relative GET ("" is the repository), null on 404
 * @returns {(run: any, path?: string) => Promise<string | null>} the reason a run is not trusted, or null
 */
export function runVerifier(get) {
  let repoId
  let tagged
  const onStaging = new Map()
  return async function verify(run, path = SETUP_WORKFLOW) {
    if (!run || workflowPath(run) !== path) return `run ${run?.id} is not ${path}`
    if (run.event === "pull_request_target") {
      if (path !== SETUP_WORKFLOW) return `run ${run.id} of ${path} came from pull_request_target`
      if (repoId === undefined) repoId = (await get(""))?.id ?? null
      if (repoId === null) return "the repository id could not be read"
      const into = (run.pull_requests ?? []).some((p) => p?.base?.ref === TRUSTED_BRANCH && p?.base?.repo?.id === repoId)
      return into ? null : `pull_request_target run ${run.id} is not for a pull request into ${TRUSTED_BRANCH} of this repository`
    }
    if (!TRUSTED_BRANCH_EVENTS.includes(run.event)) return `run ${run.id} event ${run.event} is not trusted`
    if (run.head_branch !== TRUSTED_BRANCH) return `run ${run.id} is from ${run.head_branch}, not ${TRUSTED_BRANCH}`
    if (tagged === undefined) tagged = (await get(`git/ref/tags/${TRUSTED_BRANCH}`)) !== null
    if (tagged) return `a tag named ${TRUSTED_BRANCH} exists, so head_branch ${TRUSTED_BRANCH} does not prove the branch`
    const sha = String(run.head_sha ?? "")
    if (!/^[0-9a-f]{40}$/.test(sha)) return `run ${run.id} has no head sha`
    if (!onStaging.has(sha)) {
      const c = await get(`compare/refs/heads/${TRUSTED_BRANCH}...${sha}`)
      onStaging.set(sha, c?.status === "identical" || c?.status === "behind")
    }
    return onStaging.get(sha) ? null : `run ${run.id} head ${sha.slice(0, 12)} is not on refs/heads/${TRUSTED_BRANCH}`
  }
}

export function checkSetupRun({ setupRun, runRecord, untrusted }) {
  if (untrusted === undefined) return "setup run trust was not verified"
  if (untrusted) return untrusted
  if (!runRecord || String(runRecord.setup_run_id) !== String(setupRun.id)) return "run.json does not belong to this setup run"
  return null
}

/** @param {{ setupRun: any, untrusted: string | null | undefined, runRecord: any, run: any, jobs?: { status: string }[] }} args @returns {{ decision: string, reason: string | null, run_key?: string }} */
export function checkRunTrust({ setupRun, untrusted, runRecord, run, jobs = [] }) {
  const refuse = (reason) => ({ decision: "refuse", reason })
  const setupProblem = checkSetupRun({ setupRun, runRecord, untrusted })
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
