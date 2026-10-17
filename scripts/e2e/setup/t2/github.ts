import { validateRunRequest } from "../../contract/formats.js"
import { markerMessage, type GitCommit } from "../../map/nightly/branch.js"
import type { Deployment, DeploymentStatus, DeploymentsClient } from "../../map/nightly/ready.js"
import { emptyIndex, parseIndex, type StoreIndex } from "../../map/nightly/store-index.js"
import type { IndexStore } from "../../map/nightly/setup-night.js"
import { assertRunBranch, type BranchRef, type GitRefs } from "./branches.js"

export type Fetch = (url: string, init?: RequestInit) => Promise<Response>

export const RUN_WORKFLOW = "e2e-run.yml"
export const SETUP_WORKFLOW = "e2e-setup.yml"
export const DISPATCH_API_VERSION = "2026-03-10"
export const SETUP_DISPATCH_INPUTS = ["mode", "kind", "pr"] as const
export const MAP_STORE_BRANCH = "e2e/map"
export const MAP_INDEX_PATH = "maps/index.json"

const SHA = /^[0-9a-f]{40}$/
const REQUEST_TIMEOUT_MS = 30_000
const MARKER = /^e2e tooling branch (\S+) at ([0-9a-f]{12})$/

type RawCommit = { sha: string; tree: { sha: string }; parents: { sha: string }[] }

const commitOf = (c: RawCommit): GitCommit => ({ sha: c.sha, tree: c.tree.sha, parents: c.parents.map((p) => p.sha) })

export interface WorkflowRun {
  id: number
  path: string
  head_branch: string | null
  head_sha: string
  status: string | null
  conclusion: string | null
  created_at: string
  event?: string
}

export interface PullFile {
  filename: string
  status: string
  previous_filename?: string
}

export interface PullDetail {
  number: number
  state: string
  draft?: boolean
  title: string
  merged?: boolean
  merge_commit_sha: string | null
  updated_at: string
  head: { sha: string; ref: string; repo: { full_name: string; fork?: boolean } | null }
  base: { ref: string; repo: { full_name: string } }
}

export interface ArtifactInfo {
  id: number
  name: string
  expired: boolean
}

export interface SetupGitHub extends GitRefs, DeploymentsClient {
  dispatchWorkflow(file: string, ref: string, inputs: Record<string, string>): Promise<{ runId: string | null; htmlUrl: string | null }>
  listWorkflowRuns(file: string, query?: { branch?: string; status?: string; created?: string; event?: string }): Promise<WorkflowRun[]>
  getRun(id: string): Promise<WorkflowRun | null>
  cancelRun(id: string): Promise<void>
  getPullDetail(pr: number): Promise<PullDetail>
  listOpenPulls(base: string): Promise<PullDetail[]>
  listPullFiles(pr: number): Promise<PullFile[]>
  mergeBase(base: string, head: string): Promise<string>
  commitMessage(sha: string): Promise<string>
  listDeploymentsForRef(ref: string): Promise<Deployment[]>
  listArtifacts(runId: string): Promise<ArtifactInfo[]>
  getJson<T>(path: string): Promise<T | null>
  compareFiles(base: string, head: string): Promise<{ files: string[]; complete: boolean }>
  downloadArtifact(artifactId: number): Promise<Buffer>
  readContent(path: string, ref: string): Promise<{ text: string; sha: string } | null>
  writeContent(path: string, branch: string, text: string, message: string, sha: string | null): Promise<void>
}

export class GitHubHttpError extends Error {
  constructor(
    readonly status: number,
    readonly path: string,
  ) {
    super(`GitHub ${status} for ${path}`)
    this.name = "GitHubHttpError"
  }
}

export function nextPage(link: string | null): string | null {
  if (!link) return null
  for (const part of link.split(",")) {
    const m = /<([^>]+)>\s*;\s*rel="next"/.exec(part)
    if (m) return m[1]
  }
  return null
}

export function checkDispatchInputs(file: string, inputs: Record<string, string>): void {
  if (file === RUN_WORKFLOW) {
    const r = validateRunRequest(inputs)
    if (!r.ok) throw new Error(`refused: ${RUN_WORKFLOW} inputs are exactly setup_run_id and run_key (${r.errors.join("; ")})`)
    return
  }
  if (file === SETUP_WORKFLOW) {
    for (const k of Object.keys(inputs)) {
      if (!(SETUP_DISPATCH_INPUTS as readonly string[]).includes(k)) throw new Error(`refused: ${SETUP_WORKFLOW} has no input "${k}"`)
    }
    return
  }
  throw new Error(`refused: setup dispatches only ${RUN_WORKFLOW} and ${SETUP_WORKFLOW}, not ${file}`)
}

