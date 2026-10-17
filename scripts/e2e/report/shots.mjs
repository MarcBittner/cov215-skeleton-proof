import { createHash } from "node:crypto"
import path from "node:path"

export const SHOTS_BRANCH = "e2e/shots"

export function localShotPath(shardDir, reportedPath) {
  const p = String(reportedPath).replace(/\\/g, "/")
  const i = p.lastIndexOf("/test-results/")
  const rel = i === -1 ? (p.startsWith("test-results/") ? p : null) : p.slice(i + 1)
  if (!rel || rel.split("/").includes("..")) return null
  return path.join(shardDir, rel)
}

export function shotTarget(runTag, id, index) {
  if (!/^[A-Za-z0-9-]+$/.test(runTag)) throw new Error(`bad run tag: ${runTag}`)
  const h = createHash("sha1").update(id).digest("hex").slice(0, 12)
  return `${runTag}/${h}-${index + 1}.png`
}

export function shotUrl(target, repo = "CO-Ver/Co-Ver") {
  return `https://github.com/${repo}/blob/${SHOTS_BRANCH}/${target}?raw=true`
}

export function planShots(rows, runTag, shardDirs) {
  const out = []
  for (const row of rows) {
    if (row.status !== "failed" && row.status !== "flaky") continue
    for (const [i, p] of (row.screenshots ?? []).entries()) {
      const dir = shardDirs.get(row.shard)
      const from = dir ? localShotPath(dir, p) : null
      if (from) out.push({ id: row.id, reported: p, from, to: shotTarget(runTag, row.id, i) })
    }
  }
  return out
}
