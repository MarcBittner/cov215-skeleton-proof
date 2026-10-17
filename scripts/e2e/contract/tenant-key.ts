import { createHash } from "node:crypto"
import { parseId } from "../../../e2e/map/ids.js"

export const TENANT_TITLE_SEPARATOR = " > "
export const E2E_TEST_DIR = "e2e"
export const MAX_TENANT_ORDINAL = 20

const ORDINAL = /^(t_[0-9a-f]{24})#([2-9]|1[0-9]|20)$/

export function tenantKeyOfTitle(title: string): string {
  return `t_${createHash("sha256").update(title, "utf8").digest("hex").slice(0, 24)}`
}

export function tenantTitle(titlePath: readonly string[]): string {
  return titlePath.join(TENANT_TITLE_SEPARATOR)
}

export function tenantKeyOf(titlePath: readonly string[]): string {
  return tenantKeyOfTitle(tenantTitle(titlePath))
}

export function titlePathOfTestId(testId: string): string[] | null {
  const id = parseId(testId)
  if (!id || id.kind !== "test" || !id.path.startsWith(`${E2E_TEST_DIR}/`)) return null
  return [id.path.slice(E2E_TEST_DIR.length + 1), ...id.titlePath]
}

export function tenantKey(baseKey: string, ordinal: number): string {
  if (!Number.isInteger(ordinal) || ordinal < 1 || ordinal > MAX_TENANT_ORDINAL) {
    throw new Error(`tenant ordinal must be 1..${MAX_TENANT_ORDINAL}, got ${ordinal}`)
  }
  return ordinal === 1 ? baseKey : `${baseKey}#${ordinal}`
}

export function tenantBaseKey(key: string): string {
  return ORDINAL.exec(key)?.[1] ?? key
}
