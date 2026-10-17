import { createHash } from "node:crypto"
import { existsSync, readFileSync } from "node:fs"
import type { GitHub } from "../../lib/github.js"
import { ACCEPT_LABEL, acceptGroup, commentRowsT3, evaluateAccept, lastLabelEvent, nextOutcome, reportedDiffHash } from "./accept.mjs"

export type Change = { id: string; digest: string; text: string }
export type PriorOutcome = { head: string; reportedDiffHash: string; reportedAt: string }
export type AcceptOutcome = PriorOutcome & { pr: number }

type Attachment = { name?: string; contentType?: string; body?: string; path?: string }
type Result = { retry?: number; attachments?: Attachment[] }
type Spec = { tests?: { results?: Result[] }[] }
type Suite = { specs?: Spec[]; suites?: Suite[] }

const sha256 = (text: string) => createHash("sha256").update(text).digest("hex")

function attachmentJson(results: Result[] | undefined, name: string): unknown {
  const last = [...(results ?? [])].sort((a, b) => (a.retry ?? 0) - (b.retry ?? 0)).pop()
  const a = last?.attachments?.find((x) => x.name === name)
  if (!a) return null
  try {
    if (a.body) return JSON.parse(Buffer.from(a.body, "base64").toString("utf8"))
    if (a.path && existsSync(a.path)) return JSON.parse(readFileSync(a.path, "utf8"))
  } catch {
    return null
  }
  return null
}

type ScreenResult = { id?: unknown; cell?: unknown; parts?: { name?: unknown; status?: unknown; diff?: unknown }[] }
type BehaviourResult = { outcome?: { id?: unknown; comparison?: { status?: unknown; differences?: { part?: unknown }[] } | null } }

export function reportedChanges(reports: readonly unknown[]): Change[] {
  const out = new Map<string, Change>()
  const visit = (suite: Suite) => {
    for (const spec of suite.specs ?? []) {
      for (const t of spec.tests ?? []) {
        const screen = attachmentJson(t.results, "screen-check.json") as ScreenResult | null
        const part = screen?.parts?.find((p) => p.name === "baseline")
        if (screen && typeof screen.id === "string" && part?.status === "failed" && Array.isArray(part.diff) && part.diff.length > 0) {
          const diff = part.diff.map(String)
          out.set(screen.id, { id: screen.id, digest: sha256(diff.join("\n")), text: `Screen ${String(screen.cell)} changed: ${diff.length} ARIA line(s) differ from the baseline.` })
        }
        const behaviour = attachmentJson(t.results, "behaviour.json") as BehaviourResult | null
        const o = behaviour?.outcome
        if (o && typeof o.id === "string" && o.comparison?.status === "changed") {
          const differences = o.comparison.differences ?? []
          out.set(o.id, {
            id: o.id,
            digest: sha256(JSON.stringify(differences)),
            text: `Behaviour of ${o.id.slice("gen:snapshot:".length)} changed (${[...new Set(differences.map((d) => String(d.part)))].join(", ") || "differences"}).`,
          })
        }
      }
    }
    for (const child of suite.suites ?? []) visit(child)
  }
  for (const r of reports) for (const s of (r as Suite & { suites?: Suite[] })?.suites ?? []) visit(s)
  return [...out.values()].sort((a, b) => (a.id < b.id ? -1 : a.id > b.id ? 1 : 0))
}

export function priorOutcomeFor(outcomes: readonly unknown[], pr: number): PriorOutcome | null {
  for (const doc of outcomes) {
    const a = (doc as { accept?: Partial<AcceptOutcome> | null } | null)?.accept
    if (a && a.pr === pr && typeof a.head === "string" && typeof a.reportedDiffHash === "string" && typeof a.reportedAt === "string") {
      return { head: a.head, reportedDiffHash: a.reportedDiffHash, reportedAt: a.reportedAt }
    }
  }
  return null
}

async function paged<T>(gh: GitHub, path: string): Promise<T[]> {
  const out: T[] = []
  for (let page = 1; page <= 20; page += 1) {
    const items = (await gh.get<T[]>(`${path}${path.includes("?") ? "&" : "?"}per_page=100&page=${page}`)) ?? []
    out.push(...items)
    if (items.length < 100) break
  }
  return out
}

export type AcceptArgs = {
  gh: GitHub
  pr: number
  headSha: string
  setupRunId: string
  reports: readonly unknown[]
  priorOutcome: (pr: number) => Promise<PriorOutcome | null>
  rowFiles: Record<string, unknown>
  now?: () => number
  log?: (line: string) => void
}

export async function acceptRebind(args: AcceptArgs): Promise<{ diffHash: string; accept: AcceptOutcome }> {
  const { gh, pr, headSha } = args
  const changes = reportedChanges(args.reports)
  const diffHash = reportedDiffHash(changes)
  const timeline = await paged<unknown>(gh, `/issues/${pr}/timeline`)
  const pull = await gh.get<{ user?: { login?: string } }>(`/pulls/${pr}`)
  const prAuthor = pull?.user?.login
  if (!prAuthor) throw new Error(`PR #${pr} has no author`)
  const label = lastLabelEvent(timeline)
  const labelActorPermission = label?.actor ? ((await gh.get(`/collaborators/${encodeURIComponent(label.actor)}/permission`)) ?? { permission: "none" }) : null
  const priorOutcome = await args.priorOutcome(pr)
  const evaluation = evaluateAccept({ timeline, prAuthor, labelActorPermission, priorOutcome, headSha, diffHash })
  if (evaluation.state === "refused" && evaluation.removeLabel) {
    try {
      await gh.send("DELETE", `/issues/${pr}/labels/${encodeURIComponent(ACCEPT_LABEL)}`)
      args.log?.(`${ACCEPT_LABEL} removed from PR #${pr}: ${evaluation.reason}`)
    } catch (e) {
      if (!(e instanceof Error && /: 404 /.test(e.message))) throw e
    }
  }
  const group = acceptGroup({ evaluation, changes })
  const prior = args.rowFiles.t3 as { groups?: (typeof group)[] } | Error | undefined
  const groups = prior && !(prior instanceof Error) && Array.isArray(prior.groups) ? [...prior.groups.filter((g) => g.id !== group.id), group] : [group]
  args.rowFiles.t3 = commentRowsT3({ setupRunId: args.setupRunId, groups })
  const next = nextOutcome({ priorOutcome, headSha, diffHash, now: (args.now ?? Date.now)() })
  return { diffHash, accept: { pr, ...next } }
}
