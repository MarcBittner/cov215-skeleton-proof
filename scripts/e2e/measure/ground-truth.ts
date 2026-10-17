import { sha256Hex } from "./rng.js"

export const SAMPLE_PERCENT = 17

export function sampledPush(pr: number, headSha: string): boolean {
  const h = BigInt(`0x${sha256Hex(String(pr), headSha)}`)
  return Number(h % BigInt(100)) < SAMPLE_PERCENT
}

export function needsGroundTruth(selectMode: "full" | "select", pr: number, headSha: string): boolean {
  return selectMode === "full" || sampledPush(pr, headSha)
}

export type Push = { pr: number; headSha: string; groundTruth: boolean }

export function sampleRates(pushes: readonly Push[]): {
  pushes: number
  sampledPushes: number
  pushRate: number | null
  prs: number
  prsWithSample: number
  prShare: number | null
} {
  const prs = new Map<number, boolean>()
  let sampled = 0
  for (const p of pushes) {
    if (p.groundTruth) sampled++
    prs.set(p.pr, (prs.get(p.pr) ?? false) || p.groundTruth)
  }
  const prsWithSample = [...prs.values()].filter(Boolean).length
  return {
    pushes: pushes.length,
    sampledPushes: sampled,
    pushRate: pushes.length ? sampled / pushes.length : null,
    prs: prs.size,
    prsWithSample,
    prShare: prs.size ? prsWithSample / prs.size : null,
  }
}
