// A browser on THIS machine that a paired host may drive (spec 016 Phase 3, contract
// revision 10). The Host half of @dsh-ext/devices runs it; the "Browser (agent)" tab
// only shows its screencast.
//
// Why a spawned Chromium rather than the native Browser tab: rc.1 attaches a
// `<webview>` only with a main-process lease (`main.js:18663`, `:20650`), so a plugin
// has no public scriptable guest. This module therefore owns an installed Chrome/Edge
// process — never a download — with:
//  - `--remote-debugging-pipe` and NO TCP port: the CDP transport is the child's fd 3
//    (commands) and fd 4 (responses), so nothing on this machine starts listening;
//  - its own `--user-data-dir` under the plugin's data directory, one per host, so the
//    agent's cookies never mix with the owner's browsers or another host's session;
//  - a kill switch (`close()`) and an idle shutdown, so a forgotten tab cannot leave a
//    browser running.
//
// Page policy: only http/https, and never a machine on this side of the network —
// loopback (`127.0.0.0/8`, `::1`, `::`, `*.localhost`), the private/link-local/CGNAT
// ranges, any IPv6 ULA or link-local address, and the DSH server's own origin (the
// plugin records it from the frame route's `Host`, plus any configured one).
//
// Checking the URL the caller sent is not enough: a 302, a script navigation or a
// `window.open` popup reaches an address the caller never named. So every attached
// target (the tab, and every auto-attached popup) runs `Fetch.enable` at the Request
// stage and each paused request is refused (`Fetch.failRequest BlockedByClient`) when
// its URL, or the addresses its host name resolves to, are out of policy. A name that
// resolves into a blocked range is the one case the browser cannot see (Chromium
// resolves it after this hook and DNS rebinding can change the answer later), so the
// name is pre-resolved here; the residual risk is documented in the README.
import { spawn as spawnChild } from 'node:child_process'
import dns from 'node:dns'
import fs from 'node:fs'
import http from 'node:http'
import net from 'node:net'
import path from 'node:path'

import { ensureOwnerOnlyDirectory } from './secure-file.mjs'

/** Contract 10.1: the capability a client lists in `client-hello` when it can answer. */
export const BROWSER_AGENT_CAPABILITY = 'browser-agent:1'

/** Contract 10.3: largest decoded screenshot (JPEG bytes, before base64). */
export const SCREENSHOT_MAX_BYTES = 768 * 1024

/** Contract 10.3: `text`/`html` are cut here and flagged `truncated`. */
export const TEXT_MAX_BYTES = 256 * 1024

/** How long an unused browser survives before it is closed on its own. */
export const IDLE_SHUTDOWN_MS = 120_000

/** How long one CDP command may take before it is reported as a timeout. */
const CDP_TIMEOUT_MS = 30_000

/** Largest accessibility outline `snapshot` returns (lines, before the byte cut). */
const SNAPSHOT_MAX_LINES = 400

const HOST_ID = /^[A-Za-z0-9-]{1,64}$/

/** A failure the wire can carry: `code` is a contract `browser/…` code. */
export class AgentBrowserError extends Error {
  constructor(code, message) {
    super(message)
    this.name = 'AgentBrowserError'
    this.code = code
  }
}

// ---------------------------------------------------------------------------
// The shared wire contract's validators/limits. Resolved lazily: a profile that
// installs this plugin on its own may not have the sibling package, and the
// module must still load (the caller then answers `browser/not-supported`).
// ---------------------------------------------------------------------------
let protocolPromise
export function loadProtocol() {
  if (!protocolPromise) {
    protocolPromise = import('@dsh-ext/mobile-protocol')
      .catch(() => import('../../../packages/mobile-protocol/src/index.mjs'))
      .catch((error) => {
        protocolPromise = undefined
        throw new AgentBrowserError('browser/not-supported', `the mobile protocol package is not installed (${error?.code ?? 'unresolved'})`)
      })
  }
  return protocolPromise
}

/** Cut `text` to `maxBytes` of UTF-8 without splitting a character (via the contract). */
export async function cutText(text, maxBytes = TEXT_MAX_BYTES) {
  const protocol = await loadProtocol()
  return protocol.truncateBrowserText(text, maxBytes)
}

// ---------------------------------------------------------------------------
// Finding an installed browser. Standard locations only; nothing is downloaded.
// ---------------------------------------------------------------------------

/** Candidate executables in the order tried, per platform. */
export function browserCandidates({ platform = process.platform, env = process.env } = {}) {
  if (platform === 'win32') {
    const roots = [env['PROGRAMFILES'], env['PROGRAMFILES(X86)'], env.LOCALAPPDATA].filter(Boolean)
    const out = []
    for (const root of roots) {
      out.push(path.join(root, 'Google', 'Chrome', 'Application', 'chrome.exe'))
      out.push(path.join(root, 'Microsoft', 'Edge', 'Application', 'msedge.exe'))
    }
    return out
  }
  if (platform === 'darwin') {
    return [
      '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome',
      '/Applications/Microsoft Edge.app/Contents/MacOS/Microsoft Edge',
      '/Applications/Chromium.app/Contents/MacOS/Chromium',
    ]
  }
  return [
    '/usr/bin/google-chrome',
    '/usr/bin/google-chrome-stable',
    '/usr/bin/chromium',
    '/usr/bin/chromium-browser',
    '/usr/bin/microsoft-edge',
    '/usr/bin/microsoft-edge-stable',
    '/usr/local/bin/google-chrome',
    '/usr/local/bin/chromium',
    // A PATH lookup: `spawn` resolves a bare name, and `exists` cannot see it.
    'google-chrome',
    'microsoft-edge',
  ]
}

/**
 * The browser to run: the configured path when it exists, else the first standard
 * candidate that exists. `undefined` when this machine has none — the caller says so
 * and never downloads one.
 */
export function findInstalledBrowser({ platform = process.platform, env = process.env, exists = fs.existsSync, configuredPath = '' } = {}) {
  if (typeof configuredPath === 'string' && configuredPath.trim()) {
    return exists(configuredPath.trim()) ? configuredPath.trim() : undefined
  }
  for (const candidate of browserCandidates({ platform, env })) {
    if (!path.isAbsolute(candidate)) continue
    if (exists(candidate)) return candidate
  }
  return undefined
}

/**
 * The exact launch arguments. No `--remote-debugging-port`: the pipe is the transport.
 * With a `proxyPort`, every request of every target (pages, iframes, workers, service
 * workers, WebSocket handshakes) goes through the in-process egress proxy — the one
 * enforcement point. `<-loopback>` removes the implicit loopback bypass so a request
 * to 127.0.0.1 reaches the proxy and is refused there instead of leaving directly.
 */
export function browserLaunchArgs({ profileDir, proxyPort } = {}) {
  const args = [
    '--headless=new',
    '--remote-debugging-pipe',
    `--user-data-dir=${profileDir}`,
    '--no-first-run',
    '--no-default-browser-check',
  ]
  if (Number.isInteger(proxyPort) && proxyPort > 0) {
    args.push(
      `--proxy-server=http://127.0.0.1:${proxyPort}`,
      '--proxy-bypass-list=<-loopback>',
      // QUIC is UDP and would skip an HTTP proxy; Chromium's own DNS paths must not
      // resolve names behind the proxy's back either.
      '--disable-quic',
      '--dns-prefetch-disable',
      '--disable-features=DnsOverHttps',
      '--disable-background-networking',
      // WebRTC ICE/STUN is UDP and ignores --proxy-server, so a hostile page could use
      // it to probe LAN addresses (and learn which ones answer). This is the switch
      // behind the enterprise WebRtcIPHandlingPolicy: it keeps ICE off unproxied UDP.
      // There is no plain `--disable-webrtc` switch in current builds — an unknown
      // switch is silently ignored, so only this one is relied on.
      '--force-webrtc-ip-handling-policy=disable_non_proxied_udp',
    )
  }
  return args
}

// ---------------------------------------------------------------------------
// Page policy (spec 016 Phase 3): only http/https, never this machine.
// ---------------------------------------------------------------------------

const stripBrackets = (host) => String(host ?? '').replace(/^\[|\]$/g, '').split('%')[0].toLowerCase()

/** The dotted quad of an IPv4 literal, or null. */
function ipv4Octets(text) {
  const parts = String(text).split('.')
  if (parts.length !== 4) return null
  const octets = parts.map((part) => (/^\d{1,3}$/.test(part) ? Number(part) : Number.NaN))
  if (!octets.every((part) => Number.isInteger(part) && part >= 0 && part <= 255)) return null
  return octets
}

/**
 * The 16 bytes of an IPv6 literal (brackets and zone already stripped), or null.
 * Handles `::` compression and a trailing dotted quad; anything malformed is null so
 * the caller can refuse it rather than guess.
 */
function ipv6Bytes(text) {
  const value = String(text)
  if (!value.includes(':')) return null
  const halves = value.split('::')
  if (halves.length > 2) return null
  const parseGroups = (part) => {
    if (part === '') return []
    const out = []
    for (const group of part.split(':')) {
      if (group === '') return null
      if (group.includes('.')) {
        const quad = ipv4Octets(group)
        if (!quad) return null
        out.push((quad[0] << 8) | quad[1], (quad[2] << 8) | quad[3])
        continue
      }
      if (!/^[0-9a-f]{1,4}$/.test(group)) return null
      out.push(Number.parseInt(group, 16))
    }
    return out
  }
  const left = parseGroups(halves[0])
  const right = halves.length === 2 ? parseGroups(halves[1]) : []
  if (!left || !right) return null
  const missing = 8 - left.length - right.length
  if (halves.length === 1 ? missing !== 0 : missing < 0) return null
  const groups = [...left, ...new Array(halves.length === 2 ? missing : 0).fill(0), ...right]
  if (groups.length !== 8) return null
  const bytes = new Uint8Array(16)
  groups.forEach((group, at) => {
    bytes[at * 2] = (group >> 8) & 0xff
    bytes[at * 2 + 1] = group & 0xff
  })
  return bytes
}

