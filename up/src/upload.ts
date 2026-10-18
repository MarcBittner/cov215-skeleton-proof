import { createHash } from "node:crypto"
import JSZip from "jszip"
import type { ArtifactStage } from "./live.js"
import type { SetupGitHub } from "./github.js"

export type Fetch = (url: string, init?: RequestInit) => Promise<Response>
export type Upload = (name: string, files: Record<string, string>) => Promise<string>

const SERVICE = "twirp/github.actions.results.api.v1.ArtifactService"
const REQUEST_TIMEOUT_MS = 60_000
const DAY_MS = 24 * 3600_000

export function backendIds(token: string): { run: string; job: string } {
  const payload = token.split(".")[1]
  if (!payload) throw new Error("the Actions runtime token is not a JWT")
  let claims: { scp?: unknown }
  try {
    claims = JSON.parse(Buffer.from(payload, "base64url").toString("utf8")) as { scp?: unknown }
  } catch {
    throw new Error("the Actions runtime token is not a JWT")
  }
  for (const scope of typeof claims.scp === "string" ? claims.scp.split(" ") : []) {
    const parts = scope.split(":")
    if (parts.length === 3 && parts[0] === "Actions.Results" && parts[1] && parts[2]) return { run: parts[1], job: parts[2] }
  }
  throw new Error("the Actions runtime token carries no Actions.Results scope")
}

export async function zipFiles(files: Record<string, string>): Promise<Buffer> {
  const zip = new JSZip()
  for (const [name, text] of Object.entries(files)) zip.file(name, text)
  return zip.generateAsync({ type: "nodebuffer", compression: "DEFLATE" })
}

export function retentionDaysOf(name: string): number | null {
  return name.startsWith("e2e-bundle") ? 1 : null
}

export function artifactUploader(opts: { token: string; resultsUrl: string; fetch?: Fetch; now?: () => number }): Upload {
  const ids = backendIds(opts.token)
  const origin = new URL(opts.resultsUrl).origin
  const doFetch: Fetch = opts.fetch ?? ((url, init) => globalThis.fetch(url, init))
  const now = opts.now ?? Date.now
  const twirp = async (method: string, body: Record<string, unknown>) => {
    const res = await doFetch(`${origin}/${SERVICE}/${method}`, {
      method: "POST",
      headers: { "Content-Type": "application/json", Authorization: `Bearer ${opts.token}` },
      body: JSON.stringify(body),
      signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
    })
    const text = await res.text()
    if (!res.ok) throw new Error(`artifact ${method}: HTTP ${res.status} ${text.slice(0, 200)}`)
    const out = (text ? JSON.parse(text) : {}) as Record<string, unknown>
    if (out.ok !== true) throw new Error(`artifact ${method} was refused`)
    return out
  }
  return async (name, files) => {
    const zip = await zipFiles(files)
    const owner = { workflow_run_backend_id: ids.run, workflow_job_run_backend_id: ids.job, name }
    const days = retentionDaysOf(name)
    const expires = days === null ? {} : { expires_at: new Date(now() + days * DAY_MS).toISOString().replace(/\.\d{3}Z$/, "Z") }
    const created = await twirp("CreateArtifact", { ...owner, version: 4, ...expires })
    const url = String(created.signed_upload_url ?? created.signedUploadUrl ?? "")
    if (!url.startsWith("https://")) throw new Error(`artifact CreateArtifact for ${name} returned no upload URL`)
    const put = await doFetch(url, {
      method: "PUT",
      headers: { "x-ms-blob-type": "BlockBlob", "Content-Type": "application/zip" },
      body: new Uint8Array(zip),
      signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
    })
    if (!put.ok) throw new Error(`artifact upload of ${name}: HTTP ${put.status}`)
    const hash = createHash("sha256").update(zip).digest("hex")
    const done = await twirp("FinalizeArtifact", { ...owner, size: String(zip.length), hash: `sha256:${hash}` })
    return String(done.artifact_id ?? done.artifactId ?? "")
  }
}

export function liveStage(dir: ArtifactStage, upload: Upload, gh: Pick<SetupGitHub, "deleteRunArtifacts">, runId: string): ArtifactStage {
  return {
    async stage(name, files) {
      await dir.stage(name, files)
      await gh.deleteRunArtifacts(runId, name)
      await upload(name, files)
    },
  }
}
