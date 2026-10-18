export type ArtifactStage = { stage(name: string, files: Record<string, string>): Promise<void> }
