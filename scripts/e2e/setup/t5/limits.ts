export const MAX_SCREENS_PER_NIGHT = 3
export const MAX_TESTS_PER_NIGHT = 10
export const MAX_OPEN_DRAFT_PRS = 5
export const MAX_REPAIR_ROUNDS = 2
export const NIGHT_STOP_USD = 15
export const MAX_LIVE_PREVIEWS = 40
export const CLEAN_GATE_RUNS = 3

export const MAX_OUTPUT_TOKENS = 32000
export const MAX_INPUT_BYTES = 40_000
export const INPUT_OVERHEAD_TOKENS = 4_000
export const MAX_INPUT_TOKENS = MAX_INPUT_BYTES + INPUT_OVERHEAD_TOKENS
export const MAX_SOURCES_PER_GAP = 4
export const MAX_SOURCE_BYTES = 8_000
export const MAX_SOURCE_REF_CHARS = 200
export const MAX_GAP_FIELD_CHARS = 300
export const MAX_PREVIOUS_SPEC_BYTES = 8_000
export const MAX_VIOLATIONS_FED_BACK = 40

export interface TokenUsage {
  input: number
  cacheWrite: number
  cacheRead: number
  output: number
}

interface Price {
  input: number
  cacheWrite: number
  cacheRead: number
  output: number
}

export const PRICES_PER_MTOK: Readonly<Record<string, Price>> = {
  "claude-opus-5-5": { input: 4, cacheWrite: 5, cacheRead: 0.2, output: 20 },
}

export function worstCaseAttemptUsd(model = "claude-opus-5-5"): number {
  const p = PRICES_PER_MTOK[model] ?? PRICES_PER_MTOK["claude-opus-5-5"]
  return Math.ceil(((MAX_INPUT_TOKENS * p.input + MAX_OUTPUT_TOKENS * p.output) / 1_000_000) * 100) / 100
}

export const ATTEMPT_ESTIMATE_USD = worstCaseAttemptUsd()

export function costOf(model: string, usage: TokenUsage): number {
  const p = PRICES_PER_MTOK[model] ?? PRICES_PER_MTOK["claude-opus-5-5"]
  const usd =
    (usage.input * p.input + usage.cacheWrite * p.cacheWrite + usage.cacheRead * p.cacheRead + usage.output * p.output) /
    1_000_000
  return Math.round(usd * 1e6) / 1e6
}

export function addUsage(a: TokenUsage, b: TokenUsage): TokenUsage {
  return {
    input: a.input + b.input,
    cacheWrite: a.cacheWrite + b.cacheWrite,
    cacheRead: a.cacheRead + b.cacheRead,
    output: a.output + b.output,
  }
}

export const NO_USAGE: TokenUsage = { input: 0, cacheWrite: 0, cacheRead: 0, output: 0 }

export function batchEstimate(tests: number): { attempts: number; unitUsd: number; totalUsd: number; line: string } {
  const attempts = tests * (1 + MAX_REPAIR_ROUNDS)
  const totalUsd = Math.round(attempts * ATTEMPT_ESTIMATE_USD * 100) / 100
  return {
    attempts,
    unitUsd: ATTEMPT_ESTIMATE_USD,
    totalUsd,
    line: `drafts: ${tests} test(s) x up to ${1 + MAX_REPAIR_ROUNDS} attempts = ${attempts} x $${ATTEMPT_ESTIMATE_USD} = $${totalUsd.toFixed(2)} at most (stop at $${NIGHT_STOP_USD}/night)`,
  }
}

export function canSpend(spentUsd: number): boolean {
  return spentUsd + ATTEMPT_ESTIMATE_USD <= NIGHT_STOP_USD
}
