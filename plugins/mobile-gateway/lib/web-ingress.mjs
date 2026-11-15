// Spec 031 step 2 (GATEWAY scope): the loopback web (Serve) ingress — origin policy, the persisted
// tuple, and the request fence. Leaf module: it never imports index.mjs and holds no socket.
//
// Three facts stay separate (spec 031 "Problem"): where the gateway listens (the direct TLS listener,
// unchanged), where a browser connects (the Serve origin), and which certificate a client observes
// (Serve's, because Serve terminates TLS). This module owns only the second and third whitelisted
// facts of the LOOPBACK upstream that Serve dials — never the advertised web origin in a pinned offer.
/** The fixed bind of the web ingress. Never configurable: a wildcard or a tailnet bind is not this surface. */
export const WEB_INGRESS_HOST = '127.0.0.1'

/** Policy-limited port window: the Serve upstream is a local listener, so no wildcard range. */
export const WEB_INGRESS_MAX_PORT = 65_535

/**
 * The ONLY WebSocket path the web ingress serves, fixed by the contract (spec 031 §2: the browser
 * opens the current HTTPS origin's WSS `/ws/mobile`). Deliberately not the configurable direct
 * listener path: Serve is mounted on that exact path, so a different direct path must never move
 * the browser path or the guidance `status.webIngress.wsPath` reports.
 */
export const WEB_WS_PATH = '/ws/mobile'

/** The only keys the tuple may carry: an unexpected key would be silently dropped otherwise. */
const WEB_INGRESS_KEYS = Object.freeze(['enabled', 'port', 'origin'])

/**
 * The one origin shape this ingress accepts: canonical `https://<label>.ts.net`, no port, no path.
 * Serve serves the PWA and `/ws/mobile` on the tailnet MagicDNS name over TLS; any other spelling
 * (http, a LAN address, an IP literal, a trailing dot, a userinfo, a port or a path) is refused
 * instead of normalised, so a typo can never silently fence a different origin out.
 */
