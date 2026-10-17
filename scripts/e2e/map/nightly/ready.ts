export const READY_BOUND_MS = 20 * 60_000
export const READY_POLL_MS = 15_000

export interface Deployment {
  id: number
  ref: string
  sha: string
  environment: string
  created_at: string
}

export interface DeploymentStatus {
  state: string
  environment_url?: string | null
  description?: string | null
  created_at: string
}

export interface DeploymentsClient {
  listDeploymentsForSha(sha: string): Promise<Deployment[]>
  listDeploymentStatuses(id: number): Promise<DeploymentStatus[]>
}

export type ReadyResult =
  | { ready: true; deploymentId: number; url: string; waitedMs: number }
  | { ready: false; kind: "failed" | "timeout"; reason: string; waitedMs: number }

export interface WaitOptions {
  branch: string
  sha: string
  createdAfterMs: number
  boundMs?: number
  pollMs?: number
  now?: () => number
  sleep?: (ms: number) => Promise<void>
}

const WAITING = new Set(["pending", "queued", "in_progress"])

const realSleep = (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms))

function newest<T extends { created_at: string }>(items: readonly T[]): T | undefined {
  let best: T | undefined
  for (const item of items) {
    if (!best || Date.parse(item.created_at) > Date.parse(best.created_at)) best = item
  }
  return best
}

type Poll =
  | { done: true; result: { kind: "ready"; deploymentId: number; url: string } | { kind: "failed"; reason: string } }
  | { done: false; note: string }

export const CREATED_SLACK_MS = 60_000

async function pollOnce(client: DeploymentsClient, options: WaitOptions): Promise<Poll> {
  const { branch, sha } = options
  const candidates = (await client.listDeploymentsForSha(sha)).filter(
    (d) => d.sha === sha && d.environment.startsWith("Preview") && Date.parse(d.created_at) >= options.createdAfterMs - CREATED_SLACK_MS,
  )
  const deployment = newest(candidates)
  if (!deployment) {
    return { done: false, note: `no Preview deployment of ${sha.slice(0, 12)} created after ${branch} (${new Date(options.createdAfterMs).toISOString()})` }
  }
  const status = newest(await client.listDeploymentStatuses(deployment.id))
  if (!status) return { done: false, note: `deployment ${deployment.id} has no status yet` }
  if (WAITING.has(status.state)) return { done: false, note: `deployment ${deployment.id} is ${status.state}` }
  const detail = status.description ? `: ${status.description}` : ""
  if (status.state === "success") {
    if (!status.environment_url) {
      return { done: true, result: { kind: "failed", reason: `deployment ${deployment.id} succeeded without an environment_url` } }
    }
    return { done: true, result: { kind: "ready", deploymentId: deployment.id, url: status.environment_url } }
  }
  return { done: true, result: { kind: "failed", reason: `build ${status.state} (deployment ${deployment.id}${detail})` } }
}

function formatBound(ms: number): string {
  return ms % 60_000 === 0 ? `${ms / 60_000} min` : `${ms / 1000} s`
}

export async function waitForNightlyPreview(client: DeploymentsClient, options: WaitOptions): Promise<ReadyResult> {
  const boundMs = options.boundMs ?? READY_BOUND_MS
  const pollMs = options.pollMs ?? READY_POLL_MS
  const now = options.now ?? Date.now
  const sleep = options.sleep ?? realSleep
  if (!(boundMs > 0)) throw new Error(`READY bound must be > 0 ms, got ${boundMs}`)
  if (!/^[0-9a-f]{40}$/.test(options.sha)) throw new Error(`not a full sha: "${options.sha}"`)
  if (!Number.isFinite(options.createdAfterMs)) throw new Error("createdAfterMs is required")
  const start = now()
  const deadline = start + boundMs
  let note = "not polled"
  for (;;) {
    try {
      const poll = await pollOnce(client, options)
      if (poll.done) {
        const waitedMs = now() - start
        const r = poll.result
        if (r.kind === "ready") return { ready: true, deploymentId: r.deploymentId, url: r.url, waitedMs }
        return { ready: false, kind: r.kind, reason: r.reason, waitedMs }
      }
      note = poll.note
    } catch (err) {
      note = `deployments API error: ${err instanceof Error ? err.message : String(err)}`
    }
    const left = deadline - now()
    if (left <= 0) {
      return {
        ready: false,
        kind: "timeout",
        reason: `not READY within ${formatBound(boundMs)} (${note})`,
        waitedMs: now() - start,
      }
    }
    await sleep(Math.min(pollMs, left))
  }
}
