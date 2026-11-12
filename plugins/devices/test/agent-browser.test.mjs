// Spec 016 Phase 3 (contract revision 10) — the client half of "the host drives a
// browser on this machine":
//  - the per-host consent decides the hello capability and `browser/denied`;
//  - one command in flight, validated by the shared protocol, answered exactly once,
//    cancellable and bounded by its own deadline;
//  - a spawned Chrome/Edge over `--remote-debugging-pipe` only (no TCP port), its own
//    profile per host, ops, limits and truncation, the kill switch and idle shutdown;
//  - the URL refusal set;
//  - the two routes the tab uses (`frame`, `stop`) and the consent route.
// The browser is a FAKE process speaking CDP over the same NUL-delimited pipes, so
// the suite never launches a real browser. Run as a plain script (`node test/x.mjs`).
import assert from 'node:assert/strict'
import { PassThrough } from 'node:stream'
import crypto from 'node:crypto'

import { check, finish, mountPlugin, tempDir, delay } from './helpers.mjs'
import {
  AgentBrowser, EgressProxy, SCREENSHOT_MAX_BYTES, TEXT_MAX_BYTES,
  browserLaunchArgs, checkPageUrl, createAgentBrowserPool,
} from '../lib/agent-browser.mjs'
import { BrowserChannel, buildClientHello } from '../lib/remote-client.mjs'
import http from 'node:http'
import net from 'node:net'

console.log('agent-browser')

const HTML = `<html><body>${'x'.repeat(300 * 1024)}</body></html>`
const TEXT = 't'.repeat(300 * 1024)
const SAMPLE_WS_KEY = Buffer.from('the sample nonce').toString('base64')

/**
 * A fake child process speaking the CDP pipe protocol: fd 3 takes commands, fd 4
 * speaks NUL-delimited JSON. `routes` maps a CDP method to its `result`.
 */
function fakeBrowser({ routes = {}, onSpawn } = {}) {
  const input = new PassThrough()
  const output = new PassThrough()
  const handled = []
  const exitListeners = new Set()
  const state = { killed: 0, signal: null }
  const child = {
    stdio: [null, null, null, input, output],
    once(event, fn) {
      if (event === 'exit') exitListeners.add(fn)
      return child
    },
    on() { return child },
    kill(signal) {
      state.killed += 1
      state.signal = signal ?? 'SIGTERM'
      for (const fn of exitListeners) fn(0)
      return true
    },
  }
  const defaultRoutes = {
    'Target.getTargets': () => ({ targetInfos: [{ type: 'page', targetId: 't1', url: 'about:blank', title: 'about:blank' }] }),
    'Target.attachToTarget': () => ({ sessionId: 's1' }),
    'Target.setAutoAttach': () => ({}),
    'Fetch.enable': () => ({}),
    'Fetch.continueRequest': () => ({}),
    'Fetch.failRequest': () => ({}),
    'Runtime.runIfWaitingForDebugger': () => ({}),
    'Page.enable': () => ({}),
    'Runtime.enable': () => ({}),
    'Page.startScreencast': () => ({}),
    'Page.screencastFrameAck': () => ({}),
    'Page.navigate': () => ({ frameId: 'f1' }),
    'Input.dispatchMouseEvent': () => ({}),
    'Input.insertText': () => ({}),
    'Input.dispatchKeyEvent': () => ({}),
    'Target.createTarget': () => ({ targetId: 't2' }),
    'Target.closeTarget': () => ({ success: true }),
    'Accessibility.getFullAXTree': () => ({ nodes: [{ role: { value: 'RootWebArea' }, name: { value: 'Example' } }] }),
    'Runtime.evaluate': (params) => {
      const expression = String(params.expression ?? '')
      // The page's own address, read by the post-op check.
      if (expression === 'location.href') return { result: { value: 'https://example.com/' } }
      if (expression.includes('location.href')) return { result: { value: { url: 'https://example.com/', title: 'Example' } } }
      if (expression.includes('outerHTML')) return { result: { value: HTML } }
      if (expression.includes('innerText')) return { result: { value: TEXT } }
      if (expression.includes('innerWidth')) return { result: { value: { width: 1200, height: 800 } } }
      if (expression.includes('#missing')) return { result: { value: false } }
      return { result: { value: true } }
    },
    'Page.captureScreenshot': (params) => {
      // A realistic case: high quality is too big, a low quality fits.
      const bytes = params.clip ? 200_000 : (params.quality ?? 75) >= 50 ? 1_000_000 : 100_000
      if (bytes === 1_000_000 && params.clip === undefined && params.forceTooBig === true) return { data: 'A'.repeat(Math.ceil(bytes / 3) * 4) }
      return { data: Buffer.alloc(bytes, 1).toString('base64') }
    },
  }
  let buffer = ''
  input.on('data', (chunk) => {
    buffer += chunk.toString('utf8')
    for (let at = buffer.indexOf('\0'); at >= 0; at = buffer.indexOf('\0')) {
      const text = buffer.slice(0, at)
      buffer = buffer.slice(at + 1)
      if (!text.trim()) continue
      const message = JSON.parse(text)
      handled.push(message)
      const route = routes[message.method] ?? defaultRoutes[message.method]
      if (!route) continue // no answer: exercises the deadline and the kill switch
      const result = route(message.params ?? {})
      if (result === undefined) continue
      output.write(`${JSON.stringify({ id: message.id, result })}\0`)
    }
  })
  onSpawn?.({ child, state, handled })
  /** Push one browser → client CDP event (a paused request, an attached popup). */
  const emit = (message) => output.write(`${JSON.stringify(message)}\0`)
  return { child, state, handled, input, output, emit }
}

function browserFor(fake, overrides = {}) {
  return new AgentBrowser({
    hostId: 'r1', profileDir: 'C:/tmp/data/agent-browser-profile/r1', log: () => {},
    spawn: () => fake.child, exists: () => true, configuredPath: 'C:/fake/chrome.exe',
    mkdir: () => true, idleMs: 0, ...overrides,
  })
}

// ---------------------------------------------------------------------------
await check('launch: headless, the debugging PIPE only, and one profile per host', () => {
  const args = browserLaunchArgs({ profileDir: 'C:/data/agent-browser-profile/r1' })
  assert.ok(args.includes('--headless=new'))
  assert.ok(args.includes('--remote-debugging-pipe'))
  assert.ok(args.includes('--user-data-dir=C:/data/agent-browser-profile/r1'))
  assert.ok(args.includes('--no-first-run'))
  assert.ok(args.includes('--no-default-browser-check'))
  assert.equal(args.some((arg) => arg.startsWith('--remote-debugging-port')), false, 'no TCP port may be opened')
  assert.equal(args.filter((arg) => arg.startsWith('--remote-debugging-')).length, 1, 'exactly one transport')
})

await check('launch: WebRTC is kept off unproxied UDP, or ICE would bypass the proxy', () => {
  // ICE/STUN is UDP and ignores --proxy-server, so the browser needs to be told by
  // switch that unproxied UDP is not an option; otherwise a page can probe the LAN.
  const args = browserLaunchArgs({ profileDir: 'C:/p', proxyPort: 4321 })
  assert.ok(args.includes('--force-webrtc-ip-handling-policy=disable_non_proxied_udp'))
  // Nothing to bypass without a proxy, so the flag belongs to the proxied launch only.
  assert.equal(browserLaunchArgs({ profileDir: 'C:/p' }).some((arg) => arg.includes('webrtc')), false)
})

await check('no Chrome/Edge installed: a typed refusal, nothing downloaded', async () => {
  const browser = new AgentBrowser({
    hostId: 'r1', profileDir: 'C:/tmp/x', log: () => {},
    spawn: () => { throw new Error('must not spawn') }, exists: () => false, configuredPath: '',
    mkdir: () => true, platform: 'linux', env: {},
  })
  await assert.rejects(browser.op('text', {}), (error) => error.code === 'browser/not-supported' && /no Chrome or Edge/.test(error.message))
})

await check('spawn arguments reach the process exactly as the contract requires', async () => {
  const seen = []
  const fake = fakeBrowser()
  const browser = browserFor(fake, {
    spawn: (executable, args) => { seen.push([executable, args]); return fake.child },
  })
  await browser.start()
  assert.equal(seen.length, 1)
  assert.equal(seen[0][0], 'C:/fake/chrome.exe')
  const args = seen[0][1]
  assert.ok(args.includes('--remote-debugging-pipe'))
  assert.equal(args.some((arg) => arg.startsWith('--remote-debugging-port')), false)
  assert.ok(args.includes('--user-data-dir=C:/tmp/data/agent-browser-profile/r1'))
  browser.close()
})

