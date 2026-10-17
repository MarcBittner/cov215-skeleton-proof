#!/usr/bin/env node
import { readdirSync, readFileSync, writeFileSync, statSync, rmSync } from "node:fs"
import path from "node:path"
import { fileURLToPath } from "node:url"
import JSZip from "jszip"

export const REDACTED = "[scrubbed]"
const SENSITIVE_HEADERS = "cookie|set-cookie|authorization|x-vercel-protection-bypass|x-clerk-auth-token"
const SENSITIVE_NAMES = "__session[\\w-]*|__client[\\w-]*|__clerk_db_jwt[\\w-]*|__clerk_ticket|__clerk_handshake[\\w-]*|x-vercel-protection-bypass|x-vercel-set-bypass-cookie"
const TEXT_EXT = new Set([".json", ".jsonl", ".trace", ".network", ".stacks", ".txt", ".md", ".html", ".log", ".xml", ".har", ".js", ".css", ".yml"])
const BUNDLE_NAMES = /^(e2e-bundle(\..*)?|e2e-inputs\.json|bundle\.json|bundle\.enc)$/

function patterns() {
  return [
    {
      name: "header",
      re: new RegExp(`("name"\\s*:\\s*"(?:${SENSITIVE_HEADERS}|${SENSITIVE_NAMES})"\\s*,\\s*"value"\\s*:\\s*")((?:[^"\\\\]|\\\\.)+)(")`, "gi"),
      keep: (m, a, v, z) => (v === REDACTED ? m : `${a}${REDACTED}${z}`),
    },
    {
      name: "header-object",
      re: new RegExp(`("(?:${SENSITIVE_HEADERS})"\\s*:\\s*")((?:[^"\\\\]|\\\\.)+)(")`, "gi"),
      keep: (m, a, v, z) => (v === REDACTED ? m : `${a}${REDACTED}${z}`),
    },
    {
      name: "header-line",
      re: new RegExp(`^(\\s*(?:${SENSITIVE_HEADERS}):[ \\t]*)(\\S.*)$`, "gim"),
      keep: (m, a, v) => (v === REDACTED ? m : `${a}${REDACTED}`),
    },
    {
      name: "pair",
      re: new RegExp(`((?:${SENSITIVE_NAMES})=)([^;&\\s"'\\\\]+)`, "gi"),
      keep: (m, a, v) => (v === REDACTED || v === encodeURIComponent(REDACTED) ? m : `${a}${REDACTED}`),
    },
    {
      name: "bearer",
      re: /(Bearer\s+)([A-Za-z0-9._~+/=-]{8,})/g,
      keep: (m, a, v) => (v === REDACTED ? m : `${a}${REDACTED}`),
    },
    {
      name: "jwt",
      re: /eyJ[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}/g,
      keep: () => REDACTED,
    },
  ]
}

function secretForms(secrets) {
  const forms = new Set()
  for (const s of secrets) {
    if (typeof s !== "string" || s.length < 8) continue
    forms.add(s)
    forms.add(encodeURIComponent(s))
    forms.add(JSON.stringify(s).slice(1, -1))
  }
  return [...forms].sort((a, b) => b.length - a.length)
}

/** @param {string} text @param {{ secrets?: string[] }} [opts] */
export function scrubText(text, { secrets = [] } = {}) {
  let out = text
  for (const form of secretForms(secrets)) out = out.split(form).join(REDACTED)
  for (const p of patterns()) out = out.replace(p.re, p.keep)
  return out
}

/** @param {string} text @param {{ secrets?: string[] }} [opts] */
export function findLeaks(text, { secrets = [] } = {}) {
  const leaks = []
  for (const form of secretForms(secrets)) if (text.includes(form)) leaks.push("planted secret")
  for (const p of patterns()) {
    for (const m of text.matchAll(new RegExp(p.re.source, p.re.flags))) {
      if (p.keep(...m) !== m[0]) leaks.push(p.name)
    }
  }
  return leaks
}

