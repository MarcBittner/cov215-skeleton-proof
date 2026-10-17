export type JsonSchema = { [keyword: string]: unknown }

export type ValidationResult<T> = { ok: true; value: T } | { ok: false; errors: string[] }

const SUBSCHEMA_MAPS = ["properties", "$defs"]
const SUBSCHEMA_SINGLE = ["additionalProperties", "propertyNames", "items", "not", "if", "then", "else"]
const SUBSCHEMA_LISTS = ["oneOf", "anyOf", "allOf"]
const PLAIN = [
  "$schema",
  "$id",
  "$ref",
  "$comment",
  "title",
  "description",
  "type",
  "required",
  "maxProperties",
  "minProperties",
  "minItems",
  "maxItems",
  "uniqueItems",
  "enum",
  "const",
  "pattern",
  "minLength",
  "maxLength",
  "minimum",
  "maximum",
]
const SUPPORTED = new Set([...SUBSCHEMA_MAPS, ...SUBSCHEMA_SINGLE, ...SUBSCHEMA_LISTS, ...PLAIN])
const TYPES = new Set(["null", "boolean", "object", "array", "string", "number", "integer"])

const regexCache = new Map<string, RegExp>()

function regex(p: string): RegExp {
  let r = regexCache.get(p)
  if (!r) {
    r = new RegExp(p, "u")
    regexCache.set(p, r)
  }
  return r
}

function isObject(v: unknown): v is Record<string, unknown> {
  return typeof v === "object" && v !== null && !Array.isArray(v)
}

