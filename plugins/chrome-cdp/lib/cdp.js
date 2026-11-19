/**
 * Pure pieces of the Chrome CDP half: the endpoint rule, the result envelope, the risk
 * sentences and the page-side snippet that numbers the interactive elements.
 *
 * Everything here is a plain function so the specs can pin it without a Chrome process,
 * a DSH Host or a DOM. The transport lives in `./cdp-client.js`; the tools and the routes
 * live in `./index.js`.
 *
 * @module @dsh-ext/chrome-cdp/cdp
 */
import os from 'node:os'
import { snapshotExpression as buildSnapshotExpression } from './snapshot-script.js'

/** Default CDP HTTP endpoint (the owner's Chrome on this machine, spec 035 Problem). */
export const DEFAULT_ENDPOINT = 'http://127.0.0.1:40222'

/** The port the owner's own Chrome listens on; a test process never contacts it. */
export const OWNER_CHROME_PORT = 40222

/** HTTP ports a URL leaves implicit. */
const DEFAULT_PORTS = { 'http:': 80, 'https:': 443 }

/** Hosts a CDP endpoint may name: a loopback literal, never a name that could resolve elsewhere (R1). */
const LOOPBACK_HOSTS = new Set(['127.0.0.1', '::1', 'localhost'])

/** How long a tab stays leased to the session that acted on it, in milliseconds (R4). */
export const LEASE_MS = 60_000

/** The permission preset the composer labels "Full access" (same rule as sidebar-browser C2a, R7). */
export const FULL_ACCESS_PRESET = 'danger-full-access'

/** Tool name prefix; the suffix names the action (R2). */
export const TOOL_PREFIX = 'chrome_'

/** Tools that change the page, so they carry the R7 risk declaration. */
export const MUTATING = new Set(['open', 'click', 'fill', 'key', 'close_tab'])

/** Tools that only read; they never ask (R7). */
export const READ_ONLY = new Set(['status', 'tabs', 'snapshot', 'screenshot'])

/** Routes the sidebar tab's host half talks to (R12). */
export const BRIDGE_PREFIX = '/dsh-chrome-cdp'

/** Header carrying the per-start bridge secret (R12). */
export const SECRET_HEADER = 'x-dsh-chrome-cdp-secret'

/** Page global the secret is injected under, for the owner's page only (R12). */
export const GLOBAL_KEY = '__DSH_CHROME_CDP__'

/** `targetId`s go to a WebSocket URL and a route; a CDP id is an opaque hex string. */
const TARGET_ID = /^[A-Za-z0-9._-]{1,128}$/

/**
 * Validate `config.endpoint` (R1).
 *
 * The host must be a loopback literal: `127.0.0.1`, `::1` or `localhost`. Any other host is
 * refused — a CDP endpoint is a remote-control channel for the owner's browser, and this
 * plugin never reaches one that is not this machine. Errors name the value and the reason,
 * so a misconfigured Host says why at activation instead of failing on the first tool call.
 *
 * @param {unknown} raw - the configured value; empty or absent means the default.
 * @returns {{url: string, host: string, port: number}} normalized endpoint parts.
 * @throws {TypeError} when the value is not a loopback http(s) URL.
 */
