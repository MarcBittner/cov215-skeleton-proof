import fs from "node:fs"
import path from "node:path"

import Anthropic from "@anthropic-ai/sdk"

import { FILES } from "../../contract/constants.js"
import { sourceStates, type SourceCheck } from "../../gate/checker.js"
import type { Gap } from "../../map/reports/gaps.js"
import { gitHubClient } from "../../lib/github.js"
import { commentRows, errorCommentRows } from "./comment-rows.js"
import { collectGateResults, gateRunReader } from "./gate-results.js"
import type { DraftClient } from "./draft-call.js"
import { restGithubClient, type GithubClient } from "./github.js"
import { MAX_SOURCE_BYTES, MAX_SOURCE_REF_CHARS, MAX_SOURCES_PER_GAP } from "./limits.js"
import { runNight, type NightReport } from "./orchestrate.js"
import {
  EMPTY_STATE,
  type DraftsState,
  type GateResultInput,
  type IntentSource,
  type PendingDraft,
  type SetupStep,
  type SetupStepContext,
  type SetupStepResult,
} from "./types.js"

export const INPUT_FILE = "drafts-input.json"
export const INPUT_SKIPPED_FILE = "drafts-input-skipped.json"
export const STATE_FILE = "drafts-state.json"
export const REQUESTS_FILE = "gate-requests.json"
export const REPORT_FILE = "drafts-report.json"
export const COMMENT_ROWS_FILE = FILES.commentRows("t5")
export const LIVE_ENV = "E2E_DRAFTS_LIVE"
const SOURCE_KINDS = new Set(["code", "doc", "issue"])

export interface DraftsInput {
  night: string
  stagingSha: string
  gaps: Gap[]
  sources?: Record<string, IntentSource[]>
  state?: DraftsState
}

export function parseDraftsInput(raw: unknown): DraftsInput {
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) throw new Error("drafts input is not an object")
  const r = raw as Record<string, unknown>
  if (typeof r.night !== "string" || !r.night) throw new Error("drafts input needs night")
  if (typeof r.stagingSha !== "string" || !/^[0-9a-f]{40}$/.test(r.stagingSha)) throw new Error("drafts input needs a 40-hex stagingSha")
  if (!Array.isArray(r.gaps)) throw new Error("drafts input needs gaps")
  if ("gateResults" in r) throw new Error("drafts input must not carry gate results; they are read from trusted gate runs")
  if (r.state !== undefined && (typeof r.state !== "object" || (r.state as DraftsState).version !== 1)) {
    throw new Error("drafts state has an unknown version")
  }
  return { ...(r as unknown as DraftsInput), sources: r.sources === undefined ? undefined : parseSources(r.sources) }
}

export function parseSources(raw: unknown): Record<string, IntentSource[]> {
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) throw new Error("drafts input sources must be an object")
  const out: Record<string, IntentSource[]> = {}
  for (const [gapId, list] of Object.entries(raw as Record<string, unknown>)) {
    if (!Array.isArray(list)) throw new Error(`sources for ${gapId} must be an array`)
    out[gapId] = list.slice(0, MAX_SOURCES_PER_GAP).map((s, i) => {
      const src = s as Record<string, unknown> | null
      if (!src || typeof src.kind !== "string" || !SOURCE_KINDS.has(src.kind) || typeof src.ref !== "string" || typeof src.text !== "string") {
        throw new Error(`source ${i} for ${gapId} needs kind (code, doc or issue), ref and text`)
      }
      return { kind: src.kind as IntentSource["kind"], ref: src.ref.slice(0, MAX_SOURCE_REF_CHARS), text: clipText(src.text) }
    })
  }
  return out
}

function clipText(text: string): string {
  const buf = Buffer.from(text, "utf8")
  return buf.length <= MAX_SOURCE_BYTES ? text : buf.subarray(0, MAX_SOURCE_BYTES).toString("utf8").replace(/\uFFFD$/, "")
}

function routeOf(dir: string): string {
  const parts = dir.split("/").filter((p) => p && !/^\(.*\)$/.test(p) && !p.startsWith("@"))
  return "/" + parts.join("/")
}

export function pageSources(root: string, gaps: Gap[]): Record<string, IntentSource[]> {
  const appDir = path.join(root, "src", "app")
  const pages = new Map<string, string>()
  const walk = (rel: string) => {
    let entries: fs.Dirent[]
    try {
      entries = fs.readdirSync(path.join(appDir, rel), { withFileTypes: true })
    } catch {
      return
    }
    for (const e of entries) {
      const child = rel ? `${rel}/${e.name}` : e.name
      if (e.isDirectory()) walk(child)
      else if (/^page\.(tsx|ts|jsx|js)$/.test(e.name)) pages.set(routeOf(rel), `src/app/${child}`)
    }
  }
  walk("")
  const out: Record<string, IntentSource[]> = {}
  for (const gap of gaps) {
    const file = pages.get(gap.route.replace(/\/$/, "") || "/")
    if (!file) continue
    const text = fs.readFileSync(path.join(root, file), "utf8").slice(0, MAX_SOURCE_BYTES)
    const numbered = text
      .split("\n")
      .map((l, i) => `${i + 1}: ${l}`)
      .join("\n")
    out[gap.id] = [{ kind: "code", ref: file, text: clipText(numbered) }]
  }
  return out
}

