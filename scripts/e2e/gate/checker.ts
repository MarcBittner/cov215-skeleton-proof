import ts from "typescript"
import path from "path"

export type DraftRule =
  | "parse"
  | "path"
  | "import-allowlist"
  | "forbidden-api"
  | "secret"
  | "egress"
  | "wait-for-timeout"
  | "skip"
  | "fixture"
  | "signed-in"
  | "selector"
  | "tags"
  | "expect-comment"
  | "screen-assertion"
  | "saved-state-read"
  | "intent-source"
  | "break-sentinel"

export interface DraftViolation {
  rule: DraftRule
  line: number
  message: string
}

export interface DraftCheckResult {
  ok: boolean
  violations: DraftViolation[]
}

export interface DraftConventions {
  specDir: string
  packageExports: Record<string, string[]>
  fixtureModules: string[]
  fixtureExports: string[]
  helperExports: Record<string, string[]>
  locatorFactories: string[]
  signedInFixtures: string[]
  readerFixtures: string[]
  seedFixtures: string[]
  readerMethods: string[]
  forbiddenFixtures: string[]
}

export type SourceCheck = (file: string, line: number, needles: readonly string[], endLine?: number) => boolean

export interface DraftCheckOptions {
  path?: string
  gapId?: string
  previewHost?: string
  convexHost?: string
  conventions?: Partial<DraftConventions>
  sourceExists?: SourceCheck
}

export function sourceStates(text: string, line: number, endLine: number, needles: readonly string[]): boolean {
  const lines = text.split("\n")
  if (line < 1 || endLine < line || endLine > lines.length) return false
  const span = lines.slice(line - 1, endLine).join("\n").toLowerCase()
  return needles.some((n) => n.trim().length >= 2 && span.includes(n.trim().toLowerCase()))
}

export type ExpectSourceKind = "observed" | "code" | "doc" | "issue"

export const DEFAULT_CONVENTIONS: DraftConventions = {
  specDir: "e2e/drafts",
  packageExports: { "@playwright/test": ["expect"] },
  fixtureModules: ["e2e/gate/inject-break"],
  fixtureExports: ["test", "expect"],
  helperExports: {
    "e2e/helpers/selectors": ["sel"],
    "e2e/helpers/onboarding-selectors": ["onbSel"],
    "e2e/helpers/co-decision": ["coSel", "CO_STATUS_LABEL"],
    "e2e/helpers/co-verification": ["verifySel", "VERIFICATION_METHOD_TITLE", "RUBRIC_AREA_LABEL", "RUBRIC_PASS", "RUBRIC_BELOW_MIN"],
    "e2e/helpers/co-seed": ["CO_SEED_STATES", "CO_VERIFIER_SEED_STATES", "CO_ROUTEE_SEED_STATES"],
  },
  locatorFactories: ["sel", "onbSel", "coSel", "verifySel"],
  signedInFixtures: ["owner", "verifier", "member", "approver", "billing"],
  readerFixtures: ["ownerCh", "verifierCh", "memberCh", "approverCh", "billingCh"],
  seedFixtures: ["seedCo"],
  readerMethods: ["query"],
  forbiddenFixtures: ["adminCh", "page", "context", "browser", "request", "injectedBreak"],
}

type Kind =
  | "page"
  | "locator"
  | "keyboard"
  | "reader"
  | "seed"
  | "helper"
  | "expect"
  | "assertion"
  | "data"
  | "opaque"
  | "fn"
  | "test"
  | "invalid"
  | `global:${string}`
  | `method:${string}`

const CAPABILITIES = new Set<Kind>(["page", "locator", "keyboard", "reader", "seed"])

const GET_BY = ["getByRole", "getByText", "getByLabel", "getByTestId", "getByPlaceholder", "getByAltText", "getByTitle"]

const PAGE_METHODS: Record<string, Kind> = {
  ...Object.fromEntries(GET_BY.map((m) => [m, "locator" as Kind])),
  locator: "locator",
  goto: "opaque",
  reload: "opaque",
  goBack: "opaque",
  goForward: "opaque",
  waitForURL: "opaque",
  waitForLoadState: "opaque",
  url: "data",
  title: "data",
}

const LOCATOR_METHODS: Record<string, Kind> = {
  ...Object.fromEntries(GET_BY.map((m) => [m, "locator" as Kind])),
  ...Object.fromEntries(["locator", "filter", "first", "last", "nth", "and", "or"].map((m) => [m, "locator" as Kind])),
  ...Object.fromEntries(
    [
      "click",
      "dblclick",
      "fill",
      "clear",
      "press",
      "pressSequentially",
      "check",
      "uncheck",
      "setChecked",
      "selectOption",
      "hover",
      "focus",
      "blur",
      "tap",
      "dragTo",
      "scrollIntoViewIfNeeded",
      "waitFor",
    ].map((m) => [m, "opaque" as Kind]),
  ),
  ...Object.fromEntries(
    [
      "textContent",
      "innerText",
      "inputValue",
      "isVisible",
      "isHidden",
      "isChecked",
      "isEnabled",
      "isDisabled",
      "isEditable",
      "count",
      "getAttribute",
      "allTextContents",
      "allInnerTexts",
    ].map((m) => [m, "data" as Kind]),
  ),
}

const KEYBOARD_METHODS = new Set(["press", "type", "insertText", "down", "up"])

const MATCHERS = new Set([
  "toBeVisible",
  "toBeHidden",
  "toBeAttached",
  "toBeInViewport",
  "toHaveText",
  "toContainText",
  "toHaveValue",
  "toHaveValues",
  "toHaveCount",
  "toBeChecked",
  "toBeEnabled",
  "toBeDisabled",
  "toBeEditable",
  "toBeFocused",
  "toBeEmpty",
  "toHaveAttribute",
  "toHaveClass",
  "toHaveAccessibleName",
  "toHaveAccessibleDescription",
  "toHaveRole",
  "toHaveId",
  "toHaveURL",
  "toHaveTitle",
  "toBe",
  "toEqual",
  "toStrictEqual",
  "toBeTruthy",
  "toBeFalsy",
  "toBeDefined",
  "toBeUndefined",
  "toBeNull",
  "toBeNaN",
  "toContain",
  "toContainEqual",
  "toHaveLength",
  "toHaveProperty",
  "toMatch",
  "toMatchObject",
  "toBeGreaterThan",
  "toBeGreaterThanOrEqual",
  "toBeLessThan",
  "toBeLessThanOrEqual",
  "toBeCloseTo",
])
const ASSERTION_MODIFIERS = new Set(["not", "resolves", "rejects"])

const DATA_METHODS = new Set([
  "find",
  "findIndex",
  "filter",
  "map",
  "flatMap",
  "some",
  "every",
  "includes",
  "indexOf",
  "slice",
  "join",
  "at",
  "concat",
  "trim",
  "toLowerCase",
  "toUpperCase",
  "startsWith",
  "endsWith",
  "split",
  "replace",
  "match",
  "test",
  "toFixed",
  "toString",
  "padStart",
])