export function ticketsFromBundle(bundle) {
  const out = []
  const walk = (v) => {
    if (typeof v === "string") out.push(v)
    else if (v && typeof v === "object") Object.values(v).forEach(walk)
  }
  walk(bundle?.tickets)
  return out
}

function isText(buf) {
  if (buf.includes(0)) return false
  return !buf.toString("utf8").includes("�")
}

export async function scrubZip(buf, opts) {
  const zip = await JSZip.loadAsync(buf)
  const out = new JSZip()
  const leaks = []
  for (const [name, entry] of Object.entries(zip.files)) {
    if (entry.dir) continue
    const data = await entry.async("nodebuffer")
    if (BUNDLE_NAMES.test(path.basename(name))) continue
    if (isText(data)) {
      const text = scrubText(data.toString("utf8"), opts)
      leaks.push(...findLeaks(text, opts).map((l) => `${name}: ${l}`))
      out.file(name, text)
    } else {
      const latin = data.toString("latin1")
      leaks.push(...secretForms(opts.secrets ?? []).filter((f) => latin.includes(f)).map(() => `${name}: planted secret in binary entry`))
      out.file(name, data)
    }
  }
  return { buf: await out.generateAsync({ type: "nodebuffer", compression: "DEFLATE" }), leaks }
}

function walkFiles(dir) {
  const out = []
  for (const name of readdirSync(dir)) {
    const full = path.join(dir, name)
    if (statSync(full).isDirectory()) out.push(...walkFiles(full))
    else out.push(full)
  }
  return out
}

/** @param {string} dir @param {{ secrets?: string[] }} [opts] */
export async function scrubDirectory(dir, opts = {}) {
  const leaks = []
  const removed = []
  for (const file of walkFiles(dir)) {
    const rel = path.relative(dir, file)
    if (BUNDLE_NAMES.test(path.basename(file))) {
      rmSync(file)
      removed.push(rel)
      continue
    }
    const ext = path.extname(file).toLowerCase()
    const buf = readFileSync(file)
    if (ext === ".zip") {
      const res = await scrubZip(buf, opts)
      writeFileSync(file, res.buf)
      leaks.push(...res.leaks.map((l) => `${rel}!${l}`))
    } else if (TEXT_EXT.has(ext) || isText(buf)) {
      const text = scrubText(buf.toString("utf8"), opts)
      writeFileSync(file, text)
      leaks.push(...findLeaks(text, opts).map((l) => `${rel}: ${l}`))
    } else {
      const latin = buf.toString("latin1")
      leaks.push(...secretForms(opts.secrets ?? []).filter((f) => latin.includes(f)).map(() => `${rel}: planted secret in binary file`))
    }
  }
  return { leaks, removed }
}

/** @param {string[]} [argv] */
export async function main(argv = process.argv.slice(2)) {
  const dir = argv.find((a) => !a.startsWith("--"))
  if (!dir) throw new Error("usage: scrub.mjs <dir> [--bundle <decrypted bundle json>] [--secrets-file <newline list>]")
  const secrets = []
  const b = argv.indexOf("--bundle")
  if (b !== -1) secrets.push(...ticketsFromBundle(JSON.parse(readFileSync(argv[b + 1], "utf8"))))
  const s = argv.indexOf("--secrets-file")
  if (s !== -1) secrets.push(...readFileSync(argv[s + 1], "utf8").split("\n").map((l) => l.trim()).filter(Boolean))
  const { leaks, removed } = await scrubDirectory(dir, { secrets })
  for (const r of removed) console.log(`removed ${r}`)
  if (leaks.length) {
    for (const l of leaks) console.error(`leak remains after scrubbing: ${l}`)
    console.error("refusing to upload or post")
    return 1
  }
  console.log(`scrubbed ${dir}`)
  return 0
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  main().then((code) => {
    process.exitCode = code
  })
}
