import type { GitHub } from "../lib/github.js"
import { acceptRebind, type AcceptOutcome, type PriorOutcome } from "../map/accept/report.js"

export type ReportTrigger = "fan-in" | "sweep"

export interface RebindArgs {
  gh: GitHub
  pr: number
  headSha: string
  setupRunId: string
  trigger: ReportTrigger
  rowFiles: Record<string, unknown>
  reports: readonly unknown[]
  priorOutcome: (pr: number) => Promise<PriorOutcome | null>
}

export interface ReportHooks {
  rebind(args: RebindArgs): Promise<{ diffHash: string; accept?: AcceptOutcome } | null>
}

export const reportHooks: ReportHooks = {
  rebind: (args) => acceptRebind({ ...args, log: (line) => console.log(line) }),
}
