// Split the test suite into N shards that take about the SAME TIME, instead of
// N shards that contain the same NUMBER OF FILES.
//
// WHY
// ---
// vitest's own `--shard i/N` sorts specs by the sha1 of their path and slices
// equal COUNTS (BaseSequencer.shard). That is a partition — nothing is dropped
// — but it assumes every file costs the same, and they do not. Measured on CI
// run 1847, eight legs of 158-159 files each:
//
//     131  117  108  98  97  91  84  70   seconds     mean 99
//
// The slowest leg is 1.9x the fastest, and the slowest leg IS the wall clock:
// nothing else on that run finished later. Balancing toward the mean is worth
// more than two extra runners and costs nothing.
//
// ⛔ THIS CHANGES WHICH SHARD A FILE RUNS IN. IT CHANGES NOTHING ELSE. No file
// is dropped, skipped, excluded or shortened; `assignShards` returns a
// partition of exactly the input, and `scripts/check-test-shards.mjs` re-proves
// that empirically on every CI run out of what the legs ACTUALLY ran. This
// module is the plan; that script is the audit, and the audit does not trust
// the plan.
//
// ⚠️ WHAT HAPPENS WHEN THE TIMINGS GO STALE — this is the question that breaks
// naive versions of this idea, so it is answered here rather than hoped about:
//
//   * A file with NO recorded duration is not weightless and is not dropped. It
//     gets `unknownWeight` — the 75th percentile of the files that live in the
//     same directory, falling back to the 75th percentile of its project family
//     (`components` costs several times what a `unit` file costs), then to the
//     75th percentile of everything known. A p75 rather than a median because
//     the failure that hurts is UNDER-weighting a new heavy file; over-weighting
//     one merely gives it a quieter shard.
//   * Many new files at once do not pile into one leg: they all carry the same
//     fallback weight, and longest-processing-time packing spreads equal weights
//     round-robin across the bins by construction.
//   * If the manifest is missing or empty, every weight is equal and this
//     degenerates to a deterministic round-robin over sorted paths — no worse
//     than today's sha1 draw, and still a complete partition.
//
//   So drift costs BALANCE and never FIDELITY. The worst a maximally stale
//   manifest can do is give back the imbalance we started with. And it does not
//   drift silently: the `Tests` gate job runs `scripts/test-timings.mjs report`,
//   prints how much measured work each leg actually carried, and annotates the
//   run + publishes a refreshed manifest as soon as the spread or the number of
//   unrecorded files crosses a threshold.
//
// The decision logic here is pure and unit-tested in
// __tests__/lib/shard-balance.test.ts. scripts/test-sequencer.mjs is the thin
// vitest adapter around it.

import { existsSync, readFileSync } from "node:fs"
import path from "node:path"
import { fileURLToPath } from "node:url"

export const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..")
export const TIMINGS_FILE = "test-timings.json"

/** Recorded runtimes, keyed by repo-relative path, in milliseconds. */
export function loadTimings(root = ROOT) {
  const file = path.join(root, TIMINGS_FILE)
  if (!existsSync(file)) return {}
  try {
    const parsed = JSON.parse(readFileSync(file, "utf8"))
    const durations = parsed && typeof parsed === "object" ? parsed.durations : null
    if (!durations || typeof durations !== "object") return {}
    const out = {}
    for (const [key, value] of Object.entries(durations)) {
      if (typeof value === "number" && Number.isFinite(value) && value >= 0) out[key] = value
    }
    return out
  } catch {
    // A corrupt manifest must not stop the suite from running. Equal weights is
    // the documented degenerate case, not an outage.
    return {}
  }
}

/** Linear-interpolated percentile of an unsorted numeric array; 0 when empty. */
export function percentile(values, p) {
  if (values.length === 0) return 0
  const sorted = [...values].sort((a, b) => a - b)
  if (sorted.length === 1) return sorted[0]
  const rank = (sorted.length - 1) * p
  const low = Math.floor(rank)
  const high = Math.ceil(rank)
  if (low === high) return sorted[low]
  return sorted[low] + (sorted[high] - sorted[low]) * (rank - low)
}

/**
 * `components` files run under jsdom with `isolate: true` — a fresh child
 * process, a fresh DOM and a fresh React import each — so they cost several
 * times what a `unit` file costs. A new file's fallback weight must come from
 * its own family or it is systematically wrong for exactly the files that
 * matter most.
 */
