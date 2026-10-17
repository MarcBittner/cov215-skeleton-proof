import fs from "node:fs"
import path from "node:path"

import { planGate } from "./gate-transport.js"
import type { Gap } from "../../map/reports/gaps.js"
import { applicableBreaks, draftGap, draftable, gapSlug, parseExpectations, type DraftClient } from "./draft-call.js"
import type { SourceCheck } from "../../gate/checker.js"
import type { GithubClient } from "./github.js"
import {
  CLEAN_GATE_RUNS,
  MAX_LIVE_PREVIEWS,
  MAX_OPEN_DRAFT_PRS,
  MAX_SCREENS_PER_NIGHT,
  MAX_TESTS_PER_NIGHT,
  batchEstimate,
  canSpend,
} from "./limits.js"
import { applyOutcome, decideOutcome, prLedger, type Applied } from "./outcomes.js"
import { specSha256 } from "../../gate/gate-run.js"
import type { DraftsState, GateRequest, GateResultInput, IntentSource, PendingDraft } from "./types.js"

export interface NightInput {
  night: string
  now: string
  stagingSha: string
  gaps: Gap[]
  sources: Record<string, IntentSource[]>
  state: DraftsState
  gateResults: GateResultInput[]
}

export interface NightDeps {
  client: DraftClient | null
  github: GithubClient
  dry: boolean
  outDir: string
  sourceExists?: SourceCheck
  log?: (line: string) => void
}

export interface Skipped {
  gapId: string
  reason: string
}

export interface NightReport {
  dry: boolean
  applied: Applied[]
  drafted: { gapId: string; slug: string; sha256: string; attempts: number; costUsd: number }[]
  failed: { gapId: string; reason: string; attempts: number; costUsd: number }[]
  skipped: Skipped[]
  gateRequests: GateRequest[]
  estimate: string | null
  spentUsd: number
  state: DraftsState
}

export const DRY_DRAFTS_DIR = "dry-drafts"

function writeDryDraft(outDir: string, slug: string, spec: string, requests: GateRequest[]) {
  const dir = path.join(outDir, DRY_DRAFTS_DIR)
  fs.mkdirSync(dir, { recursive: true })
  fs.writeFileSync(path.join(dir, `${slug}.spec.ts`), spec)
  fs.writeFileSync(path.join(dir, `${slug}.gates.json`), JSON.stringify(requests.map((r) => r.gate), null, 2) + "\n")
}

export function gateRequestsFor(draft: { gapId: string; slug: string; spec: string; breaks: PendingDraft["applicableBreaks"] }): GateRequest[] {
  const runs = [
    ...Array.from({ length: CLEAN_GATE_RUNS }, () => null),
    ...draft.breaks,
  ]
  return runs.map((injectedBreak, i) => {
    const plan = planGate({ gapId: draft.slug, attempt: i + 1, spec: draft.spec, break: injectedBreak })
    return { gapId: draft.gapId, slug: draft.slug, attempt: i + 1, ref: plan.gate.ref, path: plan.path, sha256: plan.gate.sha256, injectedBreak: plan.gate.break, gate: plan.gate }
  })
}

export function chooseGaps(opts: {
  gaps: Gap[]
  sources: Record<string, IntentSource[]>
  excluded: Map<string, string>
  openSlots: number
  previewSlots: number
}): { chosen: Gap[]; skipped: Skipped[] } {
  const chosen: Gap[] = []
  const skipped: Skipped[] = []
  const screens = new Set<string>()
  let previews = opts.previewSlots
  for (const gap of opts.gaps) {
    const skip = (reason: string) => skipped.push({ gapId: gap.id, reason })
    const excluded = opts.excluded.get(gap.id)
    if (excluded) {
      skip(excluded)
      continue
    }
    const notDraftable = draftable(gap)
    if (notDraftable) {
      skip(notDraftable)
      continue
    }
    if (!(opts.sources[gap.id] ?? []).length) {
      skip("no intent source")
      continue
    }
    if (chosen.length >= MAX_TESTS_PER_NIGHT) {
      skip(`${MAX_TESTS_PER_NIGHT} tests a night`)
      continue
    }
    if (chosen.length >= opts.openSlots) {
      skip(`${MAX_OPEN_DRAFT_PRS} open draft PRs`)
      continue
    }
    if (!screens.has(gap.route) && screens.size >= MAX_SCREENS_PER_NIGHT) {
      skip(`${MAX_SCREENS_PER_NIGHT} screens a night`)
      continue
    }
    const needed = CLEAN_GATE_RUNS + applicableBreaks(gap).length
    if (needed > previews) {
      skip(`${MAX_LIVE_PREVIEWS} live tooling previews`)
      continue
    }
    previews -= needed
    screens.add(gap.route)
    chosen.push(gap)
  }
  return { chosen, skipped }
}

