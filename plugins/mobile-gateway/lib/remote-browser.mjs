/**
 * Spec 016 Phase 3 / spec 014 C6 — the host drives a browser on the paired CLIENT.
 *
 * Two host services live here, both small and both dependency-injected so they can be
 * tested without a socket, a registry file or a timer:
 *
 * - `remoteSessionScope` (spec 014 C6 contract): `describe(session)` says whether the
 *   session is driven by a paired device and which scopes that device holds. It is the
 *   seam `plugins/sidebar-browser` reads with `ctx.get('remoteSessionScope')`
 *   (`lib/remote-scope.js` there), and the reason the gateway has to remember WHO
 *   prompted a session: DSH 0.2.2-rc.1 carries no client identity on the tool path.
 * - `remoteBrowser` (spec 016): `targets(sessionId)` and `send(target, sessionId, op,
 *   args, signal)` — the host→client `browser-command` channel of contract revision 10.
 *
 * Why the driver bookkeeping is a heuristic: the gateway sees every prompt that goes
 * through IT (the remote bridge's `session/prompt`, the companion `message` op) and every
 * prompt the Host runs (`session/event` `user/message`). A prompt it did not proxy is the
 * local owner's. A session it has no record of at all answers "remote" — spec 014 C6 says
 * an undeterminable origin is treated as remote, so the failure mode is a missing
 * permission, never a granted one.
 *
 * @module @dsh-ext/mobile-gateway/remote-browser
 */

import * as contract from './vendor/mobile-protocol.mjs'

/** ctx key of the browser service (spec 016). */
export const REMOTE_BROWSER_SERVICE = 'remoteBrowser'
/** ctx key of the driver-scope service (spec 014 C6). */
export const REMOTE_SESSION_SCOPE_SERVICE = 'remoteSessionScope'
/** The `target` value that means "the local owner's own browser". */
export const HOST_TARGET = 'host'

const SCOPE = contract.BROWSER_CONTROL_SCOPE

/** A device prompt is matched to the `user/message` event it causes within this window. */
const PROMPT_PENDING_MS = 30_000
/** How long a recorded prompt keeps naming the driver of its session. */
const DRIVER_TTL_MS = 12 * 60 * 60 * 1000

const isRecord = (value) => typeof value === 'object' && value !== null && !Array.isArray(value)

const browserRefusal = (code, message) => ({ ok: false, error: { code, message } })

/**
 * The id a driver record is keyed by, from whatever a caller has: a DSH session object
 * (`session.id`), a plain row (`sessionId`), a bare id, or nothing.
 *
 * @param {unknown} session
 * @returns {string|undefined}
 */
export function sessionIdOf(session) {
  if (typeof session === 'string') {
    const id = session.trim()
    return id === '' ? undefined : id
  }
  if (!isRecord(session)) return undefined
  for (const value of [session.sessionId, session.id, session.header?.id, session.session?.id]) {
    if (typeof value === 'string' && value.trim() !== '') return value.trim()
  }
  return undefined
}

/** The live device record a caller was paired as, or `null`. */
const liveDevice = (getDevice, deviceId) => {
  if (typeof getDevice !== 'function' || typeof deviceId !== 'string' || deviceId === '') return null
  let device
  try { device = getDevice(deviceId) } catch { device = undefined }
  if (!isRecord(device)) return null
  // A revoked record is not a device any more: nothing may be recorded against it.
  return device.revokedAt ? null : device
}

const holdsBrowserScope = (device) => Array.isArray(device?.scopes) && device.scopes.includes(SCOPE)

/**
 * Per-session "who prompted it last" memory, and the `remoteSessionScope` service built
 * on it.
 *
 * @param {object} deps
 * @param {(deviceId: string) => any} deps.getDevice live registry record (scopes/kind)
 * @param {() => number} [deps.now]
 * @param {number} [deps.promptPendingMs]
 * @param {number} [deps.ttlMs]
 */
