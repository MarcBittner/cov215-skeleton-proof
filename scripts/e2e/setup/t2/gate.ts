import { createHash } from "node:crypto"

import type { GateEntry } from "../../contract/types.js"
import { assertGateRef, draftSpecPath, parseGateBranch } from "../../gate/gate-run.js"
import { isMarkerHead, type MarkerGit } from "../../map/nightly/branch.js"
import { draftRecipe } from "../../../../e2e/helpers/tenant-recipes.js"

export const DRAFTS_LIVE_ENV = "E2E_DRAFTS_LIVE"
export const NO_BREAK = "none"
export const GATE_MAX_AGE_MS = 3 * 24 * 60 * 60 * 1000

export type GateInputs = Readonly<Record<string, string | undefined>>

export function parseGateInputs(kind: string, env: GateInputs): { gate: GateEntry | null; refused: string | null } {
  const ref = env.INPUT_GATE_REF ?? ""
  const sha256 = env.INPUT_GATE_SHA256 ?? ""
  const brk = env.INPUT_GATE_BREAK ?? ""
  if (kind !== "gate") {
    return ref || sha256 ? { gate: null, refused: `gate inputs are given for a ${kind} run` } : { gate: null, refused: null }
  }
  if (env[DRAFTS_LIVE_ENV] !== "1") return { gate: null, refused: `a gate run needs ${DRAFTS_LIVE_ENV}=1` }
  if (!ref || !sha256 || !brk) return { gate: null, refused: "a gate run needs gate_ref, gate_sha256 and gate_break" }
  const parsed = parseGateBranch(ref)
  if (!parsed) return { gate: null, refused: `gate_ref "${ref}" is not an e2e/gate/<id>-<n> branch` }
  try {
    return { gate: assertGateRef({ ref, path: draftSpecPath(parsed.gapId), sha256, break: brk === NO_BREAK ? null : brk }), refused: null }
  } catch (e) {
    return { gate: null, refused: (e as Error).message }
  }
}

export interface GateGit extends MarkerGit {
  getBranch(name: string): Promise<{ name: string; sha: string } | null>
  readContent(path: string, ref: string): Promise<{ text: string; sha: string } | null>
}

export type GateTarget =
  | { ok: true; markerSha: string; specCommit: string; spec: string; recipe: string }
  | { ok: false; reason: string }

export async function resolveGateBranch(git: GateGit, gate: GateEntry): Promise<GateTarget> {
  const head = await git.getBranch(gate.ref)
  if (!head) return { ok: false, reason: `${gate.ref} does not exist` }
  const commit = await git.getCommit(head.sha)
  if (commit.parents.length !== 1) return { ok: false, reason: `${gate.ref} head ${head.sha.slice(0, 12)} is not a marker commit` }
  const specCommit = commit.parents[0]
  if (!(await isMarkerHead(git, head.sha, specCommit))) {
    return { ok: false, reason: `${gate.ref} head ${head.sha.slice(0, 12)} is not an empty marker commit on ${specCommit.slice(0, 12)}` }
  }
  const doc = await git.readContent(gate.path, head.sha)
  if (!doc) return { ok: false, reason: `${gate.path} is missing at ${gate.ref}` }
  const sha256 = createHash("sha256").update(doc.text).digest("hex")
  if (sha256 !== gate.sha256) return { ok: false, reason: `${gate.path} at ${gate.ref} hashes to ${sha256}, not the planned ${gate.sha256}` }
  const recipe = draftRecipe(doc.text)
  if (!recipe) return { ok: false, reason: `${gate.path} uses no signed-in fixture set that a tenant recipe covers` }
  return { ok: true, markerSha: head.sha, specCommit, spec: doc.text, recipe }
}