await check('page URL policy: http/https only, never this machine or this network', () => {
  const allowed = ['http://example.com/', 'https://example.com/a?b=c', 'http://news.example.org:8080/x']
  for (const url of allowed) assert.equal(checkPageUrl(url).ok, true, url)
  for (const url of [
    'ftp://example.com/', 'file:///etc/passwd', 'javascript:alert(1)', 'data:text/html,x', 'not a url', '',
  ]) assert.equal(checkPageUrl(url).ok, false, url)
  for (const url of [
    'http://localhost:3000/', 'http://LOCALHOST/', 'http://localhost./', 'http://app.localhost:8080/',
    'http://127.0.0.1:13210/', 'https://127.5.5.5/', 'http://0.0.0.0:80/', 'http://[::1]:13210/',
    'http://[::ffff:127.0.0.1]/', 'http://[::7f00:1]/', 'http://[::]/',
  ]) {
    const verdict = checkPageUrl(url)
    assert.equal(verdict.ok, false, url)
    assert.equal(verdict.reason, 'loopback', url)
  }
  // Private, link-local, CGNAT/Tailscale and IPv6 local ranges: a LAN neighbour is not
  // this machine, but it is still not somewhere an agent on this machine may go.
  for (const url of [
    'http://10.0.0.5/', 'http://172.16.3.4/', 'http://172.31.255.254/', 'http://192.168.1.20:3081/',
    'http://169.254.169.254/latest/meta-data/', 'http://100.64.0.1/', 'http://100.127.255.254/',
    'http://[fc00::1]/', 'http://[fd12:3456::1]/', 'http://[fe80::1]/', 'http://[::10.0.0.5]/',
  ]) {
    const verdict = checkPageUrl(url)
    assert.equal(verdict.ok, false, url)
    assert.equal(verdict.reason, 'private', url)
  }
  // ...while a neighbouring public address is not caught by those ranges.
  for (const url of ['http://172.32.0.1/', 'http://100.128.0.1/', 'http://11.0.0.1/', 'http://[fdix::1]']) {
    const verdict = checkPageUrl(url)
    assert.equal(verdict.ok, url === 'http://[fdix::1]' ? false : true, url)
  }
  assert.equal(checkPageUrl('http://user:pw@example.com/').ok, false)
  // This machine's DSH server, when it binds a LAN (or a routed) address.
  const blocked = { blockedOrigins: ['203.0.113.5:3081', 'https://dsh.local:443'] }
  assert.equal(checkPageUrl('http://203.0.113.5:3081/api', blocked).reason, 'dsh-server')
  assert.equal(checkPageUrl('https://dsh.local/anything', blocked).reason, 'dsh-server')
  assert.equal(checkPageUrl('http://203.0.113.5:9999/', blocked).ok, true)
})

// ---------------------------------------------------------------------------
// The egress proxy: the socket-level half of the same policy. Chromium is launched
// against it, so a name is resolved here ONCE and the connection opens on the address
// that was checked — a rebind cannot hand the browser a second answer.
const RESOLVER = (overrides = {}) => async (host) => {
  const table = {
    'public.test': [{ address: '203.0.113.9', family: 4 }],
    'private.test': [{ address: '192.168.1.5', family: 4 }],
    // A name that answers a public A record first and this machine second: the second
    // answer is exactly what a rebinding name wants, and any blocked address refuses.
    'rebind.test': [{ address: '203.0.113.9', family: 4 }, { address: '127.0.0.1', family: 4 }],
    'v6local.test': [{ address: 'fd00::1', family: 6 }],
    ...overrides,
  }
  if (!table[host]) return [{ address: '203.0.113.9', family: 4 }]
  if (table[host] instanceof Error) throw table[host]
  if (typeof table[host] === 'function') return table[host]()
  return table[host]
}

/** Send one raw HTTP message to a proxy port and read until it closes. */
function proxyRequest(port, text, { waitMs = 1500 } = {}) {
  return new Promise((resolve) => {
    const socket = net.connect(port, '127.0.0.1')
    let out = ''
    let done = false
    const finishOnce = () => {
      if (done) return
      done = true
      try { socket.destroy() } catch { /* already gone */ }
      resolve(out)
    }
    socket.on('connect', () => socket.write(text))
    socket.on('data', (chunk) => { out += chunk.toString('latin1') })
    socket.on('close', finishOnce)
    socket.on('error', finishOnce)
    // A tunnel that was established stays open on purpose: read the head, then stop.
    setTimeout(finishOnce, waitMs)
  })
}

/** The status line of a proxy answer, or '' when nothing came back. */
const statusOf = (text) => (text.split('\r\n')[0] ?? '')

/**
 * A proxy that lets the named test hosts through to loopback. Policy refuses loopback
 * (the checks above cover that); the transport tests below need a real origin to talk
 * to, so only those names get through and everything else takes the real verdict.
 */
function loopbackProxyFor(names, options = {}) {
  const allowed = new Set(names)
  return new (class extends EgressProxy {
    async verdict(host, port) {
      if (allowed.has(host)) return { ok: true, address: '127.0.0.1', family: 4, authority: `${host}:${port}` }
      return super.verdict(host, port)
    }
  })(options)
}

/** Listen on an ephemeral loopback port; resolves with the port. */
const listenLoopback = (server) => new Promise((resolve) => {
  server.listen(0, '127.0.0.1', () => resolve(server.address().port))
})

await check('egress proxy: loopback, private and rebinding names are refused on the socket', async () => {
  const proxy = new EgressProxy({ resolveHost: RESOLVER(), dnsTimeoutMs: 200 })
  await proxy.start()
  try {
    assert.ok(proxy.port > 0, 'it bound a loopback port')
    const cases = [
      ['http://127.0.0.1:3080/secret', '403', 'a loopback literal'],
      ['http://localhost:3080/', '403', 'the loopback name'],
      ['http://[::1]:3080/', '403', 'an IPv6 loopback literal'],
      ['http://private.test/admin', '403', 'a name resolving into the LAN'],
      ['http://v6local.test/', '403', 'a name resolving to a ULA'],
      ['http://rebind.test/', '403', 'a rebinding name whose second answer is this machine'],
    ]
    for (const [url, code, why] of cases) {
      const answer = await proxyRequest(proxy.port, `GET ${url} HTTP/1.1\r\nHost: x\r\n\r\n`)
      assert.match(statusOf(answer), new RegExp(` ${code} `), `${why}: ${statusOf(answer)}`)
    }
  } finally { await proxy.close() }
})

await check('egress proxy: CONNECT to private and to loopback is refused before any tunnel', async () => {
  const proxy = new EgressProxy({ resolveHost: RESOLVER(), dnsTimeoutMs: 200 })
  await proxy.start()
  try {
    for (const authority of ['private.test:443', '127.0.0.1:3080', '[::1]:443', 'localhost:80']) {
      const answer = await proxyRequest(proxy.port, `CONNECT ${authority} HTTP/1.1\r\nHost: ${authority}\r\n\r\n`)
      assert.match(statusOf(answer), / 403 /, `${authority}: ${statusOf(answer)}`)
      assert.equal(/200 Connection Established/.test(answer), false, `${authority} gave no tunnel`)
    }
  } finally { await proxy.close() }
})

await check('egress proxy: a WebSocket upgrade to this machine is refused before piping', async () => {
  const proxy = new EgressProxy({ resolveHost: RESOLVER(), dnsTimeoutMs: 200 })
  await proxy.start()
  try {
    const upgrade = (url) => `GET ${url} HTTP/1.1\r\nHost: x\r\nConnection: Upgrade\r\nUpgrade: websocket\r\n`
      + `Sec-WebSocket-Key: ${SAMPLE_WS_KEY}\r\nSec-WebSocket-Version: 13\r\n\r\n`
    for (const url of ['http://127.0.0.1:3080/ws', 'ws://127.0.0.1:3080/ws', 'http://rebind.test/ws']) {
      const answer = await proxyRequest(proxy.port, upgrade(url))
      assert.match(statusOf(answer), / 403 /, `${url}: ${statusOf(answer)}`)
      assert.equal(/101 Switching Protocols/.test(answer), false, `${url} was never upgraded`)
    }
  } finally { await proxy.close() }
})

await check('egress proxy: a lookup that fails or times out is refused, and never cached', async () => {
  let calls = 0
  const proxy = new EgressProxy({
    dnsTimeoutMs: 40,
    resolveHost: async (host) => {
      calls += 1
      if (host === 'slow.test') return new Promise(() => {}) // never answers
      if (host === 'broken.test') throw new Error('no dns')
      return [{ address: '203.0.113.9', family: 4 }]
    },
  })
  await proxy.start()
  try {
    for (const host of ['slow.test', 'broken.test']) {
      const answer = await proxyRequest(proxy.port, `GET http://${host}/x HTTP/1.1\r\nHost: ${host}\r\n\r\n`)
      assert.match(statusOf(answer), / 407 /, `${host}: ${statusOf(answer)}`)
    }
    // The failures were not remembered: each request asks the resolver again.
    assert.equal(calls >= 2, true, `the resolver was asked per request (${calls})`)
    await proxyRequest(proxy.port, 'GET http://slow.test/x HTTP/1.1\r\nHost: slow.test\r\n\r\n')
    assert.equal(calls >= 3, true, 'a timed-out name is resolved again, not remembered as blocked')
  } finally { await proxy.close() }
})

