import {
  type IndexEntry,
  type IndexStatus,
  type ManifestIndex,
  MANIFEST_VERSION,
  validateManifestIndex,
} from "../../contract/manifest.js"

export const NIGHT_STATUSES = ["published", "failed-partition", "failed-job"] as const satisfies readonly IndexStatus[]
export type NightStatus = IndexStatus

export type NightEntry = Omit<IndexEntry, "reason"> & { reason?: string | null }

export type StoreIndex = ManifestIndex

export function emptyIndex(): StoreIndex {
  return { schemaVersion: MANIFEST_VERSION, latest: null, entries: [] }
}

function toEntry(entry: NightEntry, where: string): IndexEntry {
  if (!(NIGHT_STATUSES as readonly string[]).includes(entry.status)) {
    throw new Error(`${where}: unknown status "${entry.status}"`)
  }
  if (entry.status !== "published" && !entry.reason) {
    throw new Error(`${where}: a ${entry.status} night needs a reason`)
  }
  if (entry.status === "published" && entry.reason) {
    throw new Error(`${where}: a published night has no reason`)
  }
  return {
    stagingSha: entry.stagingSha,
    builtAt: entry.builtAt,
    schemaVersion: entry.schemaVersion,
    status: entry.status,
    reason: entry.status === "published" ? null : (entry.reason as string),
  }
}

function checked(index: StoreIndex, where: string): StoreIndex {
  const result = validateManifestIndex(index)
  if (!result.ok) throw new Error(`${where}: ${result.errors.join("; ")}`)
  return result.value
}

export function parseIndex(raw: unknown): StoreIndex {
  if (raw === null || typeof raw !== "object" || !Array.isArray((raw as StoreIndex).entries)) {
    throw new Error("index.json: expected an object with an entries array")
  }
  const entries = (raw as StoreIndex).entries.map((e, i) => toEntry(e, `index.json entries[${i}]`))
  return checked({ ...(raw as StoreIndex), entries, latest: latestPublished(entries) }, "index.json")
}

export function latestPublished(entries: readonly NightEntry[]): string | null {
  let best: NightEntry | null = null
  for (const n of entries) {
    if (n.status !== "published") continue
    if (!best || Date.parse(n.builtAt) > Date.parse(best.builtAt)) best = n
  }
  return best ? best.stagingSha : null
}

export function isPublished(index: StoreIndex, stagingSha: string): boolean {
  return index.entries.some((n) => n.status === "published" && n.stagingSha === stagingSha)
}

export function recordNight(index: StoreIndex, entry: NightEntry): StoreIndex {
  const entries = [...index.entries, toEntry(entry, "night")]
  return checked({ ...index, entries, latest: latestPublished(entries) }, "night")
}

export const NIGHT_FILE = "night.json"

const sameNight = (a: NightEntry, b: NightEntry) => a.stagingSha === b.stagingSha && a.builtAt === b.builtAt && a.status === b.status

export function foldNights(index: StoreIndex, nights: readonly NightEntry[]): StoreIndex {
  const entries: IndexEntry[] = [...index.entries]
  for (const [i, n] of nights.entries()) {
    if (n.status === "published") throw new Error(`folded night ${i}: only publish records a published night`)
    const entry = toEntry(n, `folded night ${i}`)
    if (!entries.some((e) => sameNight(e, entry))) entries.push(entry)
  }
  const sorted = entries.map((e, i) => ({ e, i })).sort((a, b) => Date.parse(a.e.builtAt) - Date.parse(b.e.builtAt) || a.i - b.i).map((x) => x.e)
  return checked({ ...index, entries: sorted, latest: latestPublished(sorted) }, "folded index")
}
