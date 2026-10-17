import {
  bindPullRequest,
  newestReadyPreview,
  waitForReady,
  type GitHubReader,
  type Preview,
  type PullRequestTargetEvent,
  type WaitOptions,
} from "./resolve.js"
import { readConvexTarget, type ConvexTarget, type FetchText } from "./resolve-convex.js"

type ReadyPreview = Extract<Preview, { state: "READY" }>

export type ResolvedTarget =
  | { status: "skip"; pr: number | null; reason: string }
  | {
      status: "ready"
      pr: number
      prSha: string
      headRef: string
      targetSha: string
      headSkipsBuild: boolean
      preview: ReadyPreview
      convex: ConvexTarget
    }
  | {
      status: "no-preview"
      pr: number
      prSha: string
      headRef: string
      headSkipsBuild: boolean
      reason: string
    }

export type ResolveDeps = {
  reader: GitHubReader
  fetchText: FetchText
  repo: string
  headSkipsBuild: (prSha: string) => Promise<boolean>
  wait?: WaitOptions
}

export async function resolvePullRequestTarget(
  event: PullRequestTargetEvent,
  deps: ResolveDeps,
): Promise<ResolvedTarget> {
  const bound = await bindPullRequest(event, deps.reader, deps.repo)
  if (!bound.run) return { status: "skip", pr: bound.pr, reason: bound.reason }
  const { pr, prSha, headRef } = bound
  const headSkipsBuild = await deps.headSkipsBuild(prSha)

  let preview: ReadyPreview | null
  let reason: string
  if (headSkipsBuild) {
    preview = await newestReadyPreview(deps.reader, pr)
    reason = "head has no build and the pull request has no READY preview"
  } else {
    const waited = await waitForReady(deps.reader, prSha, deps.wait)
    preview = waited.state === "READY" ? waited : null
    reason =
      waited.state === "FAILED"
        ? `preview of ${prSha} failed: ${waited.description}`
        : waited.state === "TIMEOUT"
          ? `no READY preview of ${prSha} after ${Math.round(waited.waitedMs / 60000)} min`
          : ""
  }
  if (!preview) return { status: "no-preview", pr, prSha, headRef, headSkipsBuild, reason }

  const convex = await readConvexTarget(preview.url, deps.fetchText)
  return { status: "ready", pr, prSha, headRef, targetSha: preview.sha, headSkipsBuild, preview, convex }
}

export function runRecord(target: Extract<ResolvedTarget, { status: "ready" }>) {
  return {
    pr: target.pr,
    pr_sha: target.prSha,
    target_sha: target.targetSha,
    head_skips_build: target.headSkipsBuild,
    preview_url: target.preview.url,
    github_deployment_id: target.preview.githubDeploymentId,
    deployment: target.convex.deployment,
    convex_url: target.convex.url,
  }
}
