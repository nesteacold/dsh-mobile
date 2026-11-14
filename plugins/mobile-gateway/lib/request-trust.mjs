// Request-trust predicates moved verbatim from index.mjs (split plan step 1, 2026-11-14).
// Leaf module: must never import index.mjs.

// ---------------------------------------------------------------------------
// A request is NOT this machine's local caller. ONE predicate answers that question for every
// surface below — the loopback classification, the `/mgw` fence, and the Host/Origin guard — so no
// route can be fenced by a weaker rule than another, and none of it depends on the owner's
// `adminLoopbackOnly` switch. Two independent signals, either one sufficient:
//
//  1. A FORWARDING-FAMILY HEADER IS PRESENT. `tailscale serve` terminates TLS in front of this
//     process and dials the local target from this machine, so a proxied request arrives from the
//     machine's OWN address — 127.0.0.1, or this host's own tailnet address — and `remoteAddress`
//     stops naming the caller. The family is matched by PREFIX, never by a list of the names one
//     proxy happens to write: `x-forwarded-ssl`, `tailscale-foo`, or a header this gateway has
//     never heard of is still a proxy talking, and a fixed list would silently stop covering the
//     next one. Header VALUES are never read for anything — they are caller-supplied text.
//  2. THE HOST THE CALLER ADDRESSED IS NOT THIS MACHINE'S LOOPBACK AUTHORITY
//     (`Host: 127.0.0.1[:port]`, `localhost` or `[::1]`). A browser reaching the same process
//     through `tailscale serve` sends the tailnet name as `Host`, because that is the origin it
//     typed. So even a proxy that added no forwarding header at all — or stripped the ones a test
//     expects — cannot make a forwarded request look local. Reuses the exact authority set
//     `assertTrustedLocalAuthority` enforces; do not widen it into a suffix check.
const FORWARDING_HEADER_NAMES = Object.freeze(['forwarded', 'x-real-ip'])
const FORWARDING_HEADER_PREFIXES = Object.freeze(['x-forwarded-', 'tailscale-'])

function isForwardedRequest(req) {
  const headers = req && req.headers
  if (!headers) return false
  return Object.keys(headers).some((name) => {
    const key = name.toLowerCase()
    return FORWARDING_HEADER_NAMES.includes(key)
      || FORWARDING_HEADER_PREFIXES.some((prefix) => key.startsWith(prefix))
  })
}

function addressesLoopbackAuthority(req) {
  const host = req && req.headers && typeof req.headers.host === 'string' ? req.headers.host.trim() : ''
  return TRUSTED_LOCAL_AUTHORITY.test(host)
}

/** The single classification: a proxied request, or one addressed elsewhere, is never local. */
function isNonLocalRequest(req) {
  return isForwardedRequest(req) || !addressesLoopbackAuthority(req)
}

/** The peer address, seen on its own: a proxy makes it name the proxy, never the caller. */
function isLoopbackPeer(req) {
  const addr = req.socket && req.socket.remoteAddress
  return addr === '127.0.0.1' || addr === '::1' || addr === '::ffff:127.0.0.1'
}

function isLoopback(req) {
  // A proxied request is not loopback, however it looks: the peer address is the proxy's.
  if (isNonLocalRequest(req)) return false
  return isLoopbackPeer(req)
}

function parseProtocols(req) {
  const value = req.headers['sec-websocket-protocol']
  if (typeof value !== 'string') return []
  return value.split(',').map((entry) => entry.trim()).filter(Boolean)
}

// T020/T023 (FR-004, FR-007): credentials travel only in handshake headers or
// `dsh-pair.`/`dsh-auth.` subprotocols. A pairing code or device token in the
// URL query is never accepted on any listener — not even a valid one — because
// proxies, access logs and browser history record query strings.
const QUERY_CREDENTIAL_PARAMS = Object.freeze(['pairingCode', 'token', 'code'])

/** Query-parameter names used for a credential in this upgrade request. */
function queryCredentialParams(req) {
  try {
    const query = new URL(req.url || '/', 'http://localhost').searchParams
    return QUERY_CREDENTIAL_PARAMS.filter((name) => {
      const value = query.get(name)
      return typeof value === 'string' && value !== ''
    })
  } catch {
    return []
  }
}

function extractCredential(req) {
  const authorization = req.headers.authorization
  if (typeof authorization === 'string') {
    const match = /^Bearer\s+([A-Za-z0-9_-]{43})$/i.exec(authorization.trim())
    if (match) return { kind: 'token', value: match[1] }
  }

  for (const protocol of parseProtocols(req)) {
    if (protocol.startsWith('dsh-auth.')) return { kind: 'token', value: protocol.slice('dsh-auth.'.length) }
    if (protocol.startsWith('dsh-pair.')) return { kind: 'pairing', value: protocol.slice('dsh-pair.'.length) }
  }
  return undefined
}