/**
 * Why an IPv4 address may not be reached: `'loopback'` for this machine and this
 * network's "me" addresses, `'private'` for the ranges only a LAN, a link or a CGNAT
 * carrier can own, or null for a public address.
 */
function v4Verdict(octets) {
  const [a, b] = octets
  if (a === 0 || a === 127) return 'loopback' // 0.0.0.0/8, 127.0.0.0/8
  if (a === 10) return 'private'
  if (a === 172 && b >= 16 && b <= 31) return 'private'
  if (a === 192 && b === 168) return 'private'
  if (a === 169 && b === 254) return 'private'
  // 100.64.0.0/10: CGNAT, and what Tailscale hands out.
  if (a === 100 && b >= 64 && b <= 127) return 'private'
  // 198.18.0.0/15: benchmarking range, routed inside some labs/VPNs.
  if (a === 198 && (b === 18 || b === 19)) return 'private'
  // 224.0.0.0/4 multicast, 240.0.0.0/4 reserved and 255.255.255.255 broadcast.
  if (a >= 224) return 'private'
  return null
}

/** Why an IPv6 literal may not be reached, or null. */
function v6Verdict(bytes) {
  const allZero = (from, to) => bytes.subarray(from, to).every((byte) => byte === 0)
  // 64:ff9b::/96 NAT64: the last 32 bits are the IPv4 destination a gateway forwards to.
  if (bytes[0] === 0x00 && bytes[1] === 0x64 && bytes[2] === 0xff && bytes[3] === 0x9b && allZero(4, 12)) {
    return v4Verdict([bytes[12], bytes[13], bytes[14], bytes[15]]) ?? null
  }
  // 2002::/16 6to4: bytes 2..5 are the embedded IPv4 address.
  if (bytes[0] === 0x20 && bytes[1] === 0x02) {
    return v4Verdict([bytes[2], bytes[3], bytes[4], bytes[5]])
  }
  // ff00::/8 multicast.
  if (bytes[0] === 0xff) return 'private'
  // ::ffff:a.b.c.d — an IPv4 address wearing an IPv6 hat (what a URL parser writes).
  if (allZero(0, 10) && bytes[10] === 0xff && bytes[11] === 0xff) {
    return v4Verdict([bytes[12], bytes[13], bytes[14], bytes[15]])
  }
  // ::a.b.c.d — IPv4-compatible (`::7f00:1` is 127.0.0.1); :: and ::1 are below.
  if (allZero(0, 12)) {
    const last = (bytes[12] << 24 >>> 0) + (bytes[13] << 16) + (bytes[14] << 8) + bytes[15]
    if (last === 0 || last === 1) return 'loopback' // :: (unspecified), ::1 (this machine)
    return v4Verdict([bytes[12], bytes[13], bytes[14], bytes[15]])
  }
  if ((bytes[0] & 0xfe) === 0xfc) return 'private' // fc00::/7 unique local
  if (bytes[0] === 0xfe && (bytes[1] & 0xc0) === 0x80) return 'private' // fe80::/10 link-local
  return null
}

/**
 * Why one host name may not be reached: `'loopback'`, `'private'`, or null.
 *
 * A bare `localhost` label, or any subdomain of it (`x.localhost` is loopback per
 * RFC 6761), names this machine; so does a trailing dot form of it, which is the same
 * name to a resolver.
 */
function hostVerdict(host) {
  const value = String(host ?? '').trim().toLowerCase().replace(/\.$/, '')
  if (value === '') return 'loopback'
  if (value === 'localhost' || value.endsWith('.localhost')) return 'loopback'
  const quad = ipv4Octets(value)
  if (quad) return v4Verdict(quad)
  const bytes = ipv6Bytes(value)
  if (bytes) return v6Verdict(bytes)
  return null
}

const normalizeHost = (host) => stripBrackets(host)

