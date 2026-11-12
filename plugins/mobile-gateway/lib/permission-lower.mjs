// Spec 019 Wave 3 — permission control: view + lower-only (see
// `specs/019-parity-wave3-high-risk-design/permission-lower.md`).
//
// A device holding the new, explicit-only `permission:lower` scope may READ this Host's
// permission presets (`permission-options`) and switch ONE session to a STRICTLY
// STRICTER preset (`permission-lower`). It can never widen one: this module compares
// both axes itself and refuses anything looser on either.
//
// Why the in-process service and not a command: DSH exposes no Remote setter for
// `permissionPresets` — only `catalog` is decorated `@Remote` (dsh-permission-presets/
// lib/index.js:120, measured on 0.2.2-rc.1). The desktop UI switches through the
// `/permission` slash command, which a companion must never be given: a phone sends a
// PRESET NAME here, never a command line. So every read and write goes through the same
// cordis service the command handler uses (`current`/`resolve`/`set`,
// lib/index.js:296, :318, :349), called with the Host's LIVE Session object.
//
// TWO separate readers, never one:
//  1. VISIBILITY: the Gateway's own `session/projections` read, issued through
//     `typertGateway.dispatchRpc` with THIS DEVICE's Peer, so DSH's own `remoteAccess`
//     policy answers the per-session `allows({kind:'session', id})` for that device —
//     a session the device may not address never gets past this. Its `values.permissions`
//     member is the projection WIRE VIEW (`{currentValue}`, dsh-permission-presets/
//     lib/index.js:206-209), NOT the Session: a wire view names no session at all, so it
//     can never be the argument of `current(session)` / `set(session, name)`.
//  2. THE LIVE SESSION: the in-process cordis service `sessions` (`ctx.get('sessions')`,
//     service key `sessions` at dsh-session/lib/index.js:1748), whose `get(id)` returns
//     the Session only while it is the store's LIVE entry (dsh-session/lib/index.js:
//     1988-2001: the store entry, `undefined` when absent). `dsh-session-query`'s `read()`
//     asks the same store first and never attaches a stored one behind a `sessions.get`
//     hit (dsh-session-query/lib/index.js:354-355). Nothing here loads or resumes a
//     session: a session that is not live is refused `unavailable`, never opened.
//
// Fail closed: a Host without either service (or with a service whose shape differs) is
// refused `unavailable`; a session that is not live is refused `unavailable`; nothing is
// ever routed through `commands/execute`. The service and the Session are passed as
// SEPARATE arguments of the calls below — never merged into one object — because the
// service is a class instance and spreading it drops its prototype methods.
//
// LIVENESS FIRST: the store answers before the visibility read runs. A session that is
// not live is refused `unavailable` WITHOUT a `session/projections` call — that read
// answers a stored session too, and its `permissions` member is what loads the session
// into a cache (dsh-permission-presets/lib/index.js:206-209 is a stored-session
// projection), so a refusal must not provoke it. The device-visibility answer is still
// the HTTP-equivalent 404 for a caller that probes ids: a refused id and an absent id
// answer the same `unavailable`, and neither says whether that session exists.
//
// What this module does NOT do: send a device the "approval policy changed" notice
// `service.set` leaves to the Host. The desktop `/permission` command announces a switch
// through `approval.setPolicy`, which is what re-arms the agent's next tool call; a
// `permission-lower` write goes straight to `permissionPresets.set`, so the agent is not
// told. The stricter policy IS enforced (the next tool call is judged by it), and a
// session already waiting on an approval keeps that pending card. If the agent must be
// re-notified, that would be the same `approval.setPolicy` call the command makes, and
// it would have to be decided under a new capability — not added silently here.
//
// Atomicity: DSH has no compare-and-set. The second `current` read and `set` run in one
// synchronous block with no `await` between them, so no other in-process writer can
// interleave on JS's single thread (inferred, not a Host guarantee — the service is
// unversioned internals, re-check on a DSH bump). The write is re-read and answered
// `raced` when it did not take; nothing is retried.

