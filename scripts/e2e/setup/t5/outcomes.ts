import fs from "node:fs"
import path from "node:path"

import { breakAnalysis } from "../../gate/break-targets.js"
import { gateVerdict, type GateCheckRecord, type GateRunResult, type GateVerdict } from "../../gate/gate-run.js"
import { escapeInline, plainTitle } from "./escape.js"
import { DRAFT_LABEL, POSSIBLE_BUG_LABEL, REJECTED_LABEL, type GithubClient } from "./github.js"
import { MAX_OPEN_DRAFT_PRS } from "./limits.js"
import type { DraftPr, GateResultInput, PendingDraft } from "./types.js"

export const SETUP_WORKFLOW = "e2e-setup.yml"
export const BASE_BRANCH = "staging"
export const DRAFT_BRANCH_PREFIX = "e2e/draft/"
export const GATE_EXPIRY_MS = 3 * 24 * 60 * 60 * 1000

const GAP_ID_LINE = /^gap-id:(\S+)\s*$/gm

export function gapIdsFromBody(body: string): string[] {
  return [...body.matchAll(GAP_ID_LINE)].map((m) => m[1])
}

export interface PrLedger {
  open: number
  rejected: Set<string>
  taken: Set<string>
}

export function prLedger(prs: DraftPr[]): PrLedger {
  const rejected = new Set<string>()
  const taken = new Set<string>()
  let open = 0
  for (const pr of prs) {
    if (pr.state === "open") open++
    const ids = gapIdsFromBody(pr.body)
    const isRejected = (pr.state === "closed" && !pr.merged) || pr.labels.includes(REJECTED_LABEL)
    for (const id of ids) {
      taken.add(id)
      if (isRejected) rejected.add(id)
    }
  }
  return { open, rejected, taken }
}

export type OutcomeAction = "offer" | "possible-bug" | "drop" | "wait"

export interface Outcome {
  action: OutcomeAction
  verdict: GateVerdict | null
  reasons: string[]
  results: GateRunResult[]
}

function checkOf(draft: PendingDraft, results: GateResultInput[]): GateCheckRecord | null {
  const checks = results.map((r) => r.check).filter((c): c is GateCheckRecord => !!c)
  return checks.find((c) => !c.ok || c.sha256 !== draft.sha256) ?? checks[0] ?? null
}

function reachableLines(spec: string): Record<"alter-query-field" | "drop-mutation-frame", number[]> {
  const a = breakAnalysis(spec)
  return { "alter-query-field": a.alterLines, "drop-mutation-frame": a.dropLines }
}

export function decideOutcome(draft: PendingDraft, all: GateResultInput[], now: Date): Outcome {
  const byRef = new Map(draft.gates.map((g) => [g.ref, g]))
  const mine = all.filter((r) => byRef.has(r.ref))
  const results: GateRunResult[] = mine.map((r) => ({
    sha256: r.sha256,
    deployment: r.deployment,
    passed: r.passed,
    injectedBreak: byRef.get(r.ref)!.injectedBreak,
    status: r.status,
    failedLines: r.failedLines,
    breakAnnotation: r.breakAnnotation ?? null,
  }))
  const expired = now.getTime() - Date.parse(draft.draftedAt) > GATE_EXPIRY_MS
  const check = checkOf(draft, mine)
  if (!check) {
    return expired
      ? { action: "drop", verdict: null, reasons: ["gate results did not arrive in time"], results }
      : { action: "wait", verdict: null, reasons: ["no gate check yet"], results }
  }
  const verdict = gateVerdict({
    sha256: draft.sha256,
    check,
    applicableBreaks: draft.applicableBreaks,
    expectLines: draft.expectations.map((e) => e.line),
    breakLines: reachableLines(draft.spec),
    results,
  })
  if (verdict.verdict === "offer") return { action: "offer", verdict, reasons: [], results }
  if (verdict.verdict === "incomplete") {
    return expired
      ? { action: "drop", verdict, reasons: ["gate incomplete in time", ...verdict.reasons], results }
      : { action: "wait", verdict, reasons: verdict.reasons, results }
  }
  if (verdict.verdict === "failing") {
    const exp = draft.expectations.find((e) => e.line === verdict.line)
    if (exp && exp.sourceKind !== "observed") {
      return { action: "possible-bug", verdict, reasons: [`every clean run failed at line ${verdict.line}, an intent-sourced assertion`], results }
    }
  }
  return { action: "drop", verdict, reasons: verdict.reasons, results }
}