export function parseEndpoint (raw) {
  const text = raw === undefined || raw === null || raw === '' ? DEFAULT_ENDPOINT : raw
  if (typeof text !== 'string' || text.trim() === '') {
    throw new TypeError('@dsh-ext/chrome-cdp: config.endpoint must be a non-empty URL string')
  }
  let url
  try {
    url = new URL(text.trim())
  } catch {
    throw new TypeError(`@dsh-ext/chrome-cdp: config.endpoint "${text}" is not an absolute URL (expected http://127.0.0.1:<port>)`)
  }
  if (url.protocol !== 'http:' && url.protocol !== 'https:') {
    throw new TypeError(`@dsh-ext/chrome-cdp: config.endpoint "${text}" must use http or https, not "${url.protocol}"`)
  }
  if (url.username !== '' || url.password !== '' || url.search !== '' || url.hash !== '') {
    throw new TypeError(`@dsh-ext/chrome-cdp: config.endpoint "${text}" must be a bare origin (no credentials, query or fragment)`)
  }
  // URL lowercases the host and normalizes exotic IPv4 spellings (0x7f000001, 2130706433) to
  // dotted form; its IPv6 hostname keeps the brackets, which are stripped here.
  let host = url.hostname.toLowerCase()
  if (host.startsWith('[') && host.endsWith(']')) host = host.slice(1, -1)
  if (!LOOPBACK_HOSTS.has(host)) {
    throw new TypeError(
      `@dsh-ext/chrome-cdp: config.endpoint "${text}" names "${host}", which is not loopback. `
      + 'The Chrome CDP endpoint must be 127.0.0.1, ::1 or localhost: CDP is never exposed beyond this machine (spec 035 R1).',
    )
  }
  if (url.pathname !== '/' && url.pathname !== '') {
    throw new TypeError(`@dsh-ext/chrome-cdp: config.endpoint "${text}" must not carry a path; give the origin only, e.g. http://127.0.0.1:40222`)
  }
  const port = url.port === '' ? DEFAULT_PORTS[url.protocol] : Number(url.port)
  if (!Number.isInteger(port) || port <= 0 || port > 65535) {
    throw new TypeError(`@dsh-ext/chrome-cdp: config.endpoint "${text}" has no usable port`)
  }
  const authority = host === '::1' ? '[::1]' : host
  return { url: `${url.protocol}//${authority}:${port}`, host, port }
}

/**
 * A `targetId` from a model argument, or a refusal. Ids cross into a WebSocket URL and a route, so
 * a malformed one is refused here instead of being interpolated (R5: only a named target closes).
 * @param {unknown} value - the argument.
 * @returns {string} the id.
 */
export function targetIdOf (value) {
  if (typeof value !== 'string' || !TARGET_ID.test(value)) {
    throw new Error('argument "targetId" must be the id of a Chrome target, as chrome_tabs lists it')
  }
  return value
}

/** This machine's name, for the execution host every result states (R2). */
export const executionHost = () => os.hostname()

/**
 * The envelope every result starts with (R2): browser, execution host, endpoint, connection.
 * @param {object} state - plugin state built by `apply`.
 * @param {'ready'|'unreachable'} connection - last known connection state.
 */
export function resultHeader (state, connection) {
  return [
    'browser    : Chrome (CDP)',
    `host       : ${executionHost()}`,
    `endpoint   : ${state.endpoint.url}`,
    `connection : ${connection}`,
  ].join('\n')
}

/** The R9 sentence for an endpoint nothing answers. It never mentions the sidebar Browser. */
export function unreachableText (state) {
  return `Chrome CDP not reachable at ${state.endpoint.url} on ${executionHost()}; `
    + 'start Chrome with --remote-debugging-port or fix config'
}

/** One tab as a list shows it; the bound tab carries the star (R4). */
export const describeTab = (tab, currentId) => {
  const mark = tab.id === currentId ? '*' : ' '
  return `  ${mark} ${tab.id}  ${(tab.title || '').slice(0, 60)}  ${String(tab.url ?? '').slice(0, 90)}`
}

/**
 * One audited sentence for a mutating call (R7). Arguments are untrusted shapes here: a
 * prompt sentence must never throw on one, because a throw would fail a call the user could
 * have approved.
 * @param {object} state - for the bound tab.
 * @param {string} action - tool-name suffix.
 * @param {object} [rawArgs] - the model's arguments.
 * @param {string} [sessionId] - whose binding is quoted.
 */
export function describeCall (state, action, rawArgs, sessionId) {
  const args = rawArgs !== null && typeof rawArgs === 'object' ? rawArgs : {}
  const tab = state.bindingFor(sessionId)
  const where = tab === undefined ? 'a Chrome tab' : `Chrome tab ${tab.targetId}${tab.url ? ` (${tab.url})` : ''}`
  switch (action) {
    case 'open': return args.url
      ? `open a Chrome tab at ${args.url}`
      : 'open a blank Chrome tab'
    case 'click': return `click element [${args.index ?? '?'}] on ${where}`
    case 'fill': return `type ${String(args.text ?? '').length} character(s) into element [${args.index ?? '?'}] on ${where}`
    case 'key': return `press ${args.key} on ${where}`
    case 'close_tab': return `close ${args.targetId ? `Chrome tab ${args.targetId}` : 'a Chrome tab'}`
    default: return `${action} on ${where}`
  }
}

