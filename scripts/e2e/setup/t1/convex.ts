export interface ConvexCaller {
  readonly url: string
  query<T = unknown>(path: string, args?: Record<string, unknown>): Promise<T>
  mutation<T = unknown>(path: string, args?: Record<string, unknown>): Promise<T>
}

export class ConvexCallError extends Error {
  constructor(
    readonly fn: string,
    readonly status: number,
    message: string,
  ) {
    super(`${fn}: ${message}`)
    this.name = "ConvexCallError"
  }
}

interface ConvexHttpResult {
  status?: string
  value?: unknown
  errorMessage?: string
}

export type ConvexFactory = (convexUrl: string, jwt: string) => ConvexCaller

export function httpConvexFactory(fetchImpl: typeof fetch = fetch): ConvexFactory {
  return (convexUrl, jwt) => {
    const base = convexUrl.replace(/\/+$/, "")
    const call = async <T>(kind: "query" | "mutation", path: string, args: Record<string, unknown>) => {
      const res = await fetchImpl(`${base}/api/${kind}`, {
        method: "POST",
        headers: {
          Authorization: `Bearer ${jwt}`,
          "Content-Type": "application/json",
        },
        body: JSON.stringify({ path, args, format: "json" }),
      })
      let out: ConvexHttpResult | null = null
      try {
        out = (await res.json()) as ConvexHttpResult
      } catch {
        out = null
      }
      if (!res.ok || !out || out.status !== "success") {
        throw new ConvexCallError(path, res.status, String(out?.errorMessage ?? `HTTP ${res.status}`).slice(0, 300))
      }
      return out.value as T
    }
    return {
      url: base,
      query: <T>(path: string, args: Record<string, unknown> = {}) => call<T>("query", path, args),
      mutation: <T>(path: string, args: Record<string, unknown> = {}) => call<T>("mutation", path, args),
    }
  }
}

export function deployAdminCaller(target: { url: string; adminKey: string }, fetchImpl: typeof fetch = fetch): ConvexCaller {
  const base = target.url.replace(/\/+$/, "")
  const call = async <T>(path: string, args: Record<string, unknown>) => {
    const res = await fetchImpl(`${base}/api/function`, {
      method: "POST",
      headers: {
        Authorization: `Convex ${target.adminKey}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({ path, args, format: "json" }),
    })
    let out: ConvexHttpResult | null = null
    try {
      out = (await res.json()) as ConvexHttpResult
    } catch {
      out = null
    }
    if (!res.ok || !out || out.status !== "success") {
      throw new ConvexCallError(path, res.status, String(out?.errorMessage ?? `HTTP ${res.status}`).slice(0, 300))
    }
    return out.value as T
  }
  return {
    url: base,
    query: <T>(path: string, args: Record<string, unknown> = {}) => call<T>(path, args),
    mutation: <T>(path: string, args: Record<string, unknown> = {}) => call<T>(path, args),
  }
}
