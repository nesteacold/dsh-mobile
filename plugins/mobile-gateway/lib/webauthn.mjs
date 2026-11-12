/**
 * Spec 021 (contract revision 14): WebAuthn verification with `node:crypto` only.
 *
 * This module is the pure part of the web passkey unlock: base64url, the CBOR subset a
 * `attestationObject` uses, COSE → `KeyObject` for ES256 (P-256) and RS256, and the two
 * verification routines the gateway calls. Nothing here touches a socket, a store or a
 * clock, so every rule can be checked with a crafted input in a unit test.
 *
 * The rules are the spec's, in the order the spec states them (contract §14.1):
 *   registration  fmt `none`, attStmt empty, `webauthn.create`, challenge exact,
 *                 origin exact, rpIdHash = SHA-256(rp id), UP+UV, ES256 or RS256 only;
 *   assertion     `webauthn.get`, challenge exact, origin exact, rpIdHash, UP+UV,
 *                 signature over `authData || SHA-256(clientDataJSON)` with the stored key,
 *                 signCount monotonic when both counters are non-zero.
 *
 * A refusal is a typed Error with `code` `passkey/verification-failed` (the wire code) —
 * never a reason about which check failed, and never the offending value.
 */
import crypto from 'node:crypto'
import { CborDecodeError, CborMap, decodeCbor as decodeCborBytes } from './cbor.mjs'

/** The only attestation format accepted (no attestation trust is needed: the device is paired). */
export const ATTESTATION_FORMAT_NONE = 'none'

/** COSE algorithm identifiers the gateway accepts (ES256, RS256). */
export const COSE_ALGORITHM_ES256 = -7
export const COSE_ALGORITHM_RS256 = -257

/** Client data types of the two ceremonies. */
const CLIENT_DATA_TYPE_CREATE = 'webauthn.create'
const CLIENT_DATA_TYPE_GET = 'webauthn.get'

/** Authenticator data flags (WebAuthn §6.1: UP = 0x01, UV = 0x04, AT = 0x40). */
const FLAG_USER_PRESENT = 0x01
const FLAG_USER_VERIFIED = 0x04
const FLAG_ATTESTED_CREDENTIAL = 0x40

/** `authData` fixed prefix: rpIdHash (32) + flags (1) + signCount (4). */
const AUTH_DATA_PREFIX_BYTES = 37
/**
 * Attested credential data (WebAuthn §6.5.2): AAGUID (16) + credentialIdLength (2) + id + COSE key.
 * The AAGUID is part of the layout that the browsers and authenticators actually send; skipping
 * it is what makes the credential id and the key be read at the right offsets.
 */
const AAGUID_BYTES = 16
const CREDENTIAL_ID_LENGTH_BYTES = 2

/** Longest base64url text the gateway will decode for one field (1 MiB decoded). */
const MAX_B64URL_CHARS = 1_400_000

/**
 * A verification failure. `code` is the contract's wire code; the message is fixed text so an
 * error object can never carry the field, the challenge or the signature that failed.
 */
export class PasskeyVerificationError extends Error {
  constructor() {
    super('the passkey proof did not verify')
    this.name = 'PasskeyVerificationError'
    this.code = 'passkey/verification-failed'
  }
}

const fail = () => { throw new PasskeyVerificationError() }

/**
 * The shared CBOR subset decoder, with its refusal turned into this module's one refusal: an
 * unsupported document and a wrong signature look the same on the wire (§14.4).
 * @param {Buffer} bytes
 */
function decodeCborOrFail(bytes) {
  try {
    return decodeCborBytes(bytes)
  } catch (error) {
    if (error instanceof CborDecodeError) fail()
    throw error
  }
}

/**
 * Decode one CBOR document for tests and diagnostics (a top-level map, byte strings as
 * `Buffer`s). An unsupported document throws, never a crash. Nothing derived from it is sent
 * to a device.
 * @param {Buffer} bytes
 */
export function decodeCbor(bytes) {
  return decodeCborOrFail(bytes)
}

/**
 * Decode unpadded base64url text to bytes. Strict: the canonical alphabet only, no padding,
 * and anything that is not a string fails (a frame field is never coerced).
 * @param {unknown} value
 * @returns {Buffer}
 */
export function decodeBase64url(value) {
  if (typeof value !== 'string' || value.length === 0 || value.length > MAX_B64URL_CHARS) fail()
  if (!/^[A-Za-z0-9_-]+$/.test(value)) fail()
  const bytes = Buffer.from(value, 'base64url')
  // Round trip: rejects text that decodes "successfully" after dropping characters.
  if (bytes.length === 0 || bytes.toString('base64url') !== value) fail()
  return bytes
}