export async function runNight(input: NightInput, deps: NightDeps): Promise<NightReport> {
  const log = deps.log ?? ((line: string) => console.log(line))
  const now = new Date(input.now)
  const prs = await deps.github.listDraftPrs()
  const ledger = prLedger(prs)

  const applied: Applied[] = []
  const pending: PendingDraft[] = []
  const dryOffered = new Set(input.state.dryOffered)
  let open = ledger.open
  for (const draft of input.state.pending) {
    if (ledger.rejected.has(draft.gapId) || ledger.taken.has(draft.gapId)) continue
    const outcome = decideOutcome(draft, input.gateResults, now)
    const result = await applyOutcome({ draft, outcome, dry: deps.dry, openPrs: open, outDir: deps.outDir, github: deps.github })
    applied.push(result)
    if (result.action === "opened") open++
    else if (result.action === "dry") dryOffered.add(draft.gapId)
    else if (result.action === "waiting") pending.push(draft)
  }

  let spentUsd = input.state.spend?.night === input.night ? input.state.spend.costUsd : 0
  const excluded = new Map<string, string>()
  for (const id of ledger.rejected) excluded.set(id, "rejected draft")
  for (const id of ledger.taken) if (!excluded.has(id)) excluded.set(id, "draft PR exists")
  for (const d of pending) excluded.set(d.gapId, "draft in gate")
  for (const id of dryOffered) if (!excluded.has(id)) excluded.set(id, "offered in dry mode")

  const live = await deps.github.countLiveToolingBranches()
  const { chosen, skipped } = chooseGaps({
    gaps: input.gaps,
    sources: input.sources,
    excluded,
    openSlots: Math.max(0, MAX_OPEN_DRAFT_PRS - open),
    previewSlots: Math.max(0, MAX_LIVE_PREVIEWS - live),
  })

  const drafted: NightReport["drafted"] = []
  const failed: NightReport["failed"] = []
  const gateRequests: GateRequest[] = []
  let estimate: string | null = null
  if (chosen.length && !deps.client) {
    for (const gap of chosen) skipped.push({ gapId: gap.id, reason: "no Anthropic key" })
  } else if (chosen.length && deps.client) {
    estimate = batchEstimate(chosen.length).line
    log(estimate)
    for (const gap of chosen) {
      if (!canSpend(spentUsd)) {
        skipped.push({ gapId: gap.id, reason: "night cost stop" })
        continue
      }
      const slug = gapSlug(gap.id)
      const out = await draftGap({
        gap,
        slug,
        sources: input.sources[gap.id] ?? [],
        client: deps.client,
        spentUsd,
        sourceExists: deps.sourceExists,
        log,
      })
      spentUsd += out.costUsd
      if (!out.ok) {
        failed.push({ gapId: gap.id, reason: out.reason, attempts: out.attempts, costUsd: out.costUsd })
        continue
      }
      const breaks = applicableBreaks(gap)
      const requests = gateRequestsFor({ gapId: gap.id, slug, spec: out.spec, breaks })
      if (deps.dry) {
        writeDryDraft(deps.outDir, slug, out.spec, requests)
        dryOffered.add(gap.id)
        drafted.push({ gapId: gap.id, slug, sha256: specSha256(out.spec), attempts: out.attempts, costUsd: out.costUsd })
        continue
      }
      let specCommit: string
      try {
        specCommit = await deps.github.createCommitWithFiles({ baseSha: input.stagingSha, files: { [requests[0].path]: out.spec }, message: `Draft spec for ${slug}` })
        for (const r of requests) await deps.github.createMarkerBranch({ branch: r.ref, targetSha: specCommit })
      } catch (e) {
        failed.push({ gapId: gap.id, reason: `gate branch: ${(e as Error).message}`, attempts: out.attempts, costUsd: out.costUsd })
        continue
      }
      const sha256 = specSha256(out.spec)
      pending.push({
        gapId: gap.id,
        slug,
        gap,
        spec: out.spec,
        sha256,
        path: requests[0].path,
        expectations: parseExpectations(out.spec),
        applicableBreaks: breaks,
        gates: requests,
        attempts: out.attempts,
        usage: out.usage,
        costUsd: out.costUsd,
        baseSha: input.stagingSha,
        specCommit,
        draftedAt: input.now,
      })
      gateRequests.push(...requests)
      drafted.push({ gapId: gap.id, slug, sha256, attempts: out.attempts, costUsd: out.costUsd })
    }
  }
  log(`drafts: spent $${spentUsd.toFixed(2)} tonight; ${drafted.length} drafted, ${failed.length} failed, ${applied.length} gate outcome(s)`)

  return {
    dry: deps.dry,
    applied,
    drafted,
    failed,
    skipped,
    gateRequests,
    estimate,
    spentUsd,
    state: { version: 1, pending, dryOffered: [...dryOffered].sort(), spend: { night: input.night, costUsd: spentUsd } },
  }
}
