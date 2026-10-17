export type SetupKind = "pr" | "postmerge" | "nightly" | "gate" | "mut" | "fallback" | "fresh" | "base"
export type SetupMode = "fixture" | "live"
export type SetupTask = "t3" | "t4" | "t5"

export interface SetupStepContext {
  kind: SetupKind
  mode: SetupMode
  setupRunId: string
  workDir: string
}

export interface SetupStepResult {
  task: SetupTask
  status: "stub" | "ok" | "skipped"
  output?: unknown
}

export type SetupStep = (ctx: SetupStepContext) => Promise<SetupStepResult>
