import { NIGHTLY_BRANCH_PREFIX, createMarkerCommit, isMarkerHead, isNightlyBranch, type MarkerGit } from "../../map/nightly/branch.js"
import { TOOLING_KINDS } from "../t1/target.js"

export type ToolingKind = (typeof TOOLING_KINDS)[number]

export const TOOLING_PREFIX = "e2e/"
export const MAX_LIVE_TOOLING_PREVIEWS = 40
export const BRANCH_POLL_MS = 30_000

const ID = /^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$/
const TOOLING = /^e2e\/([a-z]+)\/([A-Za-z0-9][A-Za-z0-9._-]{0,63})$/
const SHA = /^[0-9a-f]{40}$/

export interface BranchRef {
  name: string
  sha: string
}

export interface GitRefs extends MarkerGit {
  listBranches(prefix: string): Promise<BranchRef[]>
  getBranch(name: string): Promise<BranchRef | null>
  createBranch(name: string, sha: string): Promise<void>
  deleteBranch(name: string): Promise<void>
}

export class BranchRefused extends Error {
  constructor(
    readonly branch: string,
    reason: string,
  ) {
    super(`branch refused: "${branch}" ${reason}`)
    this.name = "BranchRefused"
  }
}

export class BranchCapacityError extends Error {
  readonly reason = "capacity" as const
  constructor(message: string) {
    super(`capacity: ${message}`)
    this.name = "BranchCapacityError"
  }
}

export function isToolingKind(kind: string): kind is ToolingKind {
  return (TOOLING_KINDS as readonly string[]).includes(kind)
}

export function toolingBranchName(kind: string, id: string): string {
  if (!isToolingKind(kind)) throw new BranchRefused(`e2e/${kind}/${id}`, `has kind ${kind}, not one of ${TOOLING_KINDS.join(", ")}`)
  if (!ID.test(id)) throw new BranchRefused(`e2e/${kind}/${id}`, "has a bad id")
  return `${TOOLING_PREFIX}${kind}/${id}`
}

export function baseBranchName(mergeBaseSha: string): string {
  if (!SHA.test(mergeBaseSha)) throw new Error(`not a full sha: "${mergeBaseSha}"`)
  return toolingBranchName("base", mergeBaseSha.slice(0, 12))
}

export function parseToolingBranch(name: string): { kind: ToolingKind; id: string } | null {
  const m = TOOLING.exec(name)
  if (!m || !isToolingKind(m[1])) return null
  return { kind: m[1], id: m[2] }
}

export function isRunBranch(name: string): boolean {
  return parseToolingBranch(name) !== null || isNightlyBranch(name)
}

export function assertRunBranch(name: string): void {
  if (isRunBranch(name)) return
  if (name.startsWith(TOOLING_PREFIX) || name.startsWith(NIGHTLY_BRANCH_PREFIX)) {
    throw new BranchRefused(name, `is not e2e/<${TOOLING_KINDS.join("|")}>/<id> or ${NIGHTLY_BRANCH_PREFIX}<YYYYMMDD>`)
  }
  throw new BranchRefused(name, `does not start with ${TOOLING_PREFIX} or ${NIGHTLY_BRANCH_PREFIX}`)
}

export async function liveRunBranches(git: GitRefs): Promise<BranchRef[]> {
  const all = [...(await git.listBranches(TOOLING_PREFIX)), ...(await git.listBranches(NIGHTLY_BRANCH_PREFIX))]
  return all.filter((b) => isRunBranch(b.name))
}

export interface CreateBranchOptions {
  cap?: number
  deadline: number
  now?: () => number
  sleep?: (ms: number) => Promise<void>
  pollMs?: number
  log?: (line: string) => void
}

export type CreatedBranch = { name: string; sha: string; targetSha: string; created: boolean; createdAtMs: number }

export async function createRunBranch(git: GitRefs, name: string, targetSha: string, opts: CreateBranchOptions): Promise<CreatedBranch> {
  assertRunBranch(name)
  if (!SHA.test(targetSha)) throw new Error(`not a full sha: "${targetSha}"`)
  const now = opts.now ?? Date.now
  const sleep = opts.sleep ?? ((ms: number) => new Promise<void>((r) => setTimeout(r, ms)))
  const log = opts.log ?? (() => {})
  const cap = opts.cap ?? MAX_LIVE_TOOLING_PREVIEWS
  const existing = await git.getBranch(name)
  if (existing) {
    if (!(await isMarkerHead(git, existing.sha, targetSha))) {
      throw new BranchRefused(name, `already exists at ${existing.sha.slice(0, 12)}, not a marker commit on ${targetSha.slice(0, 12)}`)
    }
    return { name, sha: existing.sha, targetSha, created: false, createdAtMs: now() }
  }
  for (;;) {
    const live = (await liveRunBranches(git)).length
    if (live < cap) break
    if (now() >= opts.deadline) {
      throw new BranchCapacityError(`${live} live tooling previews (cap ${cap}); ${name} was not created`)
    }
    log(`${live} live tooling previews (cap ${cap}); waiting to create ${name}`)
    await sleep(Math.max(1, Math.min(opts.pollMs ?? BRANCH_POLL_MS, opts.deadline - now())))
  }
  const createdAtMs = now()
  const marker = await createMarkerCommit(git, name, targetSha)
  await git.createBranch(name, marker.sha)
  const back = await git.getBranch(name)
  if (!back || back.sha !== marker.sha) throw new Error(`${name} is not readable at ${marker.sha.slice(0, 12)} after create`)
  log(`created ${name} at ${marker.sha} on ${targetSha}`)
  return { name, sha: marker.sha, targetSha, created: true, createdAtMs }
}

export async function deleteRunBranch(git: GitRefs, name: string): Promise<{ name: string; deleted: true }> {
  assertRunBranch(name)
  await git.deleteBranch(name)
  if ((await git.getBranch(name)) !== null) throw new Error(`${name} still exists after delete`)
  return { name, deleted: true }
}
