import { randomBytes } from "node:crypto"
import type { InjectedBreak } from "./types.js"

export const CONTRACT_MAJOR = 1
export const CONTRACT_VERSION = "1.0"

export const ARTIFACTS = {
  plan: "e2e-plan",
  planFinal: "e2e-plan-final",
  control: "e2e-control",
  bundle: "e2e-bundle",
  bundleAi: "e2e-bundle-ai",
  runRecord: "e2e-run-record",
  selectAi: "e2e-select-ai",
  commentRows: (task: "t3" | "t4" | "t5") => `e2e-comment-rows-${task}`,
} as const

export const FILES = {
  setupPlan: "run.json",
  shardPlan: "plan.json",
  control: "control.json",
  bundle: "bundle.enc.json",
  selection: "selection.json",
  selectAi: "ai.json",
  commentRows: (task: "t3" | "t4" | "t5") => `comment-rows-${task}.json`,
  runRecord: (setupRunId: string) => `runs/${setupRunId}.json`,
  manifest: (stagingSha: string) => `maps/${stagingSha}/manifest.json`,
  manifestIndex: "maps/index.json",
} as const

export const INJECTED_BREAKS: readonly InjectedBreak[] = ["alter-query-field", "drop-mutation-frame"]

export const COMMENT_SECTION_ORDER = ["t3", "t4", "t5"] as const

export const TICKET_KEY_SECRET = "E2E_TICKET_KEY"
export const TICKET_RECIPIENT_VAR = "E2E_TICKET_AGE_RECIPIENT"
export const DECRYPTED_BUNDLE_ENV = "E2E_INPUTS_FILE"
export const TICKET_TTL_SECONDS = 600
export const MAX_DISPATCH_INPUT_BYTES = 1024
export const MAX_RUN_TENANTS = 128
export const MAX_RUN_USERS = 200

export function runTagFor(setupRunId: string): string {
  return `r${setupRunId}`
}

export function newRunKey(): string {
  return randomBytes(16).toString("hex")
}
