export type FlagSet = "off" | "on" | `custom:${string}`

export type CellId = { kind: "cell"; route: string; role: string; recordState: string; flagSet: FlagSet }
export type ControlId = { kind: "control"; cell: CellId; controlKey: string }

export type MapId =
  | { kind: "fn"; path: string; chain: string[] }
  | { kind: "udf"; module: string; exportName: string }
  | { kind: "table"; table: string }
  | { kind: "index"; table: string; index: string }
  | { kind: "route"; pattern: string }
  | { kind: "feature"; path: string }
  | CellId
  | ControlId
  | { kind: "gen-screen"; cell: CellId }
  | { kind: "gen-snapshot"; control: ControlId }
  | { kind: "test"; path: string; titlePath: string[] }

export type MapIdKind = MapId["kind"]
export type TestKind = "functional" | "screen" | "snapshot"

export const TITLE_SEPARATOR = " › "
export const MODULE_CHAIN = "<module>"

const IDENT = /^[A-Za-z_$][A-Za-z0-9_$]*$/
const ANON = /^<anon#[1-9][0-9]*>$/
const SLUG = /^[a-z][a-z0-9-]*$/
const FLAG = /^(off|on|custom:[0-9a-f]{8,64})$/
const UDF_SEGMENT = /^[A-Za-z0-9_][A-Za-z0-9_.-]*$/
const CONTROL_KEY = /^[^|\r\n\t]+$/

export function isRepoPath(p: string): boolean {
  if (p === "" || p.startsWith("/") || p.endsWith("/")) return false
  if (/[\s:|\\]/.test(p)) return false
  return p.split("/").every((s) => s !== "" && s !== "." && s !== "..")
}

export function isRoutePattern(p: string): boolean {
  if (p === "/") return true
  if (!p.startsWith("/") || p.endsWith("/")) return false
  if (/[\s|?#]/.test(p)) return false
  return p
    .slice(1)
    .split("/")
    .every((s) => s !== "" && s !== "." && s !== "..")
}

function isTitle(t: string): boolean {
  return t !== "" && t === t.trim() && !/[\r\n\t]/.test(t) && !t.includes(TITLE_SEPARATOR)
}

function isChain(chain: string[]): boolean {
  if (chain.length === 1 && chain[0] === MODULE_CHAIN) return true
  return chain.length > 0 && chain.every((s) => IDENT.test(s) || ANON.test(s))
}

function isUdfModule(m: string): boolean {
  const segs = m.split("/")
  if (segs[0] === "convex") return false
  if (/\.(ts|tsx|js|jsx|mjs|cjs)$/.test(m)) return false
  return segs.every((s) => UDF_SEGMENT.test(s))
}

function parseCellBody(body: string): CellId | null {
  const parts = body.split("|")
  if (parts.length !== 4) return null
  const [route, role, recordState, flagSet] = parts
  if (!isRoutePattern(route) || !SLUG.test(role) || !SLUG.test(recordState) || !FLAG.test(flagSet)) return null
  return { kind: "cell", route, role, recordState, flagSet: flagSet as FlagSet }
}

function parseCell(s: string): CellId | null {
  return s.startsWith("cell:") ? parseCellBody(s.slice(5)) : null
}

function parseControl(s: string): ControlId | null {
  if (!s.startsWith("control:cell:")) return null
  const body = s.slice("control:cell:".length)
  const parts = body.split("|")
  if (parts.length !== 5) return null
  const cell = parseCellBody(parts.slice(0, 4).join("|"))
  const controlKey = parts[4]
  if (!cell || !CONTROL_KEY.test(controlKey) || controlKey !== controlKey.trim()) return null
  return { kind: "control", cell, controlKey }
}

export function parseId(s: string): MapId | null {
  if (typeof s !== "string") return null
  const colon = s.indexOf(":")
  if (colon < 0) return null
  const prefix = s.slice(0, colon)
  const body = s.slice(colon + 1)
  switch (prefix) {
    case "fn": {
      const sep = body.indexOf("::")
      if (sep < 0) return null
      const path = body.slice(0, sep)
      const chain = body.slice(sep + 2).split(".")
      return isRepoPath(path) && isChain(chain) ? { kind: "fn", path, chain } : null
    }
    case "udf": {
      const parts = body.split(":")
      if (parts.length !== 2) return null
      const [module, exportName] = parts
      return isUdfModule(module) && IDENT.test(exportName) ? { kind: "udf", module, exportName } : null
    }
    case "table":
      return IDENT.test(body) ? { kind: "table", table: body } : null
    case "index": {
      const parts = body.split(".")
      if (parts.length !== 2 || !IDENT.test(parts[0]) || !IDENT.test(parts[1])) return null
      return { kind: "index", table: parts[0], index: parts[1] }
    }
    case "route":
      return isRoutePattern(body) ? { kind: "route", pattern: body } : null
    case "feature":
      return isRepoPath(body) ? { kind: "feature", path: body } : null
    case "cell":
      return parseCell(s)
    case "control":
      return parseControl(s)
    case "gen": {
      if (body.startsWith("screen:")) {
        const cell = parseCell(body.slice("screen:".length))
        return cell ? { kind: "gen-screen", cell } : null
      }
      if (body.startsWith("snapshot:")) {
        const control = parseControl(body.slice("snapshot:".length))
        return control ? { kind: "gen-snapshot", control } : null
      }
      return null
    }
    case "test": {
      const sep = body.indexOf("::")
      if (sep < 0) return null
      const path = body.slice(0, sep)
      const titlePath = body.slice(sep + 2).split(TITLE_SEPARATOR)
      return isRepoPath(path) && titlePath.every(isTitle) ? { kind: "test", path, titlePath } : null
    }
    default:
      return null
  }
}

function formatCellBody(c: CellId): string {
  return `${c.route}|${c.role}|${c.recordState}|${c.flagSet}`
}

export function formatId(id: MapId): string {
  switch (id.kind) {
    case "fn":
      return `fn:${id.path}::${id.chain.join(".")}`
    case "udf":
      return `udf:${id.module}:${id.exportName}`
    case "table":
      return `table:${id.table}`
    case "index":
      return `index:${id.table}.${id.index}`
    case "route":
      return `route:${id.pattern}`
    case "feature":
      return `feature:${id.path}`
    case "cell":
      return `cell:${formatCellBody(id)}`
    case "control":
      return `control:cell:${formatCellBody(id.cell)}|${id.controlKey}`
    case "gen-screen":
      return `gen:screen:${formatId(id.cell)}`
    case "gen-snapshot":
      return `gen:snapshot:${formatId(id.control)}`
    case "test":
      return `test:${id.path}::${id.titlePath.join(TITLE_SEPARATOR)}`
  }
}

export function canonicalId(s: string): string | null {
  const parsed = parseId(s)
  if (!parsed) return null
  const formatted = formatId(parsed)
  return formatted === s ? formatted : null
}

export function isIdOfKind(s: string, ...kinds: MapIdKind[]): boolean {
  const parsed = parseId(s)
  return parsed !== null && kinds.includes(parsed.kind) && formatId(parsed) === s
}

export function testKindOf(s: string): TestKind | null {
  const parsed = parseId(s)
  if (!parsed || formatId(parsed) !== s) return null
  if (parsed.kind === "test") return "functional"
  if (parsed.kind === "gen-screen") return "screen"
  if (parsed.kind === "gen-snapshot") return "snapshot"
  return null
}
