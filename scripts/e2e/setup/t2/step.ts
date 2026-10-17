export type SetupKind = "pr" | "postmerge" | "nightly" | "gate" | "mut" | "fallback" | "fresh" | "base"
export type SetupMode = "fixture" | "live"
export type SetupTask = "t3" | "t4" | "t5"

export interface SetupLiveMap {
  dir: string | null
  mapSha: string | null
  fullRun: string | null
  candidatesDir?: string | null
}

export interface SetupLiveInputs {
  harnessDir: string
  harnessSha: string
  pr: number | null
  prSha: string | null
  headRef: string | null
  prTitle: string | null
  now: string
  env: Readonly<Record<string, string | undefined>>
  records: () => Promise<readonly unknown[]>
  mapRecords?: () => Promise<readonly unknown[]>
  map?: SetupLiveMap
  stage: (name: string, files: Record<string, string>) => Promise<void>
}

export interface SetupStepContext {
  kind: SetupKind
  mode: SetupMode
  setupRunId: string
  workDir: string
  live?: SetupLiveInputs
}

export interface SetupStepResult {
  task: SetupTask
  status: "stub" | "ok" | "skipped"
  output?: unknown
  aiAdditions?: string[]
}

export type SetupStep = (ctx: SetupStepContext) => Promise<SetupStepResult>