/** `host:port` of a configured origin, accepting `host:port` or a URL. */
function authorityOf(value) {
  const text = String(value ?? '').trim()
  if (!text) return ''
  try {
    const url = new URL(/^[a-z][a-z0-9+.-]*:\/\//i.test(text) ? text : `http://${text}`)
    const port = url.port || (url.protocol === 'https:' ? '443' : '80')
    return `${normalizeHost(url.hostname)}:${port}`
  } catch { return '' }
}

/**
 * Decide whether the agent may open `raw`.
 * @returns {{ ok: true, url: string } | { ok: false, reason: string, host: string }}
 */
export function checkPageUrl(raw, { blockedOrigins = [] } = {}) {
  const text = typeof raw === 'string' ? raw.trim() : ''
  if (text === '' || text.length > 2048) return { ok: false, reason: 'invalid-url', host: '' }
  let url
  try { url = new URL(text) } catch { return { ok: false, reason: 'invalid-url', host: '' } }
  if (url.protocol !== 'http:' && url.protocol !== 'https:') return { ok: false, reason: 'scheme', host: url.hostname }
  if (url.username || url.password) return { ok: false, reason: 'credentials', host: url.hostname }
  const host = normalizeHost(url.hostname)
  const verdict = hostVerdict(host)
  if (verdict !== null) return { ok: false, reason: verdict, host }
  const port = url.port || (url.protocol === 'https:' ? '443' : '80')
  const authority = `${host}:${port}`
  for (const blocked of blockedOrigins) {
    if (authorityOf(blocked) === authority) return { ok: false, reason: 'dsh-server', host }
  }
  return { ok: true, url: url.toString() }
}

// ---------------------------------------------------------------------------
// The egress proxy: one HTTP proxy per browser, on this machine's loopback.
//
// The request hook above sees the URL; this sees the SOCKET. Chromium is told to
// send every request through it (`browserLaunchArgs`), so a name is resolved HERE,
// once, and the connection is opened to the address that was checked — the browser
// never gets a second, later answer it could be rebound to. That is what closes the
// DNS-rebinding window the hook alone leaves open; the hook stays as defence in
// depth, because a request that never reaches this proxy is still refused there.
//
// Refusals are the proxy's own, not the browser's: `403` for policy, `407`-style
// proxy refusal for a name that could not be resolved in time, so the page can never
// mistake a blocked request for content this machine served.
// ---------------------------------------------------------------------------

/** How long the proxy's own lookup may take before the request is refused. */
const PROXY_DNS_TIMEOUT_MS = 2000

/** Largest upstream response head the upgrade path will buffer before giving up. */
const PROXY_MAX_HEAD_BYTES = 16 * 1024

/** How long a dial to the checked address may stall before it is dropped. */
const PROXY_CONNECT_TIMEOUT_MS = 10_000

/**
 * Headers a proxy must not pass on (RFC 9110 §7.6.1), plus its own. A connection's
 * framing and keep-alive belong to the hop that opened it, never to the next one.
 */
const HOP_BY_HOP_HEADERS = new Set([
  'connection', 'keep-alive', 'proxy-connection', 'proxy-authorization', 'proxy-authenticate',
  'te', 'trailer', 'transfer-encoding', 'upgrade',
])

/** The headers the WebSocket/`Upgrade` reply drops: the upgrade itself is the point. */
const UPGRADE_DROP_HEADERS = new Set(['keep-alive', 'proxy-connection', 'proxy-authenticate'])

/** One upstream socket, dialled by this proxy after the address was judged. */
function connectUpstream(address, port, family, connectTimeoutMs = PROXY_CONNECT_TIMEOUT_MS) {
  // `timeout` arms the timer before connecting, so a SYN a firewall silently drops
  // ends here instead of holding the browser's request until TCP gives up.
  const upstream = net.connect({ host: address, port, family, timeout: connectTimeoutMs })
  upstream.once('timeout', () => { try { upstream.destroy() } catch { /* already gone */ } })
  // The socket timeout is an IDLE timeout; once connected it must not kill a tunnel or
  // upgraded stream that is simply quiet (a WebSocket can idle far longer than a dial).
  upstream.once('connect', () => upstream.setTimeout(0))
  return upstream
}

/**
 * Header names the `Connection` header declares hop-by-hop (RFC 9110 §7.6.1): they
 * belong to the browser's hop and must not be forwarded, whatever they are called.
 */
function connectionListedHeaders(value) {
  const text = Array.isArray(value) ? value.join(',') : String(value ?? '')
  return new Set(text.split(',').map((token) => token.trim().toLowerCase()).filter(Boolean))
}

/** Headers the upgrade handshake needs even when `Connection` names them. */
const UPGRADE_KEEP_HEADERS = new Set(['upgrade', 'connection'])

/** A refusal that never came from an upstream server. */
function refuseProxy(socket, status, reason, { head = false, method = 'GET' } = {}) {
  if (!socket || socket.destroyed) return
  const body = Buffer.from(`${reason}\n`, 'utf8')
  if (head) {
    socket.end(`HTTP/1.1 ${status} ${http.STATUS_CODES[status] ?? 'Refused'}\r\n`
      + 'Content-Length: 0\r\nConnection: close\r\n\r\n')
    return
  }
  socket.end(`HTTP/1.1 ${status} ${http.STATUS_CODES[status] ?? 'Refused'}\r\n`
    + 'Content-Type: text/plain; charset=utf-8\r\n'
    + `Content-Length: ${body.length}\r\n`
    + 'Connection: close\r\n\r\n'
    + (method === 'HEAD' ? '' : body.toString('utf8')))
}

/** The same refusal, answered through the HTTP server's own response object. */
function refuseResponse(res, status, reason, { method = 'GET' } = {}) {
  if (!res || res.destroyed || res.headersSent) {
    try { res?.destroy?.() } catch { /* already gone */ }
    return
  }
  const body = Buffer.from(`${reason}\n`, 'utf8')
  res.writeHead(status, {
    'Content-Type': 'text/plain; charset=utf-8',
    'Content-Length': method === 'HEAD' ? 0 : body.length,
    Connection: 'close',
  })
  res.end(method === 'HEAD' ? undefined : body)
}

/** `host:port` of an absolute-URI HTTP request, or null when it is not one. */
function proxyTargetOf(rawUrl) {
  let url
  try { url = new URL(String(rawUrl ?? '')) } catch { return null }
  if (url.protocol !== 'http:') return null
  const host = stripBrackets(url.hostname)
  if (host === '') return null
  const port = url.port === '' ? 80 : Number(url.port)
  if (!Number.isInteger(port) || port < 1 || port > 65535) return null
  return { url, host, port, authority: `${host}:${port}` }
}

/** `host:port` of a CONNECT target, or null when it is not a usable authority. */
function proxyTargetOfAuthority(rawAuthority) {
  const text = String(rawAuthority ?? '').trim()
  if (text === '' || text.length > 300) return null
  const match = /^\[([0-9a-fA-F:.]+)\]:(\d{1,5})$/.exec(text) ?? /^([^:[\]]+):(\d{1,5})$/.exec(text)
  if (!match) return null
  const host = stripBrackets(match[1])
  const port = Number(match[2])
  if (host === '') return null
  if (!Number.isInteger(port) || port < 1 || port > 65535) return null
  return { host, port, authority: `${host}:${port}` }
}

/** A dialable literal for `net.connect`, from a resolved address. */
function dialAddress(address) {
  const family = Number(address?.family)
  const value = stripBrackets(address?.address ?? '')
  if (value === '') return null
  if (family === 6 || value.includes(':')) return value
  if (family === 4 || ipv4Octets(value) !== null) return value
  return null
}

/**
 * The egress proxy one browser launch owns. `start()` binds it on loopback with an
 * ephemeral port and `close()` is the kill switch (the browser is closed first).
 *
 * `resolveHost` is the SAME injectable resolver the request hook uses, so a test can
 * stand in for DNS and a name that times out is refused rather than dialled. A
 * resolver failure or a timeout is never cached: the next request asks again.
 */
export class EgressProxy {
  constructor({
    resolveHost = lookupAddresses, dnsTimeoutMs = PROXY_DNS_TIMEOUT_MS,
    connectTimeoutMs = PROXY_CONNECT_TIMEOUT_MS,
    blockedOrigins = () => [], now = Date.now, onError = () => {},
  } = {}) {
    // No logger on purpose: a refused request names a host, and that is the one thing
    // this module must never write to the plugin log.
    this.resolveHost = resolveHost
    this.dnsTimeoutMs = dnsTimeoutMs
    this.connectTimeoutMs = connectTimeoutMs
    this.blockedOrigins = typeof blockedOrigins === 'function' ? blockedOrigins : () => []
    this.now = now
    // A listener that dies after it started taking requests cannot enforce anything:
    // the owner is told so the browser behind it can be closed, never left unguarded.
    this.onError = typeof onError === 'function' ? onError : () => {}
    this.server = null
    this.port = 0
    /** in-flight sockets, so `close()` can drop the ones a browser left open. */
    this.sockets = new Set()
  }

  get started() {
    return this.server !== null
  }

  /** Bind on `127.0.0.1:0` and return the port the browser must be pointed at. */
  async start() {
    if (this.server) return this.port
    const server = http.createServer((req, res) => {
      this.#onHttp(req, res).catch(() => {
        try { res.destroy?.() } catch { /* already gone */ }
      })
    })
    // A WebSocket (or any other `Upgrade`) arrives as an upgrade on this same
    // listener: the handshake is an ordinary HTTP request, so the same policy runs.
    server.on('upgrade', (req, socket, head) => {
      this.#onUpgrade(req, socket, head).catch(() => {
        try { socket.destroy() } catch { /* already gone */ }
      })
    })
    server.on('connect', (req, socket, head) => {
      this.#onConnect(req, socket, head).catch(() => {
        try { socket.destroy() } catch { /* already gone */ }
      })
    })
    server.on('connection', (socket) => {
      this.sockets.add(socket)
      socket.once('close', () => this.sockets.delete(socket))
      socket.once('error', () => { /* a browser dropping a socket is not an error */ })
    })
    // A slow or huge request head is not something a browser sends: refuse it.
    server.maxHeadersCount = 128
    server.headersTimeout = 20_000
    server.requestTimeout = 0
    await new Promise((resolve, reject) => {
      const onError = (error) => { server.off('listening', onListening); reject(error) }
      const onListening = () => { server.off('error', onError); resolve() }
      server.once('error', onError)
      server.once('listening', onListening)
      server.listen(0, '127.0.0.1')
    })
    this.server = server
    this.port = server.address()?.port ?? 0
    // A server error after this point (the listener dying, a descriptor limit hit)
    // must not crash the Host: drop the proxy and tell the owner to close the browser.
    server.on('error', () => this.#fail())
    if (!Number.isInteger(this.port) || this.port <= 0) {
      await this.close()
      throw new AgentBrowserError('browser/not-supported', 'the egress proxy could not bind a loopback port')
    }
    return this.port
  }

  /**
   * The listener itself failed after it was serving: drop it and every socket on it,
   * then report once. A dead proxy cannot enforce the policy, so this is never silent.
   */
  #fail() {
    const server = this.server
    const hadServer = server !== null
    this.server = null
    this.port = 0
    for (const socket of this.sockets) {
      try { socket.destroy() } catch { /* already gone */ }
    }
    this.sockets.clear()
    if (hadServer) {
      try { server.close(() => {}) } catch { /* already gone */ }
    }
    try { this.onError() } catch { /* the owner's handler must not throw back */ }
  }

  /** Stop listening and drop every socket the browser still holds. */
  async close() {
    const server = this.server
    this.server = null
    this.port = 0
    for (const socket of this.sockets) {
      try { socket.destroy() } catch { /* already gone */ }
    }
    this.sockets.clear()
    if (!server) return false
    await new Promise((resolve) => {
      try { server.close(() => resolve()) } catch { resolve() }
      // `close` waits for open sockets; they were destroyed above, and a server that
      // never listened must not hold the Host open.
      setTimeout(resolve, 500).unref?.()
    })
    return true
  }

  /**
   * The one policy: a name, its port and the addresses it resolves to. Resolves with
   * `{ ok: true, address }` (the literal to dial, no second resolution) or
   * `{ ok: false, status, reason }`. Nothing about a failure is cached.
   */
  async verdict(host, port) {
    if (!Number.isInteger(port) || port < 1 || port > 65535) {
      return { ok: false, status: 403, reason: 'refused: the port is out of range' }
    }
    const literal = hostVerdict(host)
    if (literal !== null) return { ok: false, status: 403, reason: `refused: ${host} is ${literal}` }
    if (host === '') return { ok: false, status: 403, reason: 'refused: no host' }
    // A literal never needs a lookup; it is judged above and dialled as written.
    if (ipv4Octets(host) !== null || ipv6Bytes(host) !== null) return this.#judge([{ address: host, family: host.includes(':') ? 6 : 4 }], host, port)
    let addresses
    try {
      addresses = await this.#resolve(host)
    } catch {
      return { ok: false, status: 407, reason: `refused: ${host} could not be resolved in time` }
    }
    const usable = (Array.isArray(addresses) ? addresses : []).filter((address) => dialAddress(address) !== null)
    if (usable.length === 0) return { ok: false, status: 407, reason: `refused: ${host} resolved to no usable address` }
    return this.#judge(usable, host, port)
  }

  /** The verdict for a name whose addresses are already known. */
  #judge(addresses, host, port) {
    for (const address of addresses) {
      const text = stripBrackets(address?.address ?? '')
      const one = hostVerdict(text)
      if (one !== null) return { ok: false, status: 403, reason: `refused: ${host} resolves into ${one}` }
    }
    // A blocked origin is refused by the authority the caller asked for AND by the
    // address it resolved to: the DSH server is recorded as a literal `host:port`, so a
    // NAME pointing at that same address and port is the same machine and is refused too.
    const resolved = new Set(addresses.map((address) => stripBrackets(address?.address ?? '')))
    for (const blocked of this.blockedOrigins()) {
      const entry = authorityOf(blocked)
      if (entry === '') continue
      const at = entry.lastIndexOf(':')
      const blockedHost = entry.slice(0, at)
      const blockedPort = Number(entry.slice(at + 1))
      if (blockedPort !== port) continue
      if (blockedHost === host || resolved.has(blockedHost)) {
        return { ok: false, status: 403, reason: `refused: ${host} is this machine's own DSH server` }
      }
    }
    // The FIRST address is the one dialled; it was judged above, so the literal the
    // socket opens is the literal that was checked.
    const dial = dialAddress(addresses[0])
    if (dial === null) return { ok: false, status: 407, reason: `refused: ${host} resolved to no usable address` }
    return { ok: true, address: dial, family: addresses[0].family === 6 || dial.includes(':') ? 6 : 4, authority: `${host}:${port}` }
  }

  /** A resolver answer, or a rejection once `dnsTimeoutMs` passes. */
  #resolve(host) {
    return new Promise((resolve, reject) => {
      let settled = false
      const settle = (fn, value) => {
        if (settled) return
        settled = true
        clearTimeout(timer)
        fn(value)
      }
      const timer = setTimeout(() => {
        settle(reject, new Error(`lookup of ${host} timed out`))
      }, this.dnsTimeoutMs)
      timer.unref?.()
      Promise.resolve()
        .then(() => this.resolveHost(host))
        .then((addresses) => settle(resolve, addresses), (error) => settle(reject, error))
    })
  }

  /**
   * Plain HTTP: an absolute-URI request, forwarded on its own upstream connection to
   * the address that was checked.
   *
   * One `http.request` per request, deliberately not a piped raw socket: the browser
   * keeps its connection to this proxy (keep-alive, several hosts in a row), and a raw
   * pipe would let the next request on that same client socket be copied onto an
   * upstream dialled for the previous host — and would lose a body the HTTP parser had
   * already consumed. Here Node parses each request, the verdict is taken for it alone,
   * and the body is streamed to the upstream request as it arrives.
   */
  async #onHttp(req, res) {
    // A browser dropping the request mid-body must not surface as an unhandled
    // `error` on the request stream: that would be an exception in the Host process.
    req.once('error', () => { /* the browser went away; the response is gone too */ })
    const target = proxyTargetOf(req.url)
    if (target === null) {
      // A relative URL here means the browser treated this proxy as an origin: there
      // is nothing this proxy could forward, and it must never answer as content.
      refuseResponse(res, 403, 'refused: a proxy request must name an absolute http URL', { method: req.method })
      return
    }
    const verdict = await this.verdict(target.host, target.port)
    if (!verdict.ok) {
      refuseResponse(res, verdict.status, verdict.reason, { method: req.method })
      return
    }
    // The head is rebuilt around the path: the browser sent an absolute URI, the
    // server wants an origin-form one, and the hop-by-hop headers stay on this hop.
    const headers = {}
    // Headers the browser named in `Connection` are hop-by-hop too.
    const listed = connectionListedHeaders(req.headers.connection)
    for (const [name, value] of Object.entries(req.headers)) {
      if (value === undefined) continue
      if (HOP_BY_HOP_HEADERS.has(name) || listed.has(name)) continue
      headers[name] = value
    }
    headers.host = target.url.host
    const upstream = http.request({
      host: verdict.address,
      port: target.port,
      family: verdict.family,
      method: req.method,
      path: `${target.url.pathname}${target.url.search}`,
      headers,
      // No pooled connection: this request was judged for this address, so it gets a
      // socket dialled to it and nothing else can ever ride it.
      agent: false,
      timeout: this.connectTimeoutMs,
    })
    const drop = () => {
      try { upstream.destroy() } catch { /* already gone */ }
      try { res.destroy?.() } catch { /* already gone */ }
    }
    // `timeout` above is an idle timeout. A dial that stalls must still be cut, but a
    // connected upstream that is quiet (long-poll, SSE) must not be: once the socket
    // connects the idle timer is cleared. A reused/already-connected socket is handled too.
    upstream.once('socket', (socket) => {
      if (socket.connecting) socket.once('connect', () => socket.setTimeout(0))
      else socket.setTimeout(0)
    })
    upstream.once('timeout', () => { try { upstream.destroy() } catch { /* already gone */ } })
    upstream.once('error', () => {
      // Nothing was answered: the page sees a refusal, never a body this machine made
      // up on the server's behalf.
      if (res.headersSent) drop()
      else refuseResponse(res, 502, 'refused: the upstream request failed', { method: req.method })
    })
    upstream.once('response', (answer) => {
      const forwarded = []
      for (let at = 0; at < answer.rawHeaders.length; at += 2) {
        if (HOP_BY_HOP_HEADERS.has(String(answer.rawHeaders[at]).toLowerCase())) continue
        forwarded.push(answer.rawHeaders[at], answer.rawHeaders[at + 1])
      }
      res.writeHead(answer.statusCode ?? 502, answer.statusMessage, forwarded)
      answer.once('error', drop)
      answer.pipe(res)
    })
    res.once('close', () => { try { upstream.destroy() } catch { /* already gone */ } })
    req.once('error', drop)
    req.pipe(upstream)
  }

  /** `CONNECT host:port`: open the raw tunnel only after the address passed policy. */
  async #onConnect(req, socket, head) {
    const target = proxyTargetOfAuthority(req.url)
    if (target === null) {
      refuseProxy(socket, 403, 'refused: CONNECT must name host:port')
      return
    }
    const verdict = await this.verdict(target.host, target.port)
    if (!verdict.ok) {
      refuseProxy(socket, verdict.status, verdict.reason)
      return
    }
    const upstream = connectUpstream(verdict.address, target.port, verdict.family, this.connectTimeoutMs)
    const drop = () => {
      try { upstream.destroy() } catch { /* already gone */ }
      try { socket.destroy() } catch { /* already gone */ }
    }
    upstream.once('error', drop)
    upstream.once('connect', () => {
      socket.write('HTTP/1.1 200 Connection Established\r\n\r\n')
      if (head?.length) upstream.write(head)
      upstream.pipe(socket)
      socket.pipe(upstream)
      socket.once('error', drop)
    })
  }

  /**
   * A WebSocket (or other `Upgrade`) handshake. The request is an ordinary HTTP
   * request with an absolute URI, so it takes the same verdict; then the handshake is
   * replayed on the checked socket and only a `101` is handed back to the browser.
   */
  async #onUpgrade(req, socket, head) {
    const target = proxyTargetOf(req.url)
    if (target === null) {
      refuseProxy(socket, 403, 'refused: an upgrade must name an absolute http URL')
      return
    }
    const verdict = await this.verdict(target.host, target.port)
    if (!verdict.ok) {
      refuseProxy(socket, verdict.status, verdict.reason)
      return
    }
    const upstream = connectUpstream(verdict.address, target.port, verdict.family, this.connectTimeoutMs)
    const drop = () => {
      try { upstream.destroy() } catch { /* already gone */ }
      try { socket.destroy() } catch { /* already gone */ }
    }
    upstream.once('error', drop)
    let buffered = Buffer.alloc(0)
    const onData = (chunk) => {
      buffered = Buffer.concat([buffered, chunk])
      if (buffered.length > PROXY_MAX_HEAD_BYTES) {
        upstream.off('data', onData)
        drop()
        return
      }
      const end = buffered.indexOf('\r\n\r\n')
      if (end < 0) return
      upstream.off('data', onData)
      const headLines = buffered.subarray(0, end).toString('latin1').split('\r\n')
      const statusLine = headLines[0] ?? ''
      const rest = buffered.subarray(end + 4)
      if (!/^HTTP\/1\.[01] 101\b/.test(statusLine)) {
        // The server refused the upgrade; nothing is tunnelled and the browser is
        // told with its own status, never a stream this machine invented.
        refuseProxy(socket, 403, 'refused: the server did not accept the upgrade')
        drop()
        return
      }
      // The upstream's own handshake is handed back verbatim, minus the headers that
      // belong to the hop that is being replaced: `Upgrade`, `Connection` and
      // `Sec-WebSocket-Accept` are exactly what the page's WebSocket needs to open, and
      // dropping them (as a fabricated 101 does) fails the handshake.
      const kept = [statusLine]
      for (const line of headLines.slice(1)) {
        const colon = line.indexOf(':')
        if (colon <= 0) continue
        if (UPGRADE_DROP_HEADERS.has(line.slice(0, colon).trim().toLowerCase())) continue
        kept.push(line)
      }
      socket.write(`${kept.join('\r\n')}\r\n\r\n`)
      if (rest.length) socket.write(rest)
      if (head?.length) upstream.write(head)
      upstream.pipe(socket)
      socket.pipe(upstream)
      socket.once('error', drop)
    }
    upstream.once('connect', () => {
      const headers = { ...req.headers, host: target.url.host }
      // `Connection`/`Upgrade` stay (the handshake is the point); any OTHER header the
      // browser named in `Connection` belongs to its hop and is not forwarded.
      const listed = connectionListedHeaders(req.headers.connection)
      const lines = [`${req.method} ${target.url.pathname}${target.url.search} HTTP/1.1`]
      for (const [name, value] of Object.entries(headers)) {
        if (value === undefined) continue
        if (name === 'proxy-connection' || name === 'proxy-authorization') continue
        if (listed.has(name) && !UPGRADE_KEEP_HEADERS.has(name)) continue
        if (Array.isArray(value)) for (const one of value) lines.push(`${name}: ${one}`)
        else lines.push(`${name}: ${value}`)
      }
      upstream.write(`${lines.join('\r\n')}\r\n\r\n`)
      upstream.on('data', onData)
    })
  }
}

