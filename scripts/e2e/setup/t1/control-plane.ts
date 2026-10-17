import { version as convexVersion } from "convex"

export const CONVEX_CONTROL_PLANE = "https://api.convex.dev"
export const AUTHORIZE_PREVIEW_PATH = "/api/deployment/authorize_preview"

const DEPLOYMENT_NAME = /^[a-z]+-[a-z]+-\d+$/
const SLUG = /^[a-z0-9][a-z0-9-]{0,63}$/

export interface PreviewDeployment {
  previewName: string
  deploymentName: string
  url: string
  adminKey: string
}

export function previewKeyProject(deployKey: string): { teamSlug: string; projectSlug: string } {
  const [prefix, secret] = deployKey.split("|")
  const parts = (prefix ?? "").split(":")
  if (!secret || parts.length !== 3 || parts[0] !== "preview" || !SLUG.test(parts[1]) || !SLUG.test(parts[2])) {
    throw new Error("the Convex deploy key is not a preview deploy key (preview:<team>:<project>|...)")
  }
  return { teamSlug: parts[1], projectSlug: parts[2] }
}

export async function resolvePreviewDeployment(
  previewName: string,
  deployKey: string,
  fetchImpl: typeof fetch = fetch,
): Promise<PreviewDeployment> {
  if (!previewName) throw new Error("preview name is empty")
  const project = previewKeyProject(deployKey)
  const res = await fetchImpl(`${CONVEX_CONTROL_PLANE}${AUTHORIZE_PREVIEW_PATH}`, {
    method: "POST",
    headers: {
      Authorization: `Bearer ${deployKey}`,
      "Content-Type": "application/json",
      "Convex-Client": `npm-cli-${convexVersion}`,
    },
    body: JSON.stringify({ previewName, projectSelection: { kind: "teamAndProjectSlugs", ...project } }),
  })
  if (res.status !== 200) throw new Error(`Convex control plane refused preview "${previewName}": HTTP ${res.status}`)
  const body = (await res.json().catch(() => null)) as { deploymentName?: unknown; url?: unknown; adminKey?: unknown } | null
  const name = body?.deploymentName
  const url = body?.url
  const adminKey = body?.adminKey
  if (typeof name !== "string" || !DEPLOYMENT_NAME.test(name)) throw new Error("Convex control plane returned no deployment name")
  if (typeof url !== "string" || url.replace(/\/+$/, "") !== `https://${name}.convex.cloud`) {
    throw new Error(`Convex control plane returned URL ${String(url)} for ${name}`)
  }
  if (typeof adminKey !== "string" || !adminKey) throw new Error("Convex control plane returned no admin key")
  return { previewName, deploymentName: name, url: `https://${name}.convex.cloud`, adminKey }
}