/** Encode bytes as unpadded base64url (the only binary encoding on this wire). */
export function encodeBase64url(bytes) {
  return Buffer.from(bytes).toString('base64url')
}

/**
 * The hostname of one exact origin string, or `undefined` when it is not a plain
 * `scheme://host[:port]` origin. `rp.id` is the hostname, and the browser can only assert
 * with that id, so the origin the client data names must parse to one.
 * @param {string} origin
 */
export function originHostname(origin) {
  if (typeof origin !== 'string' || origin === '') return undefined
  try {
    const url = new URL(origin)
    if (url.username !== '' || url.password !== '') return undefined
    if (url.pathname !== '/' || url.search !== '' || url.hash !== '') return undefined
    return url.hostname || undefined
  } catch {
    return undefined
  }
}


// ---------------------------------------------------------------------------
// COSE public key → node:crypto KeyObject
// ---------------------------------------------------------------------------

/** COSE key-parameter labels (RFC 9052 §7.1 / RFC 9053). */
const COSE_KTY = 1
const COSE_ALG = 3
const COSE_CRV = -1
const COSE_X = -2
const COSE_Y = -3
const COSE_N = -1
const COSE_E = -2
const KTY_EC2 = 2
const KTY_RSA = 3

/**
 * One COSE integer parameter (the RSA modulus and exponent) as big-endian bytes. A huge
 * parameter cannot be expressed as a JS integer, so it arrives as a byte string.
 */
function uintBytes(value, expectedLength) {
  const bytes = Buffer.isBuffer(value) ? value : (Number.isSafeInteger(value) && value >= 0 ? uintToBytes(value) : null)
  if (bytes === null || bytes.length > expectedLength) fail()
  return bytes
}

/** A non-negative safe integer as big-endian bytes (at least one byte). */
function uintToBytes(value) {
  const hex = value.toString(16)
  return Buffer.from(hex.padStart(((hex.length + 1) >> 1) * 2, '0'), 'hex')
}

/**
 * The stored COSE public key (base64url) → `{ algorithm, key }`.
 *
 * Only the two contracted algorithms are accepted: ES256 (P-256, exactly 32-byte X and Y)
 * and RS256 (a modulus of at least 2048 bits and an odd exponent). A key whose COSE `alg`
 * disagrees with its actual key type is refused, so the signature algorithm is always the
 * one the key can actually produce.
 * @param {string} coseBase64url
 * @returns {{ algorithm: number, key: crypto.KeyObject }}
 */
export function coseToKeyObject(coseBase64url) {
  const cose = decodeCborOrFail(decodeBase64url(coseBase64url))
  const kty = cose.get(COSE_KTY)
  const alg = cose.get(COSE_ALG)
  if (kty === KTY_EC2) {
    if (alg !== COSE_ALGORITHM_ES256) fail()
    // COSE curve identifier 1 is P-256 (P-256, not P-384/P-521 and not a cofactor curve).
    if (cose.get(COSE_CRV) !== 1) fail()
    const x = cose.get(COSE_X)
    const y = cose.get(COSE_Y)
    if (!Buffer.isBuffer(x) || x.length !== 32 || !Buffer.isBuffer(y) || y.length !== 32) fail()
    try {
      const key = crypto.createPublicKey({ key: { kty: 'EC', crv: 'P-256', x: encodeBase64url(x), y: encodeBase64url(y) }, format: 'jwk' })
      return { algorithm: COSE_ALGORITHM_ES256, key }
    } catch {
      // A point that is not on the curve (or at infinity) cannot be a key.
      fail()
    }
  }
  if (kty === KTY_RSA) {
    if (alg !== COSE_ALGORITHM_RS256) fail()
    const n = cose.get(COSE_N)
    const e = cose.get(COSE_E)
    const modulus = uintBytes(n, 512)
    const exponent = uintBytes(e, 8)
    if (modulus.length < 256) fail() // ≥ 2048 bits
    if (exponent.length === 0 || (exponent[exponent.length - 1] & 1) === 0) fail()
    try {
      const key = crypto.createPublicKey({
        key: { kty: 'RSA', n: encodeBase64url(modulus), e: encodeBase64url(exponent) },
        format: 'jwk',
      })
      return { algorithm: COSE_ALGORITHM_RS256, key }
    } catch {
      fail()
    }
  }
  fail()
}