export function sourceExistsIn(root: string): SourceCheck {
  return (file, line, needles, endLine = line) => {
    const abs = path.resolve(root, file)
    if (!abs.startsWith(path.resolve(root) + path.sep)) return false
    try {
      return sourceStates(fs.readFileSync(abs, "utf8"), line, endLine, needles)
    } catch {
      return false
    }
  }
}

export interface StepDeps {
  env: Record<string, string | undefined>
  root: string
  client?: DraftClient | null
  github?: GithubClient | null
  gateResults?: ((pending: PendingDraft[]) => Promise<GateResultInput[]>) | null
  log?: (line: string) => void
}

export async function runDraftsStep(ctx: SetupStepContext, deps: StepDeps): Promise<SetupStepResult> {
  const skipped = (reason: string): SetupStepResult => ({ task: "t5", status: "skipped", output: { reason } })
  if (ctx.kind !== "nightly") return skipped(`drafts run only after a nightly, not ${ctx.kind}`)
  if (ctx.mode === "fixture") return skipped("fixture mode drafts nothing")
  const inputPath = path.join(ctx.workDir, INPUT_FILE)
  if (!fs.existsSync(inputPath)) {
    const why = path.join(ctx.workDir, INPUT_SKIPPED_FILE)
    const reason = fs.existsSync(why) ? (JSON.parse(fs.readFileSync(why, "utf8")) as { reason?: unknown }).reason : undefined
    return skipped(typeof reason === "string" ? `drafts input not fetched: ${reason}` : `${INPUT_FILE} not found`)
  }
  try {
    return await draftNight(ctx, deps, inputPath, skipped)
  } catch (e) {
    let rows
    try {
      rows = errorCommentRows(ctx.setupRunId, e instanceof Error ? e.message : String(e))
    } catch {
      throw e
    }
    fs.writeFileSync(path.join(ctx.workDir, COMMENT_ROWS_FILE), JSON.stringify(rows, null, 2) + "\n")
    throw e
  }
}

async function draftNight(
  ctx: SetupStepContext,
  deps: StepDeps,
  inputPath: string,
  skipped: (reason: string) => SetupStepResult,
): Promise<SetupStepResult> {
  const input = parseDraftsInput(JSON.parse(fs.readFileSync(inputPath, "utf8")))

  const github =
    deps.github !== undefined
      ? deps.github
      : deps.env.GITHUB_TOKEN && deps.env.GITHUB_REPOSITORY
        ? restGithubClient({ token: deps.env.GITHUB_TOKEN, repository: deps.env.GITHUB_REPOSITORY, apiUrl: deps.env.GITHUB_API_URL })
        : null
  if (!github) return skipped("GITHUB_TOKEN and GITHUB_REPOSITORY are required")
  const client =
    deps.client !== undefined
      ? deps.client
      : deps.env.ANTHROPIC_API_KEY
        ? new Anthropic({ apiKey: deps.env.ANTHROPIC_API_KEY, maxRetries: 0 })
        : null

  const state = input.state ?? EMPTY_STATE
  const fetchResults =
    deps.gateResults !== undefined
      ? deps.gateResults
      : deps.env.GITHUB_TOKEN && deps.env.GITHUB_REPOSITORY
        ? (pending: PendingDraft[]) => {
            const gh = gitHubClient({ repo: deps.env.GITHUB_REPOSITORY!, token: deps.env.GITHUB_TOKEN!, apiUrl: deps.env.GITHUB_API_URL })
            return collectGateResults(pending, gateRunReader(gh), deps.log)
          }
        : null
  const gateResults = state.pending.length && fetchResults ? await fetchResults(state.pending) : []
  const report: NightReport = await runNight(
    {
      night: input.night,
      now: new Date().toISOString(),
      stagingSha: input.stagingSha,
      gaps: input.gaps,
      sources: { ...pageSources(deps.root, input.gaps), ...input.sources },
      state,
      gateResults,
    },
    {
      client,
      github,
      dry: deps.env[LIVE_ENV] !== "1",
      outDir: ctx.workDir,
      sourceExists: sourceExistsIn(deps.root),
      log: deps.log,
    },
  )
  fs.writeFileSync(path.join(ctx.workDir, STATE_FILE), JSON.stringify(report.state, null, 2) + "\n")
  fs.writeFileSync(path.join(ctx.workDir, REQUESTS_FILE), JSON.stringify(report.gateRequests, null, 2) + "\n")
  const summary = { ...report, state: undefined }
  fs.writeFileSync(path.join(ctx.workDir, REPORT_FILE), JSON.stringify(summary, null, 2) + "\n")
  const rows = commentRows(report, ctx.setupRunId)
  fs.writeFileSync(path.join(ctx.workDir, COMMENT_ROWS_FILE), JSON.stringify(rows, null, 2) + "\n")
  return { task: "t5", status: "ok", output: summary }
}

export const runSetupStep: SetupStep = (ctx) => runDraftsStep(ctx, { env: process.env, root: process.cwd() })
