/**
 * Spec 026 R4 — Web Push message encryption, RFC 8291, on `node:crypto` only.
 *
 * The message is `aes128gcm` content-coded (that IS RFC 8291: RFC 8188's `aes128gcm` restricted to
 * a 16-byte tag, a 2-byte pad delimiter and a 4096-byte record size). The wire body is:
 *
 *   salt(16) | rs(4, big endian) | idlen(1) | keyid(idlen) | ciphertext
 *
 * `keyid` is the sender's ephemeral P-256 public key (65 bytes). The two secrets come from ECDH
 * between that ephemeral key and the subscription's `p256dh` point, salted with the subscription's
 * `auth` secret by HKDF-SHA256 (RFC 5869):
 *
 *   ecdh_secret          = ECDH(as_private, ua_public)
 *   IKM                  = HKDF(auth_secret, ecdh_secret, "WebPush: info\0" || ua_public || as_public, 32)
 *   PRK                  = HKDF-Extract(salt, IKM)
 *   CEK                  = HKDF-Expand(PRK, "Content-Encoding: aes128gcm\0", 16)
 *   NONCE                = HKDF-Expand(PRK, "Content-Encoding: nonce\0", 12)
 *
 * so the subscription's own key material is what a device needs to read the message — which is
 * exactly what the gateway's round-trip test proves by decrypting with the subscription keys.
 */
import crypto from 'node:crypto'

/** Content coding of the body (RFC 8188 / RFC 8291). */
export const CONTENT_ENCODING = 'aes128gcm'

/** The record size RFC 8291 §4 pins for web push; a body is never split in practice. */
export const RECORD_SIZE = 4096

const TAG_BYTES = 16
const SALT_BYTES = 16
const NONCE_BYTES = 12
const CEK_BYTES = 16

const hmac = (key, data) => crypto.createHmac('sha256', key).update(data).digest()

/**
 * HKDF-Extract (RFC 5869 §2.2): one HMAC over the input keying material, keyed by the salt.
 * @returns {Buffer} a 32-byte pseudorandom key
 */
export function hkdfExtract(salt, ikm) {
  return hmac(salt, ikm)
}

/**
 * HKDF-Expand (RFC 5869 §2.3) for a single 32-byte-or-shorter block, which is all RFC 8291
 * needs (16-byte CEK, 12-byte nonce).
 *
 * @param {Buffer} prk pseudorandom key from {@link hkdfExtract}
 * @param {Buffer|string} info the `Content-Encoding: …` label
 * @param {number} length bytes wanted, `1..32`
 * @returns {Buffer}
 */
export function hkdfExpand(prk, info, length) {
  if (!Number.isSafeInteger(length) || length < 1 || length > 32) throw new Error('HKDF-Expand here supports 1..32 bytes')
  return hmac(prk, Buffer.concat([Buffer.from(info, 'utf8'), Buffer.from([0x01])])).subarray(0, length)
}

/**
 * The uncompressed point of a P-256 public key as the wire wants it: `04 || X || Y`, 65 bytes.
 *
 * @param {crypto.KeyObject} key
 * @returns {Buffer}
 */
export function uncompressedPoint(key) {
  const jwk = key.export({ format: 'jwk' })
  if (typeof jwk.x !== 'string' || typeof jwk.y !== 'string') throw new Error('not a P-256 public key')
  return Buffer.concat([Buffer.from([0x04]), Buffer.from(jwk.x, 'base64url'), Buffer.from(jwk.y, 'base64url')])
}

/**
 * A P-256 public key from its uncompressed point.
 *
 * @param {Buffer} point 65 bytes, `04 || X || Y`
 * @returns {crypto.KeyObject}
 */
export function publicKeyFromPoint(point) {
  const bytes = Buffer.from(point)
  if (bytes.length !== 65 || bytes[0] !== 0x04) throw new Error('an uncompressed P-256 point is 65 bytes starting with 0x04')
  return crypto.createPublicKey({
    format: 'jwk',
    key: { kty: 'EC', crv: 'P-256', x: bytes.subarray(1, 33).toString('base64url'), y: bytes.subarray(33, 65).toString('base64url') },
  })
}

/**
 * Derive the CEK and nonce of one message (RFC 8291 §3.3–3.4).
 *
 * Exported because the round-trip test derives the SAME pair from the receiver's side, which is
 * the only way to prove the body really decrypts with the subscription keys.
 *
 * @param {object} options
 * @param {Buffer} options.salt the 16-byte salt carried in the body
 * @param {Buffer} options.authSecret the subscription's 16-byte `auth` secret
 * @param {Buffer} options.receiverPoint the subscription's `p256dh` point (65 bytes)
 * @param {Buffer} options.senderPoint the ephemeral sender point (65 bytes)
 * @param {Buffer} options.ecdhSecret the raw ECDH result
 * @returns {{ cek: Buffer, nonce: Buffer }}
 */
export function deriveKeyMaterial({ salt, authSecret, receiverPoint, senderPoint, ecdhSecret }) {
  // "WebPush: info" || 0x00 || ua_public || as_public — the binding that stops a different
  // subscription (or a replayed body) from deriving the same key.
  const keyInfo = Buffer.concat([Buffer.from('WebPush: info\0', 'utf8'), receiverPoint, senderPoint])
  const ikm = hkdfExpand(hkdfExtract(authSecret, ecdhSecret), keyInfo, 32)
  const prk = hkdfExtract(salt, ikm)
  return {
    cek: hkdfExpand(prk, 'Content-Encoding: aes128gcm\0', CEK_BYTES),
    nonce: hkdfExpand(prk, 'Content-Encoding: nonce\0', NONCE_BYTES),
  }
}

