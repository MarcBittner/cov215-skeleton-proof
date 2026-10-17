import { packByRuntime, binLoads, percentile } from "../../shard-balance.mjs"
import { isIdOfKind, testKindOf } from "../../../e2e/map/ids.js"

export const SEP = " › "
export const TEST_DIR = "e2e"
export const DEFAULT_TEST_MS = 30_000

export function testId({ project, file, titles }) {
  for (const part of [file, ...titles]) {
    if (part.includes("›")) throw new Error(`test title contains "›", which a Playwright test list cannot express: ${[file, ...titles].join(SEP)}`)
  }
  return `[${project}]${SEP}${file}${SEP}${titles.join(SEP)}`
}

export function parseTestId(line) {
  const m = /^\[([^\]]+)\] › (.+)$/.exec(line)
  if (!m) throw new Error(`not a test-list line: ${line}`)
  const [file, ...titles] = m[2].split(SEP)
  if (!file || titles.length === 0) throw new Error(`not a test-list line: ${line}`)
  return { project: m[1], file, titles }
}

export function isContractTestId(id) {
  return typeof id === "string" && isIdOfKind(id, "test")
}

export function contractId({ file, titles }, testDir = TEST_DIR) {
  const id = `test:${testDir}/${file}::${titles.join(SEP)}`
  if (!isIdOfKind(id, "test")) throw new Error(`test has no contract id (empty, padded or multi-line title): ${[file, ...titles].join(SEP)}`)
  return id
}

export function projectOf(id) {
  return parseTestId(id).project
}

export function contractIdFromLine(line, testDir = TEST_DIR) {
  return contractId(parseTestId(line), testDir)
}

export function lineFromContractId(id, project, testDir = TEST_DIR) {
  if (!isIdOfKind(id, "test")) throw new Error(`only a test: id converts to a test-list line without the catalogue: ${id}`)
  const sep = id.indexOf("::")
  const repoPath = id.slice("test:".length, sep)
  const prefix = `${testDir}/`
  if (!repoPath.startsWith(prefix)) throw new Error(`${id} is not under ${testDir}/`)
  return testId({ project, file: repoPath.slice(prefix.length), titles: id.slice(sep + 2).split(SEP) })
}

export function* walkReport(report, testDir = TEST_DIR) {
  function* walk(suite, titles) {
    for (const spec of suite.specs ?? []) {
      for (const test of spec.tests ?? []) {
        const t = [...titles, spec.title]
        const where = { project: test.projectName, file: spec.file, titles: t }
        yield { id: testId(where), contractId: contractId(where, testDir), project: test.projectName, file: spec.file, titles: t, line: spec.line, test }
      }
    }
    for (const child of suite.suites ?? []) yield* walk(child, [...titles, child.title])
  }
  if (!report || !Array.isArray(report.suites)) throw new Error("not a Playwright JSON report: no suites[]")
  for (const fileSuite of report.suites) yield* walk(fileSuite, [])
}

export function catalogueFromList(listReport, testDir = TEST_DIR) {
  const seen = new Set()
  const byContract = new Map()
  const out = []
  for (const { id, contractId: cid, project, file, titles } of walkReport(listReport, testDir)) {
    if (seen.has(id)) throw new Error(`duplicate test id in --list: ${id}`)
    if (byContract.has(cid)) throw new Error(`${byContract.get(cid)} and ${id} share contract id ${cid}; a test runs in one project`)
    seen.add(id)
    byContract.set(cid, id)
    out.push({ id, contractId: cid, project, file, titles, kind: testKindOf(cid) })
  }
  return out.sort((a, b) => (a.id < b.id ? -1 : a.id > b.id ? 1 : 0))
}

export function weigher(durations, ids, projectFor = projectOfOrNull) {
  const byProject = new Map()
  const all = []
  for (const [id, ms] of Object.entries(durations ?? {})) {
    if (typeof ms !== "number" || !Number.isFinite(ms) || ms < 0) continue
    const project = projectFor(id)
    if (project) {
      if (!byProject.has(project)) byProject.set(project, [])
      byProject.get(project).push(ms)
    }
    all.push(ms)
  }
  const globalP75 = percentile(all, 0.75) || DEFAULT_TEST_MS
  const unknown = []
  const weights = new Map()
  for (const id of ids) {
    const known = durations?.[id]
    if (typeof known === "number" && Number.isFinite(known) && known >= 0) {
      weights.set(id, known)
      continue
    }
    unknown.push(id)
    const samples = byProject.get(projectFor(id))
    weights.set(id, samples && samples.length ? percentile(samples, 0.75) : globalP75)
  }
  return { weights, unknown }
}

function projectOfOrNull(id) {
  try {
    return projectOf(id)
  } catch {
    return null
  }
}

export function packTestIds(ids, weights, count) {
  const bins = packByRuntime(
    ids.map((id) => ({ id, weight: weights.get(id) ?? 0 })),
    count,
  )
  return { bins, loads: binLoads(bins, (id) => weights.get(id) ?? 0) }
}
