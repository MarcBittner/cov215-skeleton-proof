import type { ConvexCaller } from "../t1/convex.js"
import type { RunState } from "../t1/run.js"
import { assertOperation } from "../t1/scope.js"
import { checkTarget, type DenyList } from "../t1/target.js"

export const APP_CATCH_ALL = "app-mail@co-ver.com"
export const MAIL_REFUSED = "Email is enabled on this preview: run refused"

export interface MailProjection {
  emailEnabled: boolean
  catchAllAddress: string
  catchAllSource: "database" | "default"
}

export interface PriorMail {
  setup_run_id: string
  projection: MailProjection
}

export interface ContainedMail {
  projection: MailProjection
  adopted_from_setup_run_id: string | null
  contained: true
  contained_at: string
  effective_catch_all: string
}

export class MailRefused extends Error {
  constructor(readonly projection: MailProjection) {
    super(MAIL_REFUSED)
    this.name = "MailRefused"
  }
}

export class MailReadbackError extends Error {
  constructor(
    message: string,
    readonly original: MailProjection | null = null,
  ) {
    super(`mail read-back: ${message}`)
    this.name = "MailReadbackError"
  }
}

export function projectMail(config: unknown): MailProjection {
  const c = (config ?? {}) as Record<string, unknown>
  const source = c.catchAllSource
  const address = c.catchAllAddress
  if (source !== "database" && source !== "default") throw new Error(`getPlatformConfig catchAllSource is ${String(source)}`)
  if (typeof address !== "string" || !address.includes("@")) throw new Error("getPlatformConfig has no catchAllAddress")
  return { emailEnabled: c.emailEnabled === true, catchAllAddress: address, catchAllSource: source }
}

export async function readMail(caller: ConvexCaller): Promise<MailProjection> {
  return projectMail(await caller.query("commsAdmin:getPlatformConfig", {}))
}

export async function containMail(
  state: RunState,
  caller: ConvexCaller,
  opts: { prior?: PriorMail | null; now?: () => number; deny?: DenyList } = {},
): Promise<ContainedMail> {
  assertOperation("mailContain")
  checkTarget(state, state.deployment, "mail-contain", opts.deny)
  const current = await readMail(caller)
  if (current.emailEnabled) throw new MailRefused(current)
  const prior = opts.prior ?? null
  if (prior && BigInt(prior.setup_run_id) >= BigInt(state.setup_run_id)) {
    throw new Error(`prior mail projection ${prior.setup_run_id} is not from an older setup run`)
  }
  const original = prior ? { ...prior.projection } : current
  if (original.emailEnabled) throw new MailRefused(original)
  await caller.mutation("commsAdmin:setEmailEnabled", { enabled: false })
  await caller.mutation("commsAdmin:setPlatformAddress", { field: "catchAllAddress", value: APP_CATCH_ALL })
  const back = await readMail(caller)
  if (back.emailEnabled !== false) throw new MailReadbackError("emailEnabled is not false after contain", original)
  if (back.catchAllSource !== "database" || back.catchAllAddress !== APP_CATCH_ALL) {
    throw new MailReadbackError(`catch-all is ${back.catchAllAddress} (${back.catchAllSource}), not ${APP_CATCH_ALL} (database)`, original)
  }
  return {
    projection: original,
    adopted_from_setup_run_id: prior ? prior.setup_run_id : null,
    contained: true,
    contained_at: new Date((opts.now ?? Date.now)()).toISOString(),
    effective_catch_all: back.catchAllAddress,
  }
}

export async function restoreMail(
  state: RunState,
  caller: ConvexCaller,
  original: MailProjection,
  opts: { deny?: DenyList } = {},
): Promise<{ flipped: boolean }> {
  assertOperation("mailRestore")
  checkTarget(state, state.deployment, "mail-restore", opts.deny)
  const before = await readMail(caller)
  await caller.mutation("commsAdmin:setEmailEnabled", { enabled: false })
  await caller.mutation("commsAdmin:setPlatformAddress", {
    field: "catchAllAddress",
    value: original.catchAllSource === "default" ? null : original.catchAllAddress,
  })
  const back = await readMail(caller)
  const diffs: string[] = []
  if (back.emailEnabled !== false) diffs.push("emailEnabled is not false")
  if (back.catchAllSource !== original.catchAllSource) diffs.push(`catchAllSource ${back.catchAllSource}, saved ${original.catchAllSource}`)
  if (back.catchAllAddress !== original.catchAllAddress) diffs.push(`catchAllAddress ${back.catchAllAddress}, saved ${original.catchAllAddress}`)
  if (diffs.length) throw new MailReadbackError(diffs.join("; "))
  return { flipped: before.emailEnabled }
}