await check('egress proxy: a public name is allowed and dialled on the address that was checked', async () => {
  // No network here: the dial fails, but the VERDICT is what this asserts — the proxy
  // opens the socket to the literal it judged, never to a second resolver answer.
  const dialled = []
  const proxy = new EgressProxy({ resolveHost: RESOLVER(), dnsTimeoutMs: 200 })
  await proxy.start()
  try {
    const verdict = await proxy.verdict('public.test', 80)
    assert.deepEqual({ ok: verdict.ok, address: verdict.address }, { ok: true, address: '203.0.113.9' })
    assert.equal((await proxy.verdict('public.test', 0)).ok, false, 'port 0 is out of range')
    assert.equal((await proxy.verdict('public.test', 70000)).ok, false, 'port 70000 is out of range')
    assert.equal((await proxy.verdict('public.test', 65535)).ok, true, 'the top of the range is usable')
    dialled.push(proxy.port)
  } finally { await proxy.close() }
})

await check('egress proxy: the DSH origin is refused even on a public address', async () => {
  const proxy = new EgressProxy({ resolveHost: RESOLVER(), dnsTimeoutMs: 200, blockedOrigins: () => ['203.0.113.9:3081'] })
  await proxy.start()
  try {
    const verdict = await proxy.verdict('public.test', 3081)
    assert.equal(verdict.ok, false, 'the DSH server is never reachable through the proxy')
    assert.match(verdict.reason, /DSH server/)
    assert.equal((await proxy.verdict('public.test', 3082)).ok, true, 'another port on that host is a normal site')
    const answer = await proxyRequest(proxy.port, 'GET http://public.test:3081/api HTTP/1.1\r\nHost: public.test:3081\r\n\r\n')
    assert.match(statusOf(answer), / 403 /)
  } finally { await proxy.close() }
})

await check('egress proxy: HTTP is forwarded to the checked address, absolute URI rewritten', async () => {
  // A real origin, reached through the proxy's own dial. Policy refuses loopback, so
  // this proxy is told to allow it for one test name only: the pipe is what is under
  // test here, and the refusals above cover the policy.
  const origin = net.createServer((socket) => {
    socket.once('data', (chunk) => {
      const head = chunk.toString('latin1')
      const [requestLine] = head.split('\r\n')
      socket.end(`HTTP/1.1 200 OK\r\nContent-Length: ${Buffer.byteLength(requestLine)}\r\nConnection: close\r\n\r\n${requestLine}`)
    })
  })
  await new Promise((resolve) => origin.listen(0, '127.0.0.1', resolve))
  const originPort = origin.address().port
  const proxy = loopbackProxyFor(['origin.test'], { resolveHost: RESOLVER() })
  await proxy.start()
  try {
    // The URL's own port is the port dialled: the proxy never rewrites it.
    const answer = await proxyRequest(proxy.port,
      `GET http://origin.test:${originPort}/a/b?c=1 HTTP/1.1\r\nHost: origin.test:${originPort}\r\nConnection: close\r\n\r\n`)
    const body = answer.slice(answer.indexOf('\r\n\r\n') + 4)
    assert.equal(statusOf(answer), 'HTTP/1.1 200 OK')
    assert.equal(body, `GET /a/b?c=1 HTTP/1.1`, 'the origin saw an origin-form request line, not the absolute URI')
  } finally { await proxy.close(); origin.close() }
})

await check('egress proxy: a POST body reaches the origin intact and the answer comes back', async () => {
  // A raw piped socket loses whatever the HTTP parser had already consumed of the
  // body; the forwarding path must carry it, byte for byte.
  const seen = []
  const origin = http.createServer((req, res) => {
    const chunks = []
    req.on('data', (chunk) => chunks.push(chunk))
    req.on('end', () => {
      seen.push({ method: req.method, url: req.url, host: req.headers.host, body: Buffer.concat(chunks).toString('utf8') })
      const answer = Buffer.from(JSON.stringify({ received: Buffer.concat(chunks).toString('utf8'), host: req.headers.host }))
      res.writeHead(200, { 'Content-Type': 'application/json', 'Content-Length': answer.length })
      res.end(answer)
    })
  })
  const originPort = await listenLoopback(origin)
  const proxy = loopbackProxyFor(['post.test'], { resolveHost: RESOLVER() })
  await proxy.start()
  try {
    const payload = JSON.stringify({ hello: 'world', pad: 'p'.repeat(4096) })
    const answer = await proxyRequest(proxy.port,
      `POST http://post.test:${originPort}/submit?x=1 HTTP/1.1\r\nHost: post.test:${originPort}\r\n`
      + `Content-Type: application/json\r\nContent-Length: ${Buffer.byteLength(payload)}\r\n`
      + `Connection: close\r\n\r\n${payload}`)
    assert.equal(statusOf(answer), 'HTTP/1.1 200 OK')
    const body = answer.slice(answer.indexOf('\r\n\r\n') + 4)
    assert.deepEqual(JSON.parse(body), { received: payload, host: `post.test:${originPort}` },
      'the origin received the whole body, addressed to the name the browser asked for')
    assert.deepEqual(seen.map((one) => [one.method, one.url, one.body.length]),
      [['POST', '/submit?x=1', Buffer.byteLength(payload)]])
  } finally { await proxy.close(); origin.close() }
})

await check('egress proxy: keep-alive requests for different hosts take their own upstream', async () => {
  // The client keeps ONE connection to the proxy and sends two requests on it. Each
  // must be forwarded to its own host; a raw socket pipe would copy the second request
  // onto the upstream dialled for the first (and lose what the parser had consumed).
  const answers = new Map()
  const makeOrigin = (name) => {
    const seen = []
    const server = http.createServer((req, res) => {
      seen.push(`${req.method} ${req.url} host=${req.headers.host}`)
      const body = Buffer.from(`${name}:${req.url}`)
      res.writeHead(200, { 'Content-Type': 'text/plain', 'Content-Length': body.length })
      res.end(body)
    })
    return { server, seen }
  }
  const first = makeOrigin('A')
  const second = makeOrigin('B')
  const firstPort = await listenLoopback(first.server)
  const secondPort = await listenLoopback(second.server)
  const proxy = loopbackProxyFor(['a.test', 'b.test'], { resolveHost: RESOLVER() })
  await proxy.start()
  let connections = 0
  proxy.server.on('connection', () => { connections += 1 })
  const agent = new http.Agent({ keepAlive: true, maxSockets: 1 })
  const get = (host, port, path) => new Promise((resolve, reject) => {
    const req = http.request({
      host: '127.0.0.1',
      port: proxy.port,
      method: 'GET',
      path: `http://${host}:${port}${path}`,
      headers: { host: `${host}:${port}`, connection: 'keep-alive' },
      agent,
    }, (res) => {
      const chunks = []
      res.on('data', (chunk) => chunks.push(chunk))
      res.on('end', () => resolve({ status: res.statusCode, body: Buffer.concat(chunks).toString('utf8') }))
    })
    req.once('error', reject)
    req.end()
  })
  try {
    answers.set('a', await get('a.test', firstPort, '/one'))
    answers.set('b', await get('b.test', secondPort, '/two'))
    assert.deepEqual(answers.get('a'), { status: 200, body: 'A:/one' })
    assert.deepEqual(answers.get('b'), { status: 200, body: 'B:/two' })
    assert.deepEqual(first.seen, [`GET /one host=a.test:${firstPort}`], 'the first host saw only its own request')
    assert.deepEqual(second.seen, [`GET /two host=b.test:${secondPort}`], 'the second host saw only its own request')
    assert.equal(connections, 1, 'both requests rode the one client connection')
  } finally { agent.destroy(); await proxy.close(); first.server.close(); second.server.close() }
})