export function createSessionDriver(deps = {}) {
  const getDevice = deps.getDevice
  const now = typeof deps.now === 'function' ? deps.now : Date.now
  const promptPendingMs = Number.isSafeInteger(deps.promptPendingMs) && deps.promptPendingMs > 0
    ? deps.promptPendingMs : PROMPT_PENDING_MS
  const ttlMs = Number.isSafeInteger(deps.ttlMs) && deps.ttlMs > 0 ? deps.ttlMs : DRIVER_TTL_MS

  /** @type {Map<string, {deviceId: string|null, at: number, pending: number}>} */
  const drivers = new Map()

  const fresh = (sessionId) => {
    const entry = drivers.get(sessionId)
    if (entry === undefined) return undefined
    if (now() - entry.at > ttlMs) {
      drivers.delete(sessionId)
      return undefined
    }
    return entry
  }
  const forget = (sessionId) => { drivers.delete(sessionId) }
  const record = (sessionId, deviceId) => {
    const id = typeof sessionId === 'string' ? sessionId.trim() : ''
    if (id === '') return false
    const previous = fresh(id)
    // A device prompt owes one `user/message` event; a local prompt never does. Two
    // prompts from the same device in a row owe two, so the count carries over.
    const owed = previous !== undefined && previous.deviceId === deviceId ? previous.pending : 0
    drivers.set(id, { deviceId, at: now(), pending: deviceId === null ? 0 : owed + 1 })
    return true
  }

  return {
    /** A prompt this gateway forwarded from a paired device. */
    noteDevicePrompt(sessionId, deviceId) {
      if (typeof deviceId !== 'string' || deviceId === '') return false
      // A revoked device's prompt must not keep naming it as the driver.
      if (liveDevice(getDevice, deviceId) === null) return false
      return record(sessionId, deviceId)
    },
    /** A prompt the gateway saw the Host run without proxying it (the local owner's UI). */
    noteLocalPrompt(sessionId) {
      return record(sessionId, null)
    },
    /**
     * A `user/message` session event. It is the prompt a device just sent through this
     * gateway, or — when no device prompt is outstanding — the local owner's.
     */
    noteUserMessage(sessionId) {
      const id = typeof sessionId === 'string' ? sessionId.trim() : ''
      if (id === '') return false
      const entry = fresh(id)
      if (entry && entry.deviceId !== null && entry.pending > 0 && now() - entry.at <= promptPendingMs) {
        // The event is the device prompt surfacing: keep the attribution, owe one fewer.
        drivers.set(id, { ...entry, at: now(), pending: entry.pending - 1 })
        return true
      }
      return record(id, null)
    },
    /** The last driver of a session: `{ deviceId: null }` for the local owner, or undefined. */
    last(sessionId) {
      const id = typeof sessionId === 'string' ? sessionId.trim() : ''
      if (id === '') return undefined
      const entry = fresh(id)
      return entry === undefined ? undefined : { deviceId: entry.deviceId, at: entry.at }
    },
    /**
     * The `remoteSessionScope` service body (spec 014 C6 + the sidebar-browser README).
     * `driven: 'local'` needs no scope; `driven: 'remote'` carries the device's live
     * scopes; an undeterminable origin answers remote with no scopes (fail closed).
     */
    describe(session) {
      const sessionId = sessionIdOf(session)
      if (sessionId === undefined) return { driven: 'remote' }
      const entry = fresh(sessionId)
      if (entry === undefined) return { driven: 'remote' }
      if (entry.deviceId === null) return { driven: 'local' }
      const device = liveDevice(getDevice, entry.deviceId)
      if (device === null) return { driven: 'remote', deviceId: entry.deviceId, scopes: [] }
      return {
        driven: 'remote',
        deviceId: entry.deviceId,
        scopes: Array.isArray(device.scopes) ? [...device.scopes] : [],
      }
    },
    forget,
    clear() { drivers.clear() },
    get size() { return drivers.size },
  }
}

/**
 * The `remoteBrowser` service (contract revision 10).
 *
 * Every check the contract makes mandatory happens here, in the contract's order, before
 * a frame reaches a device — and again when its answer arrives, because a revocation or a
 * scope removal must bite immediately, not at the next call.
 *
 * @param {object} deps
 * @param {(deviceId: string) => any} deps.getDevice live registry record
 * @param {() => any[]} deps.listDevices every paired record (public shape)
 * @param {() => Iterable<object>} deps.listClients live connections (`deviceId`, `readyState`, `send`)
 * @param {object} deps.sessionDriver the driver used for `auto` and `targets`
 * @param {(line: string) => void} [deps.log]
 * @param {string} [deps.hostName] name shown for the `host` target
 * @param {() => number} [deps.now]
 * @param {(fn: () => void, ms: number) => any} [deps.setTimer] test seam (default setTimeout)
 * @param {(timer: any) => void} [deps.clearTimer]
 */
