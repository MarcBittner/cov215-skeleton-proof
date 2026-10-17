import { spawnSync } from "node:child_process"
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import path from "node:path"
import type { SetupGitHub } from "./github.js"
import { readPreview, type GitHubReader } from "./resolve.js"

export const FALLBACK_TRIGGER_FILES = ["scripts/skip-build.sh", "scripts/skip-ci.sh", "vercel.json"] as const

export type Exec = (cmd: string, args: readonly string[], opts: { cwd: string; env?: Record<string, string> }) => { status: number | null; stdout: string }

export function editsBuildRules(files: ReadonlyArray<{ filename: string; previous_filename?: string }>): string[] {
  const hits = new Set<string>()
  for (const f of files) {
    for (const name of [f.filename, f.previous_filename]) {
      if (name && (FALLBACK_TRIGGER_FILES as readonly string[]).includes(name)) hits.add(name)
    }
  }
  return [...hits].sort()
}

export interface ChangedFiles {
  files: string[]
  complete: boolean
}

const GIT_SHIM = `#!/usr/bin/env bash
if [ "$1" = diff ]; then cat "$E2E_CHANGED_FILES"; exit 0; fi
echo "git $1 is not available to skip-build.sh here" >&2
exit 2
`

export function headSkipsBuildFromFiles(opts: { exec: Exec; stagingDir: string; headRef: string; commitMessage: string; changed: ChangedFiles | null }): boolean {
  if (!opts.changed || !opts.changed.complete) return false
  const dir = mkdtempSync(path.join(tmpdir(), "e2e-skip-"))
  try {
    const bin = path.join(dir, "bin")
    mkdirSync(bin)
    writeFileSync(path.join(bin, "git"), GIT_SHIM, { mode: 0o755 })
    const list = path.join(dir, "changed.txt")
    writeFileSync(list, opts.changed.files.map((f) => `${f}\n`).join(""))
    const r = opts.exec("bash", [path.join(opts.stagingDir, "scripts/skip-build.sh"), "compare"], {
      cwd: dir,
      env: {
        VERCEL_GIT_COMMIT_MESSAGE: opts.commitMessage,
        VERCEL_GIT_COMMIT_REF: opts.headRef,
        E2E_CHANGED_FILES: list,
        PATH: `${bin}${path.delimiter}${process.env.PATH ?? ""}`,
      },
    })
    if (r.status !== 0 && r.status !== 1) throw new Error(`skip-build.sh exited ${r.status}`)
    return r.status === 0
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
}

export async function previousReadySha(reader: GitHubReader, pr: number, headSha: string): Promise<string | null> {
  const shas = (await reader.listPullCommitShas(pr)).filter((s) => s !== headSha)
  for (const sha of [...shas].reverse()) if ((await readPreview(reader, sha)).state === "READY") return sha
  return null
}

export async function skipsBuild(a: { github: SetupGitHub; reader: GitHubReader; pr: number; prSha: string; stagingDir: string; exec?: Exec }): Promise<boolean> {
  const previous = await previousReadySha(a.reader, a.pr, a.prSha)
  const pull = await a.reader.getPull(a.pr)
  return headSkipsBuildFromFiles({
    exec: a.exec ?? spawnExec,
    stagingDir: a.stagingDir,
    headRef: pull.head.ref,
    commitMessage: await a.github.commitMessage(a.prSha),
    changed: previous ? await a.github.compareFiles(previous, a.prSha) : null,
  })
}

export const spawnExec: Exec = (cmd, args, opts) => {
  const r = spawnSync(cmd, [...args], { cwd: opts.cwd, env: (opts.env ?? process.env) as NodeJS.ProcessEnv, encoding: "utf8" })
  return { status: r.status, stdout: r.stdout ?? "" }
}
