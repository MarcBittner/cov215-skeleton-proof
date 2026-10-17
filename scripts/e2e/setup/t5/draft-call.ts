import { createHash } from "node:crypto"
import fs from "node:fs"
import path from "node:path"
import { fileURLToPath } from "node:url"

import type Anthropic from "@anthropic-ai/sdk"

import { DEFAULT_CONVENTIONS, checkDraftSpec, classifyExpectSource, type DraftCheckResult, type SourceCheck } from "../../gate/checker.js"
import { draftSpecPath } from "../../gate/gate-run.js"
import type { Gap } from "../../map/reports/gaps.js"
import {
  ATTEMPT_ESTIMATE_USD,
  MAX_GAP_FIELD_CHARS,
  MAX_INPUT_BYTES,
  MAX_OUTPUT_TOKENS,
  MAX_PREVIOUS_SPEC_BYTES,
  MAX_REPAIR_ROUNDS,
  MAX_SOURCE_BYTES,
  MAX_SOURCE_REF_CHARS,
  MAX_SOURCES_PER_GAP,
  MAX_VIOLATIONS_FED_BACK,
  NO_USAGE,
  addUsage,
  canSpend,
  costOf,
  type TokenUsage,
} from "./limits.js"
import type { Expectation, InjectedBreak, IntentSource } from "./types.js"

export const MODEL = "claude-opus-5-5"
export const EFFORT = "high"
export const MAX_TOKENS = MAX_OUTPUT_TOKENS
export const ATTEMPT_TIMEOUT_MS = 180_000

type CreateParams = Anthropic.Beta.Messages.MessageCreateParamsNonStreaming
type BetaMessage = Anthropic.Beta.Messages.BetaMessage
type TextBlockParam = Anthropic.Beta.Messages.BetaTextBlockParam

export interface DraftClient {
  beta: {
    messages: {
      create(body: CreateParams, options?: Anthropic.RequestOptions): PromiseLike<BetaMessage>
    }
  }
}

export const PROMPT_FILE = "scripts/e2e/setup/t5/prompt.md"

export function promptPathFor(moduleDir: string): string {
  const marker = `${path.sep}scripts${path.sep}e2e${path.sep}`
  const at = moduleDir.indexOf(marker)
  if (at < 0) throw new Error(`${moduleDir} is not under scripts/e2e`)
  return path.join(moduleDir.slice(0, at), ...PROMPT_FILE.split("/"))
}

function promptPath(): string {
  return promptPathFor(path.dirname(fileURLToPath(import.meta.url)))
}

export const PROMPT = fs.readFileSync(promptPath(), "utf8")

export const OUTPUT_SCHEMA = {
  type: "object",
  properties: { spec: { type: "string" } },
  required: ["spec"],
  additionalProperties: false,
} as const

const escapeTags = (text: string) => text.replace(/</g, "&lt;").replace(/>/g, "&gt;")
const attr = (text: string) => text.replace(/[^A-Za-z0-9_./:@()[\]-]/g, "_")
const bytes = (text: string) => Buffer.byteLength(text, "utf8")

export function clipBytes(text: string, max: number): string {
  if (bytes(text) <= max) return text
  const marker = "\n[truncated]"
  const room = Math.max(0, max - bytes(marker))
  let out = Buffer.from(text, "utf8").subarray(0, room).toString("utf8")
  while (bytes(out) > room) out = out.slice(0, -1)
  if (out.endsWith("\uFFFD")) out = out.slice(0, -1)
  return out + marker
}

const field = (text: string) => clipBytes(escapeTags(String(text)), MAX_GAP_FIELD_CHARS)

export function requestInputBytes(req: CreateParams): number {
  const system = Array.isArray(req.system) ? req.system.map((b) => b.text).join("") : (req.system ?? "")
  const content = req.messages.flatMap((m) => (typeof m.content === "string" ? [m.content] : m.content.map((b) => ("text" in b ? b.text : ""))))
  return bytes(system) + content.reduce((n, t) => n + bytes(t), 0) + bytes(JSON.stringify(OUTPUT_SCHEMA))
}