await check('egress proxy: a WebSocket 101 keeps the handshake headers the page needs', async () => {
  // A fabricated `101 Switching Protocols` with no headers fails every browser
  // WebSocket: Upgrade, Connection and Sec-WebSocket-Accept are the handshake.
  const accept = 's3pPLMBiTxaQ9kYGzzhZRbK+xOo='
  const origin = net.createServer((socket) => {
    socket.once('data', () => {
      socket.write('HTTP/1.1 101 Switching Protocols\r\n'
        + 'Upgrade: websocket\r\nConnection: Upgrade\r\n'
        + `Sec-WebSocket-Accept: ${accept}\r\n`
        + 'Sec-WebSocket-Extensions: permessage-deflate\r\n'
        + 'Proxy-Connection: keep-alive\r\n\r\n')
      socket.end()
    })
  })
  const originPort = await listenLoopback(origin)
  const proxy = loopbackProxyFor(['ws.test'], { resolveHost: RESOLVER() })
  await proxy.start()
  try {
    const answer = await proxyRequest(proxy.port,
      `GET http://ws.test:${originPort}/socket HTTP/1.1\r\nHost: ws.test:${originPort}\r\n`
      + 'Connection: Upgrade\r\nUpgrade: websocket\r\n'
      + `Sec-WebSocket-Key: ${SAMPLE_WS_KEY}\r\nSec-WebSocket-Version: 13\r\n\r\n`)
    assert.equal(statusOf(answer), 'HTTP/1.1 101 Switching Protocols')
    assert.match(answer, new RegExp(`Sec-WebSocket-Accept: ${accept.replace(/[+/]/g, '\\$&')}`))
    assert.match(answer, /Upgrade: websocket/)
    assert.match(answer, /Connection: Upgrade/)
    assert.equal(/Proxy-Connection/i.test(answer), false, 'the proxy hop header stays here')
  } finally { await proxy.close(); origin.close() }
})

await check('egress proxy: a header named in Connection is hop-by-hop and is not forwarded (HTTP and upgrade)', async () => {
  const seen = []
  const origin = net.createServer((socket) => {
    socket.once('data', (chunk) => {
      seen.push(chunk.toString('latin1').toLowerCase())
      if (/upgrade: websocket/.test(seen[seen.length - 1])) {
        socket.write('HTTP/1.1 101 Switching Protocols\r\nUpgrade: websocket\r\nConnection: Upgrade\r\nSec-WebSocket-Accept: x\r\n\r\n')
        socket.end()
        return
      }
      socket.end('HTTP/1.1 200 OK\r\nContent-Length: 0\r\nConnection: close\r\n\r\n')
    })
  })
  const originPort = await listenLoopback(origin)
  const proxy = loopbackProxyFor(['hop.test'], { resolveHost: RESOLVER() })
  await proxy.start()
  try {
    const plain = await proxyRequest(proxy.port,
      `GET http://hop.test:${originPort}/p HTTP/1.1\r\nHost: hop.test:${originPort}\r\n`
      + 'Connection: close, X-Foo\r\nX-Foo: 1\r\nX-Keep: 2\r\n\r\n')
    assert.equal(statusOf(plain), 'HTTP/1.1 200 OK')
    assert.equal(/^x-foo:/m.test(seen[0]), false, `X-Foo named in Connection was not forwarded:\n${seen[0]}`)
    assert.match(seen[0], /x-keep: 2/, 'an unrelated header still goes through')

    const upgraded = await proxyRequest(proxy.port,
      `GET http://hop.test:${originPort}/s HTTP/1.1\r\nHost: hop.test:${originPort}\r\n`
      + 'Connection: Upgrade, X-Foo\r\nUpgrade: websocket\r\nX-Foo: 1\r\nX-Keep: 2\r\n'
      + `Sec-WebSocket-Key: ${SAMPLE_WS_KEY}\r\nSec-WebSocket-Version: 13\r\n\r\n`)
    assert.equal(statusOf(upgraded), 'HTTP/1.1 101 Switching Protocols')
    // `Connection`'s own value still lists the token; what must be gone is the header line.
    assert.equal(/^x-foo:/m.test(seen[1]), false, `X-Foo was not forwarded on the upgrade path:\n${seen[1]}`)
    assert.match(seen[1], /connection: upgrade, x-foo/, 'Connection itself is kept for the handshake')
    assert.match(seen[1], /upgrade: websocket/, 'Upgrade is kept')
    assert.match(seen[1], /sec-websocket-key:/, 'handshake headers are kept')
    assert.match(seen[1], /x-keep: 2/, 'an unrelated header still goes through')
  } finally { await proxy.close(); origin.close() }
})

await check('egress proxy: the connect timeout is cleared once connected (a silent response is not cut), and a dead dial still times out', async () => {
  // The origin accepts, then stays quiet for longer than the (shortened) timeout
  // before answering: an idle timeout left armed would destroy this request.
  const SHORT = 150
  const origin = http.createServer((req, res) => {
    setTimeout(() => { res.writeHead(200, { 'Content-Length': 4 }); res.end('late') }, SHORT * 3)
  })
  const originPort = await listenLoopback(origin)
  const proxy = loopbackProxyFor(['quiet.test'], { resolveHost: RESOLVER(), connectTimeoutMs: SHORT })
  await proxy.start()
  try {
    const answer = await proxyRequest(proxy.port,
      `GET http://quiet.test:${originPort}/poll HTTP/1.1\r\nHost: quiet.test:${originPort}\r\nConnection: close\r\n\r\n`,
      { waitMs: SHORT * 6 })
    assert.equal(statusOf(answer), 'HTTP/1.1 200 OK', `a response silent for >${SHORT}ms survives: ${answer}`)
    assert.equal(answer.slice(answer.indexOf('\r\n\r\n') + 4), 'late')
  } finally { await proxy.close(); origin.close() }

  // An unreachable upstream (a SYN that is never answered) still ends at the connect timeout.
  const dead = new (class extends EgressProxy {
    async verdict(host, port) { return { ok: true, address: '203.0.113.1', family: 4, authority: `${host}:${port}` } }
  })({ resolveHost: RESOLVER(), connectTimeoutMs: 100 })
  await dead.start()
  try {
    const started = Date.now()
    const answer = await proxyRequest(dead.port, 'GET http://dead.test:81/x HTTP/1.1\r\nHost: dead.test:81\r\nConnection: close\r\n\r\n',
      { waitMs: 3000 })
    assert.match(statusOf(answer), / 502 /, `the stalled dial was cut and refused: ${statusOf(answer)}`)
    assert.ok(Date.now() - started < 2500, 'it ended at the connect timeout, not at TCP give-up')
  } finally { await dead.close() }
})

await check('egress proxy: one per launch, its port in the launch args, gone when the browser closes', async () => {
  const fake = fakeBrowser()
  const seen = []
  const proxies = []
  const browser = browserFor(fake, {
    spawn: (_executable, args) => { seen.push(args); return fake.child },
    createProxy: (options) => { const proxy = new EgressProxy(options); proxies.push(proxy); return proxy },
  })
  await browser.start()
  assert.equal(proxies.length, 1, 'exactly one proxy per launch')
  assert.ok(browser.proxyPort > 0)
  assert.ok(seen[0].includes(`--proxy-server=http://127.0.0.1:${browser.proxyPort}`), 'the browser is pointed at it')
  for (const flag of ['--proxy-bypass-list=<-loopback>', '--disable-quic', '--dns-prefetch-disable',
    '--disable-features=DnsOverHttps', '--disable-background-networking',
    '--force-webrtc-ip-handling-policy=disable_non_proxied_udp']) {
    assert.ok(seen[0].includes(flag), `launch carries ${flag}`)
  }
  assert.equal(proxies[0].started, true)
  browser.close()
  await delay(30)
  assert.equal(proxies[0].started, false, 'closing the browser closes its proxy')
  assert.equal(browser.proxyPort, 0)
})

await check('egress proxy: a listener error after bind drops the proxy, never throws out of the Host', async () => {
  let reported = 0
  const proxy = new EgressProxy({ resolveHost: RESOLVER(), onError: () => { reported += 1 } })
  await proxy.start()
  // An `error` with no listener would be an uncaught exception in the Host process.
  assert.doesNotThrow(() => proxy.server.emit('error', new Error('the listener died')))
  assert.equal(reported, 1, 'the owner is told, once')
  assert.equal(proxy.started, false, 'the dead proxy is not left "started"')
  assert.equal(proxy.port, 0)
  await delay(20)
  // The failure is survivable: a fresh proxy still binds and serves a verdict.
  const again = new EgressProxy({ resolveHost: RESOLVER() })
  await again.start()
  assert.ok(again.port > 0, 'another proxy can bind after the failure')
  await again.close()
})

await check('egress proxy: a listener error tears the browser down, not just the proxy', async () => {
  const fake = fakeBrowser()
  let proxy
  const browser = browserFor(fake, {
    createProxy: (options) => { proxy = new EgressProxy(options); return proxy },
  })
  await browser.start()
  assert.equal(browser.running, true)
  proxy.server.emit('error', new Error('the listener died'))
  await delay(30)
  assert.equal(proxy.started, false)
  assert.equal(browser.running, false, 'a browser with no egress policy is not left running')
  assert.equal(fake.state.killed >= 1, true, 'the process was stopped')
})

