import ts from "typescript"

export interface BreakTarget {
  path: string
  at: string[]
}

type Read = { path: string; at: string[]; pos: number }

export interface BreakAnalysis {
  targets: BreakTarget[]
  alterLines: number[]
  dropLines: number[]
}

const NOT_A_FIELD = new Set(["length"])
const OBJECT_MATCHERS = new Set(["toMatchObject", "toEqual", "toStrictEqual"])
const WRITE_ACTIONS = new Set([
  "click",
  "dblclick",
  "tap",
  "fill",
  "clear",
  "press",
  "pressSequentially",
  "type",
  "insertText",
  "check",
  "uncheck",
  "setChecked",
  "selectOption",
  "dragTo",
])

export function canonicalUdfPath(udfPath: string): string {
  const pieces = udfPath.split(":")
  let moduleName = pieces.length === 1 ? pieces[0] : pieces.slice(0, -1).join(":")
  const fn = pieces.length === 1 ? "default" : pieces[pieces.length - 1]
  if (moduleName.endsWith(".js")) moduleName = moduleName.slice(0, -3)
  return `${moduleName}:${fn}`
}

export function targetKey(t: BreakTarget): string {
  return `${t.path}#${t.at.join(".")}`
}

function strip(e: ts.Expression): ts.Expression {
  for (;;) {
    if (
      ts.isParenthesizedExpression(e) ||
      ts.isAwaitExpression(e) ||
      ts.isNonNullExpression(e) ||
      ts.isAsExpression(e) ||
      ts.isSatisfiesExpression(e) ||
      ts.isTypeAssertionExpression(e)
    ) {
      e = e.expression
    } else return e
  }
}

function readerPath(e: ts.Expression): string | null {
  const s = strip(e)
  if (!ts.isCallExpression(s)) return null
  const c = s.expression
  if (!ts.isPropertyAccessExpression(c) || c.name.text !== "query") return null
  const obj = strip(c.expression)
  if (!ts.isIdentifier(obj) || !/Ch$/.test(obj.text)) return null
  const arg = s.arguments[0]
  if (!arg || !(ts.isStringLiteral(arg) || ts.isNoSubstitutionTemplateLiteral(arg))) return null
  return canonicalUdfPath(arg.text)
}

function chain(e: ts.Expression, reads: Map<string, Read>): Read | null {
  const names: string[] = []
  let cur = strip(e)
  for (;;) {
    if (ts.isPropertyAccessExpression(cur)) {
      names.unshift(cur.name.text)
      cur = strip(cur.expression)
    } else if (ts.isElementAccessExpression(cur)) {
      const a = cur.argumentExpression
      if (ts.isStringLiteral(a) || ts.isNoSubstitutionTemplateLiteral(a)) names.unshift(a.text)
      else if (!ts.isNumericLiteral(a)) return null
      cur = strip(cur.expression)
    } else break
  }
  let base: Read | null = null
  if (ts.isIdentifier(cur)) base = reads.get(cur.text) ?? null
  else {
    const p = readerPath(cur)
    if (p) base = { path: p, at: [], pos: cur.getStart() }
  }
  if (!base) return null
  const fields = names.filter((n, i) => !(NOT_A_FIELD.has(n) && i === names.length - 1))
  return { path: base.path, at: [...base.at, ...fields], pos: base.pos }
}

function bind(name: ts.BindingName, read: Read, reads: Map<string, Read>): void {
  if (ts.isIdentifier(name)) {
    reads.set(name.text, read)
    return
  }
  if (ts.isArrayBindingPattern(name)) {
    for (const el of name.elements) if (!ts.isOmittedExpression(el) && !el.dotDotDotToken) bind(el.name, read, reads)
    return
  }
  for (const el of name.elements) {
    if (el.dotDotDotToken) continue
    const key = el.propertyName ?? el.name
    const k = ts.isIdentifier(key) || ts.isStringLiteral(key) ? key.text : null
    if (k === null) continue
    bind(el.name, { path: read.path, at: [...read.at, k], pos: read.pos }, reads)
  }
}

function objectLeaves(o: ts.ObjectLiteralExpression, prefix: string[], out: string[][]): void {
  for (const p of o.properties) {
    let key: string | null = null
    let init: ts.Expression | null = null
    if (ts.isPropertyAssignment(p) && (ts.isIdentifier(p.name) || ts.isStringLiteral(p.name))) {
      key = p.name.text
      init = p.initializer
    } else if (ts.isShorthandPropertyAssignment(p)) key = p.name.text
    if (key === null) continue
    const inner = init ? strip(init) : null
    if (inner && ts.isObjectLiteralExpression(inner)) objectLeaves(inner, [...prefix, key], out)
    else out.push([...prefix, key])
  }
}

function subjectOf(e: ts.Expression): ts.Expression | null {
  const s = strip(e)
  if (ts.isArrowFunction(s) || ts.isFunctionExpression(s)) {
    if (!ts.isBlock(s.body)) return s.body
    const ret = s.body.statements.find(ts.isReturnStatement)
    return ret?.expression ?? null
  }
  return s
}

