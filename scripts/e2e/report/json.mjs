import { readFileSync } from "node:fs"
import { isContractTestId } from "./id.mjs"

export function readJson(file) {
  return JSON.parse(readFileSync(file, "utf8"))
}

export function checkId(id, where, problems) {
  if (typeof id !== "string") {
    problems.push(`${where}: id must be a string`)
    return false
  }
  if (!isContractTestId(id)) {
    problems.push(`${where}: not a test id: ${id}`)
    return false
  }
  return true
}
