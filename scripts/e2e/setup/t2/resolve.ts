export const PREVIEW_ENVIRONMENT = "Preview – staging"
export const BASE_BRANCH = "staging"
export const READY_TIMEOUT_MS = 20 * 60 * 1000
export const READY_POLL_MS = 15 * 1000

export type GitHubDeployment = {
  id: number
  sha: string
  environment: string
  created_at: string
}

export type GitHubDeploymentStatus = {
  id: number
  state: string
  environment?: string
  environment_url?: string
  description?: string | null
  created_at: string
}

export type GitHubPull = {
  number: number
  state: string
  draft?: boolean
  base: { ref: string; repo: { full_name: string } }
  head: { sha: string; ref: string; repo: { full_name: string; fork?: boolean } | null }
}

export type PullRequestTargetEvent = {
  action?: string
  number?: number
  pull_request?: { number?: number }
  repository?: { full_name?: string }
}

export interface GitHubReader {
  getPull(pr: number): Promise<GitHubPull>
  listPullCommitShas(pr: number): Promise<string[]>
  listDeployments(sha: string): Promise<GitHubDeployment[]>
  listDeploymentStatuses(deploymentId: number): Promise<GitHubDeploymentStatus[]>
}

export type Preview =
  | { state: "READY"; sha: string; githubDeploymentId: number; url: string; readyAt: string }
  | { state: "FAILED"; sha: string; githubDeploymentId: number; description: string }
  | { state: "NONE"; sha: string }

export type BoundPullRequest =
  | { run: true; pr: number; prSha: string; headRef: string; repo: string }
  | { run: false; pr: number | null; reason: "no-pr" | "closed" | "base" | "draft" | "fork" }

const newestFirst = <T extends { id: number; created_at: string }>(a: T, b: T) =>
  b.created_at.localeCompare(a.created_at) || b.id - a.id

export function latestStatus(statuses: GitHubDeploymentStatus[]): GitHubDeploymentStatus | null {
  return [...statuses].sort(newestFirst)[0] ?? null
}

export function previewDeployments(deployments: GitHubDeployment[], sha: string): GitHubDeployment[] {
  return deployments
    .filter((d) => d.environment === PREVIEW_ENVIRONMENT && d.sha === sha)
    .sort(newestFirst)
}

export function classifyPreview(
  sha: string,
  deployment: GitHubDeployment | undefined,
  statuses: GitHubDeploymentStatus[],
): Preview {
  if (!deployment) return { state: "NONE", sha }
  const latest = latestStatus(statuses)
  if (!latest) return { state: "NONE", sha }
  if (latest.state === "success" && latest.environment_url) {
    return {
      state: "READY",
      sha,
      githubDeploymentId: deployment.id,
      url: new URL(latest.environment_url).origin,
      readyAt: latest.created_at,
    }
  }
  if (latest.state === "failure" || latest.state === "error") {
    return {
      state: "FAILED",
      sha,
      githubDeploymentId: deployment.id,
      description: latest.description ?? latest.state,
    }
  }
  return { state: "NONE", sha }
}

export async function readPreview(reader: GitHubReader, sha: string): Promise<Preview> {
  const [deployment] = previewDeployments(await reader.listDeployments(sha), sha)
  if (!deployment) return { state: "NONE", sha }
  return classifyPreview(sha, deployment, await reader.listDeploymentStatuses(deployment.id))
}

export async function newestReadyPreview(
  reader: GitHubReader,
  pr: number,
): Promise<Extract<Preview, { state: "READY" }> | null> {
  const shas = await reader.listPullCommitShas(pr)
  for (const sha of [...shas].reverse()) {
    const preview = await readPreview(reader, sha)
    if (preview.state === "READY") return preview
  }
  return null
}

export function eventPullNumber(event: PullRequestTargetEvent): number | null {
  const n = event.pull_request?.number ?? event.number
  return Number.isInteger(n) && (n as number) > 0 ? (n as number) : null
}

export async function bindPullRequest(
  event: PullRequestTargetEvent,
  reader: GitHubReader,
  repo: string,
): Promise<BoundPullRequest> {
  const pr = eventPullNumber(event)
  if (pr === null) return { run: false, pr: null, reason: "no-pr" }
  const pull = await reader.getPull(pr)
  if (pull.number !== pr) throw new Error(`pull ${pr} read back as ${pull.number}`)
  if (pull.state !== "open") return { run: false, pr, reason: "closed" }
  if (pull.base.ref !== BASE_BRANCH || pull.base.repo.full_name !== repo) {
    return { run: false, pr, reason: "base" }
  }
  if (pull.draft) return { run: false, pr, reason: "draft" }
  if (!pull.head.repo || pull.head.repo.fork || pull.head.repo.full_name !== repo) {
    return { run: false, pr, reason: "fork" }
  }
  if (!/^[0-9a-f]{40}$/.test(pull.head.sha)) throw new Error(`pull ${pr} head sha is not a sha`)
  return { run: true, pr, prSha: pull.head.sha, headRef: pull.head.ref, repo }
}

export type WaitOptions = {
  timeoutMs?: number
  intervalMs?: number
  now?: () => number
  sleep?: (ms: number) => Promise<void>
}

export type WaitResult =
  | Extract<Preview, { state: "READY" }>
  | Extract<Preview, { state: "FAILED" }>
  | { state: "TIMEOUT"; sha: string; waitedMs: number }

export async function waitForReady(
  reader: GitHubReader,
  sha: string,
  options: WaitOptions = {},
): Promise<WaitResult> {
  const timeoutMs = options.timeoutMs ?? READY_TIMEOUT_MS
  const intervalMs = options.intervalMs ?? READY_POLL_MS
  const now = options.now ?? Date.now
  const sleep = options.sleep ?? ((ms: number) => new Promise<void>((r) => setTimeout(r, ms)))
  const start = now()
  for (;;) {
    const preview = await readPreview(reader, sha)
    if (preview.state !== "NONE") return preview
    const waited = now() - start
    if (waited >= timeoutMs) return { state: "TIMEOUT", sha, waitedMs: waited }
    await sleep(Math.min(intervalMs, timeoutMs - waited))
  }
}