// At least one label before `ts.net`: a bare `ts.net` is not a tailnet name.
const WEB_ORIGIN_SHAPE = /^https:\/\/(?:[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?\.)+ts\.net$/

/**
 * A configured web origin, or `null` when it is not exactly one canonical HTTPS `*.ts.net` origin.
 * @param {unknown} value owner-configured origin
 * @returns {string|null}
 */
export function normalizeWebOrigin(value) {
  if (typeof value !== 'string') return null
  const trimmed = value.trim()
  if (!WEB_ORIGIN_SHAPE.test(trimmed)) return null
  let url
  try { url = new URL(trimmed) } catch { return null }
  // `URL` would accept a port, a path or credentials the regex cannot see, and `.origin`
  // would then silently drop them; the canonical form has none, so compare the WHOLE string.
  if (url.origin !== trimmed || url.pathname !== '/' || url.search !== '' || url.hash !== '') return null
  if (url.username !== '' || url.password !== '') return null
  return url.origin
}

/**
 * Whether a WebSocket request came from the exact configured browser origin. Unlike `originAllowed`
 * (native clients send no Origin, and that is fine there), the web ingress is BROWSER-ONLY, so a
 * missing Origin is a refusal as well: a non-browser client must not borrow this listener's
 * browser-ca-same-origin trust model. `null`, a repeated (array) header, `file://`, `null` and any
 * other origin are refused.
 * @param {object} req upgrade request
 * @param {string|null} configuredOrigin the single configured origin
 * @returns {{ok: boolean, reason?: string}}
 */
export function webOriginAccepted(req, configuredOrigin) {
  if (typeof configuredOrigin !== 'string' || configuredOrigin === '') return { ok: false, reason: 'not-configured' }
  const origin = req && req.headers ? req.headers.origin : undefined
  if (origin === undefined) return { ok: false, reason: 'origin-missing' }
  // Node joins repeated headers into one string; a comma never occurs in a canonical origin, so a
  // repeated header is refused rather than matched by accident.
  if (typeof origin !== 'string' || origin.includes(',')) return { ok: false, reason: 'origin-foreign' }
  const candidate = origin.trim()
  if (candidate !== configuredOrigin) return { ok: false, reason: 'origin-foreign' }
  return { ok: true }
}

/**
 * The ingress identity of a pending pairing/approval, so a decision can refuse a request whose
 * ingress was disabled or replaced while the owner was deciding. A fresh symbol per attempt: two
 * listeners that happen to use the same port are still different attempts.
 * @param {'direct'|'web'} kind
 * @returns {{kind: 'direct'|'web', generation: number, token: symbol}}
 */
export function ingressIdentity(kind, generation) {
  return { kind, generation, token: Symbol(`${kind}:${generation}`) }
}

/**
 * A fresh identity for a listener ATTEMPT, made once every time the gateway opens a listener — a
 * restoration, an identical-tuple retry and a replacement all make a new one. The token is what a
 * socket's upgrade carries and what the liveness checks compare, so a socket can only ever be live
 * on the very listener that served it, even when the restored listener reuses its tuple generation.
 * @param {'direct'|'web'} kind
 * @param {number} generation the tuple/attempt generation in force when the listener was made
 * @returns {{kind: 'direct'|'web', generation: number, token: symbol}}
 */
export function listenerIngress(kind, generation) {
  return { kind, generation, token: Symbol(`listener:${kind}:${generation}`) }
}

/**
 * The persisted `webIngress` tuple, or the disabled default. `version` stays 1 (optional field, like
 * `listenHost`/`remoteControl`): a file written before this feature still validates.
 * @param {unknown} value raw persisted value
 * @returns {{enabled: boolean, port: number, origin: string}}
 * @throws {Error} on a malformed tuple (never silently repaired: the owner's choice must survive)
 */
export function readWebIngress(value) {
  if (value === undefined) return { enabled: false, port: 0, origin: '' }
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error('invalid web ingress')
  const keys = Object.keys(value)
  if (keys.some((key) => !WEB_INGRESS_KEYS.includes(key))) throw new Error('invalid web ingress')
  const { enabled, port, origin } = value
  if (typeof enabled !== 'boolean') throw new Error('invalid web ingress switch')
  // A bound is required from a CALLER, never invented: an input that omits `port` or `origin`
  // is refused rather than read as the disabled default (a half tuple must not enable anything).
  if (!Number.isSafeInteger(port) || port < 0 || port > WEB_INGRESS_MAX_PORT) throw new Error('invalid web ingress port')
  if (typeof origin !== 'string' || (origin !== '' && normalizeWebOrigin(origin) === null)) throw new Error('invalid web ingress origin')
  // An enabled ingress with no origin would fence out every browser request; refuse the file
  // instead of starting a listener nobody can reach.
  if (enabled && origin === '') throw new Error('an enabled web ingress requires an origin')
  return { enabled, port, origin }
}

/**
 * Validate an owner request for the ingress tuple. Distinct from the direct listener's port is a
 * property of the whole configuration, so the caller supplies that port.
 * @param {object} input `{enabled?, port?, origin?}` — absent keys keep the current value
 * @param {{enabled: boolean, port: number, origin: string}} current tuple in force
 * @param {number} directPort the port the direct TLS listener is configured on (or is bound to)
 * @returns {{enabled: boolean, port: number, origin: string}}
 * @throws {Error} with `status: 400` or `409` (`code: 'port-conflict'`)
 */
export function planWebIngress(input, current, directPort) {
  if (!input || typeof input !== 'object' || Array.isArray(input)) {
    const error = new Error('a web ingress object is required')
    error.status = 400
    throw error
  }
  const unknown = Object.keys(input).filter((key) => !['enabled', 'port', 'origin'].includes(key))
  if (unknown.length > 0) {
    const error = new Error(`unsupported web ingress setting: ${unknown.join(', ')}`)
    error.status = 400
    throw error
  }
  const next = { ...current }
  if (input.enabled !== undefined) {
    if (typeof input.enabled !== 'boolean') {
      const error = new Error('enabled must be a boolean')
      error.status = 400
      throw error
    }
    next.enabled = input.enabled
  }
  if (input.port !== undefined) {
    if (!Number.isSafeInteger(input.port) || input.port < 0 || input.port > WEB_INGRESS_MAX_PORT) {
      const error = new Error(`port must be an integer between 0 and ${WEB_INGRESS_MAX_PORT}`)
      error.status = 400
      throw error
    }
    next.port = input.port
  }
  if (input.origin !== undefined) {
    if (typeof input.origin !== 'string' || normalizeWebOrigin(input.origin) === null) {
      const error = new Error('origin must be a canonical https://<label>.ts.net origin (no port, path or credentials)')
      error.status = 400
      throw error
    }
    next.origin = normalizeWebOrigin(input.origin)
  }
  // An enabled ingress must be reachable: an origin is required, and the port must be a real port
  // (0 would let the OS pick one Serve is not pointing at) that is not the direct listener's.
  if (next.enabled) {
    if (next.origin === '') {
      const error = new Error('an origin is required to enable the web ingress')
      error.status = 400
      throw error
    }
    if (next.port === 0) {
      const error = new Error('a port is required to enable the web ingress')
      error.status = 400
      throw error
    }
  }
  if (next.port !== 0 && Number.isSafeInteger(directPort) && next.port === directPort) {
    const error = new Error(`port ${next.port} is already used by the direct TLS listener`)
    error.status = 409
    error.code = 'port-conflict'
    throw error
  }
  return next
}

/**
 * The owner-facing status guidance for the browser path. Deliberately a SEPARATE object: it is
 * never merged into a pinned offer (`PairingPayload`/`endpoints`), because a browser does not
 * observe the gateway leaf (Serve terminates TLS) and must never be offered a gateway pin.
 * Reported even while the ingress is off, so the owner can see what enabling it would mean.
 *
 * It reports `listening` (the loopback upstream is up) — never a `ready`: readiness needs an
 * accepted client-hello after pairing and any required unlock (spec 031 §7), which live client
 * state decides, not this listener. The path is the fixed `WEB_WS_PATH`, never the direct one.
 * @param {{enabled: boolean, origin: string, listening: boolean, port: number, error: string|null}} state
 */
export function webIngressStatus(state) {
  return {
    enabled: state.enabled === true,
    configured: state.origin !== '',
    origin: state.origin === '' ? null : state.origin,
    // The browser path the PWA opens on that origin. Never a `wss://` endpoint of the direct listener.
    wsPath: WEB_WS_PATH,
    trust: 'browser-ca-same-origin',
    listening: state.listening === true,
    host: WEB_INGRESS_HOST,
    port: state.port,
    error: state.error ?? null,
  }
}

/** Deterministic-enough label for a log line: the origin only (never a credential or a header). */
export function webIngressLabel(state) {
  return state && state.origin ? `${state.origin} (${WEB_INGRESS_HOST}:${state.port})` : `${WEB_INGRESS_HOST}:${state.port ?? 0}`
}