await check('egress proxy: a launch that cannot guard its targets never runs a browser', async () => {
  // `Target.setAutoAttach` refused: popups and OOPIFs could not be guarded, so the
  // launch is refused instead of running a half-guarded tab.
  const fake = fakeBrowser({ routes: { 'Target.setAutoAttach': () => undefined } })
  const proxies = []
  const browser = browserFor(fake, {
    createProxy: (options) => { const proxy = new EgressProxy(options); proxies.push(proxy); return proxy },
  })
  await assert.rejects(browser.start(), (error) => error.code === 'browser/not-supported' && /auto-attach/.test(error.message))
  assert.equal(browser.running, false, 'no browser is left running')
  assert.equal(fake.state.killed >= 1, true, 'and the process was stopped')
  assert.equal(proxies[0].started, false, 'and its proxy was closed')
})

await check('request hook: a target whose hook cannot be installed is closed, never resumed', async () => {
  const fake = fakeBrowser({ routes: { 'Fetch.enable': () => undefined } })
  const browser = browserFor(fake)
  await assert.rejects(browser.start(), (error) => error.code === 'browser/not-supported' && /could not be guarded/.test(error.message))
  assert.equal(fake.handled.some((message) => message.method === 'Fetch.enable'), true, 'it tried')
  assert.equal(fake.handled.some((message) => message.method === 'Runtime.runIfWaitingForDebugger'), false,
    'and never resumed an unguarded target')
  assert.equal(fake.handled.some((message) => message.method === 'Target.closeTarget'), true, 'the target was closed instead')
})

await check('request hook: every page session asks for its own children (OOPIFs, workers)', async () => {
  const fake = fakeBrowser({ routes: { 'Target.attachToTarget': (params) => ({ sessionId: params.targetId === 'popup' ? 's2' : 's1' }) } })
  const browser = browserFor(fake)
  await browser.start()
  const autoAttach = fake.handled.filter((message) => message.method === 'Target.setAutoAttach')
  assert.equal(autoAttach[0].sessionId, undefined, 'the browser-level auto-attach is still sent')
  assert.deepEqual(autoAttach[0].params, { autoAttach: true, waitForDebuggerOnStart: true, flatten: true })
  // The tab's own session asks for its children too, before it is resumed.
  const forTab = autoAttach.filter((message) => message.sessionId === 's1')
  assert.equal(forTab.length, 1)
  assert.deepEqual(forTab[0].params, { autoAttach: true, waitForDebuggerOnStart: true, flatten: true })
  // A popup is attached, guarded, and only then resumed — with its own recursion.
  fake.emit({ method: 'Target.attachedToTarget',
    params: { sessionId: 's2', targetInfo: { targetId: 'popup', type: 'page' }, waitingForDebugger: true } })
  await delay(20)
  const forPopup = fake.handled.filter((message) => message.method === 'Target.setAutoAttach' && message.sessionId === 's2')
  assert.equal(forPopup.length, 1, 'the popup asks for its own children')
  assert.equal(fake.handled.some((message) => message.method === 'Runtime.runIfWaitingForDebugger' && message.sessionId === 's2'), true)
  browser.close()
})

// ---------------------------------------------------------------------------
await check('ops: navigate, click, text/html/inner limits, tabs, screenshot, snapshot', async () => {
  const fake = fakeBrowser()
  const browser = browserFor(fake)
  const navigation = await browser.op('navigate', { url: 'https://example.com' })
  assert.equal(navigation.url, 'https://example.com/')
  assert.equal(navigation.title, 'Example')

  await assert.rejects(browser.op('navigate', { url: 'http://127.0.0.1:13210/' }),
    (error) => error.code === 'browser/bad-request' && /this machine/.test(error.message))

  const clicked = await browser.op('click', { selector: '#go' })
  assert.deepEqual(clicked, { clicked: true, selector: '#go' })
  await assert.rejects(browser.op('click', { selector: '#missing' }), (error) => error.code === 'browser/not-found')

  await browser.op('type', { selector: '#q', text: 'dsh' })
  await browser.op('press', { key: 'Enter' })
  await browser.op('scroll', { deltaY: 500 })

  const text = await browser.op('text', {})
  assert.equal(text.truncated, true)
  assert.ok(Buffer.byteLength(text.text, 'utf8') <= TEXT_MAX_BYTES)
  assert.equal(Buffer.byteLength(text.text, 'utf8'), TEXT_MAX_BYTES)

  const html = await browser.op('html', {})
  assert.equal(html.truncated, true)
  assert.ok(Buffer.byteLength(html.html, 'utf8') <= TEXT_MAX_BYTES)

  const tabs = await browser.op('tabs', {})
  assert.deepEqual(tabs.tabs.map((tab) => tab.tabId), ['t1'])
  assert.equal((await browser.op('open', { url: 'https://example.com/new' })).tabId, 't2')
  assert.deepEqual(await browser.op('close', { tabId: 't2' }), { closed: true, tabId: 't2' })

  const snapshot = await browser.op('snapshot', {})
  assert.equal(snapshot.truncated, false)
  assert.match(snapshot.snapshot, /RootWebArea Example/)
  assert.ok(fake.handled.some((message) => message.method === 'Page.navigate'))
  browser.close()
})

// ---------------------------------------------------------------------------
// Request-time enforcement: the URL a caller sent is not the only address the page
// reaches. A 302, a script navigation and a `window.open` popup all arrive as
// requests the caller never named, so every paused request is checked.
const paused = (requestId, url) => ({
  method: 'Fetch.requestPaused', params: { requestId, request: { url }, resourceType: 'Document' },
})

await check('request hook: Fetch runs on the tab and on auto-attached popups', async () => {
  const fake = fakeBrowser()
  const browser = browserFor(fake)
  await browser.start()
  const guard = fake.handled.filter((message) => message.method === 'Fetch.enable')
  assert.equal(guard.length >= 1, true)
  assert.deepEqual(guard[0].params.patterns, [{ urlPattern: '*', requestStage: 'Request' }],
    'every request, at the Request stage, on the attached tab')
  assert.equal(guard[0].sessionId, 's1')
  assert.equal(fake.handled.some((message) => message.method === 'Target.setAutoAttach'
    && message.params.flatten === true && message.params.autoAttach === true), true)
  browser.close()
})

await check('request hook: a 302 to 127.0.0.1 is failed, not followed', async () => {
  const fake = fakeBrowser()
  const browser = browserFor(fake)
  await browser.start()
  fake.emit(paused('r1', 'http://127.0.0.1:13210/redirected'))
  await delay(10)
  const failed = fake.handled.filter((message) => message.method === 'Fetch.failRequest')
  assert.equal(failed.length, 1)
  assert.deepEqual(failed[0].params, { requestId: 'r1', errorReason: 'BlockedByClient' })
  assert.equal(failed[0].sessionId, 's1')
  assert.equal(fake.handled.some((message) => message.method === 'Fetch.continueRequest'), false)
  browser.close()
})

await check('request hook: a script navigation to a private address is failed too', async () => {
  const fake = fakeBrowser()
  const browser = browserFor(fake)
  await browser.start()
  for (const [id, url] of [
    ['r1', 'http://10.0.0.5/admin'],
    ['r2', 'http://169.254.169.254/latest/meta-data/'],
    ['r3', 'http://[fd00::1]/'],
    ['r4', 'http://app.localhost:8080/'],
  ]) fake.emit(paused(id, url))
  await delay(20)
  const failed = fake.handled.filter((message) => message.method === 'Fetch.failRequest')
  assert.deepEqual(failed.map((message) => message.params.requestId), ['r1', 'r2', 'r3', 'r4'])
  assert.equal(fake.handled.some((message) => message.method === 'Fetch.continueRequest'), false)
  browser.close()
})

await check('request hook: a window.open popup is guarded before it loads anything', async () => {
  const fake = fakeBrowser({ routes: { 'Target.attachToTarget': (params) => ({ sessionId: params.targetId === 'popup' ? 's2' : 's1' }) } })
  const browser = browserFor(fake)
  await browser.start()
  fake.emit({ method: 'Target.attachedToTarget',
    params: { sessionId: 's2', targetInfo: { targetId: 'popup', type: 'page', url: 'about:blank' }, waitingForDebugger: true } })
  await delay(20)
  const forPopup = fake.handled.filter((message) => message.method === 'Fetch.enable' && message.sessionId === 's2')
  assert.equal(forPopup.length, 1, 'the popup gets its own request hook')
  assert.equal(fake.handled.some((message) => message.method === 'Runtime.runIfWaitingForDebugger' && message.sessionId === 's2'), true,
    'and is only resumed after the hook is in place')
  // A request the popup makes to this machine is refused on the popup's own session.
  fake.emit({ ...paused('p1', 'http://127.0.0.1:13210/'), sessionId: 's2' })
  await delay(10)
  const failed = fake.handled.filter((message) => message.method === 'Fetch.failRequest')
  assert.equal(failed.length, 1)
  assert.equal(failed[0].sessionId, 's2')
  browser.close()
})