export function prTitle(draft: PendingDraft): string {
  const what = draft.gap.kind === "control" ? `${draft.gap.controlKey} on ${draft.gap.route}` : draft.gap.route
  return plainTitle(`Drafted test: ${what} as ${draft.gap.role} (COV-215)`)
}

export function prBody(draft: PendingDraft, outcome: Outcome): string {
  const clean = outcome.results.filter((r) => r.injectedBreak === null)
  const lines = [
    "Part of COV-215",
    "",
    `gap-id:${draft.gapId}`,
    "",
    `A drafted functional test for ${escapeInline(draft.gap.kind === "control" ? `the ${draft.gap.controlKey} action on ${draft.gap.route}` : `the ${draft.gap.route} screen`)} as ${escapeInline(draft.gap.role)}. Approve by merging, correct by pushing to this branch, or reject by closing it (the gap is then not drafted again).`,
    "",
    "## What it expects",
    "",
    ...draft.expectations.map((e) => `- Line ${e.line}: ${escapeInline(e.text)} (source: ${escapeInline(e.source)}${e.sourceKind === "observed" && !/^observed\b/i.test(e.source) ? ", observed behaviour" : ""})`),
    "",
    "## Gate evidence",
    "",
    `- Spec: \`${draft.path}\`, sha256 \`${draft.sha256}\``,
    `- Clean runs on new previews: ${clean.filter((r) => r.passed).length} of ${clean.length} passed (${clean.map((r) => escapeInline(r.deployment)).join(", ") || "none"})`,
    ...draft.applicableBreaks.map((b) => {
      const runs = outcome.results.filter((r) => r.injectedBreak === b)
      return `- Under injected break ${b}: ${runs.length === 0 ? "not run" : runs.every((r) => !r.passed) ? "failed, as it should" : "passed"}`
    }),
    `- Drafting: ${draft.attempts} model attempt(s), $${draft.costUsd.toFixed(2)}`,
  ]
  if (outcome.action === "possible-bug") {
    lines.push("", "## Possible bug", "", ...outcome.reasons.map((r) => `- ${escapeInline(r)}`), "", "The app may not do what its source says. Check the assertion before rejecting.")
  }
  return lines.join("\n") + "\n"
}

export type Applied =
  | { gapId: string; action: "opened"; pr: number; labels: string[] }
  | { gapId: string; action: "dry"; bodyFile: string; labels: string[] }
  | { gapId: string; action: "dropped"; reasons: string[] }
  | { gapId: string; action: "waiting"; reasons: string[] }

export async function applyOutcome(opts: {
  draft: PendingDraft
  outcome: Outcome
  dry: boolean
  openPrs: number
  outDir: string
  github: GithubClient | null
}): Promise<Applied> {
  const { draft, outcome } = opts
  if (outcome.action === "drop") return { gapId: draft.gapId, action: "dropped", reasons: outcome.reasons }
  if (outcome.action === "wait") return { gapId: draft.gapId, action: "waiting", reasons: outcome.reasons }
  const labels = outcome.action === "possible-bug" ? [DRAFT_LABEL, POSSIBLE_BUG_LABEL] : [DRAFT_LABEL]
  const body = prBody(draft, outcome)
  if (opts.dry) {
    const bodyFile = path.join(opts.outDir, "pr-bodies", `${draft.slug}.md`)
    fs.mkdirSync(path.dirname(bodyFile), { recursive: true })
    fs.writeFileSync(bodyFile, `# ${prTitle(draft)}\n\nLabels: ${labels.join(", ")}\n\n${body}`)
    fs.writeFileSync(path.join(path.dirname(bodyFile), `${draft.slug}.spec.ts`), draft.spec)
    return { gapId: draft.gapId, action: "dry", bodyFile, labels }
  }
  if (opts.openPrs >= MAX_OPEN_DRAFT_PRS) {
    return { gapId: draft.gapId, action: "waiting", reasons: [`${opts.openPrs} draft PRs already open`] }
  }
  if (!opts.github) throw new Error("live outcomes need a GitHub client")
  const head = `${DRAFT_BRANCH_PREFIX}${draft.slug}`
  await opts.github.createBranchWithFiles({
    branch: head,
    baseSha: draft.baseSha,
    files: { [draft.path]: draft.spec },
    message: prTitle(draft),
  })
  const pr = await opts.github.openPullRequest({ head, base: BASE_BRANCH, title: prTitle(draft), body, labels })
  await opts.github.dispatchWorkflow({
    workflow: SETUP_WORKFLOW,
    ref: BASE_BRANCH,
    inputs: { mode: "live", kind: "pr", pr: String(pr) },
  })
  return { gapId: draft.gapId, action: "opened", pr, labels }
}