// ---------------------------------------------------------------------------
// CDP over the child's pipes: NUL-delimited JSON, one message per frame.
// ---------------------------------------------------------------------------

class PipeCdp {
  constructor({ input, output, log = () => {}, timeoutMs = CDP_TIMEOUT_MS }) {
    this.input = input
    this.output = output
    this.log = log
    this.timeoutMs = timeoutMs
    this.nextId = 0
    this.pending = new Map()
    this.listeners = new Map()
    this.buffer = ''
    this.closed = false
    this.onData = (chunk) => this.#read(chunk)
    output.on('data', this.onData)
    output.on('error', () => this.fail(new AgentBrowserError('browser/not-supported', 'the browser pipe failed')))
    output.on('close', () => this.fail(new AgentBrowserError('browser/not-supported', 'the browser pipe closed')))
  }

  #read(chunk) {
    this.buffer += chunk.toString('utf8')
    // A message ends at NUL; a chunk boundary can split one, so the tail stays.
    for (let at = this.buffer.indexOf('\0'); at >= 0; at = this.buffer.indexOf('\0')) {
      const text = this.buffer.slice(0, at)
      this.buffer = this.buffer.slice(at + 1)
      if (text.trim() === '') continue
      let message
      try { message = JSON.parse(text) } catch { continue }
      if (!message || typeof message !== 'object') continue
      if (typeof message.id === 'number') {
        const waiter = this.pending.get(message.id)
        if (!waiter) continue
        this.pending.delete(message.id)
        clearTimeout(waiter.timer)
        if (message.error) waiter.reject(new AgentBrowserError('browser/bad-request', String(message.error.message ?? 'the browser refused the command')))
        else waiter.resolve(message.result)
        continue
      }
      if (typeof message.method !== 'string') continue
      for (const listener of [...(this.listeners.get(message.method) ?? [])]) {
        try { listener(message.params ?? {}, message.sessionId) } catch { /* a listener must not break the pipe */ }
      }
    }
    // A peer that never sends NUL would grow this forever; the frames we send and
    // expect are small (screenshots are pulled, not pushed) so cap the tail.
    if (this.buffer.length > 4 * 1024 * 1024) this.fail(new AgentBrowserError('browser/frame-too-large', 'the browser pipe produced an oversized message'))
  }

  /** One CDP command; resolves with its `result`. */
  send(method, params = {}, sessionId) {
    if (this.closed) return Promise.reject(new AgentBrowserError('browser/not-supported', 'the browser is not running'))
    const id = ++this.nextId
    const message = { id, method, params, ...(sessionId ? { sessionId } : {}) }
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pending.delete(id)
        reject(new AgentBrowserError('browser/timeout', `the browser did not answer ${method} in time`))
      }, this.timeoutMs)
      this.pending.set(id, { resolve, reject, timer })
      try { this.input.write(`${JSON.stringify(message)}\0`) } catch {
        this.pending.delete(id)
        clearTimeout(timer)
        reject(new AgentBrowserError('browser/not-supported', 'the browser pipe is closed'))
      }
    })
  }

  onEvent(method, listener) {
    const list = this.listeners.get(method) ?? []
    list.push(listener)
    this.listeners.set(method, list)
    return () => {
      const current = this.listeners.get(method) ?? []
      const at = current.indexOf(listener)
      if (at >= 0) current.splice(at, 1)
    }
  }

  /** Settle everything outstanding; the transport is unusable from here on. */
  fail(error) {
    if (this.closed) return
    this.closed = true
    for (const [, waiter] of this.pending) {
      clearTimeout(waiter.timer)
      waiter.reject(error)
    }
    this.pending.clear()
    try { this.output.off?.('data', this.onData) } catch { /* already gone */ }
  }
}

