import type { InjectedBreak } from "../../contract/types.js"
import {
  GATE_BRANCH_PREFIX,
  assertGateRef,
  assertInjectedBreak,
  draftSpecPath,
  specSha256,
  type GateRef,
} from "../../gate/gate-run.js"

export const RUN_WORKFLOW = "e2e-run.yml"
export const DISPATCH_INPUT_KEYS = ["setup_run_id", "run_key"] as const
export const MAX_DISPATCH_BYTES = 1024

const GAP_ID = /^[a-z0-9][a-z0-9-]{0,62}$/
const SETUP_RUN_ID = /^[1-9][0-9]{0,19}$/
const RUN_KEY = /^[A-Za-z0-9_-]{16,128}$/

export interface GatePlan {
  gate: GateRef
  path: string
  files: Record<string, string>
}

export interface DispatchInputs {
  setup_run_id: string
  run_key: string
}

export interface GateDispatch {
  workflow: typeof RUN_WORKFLOW
  ref: string
  inputs: DispatchInputs
}

export function gateBranch(gapId: string, attempt: number): string {
  if (!GAP_ID.test(gapId)) throw new Error(`invalid gap id "${gapId}"`)
  if (!Number.isInteger(attempt) || attempt < 1 || attempt > 99) {
    throw new Error(`invalid gate attempt ${attempt}`)
  }
  return `${GATE_BRANCH_PREFIX}${gapId}-${attempt}`
}

export function planGate(opts: { gapId: string; attempt: number; spec: string; break: InjectedBreak | null }): GatePlan {
  const ref = gateBranch(opts.gapId, opts.attempt)
  const specPath = draftSpecPath(opts.gapId)
  return {
    gate: { ref, path: specPath, sha256: specSha256(opts.spec), break: assertInjectedBreak(opts.break) },
    path: specPath,
    files: { [specPath]: opts.spec },
  }
}

export function assertDispatchInputs(inputs: unknown): DispatchInputs {
  if (!inputs || typeof inputs !== "object" || Array.isArray(inputs)) {
    throw new Error("dispatch inputs must be an object")
  }
  const keys = Object.keys(inputs).sort()
  const expected = [...DISPATCH_INPUT_KEYS].sort()
  if (keys.length !== expected.length || keys.some((k, i) => k !== expected[i])) {
    throw new Error(`dispatch inputs must be exactly ${DISPATCH_INPUT_KEYS.join(", ")}; got ${keys.join(", ")}`)
  }
  const rec = inputs as Record<string, unknown>
  if (typeof rec.setup_run_id !== "string" || !SETUP_RUN_ID.test(rec.setup_run_id)) {
    throw new Error("setup_run_id must be a numeric run id")
  }
  if (typeof rec.run_key !== "string" || !RUN_KEY.test(rec.run_key)) {
    throw new Error("run_key has the wrong shape")
  }
  if (Buffer.byteLength(JSON.stringify(rec), "utf8") > MAX_DISPATCH_BYTES) {
    throw new Error(`dispatch inputs exceed ${MAX_DISPATCH_BYTES} bytes`)
  }
  return { setup_run_id: rec.setup_run_id, run_key: rec.run_key }
}

export function gateDispatch(opts: { gate: GateRef; setupRunId: string; runKey: string }): GateDispatch {
  const gate = assertGateRef(opts.gate)
  return {
    workflow: RUN_WORKFLOW,
    ref: gate.ref,
    inputs: assertDispatchInputs({ setup_run_id: opts.setupRunId, run_key: opts.runKey }),
  }
}
