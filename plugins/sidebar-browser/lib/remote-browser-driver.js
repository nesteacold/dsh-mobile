/**
 * Spec 016 Phase 3 / spec 014 C6 — drive the browser on the CLIENT machine.
 *
 * `./remote-scope.js` answers "is this session driven by a paired device, and may it
 * use the browser tools". It says nothing about WHERE the browser is. Until this module
 * existed the tools always drove the local sidebar tab, so an agent in a
 * remote-controlled session clicked on the Host owner's screen while the device's owner
 * watched nothing: the client machine's browser was never asked.
 *
 * The gateway half registers the service that can ask it (`plugins/mobile-gateway/lib/
 * remote-browser.mjs`, contract revision 10) under `remoteBrowser`:
 *
 *   targets(sessionId) -> [{ id, name, connected, capable, granted }]
 *   send(target, sessionId, op, args, signal) -> { ok: true, value }
 *                                              | { ok: false, error: { code, message } }
 *
 * `send` never throws and never rejects; every refusal is a contract §10.5 code. The
 * checks (offline, capability, scope, one command per device, deadline) all live there,
 * so this module holds no policy of its own: it maps one local driver operation onto one
 * `browser-command` and turns the refusal codes into sentences the model can act on.
 *
 * Two contract differences shape the mapping and are refused rather than papered over:
 * the client browser addresses elements by CSS selector (there is no `data-dsh-idx`
 * numbering over there), and it answers exactly `BROWSER_OPS` — no `eval`, no history,
 * no sidebar.
 *
 * @module @dsh-ext/sidebar-browser/remote-browser-driver
 */

/** Service key the gateway half registers (spec 016). */
export const REMOTE_BROWSER_SERVICE = 'remoteBrowser'

/**
 * The switch the client's owner flips, verbatim from `plugins/devices/lib/client.js`
 * (`browserAgentConsent`). Quoted in the error text so the answer names the exact
 * control the owner has to find.
 */
export const CLIENT_BROWSER_SWITCH = 'Allow this host to drive a browser on this machine'

const NEEDS_SWITCH =
  `The owner of that machine must enable "${CLIENT_BROWSER_SWITCH}" there (the "Browser (agent)" tab), then retry.`

/** A refusal the gateway or the client wrote, carried as one model-facing sentence. */
export class RemoteBrowserError extends Error {
  /**
   * @param {string} code contract `browser/…` code (or `browser/unusable` for this module).
   * @param {string} message the sentence the model sees.
   * @param {{pageDerived?: boolean}} [options] true when the text came from the page.
   */
  constructor (code, message, { pageDerived = false } = {}) {
    super(message)
    this.name = 'RemoteBrowserError'
    this.code = code
    this.pageDerived = pageDerived
  }
}

/**
 * The gateway's or client's own detail, quoted and attributed.
 *
 * The named codes below are this module's own sentences, but `detail` is written by the
 * other end and can relay page text (a script that threw, a selector a page refused).
 * `JSON.stringify` keeps it inside one quoted aside on one line and escapes line breaks,
 * so a misbehaving client cannot make page text read as trusted prose of this plugin.
 * @param {string} detail the gateway's or client's own message.
 */
function detailText (detail) {
  const text = String(detail ?? '').trim()
  return text === '' ? '' : ` (client said: ${JSON.stringify(text)})`
}

/**
 * Sentence for one `browser-result` refusal. The detail travels with it: it is the only
 * place the gateway's own reason (which device, which deadline) survives.
 * @param {string} code contract `browser/…` code.
 * @param {string} detail the gateway's or client's own message.
 */
function refusal (code, detail) {
  const why = detailText(detail)
  switch (code) {
    case 'browser/offline':
      return new RemoteBrowserError(code,
        `the machine this session is driven from is not connected right now${why}, so its browser cannot be driven. `
        + 'Reconnect it (open the companion app there) and retry.')
    case 'browser/not-supported':
      // Two sources: no capability advertised, or the `host` target asked for over the wire.
      return new RemoteBrowserError(code,
        `the client machine has no browser an agent may drive${why}. ${NEEDS_SWITCH}`)
    case 'browser/denied':
      return new RemoteBrowserError(code, `the owner of that machine has not allowed it${why}. ${NEEDS_SWITCH}`)
    case 'browser/forbidden-scope':
      return new RemoteBrowserError(code,
        `this device does not hold the "browser:control" scope${why}, so it may not be driven. `
        + 'Grant that scope to the device (plugins/devices permission UI) and retry.')
    case 'browser/timeout':
      return new RemoteBrowserError(code, `the client machine did not answer in time${why}. Check that it is awake and retry.`)
    case 'browser/busy':
      return new RemoteBrowserError(code, `another browser command is still running on that machine${why}. Retry in a moment.`)
    case 'browser/cancelled':
      return new RemoteBrowserError(code, `the browser command was cancelled on the client machine${why}.`)
    case 'browser/frame-too-large':
      return new RemoteBrowserError(code, `the result does not fit one browser frame${why}. Ask for less (a smaller max, or the snapshot).`)
    case 'browser/unknown-target':
      return new RemoteBrowserError(code, `no paired device answers to that id${why}.`)
    default:
      // `browser/bad-request`, `browser/not-found` and any client-specific code: the text
      // can be the page's own (a script that threw, a refused element selector).
      return new RemoteBrowserError(code === '' ? 'browser/bad-request' : code,
        `the client machine refused the browser command${why}`, { pageDerived: true })
  }
}

/** The session id the gateway keys its driver records by, from a DSH session object. */
export function sessionIdOf (session) {
  for (const value of [session?.id, session?.sessionId, session?.header?.id]) {
    if (typeof value === 'string' && value.trim() !== '') return value.trim()
  }
  return undefined
}