export function createRemoteBrowser(deps) {
  const log = typeof deps.log === 'function' ? deps.log : () => {}
  const getDevice = deps.getDevice
  const listDevices = typeof deps.listDevices === 'function' ? deps.listDevices : () => []
  const listClients = typeof deps.listClients === 'function' ? deps.listClients : () => []
  const driver = deps.sessionDriver
  const hostName = typeof deps.hostName === 'string' && deps.hostName.trim() !== '' ? deps.hostName : 'This machine'
  const setTimer = typeof deps.setTimer === 'function' ? deps.setTimer : (fn, ms) => setTimeout(fn, ms)
  const clearTimer = typeof deps.clearTimer === 'function' ? deps.clearTimer : (timer) => clearTimeout(timer)

  /** commandId → pending entry; `byDevice` enforces one in flight per device. */
  const byCommand = new Map()
  const byDevice = new Map()

  const clientsOf = (deviceId) => {
    const ready = []
    try {
      for (const client of listClients()) {
        if (client?.deviceId === deviceId && client.readyState === 1) ready.push(client)
      }
    } catch { /* a broken enumeration is "no connection" */ }
    return ready
  }
  const capabilitiesOf = (deviceId) => {
    for (const client of clientsOf(deviceId)) {
      const advertised = client.clientHello?.capabilities
      if (Array.isArray(advertised) && advertised.includes(contract.BROWSER_AGENT_CAPABILITY)) return true
    }
    return false
  }

  /** Every target the caller may choose, host first, then devices (the auto one first). */
  function targets(sessionId) {
    const rows = [{ id: HOST_TARGET, name: hostName, connected: true, capable: true, granted: true }]
    const preferred = driver?.last?.(sessionId)?.deviceId ?? null
    const devices = []
    let records = []
    try { records = Array.isArray(listDevices()) ? listDevices() : [] } catch { records = [] }
    for (const device of records) {
      if (!isRecord(device) || typeof device.id !== 'string' || device.id === '') continue
      devices.push({
        id: device.id,
        name: typeof device.name === 'string' && device.name !== '' ? device.name : device.id,
        connected: clientsOf(device.id).length > 0,
        capable: capabilitiesOf(device.id),
        granted: !device.revokedAt && holdsBrowserScope(liveDevice(getDevice, device.id)),
      })
    }
    // The device that prompted this session is the `auto` candidate: list it first.
    devices.sort((left, right) => (right.id === preferred ? 1 : 0) - (left.id === preferred ? 1 : 0))
    return [...rows, ...devices]
  }

  /** `{ kind: 'host' } | { kind: 'device', deviceId } | { error }`. */
  function resolveTarget(target, sessionId) {
    let requested = typeof target === 'string' ? target.trim() : ''
    if (requested === 'auto') {
      const last = driver?.last?.(sessionId)?.deviceId
      requested = typeof last === 'string' && last !== '' ? last : HOST_TARGET
    }
    if (requested === '' || requested === 'local') requested = HOST_TARGET
    if (requested === HOST_TARGET) {
      // The gateway cannot drive the Host's own browser; the caller does that locally.
      return { error: browserRefusal('browser/not-supported', 'the host target is driven locally, not over the gateway') }
    }
    if (liveDevice(getDevice, requested) === null) {
      return { error: browserRefusal('browser/unknown-target', 'no paired device has this id') }
    }
    return { kind: 'device', deviceId: requested }
  }

  /** Text/html results are cut host-side too: the client's word is not the bound. */
  const normalizeResult = (result) => {
    if (!isRecord(result)) return result
    let out = result
    for (const key of ['text', 'html']) {
      if (typeof result[key] !== 'string') continue
      const cut = contract.truncateBrowserText(result[key])
      if (!cut.truncated) continue
      if (out === result) out = { ...result }
      out[key] = cut.text
      out.truncated = true
    }
    return out
  }

  function commandFrame(commandId, sessionId, op, args, deadlineMs) {
    // Contract §10.2 — kind (host frame), commandId, sessionId, op, args, deadlineMs.
    return { kind: 'browser-command', commandId, sessionId, op, args, deadlineMs }
  }

  function cancelFrame(commandId) {
    return { kind: 'browser-cancel', commandId }
  }

  let sequence = 0
  const nextCommandId = () => {
    sequence += 1
    return `b${Date.now().toString(36)}-${sequence.toString(36)}`
  }

  /**
   * Drive the target: resolve, check, send one `browser-command`, wait for its result.
   *
   * Never throws and never rejects: a refusal is `{ ok: false, error: { code, message } }`
   * with one of the contract §10.5 codes.
   *
   * @param {string} target `auto` | `host` | `<deviceId>`
   * @param {string} sessionId the session whose agent asks
   * @param {string} op one of `contract.BROWSER_OPS`
   * @param {object} [args]
   * @param {AbortSignal} [signal] cancels the command (the device is told)
   * @returns {Promise<{ok: true, value: unknown} | {ok: false, error: {code: string, message: string}}>}
   */
  function send(target, sessionId, op, args, signal) {
    const session = typeof sessionId === 'string' ? sessionId.trim() : ''
    if (session === '') return Promise.resolve(browserRefusal('browser/bad-request', 'sessionId is required'))
    if (typeof op !== 'string' || !contract.BROWSER_OPS.includes(op)) {
      return Promise.resolve(browserRefusal('browser/bad-request', 'op is not a browser operation'))
    }
    const commandArgs = args === undefined ? {} : args
    if (!isRecord(commandArgs)) return Promise.resolve(browserRefusal('browser/bad-request', 'args must be an object'))
    const resolved = resolveTarget(target, session)
    if (resolved.error) return Promise.resolve(resolved.error)
    const deviceId = resolved.deviceId
    const device = liveDevice(getDevice, deviceId)
    if (device === null) return Promise.resolve(browserRefusal('browser/unknown-target', 'no paired device has this id'))
    // Connected first: the capability is advertised on a live connection, so an offline
    // device cannot be judged "incapable" — it is simply not reachable right now.
    const clients = clientsOf(deviceId)
    if (clients.length === 0) return Promise.resolve(browserRefusal('browser/offline', 'this device is not connected'))
    if (!capabilitiesOf(deviceId)) {
      return Promise.resolve(browserRefusal('browser/not-supported', 'this device did not advertise browser-agent:1'))
    }
    if (!holdsBrowserScope(device)) {
      return Promise.resolve(browserRefusal('browser/forbidden-scope', 'the device needs the browser:control scope'))
    }
    if (byDevice.has(deviceId)) {
      return Promise.resolve(browserRefusal('browser/busy', 'another browser command is already in flight for this device'))
    }

    const commandId = nextCommandId()
    const deadlineMs = contract.BROWSER_DEADLINE_DEFAULT_MS
    const frame = commandFrame(commandId, session, op, commandArgs, deadlineMs)
    if (contract.browserFrameBytes(frame) > contract.BROWSER_FRAME_MAX_BYTES) {
      return Promise.resolve(browserRefusal('browser/frame-too-large',
        `a frame may not exceed ${contract.BROWSER_FRAME_MAX_BYTES} bytes`))
    }

    return new Promise((resolve) => {
      const entry = { commandId, deviceId, sessionId: session, op, done: false, timer: null, onAbort: null, resolve }
      const settle = (result) => {
        if (entry.done) return
        entry.done = true
        if (entry.timer !== null) clearTimer(entry.timer)
        if (entry.onAbort && typeof signal?.removeEventListener === 'function') {
          try { signal.removeEventListener('abort', entry.onAbort) } catch { /* an exotic signal */ }
        }
        if (byCommand.get(commandId) === entry) byCommand.delete(commandId)
        if (byDevice.get(deviceId) === entry) byDevice.delete(deviceId)
        resolve(result)
      }
      entry.settle = settle
      entry.fail = (code, message) => settle({ ok: false, error: { code, message } })
      byCommand.set(commandId, entry)
      byDevice.set(deviceId, entry)

      const tellDevice = (cancel) => {
        for (const client of clients) {
          try {
            if (typeof client.sendFrame === 'function') client.sendFrame(cancel)
            else client.send(JSON.stringify(cancel))
          } catch { /* a raced close: the deadline still settles this command */ }
        }
      }

      entry.timer = setTimer(() => {
        // Contract §10.4 rule 7: the host cancels before it gives up, so the client stops.
        tellDevice(cancelFrame(commandId))
        log(`browser command timed out: device=${deviceId} op=${op}`)
        entry.fail('browser/timeout', `the device did not answer within ${deadlineMs} ms`)
      }, deadlineMs)
      entry.timer?.unref?.()

      if (signal) {
        if (signal.aborted) {
          entry.fail('browser/cancelled', 'the command was cancelled before it was sent')
          return
        }
        entry.onAbort = () => {
          tellDevice(cancelFrame(commandId))
          entry.fail('browser/cancelled', 'the command was cancelled')
        }
        try { signal.addEventListener('abort', entry.onAbort, { once: true }) } catch { /* an exotic signal */ }
      }

      let sent = 0
      for (const client of clients) {
        try {
          if (typeof client.sendFrame === 'function') client.sendFrame(frame)
          else client.send(JSON.stringify(frame))
          sent += 1
        } catch { /* a raced close: another socket may still take it */ }
      }
      if (sent === 0) entry.fail('browser/offline', 'this device is not connected')
    })
  }

  /**
   * Route one client frame of this revision. Returns `true` when the frame was this
   * service's (handled or deliberately ignored), `false` when the caller must refuse it.
   *
   * @param {object} client the connection that sent it (`deviceId`, `readyState`)
   * @param {object} msg the parsed wire frame
   */
  function handleClientFrame(client, msg) {
    if (!isRecord(msg)) return false
    if (msg.type === 'browser-result') {
      const verdict = contract.validateBrowserResult(msg)
      if (!verdict.ok) {
        log(`browser-result refused: ${verdict.code}`)
        return true
      }
      const entry = byCommand.get(verdict.value.commandId)
      if (!entry || entry.done) {
        // Unknown, duplicate or already-settled id: never applied, never answered.
        log(`browser-result ignored: ${entry ? 'already settled' : 'unknown commandId'}`)
        return true
      }
      if (entry.deviceId !== client?.deviceId) {
        // One device may not answer another device's command.
        log(`browser-result ignored: command belongs to another device (${entry.commandId})`)
        return true
      }
      // Immediately: a revoked device, or a grant that went away mid-flight.
      const device = liveDevice(getDevice, entry.deviceId)
      if (device === null) {
        entry.fail('browser/offline', 'this device is no longer paired')
        return true
      }
      if (!holdsBrowserScope(device)) {
        entry.fail('browser/forbidden-scope', 'the device needs the browser:control scope')
        return true
      }
      if (verdict.value.ok) entry.settle({ ok: true, value: normalizeResult(verdict.value.result) })
      else entry.settle({ ok: false, error: verdict.value.error })
      return true
    }
    if (msg.type === 'browser-cancel') {
      const verdict = contract.validateBrowserCancel(msg)
      if (!verdict.ok) {
        log(`browser-cancel refused: ${verdict.code}`)
        return true
      }
      const entry = byCommand.get(verdict.value.commandId)
      if (entry && !entry.done && entry.deviceId === client?.deviceId) {
        entry.fail('browser/cancelled', 'the device cancelled this command')
      }
      return true
    }
    return false
  }

  /**
   * Cancel whatever this device has in flight. Called when its last connection closes
   * (every revoke/re-pair path closes the socket) and when a grant is removed.
   */
  function cancelDevice(deviceId, code = 'browser/offline', message = 'this device is no longer connected') {
    const entry = byDevice.get(deviceId)
    if (entry === undefined || entry.done) return false
    entry.fail(code, message)
    log(`browser command cancelled: device=${deviceId} reason=${code}`)
    return true
  }

  return {
    targets,
    send,
    handleClientFrame,
    cancelDevice,
    /** Teardown: nothing may outlive the plugin. */
    close() {
      for (const entry of [...byCommand.values()]) {
        if (!entry.done) entry.fail('browser/offline', 'the gateway is shutting down')
      }
      byCommand.clear()
      byDevice.clear()
    },
    get inFlight() { return byCommand.size },
  }
}