export function stableStringify(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(stableStringify).join(",")}]`
  if (isObject(value)) {
    const keys = Object.keys(value).sort()
    return `{${keys.map((k) => `${JSON.stringify(k)}:${stableStringify(value[k])}`).join(",")}}`
  }
  return JSON.stringify(value) ?? "undefined"
}

function deepEqual(a: unknown, b: unknown): boolean {
  return stableStringify(a) === stableStringify(b)
}

function resolveRef(root: JsonSchema, ref: string): JsonSchema {
  if (ref === "#") return root
  const m = /^#\/\$defs\/([A-Za-z0-9_-]+)$/.exec(ref)
  const defs = root.$defs
  if (!m || !isObject(defs) || !isObject(defs[m[1]])) throw new Error(`unresolvable $ref ${ref}`)
  return defs[m[1]] as JsonSchema
}

export function assertSupportedSchema(schema: unknown, root?: JsonSchema, at = "#"): void {
  if (typeof schema === "boolean") return
  if (!isObject(schema)) throw new Error(`${at}: schema must be an object or boolean`)
  const top = root ?? schema
  for (const [k, v] of Object.entries(schema)) {
    if (!SUPPORTED.has(k)) throw new Error(`${at}: unsupported keyword ${k}`)
    if (SUBSCHEMA_MAPS.includes(k)) {
      if (!isObject(v)) throw new Error(`${at}/${k}: must be an object`)
      for (const [name, sub] of Object.entries(v)) assertSupportedSchema(sub, top, `${at}/${k}/${name}`)
    } else if (SUBSCHEMA_SINGLE.includes(k)) {
      assertSupportedSchema(v, top, `${at}/${k}`)
    } else if (SUBSCHEMA_LISTS.includes(k)) {
      if (!Array.isArray(v) || v.length === 0) throw new Error(`${at}/${k}: must be a non-empty array`)
      v.forEach((sub, i) => assertSupportedSchema(sub, top, `${at}/${k}/${i}`))
    } else if (k === "type") {
      const list = Array.isArray(v) ? v : [v]
      for (const t of list) if (typeof t !== "string" || !TYPES.has(t)) throw new Error(`${at}/type: unknown type ${String(t)}`)
    } else if (k === "pattern") {
      if (typeof v !== "string") throw new Error(`${at}/pattern: must be a string`)
      regex(v)
    } else if (k === "$ref") {
      if (typeof v !== "string") throw new Error(`${at}/$ref: must be a string`)
      resolveRef(top, v)
    } else if (k === "required") {
      if (!Array.isArray(v) || !v.every((x) => typeof x === "string")) throw new Error(`${at}/required: must be a string array`)
    }
  }
}

function typeMatches(t: string, v: unknown): boolean {
  switch (t) {
    case "null":
      return v === null
    case "boolean":
      return typeof v === "boolean"
    case "object":
      return isObject(v)
    case "array":
      return Array.isArray(v)
    case "string":
      return typeof v === "string"
    case "number":
      return typeof v === "number" && Number.isFinite(v)
    case "integer":
      return typeof v === "number" && Number.isInteger(v)
    default:
      return false
  }
}

function describe(v: unknown): string {
  if (v === null) return "null"
  if (Array.isArray(v)) return "array"
  return typeof v
}

function run(schema: JsonSchema | boolean, value: unknown, root: JsonSchema, at: string, errors: string[]): void {
  if (schema === true) return
  if (schema === false) {
    errors.push(`${at || "/"}: not allowed`)
    return
  }
  const where = at || "/"
  if (typeof schema.$ref === "string") {
    run(resolveRef(root, schema.$ref), value, root, at, errors)
  }
  if (schema.type !== undefined) {
    const types = (Array.isArray(schema.type) ? schema.type : [schema.type]) as string[]
    if (!types.some((t) => typeMatches(t, value))) {
      errors.push(`${where}: expected ${types.join("|")}, got ${describe(value)}`)
      return
    }
  }
  if (schema.const !== undefined && !deepEqual(schema.const, value)) {
    errors.push(`${where}: must equal ${JSON.stringify(schema.const)}`)
  }
  if (Array.isArray(schema.enum) && !schema.enum.some((e) => deepEqual(e, value))) {
    errors.push(`${where}: must be one of ${schema.enum.map((e) => JSON.stringify(e)).join(", ")}`)
  }
  if (typeof value === "string") {
    const len = [...value].length
    if (typeof schema.minLength === "number" && len < schema.minLength) errors.push(`${where}: shorter than ${schema.minLength}`)
    if (typeof schema.maxLength === "number" && len > schema.maxLength) errors.push(`${where}: longer than ${schema.maxLength}`)
    if (typeof schema.pattern === "string" && !regex(schema.pattern).test(value)) {
      errors.push(`${where}: does not match ${schema.pattern}`)
    }
  }
  if (typeof value === "number") {
    if (typeof schema.minimum === "number" && value < schema.minimum) errors.push(`${where}: below ${schema.minimum}`)
    if (typeof schema.maximum === "number" && value > schema.maximum) errors.push(`${where}: above ${schema.maximum}`)
  }
  if (Array.isArray(value)) {
    if (typeof schema.minItems === "number" && value.length < schema.minItems) errors.push(`${where}: fewer than ${schema.minItems} items`)
    if (typeof schema.maxItems === "number" && value.length > schema.maxItems) errors.push(`${where}: more than ${schema.maxItems} items`)
    if (schema.uniqueItems === true) {
      const seen = new Set<string>()
      value.forEach((item, i) => {
        const key = stableStringify(item)
        if (seen.has(key)) errors.push(`${at}/${i}: duplicate item`)
        seen.add(key)
      })
    }
    if (schema.items !== undefined) {
      value.forEach((item, i) => run(schema.items as JsonSchema, item, root, `${at}/${i}`, errors))
    }
  }
  if (isObject(value)) {
    const keys = Object.keys(value)
    if (typeof schema.minProperties === "number" && keys.length < schema.minProperties) {
      errors.push(`${where}: fewer than ${schema.minProperties} properties`)
    }
    if (typeof schema.maxProperties === "number" && keys.length > schema.maxProperties) {
      errors.push(`${where}: more than ${schema.maxProperties} properties`)
    }
    if (Array.isArray(schema.required)) {
      for (const r of schema.required as string[]) if (!(r in value)) errors.push(`${where}: missing required ${r}`)
    }
    const props = isObject(schema.properties) ? schema.properties : {}
    for (const k of keys) {
      const child = `${at}/${k}`
      if (schema.propertyNames !== undefined) run(schema.propertyNames as JsonSchema, k, root, `${child}#name`, errors)
      if (k in props) {
        run(props[k] as JsonSchema, value[k], root, child, errors)
      } else if (schema.additionalProperties === false) {
        errors.push(`${child}: unexpected property`)
      } else if (schema.additionalProperties !== undefined && schema.additionalProperties !== true) {
        run(schema.additionalProperties as JsonSchema, value[k], root, child, errors)
      }
    }
  }
  if (Array.isArray(schema.allOf)) {
    for (const sub of schema.allOf) run(sub as JsonSchema, value, root, at, errors)
  }
  if (Array.isArray(schema.anyOf)) {
    const results = schema.anyOf.map((sub) => collect(sub as JsonSchema, value, root, at))
    if (!results.some((r) => r.length === 0)) errors.push(...closestBranch(results, where, "anyOf"))
  }
  if (Array.isArray(schema.oneOf)) {
    const results = schema.oneOf.map((sub) => collect(sub as JsonSchema, value, root, at))
    const passing = results.filter((r) => r.length === 0).length
    if (passing === 0) errors.push(...closestBranch(results, where, "oneOf"))
    else if (passing > 1) errors.push(`${where}: matches ${passing} of oneOf, expected exactly 1`)
  }
  if (schema.not !== undefined && collect(schema.not as JsonSchema, value, root, at).length === 0) {
    errors.push(`${where}: matches a forbidden shape`)
  }
  if (schema.if !== undefined) {
    const branch = collect(schema.if as JsonSchema, value, root, at).length === 0 ? schema.then : schema.else
    if (branch !== undefined) run(branch as JsonSchema, value, root, at, errors)
  }
}