// ---------------------------------------------------------------------------
// clientDataJSON and authData
// ---------------------------------------------------------------------------

/**
 * Parse `clientDataJSON`: a JSON object whose `type`, `challenge` and `origin` are strings.
 * Anything else — a truncated document, a nested value, a wrong type — fails.
 * @param {Buffer} bytes
 */
export function parseClientData(bytes) {
  if (!Buffer.isBuffer(bytes) || bytes.length === 0 || bytes.length > 16384) fail()
  let parsed
  try {
    parsed = JSON.parse(bytes.toString('utf8'))
  } catch {
    fail()
  }
  if (parsed === null || typeof parsed !== 'object' || Array.isArray(parsed)) fail()
  const { type, challenge, origin } = parsed
  if (typeof type !== 'string' || typeof challenge !== 'string' || typeof origin !== 'string') fail()
  return { type, challenge, origin }
}

/** Flags and counter of `authData`, plus the attested credential when present. */
function parseAuthData(authData) {
  if (!Buffer.isBuffer(authData) || authData.length < AUTH_DATA_PREFIX_BYTES) fail()
  const rpIdHash = authData.subarray(0, 32)
  const flags = authData[32]
  const signCount = authData.readUInt32BE(33)
  let offset = AUTH_DATA_PREFIX_BYTES
  let credentialId
  let credentialPublicKey
  if ((flags & FLAG_ATTESTED_CREDENTIAL) !== 0) {
    // Attested credential data: AAGUID (16) THEN credentialIdLength, then the id, then the key.
    if (authData.length < offset + AAGUID_BYTES + CREDENTIAL_ID_LENGTH_BYTES) fail()
    offset += AAGUID_BYTES
    const idLength = authData.readUInt16BE(offset)
    offset += CREDENTIAL_ID_LENGTH_BYTES
    if (idLength === 0 || authData.length < offset + idLength + 3) fail()
    credentialId = authData.subarray(offset, offset + idLength)
    offset += idLength
    // The credential public key is the remainder of the attested credential data (WebAuthn
    // §6.5.2: COSE key, then nothing else), so a key is at least three bytes.
    credentialPublicKey = authData.subarray(offset)
  }
  return {
    rpIdHash,
    flags,
    signCount,
    credentialId,
    credentialPublicKey,
  }
}

/** `SHA-256(rpId)` as a Buffer. `rpId` here is a hostname (a non-ASCII one is refused). */
function rpIdHashOf(rpId) {
  if (typeof rpId !== 'string' || rpId === '') fail()
  return crypto.createHash('sha256').update(rpId, 'utf8').digest()
}

/** The challenge and origin tests both ceremonies share. */
function assertClientData(clientData, { expectedType, challenge, origin, rpId }) {
  if (clientData.type !== expectedType) fail()
  // Exact string equality with the live challenge: no prefix, no trim, no case fold.
  if (clientData.challenge !== challenge) fail()
  if (clientData.origin !== origin) fail()
  const originRpId = originHostname(origin)
  if (originRpId === undefined || originRpId !== rpId) fail()
}

/** UP and UV must both be set (the spec requires a user-verifying authenticator). */
function assertUserFlag(flags) {
  if ((flags & FLAG_USER_PRESENT) === 0 || (flags & FLAG_USER_VERIFIED) === 0) fail()
}

// ---------------------------------------------------------------------------
// Registration and assertion
// ---------------------------------------------------------------------------

/**
 * Split an `attestationObject` into its format, its empty attStmt and the raw authData.
 * @param {Buffer} bytes
 * @returns {{ format: string, authData: Buffer }}
 */
export function parseAttestationObject(bytes) {
  if (typeof bytes === 'string') bytes = decodeBase64url(bytes)
  const document = decodeCborOrFail(bytes)
  const format = document.get('fmt')
  const attStmt = document.get('attStmt')
  const authData = document.get('authData')
  if (format !== ATTESTATION_FORMAT_NONE) fail()
  // `none` carries no statement; anything inside it is an unexpected claim.
  if (!(attStmt instanceof CborMap) || attStmt.size !== 0) fail()
  if (!Buffer.isBuffer(authData)) fail()
  return { format, authData }
}

/**
 * Verify one registration.
 *
 * @param {object} input
 * @param {{ clientDataJSON: string, attestationObject: string, rawId: string, id: string }} input.attestation
 * @param {string} input.challenge live challenge of this socket (base64url)
 * @param {string} input.origin the socket's exact `Origin`
 * @param {string} input.rpId the RP id the gateway offered (hostname)
 * @returns {{ credentialId: string, publicKey: string, signCount: number }}
 * @throws {PasskeyVerificationError}
 */
