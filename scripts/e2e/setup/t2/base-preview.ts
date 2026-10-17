import { baseBranchName, deleteRunBranch, liveRunBranches, parseToolingBranch, type GitRefs } from "./branches.js"
import type { Fetch } from "./github.js"

export const DEFECT_LABEL = "Defect"
export const BASE_MAX_AGE_MS = 7 * 24 * 60 * 60_000
export const LINEAR_API = "https://api.linear.app/graphql"

const ISSUE_KEY = /\b(COV-\d+)\b/i

export function issueKeyOf(branch: string, title: string): string | null {
  const m = ISSUE_KEY.exec(branch) ?? ISSUE_KEY.exec(title)
  return m ? m[1].toUpperCase() : null
}

export function isDefect(labels: readonly string[] | null): boolean {
  return labels !== null && labels.includes(DEFECT_LABEL)
}

export type IssueLabels = (key: string) => Promise<string[] | null>

export function linearIssueLabels(opts: { apiKey: string; fetch?: Fetch }): IssueLabels {
  if (!opts.apiKey) throw new Error("LINEAR_API_KEY is not set")
  const doFetch: Fetch = opts.fetch ?? ((url, init) => globalThis.fetch(url, init))
  return async (key) => {
    const res = await doFetch(LINEAR_API, {
      method: "POST",
      headers: { Authorization: opts.apiKey, "Content-Type": "application/json" },
      body: JSON.stringify({ query: "query($id: String!) { issue(id: $id) { labels { nodes { name } } } }", variables: { id: key } }),
      signal: AbortSignal.timeout(30_000),
    })
    if (!res.ok) throw new Error(`Linear ${res.status} for ${key}`)
    const body = (await res.json()) as { data?: { issue?: { labels?: { nodes?: Array<{ name?: unknown }> } } | null }; errors?: unknown[] }
    if (body.errors?.length) {
      if (body.data?.issue === null) return null
      throw new Error(`Linear error for ${key}`)
    }
    const issue = body.data?.issue
    if (!issue) return null
    return (issue.labels?.nodes ?? []).map((n) => String(n.name ?? ""))
  }
}

export type BaseDecision =
  | { run: false; reason: string }
  | { run: true; issue: string; branch: string; mergeBase: string; specs: string[] }

export function changedSpecs(files: ReadonlyArray<{ filename: string; status: string }>): string[] {
  return files
    .filter((f) => f.status !== "removed" && /^e2e\/.+\.spec\.ts$/.test(f.filename))
    .map((f) => f.filename)
    .sort()
}

export async function decideBaseRun(input: {
  branch: string
  title: string
  files: ReadonlyArray<{ filename: string; status: string }>
  mergeBase: () => Promise<string>
  labels: IssueLabels | null
}): Promise<BaseDecision> {
  const issue = issueKeyOf(input.branch, input.title)
  if (!issue) return { run: false, reason: "no COV issue key in the branch or title" }
  if (!input.labels) return { run: false, reason: "no Linear key in setup" }
  const labels = await input.labels(issue)
  if (labels === null) return { run: false, reason: `${issue} not found in Linear` }
  if (!isDefect(labels)) return { run: false, reason: `${issue} is not a ${DEFECT_LABEL}` }
  const specs = changedSpecs(input.files)
  if (specs.length === 0) return { run: false, reason: `${issue} is a ${DEFECT_LABEL} but the PR adds or changes no spec` }
  const mergeBase = await input.mergeBase()
  return { run: true, issue, branch: baseBranchName(mergeBase), mergeBase, specs }
}

export async function pruneBaseBranches(
  git: GitRefs,
  createdAt: (branch: string, sha: string) => Promise<number | null>,
  nowMs: number,
  maxAgeMs = BASE_MAX_AGE_MS,
): Promise<{ deleted: string[]; kept: string[]; unknown: string[] }> {
  const out = { deleted: [] as string[], kept: [] as string[], unknown: [] as string[] }
  for (const b of await liveRunBranches(git)) {
    if (parseToolingBranch(b.name)?.kind !== "base") continue
    const at = await createdAt(b.name, b.sha)
    if (at === null) out.unknown.push(b.name)
    else if (nowMs - at > maxAgeMs) {
      await deleteRunBranch(git, b.name)
      out.deleted.push(b.name)
    } else out.kept.push(b.name)
  }
  return out
}

export async function branchCreatedAt(
  listDeploymentsForRef: (ref: string) => Promise<ReadonlyArray<{ ref: string; created_at: string }>>,
  branch: string,
): Promise<number | null> {
  const times = (await listDeploymentsForRef(branch))
    .filter((d) => d.ref === branch)
    .map((d) => Date.parse(d.created_at))
    .filter((t) => Number.isFinite(t))
  return times.length ? Math.min(...times) : null
}