// ---------------------------------------------------------------------------
// One browser for one host.
// ---------------------------------------------------------------------------

/** How long one `dns.lookup` may take before the request is let through. */
const DNS_TIMEOUT_MS = 2000

/** Marks a lookup that ran out of time, so a non-answer is never cached as a verdict. */
const DNS_NO_ANSWER = Symbol('dns-no-answer')

/** How long a resolved host name keeps its verdict. */
const DNS_CACHE_MS = 60_000

/** Largest pointer coordinate the input ops accept. */
const POINTER_MAX = 100_000

/** Resolve every address of `host` (A and AAAA), rejecting on failure. */
function lookupAddresses(host) {
  return new Promise((resolve, reject) => {
    dns.lookup(host, { all: true, verbatim: true }, (error, addresses) => {
      if (error) reject(error)
      else resolve(addresses)
    })
  })
}

/** A pointer coordinate: a finite number inside the viewport's upper bound. */
function requirePoint(raw, fallback, name) {
  const value = raw === undefined || raw === null ? fallback : Number(raw)
  if (!Number.isFinite(value) || value < 0 || value > POINTER_MAX) {
    throw new AgentBrowserError('browser/bad-request', `${name} must be a finite number from 0 to ${POINTER_MAX}`)
  }
  return value
}

/** A browser the plugin owns; `start()` is lazy and `close()` is the kill switch. */
export class AgentBrowser {
  constructor({
    hostId, profileDir, log = () => {}, spawn = spawnChild, exists = fs.existsSync,
    findBrowser = findInstalledBrowser, platform = process.platform, env = process.env,
    configuredPath = '', idleMs = IDLE_SHUTDOWN_MS, timeoutMs = CDP_TIMEOUT_MS,
    blockedOrigins = [], now = Date.now, mkdir = (target) => ensureOwnerOnlyDirectory(target),
    resolveHost = lookupAddresses, dnsTtlMs = DNS_CACHE_MS, dnsTimeoutMs = DNS_TIMEOUT_MS,
    proxyDnsTimeoutMs = PROXY_DNS_TIMEOUT_MS, createProxy,
  }) {
    if (!HOST_ID.test(String(hostId ?? ''))) throw new AgentBrowserError('browser/bad-request', 'invalid host id')
    this.hostId = hostId
    this.profileDir = profileDir
    this.log = log
    this.spawn = spawn
    this.exists = exists
    this.findBrowser = findBrowser
    this.platform = platform
    this.env = env
    this.configuredPath = configuredPath
    this.idleMs = idleMs
    this.timeoutMs = timeoutMs
    this.resolveHost = resolveHost
    this.dnsTtlMs = dnsTtlMs
    this.dnsTimeoutMs = dnsTimeoutMs
    this.proxyDnsTimeoutMs = proxyDnsTimeoutMs
    // The egress proxy is created per launch (it owns a loopback port and the
    // sockets the browser holds). The seam exists so a test can stand one up
    // without a browser and without weakening the policy.
    this.createProxy = createProxy ?? ((options) => new EgressProxy(options))
    /** host → `{ at, verdict }`; a name is re-resolved after `dnsTtlMs`. */
    this.dnsCache = new Map()
    // A function, so an origin learned later (the DSH server's own `Host`) applies
    // to the next command without rebuilding the browser.
    this.blockedOrigins = typeof blockedOrigins === 'function' ? blockedOrigins : () => blockedOrigins ?? []
    this.now = now
    this.mkdir = mkdir
    this.child = null
    this.cdp = null
    /** The egress proxy this launch owns, or null while not started. */
    this.proxy = null
    this.proxyPort = 0
    this.sessionId = null
    this.pageTargetId = null
    this.idleTimer = null
    this.starting = null
    this.lastFrame = null
    this.lastActivityAt = null
    this.lastError = null
    this.launchArgs = null
    /** Listeners are installed once per launch: the pipe carries every target. */
    this.guardsInstalled = false
    this.screencastListening = false
  }

  get running() {
    return this.child !== null
  }

  status() {
    return {
      running: this.running,
      hostId: this.hostId,
      targetId: this.pageTargetId,
      lastFrameAt: this.lastFrame ? this.lastFrame.at : null,
      lastActivityAt: this.lastActivityAt,
      idle: this.running ? this.idleMs : null,
      error: this.lastError,
    }
  }

