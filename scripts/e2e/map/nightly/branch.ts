export const NIGHTLY_BRANCH_PREFIX = "e2e-nightly-"
export const NIGHTLY_TIME_ZONE = "America/Los_Angeles"

const NIGHTLY_BRANCH = /^e2e-nightly-(\d{4})(\d{2})(\d{2})$/

export function nightlyDate(now: Date): string {
  const parts = new Intl.DateTimeFormat("en-CA", {
    timeZone: NIGHTLY_TIME_ZONE,
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
  }).formatToParts(now)
  const part = (type: string) => parts.find((p) => p.type === type)?.value ?? ""
  return `${part("year")}${part("month")}${part("day")}`
}

export function nightlyBranchName(now: Date): string {
  return `${NIGHTLY_BRANCH_PREFIX}${nightlyDate(now)}`
}

export function parseNightlyBranch(name: string): string | null {
  const m = NIGHTLY_BRANCH.exec(name)
  if (!m) return null
  const [, y, mo, d] = m
  const date = new Date(Date.UTC(Number(y), Number(mo) - 1, Number(d)))
  if (
    date.getUTCFullYear() !== Number(y) ||
    date.getUTCMonth() !== Number(mo) - 1 ||
    date.getUTCDate() !== Number(d)
  ) {
    return null
  }
  return `${y}${mo}${d}`
}

export function isNightlyBranch(name: string): boolean {
  return parseNightlyBranch(name) !== null
}

export function assertNightlyBranch(name: string): void {
  if (!isNightlyBranch(name)) {
    throw new Error(`refused: "${name}" is not an ${NIGHTLY_BRANCH_PREFIX}<YYYYMMDD> branch`)
  }
}

export function staleNightlyBranches(names: readonly string[], today: string): string[] {
  return names
    .filter((name) => {
      const date = parseNightlyBranch(name)
      return date !== null && date < today
    })
    .sort()
}

export function nightStartMs(date: string): number {
  const m = /^(\d{4})(\d{2})(\d{2})$/.exec(date)
  if (!m) throw new Error(`not a YYYYMMDD date: "${date}"`)
  return Date.UTC(Number(m[1]), Number(m[2]) - 1, Number(m[3]), 7)
}

export interface GitCommit {
  sha: string
  tree: string
  parents: string[]
}

export interface MarkerGit {
  getCommit(sha: string): Promise<GitCommit>
  createCommit(message: string, tree: string, parents: string[]): Promise<GitCommit>
}

export function markerMessage(branch: string, targetSha: string): string {
  return `e2e tooling branch ${branch} at ${targetSha.slice(0, 12)}`
}

export function isMarkerOf(head: GitCommit, target: GitCommit): boolean {
  return head.sha !== target.sha && head.parents.length === 1 && head.parents[0] === target.sha && head.tree === target.tree
}

export async function isMarkerHead(git: MarkerGit, headSha: string, targetSha: string): Promise<boolean> {
  if (headSha === targetSha) return false
  return isMarkerOf(await git.getCommit(headSha), await git.getCommit(targetSha))
}

export async function createMarkerCommit(git: MarkerGit, branch: string, targetSha: string): Promise<GitCommit> {
  const target = await git.getCommit(targetSha)
  if (target.sha !== targetSha) throw new Error(`commit ${targetSha.slice(0, 12)} read back as ${target.sha.slice(0, 12)}`)
  const marker = await git.createCommit(markerMessage(branch, targetSha), target.tree, [targetSha])
  if (!isMarkerOf(marker, target)) throw new Error(`marker commit for ${branch} is not an empty commit on ${targetSha.slice(0, 12)}`)
  return marker
}