import {
  APPROVAL_POLICY_ORDER, PERMISSION_INCOMPARABLE_CURRENTS, PERMISSION_LOWER_MESSAGES,
  PERMISSION_LOWER_SCOPE, SANDBOX_MODE_ORDER,
} from './vendor/mobile-protocol.mjs'

/** The cordis service every read and write goes through. */
export const PERMISSION_PRESETS_SERVICE = 'permissionPresets'

/** The in-process store that holds every LIVE Session (`ctx.sessions`, key `sessions`). */
export const SESSIONS_SERVICE = 'sessions'

/**
 * The one Host read that decides DEVICE VISIBILITY of a session id (`sessions:read`, plus
 * the session's own `allows({kind:'session', id})`). It answers a projection wire view,
 * never the Session — see {@link SESSIONS_SERVICE} for the live object.
 */
export const SESSION_PROJECTIONS_ENDPOINT = 'session/projections'

/** The methods this module needs; a service missing any of them is unusable. */
const REQUIRED_METHODS = ['current', 'resolve', 'set']

/** Largest session id this module forwards (a wire id is far shorter). */
const MAX_SESSION_ID = 128

/**
 * Read a cordis service the same way `resolveHostGateway` reads `typertGateway`:
 * `ctx.get(name, false)` first, then the single-argument form. Never throws.
 * @param {object} ctx the plugin context
 * @param {string} name the service key
 * @returns {object|undefined} the service, or undefined when this Host has none
 */
function serviceOf(ctx, name) {
  if (!ctx || typeof ctx.get !== 'function') return undefined
  let service
  try { service = ctx.get(name, false) } catch { /* single-argument form only */ }
  if (!service) {
    try { service = ctx.get(name) } catch { return undefined }
  }
  return service
}

/**
 * The service when it can read the current preset, resolve names and write, else
 * `undefined`. A method that is not a function means the shape differs: fail closed.
 * @param {object} ctx the plugin context
 */
function usableService(ctx) {
  const service = serviceOf(ctx, PERMISSION_PRESETS_SERVICE)
  if (!service || typeof service !== 'object') return undefined
  return REQUIRED_METHODS.every((method) => typeof service[method] === 'function') ? service : undefined
}

/**
 * The LIVE Session store (`ctx.sessions`), or `undefined` when this Host has none.
 * Only its `get(id)` is used, and only to answer "is this Session live right now".
 * @param {object} ctx the plugin context
 */
function usableSessions(ctx) {
  const sessions = serviceOf(ctx, SESSIONS_SERVICE)
  if (!sessions || typeof sessions !== 'object') return undefined
  return typeof sessions.get === 'function' ? sessions : undefined
}

/** Index of `value` in `order` (strictest = 0), or `-1` when it is not a member. */
const rankOf = (order, value) => (typeof value === 'string' ? order.indexOf(value) : -1)

/**
 * Is `to` strictly stricter than `from`? Never looser on EITHER axis and stricter on at
 * least one: a sandbox rank that only goes down and an approval rank that only goes
 * down, with at least one of them moving. A pair that widens one axis is never "stricter",
 * whatever the other axis does.
 * @param {{sandbox?: unknown, approval?: unknown}} from the current knob pair
 * @param {{sandbox?: unknown, approval?: unknown}} to the target knob pair
 */
export function isStrictlyStricter(from, to) {
  const fromSandbox = rankOf(SANDBOX_MODE_ORDER, from?.sandbox)
  const toSandbox = rankOf(SANDBOX_MODE_ORDER, to?.sandbox)
  const fromApproval = rankOf(APPROVAL_POLICY_ORDER, from?.approval)
  const toApproval = rankOf(APPROVAL_POLICY_ORDER, to?.approval)
  // An unrankable knob on either side is not comparable: fail closed.
  if (fromSandbox < 0 || toSandbox < 0 || fromApproval < 0 || toApproval < 0) return false
  if (toSandbox > fromSandbox || toApproval > fromApproval) return false
  return toSandbox < fromSandbox || toApproval < fromApproval
}