// Its own code, not `browser/not-supported`: that one means "this machine has no browser
// an agent may drive" and is answered with the owner's switch, which is the wrong advice
// for an operation the client browser simply does not implement.
const unsupported = (what, how) => new RemoteBrowserError('browser/unsupported',
  `the client machine's agent browser cannot ${what}. ${how}`)

/**
 * Map one local driver operation onto its `browser-command` arguments.
 *
 * The client browser has no element numbering and no `selectAll`: a local-only argument
 * is refused with the sentence that says what to send instead, never silently ignored —
 * an ignored `index` would click whatever sits at the origin of the client's page.
 */
function clickArgs (args = {}) {
  if (args.double === true) {
    throw unsupported('double-click', 'Send internal_browser_click twice, or drive a local session.')
  }
  const selector = typeof args.selector === 'string' ? args.selector.trim() : ''
  if (selector === '') {
    throw new RemoteBrowserError('browser/bad-request',
      'the client machine\'s agent browser addresses elements by CSS selector, not by element number. '
      + 'Run internal_browser_snapshot there and pass the element as "selector".')
  }
  return { selector }
}

function typeArgs (args = {}) {
  if (args.replace === true) {
    throw unsupported('replace the existing value', 'Click the field with a "selector" first, then type without "replace".')
  }
  const selector = typeof args.selector === 'string' ? args.selector.trim() : ''
  return selector === '' ? { text: args.text } : { text: args.text, selector }
}

function scrollArgs (args = {}) {
  const step = Math.abs(Number(args.amount ?? 600)) || 600
  // A wheel event, not a scrollTo: top/bottom are one huge notch, which the browser clamps.
  const deltaY = args.direction === 'up' ? -step
    : args.direction === 'down' ? step
      : args.direction === 'top' ? -1_000_000
        : 1_000_000
  return { deltaY }
}

/**
 * The remote driver: the same operation surface the local sidebar driver exposes, each
 * one a single `browser-command` at the device that drove this session.
 *
 * @param {object} options
 * @param {(key: string) => unknown} [options.get] `ctx.get`, to find the service.
 * @param {object} [options.session] `exec.agent.session`.
 * @param {string|null} [options.deviceId] the device `remoteScopeOf` reported.
 * @param {AbortSignal} [options.signal] cancels the command on the client too.
 * @returns {object|null} the driver, or null when no `remoteBrowser` service is mounted.
 *   The caller must NOT read null as "drive locally": on a session the gateway reports as
 *   remote it is the M1 refusal (there is no way to ask the client machine).
 */
export function createRemoteDriver ({ get, session, deviceId, signal } = {}) {
  const service = typeof get === 'function' ? get(REMOTE_BROWSER_SERVICE) : undefined
  if (service === undefined || service === null) return null

  // `auto` is the contract's "the device that prompted this session"; it is the right
  // default when a gateway reports a remote session without naming the device.
  const target = typeof deviceId === 'string' && deviceId !== '' ? deviceId : 'auto'
  const sessionId = sessionIdOf(session)

  const call = async (op, args) => {
    if (typeof service.send !== 'function') {
      throw new RemoteBrowserError('browser/unusable',
        'the gateway mounted a remoteBrowser service this plugin cannot call (no send method), so the client browser cannot be driven.')
    }
    let answer
    try {
      answer = await service.send(target, sessionId, op, args, signal)
    } catch (error) {
      // `send` is documented never to throw; a throwing service is a transport failure.
      throw refusal('browser/offline', String(error?.message ?? error))
    }
    if (answer?.ok === true) return answer.value
    const error = answer?.error ?? {}
    throw refusal(typeof error.code === 'string' ? error.code : '', String(error.message ?? ''))
  }

  return {
    kind: 'remote',
    /** The contract target this driver addresses (`<deviceId>` or `auto`). */
    target,
    sessionId,
    /** Every target the gateway offers, for a caller that wants to name one. */
    targets: () => (typeof service.targets === 'function' ? service.targets(sessionId) : []),
    navigate: (args = {}) => call('navigate', { url: args.url }),
    click: (args) => call('click', clickArgs(args)),
    type: (args) => call('type', typeArgs(args)),
    press: (args = {}) => call('press', { key: args.key }),
    scroll: (args) => call('scroll', scrollArgs(args)),
    // `close` with no tabId closes the tab the client's agent drives (its `pageTargetId`).
    open: (args = {}) => call('open', args.url === undefined ? {} : { url: args.url }),
    close: (args = {}) => call('close', args.tabId === undefined ? {} : { tabId: args.tabId }),
    snapshot: () => call('snapshot', {}),
    text: () => call('text', {}),
    html: () => call('html', {}),
    screenshot: () => call('screenshot', {}),
    tabs: () => call('tabs', {}),
    /** Operations the client browser does not implement (contract `BROWSER_OPS`). */
    unsupported: (op, how) => {
      throw unsupported(op, how)
    },
  }
}

/**
 * Translate one failure the remote path raised. Anything else stays as it is, so a bug
 * in this plugin keeps its own stack instead of being relabelled as a browser refusal.
 * @param {unknown} error whatever the tool body threw.
 * @returns {string|null} the sentence, or null when this is not a remote failure.
 */
export function remoteFailureText (error) {
  return error instanceof RemoteBrowserError ? error.message : null
}

/** True when the failure text came from the page (C4/M2: then it is data, not an instruction). */
export const remoteFailureIsPageDerived = (error) => error instanceof RemoteBrowserError && error.pageDerived
