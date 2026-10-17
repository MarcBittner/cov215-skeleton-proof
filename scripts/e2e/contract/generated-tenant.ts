import { formatId, parseId } from "../../../e2e/map/ids.js"
import { tenantKeyOf, titlePathOfTestId } from "./tenant-key.js"

export const GENERATED_FILES = {
  screen: "e2e/generated/screen-checks.spec.ts",
  snapshot: "e2e/generated/behaviour-snapshots.spec.ts",
} as const

export function generatedTestId(genId: string): string {
  const parsed = parseId(genId)
  if (parsed?.kind !== "gen-screen" && parsed?.kind !== "gen-snapshot") throw new Error(`not a generated test id: ${genId}`)
  const file = parsed.kind === "gen-screen" ? GENERATED_FILES.screen : GENERATED_FILES.snapshot
  const id = formatId({ kind: "test", path: file, titlePath: [genId] })
  if (parseId(id)?.kind !== "test") throw new Error(`generated test id ${genId} has no test id`)
  return id
}

export function generatedTenantKey(genId: string): string {
  return tenantKeyOf(titlePathOfTestId(generatedTestId(genId))!)
}