/**
 * Register a host service the way this repo's plugins do: try `ctx.set` (cordis creates
 * the service property), else `ctx.provide(name, value)`, else `ctx.provide(name)` and an
 * assignment. A Host that refuses all three must not take the gateway down with it, so the
 * failure is reported as `false` — the plugin's other routes keep working.
 *
 * @param {object} ctx the Cordis context of `apply()`
 * @param {string} name service key
 * @param {object} value service object
 * @returns {boolean} true when `ctx.get(name)` reads `value` back
 */
export function provideHostService(ctx, name, value) {
  if (!isRecord(ctx) && typeof ctx !== 'object') return false
  if (ctx === null) return false
  const reads = () => {
    try { return typeof ctx.get === 'function' ? ctx.get(name, false) === value : false } catch { return false }
  }
  const attempt = (fn, ...args) => {
    try { fn.apply(ctx, args); return true } catch { return false }
  }
  if (typeof ctx.set === 'function') {
    attempt(ctx.set, name, value)
    if (reads()) return true
  }
  if (typeof ctx.provide === 'function') {
    attempt(ctx.provide, name, value)
    if (reads()) return true
    attempt(ctx.provide, name)
    try { ctx[name] = value } catch { /* a frozen context */ }
    if (reads()) return true
  }
  return false
}