/**
 * Spec 005 FR5: a native companion sends no Origin and is allowed; any Origin
 * present must be in `allowedOrigins` (empty by default), otherwise the upgrade
 * is refused before the WebSocket handshake.
 */
function originAllowed(req, allowedOrigins) {
  const origin = req.headers.origin
  if (origin === undefined) return true
  if (typeof origin !== 'string') return false
  return allowedOrigins.includes(origin)
}

function isSameOrigin(req) {
  const origin = req.headers.origin
  if (origin === undefined) return true
  if (typeof origin !== 'string' || typeof req.headers.host !== 'string') return false
  try {
    return new URL(origin).host === req.headers.host
  } catch (error) {
    return false
  }
}

// The authorities a loopback management request may name. The list is closed on
// purpose: exactly `127.0.0.1`, `localhost` and `[::1]`, each with an optional
// port. Deliberately NOT accepted, although a resolver may treat them as local:
// the trailing-dot `localhost.`, any other 127/8 address (`127.0.0.2`), the
// abbreviated `127.1`, and the IPv4-mapped `::ffff:127.0.0.1`. A suffix or
// loopback-range test would take all of them, so there is none here.
const TRUSTED_LOCAL_AUTHORITY = /^(?:127\.0\.0\.1|localhost|\[::1\])(?::\d{1,5})?$/i

/**
 * DNS-rebinding guard for the loopback management routes that change or reveal
 * state a rebound page must not reach (Blocker 1, review 2026-11-10; extended to
 * the pending routes by the spec 021 review). `isSameOrigin` above compares two
 * caller-supplied headers, so a page served from `attacker.example` that resolves
 * to 127.0.0.1 reaches this listener with `Host`/`Origin` that agree with each
 * other and passes it — and a missing Origin is allowed outright. Requiring a Host
 * header that names THIS machine's loopback authority, plus an Origin that matches
 * it exactly over http(s), leaves no name under an attacker's control able to
 * reach these routes.
 *
 * The canonical accepted authorities are exactly `127.0.0.1`, `localhost` and
 * `[::1]`, each with an optional port (see TRUSTED_LOCAL_AUTHORITY above).
 * `localhost.`, other 127/8 addresses, `127.1` and `::ffff:127.0.0.1` are refused
 * on purpose; do not widen this into a permissive suffix check.
 * @param {object} req the management request
 * @throws {Error} 403 when a forwarding-family header is present, or the Host/Origin
 *   pair is not this machine's loopback
 */
function assertTrustedLocalAuthority(req) {
  // The same ONE classification the `/mgw` fence uses, applied here alone for callers that reach a
  // guarded route some other way. A forwarding-family header means a proxy spoke, so this is not
  // the owner at the keyboard whatever the Host says; otherwise the Host itself must be local.
  // Neither refusal echoes caller input.
  if (isNonLocalRequest(req)) {
    const error = new Error(isForwardedRequest(req)
      ? 'this route is not reachable through a proxy'
      : 'this route requires a Host header naming this machine (127.0.0.1, localhost or [::1])')
    error.status = 403
    error.code = 'forbidden'
    throw error
  }
  const origin = req.headers.origin
  if (origin === undefined) return
  const host = req.headers.host.trim()
  let url = null
  try { url = new URL(String(origin)) } catch { url = null }
  // `URL.host` keeps the port: the same loopback name on another port is still
  // a different (cross-origin) caller.
  if (!url || (url.protocol !== 'http:' && url.protocol !== 'https:') || url.host !== host) {
    const error = new Error('this route requires an Origin that matches the Host header over http(s)')
    error.status = 403
    error.code = 'forbidden'
    throw error
  }
}

/** Pure composition of the predicates above; no new rules. */
function classifyRequest(req) {
  return {
    forwarded: isForwardedRequest(req),
    loopbackAuthority: addressesLoopbackAuthority(req),
    nonLocal: isNonLocalRequest(req),
    loopbackPeer: isLoopbackPeer(req),
    loopback: isLoopback(req),
    sameOrigin: isSameOrigin(req),
    credentialKind: extractCredential(req)?.kind ?? null,
    queryCredentialParams: queryCredentialParams(req),
  }
}

export {
  FORWARDING_HEADER_NAMES, FORWARDING_HEADER_PREFIXES, QUERY_CREDENTIAL_PARAMS, TRUSTED_LOCAL_AUTHORITY,
  addressesLoopbackAuthority, assertTrustedLocalAuthority, classifyRequest, extractCredential, isForwardedRequest,
  isLoopback, isLoopbackPeer, isNonLocalRequest, isSameOrigin, originAllowed, parseProtocols, queryCredentialParams,
}