/**
 * Encrypt one web push body (RFC 8291).
 *
 * @param {object} options
 * @param {string} options.payload the UTF-8 plaintext (the JSON of `{v,kind,sessionId,…}`)
 * @param {string} options.p256dh the subscription's public key, unpadded base64url (65 bytes)
 * @param {string} options.auth the subscription's auth secret, unpadded base64url (16 bytes)
 * @returns {Buffer} the complete `aes128gcm` body, ready to POST
 */
export function encryptPayload(options) {
  const receiverPoint = Buffer.from(String(options.p256dh), 'base64url')
  const authSecret = Buffer.from(String(options.auth), 'base64url')
  if (receiverPoint.length !== 65) throw new Error('p256dh must be a 65-byte uncompressed P-256 point')
  if (authSecret.length !== 16) throw new Error('auth must be a 16-byte secret')

  // A fresh ephemeral key and salt per message: reusing either would let one body be read twice.
  const ephemeral = crypto.generateKeyPairSync('ec', { namedCurve: 'P-256' })
  const senderPoint = uncompressedPoint(ephemeral.publicKey)
  const salt = crypto.randomBytes(SALT_BYTES)
  const ecdhSecret = crypto.diffieHellman({ privateKey: ephemeral.privateKey, publicKey: publicKeyFromPoint(receiverPoint) })
  const { cek, nonce } = deriveKeyMaterial({ salt, authSecret, receiverPoint, senderPoint, ecdhSecret })

  const cipher = crypto.createCipheriv('aes-128-gcm', cek, nonce)
  const plaintext = Buffer.isBuffer(options.payload) ? options.payload : Buffer.from(String(options.payload), 'utf8')
  // RFC 8188 §2: the sample is `plaintext || 0x02` for the last (here: only) record, so the
  // receiver learns where the padding delimiter is.
  const record = Buffer.concat([plaintext, Buffer.from([0x02])])
  const ciphertext = Buffer.concat([cipher.update(record), cipher.final(), cipher.getAuthTag()])
  if (ciphertext.length !== record.length + TAG_BYTES) throw new Error('unexpected aes128gcm output length')

  const header = Buffer.alloc(SALT_BYTES + 4 + 1)
  salt.copy(header, 0)
  header.writeUInt32BE(RECORD_SIZE, SALT_BYTES)
  header.writeUInt8(senderPoint.length, SALT_BYTES + 4)
  return Buffer.concat([header, senderPoint, ciphertext])
}

/**
 * Decrypt one `aes128gcm` body with the receiver's private key and subscription secret.
 *
 * This is the receiver half of RFC 8291 and exists so the gateway's own test can prove that what
 * it sends is what a real subscription would read. It is NOT part of the delivery path — the
 * Host never holds a subscriber's private key.
 *
 * @param {object} options
 * @param {Buffer} options.body the complete body
 * @param {crypto.KeyObject} options.privateKey the receiver's ephemeral/subscription private key
 * @param {string} options.auth the subscription's auth secret (unpadded base64url)
 * @returns {Buffer} the plaintext
 */
export function decryptPayload({ body, privateKey, auth }) {
  const bytes = Buffer.from(body)
  if (bytes.length < SALT_BYTES + 4 + 1 + 65 + TAG_BYTES) throw new Error('body is too short to be aes128gcm')
  const salt = bytes.subarray(0, SALT_BYTES)
  const recordSize = bytes.readUInt32BE(SALT_BYTES)
  if (recordSize !== RECORD_SIZE) throw new Error(`unexpected record size ${recordSize}`)
  const idLength = bytes.readUInt8(SALT_BYTES + 4)
  if (idLength !== 65) throw new Error(`unexpected keyid length ${idLength}`)
  const senderPoint = bytes.subarray(SALT_BYTES + 5, SALT_BYTES + 5 + 65)
  const ciphertext = bytes.subarray(SALT_BYTES + 5 + 65)
  if (ciphertext.length <= TAG_BYTES) throw new Error('body carries no ciphertext')

  const receiverPoint = uncompressedPoint(crypto.createPublicKey(privateKey))
  const authSecret = Buffer.from(String(auth), 'base64url')
  const ecdhSecret = crypto.diffieHellman({ privateKey, publicKey: publicKeyFromPoint(senderPoint) })
  const { cek, nonce } = deriveKeyMaterial({ salt, authSecret, receiverPoint, senderPoint, ecdhSecret })

  const decipher = crypto.createDecipheriv('aes-128-gcm', cek, nonce)
  decipher.setAuthTag(ciphertext.subarray(ciphertext.length - TAG_BYTES))
  const record = Buffer.concat([
    decipher.update(ciphertext.subarray(0, ciphertext.length - TAG_BYTES)),
    decipher.final(),
  ])
  // Strip the trailing padding: everything after the last 0x02 delimiter is padding.
  let delimiter = record.length - 1
  while (delimiter >= 0 && record[delimiter] === 0x00) delimiter -= 1
  if (delimiter < 0 || record[delimiter] !== 0x02) throw new Error('the record carries no padding delimiter')
  return record.subarray(0, delimiter)
}
