import type { ControlId } from "../../../e2e/map/ids.js"

export const PLATFORM_WIDE_ROUTES = ["/admin/comms"]
export const PLATFORM_WIDE_UDF_MODULES = ["commsAdmin"]

export function isPlatformWideRoute(pattern: string): boolean {
  return PLATFORM_WIDE_ROUTES.some((r) => pattern === r || pattern.startsWith(`${r}/`))
}

export function udfIdOf(udfPath: string): string {
  const cleaned = udfPath.replace(/\.(js|ts)(?=:|$)/, "")
  const i = cleaned.lastIndexOf(":")
  return i < 0 ? `udf:${cleaned}:default` : `udf:${cleaned.slice(0, i)}:${cleaned.slice(i + 1)}`
}

export function isPlatformWideUdf(udf: string): boolean {
  const m = /^udf:([^:]+):/.exec(udf)
  return !!m && PLATFORM_WIDE_UDF_MODULES.includes(m[1])
}

export function isPlatformWideFrame(udfPath: string): boolean {
  return isPlatformWideUdf(udfIdOf(udfPath))
}

export function isPlatformWideControl(control: ControlId, udfPaths: string[] = []): boolean {
  return isPlatformWideRoute(control.cell.route) || udfPaths.some(isPlatformWideUdf)
}
