import path from "node:path"
import { appendFileSync } from "node:fs"
import { createHash } from "node:crypto"
import { pathToFileURL } from "node:url"
const ws = process.env.GITHUB_WORKSPACE
const { artifactUploader } = await import(pathToFileURL(path.join(ws, "up/dist/upload.js")).href)
const sleep = (ms) => new Promise((r) => setTimeout(r, ms))
const token = process.env.ACTIONS_RUNTIME_TOKEN, resultsUrl = process.env.ACTIONS_RESULTS_URL
console.log("token present:", !!token, "resultsUrl:", resultsUrl)
let code = 0
try {
  const upload = artifactUploader({ token, resultsUrl })
  for (let i = 1; i <= 3; i++) {
    const content = `bundle ${i} run ${process.env.GITHUB_RUN_ID} attempt ${process.env.GITHUB_RUN_ATTEMPT}\n`.repeat(1000 * i)
    const sha = createHash("sha256").update(content).digest("hex")
    const id = await upload(`e2e-bundle-${i}`, { "bundle.txt": content, "nested/meta.json": JSON.stringify({ i, sha }) })
    console.log(`${new Date().toISOString()} uploaded e2e-bundle-${i} id=${id} content sha256=${sha}`)
    if (i < 3) await sleep(45_000)
  }
  console.log(`${new Date().toISOString()} all uploaded; holding the step open 60s`)
  await sleep(60_000)
} catch (err) { console.error("UPLOAD FAILED:", err?.stack ?? err); code = 1 }
process.exit(code)