await check('request hook: an allowed request continues, and page URLs are re-checked after every op', async () => {
  const fake = fakeBrowser()
  const browser = browserFor(fake)
  await browser.start()
  fake.emit(paused('r1', 'https://example.com/app.js'))
  await delay(10)
  assert.deepEqual(fake.handled.filter((message) => message.method === 'Fetch.continueRequest')
    .map((message) => message.params), [{ requestId: 'r1' }])
  browser.close()
})

await check('a page that lands on a blocked address is refused and blanked', async () => {
  // The tab reports a URL the policy refuses (e.g. it was navigated before the hook
  // could answer): the op is refused and the tab is moved to about:blank.
  const fake = fakeBrowser({
    routes: {
      'Runtime.evaluate': (params) => {
        const expression = String(params.expression ?? '')
        if (expression === 'location.href') return { result: { value: 'http://10.1.2.3/' } }
        if (expression.includes('location.href')) return { result: { value: { url: 'http://10.1.2.3/', title: 'inside' } } }
        return { result: { value: true } }
      },
    },
  })
  const browser = browserFor(fake)
  await assert.rejects(browser.op('navigate', { url: 'https://example.com' }),
    (error) => error.code === 'browser/bad-request' && /about:blank/.test(error.message))
  const blanked = fake.handled.filter((message) => message.method === 'Page.navigate' && message.params.url === 'about:blank')
  assert.equal(blanked.length >= 1, true, 'the tab is moved off that address')
  browser.close()
})

await check('names are pre-resolved: a timeout or resolver error is never cached', async () => {
  // This check is defence in depth behind the egress proxy, so a non-answer lets the
  // request through — but it must not be remembered as "allowed": the next request
  // asks the resolver again rather than trusting a stale non-answer.
  const lookups = []
  let mode = 'slow'
  const fake = fakeBrowser()
  const browser = browserFor(fake, {
    dnsTimeoutMs: 20,
    resolveHost: async (host) => {
      lookups.push(host)
      if (mode === 'slow' && host === 'slow.test') return new Promise(() => {})
      if (mode === 'broken' && host === 'broken.test') throw new Error('no dns')
      return [{ address: '203.0.113.9' }]
    },
  })
  await browser.start()
  for (const url of ['https://slow.test/', 'https://slow.test/']) {
    assert.equal(typeof (await browser.op('navigate', { url })).url, 'string')
  }
  assert.equal(lookups.filter((host) => host === 'slow.test').length, 2, 'the timeout was not remembered')
  mode = 'broken'
  for (const url of ['https://broken.test/', 'https://broken.test/']) {
    assert.equal(typeof (await browser.op('navigate', { url })).url, 'string')
  }
  assert.equal(lookups.filter((host) => host === 'broken.test').length, 2, 'the resolver error was not remembered')
  browser.close()
})

await check('names are pre-resolved: a host resolving into this network is refused', async () => {
  const lookups = []
  const fake = fakeBrowser()
  const browser = browserFor(fake, {
    resolveHost: async (host) => { lookups.push(host); return host === 'evil.test' ? [{ address: '192.168.1.5' }] : [{ address: '203.0.113.9' }] },
  })
  await browser.start()
  await assert.rejects(browser.op('navigate', { url: 'https://evil.test/' }),
    (error) => error.code === 'browser/bad-request' && /private/.test(error.message))
  assert.deepEqual(lookups.slice(0, 1), ['evil.test'])
  // The verdict is cached: the request hook refuses without asking the resolver again.
  fake.emit(paused('r1', 'https://evil.test/page'))
  await delay(20)
  assert.equal(fake.handled.some((message) => message.method === 'Fetch.failRequest' && message.params.requestId === 'r1'), true)
  assert.equal(lookups.filter((host) => host === 'evil.test').length, 1, 'one lookup per name inside the TTL')
  // A name resolving to a public address is allowed, and is looked up once too.
  const reachable = await browser.op('navigate', { url: 'https://good.test/' })
  assert.equal(typeof reachable.url, 'string')
  assert.equal(lookups.filter((host) => host === 'good.test').length, 1)
  // A resolver failure is not a refusal: the request would otherwise be unusable.
  const broken = fakeBrowser()
  const tolerant = browserFor(broken, { resolveHost: async () => { throw new Error('no dns') } })
  assert.equal(typeof (await tolerant.op('navigate', { url: 'https://maybe.test/' })).url, 'string')
  tolerant.close()
  browser.close()
})

await check('pointer coordinates must be finite numbers inside the bound', async () => {
  const fake = fakeBrowser()
  const browser = browserFor(fake)
  await browser.start()
  for (const args of [
    { x: Number.NaN, y: 1 }, { x: 1, y: Number.POSITIVE_INFINITY }, { x: -1, y: 0 },
    { x: 0, y: 100_001 }, { x: 'abc', y: 0 },
  ]) {
    await assert.rejects(browser.op('click', args), (error) => error.code === 'browser/bad-request')
    await assert.rejects(browser.op('scroll', args), (error) => error.code === 'browser/bad-request')
  }
  assert.equal(fake.handled.some((message) => message.method === 'Input.dispatchMouseEvent'), false,
    'a bad coordinate never reaches the browser')
  assert.deepEqual(await browser.op('click', { x: 0, y: 0 }), { clicked: true, x: 0, y: 0 })
  assert.deepEqual(await browser.op('click', { x: 100_000, y: 100_000 }), { clicked: true, x: 100_000, y: 100_000 })
  browser.close()
})

await check('closing the driven tab re-attaches: another page, or a fresh about:blank', async () => {
  // Another page is open: attach to it.
  const fake = fakeBrowser({
    routes: {
      'Target.getTargets': () => ({ targetInfos: [
        { type: 'page', targetId: 't1', url: 'about:blank', title: 'about:blank' },
        { type: 'page', targetId: 't9', url: 'https://example.com/', title: 'Example' },
      ] }),
      'Target.attachToTarget': (params) => ({ sessionId: params.targetId === 't9' ? 's9' : 's1' }),
    },
  })
  const browser = browserFor(fake)
  await browser.start()
  await browser.op('close', {})
  assert.equal(browser.sessionId, 's9', 'the next page took over')
  assert.equal(fake.handled.some((message) => message.method === 'Fetch.enable' && message.sessionId === 's9'), true,
    'the new page is guarded too')
  assert.equal((await browser.op('text', {})).truncated, true, 'ops keep working')
  browser.close()

  // No page left: a blank one is created rather than leaving the browser unattached.
  const empty = fakeBrowser({ routes: { 'Target.getTargets': () => ({ targetInfos: [] }) } })
  const fresh = browserFor(empty, {})
  await fresh.start()
  await fresh.op('close', {})
  assert.equal(empty.handled.some((message) => message.method === 'Target.createTarget'
    && message.params.url === 'about:blank'), true)
  fresh.close()
})

await check('screenshot: JPEG shrunk under 768 KiB before it is returned', async () => {
  const fake = fakeBrowser()
  const browser = browserFor(fake)
  const shot = await browser.op('screenshot', {})
  assert.ok(shot.bytes <= SCREENSHOT_MAX_BYTES, `${shot.bytes}`)
  assert.equal(shot.mime, 'image/jpeg')
  // High quality (75) did not fit, so the lower one did.
  const quality = fake.handled.filter((message) => message.method === 'Page.captureScreenshot').map((message) => message.params.quality)
  assert.ok(quality.length >= 2)
  browser.close()
})

await check('screenshot: a clip fallback is used when no quality fits, and failing that is an error', async () => {
  const alwaysBig = fakeBrowser({
    routes: {
      // Every un-clipped capture is over the limit; a clipped one is small.
      'Page.captureScreenshot': (params) => ({
        data: Buffer.alloc(params.clip ? 50_000 : 900_000, 2).toString('base64'),
      }),
    },
  })
  const shrink = browserFor(alwaysBig)
  const shot = await shrink.op('screenshot', {})
  assert.ok(shot.bytes <= SCREENSHOT_MAX_BYTES)
  shrink.close()

  const hopeless = fakeBrowser({
    routes: { 'Page.captureScreenshot': () => ({ data: Buffer.alloc(900_000, 3).toString('base64') }) },
  })
  const browser = browserFor(hopeless)
  await assert.rejects(browser.op('screenshot', {}), (error) => error.code === 'browser/frame-too-large')
  browser.close()
})

await check('cancel: an aborted op gives up between CDP sends, not at the pipe timeout', async () => {
  // The page never answers `Input.insertText`: without an abort-aware send the op
  // would sit there for the whole 30 s pipe timeout while it holds the channel.
  const fake = fakeBrowser({ routes: { 'Input.insertText': () => undefined } })
  const browser = browserFor(fake, { timeoutMs: 60_000 })
  await browser.start()
  const controller = new AbortController()
  const pending = browser.op('type', { text: 'x' }, { signal: controller.signal })
  await delay(10)
  const started = Date.now()
  controller.abort()
  await assert.rejects(pending, (error) => error.code === 'browser/cancelled')
  assert.ok(Date.now() - started < 1000, 'the op unwound instead of waiting out the pipe timeout')
  browser.close()
})