/**
 * The element-snapshot expression (R3) one document runs, from its own module. Frame
 * traversal is the Host's: each document answers for itself and the Host merges.
 * @param {number|null} reuseMs - how long one numbering pass stays valid.
 * @returns {string} one JavaScript expression.
 */
export function snapshotExpression (reuseMs) {
  return buildSnapshotExpression(reuseMs)
}

/**
 * What a click or fill did, as the model reads it (R6): the element's tag, kind and label
 * are page data, so this sentence never leaves the untrusted block. Only the host's own
 * number and frame name are outside it.
 * @param {string} verb - `clicked` or `typed`.
 * @param {number} index - the snapshot number the action named.
 * @param {object} hit - the element the page-side lookup returned.
 * @returns {string} one line with page text in it.
 */
export function actionSummary (verb, index, hit) {
  const element = hit !== null && typeof hit === 'object' ? hit : {}
  const tag = String(element.tag ?? 'element').slice(0, 40)
  const kind = element.type ? `[${String(element.type).slice(0, 40)}]` : ''
  const text = String(element.text ?? '').slice(0, 60)
  return `${verb} element [${Number(index)}]: <${tag}${kind}> "${text}" (frame: ${String(element.frame ?? 'unknown')})`
}

/**
 * The expression that resolves one numbered element to a viewport coordinate inside the frame
 * whose snapshot printed that number, with that document's own viewport size (the Host maps
 * the point through each frame owner's content quad with it). Click and fill address elements
 * this way, never by a screen coordinate (R3).
 * @param {number} index - element number from a snapshot.
 */
export function elementRectExpression (index) {
  const n = Number(index)
  return `(() => {
  const el = document.querySelector('[data-chrome-cdp-index="${Number.isInteger(n) ? n : -1}"]')
  if (!el) return null
  el.scrollIntoView({ block: 'center', inline: 'center', behavior: 'instant' })
  const rect = el.getBoundingClientRect()
  if (rect.width < 1 || rect.height < 1) return null
  const type = el.getAttribute('type')
  // A password field reports its type and nothing about its value (R8): the caller refuses it,
  // and the description the action result prints comes from the attributes alone.
  const password = String(type || '').toLowerCase() === 'password'
  const text = password ? '' : String(el.innerText || el.value || el.getAttribute('aria-label') || '')
  return { x: Math.round(rect.x + rect.width / 2), y: Math.round(rect.y + rect.height / 2),
    innerWidth: window.innerWidth, innerHeight: window.innerHeight,
    tag: el.tagName.toLowerCase(), type: type === null ? undefined : type,
    text: text.trim().slice(0, 60) }
})()`
}

/** Keys the `chrome_key` tool accepts, and what `Input.dispatchKeyEvent` needs for each. */
export const KEYS = Object.freeze({
  Enter: { key: 'Enter', code: 'Enter', keyCode: 13 },
  Tab: { key: 'Tab', code: 'Tab', keyCode: 9 },
  Escape: { key: 'Escape', code: 'Escape', keyCode: 27 },
  Backspace: { key: 'Backspace', code: 'Backspace', keyCode: 8 },
  Delete: { key: 'Delete', code: 'Delete', keyCode: 46 },
  ArrowUp: { key: 'ArrowUp', code: 'ArrowUp', keyCode: 38 },
  ArrowDown: { key: 'ArrowDown', code: 'ArrowDown', keyCode: 40 },
  ArrowLeft: { key: 'ArrowLeft', code: 'ArrowLeft', keyCode: 37 },
  ArrowRight: { key: 'ArrowRight', code: 'ArrowRight', keyCode: 39 },
  Home: { key: 'Home', code: 'Home', keyCode: 36 },
  End: { key: 'End', code: 'End', keyCode: 35 },
  PageUp: { key: 'PageUp', code: 'PageUp', keyCode: 33 },
  PageDown: { key: 'PageDown', code: 'PageDown', keyCode: 34 },
  ' ': { key: ' ', code: 'Space', keyCode: 32 },
})