export function familyOf(relPath) {
  return relPath.startsWith("__tests__/components/") ? "components" : "unit"
}

export function dirOf(relPath) {
  const cut = relPath.lastIndexOf("/")
  return cut === -1 ? "" : relPath.slice(0, cut)
}

/**
 * Weight every path: the recorded duration when there is one, otherwise the
 * p75 of the nearest known neighbourhood. Returns a Map of path -> ms, and the
 * list of paths that had no recorded duration.
 */
export function buildWeights(relPaths, timings) {
  const known = relPaths.filter((p) => typeof timings[p] === "number")
  const unknown = relPaths.filter((p) => typeof timings[p] !== "number")

  const byDir = new Map()
  const byFamily = new Map()
  for (const p of known) {
    const d = dirOf(p)
    const f = familyOf(p)
    if (!byDir.has(d)) byDir.set(d, [])
    if (!byFamily.has(f)) byFamily.set(f, [])
    byDir.get(d).push(timings[p])
    byFamily.get(f).push(timings[p])
  }
  const globalP75 = percentile(
    known.map((p) => timings[p]),
    0.75,
  )

  const weights = new Map()
  for (const p of known) weights.set(p, timings[p])
  for (const p of unknown) {
    const dirSamples = byDir.get(dirOf(p))
    const familySamples = byFamily.get(familyOf(p))
    const fallback =
      (dirSamples && dirSamples.length ? percentile(dirSamples, 0.75) : 0) ||
      (familySamples && familySamples.length ? percentile(familySamples, 0.75) : 0) ||
      globalP75 ||
      1
    weights.set(p, fallback)
  }
  return { weights, unknown }
}

/**
 * Longest-processing-time bin packing: heaviest item first, always into the
 * lightest bin so far. Greedy LPT is within 4/3 of optimal for this problem and
 * is O(n·k) — 1,266 files into 8 bins is under a millisecond — but the reason
 * it is the right choice here is DETERMINISM, not optimality: every one of the
 * eight legs computes this independently and they must agree exactly, or a file
 * runs twice or not at all.
 *
 * Determinism comes from (a) sorting descending by weight with the item id as
 * the tie-break, so the order does not depend on the order the caller globbed
 * the files in, and (b) `<` rather than `<=` when choosing the lightest bin, so
 * ties always go to the lowest-numbered bin.
 *
 * Takes an array of `{ id, weight }` and a bin count. Returns an array of
 * `count` arrays of ids. With at least `count` items no bin comes back empty:
 * the first `count` items each land in a distinct empty bin.
 */
export function packByRuntime(items, count) {
  if (!Number.isInteger(count) || count < 1) throw new Error(`shard count must be a positive integer, got ${count}`)
  const bins = Array.from({ length: count }, () => ({ load: 0, ids: [] }))
  const ordered = [...items].sort((a, b) => {
    if (b.weight !== a.weight) return b.weight - a.weight
    return a.id < b.id ? -1 : a.id > b.id ? 1 : 0
  })
  for (const item of ordered) {
    let best = 0
    for (let i = 1; i < count; i += 1) {
      if (bins[i].load < bins[best].load) best = i
    }
    bins[best].ids.push(item.id)
    bins[best].load += item.weight
  }
  return bins.map((b) => b.ids)
}

/**
 * The whole decision in one call. Takes the ids to partition, a function from
 * id to its repo-relative path (they differ: an id carries the vitest project
 * name so the same file in two projects stays two items), the recorded
 * timings, and the shard count.
 *
 * Returns `bins` (ids per shard, index 0 == shard 1), `weights`, and `unknown`
 * — the repo-relative paths that had no recorded duration, so the caller can
 * say so out loud instead of quietly guessing.
 */
export function assignShards({ ids, relPathOf, timings, count }) {
  const relPaths = [...new Set(ids.map(relPathOf))]
  const { weights, unknown } = buildWeights(relPaths, timings)
  const items = ids.map((id) => ({ id, weight: weights.get(relPathOf(id)) ?? 0 }))
  return { bins: packByRuntime(items, count), weights, unknown }
}

/** Total weight of each bin, for logging and for the drift report. */
export function binLoads(bins, weightOfId) {
  return bins.map((ids) => ids.reduce((sum, id) => sum + weightOfId(id), 0))
}
