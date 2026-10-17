import type { GitHub } from "../lib/github.js"

export type ReportTrigger = "fan-in" | "sweep"

export interface RebindArgs {
  gh: GitHub
  pr: number
  headSha: string
  setupRunId: string
  trigger: ReportTrigger
  rowFiles: Record<string, unknown>
}

export interface ReportHooks {
  rebind(args: RebindArgs): Promise<{ diffHash: string } | null>
}

export const reportHooks: ReportHooks = {
  rebind: async () => null,
}
