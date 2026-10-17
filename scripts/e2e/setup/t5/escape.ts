const ANSI = /\u001b\[[0-9;]*[A-Za-z]/g
const ZWJ = "‍"

export function neutraliseMentions(text: string): string {
  return String(text).replace(/@(?=[A-Za-z0-9_-])/g, `@${ZWJ}`)
}

export function neutraliseReferences(text: string): string {
  return String(text)
    .replace(/#(?=\d)/g, `#${ZWJ}`)
    .replace(/\b(GH-)(?=\d)/gi, `$1${ZWJ}`)
    .replace(/\b([a-z][a-z0-9+.-]*):(?=\/\/)/gi, `$1:${ZWJ}`)
    .replace(/\bwww\./gi, `www${ZWJ}.`)
}

export function escapeInline(text: string): string {
  const flat = String(text ?? "")
    .replace(ANSI, "")
    .replace(/[\r\n\t]+/g, " ")
    .trim()
  const escaped = flat
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/([\\`*_{}[\]()|~!#])/g, "\\$1")
  return neutraliseReferences(neutraliseMentions(escaped))
}

export function plainTitle(text: string): string {
  return neutraliseReferences(neutraliseMentions(String(text ?? "").replace(ANSI, "").replace(/[\r\n\t]+/g, " ").trim()))
}
