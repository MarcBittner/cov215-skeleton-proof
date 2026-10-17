export const NIGHT_STATUSES = ["published", "failed-partition", "failed-job"] as const
export type NightStatus = (typeof NIGHT_STATUSES)[number]

export interface NightEntry {
  stagingSha: string
  builtAt: string
  schemaVersion: string
  status: NightStatus
  reason?: string
}

export interface StoreIndex {
  nights: NightEntry[]
  latest: string | null
}

const SHA = /^[0-9a-f]{40}$/

export function emptyIndex(): StoreIndex {
  return { nights: [], latest: null }
}

function assertEntry(entry: NightEntry, where: string): void {
  if (!SHA.test(entry.stagingSha)) throw new Error(`${where}: stagingSha must be a 40-hex sha`)
  if (Number.isNaN(Date.parse(entry.builtAt))) throw new Error(`${where}: builtAt is not a date`)
  if (typeof entry.schemaVersion !== "string" || !entry.schemaVersion) {
    throw new Error(`${where}: schemaVersion missing`)
  }
  if (!(NIGHT_STATUSES as readonly string[]).includes(entry.status)) {
    throw new Error(`${where}: unknown status "${entry.status}"`)
  }
  if (entry.status !== "published" && !entry.reason) {
    throw new Error(`${where}: a ${entry.status} night needs a reason`)
  }
}

export function parseIndex(raw: unknown): StoreIndex {
  if (raw === null || typeof raw !== "object" || !Array.isArray((raw as StoreIndex).nights)) {
    throw new Error("index.json: expected an object with a nights array")
  }
  const nights = (raw as StoreIndex).nights.map((n, i) => {
    assertEntry(n, `index.json nights[${i}]`)
    return { ...n }
  })
  return { nights, latest: latestPublished(nights) }
}

export function latestPublished(nights: readonly NightEntry[]): string | null {
  let best: NightEntry | null = null
  for (const n of nights) {
    if (n.status !== "published") continue
    if (!best || Date.parse(n.builtAt) > Date.parse(best.builtAt)) best = n
  }
  return best ? best.stagingSha : null
}

export function isPublished(index: StoreIndex, stagingSha: string): boolean {
  return index.nights.some((n) => n.status === "published" && n.stagingSha === stagingSha)
}

export function recordNight(index: StoreIndex, entry: NightEntry): StoreIndex {
  assertEntry(entry, "night")
  const nights = [...index.nights, { ...entry }]
  return { nights, latest: latestPublished(nights) }
}
