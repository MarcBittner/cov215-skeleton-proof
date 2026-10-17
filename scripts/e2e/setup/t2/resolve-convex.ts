export type ConvexTarget = { deployment: string; url: string }

export type FetchText = (url: string) => Promise<string>

const SCRIPT_SRC = /<script\b[^>]*\ssrc="([^"]+)"/g
const CLIENT_URL = /ConvexReactClient\(\s*["'`](https:\/\/([a-z0-9-]+)\.convex\.cloud)["'`]\s*[,)]/g

export function scriptUrls(html: string, pageUrl: string): string[] {
  const origin = new URL(pageUrl).origin
  const urls = new Set<string>()
  for (const m of html.matchAll(SCRIPT_SRC)) {
    const src = new URL(m[1].replace(/&amp;/g, "&"), pageUrl)
    if (src.origin === origin && src.pathname.startsWith("/_next/static/")) urls.add(src.href)
  }
  return [...urls]
}

export function convexClientUrls(scripts: string[]): ConvexTarget[] {
  const found = new Map<string, ConvexTarget>()
  for (const text of scripts) {
    for (const m of text.matchAll(CLIENT_URL)) found.set(m[1], { deployment: m[2], url: m[1] })
  }
  return [...found.values()]
}

export async function readConvexTarget(previewUrl: string, fetchText: FetchText): Promise<ConvexTarget> {
  const page = new URL("/sign-in", previewUrl).href
  const urls = scriptUrls(await fetchText(page), page)
  if (urls.length === 0) throw new Error(`no script on ${page}`)
  const targets = convexClientUrls(await Promise.all(urls.map(fetchText)))
  if (targets.length !== 1) {
    throw new Error(
      `expected one Convex client URL on ${page}, found ${targets.length}` +
        (targets.length ? `: ${targets.map((t) => t.url).join(", ")}` : ""),
    )
  }
  return targets[0]
}
