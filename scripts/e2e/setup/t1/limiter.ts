import type { ClerkResponse } from "./clerk.js"

export type LimitedKind = "userCreate" | "ticketMint" | "other"

export interface LimiterBudget {
  userCreatesPerSec: number
  ticketMintsPerSec: number
  instanceUserCeiling: number | null
}

export interface S5Result {
  userCreatesPerSec: number
  ticketMintsPerSec: number
  instanceUserCeiling: number
}

export const DEFAULT_BUDGET: LimiterBudget = {
  userCreatesPerSec: 1,
  ticketMintsPerSec: 2,
  instanceUserCeiling: null,
}

export const CAPACITY_HOLD_MS = 30_000
export const INSTANCE_USER_HEADROOM = 10

export interface Clock {
  now(): number
  sleep(ms: number): Promise<void>
}

export const realClock: Clock = {
  now: () => Date.now(),
  sleep: (ms) => new Promise((resolve) => setTimeout(resolve, ms)),
}

export class CapacityError extends Error {
  readonly reason = "capacity" as const
  constructor(message: string) {
    super(`capacity: ${message}`)
    this.name = "CapacityError"
  }
}

export function budgetFromS5(s5: S5Result | null, concurrentRuns: number): LimiterBudget {
  if (!s5) return { ...DEFAULT_BUDGET }
  if (!(concurrentRuns >= 1)) throw new Error(`concurrent signed-in runs must be >= 1, got ${concurrentRuns}`)
  return {
    userCreatesPerSec: (0.5 * s5.userCreatesPerSec) / concurrentRuns,
    ticketMintsPerSec: (0.5 * s5.ticketMintsPerSec) / concurrentRuns,
    instanceUserCeiling: s5.instanceUserCeiling,
  }
}

export interface LimiterStats {
  calls: Record<LimitedKind, number>
  held: number
  retries429: number
  capacityHolds: number
  startedAt: Record<LimitedKind, number[]>
}

export class ClerkLimiter {
  private readonly nextFree: Record<LimitedKind, number> = { userCreate: 0, ticketMint: 0, other: 0 }
  readonly stats: LimiterStats = {
    calls: { userCreate: 0, ticketMint: 0, other: 0 },
    held: 0,
    retries429: 0,
    capacityHolds: 0,
    startedAt: { userCreate: [], ticketMint: [], other: [] },
  }

  constructor(
    private readonly opts: {
      budget: LimiterBudget
      deadline: number
      clock?: Clock
      passThrough?: boolean
      holdMs?: number
      backoffBaseMs?: number
      backoffMaxMs?: number
    },
  ) {
    for (const r of [opts.budget.userCreatesPerSec, opts.budget.ticketMintsPerSec]) {
      if (!(r > 0)) throw new Error(`limiter rate must be > 0, got ${r}`)
    }
  }

  get budget(): LimiterBudget {
    return this.opts.budget
  }

  private get clock(): Clock {
    return this.opts.clock ?? realClock
  }

  private interval(kind: LimitedKind): number {
    if (kind === "userCreate") return 1000 / this.opts.budget.userCreatesPerSec
    if (kind === "ticketMint") return 1000 / this.opts.budget.ticketMintsPerSec
    return 0
  }

  private async acquire(kind: LimitedKind): Promise<boolean> {
    const now = this.clock.now()
    if (this.opts.passThrough || kind === "other") return true
    const at = Math.max(now, this.nextFree[kind])
    const wait = at - now
    if (wait > (this.opts.holdMs ?? CAPACITY_HOLD_MS)) return false
    this.nextFree[kind] = at + this.interval(kind)
    if (wait > 0) {
      this.stats.held += 1
      await this.clock.sleep(wait)
    }
    return true
  }

  private remaining(): number {
    return this.opts.deadline - this.clock.now()
  }

  async call(kind: LimitedKind, fn: () => Promise<ClerkResponse>): Promise<ClerkResponse> {
    let attempt = 0
    for (;;) {
      if (this.remaining() <= 0) {
        throw new CapacityError(`run deadline passed waiting for Clerk ${kind} capacity after ${attempt} attempt(s)`)
      }
      const backoff = Math.min(
        (this.opts.backoffBaseMs ?? 500) * 2 ** Math.min(attempt, 16),
        this.opts.backoffMaxMs ?? 8_000,
      )
      if (!(await this.acquire(kind))) {
        this.stats.capacityHolds += 1
        attempt += 1
        await this.clock.sleep(Math.min(backoff, Math.max(1, this.remaining())))
        continue
      }
      this.stats.calls[kind] += 1
      this.stats.startedAt[kind].push(this.clock.now())
      const res = await fn()
      if (res.status !== 429) return res
      this.stats.retries429 += 1
      attempt += 1
      const wait = Math.max(res.retryAfterMs ?? 0, backoff)
      if (this.remaining() - wait <= 0) {
        await this.clock.sleep(Math.max(0, this.remaining()))
        throw new CapacityError(`Clerk kept answering 429 for ${kind} until the run deadline (${attempt} attempt(s))`)
      }
      await this.clock.sleep(wait)
    }
  }

  async assertUserHeadroom(count: () => Promise<number>): Promise<void> {
    const ceiling = this.opts.budget.instanceUserCeiling
    if (ceiling === null) return
    const n = await count()
    if (n >= ceiling - INSTANCE_USER_HEADROOM) {
      throw new CapacityError(`Clerk instance has ${n} users, within ${INSTANCE_USER_HEADROOM} of its ceiling ${ceiling}`)
    }
  }
}
