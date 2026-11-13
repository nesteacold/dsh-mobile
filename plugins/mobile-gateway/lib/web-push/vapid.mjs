/**
 * Spec 026 R4 — VAPID (RFC 8292) with `node:crypto` only.
 *
 * The application server identity is one P-256 key pair: the PUBLIC key travels to every device
 * in `hello.webPush.vapidPublicKey` (an uncompressed EC point, unpadded base64url), the PRIVATE
 * key never leaves this process and is never logged. Each request to a push service carries one
 * ES256 JWT:
 *
 *   header  { "typ": "JWT", "alg": "ES256" }
 *   claims  { "aud": "<origin of the endpoint>", "exp": <now + 12 h>, "sub": "mailto:<subject>" }
 *   token   base64url(header) "." base64url(claims) "." base64url(r || s)
 *
 * Two details the RFC pins and a naive `crypto.sign` gets wrong:
 *  - `aud` is the endpoint's ORIGIN (`https://fcm.googleapis.com`), never the full URL;
 *  - an ES256 JWT signature is the raw 64-byte `r || s` concatenation, NOT the DER sequence
 *    `crypto.sign` returns, so it is re-encoded field by field.
 */
import crypto from 'node:crypto'

/** Lifetime of a VAPID JWT (RFC 8292 §2 allows at most 24 h; 12 h leaves room for clock skew). */
export const VAPID_TOKEN_TTL_SECONDS = 12 * 60 * 60

/** The `sub` claim: a contact for the push service operator. Fixed, never user-supplied. */
export const VAPID_SUBJECT = 'mailto:web-push@dsh.invalid'

const b64url = (value) => Buffer.from(value).toString('base64url')

/**
 * Generate the VAPID key pair (first enable only).
 *
 * @returns {{ publicKey: string, privateKeyPem: string }} `publicKey` is an unpadded base64url
 *   uncompressed P-256 point (65 bytes); `privateKeyPem` is the PKCS#8 PEM that is stored.
 */
export function generateVapidKeys() {
  const { publicKey, privateKey } = crypto.generateKeyPairSync('ec', { namedCurve: 'P-256' })
  return {
    publicKey: exportPublicKey(publicKey),
    privateKeyPem: privateKey.export({ format: 'pem', type: 'pkcs8' }).toString(),
  }
}

/**
 * The uncompressed point of a P-256 public key, as the wire wants it: `04 || X || Y`, 65 bytes,
 * unpadded base64url.
 *
 * @param {crypto.KeyObject} key
 * @returns {string}
 */
export function exportPublicKey(key) {
  const jwk = key.export({ format: 'jwk' })
  if (typeof jwk.x !== 'string' || typeof jwk.y !== 'string') throw new Error('the VAPID public key is not a P-256 point')
  const point = Buffer.concat([Buffer.from([0x04]), Buffer.from(jwk.x, 'base64url'), Buffer.from(jwk.y, 'base64url')])
  if (point.length !== 65) throw new Error('the VAPID public key is not 65 bytes')
  return point.toString('base64url')
}

/**
 * Rebuild the public key from its wire form. Used to prove at load time that a stored private
 * key and the advertised public key are the same pair — a mismatch would make every push
 * undecryptable while looking healthy.
 *
 * @param {string} publicKey unpadded base64url, 65 bytes
 * @returns {crypto.KeyObject}
 */
export function importPublicKey(publicKey) {
  const point = Buffer.from(String(publicKey), 'base64url')
  if (point.length !== 65 || point[0] !== 0x04) throw new Error('the VAPID public key must be a 65-byte uncompressed point')
  return crypto.createPublicKey({
    format: 'jwk',
    key: {
      kty: 'EC', crv: 'P-256',
      x: point.subarray(1, 33).toString('base64url'),
      y: point.subarray(33, 65).toString('base64url'),
    },
  })
}

/**
 * The public key of a stored private key, in the same wire form {@link exportPublicKey} returns.
 *
 * @param {string} privateKeyPem
 * @returns {string}
 */
export function publicKeyOf(privateKeyPem) {
  return exportPublicKey(crypto.createPublicKey(crypto.createPrivateKey(privateKeyPem)))
}

/**
 * DER `SEQUENCE { INTEGER r, INTEGER s }` → the 64-byte `r || s` an ES256 JWT carries.
 *
 * @param {Buffer} der
 * @returns {Buffer}
 */
