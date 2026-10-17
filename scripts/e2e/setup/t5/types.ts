import type { GateEntry, InjectedBreak } from "../../contract/types.js"
import type { Gap } from "../../map/reports/gaps.js"
import type { GateCheckRecord, GateRunStatus } from "../../gate/gate-run.js"
import type { SetupKind, SetupMode, SetupStep, SetupStepContext, SetupStepResult, SetupTask } from "../t2/step.js"
import type { TokenUsage } from "./limits.js"

export type SourceKind = "code" | "doc" | "issue"

export interface IntentSource {
  kind: SourceKind
  ref: string
  text: string
}

export type { InjectedBreak }

export type { SetupKind, SetupMode, SetupStep, SetupStepContext, SetupStepResult, SetupTask }

export interface GateRequest {
  gapId: string
  slug: string
  attempt: number
  ref: string
  path: string
  sha256: string
  injectedBreak: InjectedBreak | null
  gate: GateEntry
  setupRunId?: string | null
}

export interface Expectation {
  line: number
  text: string
  source: string
  sourceKind: "observed" | "code" | "doc" | "issue"
}

export interface PendingDraft {
  gapId: string
  slug: string
  gap: Gap
  spec: string
  sha256: string
  path: string
  expectations: Expectation[]
  applicableBreaks: InjectedBreak[]
  gates: GateRequest[]
  attempts: number
  usage: TokenUsage
  costUsd: number
  baseSha: string
  specCommit?: string
  draftedAt: string
}

export interface GateResultInput {
  ref: string
  sha256: string
  deployment: string
  passed: boolean
  status?: GateRunStatus
  failedLines?: number[]
  breakAnnotation?: string | null
  check?: GateCheckRecord
}

export interface DraftsState {
  version: 1
  pending: PendingDraft[]
  dryOffered: string[]
  spend: NightSpend | null
}

export const EMPTY_STATE: DraftsState = { version: 1, pending: [], dryOffered: [], spend: null }

export interface DraftPr {
  number: number
  state: "open" | "closed"
  merged: boolean
  body: string
  labels: string[]
}

export interface NightSpend {
  night: string
  costUsd: number
}
