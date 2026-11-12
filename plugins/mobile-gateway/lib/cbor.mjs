/**
 * Spec 021: the CBOR subset WebAuthn uses (`attestationObject`, COSE public keys).
 *
 * A `attestationObject` and a COSE public key are maps whose values matter only for their types
 * (text/integer keys, byte strings, integers, nested maps/arrays). This decoder accepts exactly
 * those plus `true`/`false`, and refuses everything else (null, floats, tags, indefinite lengths,
 * duplicate keys, trailing bytes) by throwing {@link CborDecodeError}.
 *
 * Recursion is bounded by {@link MAX_CBOR_DEPTH} and every length is checked against the bytes
 * that remain, so a forged document fails as a plain "wrong shape" (an ordinary refusal), never
 * as a stack overflow or a long allocation.
 */

/** A decoded CBOR map (text/integer keys only); distinct from the arrays of CBOR major 4. */
export class CborMap extends Map {}

/** Deepest nesting accepted (a real attestation nests a map inside a map inside a map). */
export const MAX_CBOR_DEPTH = 16

/** Longest text/byte string accepted; nothing WebAuthn carries is larger. */
const MAX_STRING_BYTES = 1 << 20

/** The only refusal: fixed text, no offset and no offending value. */
export class CborDecodeError extends Error {
  constructor() {
    super('the CBOR document is not the supported subset')
    this.name = 'CborDecodeError'
    this.code = 'cbor/unsupported'
  }
}

const fail = () => { throw new CborDecodeError() }

/** Read `length` bytes as one big-endian unsigned integer. */
function readUint(view, length) {
  if (view.offset + length > view.bytes.length) fail()
  let value = 0
  for (let index = 0; index < length; index += 1) value = (value * 256) + view.bytes[view.offset + index]
  view.offset += length
  if (!Number.isSafeInteger(value)) fail()
  return value
}

/**
 * The value of an initial byte's length field. `additional` 24–27 carry the length in
 * 1/2/4/8 following bytes; 28–30 are reserved and 31 is the indefinite-length marker, refused.
 */
function readLength(view, additional) {
  if (additional < 24) return additional
  if (additional === 24) return readUint(view, 1)
  if (additional === 25) return readUint(view, 2)
  if (additional === 26) return readUint(view, 4)
  if (additional === 27) return readUint(view, 8)
  return fail()
}

/** Read one element at the view's cursor, `depth` maps/arrays deep. */
function readItem(view, depth) {
  if (depth > MAX_CBOR_DEPTH) fail()
  if (view.offset >= view.bytes.length) fail()
  const initial = view.bytes[view.offset]
  view.offset += 1
  const major = initial >> 5
  const additional = initial & 0x1f
  if (major === 7) {
    // Simple values: false (20), true (21); null and floats are refused.
    if (additional === 20) return false
    if (additional === 21) return true
    return fail()
  }
  // Tags (6) are refused: nothing WebAuthn needs is tagged.
  if (major === 6) fail()
  const length = readLength(view, additional)
  if (major === 0) return length
  if (major === 1) return -1 - length
  if (major === 2 || major === 3) {
    if (length > MAX_STRING_BYTES) fail()
    if (view.offset + length > view.bytes.length) fail()
    const slice = Buffer.from(view.bytes.subarray(view.offset, view.offset + length))
    view.offset += length
    if (major === 2) return slice
    // Text: valid UTF-8 only (a re-encode round trip is the cheap check).
    const text = slice.toString('utf8')
    if (Buffer.from(text, 'utf8').toString('hex') !== slice.toString('hex')) fail()
    return text
  }
  if (major === 4) {
    if (length > view.bytes.length) fail()
    const items = []
    for (let index = 0; index < length; index += 1) items.push(readItem(view, depth + 1))
    return items
  }
  if (major === 5) {
    if (length > view.bytes.length) fail()
    const map = new CborMap()
    for (let index = 0; index < length; index += 1) {
      const key = readItem(view, depth + 1)
      if (!(typeof key === 'string' || Number.isSafeInteger(key))) fail()
      if (map.has(key)) fail()
      map.set(key, readItem(view, depth + 1))
    }
    return map
  }
  return fail()
}

/**
 * Decode one CBOR document; a top-level map comes back as {@link CborMap}.
 * Byte strings stay `Buffer`s. Throws {@link CborDecodeError} on anything outside the subset.
 * @param {Buffer} bytes
 * @returns {CborMap}
 */
export function decodeCbor(bytes) {
  if (!Buffer.isBuffer(bytes) || bytes.length === 0) fail()
  const view = { bytes, offset: 0 }
  const value = readItem(view, 0)
  if (view.offset !== bytes.length) fail() // trailing bytes
  if (!(value instanceof CborMap)) fail()
  return value
}