/** The wire shape of one knob pair; `null` when the resolved value is unusable. */
export function pairOf(spec) {
  if (!spec || typeof spec !== 'object') return null
  const sandbox = spec.sandbox
  const approval = spec.approval
  if (rankOf(SANDBOX_MODE_ORDER, sandbox) < 0 || rankOf(APPROVAL_POLICY_ORDER, approval) < 0) return null
  return { sandbox, approval }
}

/**
 * The preset names a device may be offered or may ask for. `custom` and `auto` are never
 * targets: `custom` matches no configured preset, and `auto` bundles a `danger-full-access`
 * sandbox with an automatic reviewer, so neither is a "lower".
 */
function targetNames(names) {
  if (!Array.isArray(names)) return []
  return names.filter((name) => typeof name === 'string' && name !== ''
    && !PERMISSION_INCOMPARABLE_CURRENTS.includes(name))
}

/** Fixed sentences for every code this module answers with; the permission set plus `bad-request`. */
const REFUSAL_MESSAGES = Object.freeze({
  ...PERMISSION_LOWER_MESSAGES,
  'bad-request': 'the request must name one session id of at most 128 characters',
})

/**
 * The refusal this module answers with: an error frame carrying a stable code and its
 * fixed sentence (never Host text), plus the session it is about.
 */
function refusal(reason, requestType, sessionId) {
  return {
    kind: 'error',
    code: reason,
    requestType,
    ...(sessionId ? { sessionId } : {}),
    // Every code gets a fixed sentence, the `bad-request` of a malformed frame too;
    // nothing here is ever the Host's own text (spec 019 design, rule 8).
    message: REFUSAL_MESSAGES[reason] ?? REFUSAL_MESSAGES.unavailable,
  }
}


/**
 * Build the two operations for one plugin context. No state is kept between calls: the
 * caller passes the connection's own device id and Peer with every request.
 *
 * @param {object} ctx the plugin context (Cordis)
 * @param {object} facts injected, optional readers:
 *   - `dispatchRpc(endpoint, payload, signal, peer)` the Host carrier (see
 *     {@link SESSION_PROJECTIONS_ENDPOINT}); absent ⇒ every call is `unavailable`;
 *   - `log(line)` the plugin's log sink.
 * @returns {{
 *   options(msg: object, peer: object|undefined, deviceId: string|undefined): Promise<object>,
 *   lower(msg: object, peer: object|undefined, deviceId: string|undefined): Promise<object>,
 *   unavailable(msg: object): object,
 * }} operations
 */
