/**
 * Spec 026 R3/R5 — delivering one Web Push message, and the outbound boundary around it.
 *
 * Everything this module can do to the network is stated here, once:
 *  - the endpoint must pass {@link isWebPushEndpointAllowed} (https, a known push service, no
 *    credentials, no explicit port) — the SSRF guard — before a socket exists;
 *  - a redirect is a RESPONSE, never a hop: the status is reported to the caller and the new
 *    `Location` is never contacted, so an allowed host cannot bounce the Host somewhere else;
 *  - one request, one deadline ({@link WEB_PUSH_TIMEOUT_MS}); a socket that outlives it is
 *    destroyed, never left dangling;
 *  - `TTL: 600`, `Urgency: high` for the kinds that wait for a decision, and a body that is
 *    already encrypted per RFC 8291 (the push service can read nothing but the ciphertext).
 *
 * The transport is injectable ONLY so the test suite can point the same code at a local fake push
 * service; it is never wired from configuration (see `testWebPushTransport` in the gateway, which
 * is not part of `Config`).
 */
import crypto from 'node:crypto'
import https from 'node:https'

import {
  WEB_PUSH_HIGH_URGENCY_KINDS,
  WEB_PUSH_TIMEOUT_MS,
  WEB_PUSH_TTL_SECONDS,
  isWebPushEndpointAllowed,
} from '../vendor/mobile-protocol.mjs'
import { CONTENT_ENCODING, encryptPayload } from './encrypt.mjs'
import { vapidAuthorization } from './vapid.mjs'

/** Bound of the JSON body a push service receives. Ids only, so this is generous. */
export const WEB_PUSH_MAX_PAYLOAD_BYTES = 4 * 1024

/**
 * Why a message was not delivered. `gone` is the only one that means "drop the subscription":
 * the push service answered 404/410, which RFC 8030 §7.3 defines as permanent.
 *
 * @typedef {{ ok: true, status: number } | { ok: false, gone: boolean, reason: string, status?: number }} SendOutcome
 */

/**
 * The production transport: one HTTPS POST with no redirect following.
 *
 * @param {object} request
 * @param {string} request.url
 * @param {Record<string, string>} request.headers
 * @param {Buffer} request.body
 * @param {number} request.timeoutMs
 * @param {(address: string, options: object, callback: Function) => unknown} [request.lookup]
 * @returns {Promise<{ status: number }>}
 */
function httpsTransport({ url, headers, body, timeoutMs, lookup }) {
  return new Promise((resolve, reject) => {
    const target = new URL(url)
    let settled = false
    const settle = (fn, value) => {
      if (settled) return
      settled = true
      fn(value)
    }
    const req = https.request({
      method: 'POST',
      hostname: target.hostname,
      port: target.port === '' ? 443 : Number(target.port),
      path: `${target.pathname}${target.search}`,
      headers: { ...headers, 'Content-Length': String(body.length) },
      // node:https never follows redirects: a 3xx is returned as its status and treated as a
      // transient failure. Certificate verification is always on (no rejectUnauthorized/ca here).
      // `lookup` is an optional DNS resolver override; it does not change TLS verification.
      ...(lookup === undefined ? {} : { lookup }),
      timeout: timeoutMs,
    }, (res) => {
      // The body of a push-service answer is never used; drain it so the socket can close.
      res.resume()
      res.on('end', () => settle(resolve, { status: res.statusCode ?? 0 }))
      res.on('error', () => settle(resolve, { status: res.statusCode ?? 0 }))
    })
    req.on('timeout', () => {
      // destroy() emits 'error'; the settle guard makes sure the timeout is what the caller sees.
      req.destroy(new Error('web-push/timeout'))
      settle(reject, new Error('web-push/timeout'))
    })
    req.on('error', (error) => settle(reject, error))
    req.end(body)
  })
}

/**
 * The push sender of one gateway process.
 *
 * @param {object} options
 * @param {{ privateKeyPem: string, publicKey: string }} options.vapid the application server key
 * @param {(request: object) => Promise<{ status: number }>} [options.transport] test-only
 * @param {number} [options.timeoutMs]
 * @param {(line: string) => void} [options.log]
 */