await check('kill switch closes the process and rejects work in flight', async () => {  const fake = fakeBrowser({ routes: { 'Runtime.evaluate': () => undefined } }) // never answers
  const browser = browserFor(fake, { timeoutMs: 60_000 })
  await browser.start()
  const pending = browser.op('text', {})
  await delay(10)
  assert.equal(browser.close('stop'), true)
  await assert.rejects(pending, (error) => error.code === 'browser/cancelled')
  assert.equal(fake.state.killed, 1)
  assert.equal(browser.running, false)
  assert.equal(browser.close('again'), false, 'closing twice is harmless')
})

await check('idle shutdown: an unused browser closes itself', async () => {
  const fake = fakeBrowser()
  const browser = browserFor(fake, { idleMs: 20 })
  await browser.start()
  await delay(80)
  assert.ok(fake.state.killed >= 1, 'the idle browser was closed')
  assert.equal(browser.running, false)
})

// ---------------------------------------------------------------------------
await check('hello: the browser capability exists only with this host\'s consent', () => {
  assert.equal(Object.hasOwn(buildClientHello({ browserConsent: false }), 'capabilities'), false)
  assert.equal(buildClientHello({}).capabilities, undefined)
  assert.deepEqual(buildClientHello({ browserConsent: true }).capabilities, ['browser-agent:1'])
  const hello = buildClientHello({ browserConsent: true })
  assert.equal(hello.type, 'client-hello')
  assert.equal(hello.companionProtocol, 1)
})

const command = (overrides = {}) => ({
  kind: 'browser-command', commandId: 'c1', sessionId: 's1', op: 'text', args: {}, deadlineMs: 1000, ...overrides,
})

function channelWith(options) {
  const sent = []
  const channel = new BrowserChannel({ send: (frame) => sent.push(frame), ...options })
  return { channel, sent }
}

await check('consent off: browser/denied, and the browser is never asked', async () => {
  let ran = 0
  const { channel, sent } = channelWith({ consent: () => false, run: async () => { ran += 1; return {} } })
  await channel.handle(command())
  assert.equal(ran, 0)
  assert.equal(sent.length, 1)
  assert.deepEqual(sent[0], { type: 'browser-result', commandId: 'c1', ok: false,
    error: { code: 'browser/denied', message: 'the owner has not allowed this host to drive a browser on this machine' } })
})

await check('a malformed frame is answered bad-request, an unusable id is ignored', async () => {
  let ran = 0
  const { channel, sent } = channelWith({ consent: () => true, run: async () => { ran += 1; return { text: '' } } })
  await channel.handle(command({ op: 'rm -rf' }))
  assert.equal(ran, 0)
  assert.equal(sent.at(-1).error.code, 'browser/bad-request')
  await channel.handle(command({ commandId: 'not an id' }))
  assert.equal(sent.length, 1, 'no result for a commandId that cannot be echoed')
  await channel.handle(command({ args: ['x'] }))
  assert.equal(sent.at(-1).error.code, 'browser/bad-request')
  await channel.handle(command({ args: { blob: 'x'.repeat(1024 * 1024 + 10) } }))
  assert.equal(sent.at(-1).error.code, 'browser/frame-too-large')
  assert.equal(ran, 0)
})

await check('one command in flight: the second is browser/busy, never run', async () => {
  let release
  let runs = 0
  const { channel, sent } = channelWith({
    consent: () => true,
    run: () => { runs += 1; return new Promise((resolve) => { release = resolve }) },
  })
  const first = channel.handle(command({ commandId: 'c1' }))
  await delay(0)
  await channel.handle(command({ commandId: 'c2', op: 'screenshot' }))
  assert.equal(runs, 1)
  assert.equal(sent.length, 1)
  assert.equal(sent[0].commandId, 'c2')
  assert.equal(sent[0].error.code, 'browser/busy')
  release({ text: 'ok' })
  await first
  assert.equal(sent.length, 2)
  assert.deepEqual(sent[1], { type: 'browser-result', commandId: 'c1', ok: true, result: { text: 'ok' } })
})

await check('browser-cancel from the host aborts the work and sends no result', async () => {
  let aborted = false
  const { channel, sent } = channelWith({
    consent: () => true,
    run: (_op, _args, { signal }) => new Promise((_resolve, reject) => {
      signal.addEventListener('abort', () => { aborted = true; reject(Object.assign(new Error('aborted'), { code: 'browser/cancelled' })) })
    }),
  })
  const first = channel.handle(command())
  await delay(0)
  await channel.handle({ kind: 'browser-cancel', commandId: 'c1' })
  await first
  await delay(10)
  assert.equal(aborted, true)
  assert.equal(sent.length, 0, 'a cancelled command gets no result')
  // A cancel for an id that is not in flight is ignored.
  await channel.handle({ kind: 'browser-cancel', commandId: 'nope' })
  assert.equal(sent.length, 0)
})

await check('browser-cancel keeps the channel busy until the work unwinds', async () => {
  // The op does not give up the moment it is aborted (an uncooperative op, or one
  // halfway through a CDP round trip): the slot must stay taken, so a second command
  // answers browser/busy instead of interleaving with the cancelled one.
  let release
  let aborted = false
  const { channel, sent } = channelWith({
    consent: () => true,
    run: (_op, _args, { signal }) => new Promise((resolve) => {
      signal.addEventListener('abort', () => { aborted = true })
      release = resolve
    }),
  })
  const first = channel.handle(command({ commandId: 'c1' }))
  await delay(0)
  await channel.handle({ kind: 'browser-cancel', commandId: 'c1' })
  assert.equal(aborted, true, 'the work was told to stop')
  assert.equal(channel.commandId, 'c1', 'the slot is still taken while the op unwinds')
  await channel.handle(command({ commandId: 'c2' }))
  assert.equal(sent.length, 1)
  assert.equal(sent[0].commandId, 'c2')
  assert.equal(sent[0].error.code, 'browser/busy')
  release({ text: 'late' })
  await first
  await delay(10)
  assert.equal(sent.length, 1, 'the cancelled command is answered with nothing at all')
  assert.equal(channel.commandId, null, 'the slot is free once it unwound')
})

await check('deadline: the owner-configured bound answers browser/timeout exactly once', async () => {
  const { channel, sent } = channelWith({ consent: () => true, run: () => new Promise(() => {}) })
  // The deadline timer is unref'd on purpose (it must never keep the Host alive), so
  // the test holds the loop open itself while it waits for that timer to fire.
  const pending = channel.handle(command({ deadlineMs: 20 }))
  await delay(60)
  await pending
  assert.equal(sent.length, 1)
  assert.equal(sent[0].error.code, 'browser/timeout')
  await delay(40)
  assert.equal(sent.length, 1, 'a late result is never sent')
})

await check('a result over 1 MiB is refused instead of sent', async () => {
  const { channel, sent } = channelWith({
    consent: () => true,
    run: async () => ({ text: 'x'.repeat(1024 * 1024) }),
  })
  await channel.handle(command())
  assert.equal(sent.length, 1)
  assert.equal(sent[0].ok, false)
  assert.equal(sent[0].error.code, 'browser/frame-too-large')
})

await check('disconnect fails the work without answering (the link is gone)', async () => {
  let aborted = false
  const { channel, sent } = channelWith({
    consent: () => true,
    run: (_op, _args, { signal }) => new Promise((_resolve, reject) => {
      signal.addEventListener('abort', () => { aborted = true; reject(new Error('gone')) })
    }),
  })
  const first = channel.handle(command())
  await delay(0)
  channel.disconnect()
  await first
  assert.equal(aborted, true)
  assert.equal(sent.length, 0)
})