export function createSetupGitHub(opts: { repo: string; token: string; fetch?: Fetch; apiUrl?: string }): SetupGitHub {
  if (!/^[\w.-]+\/[\w.-]+$/.test(opts.repo)) throw new Error(`bad repo "${opts.repo}"`)
  if (!opts.token) throw new Error("GITHUB_TOKEN is not set")
  const doFetch: Fetch = opts.fetch ?? ((url, init) => globalThis.fetch(url, init))
  const api = (opts.apiUrl ?? "https://api.github.com").replace(/\/+$/, "")
  const base = `${api}/repos/${opts.repo}/`

  async function call(method: string, path: string, body?: unknown, version = "2022-11-28"): Promise<Response> {
    const url = path.startsWith(`${api}/`) ? path : base + path
    if (!url.startsWith(`${api}/`)) throw new Error(`refusing ${url}`)
    return doFetch(url, {
      method,
      headers: {
        Accept: "application/vnd.github+json",
        Authorization: `Bearer ${opts.token}`,
        "X-GitHub-Api-Version": version,
        ...(body === undefined ? {} : { "Content-Type": "application/json" }),
      },
      body: body === undefined ? undefined : JSON.stringify(body),
      signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
    })
  }

  async function json<T>(path: string): Promise<T> {
    const res = await call("GET", path)
    if (!res.ok) throw new GitHubHttpError(res.status, path)
    return (await res.json()) as T
  }

  async function all<T>(path: string, key?: string): Promise<T[]> {
    const out: T[] = []
    let url: string | null = path
    while (url) {
      const res = await call("GET", url)
      if (!res.ok) throw new GitHubHttpError(res.status, url)
      const body = (await res.json()) as unknown
      const page = key ? (body as Record<string, unknown>)[key] : body
      if (!Array.isArray(page)) throw new Error(`expected a list from ${path}`)
      out.push(...(page as T[]))
      url = nextPage(res.headers.get("link"))
    }
    return out
  }

  async function expectOk(res: Response, path: string, allowed: number[] = []): Promise<void> {
    if (!res.ok && !allowed.includes(res.status)) throw new GitHubHttpError(res.status, path)
  }

  return {
    async listBranches(prefix): Promise<BranchRef[]> {
      const refs = await all<{ ref: string; object: { sha: string } }>(`git/matching-refs/heads/${prefix.split("/").map(encodeURIComponent).join("/")}?per_page=100`)
      return refs.map((r) => ({ name: r.ref.replace(/^refs\/heads\//, ""), sha: r.object.sha }))
    },
    async getBranch(name) {
      const path = `git/ref/heads/${name.split("/").map(encodeURIComponent).join("/")}`
      const res = await call("GET", path)
      if (res.status === 404) return null
      await expectOk(res, path)
      const ref = (await res.json()) as { ref: string; object: { sha: string } }
      if (ref.ref !== `refs/heads/${name}`) return null
      return { name, sha: ref.object.sha }
    },
    async createBranch(name, sha) {
      assertRunBranch(name)
      if (!SHA.test(sha)) throw new Error(`refused: "${sha}" is not a full sha`)
      await expectOk(await call("POST", "git/refs", { ref: `refs/heads/${name}`, sha }), "git/refs")
    },
    async getCommit(sha) {
      if (!SHA.test(sha)) throw new Error(`not a full sha: "${sha}"`)
      return commitOf(await json<RawCommit>(`git/commits/${sha}`))
    },
    async createCommit(message, tree, parents) {
      const m = MARKER.exec(message)
      if (!m || parents.length !== 1 || !SHA.test(parents[0]) || !SHA.test(tree) || message !== markerMessage(m[1], parents[0])) {
        throw new Error("refused: setup creates only an empty marker commit on one target")
      }
      assertRunBranch(m[1])
      const res = await call("POST", "git/commits", { message, tree, parents })
      await expectOk(res, "git/commits")
      return commitOf((await res.json()) as RawCommit)
    },
    async deleteBranch(name) {
      assertRunBranch(name)
      const path = `git/refs/heads/${name.split("/").map(encodeURIComponent).join("/")}`
      await expectOk(await call("DELETE", path), path, [404, 422])
    },
    async listDeploymentsForSha(sha) {
      if (!SHA.test(sha)) throw new Error(`not a full sha: "${sha}"`)
      return all<Deployment>(`deployments?sha=${sha}&per_page=100`)
    },
    async listDeploymentsForRef(ref) {
      return all<Deployment>(`deployments?ref=${encodeURIComponent(ref)}&per_page=100`)
    },
    async listDeploymentStatuses(id): Promise<DeploymentStatus[]> {
      return all<DeploymentStatus>(`deployments/${id}/statuses?per_page=100`)
    },
    async dispatchWorkflow(file, ref, inputs) {
      checkDispatchInputs(file, inputs)
      const path = `actions/workflows/${file}/dispatches`
      const res = await call("POST", path, { ref, inputs }, DISPATCH_API_VERSION)
      await expectOk(res, path)
      const text = await res.text()
      const body = (text ? JSON.parse(text) : {}) as { workflow_run_id?: number; html_url?: string }
      return { runId: body.workflow_run_id ? String(body.workflow_run_id) : null, htmlUrl: body.html_url ?? null }
    },
    async listWorkflowRuns(file, query = {}) {
      const q = new URLSearchParams({ per_page: "100" })
      for (const [k, v] of Object.entries(query)) if (v) q.set(k, v)
      return all<WorkflowRun>(`actions/workflows/${file}/runs?${q.toString()}`, "workflow_runs")
    },
    async getRun(id) {
      const path = `actions/runs/${encodeURIComponent(id)}`
      const res = await call("GET", path)
      if (res.status === 404) return null
      await expectOk(res, path)
      return (await res.json()) as WorkflowRun
    },
    async cancelRun(id) {
      const path = `actions/runs/${encodeURIComponent(id)}/cancel`
      await expectOk(await call("POST", path), path, [409])
    },
    async getPullDetail(pr) {
      return json<PullDetail>(`pulls/${pr}`)
    },
    async listOpenPulls(baseRef) {
      return all<PullDetail>(`pulls?state=open&base=${encodeURIComponent(baseRef)}&per_page=100`)
    },
    async listPullFiles(pr) {
      return all<PullFile>(`pulls/${pr}/files?per_page=100`)
    },
    async mergeBase(baseRef, head) {
      const body = await json<{ merge_base_commit?: { sha?: string } }>(`compare/${encodeURIComponent(baseRef)}...${encodeURIComponent(head)}`)
      const sha = body.merge_base_commit?.sha ?? ""
      if (!SHA.test(sha)) throw new Error(`no merge base for ${baseRef}...${head}`)
      return sha
    },
    async commitMessage(sha) {
      if (!SHA.test(sha)) throw new Error(`not a full sha: "${sha}"`)
      return (await json<{ message?: string }>(`git/commits/${sha}`)).message ?? ""
    },
    async listArtifacts(runId) {
      return all<ArtifactInfo>(`actions/runs/${encodeURIComponent(runId)}/artifacts?per_page=100`, "artifacts")
    },
    async getJson<T>(path: string) {
      const res = await call("GET", path ? base + path : base.replace(/\/$/, ""))
      if (res.status === 404) return null
      await expectOk(res, path)
      return (await res.json()) as T
    },
    async compareFiles(baseSha, headSha) {
      if (!SHA.test(baseSha) || !SHA.test(headSha)) throw new Error("compare needs full shas")
      const body = await json<{ files?: Array<{ filename: string; previous_filename?: string }> }>(`compare/${baseSha}...${headSha}?per_page=300`)
      const files = body.files ?? []
      return { files: [...new Set(files.flatMap((f) => [f.filename, f.previous_filename ?? ""]).filter(Boolean))].sort(), complete: files.length < 300 }
    },
    async downloadArtifact(artifactId) {
      const path = `actions/artifacts/${artifactId}/zip`
      const res = await call("GET", path)
      await expectOk(res, path)
      return Buffer.from(await res.arrayBuffer())
    },
    async readContent(path, ref) {
      const p = `contents/${path.split("/").map(encodeURIComponent).join("/")}?ref=${encodeURIComponent(ref)}`
      const res = await call("GET", p)
      if (res.status === 404) return null
      await expectOk(res, p)
      const body = (await res.json()) as { content?: string; encoding?: string; sha?: string }
      if (body.encoding !== "base64" || typeof body.content !== "string" || !body.sha) throw new Error(`unexpected content for ${path}`)
      return { text: Buffer.from(body.content, "base64").toString("utf8"), sha: body.sha }
    },
    async writeContent(path, branch, text, message, sha) {
      if (branch !== MAP_STORE_BRANCH || path !== MAP_INDEX_PATH) {
        throw new Error(`refused: setup writes only ${MAP_INDEX_PATH} on ${MAP_STORE_BRANCH}`)
      }
      const p = `contents/${path.split("/").map(encodeURIComponent).join("/")}`
      const body: Record<string, string> = { message, branch, content: Buffer.from(text, "utf8").toString("base64") }
      if (sha) body.sha = sha
      await expectOk(await call("PUT", p, body), p)
    },
  }
}

export function mapIndexStore(gh: Pick<SetupGitHub, "readContent" | "writeContent">): IndexStore {
  let lastSha: string | null = null
  return {
    async readIndex(): Promise<StoreIndex> {
      const doc = await gh.readContent(MAP_INDEX_PATH, MAP_STORE_BRANCH)
      lastSha = doc?.sha ?? null
      return doc ? parseIndex(JSON.parse(doc.text)) : emptyIndex()
    },
    async writeIndex(index, message) {
      await gh.writeContent(MAP_INDEX_PATH, MAP_STORE_BRANCH, JSON.stringify(index, null, 2) + "\n", message, lastSha)
    },
  }
}