export function createPermissionLower(ctx, facts) {
  const log = typeof facts?.log === 'function' ? facts.log : () => {}
  const dispatchRpc = typeof facts?.dispatchRpc === 'function' ? facts.dispatchRpc : undefined
  // The two optional in-process services are read ONCE, per request, never at build time:
  // a Host can mount (or unmount) either while the gateway is up, and a cached pair would
  // go stale behind the socket.

  /** The device id the audit line names, or `-` when no live record is readable. */
  const deviceId = (id) => (typeof id === 'string' && id !== '' ? id : '-')

  /**
   * The audit line itself. Every interpolated text is a wire value (a session id, a preset
   * name, a device id), and a newline folded into one of those would start a forged
   * second line in the log file — so control characters are replaced before they land.
   * @param {string} text one complete audit line
   */
  const audit = (text) => log(text.replace(/[\u0000-\u001f\u007f\u2028\u2029]/g, '?'))

  /**
   * Resolve a device-named session id to the Host's LIVE Session object, in two steps
   * that must BOTH pass — see the header for why the projection read alone cannot.
   *
   * The live store answers FIRST: its `get(id)` returns the Session only while it is the
   * store's live entry, and nothing here loads or resumes a stored one, so a session that
   * is stored but not live is `unavailable` before any Host read is even issued.
   * Visibility then runs on the DEVICE's Peer, so DSH answers the per-session
   * `allows({kind:'session', id})` for that device: a session the device may not address
   * never gets past it. Anything but a `sequenced` snapshot with a `permissions`
   * member is refused the same way — fail closed, never a guess.
   * @param {string} sessionId the wire field, trimmed once and validated before any use
   * @returns {Promise<{id: string, session: object}|{refusal: string}>} the id that was
   *   resolved plus the live Session, or the refusal code
   */
  const resolveSession = async (sessionId, peer) => {
    if (dispatchRpc === undefined) return { refusal: 'unavailable' }
    // The router hands over the raw field: trim it once, then validate what goes on the wire.
    const id = typeof sessionId === 'string' ? sessionId.trim() : ''
    if (id === '' || id.length > MAX_SESSION_ID) return { refusal: 'bad-request' }
    if (!peer) return { refusal: 'unavailable' }
    const sessions = usableSessions(ctx)
    // Liveness before visibility (header): a session this Host does not hold live can never
    // be served, so it is refused without the projection read a stored session would satisfy.
    const live = sessions?.get(id)
    if (live === null || typeof live !== 'object') return { refusal: 'unavailable' }
    try {
      const value = await dispatchRpc(SESSION_PROJECTIONS_ENDPOINT, { sessionId: id }, undefined, peer)
      if (!value || typeof value !== 'object' || value.ok !== true) {
        // A policy refusal and a missing service both land here: nothing to compare,
        // nothing to write.
        return { refusal: 'unavailable' }
      }
      const view = value.value?.values?.permissions
      if (value.value?.kind !== 'sequenced' || view === null || typeof view !== 'object') {
        return { refusal: 'unavailable' }
      }
    } catch { return { refusal: 'unavailable' } }
    // The visibility read ends here: `view` was the wire view, never the Session. The
    // Session served below is the live object the store returned above.
    return { id, session: live }
  }

  /** Current preset, or `undefined` when it cannot be read (anything but a string is unusable). */
  const currentOf = (service, session) => {
    try {
      const value = service.current(session)
      return typeof value === 'string' && value !== '' ? value : undefined
    } catch { return undefined }
  }

  /** Resolved knob pair of `name`, or `undefined` when it is unknown/unusable. */
  const pairFor = (service, name) => {
    try { return pairOf(service.resolve(name)) } catch { return undefined }
  }

  /** Preset names from the service's own list (`names`), else from its `presets` table. */
  const namesOf = (service) => {
    try {
      if (Array.isArray(service.names)) return targetNames(service.names)
    } catch { /* an accessor that throws is treated like a missing list */ }
    try {
      const presets = service.presets
      if (presets && typeof presets === 'object') return targetNames(Object.keys(presets))
    } catch { /* fall through */ }
    return []
  }

  /**
   * Everything a read needs, or the refusal to answer with. `service` and `session` are
   * the two distinct objects: the class instance keeps its prototype methods, so its
   * own `current(session)` is called on the instance itself.
   * @param {object} service the `permissionPresets` instance
   * @param {object} session the LIVE Session the store returned
   * @param {string} sessionId the validated id, for the reply and the log
   */
  const stateOf = (service, session, sessionId) => {
    const current = currentOf(service, session)
    if (current === undefined || PERMISSION_INCOMPARABLE_CURRENTS.includes(current)) return { refusal: 'custom-current' }
    const from = pairFor(service, current)
    if (from === undefined) return { refusal: 'custom-current' }
    const options = []
    for (const preset of namesOf(service)) {
      const to = pairFor(service, preset)
      if (to === undefined || !isStrictlyStricter(from, to)) continue
      options.push({ preset, sandbox: to.sandbox, approval: to.approval })
    }
    return { current, from, options, sessionId }
  }

  const options = async (msg, peer, callingDeviceId) => {
    const service = usableService(ctx)
    if (service === undefined) {
      audit(`permission-options unavailable: no usable ${PERMISSION_PRESETS_SERVICE} service device=${deviceId(callingDeviceId)}`)
      return refusal('unavailable', 'permission-options', typeof msg.sessionId === 'string' ? msg.sessionId.trim() : undefined)
    }
    const address = await resolveSession(msg.sessionId, peer)
    if (address.refusal !== undefined) {
      // The refusal names the trimmed id only when it validated; a malformed field is
      // never echoed back into the reply or the log.
      const sessionId = typeof msg.sessionId === 'string' ? msg.sessionId.trim() : ''
      const nameable = sessionId !== '' && sessionId.length <= MAX_SESSION_ID ? sessionId : undefined
      audit(`permission-options refused: ${address.refusal} device=${deviceId(callingDeviceId)}${nameable ? ` session=${nameable}` : ''}`)
      return refusal(address.refusal, 'permission-options', nameable)
    }
    const state = stateOf(service, address.session, address.id)
    if (state.refusal !== undefined) {
      audit(`permission-options refused: ${state.refusal} device=${deviceId(callingDeviceId)} session=${address.id}`)
      return refusal(state.refusal, 'permission-options', address.id)
    }
    audit(`permission-options read: device=${deviceId(callingDeviceId)} session=${address.id} current=${state.current} options=${state.options.map((option) => option.preset).join(',') || '-'}`)
    return { kind: 'permission-options', sessionId: address.id, currentValue: state.current, options: state.options }
  }

  /**
   * Switch ONE session to a strictly stricter preset. Read, compare and write happen in
   * ONE synchronous block: no `await` sits between `current(session)` and
   * `set(session, preset)`.
   */
  const lower = async (msg, peer, callingDeviceId) => {
    const preset = msg.preset
    const service = usableService(ctx)
    if (service === undefined) {
      audit(`permission-lower unavailable: no usable ${PERMISSION_PRESETS_SERVICE} service device=${deviceId(callingDeviceId)}`)
      return refusal('unavailable', 'permission-lower', typeof msg.sessionId === 'string' ? msg.sessionId.trim() : undefined)
    }
    // `auto` is a danger-full-access sandbox and `custom` is not a preset: neither is ever
    // a target. An unknown name is refused the same way — it cannot be compared.
    const names = namesOf(service)
    if (typeof preset !== 'string' || preset === ''
      || PERMISSION_INCOMPARABLE_CURRENTS.includes(preset) || !names.includes(preset)) {
      const sessionId = typeof msg.sessionId === 'string' ? msg.sessionId.trim() : ''
      audit(`permission-lower refused: custom-current (unknown or incomparable target) device=${deviceId(callingDeviceId)}${sessionId !== '' && sessionId.length <= MAX_SESSION_ID ? ` session=${sessionId}` : ''}`)
      return refusal('custom-current', 'permission-lower', sessionId !== '' && sessionId.length <= MAX_SESSION_ID ? sessionId : undefined)
    }
    const address = await resolveSession(msg.sessionId, peer)
    if (address.refusal !== undefined) {
      const sessionId = typeof msg.sessionId === 'string' ? msg.sessionId.trim() : ''
      const nameable = sessionId !== '' && sessionId.length <= MAX_SESSION_ID ? sessionId : undefined
      audit(`permission-lower refused: ${address.refusal} device=${deviceId(callingDeviceId)}${nameable ? ` session=${nameable}` : ''}`)
      return refusal(address.refusal, 'permission-lower', nameable)
    }
    const state = stateOf(service, address.session, address.id)
    if (state.refusal !== undefined) {
      audit(`permission-lower refused: ${state.refusal} device=${deviceId(callingDeviceId)} session=${address.id}`)
      return refusal(state.refusal, 'permission-lower', address.id)
    }
    const to = pairFor(service, preset)
    if (to === undefined) {
      // An unusable pair is a refusal like any other and is audited like one: a caller
      // that never gets an answer cannot tell it from `not-stricter`.
      audit(`permission-lower refused: custom-current (unresolvable target pair) device=${deviceId(callingDeviceId)} session=${address.id} to=${preset}`)
      return refusal('custom-current', 'permission-lower', address.id)
    }
    if (!isStrictlyStricter(state.from, to)) {
      audit(`permission-lower refused: not-stricter device=${deviceId(callingDeviceId)} session=${address.id} from=${state.current} to=${preset}`)
      return { kind: 'permission-lower', sessionId: address.id, currentValue: state.current, accepted: false, reason: 'not-stricter' }
    }

    // ---- ONE synchronous block: read again, compare, write -----------------------
    const from = state.current
    const before = currentOf(service, address.session)
    if (before === undefined || PERMISSION_INCOMPARABLE_CURRENTS.includes(before)) {
      audit(`permission-lower refused: custom-current (the preset changed to an incomparable one) device=${deviceId(callingDeviceId)} session=${address.id} from=${from} observed=${before ?? 'unknown'}`)
      return { kind: 'permission-lower', sessionId: address.id, currentValue: before ?? null, accepted: false, reason: 'custom-current' }
    }
    const livePair = pairFor(service, before)
    if (livePair === undefined) {
      audit(`permission-lower refused: custom-current (the preset changed to an unresolvable one) device=${deviceId(callingDeviceId)} session=${address.id} from=${from} observed=${before}`)
      return { kind: 'permission-lower', sessionId: address.id, currentValue: before, accepted: false, reason: 'custom-current' }
    }
    if (!isStrictlyStricter(livePair, to)) {
      audit(`permission-lower refused: not-stricter (the preset changed before the write) device=${deviceId(callingDeviceId)} session=${address.id} from=${before} to=${preset}`)
      return { kind: 'permission-lower', sessionId: address.id, currentValue: before, accepted: false, reason: 'not-stricter' }
    }
    try {
      // The class instance keeps its prototype methods; the Session is its own argument.
      service.set(address.session, preset)
    } catch {
      // A throwing write changed nothing this module can vouch for; the re-read below
      // decides, and an unconfirmed write is `raced`, never a success.
    }
    const after = currentOf(service, address.session)
    // ---- end of the synchronous block --------------------------------------------

    if (after !== preset) {
      // No retry: DSH offers no compare-and-set, so a second blind write could race again.
      audit(`permission-lower raced: device=${deviceId(callingDeviceId)} session=${address.id} from=${before} to=${preset} observed=${after ?? 'unknown'}`)
      return { kind: 'permission-lower', sessionId: address.id, currentValue: after ?? null, accepted: false, reason: 'raced' }
    }
    // Audit: device, session, both preset names and both knob pairs — never command text.
    audit(`permission-lower accepted: device=${deviceId(callingDeviceId)} session=${address.id} from=${from}(${livePair.sandbox}/${livePair.approval}) to=${preset}(${to.sandbox}/${to.approval})`)
    return { kind: 'permission-lower', sessionId: address.id, preset, currentValue: after, accepted: true }
  }

  /** Fail closed for a connection that has no Peer to run the resolution on.
   * @param {object} msg the frame, for its session id and type */
  const unavailable = (msg) => refusal('unavailable', msg?.type === 'permission-options' ? 'permission-options' : 'permission-lower', typeof msg?.sessionId === 'string' ? msg.sessionId.trim() || undefined : undefined)

  return { options, lower, unavailable, scope: PERMISSION_LOWER_SCOPE }
}