const GLOBAL_STATICS: Record<string, string[]> = {
  Math: ["abs", "max", "min", "round", "floor", "ceil"],
  JSON: ["stringify", "parse"],
  Date: ["now"],
  Number: ["isFinite", "isInteger", "parseInt", "parseFloat"],
  Array: ["isArray", "from"],
  Promise: ["all", "resolve"],
}
const GLOBAL_FUNCTIONS = new Set(["String", "Number", "Boolean", "parseInt", "parseFloat", "isNaN", "encodeURIComponent"])
const GLOBAL_CONSTRUCTORS = new Set(["Date", "RegExp", "Promise", "Error"])
const GLOBAL_VALUES = new Set(["undefined", "NaN", "Infinity"])

const BANNED_MEMBERS = new Set([
  "constructor",
  "prototype",
  "__proto__",
  "__defineGetter__",
  "__defineSetter__",
  "__lookupGetter__",
  "__lookupSetter__",
  "caller",
  "callee",
  "arguments",
])

const SKIP_MEMBERS = new Set(["skip", "fixme", "only", "fail"])
const HOOKS = new Set(["beforeEach", "afterEach", "beforeAll", "afterAll"])
const NON_SCREEN_MATCHERS = new Set(["toHaveURL", "toHaveTitle"])
const ABSENCE_WHEN_NEGATED = new Set(["toBeVisible", "toBeAttached", "toBeInViewport", "toHaveText", "toContainText", "toMatch", "toContain", "toHaveCount"])
const BREAK_SENTINEL = /E2E_GATE_BREAK|injected[-_ ]?break|gate[-_ ]?break|break[-_ ]?token/i
const PREVIEW_ORIGIN = "https://preview.invalid"
const URL_IN_TEXT = /([a-z][a-z0-9+.-]*):\/\/([^/\s?#'"`\\]*)/gi

const SECRET_PATTERNS: Array<[RegExp, string]> = [
  [/\bsk_(?:live|test)_[A-Za-z0-9]/, "Clerk secret key"],
  [/\bpk_live_[A-Za-z0-9]/, "live publishable key"],
  [/\bsk-ant-[A-Za-z0-9]/, "Anthropic key"],
  [/\bghp_[A-Za-z0-9]{10,}/, "GitHub token"],
  [/\bgithub_pat_[A-Za-z0-9_]{10,}/, "GitHub token"],
  [/\bgh[osu]_[A-Za-z0-9]{20,}/, "GitHub token"],
  [/\bre_[A-Za-z0-9]{16,}/, "Resend key"],
  [/\blin_api_[A-Za-z0-9]{10,}/, "Linear key"],
  [/eyJ[A-Za-z0-9_-]{8,}\.eyJ[A-Za-z0-9_-]{8,}\./, "JWT"],
  [/-----BEGIN [A-Z ]*PRIVATE KEY-----/, "private key"],
  [/__clerk_ticket/, "sign-in ticket parameter"],
  [
    /\b(?:CONVEX_DEPLOY_KEY|CLERK_SECRET_KEY|CLERK_JWT_KEY|ANTHROPIC_API_KEY|E2E_TICKET_AGE_KEY|E2E_TICKET_KEY|E2E_INPUTS_FILE|BREAK_GLASS_ADMIN_PASSWORD|LINEAR_API_KEY|GITHUB_TOKEN|VERCEL_TOKEN|VERCEL_AUTOMATION_BYPASS_SECRET|RESEND_API_KEY)\b/,
    "secret name",
  ],
]

const DATA_ATTR_SELECTOR =
  /^(?:\s*\[data-[a-z0-9-]+(?:[\^$*~|]?=(?:"[^"\]]*"|'[^'\]]*'|[A-Za-z0-9_-]+))?\])+\s*$/
const EXPECT_COMMENT = /^\/\/\s*EXPECT:\s*(.*?)\s*\|\s*SOURCE:\s*(.*?)\s*$/
const PATH_LINE_SOURCE = /^([A-Za-z0-9_.\-/[\]()@]+\.[A-Za-z0-9]+):(\d+)(?:-(\d+))?$/
const DOC_QUOTE_SOURCE = /^(docs\/[A-Za-z0-9_.\-/]+\.[A-Za-z0-9]+):?\s+"[^"]{4,}"$/
const ISSUE_QUOTE_SOURCE = /^(?:issue\s+)?[A-Z]{2,10}-\d+:?\s+"[^"]{4,}"$/
const OBSERVED_SOURCE = /^observed\b/i
const GAP_ID = /^[a-z0-9][a-z0-9-]{0,62}$/

export function classifyExpectSource(
  source: string,
): { kind: ExpectSourceKind; file?: string; line?: number; endLine?: number } | null {
  const s = source.trim()
  if (OBSERVED_SOURCE.test(s)) return { kind: "observed" }
  const pl = PATH_LINE_SOURCE.exec(s)
  if (pl) {
    const file = pl[1]
    const line = Number(pl[2])
    const endLine = pl[3] ? Number(pl[3]) : line
    if (file.startsWith("e2e/")) return { kind: "observed", file, line, endLine }
    return { kind: file.startsWith("docs/") ? "doc" : "code", file, line, endLine }
  }
  const dq = DOC_QUOTE_SOURCE.exec(s)
  if (dq) return { kind: "doc", file: dq[1] }
  if (ISSUE_QUOTE_SOURCE.test(s)) return { kind: "issue" }
  return null
}

function isTypeNode(node: ts.Node): boolean {
  return node.kind >= ts.SyntaxKind.FirstTypeNode && node.kind <= ts.SyntaxKind.LastTypeNode
}

function isReference(node: ts.Identifier): boolean {
  const p = node.parent
  if (!p) return true
  if (ts.isPropertyAccessExpression(p) && p.name === node) return false
  if (ts.isPropertyAssignment(p) && p.name === node) return false
  if (ts.isBindingElement(p) && (p.propertyName === node || p.name === node)) return false
  if (ts.isVariableDeclaration(p) && p.name === node) return false
  if (ts.isParameter(p) && p.name === node) return false
  if (ts.isMethodDeclaration(p) && p.name === node) return false
  if (ts.isPropertyDeclaration(p) && p.name === node) return false
  if (ts.isPropertySignature(p) && p.name === node) return false
  if (ts.isInterfaceDeclaration(p) || ts.isTypeAliasDeclaration(p)) return false
  if (ts.isImportSpecifier(p) || ts.isImportClause(p) || ts.isNamespaceImport(p)) return false
  if (ts.isQualifiedName(p)) return false
  if (ts.isTypeReferenceNode(p)) return false
  if (ts.isLabeledStatement(p) || ts.isBreakOrContinueStatement(p)) return false
  return true
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

function isWrapper(n: ts.Node): n is ts.Expression {
  return (
    ts.isParenthesizedExpression(n) ||
    ts.isAwaitExpression(n) ||
    ts.isNonNullExpression(n) ||
    ts.isAsExpression(n) ||
    ts.isSatisfiesExpression(n) ||
    ts.isTypeAssertionExpression(n)
  )
}

function staticHead(node: ts.Expression | undefined): string | null {
  if (!node) return null
  if (ts.isStringLiteral(node) || ts.isNoSubstitutionTemplateLiteral(node)) return node.text
  if (ts.isTemplateExpression(node)) return node.head.text
  return null
}

function isWholeLiteral(node: ts.Expression | undefined): boolean {
  return !!node && (ts.isStringLiteral(node) || ts.isNoSubstitutionTemplateLiteral(node))
}

function memberName(callee: ts.Expression): string | null {
  if (ts.isPropertyAccessExpression(callee)) return callee.name.text
  if (
    ts.isElementAccessExpression(callee) &&
    (ts.isStringLiteral(callee.argumentExpression) || ts.isNoSubstitutionTemplateLiteral(callee.argumentExpression))
  ) {
    return callee.argumentExpression.text
  }
  return null
}

function contains(node: ts.Node, pred: (n: ts.Node) => boolean): boolean {
  if (pred(node)) return true
  return !!ts.forEachChild(node, (c) => (contains(c, pred) ? true : undefined))
}

function enclosingStatement(node: ts.Node): ts.Statement | null {
  let n: ts.Node | undefined = node
  while (n && !ts.isSourceFile(n)) {
    if (ts.isExpressionStatement(n) || ts.isVariableStatement(n) || ts.isReturnStatement(n)) return n
    n = n.parent
  }
  return null
}

function normalHost(value: string | undefined): string | null {
  if (!value) return null
  try {
    return new URL(value.includes("://") ? value : `https://${value}`).host.toLowerCase()
  } catch {
    return null
  }
}

function resolveImport(spec: string, fromFile: string): string | null {
  if (!spec.startsWith(".")) return null
  return path.posix.normalize(path.posix.join(path.posix.dirname(fromFile), spec))
}

function stripExt(p: string): string {
  return p.replace(/\.(?:ts|tsx|js|mjs)$/, "")
}

function parseDiagnostics(sf: ts.SourceFile): readonly ts.Diagnostic[] {
  return (sf as unknown as { parseDiagnostics?: ts.Diagnostic[] }).parseDiagnostics ?? []
}

function isAssignment(node: ts.Node): node is ts.BinaryExpression {
  return (
    ts.isBinaryExpression(node) &&
    node.operatorToken.kind >= ts.SyntaxKind.FirstAssignment &&
    node.operatorToken.kind <= ts.SyntaxKind.LastAssignment
  )
}

export function checkDraftSpec(source: string, options: DraftCheckOptions = {}): DraftCheckResult {
  const conv: DraftConventions = { ...DEFAULT_CONVENTIONS, ...options.conventions }
  const file = options.path ?? `${conv.specDir}/${options.gapId ?? "draft"}.spec.ts`
  const violations: DraftViolation[] = []
  const sf = ts.createSourceFile(file, source, ts.ScriptTarget.Latest, true, ts.ScriptKind.TS)
  const lineOf = (pos: number) => sf.getLineAndCharacterOfPosition(pos).line + 1
  const add = (rule: DraftRule, pos: number, message: string) => violations.push({ rule, line: lineOf(pos), message })
  const allowedHosts = new Set([normalHost(options.previewHost), normalHost(options.convexHost)].filter((h): h is string => !!h))

  for (const d of parseDiagnostics(sf)) {
    add("parse", d.start ?? 0, ts.flattenDiagnosticMessageText(d.messageText, " "))
  }

  if (options.gapId !== undefined && !GAP_ID.test(options.gapId)) {
    add("path", 0, `gap id "${options.gapId}" is not a valid gap id`)
  }
  const expectedPath = options.gapId ? `${conv.specDir}/${options.gapId}.spec.ts` : null
  if (expectedPath ? file !== expectedPath : !(file.startsWith(`${conv.specDir}/`) && file.endsWith(".spec.ts"))) {
    add("path", 0, `draft must be ${expectedPath ?? `${conv.specDir}/<gapId>.spec.ts`}, got ${file}`)
  }

  source.split("\n").forEach((text, i) => {
    for (const [re, label] of SECRET_PATTERNS) {
      if (re.test(text)) {
        violations.push({ rule: "secret", line: i + 1, message: `contains a ${label}` })
        break
      }
    }
    if (BREAK_SENTINEL.test(text)) {
      violations.push({ rule: "break-sentinel", line: i + 1, message: "a draft must not refer to the injected break or its marker" })
    }
  })

  const imports = new Map<string, Kind>()
  let testImported = false

  for (const stmt of sf.statements) {
    if (ts.isImportEqualsDeclaration(stmt)) {
      add("import-allowlist", stmt.getStart(), "import = require() is not allowed")
      continue
    }
    if (ts.isExportDeclaration(stmt) || ts.isExportAssignment(stmt)) {
      add("import-allowlist", stmt.getStart(), "exports are not allowed")
      continue
    }
    if (!ts.isImportDeclaration(stmt) || !ts.isStringLiteral(stmt.moduleSpecifier)) continue
    const spec = stmt.moduleSpecifier.text
    const resolved = resolveImport(spec, file)
    const mod = resolved ? stripExt(resolved) : spec
    const clause = stmt.importClause
    const named = clause?.namedBindings && ts.isNamedImports(clause.namedBindings) ? clause.namedBindings : null
    const wantsTest = !!named?.elements.some((el) => !el.isTypeOnly && (el.propertyName ?? el.name).text === "test")
    const isFixture = conv.fixtureModules.includes(mod)
    const allowedNames = isFixture
      ? conv.fixtureExports
      : resolved
        ? conv.helperExports[mod]
        : conv.packageExports[spec]
    if (wantsTest && !isFixture) {
      add("fixture", stmt.getStart(), `test must come from ${conv.fixtureModules.join(" or ")}, not "${spec}"`)
      for (const el of named?.elements ?? []) {
        const imported = (el.propertyName ?? el.name).text
        if (!el.isTypeOnly && !el.propertyName && imported === "expect" && allowedNames?.includes(imported)) imports.set(imported, "expect")
      }
      continue
    }
    if (!allowedNames) {
      add("import-allowlist", stmt.getStart(), `import "${spec}" is outside the allowlist`)
      continue
    }
    if (clause?.isTypeOnly) continue
    if (!clause || clause.name || (clause.namedBindings && !named)) {
      add("import-allowlist", stmt.getStart(), `only named imports are allowed from "${spec}"`)
      continue
    }
    for (const el of named?.elements ?? []) {
      if (el.isTypeOnly) continue
      const imported = (el.propertyName ?? el.name).text
      if (!allowedNames.includes(imported)) {
        add("import-allowlist", el.getStart(), `"${imported}" from "${spec}" is outside the allowlist`)
        continue
      }
      if (el.propertyName) {
        add("import-allowlist", el.getStart(), `import "${imported}" under its own name`)
        continue
      }
      if (imported === "test") {
        testImported = true
        continue
      }
      imports.set(imported, imported === "expect" ? "expect" : conv.locatorFactories.includes(imported) ? "helper" : "data")
    }
  }
  if (!testImported) add("fixture", 0, `the draft does not import test from ${conv.fixtureModules.join(" or ")}`)

  const structTestIds = new Set<ts.Identifier>()
  const testFns = new Map<ts.Node, ts.CallExpression>()
  const describeFns = new Set<ts.Node>()
  const testCalls: ts.CallExpression[] = []

  const testChain = (callee: ts.Expression, mark = true): string[] | null => {
    const names: string[] = []
    let cur = callee
    while (ts.isPropertyAccessExpression(cur)) {
      names.unshift(cur.name.text)
      cur = cur.expression
    }
    if (!ts.isIdentifier(cur) || cur.text !== "test") return null
    if (mark) structTestIds.add(cur)
    return names
  }

  const fnArg = (call: ts.CallExpression) =>
    call.arguments.find((a): a is ts.ArrowFunction | ts.FunctionExpression => ts.isArrowFunction(a) || ts.isFunctionExpression(a))

  const structStatement = (stmt: ts.Statement, where: string): void => {
    if (ts.isExpressionStatement(stmt) && ts.isCallExpression(stmt.expression)) {
      const call = stmt.expression
      const names = testChain(call.expression)
      if (names) {
        structCall(call, names)
        return
      }
    }
    add("fixture", stmt.getStart(), `${where} may contain only test(...) and test.describe(...) calls`)
  }

  const structCall = (call: ts.CallExpression, names: string[]): void => {
    const at = call.getStart()
    const [first, second] = names
    if (names.length === 0) {
      testCalls.push(call)
      const fn = fnArg(call)
      if (fn) testFns.set(fn, call)
      return
    }
    if (first === "describe") {
      if (second && SKIP_MEMBERS.has(second)) add("skip", at, `.${second} is not allowed in a draft`)
      else if (second) add("fixture", at, `test.describe.${second} is not allowed in a draft`)
      if (names.length > 2) add("fixture", at, `test.${names.join(".")} is not allowed in a draft`)
      const fn = fnArg(call)
      if (!fn || fn.parameters.length > 0 || !ts.isBlock(fn.body) || !isWholeLiteral(call.arguments[0])) {
        add("fixture", at, "test.describe takes a title and a callback with no parameters")
        return
      }
      describeFns.add(fn)
      for (const s of fn.body.statements) structStatement(s, "a describe body")
      return
    }
    if (SKIP_MEMBERS.has(first)) {
      add("skip", at, `.${first} is not allowed in a draft`)
      if (names.length === 1 && call.arguments.length >= 2) {
        testCalls.push(call)
        const fn = fnArg(call)
        if (fn) testFns.set(fn, call)
      }
      return
    }
    if (HOOKS.has(first)) add("fixture", at, `test.${first} hooks are not allowed in a draft`)
    else if (first === "use" || first === "extend") add("fixture", at, `test.${first} is not allowed in a draft`)
    else add("fixture", at, `test.${names.join(".")} is not allowed; use test(...) or test.describe(...)`)
  }

  for (const stmt of sf.statements) {
    if (
      ts.isImportDeclaration(stmt) ||
      ts.isImportEqualsDeclaration(stmt) ||
      ts.isExportDeclaration(stmt) ||
      ts.isExportAssignment(stmt) ||
      ts.isInterfaceDeclaration(stmt) ||
      ts.isTypeAliasDeclaration(stmt)
    ) {
      continue
    }
    structStatement(stmt, "the top level")
  }

  type Scope = Map<string, { kind: Kind; mutable: boolean }>
  const scopes: Scope[] = []
  const lookup = (name: string): { kind: Kind; mutable: boolean } | null => {
    for (let i = scopes.length - 1; i >= 0; i--) {
      const hit = scopes[i].get(name)
      if (hit) return hit
    }
    return null
  }

  const identKind = (id: ts.Identifier): Kind => {
    const local = lookup(id.text)
    if (local) return local.kind
    const imported = imports.get(id.text)
    if (imported) return imported
    if (id.text === "test") return "test"
    if (GLOBAL_STATICS[id.text] || GLOBAL_FUNCTIONS.has(id.text) || GLOBAL_CONSTRUCTORS.has(id.text)) return `global:${id.text}`
    if (GLOBAL_VALUES.has(id.text)) return "data"
    return "invalid"
  }

  const memberKind = (objKind: Kind, name: string): Kind => {
    if (BANNED_MEMBERS.has(name)) return "invalid"
    switch (objKind) {
      case "page":
        if (name === "keyboard") return "keyboard"
        return name in PAGE_METHODS ? "method:page" : "invalid"
      case "locator":
        return name in LOCATOR_METHODS ? "method:locator" : "invalid"
      case "keyboard":
        return KEYBOARD_METHODS.has(name) ? "method:keyboard" : "invalid"
      case "reader":
        return conv.readerMethods.includes(name) ? "method:reader" : "invalid"
      case "helper":
        return "helper"
      case "expect":
        return name === "soft" || name === "poll" ? "expect" : "invalid"
      case "assertion":
        if (ASSERTION_MODIFIERS.has(name)) return "assertion"
        return MATCHERS.has(name) ? "method:assertion" : "invalid"
      case "data":
        return DATA_METHODS.has(name) ? "method:data" : "data"
      default:
        if (objKind.startsWith("global:")) {
          const g = objKind.slice("global:".length)
          return GLOBAL_STATICS[g]?.includes(name) ? "method:global" : "invalid"
        }
        return "invalid"
    }
  }

  const callResult = (calleeKind: Kind, name: string | null): Kind => {
    switch (calleeKind) {
      case "expect":
        return "assertion"
      case "method:page":
        return PAGE_METHODS[name ?? ""] ?? "invalid"
      case "method:locator":
        return LOCATOR_METHODS[name ?? ""] ?? "invalid"
      case "method:keyboard":
      case "method:assertion":
        return "opaque"
      case "method:reader":
      case "method:global":
      case "method:data":
      case "seed":
        return "data"
      case "helper":
        return "locator"
      default:
        if (calleeKind.startsWith("global:") && GLOBAL_FUNCTIONS.has(calleeKind.slice("global:".length))) return "data"
        return "invalid"
    }
  }

  const kindOf = (expr: ts.Expression): Kind => {
    const e = strip(expr)
    if (ts.isIdentifier(e)) return identKind(e)
    if (ts.isPropertyAccessExpression(e)) return memberKind(kindOf(e.expression), e.name.text)
    if (ts.isElementAccessExpression(e)) {
      const name = memberName(e)
      if (name !== null) return memberKind(kindOf(e.expression), name)
      if (ts.isNumericLiteral(e.argumentExpression)) {
        const k = kindOf(e.expression)
        return k === "data" ? k : "invalid"
      }
      return "invalid"
    }
    if (ts.isCallExpression(e)) return callResult(kindOf(e.expression), memberName(e.expression))
    if (ts.isNewExpression(e)) {
      return ts.isIdentifier(e.expression) && GLOBAL_CONSTRUCTORS.has(e.expression.text) && identKind(e.expression) !== "invalid" && !lookup(e.expression.text)
        ? "data"
        : "invalid"
    }
    if (ts.isArrowFunction(e) || ts.isFunctionExpression(e)) return "fn"
    return "data"
  }

  const rejectedCalls = new Set<ts.Node>()
  const reject = (call: ts.Node, rule: DraftRule, pos: number, message: string) => {
    rejectedCalls.add(call)
    add(rule, pos, message)
  }

  const siteAllowed = (expr: ts.Expression): boolean => {
    let n: ts.Node = expr
    while (n.parent && isWrapper(n.parent)) n = n.parent
    const p = n.parent
    if (!p) return false
    if ((ts.isPropertyAccessExpression(p) || ts.isElementAccessExpression(p)) && p.expression === n) return true
    if (ts.isCallExpression(p)) {
      if (p.expression === n) return true
      if (rejectedCalls.has(p)) return true
      const ck = kindOf(p.expression)
      const k = kindOf(n as ts.Expression)
      if (ck === "helper") return p.arguments[0] === n && k === "page"
      if (ck === "expect") return k === "page" || k === "locator"
      return (ck === "method:page" || ck === "method:locator") && k === "locator"
    }
    if (ts.isVariableDeclaration(p) && p.initializer === n && ts.isIdentifier(p.name)) return true
    if (ts.isExpressionStatement(p)) return true
    if (ts.isPropertyAssignment(p) && p.initializer === n && ts.isObjectLiteralExpression(p.parent)) {
      let o: ts.Node = p.parent
      while (o.parent && isWrapper(o.parent)) o = o.parent
      const call = o.parent
      if (call && ts.isCallExpression(call) && call.arguments.includes(o as ts.Expression)) {
        const ck = kindOf(call.expression)
        return rejectedCalls.has(call) || ((ck === "method:page" || ck === "method:locator") && kindOf(n as ts.Expression) === "locator")
      }
    }
    return false
  }

  const checkUseSite = (expr: ts.Expression, kind: Kind) => {
    if (CAPABILITIES.has(kind) && !siteAllowed(expr)) {
      add("forbidden-api", expr.getStart(), `a ${kind} may only be used through its allowlisted methods`)
    }
  }

  const urlHostsOk = (text: string, pos: number, relative: boolean) => {
    for (const m of text.matchAll(URL_IN_TEXT)) {
      const host = (m[2] ?? "").toLowerCase()
      if (!allowedHosts.has(host)) add("egress", pos, `URL host "${host}" is not the preview or its Convex deployment`)
    }
    if (relative && /^\/\/[^/]/.test(text)) add("egress", pos, "protocol-relative URLs are not allowed")
  }

  const relativeOnly = (arg: ts.Expression | undefined): boolean => {
    if (!arg) return false
    const parts = ts.isTemplateExpression(arg)
      ? [arg.head.text, ...arg.templateSpans.map((s) => s.literal.text)]
      : isWholeLiteral(arg)
        ? [(arg as ts.StringLiteral).text]
        : null
    if (!parts || parts.some((t) => /[\s\u0000-\u001f\u007f\\]/.test(t))) return false
    const head = parts[0]
    if (ts.isTemplateExpression(arg) && !/^\/[A-Za-z0-9._~%!$&'()*+,;=:@-]/.test(head)) return false
    if (!head.startsWith("/") || head.startsWith("//")) return false
    try {
      return new URL(ts.isTemplateExpression(arg) ? `${head}x` : head, PREVIEW_ORIGIN).origin === PREVIEW_ORIGIN
    } catch {
      return false
    }
  }

  const selectorOk = (arg: ts.Expression | undefined): boolean => {
    if (!arg) return false
    if (isWholeLiteral(arg)) return DATA_ATTR_SELECTOR.test((arg as ts.StringLiteral).text)
    if (!ts.isTemplateExpression(arg)) return false
    const quasis = [arg.head.text, ...arg.templateSpans.map((s) => s.literal.text)]
    for (let i = 0; i < quasis.length - 1; i++) {
      if (!/="$/.test(quasis[i]) || !/^"/.test(quasis[i + 1])) return false
    }
    return DATA_ATTR_SELECTOR.test(quasis.join("x"))
  }

  const bindPattern = (name: ts.BindingName, kind: Kind, mutable: boolean, scope: Scope): void => {
    if (ts.isIdentifier(name)) {
      scope.set(name.text, { kind, mutable })
      return
    }
    for (const el of name.elements) {
      if (ts.isOmittedExpression(el)) continue
      bindPattern(el.name, "data", mutable, scope)
    }
  }

  const bindFixtures = (fn: ts.ArrowFunction | ts.FunctionExpression, scope: Scope) => {
    const param = fn.parameters[0]
    if (fn.parameters.length > 1) {
      add("fixture", fn.parameters[1].getStart(), "a test takes only its fixtures")
      for (const extra of fn.parameters.slice(1)) bindPattern(extra.name, "invalid", false, scope)
    }
    if (!param) return
    if (!ts.isObjectBindingPattern(param.name)) {
      add("signed-in", param.getStart(), "fixtures must be destructured")
      bindPattern(param.name, "invalid", false, scope)
      return
    }
    for (const el of param.name.elements) {
      const key = el.propertyName ? el.propertyName.getText() : el.name.getText()
      const local = ts.isIdentifier(el.name) ? el.name.text : null
      let kind: Kind = "invalid"
      if (el.dotDotDotToken) add("fixture", el.getStart(), "rest fixtures are not allowed")
      else if (!local) add("fixture", el.getStart(), "fixtures must not be destructured further")
      else if (el.initializer) add("fixture", el.getStart(), "fixtures must not have defaults")
      else if (key.startsWith("_")) add("fixture", el.getStart(), `fixture "${key}" is internal`)
      else if (conv.forbiddenFixtures.includes(key)) add("signed-in", el.getStart(), `fixture "${key}" is not allowed in a draft`)
      else if (conv.signedInFixtures.includes(key)) kind = "page"
      else if (conv.readerFixtures.includes(key)) kind = "reader"
      else if (conv.seedFixtures.includes(key)) kind = "seed"
      else add("fixture", el.getStart(), `fixture "${key}" is not on the allowlist`)
      if (local) scope.set(local, { kind, mutable: false })
      else bindPattern(el.name, "invalid", false, scope)
    }
  }

  const visitIdentifier = (node: ts.Identifier) => {
    if (!isReference(node) || node.text === "") return
    if (node.text === "test") {
      if (!structTestIds.has(node)) add("fixture", node.getStart(), "test may only be called directly as test(...) or test.describe(...)")
      return
    }
    const kind = identKind(node)
    if (kind === "invalid") {
      if (node.text === "fetch") add("egress", node.getStart(), "fetch is not allowed in a draft")
      else if (node.text === "setTimeout" || node.text === "setInterval") add("wait-for-timeout", node.getStart(), "fixed waits (setTimeout) are not allowed")
      else if (node.text === "signIn") add("signed-in", node.getStart(), "drafts must not sign in themselves; use a signed-in fixture")
      else if (!lookup(node.text)) add("forbidden-api", node.getStart(), `${node.text} is not allowed in a draft`)
      return
    }
    checkUseSite(node, kind)
  }

  const visitMember = (node: ts.PropertyAccessExpression | ts.ElementAccessExpression) => {
    const name = memberName(node)
    const objKind = kindOf(node.expression)
    const isCallee = !!node.parent && ts.isCallExpression(node.parent) && node.parent.expression === node
    if (ts.isElementAccessExpression(node) && name === null) {
      if (!ts.isNumericLiteral(node.argumentExpression)) add("forbidden-api", node.getStart(), "computed member access is not allowed")
      else if (objKind !== "data" && objKind !== "invalid") add("forbidden-api", node.getStart(), `indexing a ${objKind} is not allowed`)
      return
    }
    if (name === null) return
    if (BANNED_MEMBERS.has(name)) add("forbidden-api", node.getStart(), `.${name} is not allowed in a draft`)
    else if (name === "waitForTimeout") add("wait-for-timeout", node.getStart(), "waitForTimeout is not allowed")
    else if (name === "$" || name === "$$") add("selector", node.getStart(), `.${name} selectors are not allowed; use getBy* or a data- attribute`)
    else if (objKind === "test") return
    else if (name === "request" || name === "fetch") add("egress", node.getStart(), `.${name} is not allowed in a draft`)
    else if (objKind === "invalid") return
    else {
      const k = memberKind(objKind, name)
      if (k === "invalid") add("forbidden-api", node.getStart(), `.${name} is not allowed on a ${objKind.replace(/^global:/, "")}`)
      else if (k.startsWith("method:") && !isCallee) add("forbidden-api", node.getStart(), `.${name} may only be called`)
      else checkUseSite(node, k)
    }
  }

  const visitCall = (node: ts.CallExpression) => {
    const callee = node.expression
    const at = node.getStart()
    if (callee.kind === ts.SyntaxKind.ImportKeyword) {
      reject(node, "forbidden-api", at, "dynamic import() is not allowed")
      return
    }
    const ck = kindOf(callee)
    const name = memberName(callee)
    if (ck === "test" || testChain(callee, false) !== null) {
      if (!testCalls.includes(node)) rejectedCalls.add(node)
      return
    }
    if (ck === "invalid") {
      rejectedCalls.add(node)
      return
    }
    if (callResult(ck, name) === "invalid" && !(ck.startsWith("global:") && GLOBAL_FUNCTIONS.has(ck.slice(7)))) {
      reject(node, "forbidden-api", at, `calling ${callee.getText().slice(0, 60)} is not allowed in a draft`)
      return
    }
    if (ck === "method:reader") {
      const arg = node.arguments[0]
      if (!isWholeLiteral(arg)) reject(node, "forbidden-api", at, "query takes a literal function path")
    }
    if (ck === "helper") {
      const first = node.arguments[0]
      if (ts.isIdentifier(strip(callee)) || !first || kindOf(first) !== "page") {
        reject(node, "forbidden-api", at, "a selector helper is called as sel.<group>.<name>(page, ...values)")
        return
      }
    }
    if (ck === "method:page" && name === "goto" && !relativeOnly(node.arguments[0])) {
      reject(node, "egress", at, "goto takes only a relative path on the preview")
    }
    if (ck === "method:page" && name === "goto") {
      const head = staticHead(node.arguments[0])
      if (head !== null && /\/sign-in(?:[/?#]|$)/.test(head)) add("signed-in", at, "drafts must not sign in themselves; use a signed-in fixture")
    }
    if (ck === "method:page" && name === "waitForURL") {
      const arg = node.arguments[0]
      const ok =
        !!arg &&
        (ts.isRegularExpressionLiteral(arg) ||
          relativeOnly(arg) ||
          (isWholeLiteral(arg) && /^https:\/\/[^\s\\]+$/.test(staticHead(arg) ?? "")))
      if (!ok) reject(node, "egress", at, "waitForURL takes a relative path, a regex or a URL on the preview")
    }
    if ((ck === "method:page" || ck === "method:locator") && name === "locator") {
      if (!selectorOk(node.arguments[0])) add("selector", at, "locator() takes only [data-*] attribute selectors; use getByRole/getByTestId/getByText/getByLabel")
    }
    checkUseSite(node, callResult(ck, name))
  }

  const visitNew = (node: ts.NewExpression) => {
    const e = node.expression
    if (ts.isIdentifier(e) && identKind(e) === "invalid") return
    if (kindOf(node) === "invalid") reject(node, "forbidden-api", node.getStart(), `new ${e.getText().slice(0, 40)} is not allowed in a draft`)
  }

  const visitAssignment = (node: ts.BinaryExpression) => {
    const left = strip(node.left)
    if (ts.isIdentifier(left)) {
      const local = lookup(left.text)
      if (!local) return
      if (!local.mutable || local.kind !== "data") add("forbidden-api", node.getStart(), `assigning to ${left.text} is not allowed`)
    } else if (ts.isPropertyAccessExpression(left) || ts.isElementAccessExpression(left)) {
      const k = kindOf(left.expression)
      if (k !== "data" && k !== "invalid") add("forbidden-api", node.getStart(), "assigning to a property of a fixture or global is not allowed")
    } else {
      add("forbidden-api", node.getStart(), "destructuring assignment is not allowed")
    }
    const rk = kindOf(node.right)
    if (CAPABILITIES.has(rk)) add("forbidden-api", node.right.getStart(), `a ${rk} may only be used through its allowlisted methods`)
  }

  const walk = (node: ts.Node): void => {
    if (isTypeNode(node)) return
    if (ts.isImportDeclaration(node) || ts.isExportDeclaration(node) || ts.isInterfaceDeclaration(node) || ts.isTypeAliasDeclaration(node)) return
    if (ts.isIdentifier(node)) {
      visitIdentifier(node)
      return
    }
    if (ts.isMetaProperty(node)) add("forbidden-api", node.getStart(), "import.meta is not allowed")
    if (node.kind === ts.SyntaxKind.ThisKeyword) add("forbidden-api", node.getStart(), "this is not allowed in a draft")
    if (ts.isFunctionDeclaration(node) || ts.isClassDeclaration(node) || ts.isClassExpression(node)) {
      add("forbidden-api", node.getStart(), "declaring functions or classes is not allowed; pass callbacks inline")
    }
    if (ts.isWithStatement(node) || ts.isLabeledStatement(node) || ts.isDebuggerStatement(node)) {
      add("forbidden-api", node.getStart(), "this statement is not allowed in a draft")
    }
    if (ts.isTaggedTemplateExpression(node)) add("forbidden-api", node.getStart(), "tagged templates are not allowed")
    if (ts.isMethodDeclaration(node) || ts.isGetAccessorDeclaration(node) || ts.isSetAccessorDeclaration(node)) {
      add("forbidden-api", node.getStart(), "object methods and accessors are not allowed")
    }
    if (ts.isStringLiteral(node) || ts.isNoSubstitutionTemplateLiteral(node) || ts.isTemplateHead(node) || ts.isTemplateMiddle(node) || ts.isTemplateTail(node)) {
      urlHostsOk(node.text, node.getStart(), true)
    }
    if (ts.isRegularExpressionLiteral(node)) urlHostsOk(node.text.replace(/\\\//g, "/"), node.getStart(), false)
    if (ts.isPropertyAccessExpression(node) || ts.isElementAccessExpression(node)) visitMember(node)
    if (ts.isCallExpression(node)) visitCall(node)
    if (ts.isNewExpression(node)) visitNew(node)
    if (isAssignment(node)) visitAssignment(node)
    if (ts.isSpreadElement(node) || ts.isSpreadAssignment(node)) {
      const k = kindOf(node.expression)
      if (CAPABILITIES.has(k)) add("forbidden-api", node.getStart(), `a ${k} may only be used through its allowlisted methods`)
    }

    if (ts.isArrowFunction(node) || ts.isFunctionExpression(node)) {
      const p = node.parent
      const asArg = !!p && (ts.isCallExpression(p) || ts.isNewExpression(p)) && !!p.arguments?.includes(node)
      if (!asArg) add("forbidden-api", node.getStart(), "functions may only be passed inline as callbacks")
      const scope: Scope = new Map()
      scopes.push(scope)
      if (testFns.has(node)) bindFixtures(node, scope)
      else for (const prm of node.parameters) bindPattern(prm.name, "data", false, scope)
      for (const prm of node.parameters) if (prm.initializer) walk(prm.initializer)
      walk(node.body)
      scopes.pop()
      return
    }
    if (ts.isBlock(node) || ts.isForStatement(node) || ts.isForOfStatement(node) || ts.isForInStatement(node)) {
      scopes.push(new Map())
      ts.forEachChild(node, walk)
      scopes.pop()
      return
    }
    if (ts.isVariableDeclarationList(node)) {
      const flags = node.flags
      const mutable = !(flags & ts.NodeFlags.Const)
      if (!(flags & (ts.NodeFlags.Const | ts.NodeFlags.Let))) add("forbidden-api", node.getStart(), "var is not allowed; use const or let")
      const scope = scopes[scopes.length - 1] ?? new Map()
      for (const decl of node.declarations) {
        if (decl.initializer) walk(decl.initializer)
        const kind: Kind = decl.initializer ? kindOf(decl.initializer) : "data"
        const loopVar = !!node.parent && (ts.isForOfStatement(node.parent) || ts.isForInStatement(node.parent))
        if (ts.isIdentifier(decl.name)) {
          scope.set(decl.name.text, { kind: loopVar ? "data" : kind, mutable })
        } else {
          if (CAPABILITIES.has(kind) || kind === "invalid") {
            if (kind !== "invalid") add("forbidden-api", decl.name.getStart(), `do not destructure a ${kind}`)
            bindPattern(decl.name, "invalid", mutable, scope)
          } else bindPattern(decl.name, "data", mutable, scope)
          ts.forEachChild(decl.name, walk)
        }
      }
      return
    }
    ts.forEachChild(node, walk)
  }
  walk(sf)

  const expectStatements = new Map<ts.Statement, ts.CallExpression>()
  const collectExpects = (node: ts.Node): void => {
    if (ts.isCallExpression(node) && isExpectCall(node)) {
      const stmt = enclosingStatement(node)
      if (stmt && !expectStatements.has(stmt)) expectStatements.set(stmt, node)
      if (!stmt) add("expect-comment", node.getStart(), "expect must be its own statement")
    }
    ts.forEachChild(node, collectExpects)
  }
  collectExpects(sf)

  const varInits = new Map<string, ts.Expression>()
  const collectInits = (n: ts.Node): void => {
    if (ts.isVariableDeclaration(n) && ts.isIdentifier(n.name) && n.initializer) varInits.set(n.name.text, n.initializer)
    ts.forEachChild(n, collectInits)
  }
  collectInits(sf)

  function assertionNeedles(stmt: ts.Statement): string[] {
    const out = new Set<string>()
    const seen = new Set<string>()
    const scan = (n: ts.Node): void => {
      if (ts.isStringLiteral(n) || ts.isNoSubstitutionTemplateLiteral(n)) out.add(n.text)
      else if (ts.isTemplateHead(n) || ts.isTemplateMiddle(n) || ts.isTemplateTail(n)) out.add(n.text)
      else if (ts.isNumericLiteral(n)) out.add(n.text)
      else if (ts.isPropertyAccessExpression(n) && !(n.parent && ts.isCallExpression(n.parent) && n.parent.expression === n)) {
        if (n.name.text !== "length" && n.name.text !== "not") out.add(n.name.text)
      } else if (ts.isIdentifier(n) && isReference(n) && varInits.has(n.text) && !seen.has(n.text)) {
        seen.add(n.text)
        scan(varInits.get(n.text)!)
      }
      ts.forEachChild(n, scan)
    }
    scan(stmt)
    for (const n of [...out]) {
      for (const m of n.matchAll(/\[(data-[a-z0-9-]+)(?:[\^$*~|]?=["']?([^"'\]]*))?/g)) {
        out.add(m[1])
        if (m[2]) out.add(m[2])
      }
    }
    return [...out].filter((n) => n.trim().length >= 2)
  }

  const commentOf = new Map<ts.Statement, { sentence: string; source: string } | null>()
  for (const [stmt] of expectStatements) {
    const ranges = ts.getLeadingCommentRanges(source, stmt.getFullStart()) ?? []
    const last = ranges[ranges.length - 1]
    let parsed: { sentence: string; source: string } | null = null
    if (last && last.kind === ts.SyntaxKind.SingleLineCommentTrivia) {
      const m = EXPECT_COMMENT.exec(source.slice(last.pos, last.end))
      if (m) parsed = { sentence: m[1], source: m[2] }
    }
    commentOf.set(stmt, parsed)
    if (!parsed) {
      add("expect-comment", stmt.getStart(), "expect is not preceded by // EXPECT: <sentence> | SOURCE: <source>")
      continue
    }
    if (parsed.sentence.split(/\s+/).filter(Boolean).length < 3) {
      add("expect-comment", stmt.getStart(), "EXPECT must be a plain sentence")
    }
    const src = classifyExpectSource(parsed.source)
    if (!src) {
      add("expect-comment", stmt.getStart(), `SOURCE "${parsed.source}" is not observed, <path>:<line>, a docs quote or an issue quote`)
    } else if (src.kind !== "observed" && src.file && src.line !== undefined && options.sourceExists) {
      const needles = assertionNeedles(stmt)
      if (!options.sourceExists(src.file, src.line, needles, src.endLine)) {
        add("expect-comment", stmt.getStart(), `SOURCE ${src.file}:${src.line} does not exist or does not mention ${needles.slice(0, 5).map((n) => JSON.stringify(n)).join(", ") || "anything the assertion checks"}`)
      }
    }
  }

  if (testCalls.length === 0 && testImported) add("fixture", 0, "the draft declares no test")
  for (const call of testCalls) checkTest(call)

  function checkTest(call: ts.CallExpression): void {
    const at = call.getStart()
    const [titleArg, second] = call.arguments
    const fn = fnArg(call)
    const details = second && ts.isObjectLiteralExpression(second) ? second : undefined
    const title = staticHead(titleArg)
    if (title === null || !isWholeLiteral(titleArg)) {
      add("tags", at, "test title must be a string literal")
    }
    const tags = new Set((title ?? "").match(/@[^\s]+/g) ?? [])
    const tagProp = details?.properties.find(
      (p): p is ts.PropertyAssignment => ts.isPropertyAssignment(p) && p.name.getText() === "tag",
    )
    if (tagProp) {
      const init = tagProp.initializer
      const items = ts.isArrayLiteralExpression(init) ? [...init.elements] : [init]
      for (const it of items) {
        if (ts.isStringLiteral(it) || ts.isNoSubstitutionTemplateLiteral(it)) tags.add(it.text)
        else add("tags", it.getStart(), "tags must be string literals")
      }
    }
    if (!tags.has("@drafted")) add("tags", at, "test is missing the @drafted tag")
    const gaps = [...tags].filter((t) => t.startsWith("@gap:"))
    if (gaps.length !== 1) add("tags", at, "test needs exactly one @gap:<id> tag")
    else if (options.gapId && gaps[0] !== `@gap:${options.gapId}`) {
      add("tags", at, `test is tagged ${gaps[0]}, expected @gap:${options.gapId}`)
    }
    if (![...tags].some((t) => /^@node:.+/.test(t))) add("tags", at, "test needs an @node:<node> tag")

    if (!fn) {
      add("fixture", at, "test has no body")
      return
    }
    const param = fn.parameters[0]
    const used = new Set<string>()
    if (param && ts.isObjectBindingPattern(param.name)) {
      for (const el of param.name.elements) {
        if (!el.dotDotDotToken) used.add((el.propertyName ?? el.name).getText())
      }
    }
    if (!conv.signedInFixtures.some((f) => used.has(f))) {
      add("signed-in", at, `test must use a signed-in fixture (${conv.signedInFixtures.join(", ")})`)
    }

    const readers = new Set(conv.readerFixtures.filter((f) => used.has(f)))
    const isReaderCall = (n: ts.Node): boolean =>
      ts.isCallExpression(n) &&
      ts.isPropertyAccessExpression(n.expression) &&
      ts.isIdentifier(n.expression.expression) &&
      readers.has(n.expression.expression.text) &&
      conv.readerMethods.includes(n.expression.name.text)
    const isLocatorCall = (n: ts.Node): boolean => {
      if (!ts.isCallExpression(n)) return false
      const name = memberName(n.expression)
      return !!name && (name.startsWith("getBy") || name === "locator")
    }
    const savedVars = new Set<string>()
    const locatorVars = new Map<string, ts.Expression>()
    const collectVars = (n: ts.Node): void => {
      if (ts.isVariableDeclaration(n) && n.initializer) {
        const names: string[] = []
        const gather = (b: ts.BindingName) => {
          if (ts.isIdentifier(b)) names.push(b.text)
          else for (const e of b.elements) if (!ts.isOmittedExpression(e)) gather(e.name)
        }
        gather(n.name)
        const init = n.initializer
        const refs = (set: { has(k: string): boolean }) => contains(init, (x) => ts.isIdentifier(x) && set.has(x.text) && isReference(x))
        if (contains(init, isReaderCall) || refs(savedVars)) names.forEach((v) => savedVars.add(v))
        if (contains(init, isLocatorCall) || refs(locatorVars)) names.forEach((v) => locatorVars.set(v, init))
      }
      ts.forEachChild(n, collectVars)
    }
    collectVars(fn.body)

    const textual = (n: ts.Node): boolean => {
      const seen = new Set<string>()
      const check = (x: ts.Node): boolean =>
        contains(x, (y) => {
          if (ts.isRegularExpressionLiteral(y)) return true
          if (ts.isNewExpression(y) && ts.isIdentifier(y.expression) && y.expression.text === "RegExp") return true
          if (ts.isCallExpression(y) && memberName(y.expression) === "getByText") return true
          if (ts.isIdentifier(y) && locatorVars.has(y.text) && !seen.has(y.text)) {
            seen.add(y.text)
            return check(locatorVars.get(y.text)!)
          }
          return false
        })
      return check(n)
    }

    let screen = false
    let saved = false
    let intent = false
    for (const [stmt, expectCall] of expectStatements) {
      if (!within(stmt, fn)) continue
      const subject = expectCall.arguments[0]
      const m = matcherChain(expectCall)
      if (!subject) continue
      const refsVar = (set: { has(k: string): boolean }) => contains(subject, (x) => ts.isIdentifier(x) && set.has(x.text) && isReference(x))
      if (contains(subject, isReaderCall) || refsVar(savedVars)) saved = true
      else if ((contains(subject, isLocatorCall) || refsVar(locatorVars)) && !(m.name && NON_SCREEN_MATCHERS.has(m.name))) {
        screen = true
      }
      const c = commentOf.get(stmt)
      const kind = c ? classifyExpectSource(c.source)?.kind : undefined
      if (kind && kind !== "observed") intent = true

      const zeroArg = m.args[0] && ts.isNumericLiteral(m.args[0]) && Number(m.args[0].text) === 0
      const countSubject = contains(subject, (y) => ts.isCallExpression(y) && memberName(y.expression) === "count")
      const absence =
        m.name === "toBeHidden" ||
        (m.negated && !!m.name && ABSENCE_WHEN_NEGATED.has(m.name)) ||
        (m.name === "toHaveCount" && zeroArg && !m.negated) ||
        (countSubject && (m.name === "toBe" || m.name === "toEqual") && zeroArg && !m.negated)
      const textArgs = m.args.some((a) => textual(a))
      if (absence && (textual(subject) || textArgs) && (!kind || kind === "observed")) {
        add("break-sentinel", stmt.getStart(), "an assertion that text is absent needs a code, doc or issue SOURCE")
      }
    }
    if (!screen) add("screen-assertion", at, "test asserts nothing on screen")
    if (!saved) add("saved-state-read", at, "test never asserts on saved state read back through a signed-in channel")
    if (!intent) add("intent-source", at, "every assertion is sourced from observed behaviour; at least one needs a code, doc or issue source")
  }

  const seen = new Set<string>()
  const unique = violations.filter((v) => {
    const key = `${v.rule}|${v.line}|${v.message}`
    if (seen.has(key)) return false
    seen.add(key)
    return true
  })
  unique.sort((a, b) => a.line - b.line || a.rule.localeCompare(b.rule))
  return { ok: unique.length === 0, violations: unique }
}

function within(node: ts.Node, ancestor: ts.Node): boolean {
  return node.pos >= ancestor.pos && node.end <= ancestor.end
}

function isExpectCall(node: ts.CallExpression): boolean {
  const c = node.expression
  if (ts.isIdentifier(c)) return c.text === "expect"
  return ts.isPropertyAccessExpression(c) && ts.isIdentifier(c.expression) && c.expression.text === "expect" && (c.name.text === "poll" || c.name.text === "soft")
}

function matcherChain(expectCall: ts.CallExpression): { name: string | null; negated: boolean; args: readonly ts.Expression[] } {
  let n: ts.Node = expectCall
  let negated = false
  while (n.parent && ts.isPropertyAccessExpression(n.parent) && n.parent.expression === n) {
    const pa: ts.PropertyAccessExpression = n.parent
    if (pa.name.text === "not") negated = !negated
    if (pa.parent && ts.isCallExpression(pa.parent) && pa.parent.expression === pa) {
      return { name: pa.name.text, negated, args: pa.parent.arguments }
    }
    n = pa
  }
  return { name: null, negated, args: [] }
}

export function formatViolations(result: DraftCheckResult, file: string): string {
  return result.violations.map((v) => `${file}:${v.line} [${v.rule}] ${v.message}`).join("\n")
}
