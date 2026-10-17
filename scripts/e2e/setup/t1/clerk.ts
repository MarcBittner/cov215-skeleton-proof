export interface ClerkResponse {
  status: number
  body: unknown
  retryAfterMs: number | null
}

export interface ClerkClient {
  call(
    method: "GET" | "POST" | "DELETE",
    path: string,
    opts?: { body?: unknown; query?: Record<string, string | number> },
  ): Promise<ClerkResponse>
}

export const CLERK_API_BASE = "https://api.clerk.com"

export function httpClerkClient(opts: {
  secret: string
  baseUrl?: string
  fetch?: typeof fetch
}): ClerkClient {
  const base = (opts.baseUrl ?? CLERK_API_BASE).replace(/\/+$/, "")
  if (base !== CLERK_API_BASE) throw new Error(`Clerk base URL ${base} is not ${CLERK_API_BASE}; the Clerk secret goes nowhere else`)
  const doFetch = opts.fetch ?? fetch
  if (!opts.secret) throw new Error("Clerk secret is empty")
  return {
    async call(method, path, callOpts = {}) {
      let url = base + path
      if (callOpts.query) {
        const q = new URLSearchParams()
        for (const [k, v] of Object.entries(callOpts.query)) q.set(k, String(v))
        url += `?${q.toString()}`
      }
      const headers: Record<string, string> = {
        Authorization: `Bearer ${opts.secret}`,
        "User-Agent": "co-ver-e2e-setup/1",
      }
      let body: string | undefined
      if (callOpts.body !== undefined) {
        headers["Content-Type"] = "application/json"
        body = JSON.stringify(callOpts.body)
      }
      const res = await doFetch(url, { method, headers, body })
      const raw = await res.text()
      let parsed: unknown = null
      if (raw) {
        try {
          parsed = JSON.parse(raw)
        } catch {
          parsed = null
        }
      }
      const ra = Number(res.headers.get("retry-after"))
      return {
        status: res.status,
        body: parsed,
        retryAfterMs: Number.isFinite(ra) && ra > 0 ? ra * 1000 : null,
      }
    },
  }
}

export function clerkErrorCode(body: unknown): string {
  if (body && typeof body === "object" && Array.isArray((body as { errors?: unknown }).errors)) {
    const first = (body as { errors: Array<{ code?: unknown }> }).errors[0]
    if (first && typeof first.code === "string") return first.code.slice(0, 80)
  }
  return ""
}

export function listData<T>(body: unknown): T[] {
  if (Array.isArray(body)) return body as T[]
  if (body && typeof body === "object" && Array.isArray((body as { data?: unknown }).data)) {
    return (body as { data: T[] }).data
  }
  return []
}