export function createWebPushSender(options) {
  const transport = typeof options.transport === 'function' ? options.transport : httpsTransport
  const timeoutMs = Number.isFinite(options.timeoutMs) && options.timeoutMs > 0 ? options.timeoutMs : WEB_PUSH_TIMEOUT_MS
  const log = typeof options.log === 'function' ? options.log : undefined

  return {
    /**
     * Encrypt and deliver one message.
     *
     * @param {object} message
     * @param {string} message.endpoint the subscription endpoint (must be allowlisted)
     * @param {{ p256dh: string, auth: string }} message.keys the subscription's key material
     * @param {object} message.payload `{ v, kind, sessionId, requestId? }` — ids only
     * @returns {Promise<SendOutcome>}
     */
    async send(message) {
      // The guard runs FIRST and covers the delivery path itself, not only the frame that stored
      // the subscription: a record written before this revision, or a hand-edited store, still
      // cannot make the Host contact a foreign host.
      if (!isWebPushEndpointAllowed(message.endpoint)) {
        log?.('web push refused: the endpoint is not an allowlisted push service')
        return { ok: false, gone: false, reason: 'endpoint-not-allowed' }
      }
      let body
      try {
        const plaintext = JSON.stringify(message.payload)
        if (Buffer.byteLength(plaintext, 'utf8') > WEB_PUSH_MAX_PAYLOAD_BYTES) {
          return { ok: false, gone: false, reason: 'payload-too-large' }
        }
        body = encryptPayload({ payload: plaintext, p256dh: message.keys?.p256dh, auth: message.keys?.auth })
      } catch (error) {
        // A subscription whose keys cannot be used is as dead as a 410: it can never decrypt.
        log?.(`web push refused: unusable subscription keys (${error?.code ?? error?.name ?? 'error'})`)
        return { ok: false, gone: true, reason: 'bad-keys' }
      }
      const target = new URL(message.endpoint)
      const headers = {
        // RFC 8030 §5: TTL is mandatory. 600 s is spec 026 R5 and doubles as the message's staleness.
        TTL: String(WEB_PUSH_TTL_SECONDS),
        'Content-Encoding': CONTENT_ENCODING,
        'Content-Type': 'application/octet-stream',
        // RFC 8030 §5.3: only the kinds that wait for a decision may wake a sleeping device.
        Urgency: WEB_PUSH_HIGH_URGENCY_KINDS.includes(message.payload?.kind) ? 'high' : 'normal',
        Authorization: vapidAuthorization({
          privateKeyPem: options.vapid.privateKeyPem,
          publicKey: options.vapid.publicKey,
          // RFC 8292 §2: `aud` is the endpoint ORIGIN, never the full URL.
          audience: target.origin,
        }),
      }
      try {
        const { status } = await transport({ url: message.endpoint, headers, body, timeoutMs })
        if (status >= 200 && status < 300) return { ok: true, status }
        // 404/410 (RFC 8030 §7.3) and 403 on a stale VAPID key all mean this subscription is dead;
        // only 404/410 are reported as such per spec 026 R2.
        return { ok: false, gone: status === 404 || status === 410, reason: `http-${status}`, status }
      } catch (error) {
        const reason = error?.message === 'web-push/timeout' ? 'timeout' : 'network'
        log?.(`web push not delivered: ${reason}`)
        return { ok: false, gone: false, reason }
      }
    },
  }
}

/**
 * The VAPID `Authorization` header a fake push service can check, exposed so a test does not have
 * to rebuild it. See `verifyVapidToken` in `./vapid.mjs`.
 */
export { vapidAuthorization }

/** SHA-256 of subscription keys, for a store that must not be a plaintext credential dump. */
export function subscriptionFingerprint(keys) {
  return crypto.createHash('sha256')
    .update(`${String(keys?.p256dh)}.${String(keys?.auth)}`, 'utf8')
    .digest('hex')
}
