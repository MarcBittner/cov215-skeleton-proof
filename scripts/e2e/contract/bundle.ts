import {
  type KeyObject,
  constants,
  createCipheriv,
  createDecipheriv,
  createHash,
  createPrivateKey,
  createPublicKey,
  privateDecrypt,
  publicEncrypt,
  randomBytes,
} from "node:crypto"
import { validateBundle, validateBundleEnvelope } from "./formats.js"
import type { Bundle, BundleEnvelope } from "./types.js"
import { canonicalJson, orThrow } from "./validate.js"

export const BUNDLE_FORMAT = "cov215-e2e-bundle"
export const BUNDLE_ALG = "RSA-OAEP-256+A256GCM"
export const MIN_RSA_BITS = 2048

function publicKeyOf(key: string | KeyObject): KeyObject {
  const k = typeof key === "string" ? createPublicKey(key) : key.type === "private" ? createPublicKey(key) : key
  if (k.asymmetricKeyType !== "rsa") throw new Error("bundle key must be RSA")
  const bits = k.asymmetricKeyDetails?.modulusLength ?? 0
  if (bits < MIN_RSA_BITS) throw new Error(`bundle key must be at least ${MIN_RSA_BITS} bits, got ${bits}`)
  return k
}

export function keyIdOf(key: string | KeyObject): string {
  const der = publicKeyOf(key).export({ type: "spki", format: "der" })
  return createHash("sha256").update(der).digest("hex")
}

function additionalData(h: { setup_run_id: string; run_key: string; sha: string }): Buffer {
  return Buffer.from(`${BUNDLE_FORMAT}/1|${h.setup_run_id}|${h.run_key}|${h.sha}`, "utf8")
}

export function sealBundle(bundle: Bundle, recipientPublicKey: string | KeyObject): BundleEnvelope {
  orThrow("bundle", validateBundle(bundle))
  const pub = publicKeyOf(recipientPublicKey)
  const key = randomBytes(32)
  const iv = randomBytes(12)
  const header = { setup_run_id: bundle.setup_run_id, run_key: bundle.run_key, sha: bundle.sha }
  const cipher = createCipheriv("aes-256-gcm", key, iv)
  cipher.setAAD(additionalData(header))
  const ciphertext = Buffer.concat([cipher.update(canonicalJson(bundle), "utf8"), cipher.final()])
  const wrapped = publicEncrypt({ key: pub, padding: constants.RSA_PKCS1_OAEP_PADDING, oaepHash: "sha256" }, key)
  return {
    format: BUNDLE_FORMAT,
    version: 1,
    alg: BUNDLE_ALG,
    key_id: keyIdOf(pub),
    ...header,
    wrapped_key: wrapped.toString("base64"),
    iv: iv.toString("base64"),
    tag: cipher.getAuthTag().toString("base64"),
    ciphertext: ciphertext.toString("base64"),
  }
}

export type OpenExpectations = { sha: string; setup_run_id: string; run_key: string }

export function openBundle(envelope: unknown, privateKey: string | KeyObject, expect: OpenExpectations): Bundle {
  for (const field of ["sha", "setup_run_id", "run_key"] as const) {
    const want = (expect as Partial<OpenExpectations> | undefined)?.[field]
    if (typeof want !== "string" || want.length === 0) throw new Error(`openBundle needs the expected ${field}`)
  }
  const env = orThrow("bundle envelope", validateBundleEnvelope(envelope))
  for (const field of ["sha", "setup_run_id", "run_key"] as const) {
    const want = expect[field]
    if (env[field] !== want) {
      throw new Error(`bundle ${field} ${env[field]} does not match expected ${want}`)
    }
  }
  const priv = typeof privateKey === "string" ? createPrivateKey(privateKey) : privateKey
  if (keyIdOf(priv) !== env.key_id) throw new Error("bundle was encrypted to a different key")
  let plaintext: string
  try {
    const key = privateDecrypt(
      { key: priv, padding: constants.RSA_PKCS1_OAEP_PADDING, oaepHash: "sha256" },
      Buffer.from(env.wrapped_key, "base64"),
    )
    const decipher = createDecipheriv("aes-256-gcm", key, Buffer.from(env.iv, "base64"))
    decipher.setAAD(additionalData(env))
    decipher.setAuthTag(Buffer.from(env.tag, "base64"))
    plaintext = Buffer.concat([decipher.update(Buffer.from(env.ciphertext, "base64")), decipher.final()]).toString("utf8")
  } catch {
    throw new Error("bundle does not decrypt")
  }
  const bundle = orThrow("bundle", validateBundle(JSON.parse(plaintext)))
  for (const field of ["sha", "setup_run_id", "run_key"] as const) {
    if (bundle[field] !== env[field]) throw new Error(`bundle ${field} differs from its envelope`)
  }
  return bundle
}

export function ticketsOf(bundle: Bundle): string[] {
  return Object.values(bundle.tickets).flatMap((byUser) => Object.values(byUser))
}