export function derToJoseSignature(der) {
  // A P-256 signature is short and fixed in shape: SEQUENCE, two INTEGERs, at most 33 bytes each.
  if (der.length < 8 || der[0] !== 0x30) throw new Error('not a DER signature')
  const sequenceLength = der[1]
  if (sequenceLength !== der.length - 2) throw new Error('a DER signature must fill its sequence')
  if (der[2] !== 0x02) throw new Error('a DER signature must start with an INTEGER')
  const rLength = der[3]
  const r = der.subarray(4, 4 + rLength)
  const sType = 4 + rLength
  if (der[sType] !== 0x02) throw new Error('a DER signature must carry two INTEGERs')
  const sLength = der[sType + 1]
  const s = der.subarray(sType + 2, sType + 2 + sLength)
  if (sType + 2 + sLength !== der.length) throw new Error('a DER signature must not carry trailing bytes')
  // DER INTEGERs are minimal and signed: a leading 0x00 pads a high bit, and anything longer than
  // 32 significant bytes is not a P-256 coordinate.
  const coordinate = (bytes) => {
    let index = 0
    while (index < bytes.length - 1 && bytes[index] === 0x00) index += 1
    const value = bytes.subarray(index)
    if (value.length > 32) throw new Error('a P-256 coordinate is at most 32 bytes')
    const out = Buffer.alloc(32)
    value.copy(out, 32 - value.length)
    return out
  }
  return Buffer.concat([coordinate(r), coordinate(s)])
}

/**
 * Build the `Authorization: vapid t=<jwt>, k=<public key>` value for one push service origin.
 *
 * @param {object} options
 * @param {string} options.privateKeyPem the VAPID private key (never logged)
 * @param {string} options.publicKey the matching wire-form public key
 * @param {string} options.audience the endpoint's ORIGIN, `https://host[:port]`
 * @param {number} [options.now] epoch seconds; injected by tests
 * @param {number} [options.ttlSeconds]
 * @param {string} [options.subject]
 * @returns {string}
 */
export function vapidAuthorization(options) {
  const now = Number.isFinite(options.now) ? options.now : Math.floor(Date.now() / 1000)
  const ttl = Number.isFinite(options.ttlSeconds) && options.ttlSeconds > 0 ? options.ttlSeconds : VAPID_TOKEN_TTL_SECONDS
  const header = b64url(JSON.stringify({ typ: 'JWT', alg: 'ES256' }))
  const claims = b64url(JSON.stringify({
    aud: options.audience,
    exp: now + ttl,
    // RFC 8292 §2.1: `sub` is a contact URI (`mailto:` or `https:`).
    sub: typeof options.subject === 'string' && options.subject !== '' ? options.subject : VAPID_SUBJECT,
  }))
  const unsigned = `${header}.${claims}`
  const der = crypto.sign('sha256', Buffer.from(unsigned, 'utf8'), crypto.createPrivateKey(options.privateKeyPem))
  return `vapid t=${unsigned}.${b64url(derToJoseSignature(der))}, k=${options.publicKey}`
}

/**
 * Verify a VAPID JWT the way a push service does: the ES256 signature over
 * `base64url(header) "." base64url(claims)` with the advertised key, `alg` exactly ES256.
 *
 * Exported for the gateway's own test suite (a local fake push service checks it) and for any
 * future self-check; nothing in the delivery path calls it.
 *
 * @param {string} token the compact JWT
 * @param {string} publicKey the sender's wire-form public key
 * @returns {{ ok: true, header: object, claims: object } | { ok: false, reason: string }}
 */
export function verifyVapidToken(token, publicKey) {
  if (typeof token !== 'string') return { ok: false, reason: 'missing-token' }
  const parts = token.split('.')
  if (parts.length !== 3) return { ok: false, reason: 'malformed-token' }
  let header, claims, signature
  try {
    header = JSON.parse(Buffer.from(parts[0], 'base64url').toString('utf8'))
    claims = JSON.parse(Buffer.from(parts[1], 'base64url').toString('utf8'))
    signature = Buffer.from(parts[2], 'base64url')
  } catch {
    return { ok: false, reason: 'malformed-token' }
  }
  // `alg: none` and the HMAC family are the two classic substitutions; only ES256 is accepted.
  if (!header || header.alg !== 'ES256') return { ok: false, reason: 'unsupported-alg' }
  if (signature.length !== 64) return { ok: false, reason: 'bad-signature-length' }
  // Back to DER for `crypto.verify` (the inverse of `derToJoseSignature`). A DER INTEGER is
  // signed and minimal: a leading 0x00 is required whenever the top bit of the value is set, or
  // the value would read as negative.
  const integer = (bytes) => {
    let index = 0
    while (index < bytes.length - 1 && bytes[index] === 0x00) index += 1
    const value = bytes.subarray(index)
    const body = value[0] & 0x80 ? Buffer.concat([Buffer.from([0x00]), value]) : value
    return Buffer.concat([Buffer.from([0x02, body.length]), body])
  }
  const r = integer(signature.subarray(0, 32))
  const s = integer(signature.subarray(32, 64))
  const der = Buffer.concat([Buffer.from([0x30, r.length + s.length]), r, s])
  let valid = false
  try {
    valid = crypto.verify('sha256', Buffer.from(`${parts[0]}.${parts[1]}`, 'utf8'), importPublicKey(publicKey), der)
  } catch {
    return { ok: false, reason: 'bad-public-key' }
  }
  if (!valid) return { ok: false, reason: 'bad-signature' }
  return { ok: true, header, claims }
}