export function verifyRegistration({ attestation, challenge, origin, rpId }) {
  if (attestation === null || typeof attestation !== 'object') fail()
  const { id, rawId, clientDataJSON, attestationObject } = attestation
  if (typeof id !== 'string' || typeof rawId !== 'string') fail()
  // The browser sets `id` = base64url(rawId); a mismatch means a re-marshalled credential id.
  if (id !== rawId) fail()
  const attestationBytes = decodeBase64url(attestationObject)
  const clientDataBytes = decodeBase64url(clientDataJSON)
  const { authData } = parseAttestationObject(attestationBytes)
  const clientData = parseClientData(clientDataBytes)
  assertClientData(clientData, { expectedType: CLIENT_DATA_TYPE_CREATE, challenge, origin, rpId })
  const parsed = parseAuthData(authData)
  if (parsed.credentialId === undefined || parsed.credentialPublicKey === undefined) fail()
  // The credential id the client claims must be the one the authenticator generated.
  const rawIdBytes = decodeBase64url(rawId)
  if (!parsed.credentialId.equals(rawIdBytes)) fail()
  if (!parsed.rpIdHash.equals(rpIdHashOf(rpId))) fail()
  assertUserFlag(parsed.flags)
  // The key is validated here (ES256 or RS256), so a stored key is always verifiable.
  coseToKeyObject(encodeBase64url(parsed.credentialPublicKey))
  return {
    credentialId: encodeBase64url(parsed.credentialId),
    publicKey: encodeBase64url(parsed.credentialPublicKey),
    signCount: parsed.signCount,
  }
}

/**
 * Verify one assertion against the device's stored passkey.
 *
 * @param {object} input
 * @param {{ id: string, rawId: string, clientDataJSON: string, authenticatorData: string, signature: string }} input.assertion
 * @param {{ credentialId: string, publicKey: string, signCount: number }} input.stored
 * @param {string} input.challenge
 * @param {string} input.origin
 * @param {string} input.rpId
 * @returns {{ signCount: number }} the counter to store (the previous one when both are zero)
 * @throws {PasskeyVerificationError}
 */
export function verifyAssertion({ assertion, stored, challenge, origin, rpId }) {
  if (assertion === null || typeof assertion !== 'object' || stored === null || typeof stored !== 'object') fail()
  const { id, rawId, clientDataJSON, authenticatorData, signature } = assertion
  if (typeof id !== 'string' || typeof rawId !== 'string') fail()
  if (id !== rawId) fail()
  // The assertion must be for THIS device's credential, never another device's.
  if (typeof stored.credentialId !== 'string' || id !== stored.credentialId) fail()
  if (decodeBase64url(rawId).toString('base64url') !== stored.credentialId) fail()
  const clientDataBytes = decodeBase64url(clientDataJSON)
  const authDataBytes = decodeBase64url(authenticatorData)
  const signatureBytes = decodeBase64url(signature)
  const clientData = parseClientData(clientDataBytes)
  assertClientData(clientData, { expectedType: CLIENT_DATA_TYPE_GET, challenge, origin, rpId })
  const parsed = parseAuthData(authDataBytes)
  // An assertion carries no attested credential, so AT must be clear.
  if ((parsed.flags & FLAG_ATTESTED_CREDENTIAL) !== 0) fail()
  if (!parsed.rpIdHash.equals(rpIdHashOf(rpId))) fail()
  assertUserFlag(parsed.flags)
  const { algorithm, key } = coseToKeyObject(stored.publicKey)
  const clientDataHash = crypto.createHash('sha256').update(clientDataBytes).digest()
  const signedData = Buffer.concat([authDataBytes, clientDataHash])
  const verified = algorithm === COSE_ALGORITHM_ES256
    ? crypto.verify('sha256', signedData, { key, dsaEncoding: 'der' }, signatureBytes)
    : crypto.verify('sha256', signedData, key, signatureBytes)
  if (!verified) fail()
  // Monotonic when both counters are non-zero; a stored 0 (or a presented 0) means the
  // authenticator does not count, so there is nothing to compare.
  const previous = Number.isSafeInteger(stored.signCount) ? stored.signCount : 0
  if (previous !== 0 && parsed.signCount !== 0 && parsed.signCount <= previous) fail()
  return { signCount: parsed.signCount !== 0 ? parsed.signCount : previous }
}
