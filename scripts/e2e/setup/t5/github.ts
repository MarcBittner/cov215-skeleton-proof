import { markerMessage } from "../../map/nightly/branch.js"
import { GATE_BRANCH_PREFIX } from "../../gate/gate-run.js"
import type { DraftPr } from "./types.js"

export const DRAFT_LABEL = "test-draft"
export const REJECTED_LABEL = "test-draft-rejected"
export const POSSIBLE_BUG_LABEL = "possible-bug"
export const TOOLING_PREFIX = "e2e/"
export const MAP_BRANCH = "e2e/map"

export interface GithubClient {
  listDraftPrs(): Promise<DraftPr[]>
  countLiveToolingBranches(): Promise<number>
  createBranchWithFiles(opts: { branch: string; baseSha: string; files: Record<string, string>; message: string }): Promise<string>
  createCommitWithFiles(opts: { baseSha: string; files: Record<string, string>; message: string }): Promise<string>
  createMarkerBranch(opts: { branch: string; targetSha: string }): Promise<string>
  openPullRequest(opts: { head: string; base: string; title: string; body: string; labels: string[] }): Promise<number>
  dispatchWorkflow(opts: { workflow: string; ref: string; inputs: Record<string, string> }): Promise<void>
}

type FetchFn = (url: string, init?: RequestInit) => Promise<Response>

export function restGithubClient(opts: {
  token: string
  repository: string
  apiUrl?: string
  fetch?: FetchFn
}): GithubClient {
  if (!/^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/.test(opts.repository)) throw new Error("repository must be owner/name")
  const api = (opts.apiUrl ?? "https://api.github.com").replace(/\/$/, "")
  const doFetch: FetchFn = opts.fetch ?? ((u, i) => fetch(u, i))
  const repo = `${api}/repos/${opts.repository}`

  async function call<T>(method: string, url: string, body?: unknown): Promise<T> {
    const res = await doFetch(url, {
      method,
      headers: {
        authorization: `Bearer ${opts.token}`,
        accept: "application/vnd.github+json",
        "x-github-api-version": "2022-11-28",
        ...(body === undefined ? {} : { "content-type": "application/json" }),
      },
      body: body === undefined ? undefined : JSON.stringify(body),
    })
    if (!res.ok) throw new Error(`GitHub ${method} ${url.slice(api.length)} -> ${res.status}`)
    if (res.status === 204) return undefined as T
    return (await res.json()) as T
  }

  type Issue = {
    number: number
    state: string
    body: string | null
    labels: Array<{ name?: string } | string>
    pull_request?: { merged_at: string | null }
  }

  async function commitWithFiles(baseSha: string, files: Record<string, string>, message: string): Promise<string> {
    const base = await call<{ tree: { sha: string } }>("GET", `${repo}/git/commits/${baseSha}`)
    const tree = await call<{ sha: string }>("POST", `${repo}/git/trees`, {
      base_tree: base.tree.sha,
      tree: Object.entries(files).map(([path, content]) => ({ path, mode: "100644", type: "blob", content })),
    })
    const commit = await call<{ sha: string }>("POST", `${repo}/git/commits`, { message, tree: tree.sha, parents: [baseSha] })
    return commit.sha
  }

  return {
    async listDraftPrs() {
      const out: DraftPr[] = []
      for (let page = 1; page <= 50; page++) {
        const issues = await call<Issue[]>(
          "GET",
          `${repo}/issues?labels=${encodeURIComponent(DRAFT_LABEL)}&state=all&per_page=100&page=${page}`,
        )
        for (const i of issues) {
          if (!i.pull_request) continue
          out.push({
            number: i.number,
            state: i.state === "open" ? "open" : "closed",
            merged: !!i.pull_request.merged_at,
            body: i.body ?? "",
            labels: i.labels.map((l) => (typeof l === "string" ? l : (l.name ?? ""))),
          })
        }
        if (issues.length < 100) break
      }
      return out
    },
    async countLiveToolingBranches() {
      const refs = await call<Array<{ ref: string }>>("GET", `${repo}/git/matching-refs/heads/${TOOLING_PREFIX}`)
      return refs.filter((r) => r.ref !== `refs/heads/${MAP_BRANCH}`).length
    },
    async createBranchWithFiles({ branch, baseSha, files, message }) {
      if (!branch.startsWith(TOOLING_PREFIX) || branch === MAP_BRANCH) throw new Error(`refusing to write ${branch}`)
      const sha = await commitWithFiles(baseSha, files, message)
      await call("POST", `${repo}/git/refs`, { ref: `refs/heads/${branch}`, sha })
      return sha
    },
    createCommitWithFiles: ({ baseSha, files, message }) => commitWithFiles(baseSha, files, message),
    async createMarkerBranch({ branch, targetSha }) {
      if (!branch.startsWith(GATE_BRANCH_PREFIX)) throw new Error(`refusing to write ${branch}`)
      const target = await call<{ sha: string; tree: { sha: string } }>("GET", `${repo}/git/commits/${targetSha}`)
      if (target.sha !== targetSha) throw new Error(`commit ${targetSha.slice(0, 12)} read back as ${target.sha.slice(0, 12)}`)
      const marker = await call<{ sha: string; tree: { sha: string }; parents: { sha: string }[] }>("POST", `${repo}/git/commits`, {
        message: markerMessage(branch, targetSha),
        tree: target.tree.sha,
        parents: [targetSha],
      })
      if (marker.tree.sha !== target.tree.sha || marker.parents.map((p) => p.sha).join() !== targetSha) {
        throw new Error(`marker commit for ${branch} is not an empty commit on ${targetSha.slice(0, 12)}`)
      }
      await call("POST", `${repo}/git/refs`, { ref: `refs/heads/${branch}`, sha: marker.sha })
      return marker.sha
    },
    async openPullRequest({ head, base, title, body, labels }) {
      const pr = await call<{ number: number }>("POST", `${repo}/pulls`, { head, base, title, body })
      if (labels.length) await call("POST", `${repo}/issues/${pr.number}/labels`, { labels })
      return pr.number
    },
    async dispatchWorkflow({ workflow, ref, inputs }) {
      await call("POST", `${repo}/actions/workflows/${encodeURIComponent(workflow)}/dispatches`, { ref, inputs })
    },
  }
}