export function gapSlug(gapId: string): string {
  const base = gapId
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 50)
    .replace(/-+$/, "")
  const hash = createHash("sha256").update(gapId).digest("hex").slice(0, 8)
  return base ? `${base}-${hash}` : hash
}

export function routeNode(route: string): string {
  return `route:${route}`
}

export function draftable(gap: Gap): string | null {
  if (gap.status !== "open") return `gap status is ${gap.status}`
  if (!DEFAULT_CONVENTIONS.signedInFixtures.includes(gap.role)) return `no signed-in fixture for role ${gap.role}`
  return null
}

export function applicableBreaks(gap: Gap): InjectedBreak[] {
  return gap.kind === "control" ? ["alter-query-field", "drop-mutation-frame"] : ["alter-query-field"]
}

export function buildDraftRequest(opts: {
  gap: Gap
  slug: string
  sources: IntentSource[]
  previous?: { spec: string; check: DraftCheckResult }
}): CreateParams {
  const { gap, slug } = opts
  const gapText = [
    "<gap>",
    `id: ${field(gap.id)}`,
    `kind: ${gap.kind === "control" ? "control" : "screen"}`,
    `route: ${field(gap.route)}`,
    `role: ${field(gap.role)} (fixtures ${field(gap.role)} and ${field(gap.role)}Ch)`,
    ...(gap.kind === "control" ? [`control: ${field(gap.controlKey)}`] : []),
    "</gap>",
  ].join("\n")
  const conventionsText = [
    "<conventions>",
    `file: ${draftSpecPath(slug)}`,
    `tags: @drafted @gap:${slug} @node:${field(routeNode(gap.route))}`,
    `fixture module: ../gate/inject-break`,
    "</conventions>",
  ].join("\n")
  const content: TextBlockParam[] = [
    { type: "text", text: gapText },
    { type: "text", text: conventionsText },
  ]
  const tail: TextBlockParam[] = []
  if (opts.previous) {
    tail.push({ type: "text", text: `<previous_spec>\n${clipBytes(escapeTags(opts.previous.spec), MAX_PREVIOUS_SPEC_BYTES)}\n</previous_spec>` })
    tail.push({
      type: "text",
      text:
        "<violations>\n" +
        opts.previous.check.violations
          .slice(0, MAX_VIOLATIONS_FED_BACK)
          .map((v) => clipBytes(`line ${v.line} [${v.rule}] ${escapeTags(v.message)}`, 200))
          .join("\n") +
        "\n</violations>",
    })
  }
  const fixed =
    bytes(PROMPT) + bytes(JSON.stringify(OUTPUT_SCHEMA)) + [...content, ...tail].reduce((n, b) => n + bytes(b.text), 0)
  let budget = MAX_INPUT_BYTES - fixed
  for (const s of opts.sources.slice(0, MAX_SOURCES_PER_GAP)) {
    const open = `<untrusted_source kind="${s.kind === "doc" || s.kind === "issue" ? s.kind : "code"}" ref="${attr(String(s.ref).slice(0, MAX_SOURCE_REF_CHARS))}">\n`
    const close = "\n</untrusted_source>"
    const room = Math.min(MAX_SOURCE_BYTES, budget) - bytes(open) - bytes(close)
    if (room < 64) break
    const text = open + clipBytes(escapeTags(String(s.text)), room) + close
    budget -= bytes(text)
    content.push({ type: "text", text })
  }
  content.push(...tail)
  const req: CreateParams = {
    model: MODEL,
    max_tokens: MAX_TOKENS,
    output_config: { effort: EFFORT, format: { type: "json_schema", schema: OUTPUT_SCHEMA } },
    system: [{ type: "text", text: PROMPT }],
    messages: [{ role: "user", content }],
  }
  const size = requestInputBytes(req)
  if (size > MAX_INPUT_BYTES) throw new Error(`draft request is ${size} bytes, over the ${MAX_INPUT_BYTES}-byte input cap`)
  return req
}