function expectCallOf(call: ts.CallExpression): boolean {
  const c = call.expression
  if (ts.isIdentifier(c)) return c.text === "expect"
  return ts.isPropertyAccessExpression(c) && ts.isIdentifier(c.expression) && c.expression.text === "expect" && (c.name.text === "soft" || c.name.text === "poll")
}

function matcherOf(call: ts.CallExpression): { name: string; args: readonly ts.Expression[] } | null {
  let n: ts.Node = call
  while (n.parent && ts.isPropertyAccessExpression(n.parent) && n.parent.expression === n) {
    const pa: ts.PropertyAccessExpression = n.parent
    if (pa.parent && ts.isCallExpression(pa.parent) && pa.parent.expression === pa) {
      return { name: pa.name.text, args: pa.parent.arguments }
    }
    n = pa
  }
  return null
}

function statementOf(node: ts.Node): ts.Node {
  let n: ts.Node = node
  while (n.parent && !ts.isBlock(n.parent) && !ts.isSourceFile(n.parent)) n = n.parent
  return n
}

function enclosingFunction(node: ts.Node): ts.Node | null {
  let n: ts.Node | undefined = node.parent
  while (n && !ts.isArrowFunction(n) && !ts.isFunctionExpression(n)) n = n.parent
  return n ?? null
}

export function breakAnalysis(source: string): BreakAnalysis {
  const sf = ts.createSourceFile("draft.spec.ts", source, ts.ScriptTarget.Latest, true, ts.ScriptKind.TS)
  const reads = new Map<string, Read>()
  const inits = new Map<string, ts.Expression>()
  const out = new Map<string, BreakTarget>()
  const alterLines = new Set<number>()
  const dropLines = new Set<number>()
  const writes: Array<{ fn: ts.Node | null; pos: number }> = []
  const lineOf = (n: ts.Node) => sf.getLineAndCharacterOfPosition(statementOf(n).getStart()).line + 1
  const add = (r: Read) => {
    if (r.at.some((f) => f.startsWith("_"))) return
    const t = { path: r.path, at: r.at }
    out.set(targetKey(t), t)
  }

  const flows = (root: ts.Node): Read[] => {
    const found: Read[] = []
    const seen = new Set<string>()
    const scan = (n: ts.Node): void => {
      if (ts.isExpression(n) && (ts.isIdentifier(n) || ts.isPropertyAccessExpression(n) || ts.isElementAccessExpression(n) || ts.isCallExpression(n))) {
        const r = chain(n, reads)
        if (r) {
          found.push(r)
          return
        }
      }
      if (ts.isIdentifier(n) && inits.has(n.text) && !seen.has(n.text)) {
        seen.add(n.text)
        scan(inits.get(n.text)!)
      }
      ts.forEachChild(n, scan)
    }
    scan(root)
    return found
  }

  const visit = (node: ts.Node): void => {
    if (ts.isVariableDeclaration(node) && node.initializer) {
      const r = chain(node.initializer, reads)
      if (r) bind(node.name, r, reads)
      else if (ts.isIdentifier(node.name)) inits.set(node.name.text, node.initializer)
    }
    if (ts.isCallExpression(node) && ts.isPropertyAccessExpression(node.expression) && WRITE_ACTIONS.has(node.expression.name.text)) {
      writes.push({ fn: enclosingFunction(node), pos: node.getStart() })
    }
    if (ts.isCallExpression(node) && expectCallOf(node) && node.arguments[0]) {
      const subject = subjectOf(node.arguments[0])
      const r = subject ? chain(subject, reads) : null
      const m = matcherOf(node)
      if (r) {
        const arg = m?.args[0] ? strip(m.args[0]) : null
        if (m && OBJECT_MATCHERS.has(m.name) && arg && ts.isObjectLiteralExpression(arg)) {
          const leaves: string[][] = []
          objectLeaves(arg, [], leaves)
          for (const l of leaves) add({ path: r.path, at: [...r.at, ...l], pos: r.pos })
        } else if (m && m.name === "toHaveProperty" && arg && ts.isStringLiteral(arg)) {
          add({ path: r.path, at: [...r.at, ...arg.text.split(".")], pos: r.pos })
        } else {
          add(r)
        }
        const fn = enclosingFunction(node)
        if (writes.some((w) => w.fn === fn && w.pos < r.pos)) dropLines.add(lineOf(node))
      }
      const derived = [...(subject && !r ? flows(subject) : []), ...(m ? m.args.flatMap((a) => flows(a)) : [])]
      for (const d of derived) add(d)
      if (r || derived.length > 0) alterLines.add(lineOf(node))
    }
    ts.forEachChild(node, visit)
  }
  visit(sf)
  return { targets: [...out.values()], alterLines: [...alterLines], dropLines: [...dropLines] }
}

export function breakTargets(source: string): BreakTarget[] {
  return breakAnalysis(source).targets
}
