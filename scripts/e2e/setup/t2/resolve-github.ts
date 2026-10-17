import type { GitHubDeployment, GitHubDeploymentStatus, GitHubPull, GitHubReader } from "./resolve.js"

export type Fetch = (url: string, init?: RequestInit) => Promise<Response>

const API = "https://api.github.com"
const REQUEST_TIMEOUT_MS = 30 * 1000

export function nextLink(link: string | null): string | null {
  if (!link) return null
  for (const part of link.split(",")) {
    const m = part.match(/<([^>]+)>\s*;\s*rel="next"/)
    if (m) return m[1]
  }
  return null
}

export function createGitHubReader({
  repo,
  token,
  fetch = globalThis.fetch,
}: {
  repo: string
  token: string
  fetch?: Fetch
}): GitHubReader {
  if (!/^[\w.-]+\/[\w.-]+$/.test(repo)) throw new Error(`bad repo ${repo}`)
  if (!token) throw new Error("GITHUB_TOKEN is not set")
  const headers = {
    Accept: "application/vnd.github+json",
    Authorization: `Bearer ${token}`,
    "X-GitHub-Api-Version": "2022-11-28",
  }

  async function page(url: string): Promise<{ body: unknown; next: string | null }> {
    if (!url.startsWith(`${API}/`)) throw new Error(`refusing ${url}`)
    const res = await fetch(url, { headers, signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS) })
    if (!res.ok) throw new Error(`GitHub ${res.status} for ${new URL(url).pathname}`)
    return { body: await res.json(), next: nextLink(res.headers.get("link")) }
  }

  async function all<T>(path: string): Promise<T[]> {
    const items: T[] = []
    let url: string | null = `${API}/repos/${repo}/${path}`
    while (url) {
      const { body, next } = await page(url)
      if (!Array.isArray(body)) throw new Error(`expected a list from ${path}`)
      items.push(...(body as T[]))
      url = next
    }
    return items
  }

  return {
    async getPull(pr) {
      return (await page(`${API}/repos/${repo}/pulls/${pr}`)).body as GitHubPull
    },
    async listPullCommitShas(pr) {
      return (await all<{ sha: string }>(`pulls/${pr}/commits?per_page=100`)).map((c) => c.sha)
    },
    listDeployments(sha) {
      return all<GitHubDeployment>(`deployments?sha=${encodeURIComponent(sha)}&per_page=100`)
    },
    listDeploymentStatuses(id) {
      return all<GitHubDeploymentStatus>(`deployments/${id}/statuses?per_page=100`)
    },
  }
}
