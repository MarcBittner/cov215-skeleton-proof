import { createHash } from "node:crypto"

export function sha256Hex(...parts: string[]): string {
  return createHash("sha256").update(parts.join("\u0000")).digest("hex")
}

export function seededRandom(seed: string): () => number {
  let counter = 0
  return () => {
    const hex = sha256Hex(seed, String(counter++)).slice(0, 13)
    return parseInt(hex, 16) / 2 ** 52
  }
}

export function seededShuffle<T>(items: readonly T[], seed: string): T[] {
  const out = items.slice()
  const next = seededRandom(seed)
  for (let i = out.length - 1; i > 0; i--) {
    const j = Math.floor(next() * (i + 1))
    const tmp = out[i]
    out[i] = out[j]
    out[j] = tmp
  }
  return out
}

export function quantile(values: readonly number[], q: number): number | null {
  if (values.length === 0) return null
  const sorted = values.slice().sort((a, b) => a - b)
  const pos = (sorted.length - 1) * q
  const lo = Math.floor(pos)
  const hi = Math.ceil(pos)
  return sorted[lo] + (sorted[hi] - sorted[lo]) * (pos - lo)
}
