export const MAP_BRANCH = "e2e/map"
export const INDEX_PATH = "maps/index.json"
export const MAX_DISTANCE = 50
export const MAX_AGE_MS = 7 * 24 * 60 * 60 * 1000
export const SUPPORTED_MAJORS: readonly number[] = [1]

export type MapStatus = "published" | "failed-partition" | "failed-job"

export type MapIndexEntry = {
  stagingSha: string
  builtAt: string
  schemaVersion: string | number
  status: MapStatus
  reason?: string
}

export type MapLookupResult =
  | {
      ok: true
      mapSha: string
      builtAt: string
      schemaVersion: string | number
      distance: number
      ageMs: number
    }
  | { ok: false; fullRun: "map-stale" | "map-fetch-failed"; detail: string }

const STATUSES: readonly MapStatus[] = ["published", "failed-partition", "failed-job"]
const SHA = /^[0-9a-f]{40}$/

export function parseIndex(text: string): MapIndexEntry[] | string {
  let raw: unknown
  try {
    raw = JSON.parse(text)
  } catch (e) {
    return `index.json is not JSON: ${(e as Error).message}`
  }
  const list =
    Array.isArray(raw)
      ? raw
      : raw && typeof raw === "object" && Array.isArray((raw as { entries?: unknown }).entries)
        ? (raw as { entries: unknown[] }).entries
        : null
  if (!list) return "index.json has no entries array"
  const out: MapIndexEntry[] = []
  for (const [i, e] of list.entries()) {
    if (!e || typeof e !== "object") return `entry ${i} is not an object`
    const r = e as Record<string, unknown>
    if (typeof r.stagingSha !== "string" || !SHA.test(r.stagingSha)) return `entry ${i}: bad stagingSha`
    if (typeof r.builtAt !== "string" || Number.isNaN(Date.parse(r.builtAt))) return `entry ${i}: bad builtAt`
    if (typeof r.schemaVersion !== "string" && typeof r.schemaVersion !== "number") return `entry ${i}: bad schemaVersion`
    if (typeof r.status !== "string" || !STATUSES.includes(r.status as MapStatus)) return `entry ${i}: bad status`
    if (r.reason !== undefined && typeof r.reason !== "string") return `entry ${i}: bad reason`
    out.push({
      stagingSha: r.stagingSha,
      builtAt: r.builtAt,
      schemaVersion: r.schemaVersion,
      status: r.status as MapStatus,
      ...(r.reason !== undefined ? { reason: r.reason as string } : {}),
    })
  }
  return out
}

export function schemaMajor(v: string | number): number | null {
  const m = /^(\d+)(\.\d+)*$/.exec(String(v))
  return m ? Number(m[1]) : null
}

export function parseRevList(text: string): string[] {
  return text
    .split("\n")
    .map((l) => l.trim())
    .filter((l) => l.length > 0)
}

export function lookupMap(input: {
  indexText: string | null
  fetchError?: string
  firstParent: string[]
  referenceTime: string
  supportedMajors?: readonly number[]
}): MapLookupResult {
  if (input.indexText === null) {
    return { ok: false, fullRun: "map-fetch-failed", detail: input.fetchError ?? "e2e/map fetch failed" }
  }
  const index = parseIndex(input.indexText)
  if (typeof index === "string") return { ok: false, fullRun: "map-fetch-failed", detail: index }
  const ref = Date.parse(input.referenceTime)
  if (Number.isNaN(ref)) return { ok: false, fullRun: "map-fetch-failed", detail: "bad reference time" }
  const majors = input.supportedMajors ?? SUPPORTED_MAJORS

  const bySha = new Map<string, MapIndexEntry[]>()
  for (const e of index) {
    if (e.status !== "published") continue
    const major = schemaMajor(e.schemaVersion)
    if (major === null || !majors.includes(major)) continue
    const list = bySha.get(e.stagingSha) ?? []
    list.push(e)
    bySha.set(e.stagingSha, list)
  }

  let outside: string | null = null
  for (let distance = 0; distance < input.firstParent.length; distance++) {
    const sha = input.firstParent[distance]
    const entries = bySha.get(sha)
    if (!entries) continue
    if (distance > MAX_DISTANCE) {
      outside ??= `newest published map ${sha} is ${distance} first-parent commits back (max ${MAX_DISTANCE})`
      break
    }
    const fresh = entries
      .map((e) => ({ e, ageMs: ref - Date.parse(e.builtAt) }))
      .filter((c) => c.ageMs <= MAX_AGE_MS)
      .sort((a, b) => a.ageMs - b.ageMs)
    if (fresh.length === 0) {
      outside ??= `published map ${sha} is older than 7 days`
      continue
    }
    const { e, ageMs } = fresh[0]
    return { ok: true, mapSha: sha, builtAt: e.builtAt, schemaVersion: e.schemaVersion, distance, ageMs }
  }
  return {
    ok: false,
    fullRun: "map-stale",
    detail: outside ?? `no published map within ${MAX_DISTANCE} first-parent commits`,
  }
}

export type Git = (args: string[]) => string

export function loadMapLookup(git: Git, base: string, head: string): MapLookupResult {
  let indexText: string
  try {
    git(["fetch", "--no-tags", "--depth=1", "origin", `+refs/heads/${MAP_BRANCH}:refs/remotes/origin/${MAP_BRANCH}`])
    indexText = git(["show", `refs/remotes/origin/${MAP_BRANCH}:${INDEX_PATH}`])
  } catch (e) {
    return { ok: false, fullRun: "map-fetch-failed", detail: (e as Error).message }
  }
  const mergeBase = git(["merge-base", base, head]).trim()
  const firstParent = parseRevList(
    git(["rev-list", "--first-parent", `--max-count=${MAX_DISTANCE + 1}`, mergeBase]),
  )
  const referenceTime = git(["show", "-s", "--format=%cI", mergeBase]).trim()
  return lookupMap({ indexText, firstParent, referenceTime })
}