function usageOf(response: BetaMessage): TokenUsage {
  const u = response.usage
  return {
    input: u?.input_tokens ?? 0,
    cacheWrite: u?.cache_creation_input_tokens ?? 0,
    cacheRead: u?.cache_read_input_tokens ?? 0,
    output: u?.output_tokens ?? 0,
  }
}

export function parseSpecOutput(response: BetaMessage): string | null {
  if (response.stop_reason !== "end_turn") return null
  const text = response.content
    .filter((b): b is Anthropic.Beta.Messages.BetaTextBlock => b.type === "text")
    .map((b) => b.text)
    .join("")
  try {
    const parsed = JSON.parse(text) as unknown
    if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) return null
    const spec = (parsed as Record<string, unknown>).spec
    return typeof spec === "string" && spec.trim() ? spec : null
  } catch {
    return null
  }
}

const EXPECT_LINE = /^\s*\/\/\s*EXPECT:\s*(.*?)\s*\|\s*SOURCE:\s*(.*?)\s*$/

export function parseExpectations(spec: string): Expectation[] {
  const out: Expectation[] = []
  spec.split("\n").forEach((line, i) => {
    const m = EXPECT_LINE.exec(line)
    if (!m) return
    const kind = classifyExpectSource(m[2])?.kind ?? "observed"
    out.push({ line: i + 2, text: m[1], source: m[2], sourceKind: kind })
  })
  return out
}

export type DraftOutcome =
  | { ok: true; spec: string; check: DraftCheckResult; attempts: number; usage: TokenUsage; costUsd: number }
  | { ok: false; reason: string; check: DraftCheckResult | null; attempts: number; usage: TokenUsage; costUsd: number }

export async function draftGap(opts: {
  gap: Gap
  slug: string
  sources: IntentSource[]
  client: DraftClient
  spentUsd: number
  sourceExists?: SourceCheck
  log?: (line: string) => void
}): Promise<DraftOutcome> {
  let usage = NO_USAGE
  let costUsd = 0
  let attempts = 0
  let previous: { spec: string; check: DraftCheckResult } | undefined
  while (attempts < 1 + MAX_REPAIR_ROUNDS) {
    if (!canSpend(opts.spentUsd + costUsd)) {
      return { ok: false, reason: "night cost stop", check: previous?.check ?? null, attempts, usage, costUsd }
    }
    attempts++
    let response: BetaMessage
    try {
      response = await opts.client.beta.messages.create(
        buildDraftRequest({ gap: opts.gap, slug: opts.slug, sources: opts.sources, previous }),
        { timeout: ATTEMPT_TIMEOUT_MS, maxRetries: 0 },
      )
    } catch (e) {
      costUsd += ATTEMPT_ESTIMATE_USD
      const reason = `model call failed: ${String((e as { message?: unknown } | null)?.message ?? e)}`
      return { ok: false, reason, check: previous?.check ?? null, attempts, usage, costUsd }
    }
    if (!response.usage) {
      costUsd += ATTEMPT_ESTIMATE_USD
    } else {
      const u = usageOf(response)
      usage = addUsage(usage, u)
      costUsd += costOf(response.model ?? MODEL, u)
    }
    const spec = parseSpecOutput(response)
    if (spec === null) {
      opts.log?.(`${opts.slug}: attempt ${attempts} gave no spec (stop_reason ${response.stop_reason})`)
      return { ok: false, reason: `no spec (stop_reason ${response.stop_reason})`, check: null, attempts, usage, costUsd }
    }
    const check = checkDraftSpec(spec, {
      path: draftSpecPath(opts.slug),
      gapId: opts.slug,
      sourceExists: opts.sourceExists,
    })
    if (check.ok) return { ok: true, spec, check, attempts, usage, costUsd }
    opts.log?.(`${opts.slug}: attempt ${attempts} has ${check.violations.length} convention violation(s)`)
    previous = { spec, check }
  }
  return { ok: false, reason: "conventions still violated after repair rounds", check: previous?.check ?? null, attempts, usage, costUsd }
}
