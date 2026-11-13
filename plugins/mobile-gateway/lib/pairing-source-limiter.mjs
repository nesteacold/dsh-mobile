// Spec 023 R2/R5 — a per-source brake on WRONG one-time-code proofs.
//
// The limiter runs BEFORE a proof is verified: a source that already spent its budget is refused
// without its proof ever being tested against an offer (so a limited source can neither burn an
// offer's global guess budget nor learn whether a guess was right). Pure bookkeeping: injectable
// clock, bounded table, in-memory only, nothing logged.
//
// The source key is the socket peer address for a direct connection. Every proxied request (one
// carrying a forwarding-family header, or addressed to a non-loopback Host) shares ONE key:
// behind `tailscale serve` the peer address names the proxy, and any forwarding header is
// caller-supplied text, so no header VALUE is ever trusted or even read here.

// Spec 023 decision 2026-11-13: 2, deliberately BELOW the per-offer burn ceiling
// (`OTP_MAX_FAILURES` = 3 in pairing-requests), so no single source — and no shared `proxied`
// bucket — can burn the owner's offer alone; burning needs a second source's first wrong proof.
export const SOURCE_MAX_FAILURES = 2
export const SOURCE_WINDOW_MS = 10 * 60 * 1000
export const SOURCE_MAX_KEYS = 1024
export const PROXIED_SOURCE_KEY = 'proxied'
// Spec 023 R2: a proof with no source at all still spends a budget — the shared `unknown` bucket —
// instead of bypassing the brake. Every source the gateway computes is `proxied` or `peer:<addr>`,
// so this key can never collide with a real one.
export const UNKNOWN_SOURCE_KEY = 'unknown'

/**
 * @param {{ now?: () => number, maxFailures?: number, windowMs?: number, maxKeys?: number }} [options]
 */
export function createSourceLimiter(options = {}) {
  const now = options.now ?? Date.now
  const maxFailures = options.maxFailures ?? SOURCE_MAX_FAILURES
  const windowMs = options.windowMs ?? SOURCE_WINDOW_MS
  const maxKeys = options.maxKeys ?? SOURCE_MAX_KEYS
  /** @type {Map<string, number[]>} source key -> timestamps of recent wrong proofs (Map order = LRU) */
  const table = new Map()

  const recent = (key) => {
    const times = table.get(key)
    if (!times) return []
    const cutoff = now() - windowMs
    const live = times.filter((at) => at > cutoff)
    if (live.length === 0) table.delete(key)
    else if (live.length !== times.length) table.set(key, live)
    return live
  }

  // Drops every bucket whose timestamps are all outside the window. Only the full-table path runs
  // it, so the common case stays O(1); without it a table full of long-expired keys would refuse
  // every new source for as long as the plugin lives.
  const sweepExpired = () => {
    const cutoff = now() - windowMs
    for (const [key, times] of [...table]) {
      if (!times.some((at) => at > cutoff)) table.delete(key)
    }
  }

  return {
    /** True when this source has spent its budget in the current window. */
    isLimited(key) {
      const k = String(key)
      // A key the table is already tracking answers for itself, so an existing bucket (a peer, and
      // above all the shared `proxied` one) keeps the state it earned.
      if (table.has(k)) return recent(k).length >= maxFailures
      if (table.size < maxKeys) return false
      sweepExpired()
      // The table has no room for a new key, so this one cannot be tracked: it is refused as if it
      // had spent its budget. Evicting the least recently used key instead would hand an attacker a
      // way to clear a REAL bucket — flood the table, then fail again as `proxied`.
      return table.size >= maxKeys
    },

    /**
     * Record one wrong proof. Touching a key makes it the most recently used. A new key is never
     * recorded once the table is full: refusing it (see `isLimited`) is the whole point, so there
     * is nothing to make room for.
     */
    recordFailure(key) {
      const k = String(key)
      if (!table.has(k) && table.size >= maxKeys) {
        sweepExpired()
        if (table.size >= maxKeys) return
      }
      const live = recent(k)
      live.push(now())
      table.delete(k)
      table.set(k, live)
    },

    size() { return table.size },
    clear() { table.clear() },
  }
}

/**
 * The source key for a pairing request. `proxied` is the caller's already-computed classification
 * (the gateway's `isForwardedRequest || isNonLocalRequest`); this module deliberately does not
 * re-derive it, so there is exactly one proxy classifier in the package.
 */
export function pairingSourceKey({ proxied, peerAddress }) {
  if (proxied) return PROXIED_SOURCE_KEY
  const address = String(peerAddress ?? '').replace(/^::ffff:/, '')
  return address ? `peer:${address}` : 'peer:unknown'
}
