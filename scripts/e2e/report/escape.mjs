const ANSI = /\u001b\[[0-9;]*[A-Za-z]/g
const ZWJ = "‍"

export function neutraliseMentions(text) {
  return String(text).replace(/@(?=[A-Za-z0-9_-])/g, `@${ZWJ}`)
}

export function escapeInline(text) {
  const flat = String(text ?? "")
    .replace(ANSI, "")
    .replace(/[\r\n\t]+/g, " ")
  const escaped = flat
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/([\\`*_{}[\]()|~!#])/g, "\\$1")
  return neutraliseMentions(escaped)
}

export function codeBlock(text, lang = "") {
  const body = neutraliseMentions(String(text ?? "").replace(ANSI, ""))
  const longest = Math.max(0, ...[...body.matchAll(/`+/g)].map((m) => m[0].length))
  const fence = "`".repeat(Math.max(3, longest + 1))
  return `${fence}${lang}\n${body}\n${fence}`
}

export function inlineCode(text) {
  const body = neutraliseMentions(String(text ?? "").replace(ANSI, "").replace(/[\r\n]+/g, " "))
  const longest = Math.max(0, ...[...body.matchAll(/`+/g)].map((m) => m[0].length))
  const fence = "`".repeat(longest + 1)
  const pad = body.startsWith("`") || body.endsWith("`") ? " " : ""
  return `${fence}${pad}${body}${pad}${fence}`
}

export function hasLiveMention(markdown) {
  const withoutCode = String(markdown).replace(/(`+)[\s\S]*?\1/g, "")
  return /(^|[^\w`\\])@[A-Za-z0-9](?:[A-Za-z0-9-]*[A-Za-z0-9])?(?![\w-])/.test(withoutCode)
}
