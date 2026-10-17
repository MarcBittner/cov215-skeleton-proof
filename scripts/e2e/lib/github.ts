import { appendFileSync, readFileSync } from "node:fs"

import JSZip from "jszip"

export type Fetch = typeof fetch

export interface GitHub {
  repo: string
  get<T>(path: string, version?: string): Promise<T | null>
  send<T>(method: string, path: string, body?: unknown, version?: string): Promise<{ status: number; body: T }>
  bytes(path: string): Promise<Buffer>
}

export class GitHubError extends Error {
  constructor(
    message: string,
    readonly status: number,
  ) {
    super(message)
  }
}

export function gitHubClient({ repo, token, apiUrl = "https://api.github.com", fetchImpl = fetch }: { repo: string; token: string; apiUrl?: string; fetchImpl?: Fetch }): GitHub {
  if (!/^[\w.-]+\/[\w.-]+$/.test(repo)) throw new Error(`bad repository "${repo}"`)
  if (!token) throw new Error("GitHub token missing")
  const url = (path: string) => `${apiUrl}/repos/${repo}${path}`
  const headers = (version: string, body: boolean) => ({
    authorization: `Bearer ${token}`,
    accept: "application/vnd.github+json",
    "x-github-api-version": version,
    ...(body ? { "content-type": "application/json" } : {}),
  })
  async function send<T>(method: string, path: string, body?: unknown, version = "2022-11-28") {
    const res = await fetchImpl(url(path), { method, headers: headers(version, body !== undefined), body: body === undefined ? undefined : JSON.stringify(body) })
    const text = await res.text()
    if (res.status >= 400) throw new GitHubError(`${method} ${path}: ${res.status} ${text.slice(0, 300)}`, res.status)
    return { status: res.status, body: (text ? JSON.parse(text) : null) as T }
  }
  return {
    repo,
    async get<T>(path: string, version?: string) {
      try {
        return (await send<T>("GET", path, undefined, version)).body
      } catch (e) {
        if (e instanceof GitHubError && e.status === 404) return null
        throw e
      }
    },
    send,
    async bytes(path: string) {
      const res = await fetchImpl(url(path), { headers: headers("2022-11-28", false) })
      if (!res.ok) throw new GitHubError(`GET ${path}: ${res.status}`, res.status)
      return Buffer.from(await res.arrayBuffer())
    },
  }
}

export interface Artifact {
  id: number
  name: string
  expired: boolean
  created_at?: string
}

export async function runArtifacts(gh: GitHub, runId: string, name?: string) {
  const q = name ? `&name=${encodeURIComponent(name)}` : ""
  const body = await gh.get<{ artifacts: Artifact[] }>(`/actions/runs/${runId}/artifacts?per_page=100${q}`)
  return (body?.artifacts ?? []).filter((a) => !a.expired)
}

export async function artifactFile(gh: GitHub, artifact: Artifact, file: string): Promise<string | null> {
  const zip = await JSZip.loadAsync(await gh.bytes(`/actions/artifacts/${artifact.id}/zip`))
  const entry = zip.file(file)
  return entry ? entry.async("string") : null
}

export async function runArtifactJson<T>(gh: GitHub, runId: string, name: string, file: string): Promise<T | null> {
  const [artifact] = await runArtifacts(gh, runId, name)
  if (!artifact) return null
  const text = await artifactFile(gh, artifact, file)
  return text === null ? null : (JSON.parse(text) as T)
}

export function env(name: string, source: Record<string, string | undefined> = process.env) {
  const v = source[name]
  if (!v) throw new Error(`${name} is not set`)
  return v
}

export function output(pairs: Record<string, string>, source: Record<string, string | undefined> = process.env) {
  const text = Object.entries(pairs)
    .map(([k, v]) => {
      if (/[\r\n]/.test(v)) throw new Error(`output ${k} holds a newline`)
      return `${k}=${v}\n`
    })
    .join("")
  if (source.GITHUB_OUTPUT) appendFileSync(source.GITHUB_OUTPUT, text)
  else process.stdout.write(text)
}

export function summary(md: string, source: Record<string, string | undefined> = process.env) {
  if (source.GITHUB_STEP_SUMMARY) appendFileSync(source.GITHUB_STEP_SUMMARY, md + "\n")
  process.stdout.write(md + "\n")
}

export function readJsonFile<T>(path: string): T {
  return JSON.parse(readFileSync(path, "utf8")) as T
}