  /** Start (or reuse) the browser, attach to a page and begin the screencast. */
  async start() {
    if (this.child) return this
    if (this.starting) return this.starting
    const promise = this.#launch().catch((error) => {
      this.starting = null
      this.lastError = error?.code ?? 'browser/not-supported'
      throw error
    })
    this.starting = promise
    await promise
    this.starting = null
    return this
  }

  async #launch() {
    const executable = this.findBrowser({
      platform: this.platform, env: this.env, exists: this.exists, configuredPath: this.configuredPath,
    })
    if (!executable) {
      throw new AgentBrowserError('browser/not-supported', 'no Chrome or Edge is installed on this machine')
    }
    try { this.mkdir(this.profileDir) } catch { /* the browser creates its own profile if this fails */ }
    // The egress proxy comes first: its port is a launch argument, and a browser that
    // started before it listened would have a window with no enforcement point.
    const proxy = await this.#startProxy()
    const args = browserLaunchArgs({ profileDir: this.profileDir, proxyPort: proxy.port })
    this.launchArgs = args
    // fd 3 = commands into the browser, fd 4 = responses out; no socket anywhere.
    let child
    try {
      child = this.spawn(executable, args, {
        stdio: ['ignore', 'ignore', 'ignore', 'pipe', 'pipe'],
        windowsHide: true,
      })
    } catch {
      await this.#stopProxy()
      throw new AgentBrowserError('browser/not-supported', 'the browser could not be started')
    }
    if (!child?.stdio?.[3] || !child?.stdio?.[4]) {
      try { child?.kill?.() } catch { /* nothing to stop */ }
      await this.#stopProxy()
      throw new AgentBrowserError('browser/not-supported', 'the browser did not expose its debugging pipes')
    }
    this.child = child
    child.once?.('exit', (code) => {
      // A crash is not a command failure we can retry: settle everything and report.
      this.lastError = `exit ${code ?? 'signal'}`
      this.#teardown(new AgentBrowserError('browser/not-supported', `the browser exited (${code ?? 'signal'})`))
    })
    child.once?.('error', () => {
      this.lastError = 'spawn-failed'
      this.#teardown(new AgentBrowserError('browser/not-supported', 'the browser could not be started'))
    })
    this.cdp = new PipeCdp({
      input: child.stdio[3], output: child.stdio[4], log: this.log, timeoutMs: this.timeoutMs,
    })
    const { targetInfos } = await this.cdp.send('Target.getTargets')
    const page = (targetInfos ?? []).find((target) => target.type === 'page')
    const targetId = page?.targetId ?? (await this.cdp.send('Target.createTarget', { url: 'about:blank' })).targetId
    const { sessionId } = await this.cdp.send('Target.attachToTarget', { targetId, flatten: true })
    this.sessionId = sessionId
    this.pageTargetId = targetId
    await this.cdp.send('Page.enable', {}, sessionId).catch(() => {})
    await this.cdp.send('Runtime.enable', {}, sessionId).catch(() => {})
    try {
      await this.#startGuards()
      await this.#guardTarget(sessionId)
    } catch (error) {
      // A browser whose request hook could not be installed is not a browser this
      // module may hand to a host: refuse the launch and stop the process instead of
      // running an unguarded tab.
      this.lastError = error?.code ?? 'browser/not-supported'
      this.close('launch-failed')
      throw error
    }
    this.#startScreencast()
    this.resetIdle()
    this.log(`agent browser for ${this.hostId}: started (${path.basename(executable)})`)
    return this
  }

  /**
   * Refuse every request out of policy, whatever navigated to it — the tab, a 302, a
   * script, or a popup. The hook is installed once per launch (the pipe survives
   * re-attaching to another page) and follows auto-attached targets, so a popup is
   * paused before its first request and never gets a turn unguarded.
   */
  #startGuards() {
    if (!this.cdp || this.guardsInstalled) return Promise.resolve()
    this.guardsInstalled = true
    this.cdp.onEvent('Fetch.requestPaused', (params, sessionId) => {
      this.#onRequestPaused(params, sessionId).catch(() => { /* the request stays paused: no page gets it */ })
    })
    this.cdp.onEvent('Target.attachedToTarget', (params) => {
      const attached = typeof params?.sessionId === 'string' ? params.sessionId : ''
      if (attached === '') return
      this.#guardTarget(attached).catch(() => { /* a target closing mid-attach is not an error */ })
    })
    // Awaited at launch: without auto-attach a popup, an out-of-process iframe or a
    // worker is a target this module never sees, and the tab alone would be guarded.
    // A browser that refuses it fails the launch rather than running half-guarded.
    return this.cdp.send('Target.setAutoAttach', { autoAttach: true, waitForDebuggerOnStart: true, flatten: true })
      .catch(() => {
        throw new AgentBrowserError('browser/not-supported', 'the browser refused to auto-attach its targets, so they could not be guarded')
      })
  }

  /**
   * Enable the request hook on one target, then let it run.
   *
   * The recursive `setAutoAttach` is what guards an out-of-process iframe or a worker:
   * a target's own children are only attached when that target asks for them, so it is
   * sent on every session — the tab and every auto-attached target — before the target
   * is resumed.
   *
   * Order matters, and a failure is a refusal: a target whose hook could not be
   * installed is closed instead of resumed, because resuming it would run it with no
   * Request-stage guard at all.
   */
  async #guardTarget(sessionId) {
    if (!this.cdp) return
    const cdp = this.cdp
    let guarded = true
    await cdp.send('Target.setAutoAttach', { autoAttach: true, waitForDebuggerOnStart: true, flatten: true }, sessionId)
      .catch(() => { guarded = false })
    if (guarded) {
      await cdp.send('Fetch.enable', { patterns: [{ urlPattern: '*', requestStage: 'Request' }] }, sessionId)
        .catch(() => { guarded = false })
    }
    if (!guarded) {
      // `Target.closeTarget` is a browser-level command; the session id is not passed
      // with it, so the target is closed by the id this session was attached to.
      const targetId = await this.#targetIdOf(sessionId)
      if (targetId) await cdp.send('Target.closeTarget', { targetId }).catch(() => {})
      throw new AgentBrowserError('browser/not-supported', 'a target could not be guarded, so it was closed instead of run')
    }
    await cdp.send('Runtime.runIfWaitingForDebugger', {}, sessionId).catch(() => {})
  }

  /** The target id behind an attached session, or null when it cannot be learned. */
  async #targetIdOf(sessionId) {
    if (!this.cdp) return null
    if (sessionId === this.sessionId) return this.pageTargetId
    // A session id is not a target id, and `Target.closeTarget` names a target: ask the
    // browser which target this session is attached to.
    const info = await this.cdp.send('Target.getTargetInfo', {}, sessionId).catch(() => null)
    const targetId = info?.targetInfo?.targetId
    return typeof targetId === 'string' && targetId !== '' ? targetId : null
  }

  /** Allow the paused request, or refuse it so the page sees a blocked request. */
  async #onRequestPaused(params, sessionId) {
    const requestId = typeof params?.requestId === 'string' ? params.requestId : ''
    if (requestId === '') return
    const url = typeof params?.request?.url === 'string' ? params.request.url : ''
    const verdict = await this.#checkUrl(url, { allowNonHttp: true })
    const cdp = this.cdp
    if (!cdp) return
    // The hook answers on the target that paused the request; an event that carries no
    // session is the tab's own, which is where the op-level checks look too.
    const target = typeof sessionId === 'string' && sessionId !== '' ? sessionId : this.sessionId
    if (verdict.ok) await cdp.send('Fetch.continueRequest', { requestId }, target).catch(() => {})
    else await cdp.send('Fetch.failRequest', { requestId, errorReason: 'BlockedByClient' }, target).catch(() => {})
  }

  /**
   * The policy for one URL, including the addresses its NAME resolves to.
   *
   * Chromium resolves the name itself and only later — after this hook, and a second
   * time for a redirect — so a name on a public resolver can still be pointed at this
   * machine (`*.nip.io` style, or a rebind). Pre-resolving every name here closes the
   * ordinary case; the README records the binding weakness that remains.
   */
  async #checkUrl(raw, { allowNonHttp = false } = {}) {
    const verdict = checkPageUrl(raw, { blockedOrigins: this.blockedOrigins() })
    if (!verdict.ok) {
      // Non-http(s) schemes (about:, data:, blob:) are the browser's own pages, not a
      // network address: the request hook lets them through.
      if (allowNonHttp && (verdict.reason === 'scheme' || verdict.reason === 'invalid-url')) return { ok: true }
      return verdict
    }
    let hostname = ''
    try { hostname = stripBrackets(new URL(verdict.url).hostname) } catch { return verdict }
    if (hostVerdict(hostname) !== null) return { ok: false, reason: 'loopback', host: hostname }
    if (ipv4Octets(hostname) !== null || ipv6Bytes(hostname) !== null) return verdict
    const resolved = await this.#resolveVerdict(hostname)
    if (resolved !== null) return { ok: false, reason: resolved, host: hostname }
    return verdict
  }

  /**
   * The blocked verdict for a host name's addresses, or null when it is allowed.
   *
   * Defence in depth only: the egress proxy is the enforcement point that resolves a
   * name once and dials the address it judged, so this cannot close a rebinding window
   * by itself. It therefore still lets an unanswerable name through — refusing every
   * name whose lookup failed or timed out would break ordinary public navigation
   * without stopping a rebind — and a timeout or resolver error is never cached, so
   * the next request asks again instead of remembering a non-answer.
   */
  async #resolveVerdict(hostname) {
    const cached = this.dnsCache.get(hostname)
    if (cached !== undefined && this.now() - cached.at <= this.dnsTtlMs) return cached.verdict
    let addresses
    try {
      addresses = await Promise.race([
        this.resolveHost(hostname),
        new Promise((resolve) => {
          const timer = setTimeout(() => resolve(DNS_NO_ANSWER), this.dnsTimeoutMs)
          timer.unref?.()
        }),
      ])
    } catch {
      return null // a resolver error is not a verdict: nothing is cached
    }
    if (addresses === DNS_NO_ANSWER) return null // a timeout is not a verdict either
    let verdict = null
    for (const address of Array.isArray(addresses) ? addresses : []) {
      const text = typeof address === 'string' ? address : address?.address
      const one = hostVerdict(typeof text === 'string' ? text : '')
      if (one !== null) { verdict = one; break }
    }
    this.dnsCache.set(hostname, { at: this.now(), verdict })
    return verdict
  }

  /** Refuse a page that ended up somewhere out of policy, and blank the tab. */
  async #guardPage(send, signal) {
    const href = await this.#evaluate('location.href', signal).catch(() => null)
    if (typeof href !== 'string' || href === '' || href === 'about:blank') return
    const verdict = await this.#checkUrl(href)
    if (verdict.ok) return
    await send('Page.navigate', { url: 'about:blank' }).catch(() => {})
    throw new AgentBrowserError('browser/bad-request',
      `the page reached ${verdict.host || 'an address'} that this machine does not allow; the tab was moved to about:blank`)
  }

  #startScreencast() {
    if (!this.cdp || !this.sessionId) return
    if (!this.screencastListening) {
      this.screencastListening = true
      this.cdp.onEvent('Page.screencastFrame', (params, sessionId) => {
        if (typeof params?.data !== 'string') return
        this.lastFrame = { data: params.data, at: this.now(), metadata: params.metadata ?? null }
        this.lastActivityAt = this.lastFrame.at
        if (params.sessionId !== undefined) {
          this.cdp?.send('Page.screencastFrameAck', { sessionId: params.sessionId }, sessionId).catch(() => {})
        }
      })
    }
    this.cdp.send('Page.startScreencast', { format: 'jpeg', quality: 55, maxWidth: 1280, maxHeight: 800, everyNthFrame: 1 },
      this.sessionId).catch(() => { /* the tab simply shows no frames */ })
  }

  /** The newest screencast frame (JPEG bytes), or null before the first one. */
  frame() {
    if (!this.lastFrame) return null
    return { data: Buffer.from(this.lastFrame.data, 'base64'), at: this.lastFrame.at }
  }

  resetIdle() {
    if (this.idleTimer) clearTimeout(this.idleTimer)
    this.idleTimer = null
    if (!this.child || !(this.idleMs > 0)) return
    this.idleTimer = setTimeout(() => {
      this.idleTimer = null
      if (!this.child) return
      this.log(`agent browser for ${this.hostId}: idle for ${this.idleMs} ms, closing`)
      this.close('idle')
    }, this.idleMs)
    this.idleTimer.unref?.()
  }

  /** Run one contract `op`. Throws an AgentBrowserError carrying `browser/…`. */
  async op(op, args = {}, { signal } = {}) {
    this.#refuseWhenAborted(signal)
    await this.start()
    this.#refuseWhenAborted(signal)
    this.resetIdle()
    this.lastActivityAt = this.now()
    const session = this.sessionId
    if (!this.cdp || !session) {
      throw new AgentBrowserError('browser/not-found', 'no page is attached: open a tab or navigate first')
    }
    const send = (method, params) => this.#send(session, method, params, signal)
    const result = await this.#dispatch(session, op, args, signal, send)
    // A page can end up out of policy without any op naming it (a redirect, a script
    // navigation, a popup that took the tab over), so the address is re-read here and
    // the tab is blanked rather than left parked on this machine.
    await this.#guardPage(send, signal)
    return result
  }

  async #dispatch(session, op, args, signal, send) {
    switch (op) {
      case 'navigate': {
        const url = await this.#requireUrl(args?.url)
        await send('Page.navigate', { url })
        const seen = await this.#evaluate('({ url: location.href, title: document.title })', signal).catch(() => null)
        return { url: seen?.url ?? url, title: seen?.title ?? null }
      }
      case 'click': {
        if (typeof args?.selector === 'string' && args.selector !== '') {
          const hit = await this.#evaluate(`(() => {
            const el = document.querySelector(${JSON.stringify(args.selector)})
            if (el === null) return false
            el.scrollIntoView({ block: 'center' })
            el.click()
            return true
          })()`, signal)
          if (hit !== true) throw new AgentBrowserError('browser/not-found', `no element matches ${args.selector}`)
          return { clicked: true, selector: args.selector }
        }
        const x = requirePoint(args?.x, 0, 'x')
        const y = requirePoint(args?.y, 0, 'y')
        const base = { x, y, button: 'left', clickCount: 1 }
        await send('Input.dispatchMouseEvent', { type: 'mouseMoved', x, y })
        await send('Input.dispatchMouseEvent', { type: 'mousePressed', ...base })
        await send('Input.dispatchMouseEvent', { type: 'mouseReleased', ...base })
        return { clicked: true, x, y }
      }
      case 'type': {
        const text = typeof args?.text === 'string' ? args.text : ''
        if (typeof args?.selector === 'string' && args.selector !== '') {
          const focused = await this.#evaluate(`(() => {
            const el = document.querySelector(${JSON.stringify(args.selector)})
            if (el === null) return false
            el.focus()
            return true
          })()`, signal)
          if (focused !== true) throw new AgentBrowserError('browser/not-found', `no element matches ${args.selector}`)
        }
        await send('Input.insertText', { text })
        return { typed: text.length }
      }
      case 'press': {
        const key = typeof args?.key === 'string' && args.key ? args.key : 'Enter'
        await send('Input.dispatchKeyEvent', { type: 'keyDown', key, text: key.length === 1 ? key : undefined })
        await send('Input.dispatchKeyEvent', { type: 'keyUp', key })
        return { pressed: key }
      }
      case 'scroll': {
        const x = requirePoint(args?.x, 10, 'x')
        const y = requirePoint(args?.y, 10, 'y')
        await send('Input.dispatchMouseEvent', {
          type: 'mouseWheel', x, y, deltaX: Number(args?.deltaX ?? 0), deltaY: Number(args?.deltaY ?? 400),
        })
        return { scrolled: true }
      }
      case 'open': {
        const url = args?.url === undefined ? 'about:blank' : await this.#requireUrl(args.url)
        const { targetId } = await send('Target.createTarget', { url })
        return { tabId: targetId, url }
      }
      case 'close': {
        const tabId = typeof args?.tabId === 'string' ? args.tabId : args?.tabId === undefined ? this.pageTargetId : ''
        if (!tabId) throw new AgentBrowserError('browser/not-found', 'no tab id was given')
        const { success } = await send('Target.closeTarget', { targetId: tabId })
        if (success === false) throw new AgentBrowserError('browser/not-found', 'that tab does not exist')
        // Closing the tab the agent drives must not leave it with none: re-attach to
        // another page, or open a blank one, so the next command has somewhere to land.
        if (tabId === this.pageTargetId) await this.#reattach(signal, tabId)
        return { closed: true, tabId }
      }
      case 'snapshot': {
        const { nodes } = await send('Accessibility.getFullAXTree', {})
        const lines = []
        for (const node of nodes ?? []) {
          if (lines.length >= SNAPSHOT_MAX_LINES) break
          const role = node?.role?.value
          const name = node?.name?.value
          if (typeof role !== 'string') continue
          if (node?.ignored === true) continue
          lines.push(typeof name === 'string' && name !== '' ? `${role} ${name}` : role)
        }
        const cut = await cutText(lines.join('\n'))
        return { snapshot: cut.text, truncated: cut.truncated, nodes: lines.length }
      }
      case 'text': {
        const text = await this.#evaluate('document.body ? document.body.innerText : ""', signal)
        const cut = await cutText(typeof text === 'string' ? text : '')
        return { text: cut.text, truncated: cut.truncated }
      }
      case 'html': {
        const html = await this.#evaluate('document.documentElement ? document.documentElement.outerHTML : ""', signal)
        const cut = await cutText(typeof html === 'string' ? html : '')
        return { html: cut.text, truncated: cut.truncated }
      }
      case 'screenshot': {
        const shot = await this.#screenshot(send, signal)
        return { screenshot: shot.data, bytes: shot.bytes, mime: 'image/jpeg' }
      }
      case 'tabs': {
        const { targetInfos } = await send('Target.getTargets', {})
        const tabs = (targetInfos ?? [])
          .filter((target) => target.type === 'page')
          .map((target) => ({ tabId: target.targetId, url: target.url, title: target.title ?? '' }))
        return { tabs }
      }
      default:
        // The validator refuses anything else before this point; belt and braces.
        throw new AgentBrowserError('browser/bad-request', `unsupported operation: ${String(op)}`)
    }
  }

  async #evaluate(expression, signal) {
    const result = await this.#send(this.sessionId, 'Runtime.evaluate', {
      expression, returnByValue: true, awaitPromise: true,
    }, signal)
    if (result?.exceptionDetails) {
      throw new AgentBrowserError('browser/bad-request', String(result.exceptionDetails.text ?? 'the page threw'))
    }
    return result?.result?.value
  }

  /** The URL an op may navigate to: the policy check, plus the name's addresses. */
  async #requireUrl(raw) {
    const verdict = await this.#checkUrl(raw)
    if (verdict.ok) return typeof verdict.url === 'string' ? verdict.url : String(raw)
    const why = verdict.reason === 'loopback' || verdict.reason === 'dsh-server'
      ? 'this machine itself cannot be opened by the agent'
      : verdict.reason === 'private'
        ? 'private, link-local and carrier-grade-NAT addresses cannot be opened by the agent'
        : 'only http/https addresses without credentials are allowed'
    throw new AgentBrowserError('browser/bad-request', `refused ${verdict.host || 'that address'}: ${why}`)
  }

  #refuseWhenAborted(signal) {
    if (signal?.aborted) throw new AgentBrowserError('browser/cancelled', 'the command was cancelled')
  }

  /**
   * One CDP command that gives up the moment the command is cancelled, instead of
   * waiting out the pipe's own timeout: the channel keeps its slot busy until the work
   * unwinds, so a cancelled op that kept waiting would block the next one.
   */
  #send(sessionId, method, params, signal) {
    if (!this.cdp) return Promise.reject(new AgentBrowserError('browser/not-supported', 'the browser is not running'))
    const command = this.cdp.send(method, params, sessionId)
    if (!signal || typeof signal.addEventListener !== 'function') return command
    return new Promise((resolve, reject) => {
      let settled = false
      const onAbort = () => {
        if (settled) return
        settled = true
        // The command may still answer later; its result is simply dropped.
        command.catch(() => {})
        reject(new AgentBrowserError('browser/cancelled', 'the command was cancelled'))
      }
      signal.addEventListener('abort', onAbort, { once: true })
      command.then((value) => {
        if (settled) return
        settled = true
        signal.removeEventListener('abort', onAbort)
        resolve(value)
      }, (error) => {
        if (settled) return
        settled = true
        signal.removeEventListener('abort', onAbort)
        reject(error)
      })
      if (signal.aborted) onAbort()
    })
  }

  /**
   * Attach to the page the agent drives next: another open page, or a fresh blank one.
   * A browser left with no attached page would answer every later op with an opaque
   * CDP failure, so this either re-attaches or says `browser/not-found`.
   */
  async #reattach(signal, closedTabId) {
    this.sessionId = null
    this.pageTargetId = null
    if (!this.cdp) throw new AgentBrowserError('browser/not-supported', 'the browser is not running')
    let targetId = null
    try {
      const { targetInfos } = await this.cdp.send('Target.getTargets')
      // Never the tab that was just closed: it may still be listed for a moment, and
      // re-attaching to it would leave every later op reading a dead session.
      targetId = (targetInfos ?? [])
        .find((target) => target.type === 'page' && target.targetId !== closedTabId)?.targetId ?? null
    } catch { targetId = null }
    if (!targetId && !signal?.aborted) {
      try {
        targetId = (await this.cdp.send('Target.createTarget', { url: 'about:blank' })).targetId ?? null
      } catch { targetId = null }
    }
    if (!targetId) throw new AgentBrowserError('browser/not-found', 'no page is left in the browser after closing that tab')
    const { sessionId } = await this.cdp.send('Target.attachToTarget', { targetId, flatten: true })
    this.sessionId = sessionId
    this.pageTargetId = targetId
    await this.cdp.send('Page.enable', {}, sessionId).catch(() => {})
    await this.cdp.send('Runtime.enable', {}, sessionId).catch(() => {})
    await this.#guardTarget(sessionId)
    this.#startScreencast()
  }

  /** A JPEG under `SCREENSHOT_MAX_BYTES`: lower quality first, then a smaller clip. */
  async #screenshot(send, signal) {
    const steps = [
      { quality: 75 }, { quality: 55 }, { quality: 35 }, { quality: 20 }, { quality: 10 },
    ]
    let last = null
    for (const step of steps) {
      const { data } = await send('Page.captureScreenshot', { format: 'jpeg', ...step })
      last = data
      if (typeof data === 'string' && Buffer.byteLength(data, 'base64') <= SCREENSHOT_MAX_BYTES) {
        return { data, bytes: Buffer.byteLength(data, 'base64') }
      }
    }
    // Still too big at the lowest quality: capture a scaled-down viewport instead.
    const metrics = await this.#send(this.sessionId, 'Runtime.evaluate', {
      expression: '({ width: innerWidth, height: innerHeight })', returnByValue: true,
    }, signal).catch(() => null)
    const width = Number(metrics?.result?.value?.width ?? 0)
    const height = Number(metrics?.result?.value?.height ?? 0)
    if (width > 0 && height > 0) {
      for (const scale of [0.75, 0.5, 0.35, 0.25]) {
        const { data } = await send('Page.captureScreenshot', {
          format: 'jpeg', quality: 40, clip: { x: 0, y: 0, width, height, scale },
        })
        if (typeof data === 'string' && Buffer.byteLength(data, 'base64') <= SCREENSHOT_MAX_BYTES) {
          return { data, bytes: Buffer.byteLength(data, 'base64') }
        }
        last = data
      }
    }
    if (typeof last === 'string' && Buffer.byteLength(last, 'base64') <= SCREENSHOT_MAX_BYTES) {
      return { data: last, bytes: Buffer.byteLength(last, 'base64') }
    }
    throw new AgentBrowserError('browser/frame-too-large', 'the screenshot could not be shrunk under 768 KiB')
  }

  /**
   * Start this launch's egress proxy. One per browser, on its own loopback port; the
   * SAME resolver the request hook uses, so a test injects one resolver for both.
   */
  async #startProxy() {
    if (this.proxy) return this.proxy
    const proxy = this.createProxy({
      resolveHost: this.resolveHost,
      dnsTimeoutMs: this.proxyDnsTimeoutMs,
      blockedOrigins: () => this.blockedOrigins(),
      now: this.now,
      // A proxy whose listener died can no longer enforce anything: the browser it was
      // guarding is closed with it, rather than left running with no egress policy.
      onError: () => {
        this.lastError = 'proxy-error'
        this.log(`agent browser for ${this.hostId}: the egress proxy failed, closing the browser`)
        this.close('proxy-error')
      },
    })
    this.proxy = proxy
    try {
      this.proxyPort = await proxy.start()
    } catch {
      await this.#stopProxy()
      throw new AgentBrowserError('browser/not-supported', 'the egress proxy could not start, so the browser was not launched unguarded')
    }
    if (!Number.isInteger(this.proxyPort) || this.proxyPort <= 0) {
      await this.#stopProxy()
      throw new AgentBrowserError('browser/not-supported', 'the egress proxy did not report a loopback port')
    }
    return proxy
  }

  /** Drop the proxy (and every socket the browser still holds on it). */
  async #stopProxy() {
    const proxy = this.proxy
    this.proxy = null
    this.proxyPort = 0
    if (!proxy) return
    try { await proxy.close() } catch { /* teardown must not throw */ }
  }

  #teardown(error) {
    if (this.idleTimer) clearTimeout(this.idleTimer)
    this.idleTimer = null
    this.cdp?.fail(error ?? new AgentBrowserError('browser/not-supported', 'the browser stopped'))
    this.cdp = null
    this.child = null
    this.sessionId = null
    this.pageTargetId = null
    this.lastFrame = null
    this.starting = null
    // The listeners belong to the pipe that just went away: the next launch installs
    // its own, on its own pipe.
    this.guardsInstalled = false
    this.screencastListening = false
    this.dnsCache.clear()
    // The proxy belongs to the browser that just went away: its port is useless now,
    // and a listener left behind would outlive the process it was guarding.
    this.#stopProxy().catch(() => { /* teardown must not throw */ })
  }

  /**
   * The kill switch: stop the browser now. A pending command fails with
   * `browser/cancelled` (the caller answers it exactly once), and every timer is
   * released so a closed browser cannot keep the Host alive.
   */
  close(reason = 'stop') {
    const child = this.child
    this.#teardown(new AgentBrowserError('browser/cancelled', 'the browser was closed'))
    if (!child) return false
    try { child.kill() } catch { /* already gone */ }
    const force = setTimeout(() => { try { child.kill('SIGKILL') } catch { /* already gone */ } }, 2000)
    force.unref?.()
    this.log(`agent browser for ${this.hostId}: closed (${reason})`)
    return true
  }
}

// ---------------------------------------------------------------------------
// One browser per host, on the plugin's own clock and profile directory.
// ---------------------------------------------------------------------------

/** Browsers keyed by paired host; `forHost` is lazy and `dispose` is the kill switch for all. */
export function createAgentBrowserPool(options = {}) {
  const {
    dataDir, log = () => {}, spawn, exists, platform, env, configuredPath = '',
    idleMs = IDLE_SHUTDOWN_MS, timeoutMs, now, resolveHost, dnsTtlMs, dnsTimeoutMs,
    proxyDnsTimeoutMs, createProxy,
  } = options
  const profileRoot = path.join(dataDir, 'agent-browser-profile')
  const blockedOrigins = new Set(Array.isArray(options.blockedOrigins) ? options.blockedOrigins.filter(Boolean) : [])
  const browsers = new Map()

  return {
    /** The browser for one host, created on first use. */
    forHost(hostId) {
      if (!HOST_ID.test(String(hostId ?? ''))) throw new AgentBrowserError('browser/bad-request', 'invalid host id')
      let browser = browsers.get(hostId)
      if (!browser) {
        browser = new AgentBrowser({
          hostId,
          profileDir: path.join(profileRoot, hostId),
          log, spawn, exists, platform, env, configuredPath, idleMs, timeoutMs, now,
          resolveHost, dnsTtlMs, dnsTimeoutMs,
          proxyDnsTimeoutMs, createProxy,
          // Read lazily: the DSH origin is learned from the frame route's Host.
          blockedOrigins: () => [...blockedOrigins],
        })
        browsers.set(hostId, browser)
      }
      return browser
    },
    /** Record the DSH server's own `host:port` so the agent can never drive this app. */
    blockOrigin(host) {
      const authority = authorityOf(host)
      if (authority) blockedOrigins.add(authority)
    },
    blockedOrigins: () => [...blockedOrigins],
    /** Kill switch for one host (the tab's Stop button and "consent off"). */
    stopHost(hostId) {
      const browser = browsers.get(hostId)
      if (!browser) return false
      browsers.delete(hostId)
      return browser.close('stop')
    },
    status(hostId) {
      const browser = browsers.get(hostId)
      return browser ? browser.status() : { running: false, hostId }
    },
    dispose() {
      for (const [hostId, browser] of browsers) {
        try { browser.close('dispose') } catch { /* teardown must not throw */ }
        browsers.delete(hostId)
      }
    },
  }
}