function closestBranch(results: string[][], where: string, keyword: string): string[] {
  const typed = results.filter((r) => !r.some((e) => e.startsWith(`${where}: expected `)))
  return typed.length === 1 ? typed[0] : [`${where}: matches none of ${keyword}`]
}

function collect(schema: JsonSchema | boolean, value: unknown, root: JsonSchema, at: string): string[] {
  const errors: string[] = []
  run(schema, value, root, at, errors)
  return errors
}

export function schemaErrors(schema: JsonSchema, value: unknown): string[] {
  return collect(schema, value, schema, "")
}

export type Version = { major: number; minor: number }

export function parseVersion(v: unknown): Version | null {
  if (typeof v !== "string") return null
  const m = /^(0|[1-9][0-9]*)\.(0|[1-9][0-9]*)$/.exec(v)
  return m ? { major: Number(m[1]), minor: Number(m[2]) } : null
}

export function checkDocument<T>(
  schema: JsonSchema,
  versionField: string,
  supportedMajor: number,
  value: unknown,
  semantic: (doc: T) => string[] = () => [],
): ValidationResult<T> {
  if (!isObject(value)) return { ok: false, errors: [`/: expected object, got ${describe(value)}`] }
  const version = parseVersion(value[versionField])
  if (!version) return { ok: false, errors: [`/${versionField}: missing or malformed version`] }
  if (version.major !== supportedMajor) {
    return { ok: false, errors: [`/${versionField}: unsupported major version ${version.major} (supported ${supportedMajor})`] }
  }
  const errors = schemaErrors(schema, value)
  if (errors.length > 0) return { ok: false, errors }
  const more = semantic(value as T)
  return more.length > 0 ? { ok: false, errors: more } : { ok: true, value: value as T }
}

export function orThrow<T>(name: string, result: ValidationResult<T>): T {
  if (result.ok) return result.value
  throw new Error(`${name} invalid: ${result.errors.join("; ")}`)
}

export function parseJsonDocument<T>(name: string, text: string, validate: (v: unknown) => ValidationResult<T>): T {
  let parsed: unknown
  try {
    parsed = JSON.parse(text)
  } catch (e) {
    throw new Error(`${name} invalid: not JSON (${(e as Error).message})`)
  }
  return orThrow(name, validate(parsed))
}

export function canonicalJson(value: unknown): string {
  const sortKeys = (v: unknown): unknown => {
    if (Array.isArray(v)) return v.map(sortKeys)
    if (isObject(v)) {
      const out: Record<string, unknown> = {}
      for (const k of Object.keys(v).sort()) out[k] = sortKeys(v[k])
      return out
    }
    return v
  }
  return `${JSON.stringify(sortKeys(value), null, 2)}\n`
}
