import {
  NIGHTLY_BRANCH_PREFIX,
  type MarkerGit,
  assertNightlyBranch,
  createMarkerCommit,
  isMarkerHead,
  nightlyBranchName,
  nightStartMs,
  nightlyDate,
  staleNightlyBranches,
} from "./branch.js"
import { READY_BOUND_MS, type DeploymentsClient, waitForNightlyPreview } from "./ready.js"
import { type NightEntry, type StoreIndex, isPublished } from "./store-index.js"

export interface Branch {
  name: string
  sha: string
}

export interface NightlyGitClient extends MarkerGit {
  listBranches(prefix: string): Promise<Branch[]>
  getBranch(name: string): Promise<Branch | null>
  createBranch(name: string, sha: string): Promise<void>
  deleteBranch(name: string): Promise<void>
}

export interface IndexReader {
  readIndex(): Promise<StoreIndex>
}

export interface IndexStore extends IndexReader {
  writeIndex(index: StoreIndex, message: string): Promise<void>
}

export interface SetupNightDeps {
  git: NightlyGitClient
  deployments: DeploymentsClient
  store: IndexReader
  now?: () => number
  sleep?: (ms: number) => Promise<void>
  log?: (line: string) => void
}

export interface SetupNightInput {
  stagingSha: string
  schemaVersion: string
  readyBoundMs?: number
  pollMs?: number
}

export interface StaleBranchCleanup {
  deleted: string[]
  remaining: string[]
}

export type SetupNightResult =
  | { outcome: "skipped"; reason: string; stale: StaleBranchCleanup }
  | { outcome: "failed"; branch: string; entry: NightEntry; stale: StaleBranchCleanup }
  | { outcome: "ready"; branch: string; toolingSha: string; deploymentId: number; url: string; waitedMs: number; stale: StaleBranchCleanup }

export async function deleteStaleNightlyBranches(
  git: NightlyGitClient,
  today: string,
  log: (line: string) => void,
): Promise<StaleBranchCleanup> {
  const names = (await git.listBranches(NIGHTLY_BRANCH_PREFIX)).map((b) => b.name)
  const deleted: string[] = []
  const remaining: string[] = []
  for (const name of staleNightlyBranches(names, today)) {
    assertNightlyBranch(name)
    try {
      await git.deleteBranch(name)
    } catch (err) {
      log(`delete ${name} failed: ${err instanceof Error ? err.message : String(err)}`)
    }
    if ((await git.getBranch(name)) === null) {
      deleted.push(name)
      log(`deleted ${name} (read back: gone)`)
    } else {
      remaining.push(name)
      log(`::error::${name} still exists after delete`)
    }
  }
  return { deleted, remaining }
}

export async function setupNight(deps: SetupNightDeps, input: SetupNightInput): Promise<SetupNightResult> {
  const now = deps.now ?? Date.now
  const log = deps.log ?? (() => {})
  const startedAt = new Date(now())
  const today = nightlyDate(startedAt)
  const branch = nightlyBranchName(startedAt)

  const stale = await deleteStaleNightlyBranches(deps.git, today, log)

  const index = await deps.store.readIndex()
  if (isPublished(index, input.stagingSha)) {
    const reason = `staging ${input.stagingSha.slice(0, 12)} already has a published map`
    log(`skip: ${reason}`)
    return { outcome: "skipped", reason, stale }
  }

  const fail = async (reason: string): Promise<SetupNightResult> => {
    const entry: NightEntry = {
      stagingSha: input.stagingSha,
      builtAt: startedAt.toISOString(),
      schemaVersion: input.schemaVersion,
      status: "failed-job",
      reason: `${branch}: ${reason}`,
    }
    log(`::error::night failed: ${entry.reason} (recorded in this setup run; the next publish folds it into the index)`)
    return { outcome: "failed", branch, entry, stale }
  }

  const existing = await deps.git.getBranch(branch)
  if (existing && !(await isMarkerHead(deps.git, existing.sha, input.stagingSha))) {
    return fail(`branch already exists at ${existing.sha.slice(0, 12)}, not a marker commit on ${input.stagingSha.slice(0, 12)}; a moved branch is not freshly seeded`)
  }
  let createdAfterMs: number
  let toolingSha: string
  if (!existing) {
    createdAfterMs = now()
    toolingSha = (await createMarkerCommit(deps.git, branch, input.stagingSha)).sha
    await deps.git.createBranch(branch, toolingSha)
    const created = await deps.git.getBranch(branch)
    if (!created || created.sha !== toolingSha) return fail("branch not readable at its marker commit after create")
    log(`created ${branch} at ${toolingSha} on ${input.stagingSha}`)
  } else {
    createdAfterMs = nightStartMs(today)
    toolingSha = existing.sha
    log(`${branch} already at ${toolingSha} on ${input.stagingSha}; reusing its preview`)
  }

  const ready = await waitForNightlyPreview(deps.deployments, {
    branch,
    sha: toolingSha,
    createdAfterMs,
    boundMs: input.readyBoundMs ?? READY_BOUND_MS,
    pollMs: input.pollMs,
    now,
    sleep: deps.sleep,
  })
  if (!ready.ready) return fail(ready.reason)
  log(`${branch} READY after ${Math.round(ready.waitedMs / 1000)} s: ${ready.url}`)
  return { outcome: "ready", branch, toolingSha, deploymentId: ready.deploymentId, url: ready.url, waitedMs: ready.waitedMs, stale }
}