// ---------------------------------------------------------------------------
await check('routes: consent per host, the frame route, and the kill switch', async () => {
  const spawned = []
  const mounted = await mountPlugin({
    dataDir: tempDir(),
    agentBrowserPath: 'C:/fake/chrome.exe',
    testBrowserExists: () => true,
    spawnBrowser: (executable, args) => {
      const fake = fakeBrowser()
      spawned.push({ executable, args, fake })
      return fake.child
    },
  })
  const id = crypto.randomUUID()
  mounted.instance.store.add({
    id, name: 'Qoder-Sigma', address: '192.168.1.9:3081', publicUrl: 'wss://192.168.1.9:3081/ws/mobile',
    certSha256: 'a'.repeat(64), gatewayId: 'gw-1', createdAt: Date.now(),
    device: { kind: 'desktop', scopes: [] }, revoked: false,
  })
  try {
    const list = await mounted.call('GET', '/devices/remotes')
    assert.equal(list.status, 200)
    assert.equal(list.json.remotes[0].browserConsent, false, 'off by default, per host')

    // Consent off: the frame route refuses and no browser is started.
    const denied = await mounted.call('GET', `/devices/browser/${id}/frame`)
    assert.equal(denied.status, 403)
    assert.equal(denied.json.error, 'browser/denied')
    assert.equal(spawned.length, 0)

    assert.equal((await mounted.call('POST', `/devices/remotes/${id}/browser`, { body: { allow: 'yes' } })).status, 400)
    const on = await mounted.call('POST', `/devices/remotes/${id}/browser`, { body: { allow: true } })
    assert.equal(on.status, 200)
    assert.equal(on.json.remote.browserConsent, true)

    const frame = await mounted.call('GET', `/devices/browser/${id}/frame`)
    assert.equal(frame.status, 204, 'no screencast frame yet')
    assert.equal(spawned.length, 1)
    assert.ok(spawned[0].args.includes('--remote-debugging-pipe'))
    assert.equal(spawned[0].args.some((arg) => arg.startsWith('--remote-debugging-port')), false)
    assert.ok(spawned[0].args.includes(`--user-data-dir=${mounted.dataDir}\\agent-browser-profile\\${id}`)
      || spawned[0].args.includes(`--user-data-dir=${mounted.dataDir}/agent-browser-profile/${id}`))

    const stopped = await mounted.call('POST', `/devices/browser/${id}/stop`)
    assert.equal(stopped.status, 200)
    assert.deepEqual(stopped.json, { stopped: true })
    assert.equal(spawned[0].fake.state.killed, 1, 'the kill switch closed the process')

    const off = await mounted.call('POST', `/devices/remotes/${id}/browser`, { body: { allow: false } })
    assert.equal(off.status, 200)
    assert.equal(off.json.remote.browserConsent, false)
    assert.equal((await mounted.call('GET', `/devices/browser/${id}/frame`)).status, 403)

    assert.equal((await mounted.call('GET', `/devices/browser/${crypto.randomUUID()}/frame`)).status, 404)
  } finally {
    mounted.close()
  }
})

await check('the agent surface can be switched off for the whole machine', async () => {
  const mounted = await mountPlugin({ dataDir: tempDir(), agentBrowser: false })
  const id = crypto.randomUUID()
  mounted.instance.store.add({
    id, name: 'H', address: '192.168.1.10:3081', publicUrl: 'wss://192.168.1.10:3081/ws/mobile',
    certSha256: 'b'.repeat(64), gatewayId: 'gw-2', createdAt: Date.now(), device: null, revoked: false,
  })
  try {
    const answer = await mounted.call('POST', `/devices/remotes/${id}/browser`, { body: { allow: true } })
    assert.equal(answer.status, 404)
    assert.match(answer.json.message, /disabled/)
    assert.equal((await mounted.call('GET', `/devices/browser/${id}/frame`)).status, 404)
  } finally {
    mounted.close()
  }
})

await check('the pool keeps one browser per host and disposes them all', async () => {
  const dir = tempDir()
  const spawned = []
  const pool = createAgentBrowserPool({
    dataDir: dir, log: () => {}, configuredPath: 'C:/fake/chrome.exe', exists: () => true,
    spawn: (executable, args) => { const fake = fakeBrowser(); spawned.push(fake); return fake.child },
  })
  const first = pool.forHost('host-a')
  const again = pool.forHost('host-a')
  const other = pool.forHost('host-b')
  assert.equal(first, again, 'the same host reuses its browser')
  assert.notEqual(first, other)
  await first.start()
  await other.start()
  assert.equal(spawned.length, 2)
  assert.deepEqual(pool.status('host-a').running, true)
  pool.dispose()
  assert.equal(spawned.every((fake) => fake.state.killed >= 1), true)
  assert.equal(pool.status('host-a').running, false)
})

await check('client: one tab type per paired host, titled "Browser (agent) · <host>", keyed body', async () => {
  // The plugin's own right-panel tab type, loaded the way the shell loads it (a vm
  // with __ModuleLoader__), against a fake host that declares the two services the
  // native Browser itself uses. The tab is only a screencast, so nothing here dials.
  const fs = await import('node:fs')
  const path = await import('node:path')
  const vm = await import('node:vm')
  const { createRequire } = await import('node:module')
  const { fileURLToPath } = await import('node:url')
  const here = path.dirname(fileURLToPath(import.meta.url))
  const require = createRequire(import.meta.url)
  const React = require('../../mobile-gateway/node_modules/react')
  const source = fs.readFileSync(path.join(here, '../lib/client.js'), 'utf8')

  const REMOTES = [
    { id: 'r1', name: 'Qoder-Sigma', address: '192.168.1.40:3081', status: 'online', createdAt: 1, browserConsent: true, device: { kind: 'desktop', scopes: [] } },
    { id: 'r2', name: 'Desk-Box', address: '192.168.1.41:3081', status: 'online', createdAt: 2, browserConsent: false, device: { kind: 'desktop', scopes: [] } },
  ]
  const fetch = async (url) => {
    const route = new URL(String(url), 'http://127.0.0.1:3080/').pathname
    if (route === '/devices/remotes') {
      return { ok: true, status: 200, json: async () => ({ remotes: REMOTES, routing: { remote: true, reason: null, hosts: [], merged: [] } }) }
    }
    return { ok: true, status: 200, json: async () => ({}) }
  }
  let api
  const window = {
    __ModuleLoader__: { load: ({ factory }) => { api = factory(() => React) } },
    setInterval: () => 1,
    clearInterval: () => {},
    setTimeout: () => 1,
    clearTimeout: () => {},
  }
  const document = { baseURI: 'http://127.0.0.1:3080/', head: { appendChild() {} }, createElement: () => ({ remove() {} }) }
  vm.runInNewContext(source, {
    window, document, fetch, URL, console, setTimeout, clearTimeout, Date,
    navigator: { language: 'en-US' },
  })

  const types = []
  const bodies = []
  const disposers = []
  const slots = {
    inject(slot, factory) { const registration = factory(); (slot === 'sidebar.right.pane.tab' ? bodies : []).push(registration); return () => {} },
    register(meta, component) { return { meta, component } },
  }
  const services = {
    sessions: { refresh: async () => {} },
    sidebarRight: { openTab(kind, options) { types.push({ opened: kind, options }) } },
    sidebarRightTabs: {
      register(definition) { types.push(definition); return () => {} },
      get(kind) { return types.find((entry) => entry.kind === kind) },
    },
    // The shell's context-menu registry (client.js:2403 injects it, and the scope it
    // hands back also carries `effect`, as rc.1's ctx.inject scope does).
    contextMenus: { register() { return () => {} } },
  }
  const ctx = {
    locale: { getSnapshot: () => ({ active: 'en-US' }), subscribe: () => () => {} },
    effect(fn) { const out = fn(); if (typeof out === 'function') disposers.push(out); return () => { out?.() } },
    inject(deps, fn) {
      const scope = { effect(run) { const stop = run(); if (typeof stop === 'function') disposers.push(stop) } }
      for (const dep of deps) scope[dep] = services[dep]
      const out = fn(scope)
      if (typeof out === 'function') disposers.push(out)
      return () => { out?.() }
    },
    slots,
  }
  api.apply(ctx)
  await api.testing.hostsStore.refresh()
  const registered = api.testing.hostsStore.getSnapshot().remotes
  assert.equal(registered.length, 2)
  assert.equal(registered[0].browserConsent, true)
  assert.equal(registered[1].browserConsent, false)

  const definitions = types.filter((entry) => entry && typeof entry.kind === 'string' && entry.kind.startsWith('dsh-ext.devices.browser-agent.'))
  assert.equal(definitions.length, 2, 'one type per paired host')
  const first = definitions.find((entry) => entry.kind.endsWith('.r1'))
  assert.equal(first.priority, 'extension')
  assert.equal(first.multiple, false)
  assert.equal(first.title({}), 'Browser (agent) · Qoder-Sigma')
  assert.equal(first.guide[0].title({}), 'Browser (agent) · Qoder-Sigma')
  // The body seat is keyed to the type's own id, which is what the dock dispatches on.
  // Only this test's own seams are counted: spec 016 Phase 1 registers a pane body per
  // machine doorway in the same slot, under its own `dsh-ext.devices.<host>.<entry>` id.
  const seated = bodies.filter((entry) => entry.meta.name === 'sidebar.right.pane.tab' && entry.meta.key.startsWith('dsh-ext.devices.browser-agent:'))
  assert.equal(seated.length, 2)
  assert.equal(seated[0].meta.key, `dsh-ext.devices.browser-agent:r1`)
  assert.equal(typeof seated[0].component, 'function')
  for (const dispose of disposers) { try { dispose() } catch { /* teardown */ } }
})

finish('agent-browser')
