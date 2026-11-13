// A REVERSE PROXY IN FRONT OF THE GATEWAY (owner decision 2026-11-13).
//
// The deployment: one tailnet-only HTTPS origin serves the PWA *and* routes the gateway, via
// `tailscale serve`:
//
//     /                       -> http://127.0.0.1:<serve-web>
//     /ws/mobile              -> https+insecure://<this host's tailnet ip>:<lanPort>
//
// Two properties follow from that and are what this file measures:
//
//  1. THE MANAGEMENT SURFACE IS NOT REACHABLE THROUGH IT. `tailscale serve` terminates TLS and
//     then dials the local target, so a forwarded request arrives from THIS machine (127.0.0.1 for
//     the loopback targets, this host's own tailnet address for the TLS listener). `remoteAddress`
//     then no longer names the caller: it names the proxy. Every `/mgw/*` route is refused when the
//     request carries forwarding headers, whatever the peer address is — so a misconfiguration
//     that also routed `/mgw` would still not hand a browser the pairing list, the device list or
//     the listen switch.
//
//  2. THE DEVICE-FACING PATH DOES WORK. A pooled request from the proxy's own address passes the
//     private-source check, pairs over the pinned TLS listener, and completes `hello` ->
//     `client-hello`. The browser's `Origin` is the tailnet origin, so that exact origin must be in
//     `allowedOrigins` — it is the WebAuthn site (spec 021) as well as the WS origin fence.
//
// The gateway end of the proxy is NOT executed here (no `tailscale serve` is run: the owner runs
// it). What is simulated is precisely what the proxy puts on the wire.

import { createRequire } from 'node:module'
import { createTestConnection, createTestRemoteAccess } from './helpers/peer.mjs'
import { listenFetchSafe } from './support/fetch-safe-listen.mjs'

const require = createRequire(import.meta.url)
const assert = require('node:assert/strict')
const fs = require('node:fs')
const http = require('node:http')
const tls = require('node:tls')
const net = require('node:net')
const os = require('node:os')
const path = require('node:path')
const { once } = require('node:events')
const WebSocket = require('ws')

const pluginModule = await import('../lib/index.mjs')
const { createMobileGatewayPlugin } = pluginModule

// Every wait in this file is bounded. A socket that never answers is the ordinary failure mode of a
// proxy test (a refused upgrade, a listener that did not come up), and an unbounded `once(...)` turns
// that into a hung suite instead of a red test. The fixture is a real TCP/WS server, so `open`,
// `close`, `dispose` and each `fetch` all get the same finite deadline.
const WAIT_MS = 10_000

/** Settle `promise` or reject after `ms`; the timer never outlives the race. */
function withDeadline(promise, label, ms = WAIT_MS) {
  let timer
  const deadline = new Promise((resolve, reject) => {
    timer = setTimeout(() => reject(new Error(`timed out after ${ms}ms: ${label}`)), ms)
  })
  return Promise.race([promise, deadline]).finally(() => clearTimeout(timer))
}

/**
 * Whether the close event of `emitter` arrives within the deadline.
 *
 * This reports closure as a boolean rather than resolving either way, because the caller has to act
 * on a timeout: a peer (or a listener) that never answers cannot be distinguished from one that
 * already closed unless the miss is explicit. An `error` on the way is not a closure and is not
 * rethrown here; the socket's own state decides what happens next.
 */
async function closedWithin(emitter, label) {
  try {
    await withDeadline(once(emitter, 'close'), label)
    return true
  } catch {
    return false
  }
}

/** Close a WebSocket and wait for it to be gone; a peer that will not answer is terminated. */
async function closeSocket(ws, label) {
  if (ws.readyState === WebSocket.CLOSED) return
  const gone = closedWithin(ws, label)
  ws.close()
  if (!(await gone)) {
    ws.terminate()
    await closedWithin(ws, `${label} after terminate`)
  }
}

/** `fetch` with a deadline, so a listener that accepts but never answers fails loudly. */
function fetchWithin(url, init = {}) {
  return fetch(url, { ...init, signal: AbortSignal.timeout(WAIT_MS) })
}

// The owner page's origin. `*.example*.ts.net` is the documented placeholder host, so this is not
// a real machine name.
const PAGE_ORIGIN = 'https://host.example.ts.net:30443'
// A tailnet peer address the proxy may dial from (documented placeholder, never a real host).
const HOST_TAILNET_IP = '100.100.10.20'
// The client device id: an installation id the gateway accepts, not a credential.
const DEVICE_ID = '5d0f8b1a-0000-4000-8000-0000000000aa'

/** A forwarded request, exactly as `tailscale serve` writes it. */
const PROXY_HEADERS = {
  'X-Forwarded-For': HOST_TAILNET_IP,
  'X-Forwarded-Host': 'host.example.ts.net:30443',
  'X-Forwarded-Proto': 'https',
}

async function startGateway(overrides = {}) {
  const temp = fs.mkdtempSync(path.join(os.tmpdir(), 'dsh-mobile-proxy-'))
  let managementRoute
  let upgradeRoute
  let disposePlugin
  const server = http.createServer((req, res) => {
    if (managementRoute && (req.url === managementRoute.path || req.url.startsWith(`${managementRoute.path}/`))) {
      managementRoute.handler(req, res)
      return
    }
    res.writeHead(404).end()
  })
  const webServer = {
    port: 0,
    register(route) { managementRoute = route; return () => { managementRoute = undefined } },
    registerUpgrade(route) { upgradeRoute = route; return () => { upgradeRoute = undefined } },
  }
  server.on('upgrade', (req, socket, head) => {
    if (upgradeRoute) upgradeRoute.handler(req, socket, head)
    else socket.destroy()
  })
  const ctx = {
    webServer,
    connection: createTestConnection(),
    remoteAccess: createTestRemoteAccess(),
    typertGateway: {
      async invoke() { throw new Error('unexpected Remote invocation') },
      async stream(request) {
        return (async function* () {
          if (request.namespace === 'workspace' && request.method === 'follow') {
            yield { type: 'baseline', value: { items: [], archivedSessionIds: [] } }
            while (!request.signal.aborted) await new Promise((resolve) => setTimeout(resolve, 5))
          }
          if (request.namespace === 'session' && request.method === 'control') {
            yield { type: 'baseline', value: { projections: {} } }
            while (!request.signal.aborted) await new Promise((resolve) => setTimeout(resolve, 5))
          }
        })()
      },
    },
    agentDefaultModel: {},
    on() { return () => {} },
    effect(factory) { disposePlugin = factory() },
  }
  await withDeadline(createMobileGatewayPlugin().apply(ctx, {
    remoteControl: { enabled: true },
    gatewayEnabled: true,
    gatewayWaitTimeoutMs: 60_000,
    adminLoopbackOnly: true,
    pairingTtlMs: 60_000,
    deviceFile: path.join(temp, 'devices.json'),
    // Spec 005 FR5 / spec 021: the ONE origin the browser runs on, and therefore the passkey site.
    allowedOrigins: [PAGE_ORIGIN],
    lanEnabled: true,
    requireHostApproval: false,
    lanHost: '127.0.0.1',
    lanPort: 0,
    tlsCertificateDir: path.join(temp, 'tls'),
    ...overrides,
  }), 'plugin.apply()')
  await withDeadline(listenFetchSafe(server), 'listenFetchSafe')
  webServer.port = server.address().port
  const base = `http://127.0.0.1:${webServer.port}`
  let status
  for (let attempt = 0; attempt < 100; attempt += 1) {
    status = await (await fetchWithin(`${base}/mgw/status`)).json()
    if (status.lan && (status.lan.listening || status.lan.error)) break
    await new Promise((resolve) => setTimeout(resolve, 20))
  }
  if (!status?.lan || !(status.lan.listening || status.lan.error)) {
    throw new Error(`the TLS listener never reported a state: ${JSON.stringify(status?.lan)}`)
  }
  return {
    webServer,
    server,
    base,
    status,
    lanPort: status.lan.port,
    async dispose() {
      try {
        if (disposePlugin) disposePlugin()
      } finally {
        server.close()
        await closedWithin(server, 'management server close')
        fs.rmSync(temp, { recursive: true, force: true })
      }
    },
  }
}

/** Override the peer address of the NEXT connection to `server`, so a test models the proxy's. */
function withPeerAddress(server, address, run) {
  const hook = (socket) => Object.defineProperty(socket, 'remoteAddress', {
    configurable: true,
    get() { return address },
  })
  server.on('connection', hook)
  return Promise.resolve().then(run).finally(() => server.off('connection', hook))
}

/**
 * The plugin's TLS listener is its own `https.createServer`, so `server.on('connection')` above
 * cannot reach it. `remoteAddress` is a prototype getter, so the socket the proxy dials is patched
 * once at the prototype — the same technique `test/lan.test.mjs` uses. Production code still only
 * ever reads `req.socket.remoteAddress`; no forwarding header is consulted.
 */
async function withTlsPeerAddress(address, run) {
  const original = Object.getOwnPropertyDescriptor(net.Socket.prototype, 'remoteAddress')
  Object.defineProperty(tls.TLSSocket.prototype, 'remoteAddress', {
    configurable: true,
    get() { return address ?? original.get.call(this) },
  })
  try {
    return await run()
  } finally {
    delete tls.TLSSocket.prototype.remoteAddress
  }
}

/** A management request through the proxy: loopback peer, forwarding headers present. */
function proxiedManagementRequest(base, pathname, { method = 'GET', headers = {}, body, forwarding = true } = {}) {
  const url = new URL(pathname, base)
  const payload = body === undefined ? undefined : JSON.stringify(body)
  return new Promise((resolve, reject) => {
    const request = http.request({
      host: url.hostname,
      port: url.port,
      path: url.pathname + url.search,
      method,
      agent: false,
      headers: {
        Origin: PAGE_ORIGIN,
        Connection: 'close',
        ...(forwarding ? PROXY_HEADERS : {}),
        ...(payload === undefined ? {} : { 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(payload) }),
        ...headers,
      },
    }, (response) => {
      const chunks = []
      response.on('data', (chunk) => chunks.push(chunk))
      response.on('end', () => {
        clearTimeout(timer)
        const text = Buffer.concat(chunks).toString('utf8')
        let json = null
        try { json = JSON.parse(text) } catch (error) { /* a refusal need not be JSON */ }
        resolve({ status: response.statusCode, body: json, text })
      })
    })
    const timer = setTimeout(() => {
      request.destroy()
      reject(new Error(`management request ${method} ${pathname} timed out`))
    }, WAIT_MS)
    request.once('error', (error) => { clearTimeout(timer); reject(error) })
    request.end(payload)
  })
}

function waitForMessage(ws, kind) {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => {
      ws.off('message', onMessage)
      reject(new Error(`timed out waiting for ${kind}`))
    }, WAIT_MS)
    const onMessage = (data) => {
      const frame = JSON.parse(data.toString())
      if (frame.kind !== kind) return
      clearTimeout(timer)
      ws.off('message', onMessage)
      resolve(frame)
    }
    ws.on('message', onMessage)
  })
}

/** The upgrade status a refused WS handshake answers with. */
function upgradeStatus(url, protocols, options = {}) {
  return new Promise((resolve, reject) => {
    const ws = new WebSocket(url, protocols, options)
    const timer = setTimeout(() => { ws.terminate(); reject(new Error('upgrade timed out')) }, WAIT_MS)
    ws.once('open', () => { clearTimeout(timer); ws.terminate(); reject(new Error('upgrade unexpectedly opened')) })
    ws.once('unexpected-response', (_request, response) => {
      const chunks = []
      response.on('data', (chunk) => chunks.push(chunk))
      response.on('end', () => {
        clearTimeout(timer)
        resolve({ status: response.statusCode, body: Buffer.concat(chunks).toString('utf8') })
      })
    })
    ws.once('error', () => {})
  })
}

;(async () => {
  const gateway = await startGateway()
  try {
    assert.equal(gateway.status.lan.listening, true, 'the TLS listener the proxy routes to is up')
    const lanUrl = `wss://127.0.0.1:${gateway.lanPort}/ws/mobile`

    // -----------------------------------------------------------------------
    // (1) The management surface refuses every proxied request — even though the
    // peer address really IS loopback, which is exactly what the proxy produces.
    // -----------------------------------------------------------------------
    {
      const reads = ['/mgw/status', '/mgw/devices', '/mgw/pending']
      for (const route of reads) {
        const proxied = await proxiedManagementRequest(gateway.base, route)
        assert.equal(proxied.status, 403, `${route} through a proxy`)
        assert.equal(proxied.body?.error, 'forbidden', route)
        assert.match(String(proxied.body?.message), /not reachable through a proxy/, route)
      }
      // The same paths WITHOUT a forwarding header still answer: this is the local owner page, and
      // the refusal is about the proxy, not about the route.
      const direct = await (await fetchWithin(`${gateway.base}/mgw/status`)).json()
      assert.equal(direct.gatewayEnabled, true)
      const directPending = await fetchWithin(`${gateway.base}/mgw/pending`, { headers: { host: '127.0.0.1' } })
      assert.equal(directPending.status, 200, 'a local pending read is unchanged')
      await directPending.arrayBuffer()

      // Writes that change or reveal owner state: refused through the proxy, and nothing moved.
      const before = await (await fetchWithin(`${gateway.base}/mgw/status`)).json()
      for (const [route, body] of [
        ['/mgw/listen', { target: 'loopback' }],
        ['/mgw/gateway', { enabled: false }],
        ['/mgw/pair', { kind: 'mobile' }],
        ['/mgw/pending/req-1/approve', {}],
      ]) {
        const refused = await proxiedManagementRequest(gateway.base, route, { method: 'POST', body })
        assert.equal(refused.status, 403, `POST ${route} through a proxy`)
        assert.match(String(refused.body?.message), /not reachable through a proxy/, route)
      }
      const after = await (await fetchWithin(`${gateway.base}/mgw/status`)).json()
      assert.equal(after.gatewayEnabled, true, 'the proxied writes changed nothing')
      assert.equal(after.lan.port, before.lan.port, 'no listener moved')
      const devicesAfter = await (await fetchWithin(`${gateway.base}/mgw/devices`)).json()
      assert.equal(devicesAfter.devices.length, 0, 'no pairing was created')

      // The peer being the host's OWN tailnet address (the other thing the proxy may dial from)
      // changes nothing: a management request from a non-loopback peer is refused as well.
      for (const peer of [HOST_TAILNET_IP, '::ffff:100.100.10.20', '203.0.113.7']) {
        const remote = await withPeerAddress(gateway.server, peer,
          () => proxiedManagementRequest(gateway.base, '/mgw/devices'))
        assert.equal(remote.status, 403, `management from peer ${peer}`)
      }

      // The refusal does NOT depend on knowing which forwarding headers this proxy writes. A
      // browser through `tailscale serve` addresses the tailnet name, so a forwarded request can
      // carry NO forwarding header at all — a proxy that strips them, or one this gateway has
      // never heard of — and still arrive from a loopback peer. The Host it addressed is what
      // gives it away, and that is the second, independent condition.
      for (const host of ['host.example.ts.net:30443', 'host.example.ts.net']) {
        const noHeaders = await proxiedManagementRequest(gateway.base, '/mgw/devices', {
          forwarding: false,
          headers: { Host: host },
        })
        assert.equal(noHeaders.status, 403, `proxied read addressed to ${host} with no forwarding header`)
        assert.match(String(noHeaders.body?.message), /loopback-only/, host)
      }

      // The family is matched by PREFIX, not by the names one proxy happens to write. A header this
      // gateway has never heard of is still a proxy talking, so an unlisted member refuses exactly
      // like `x-forwarded-for` does — from a loopback peer, addressed to a loopback authority.
      for (const header of ['x-forwarded-ssl', 'x-forwarded-evil', 'tailscale-foo', 'Tailscale-User-Email', 'Forwarded']) {
        const unlisted = await proxiedManagementRequest(gateway.base, '/mgw/devices', {
          forwarding: false,
          headers: { [header]: '1' },
        })
        assert.equal(unlisted.status, 403, `proxied read carrying ${header}`)
        assert.match(String(unlisted.body?.message), /not reachable through a proxy/, header)
      }
    }

    // -----------------------------------------------------------------------
    // (1b) The classification is UNCONDITIONAL: it does not depend on the owner's
    //      `adminLoopbackOnly` switch. That switch relaxes the peer test only, so
    //      with it off a request still has to be this machine's local caller.
    // -----------------------------------------------------------------------
    {
      const permissive = await startGateway({ adminLoopbackOnly: false })
      try {
        const port = permissive.webServer.port
        // Non-loopback Host, no forwarding header at all: refused, and the answer is the
        // loopback-only refusal — i.e. it was classified non-local, not merely proxy-header'd.
        for (const host of [`host.example.ts.net:${port}`, `192.168.88.8:${port}`]) {
          const foreign = await proxiedManagementRequest(permissive.base, '/mgw/devices', {
            forwarding: false,
            headers: { Host: host },
          })
          assert.equal(foreign.status, 403, `adminLoopbackOnly:false still refuses Host ${host}`)
          assert.equal(foreign.body?.error, 'forbidden', host)
          assert.match(String(foreign.body?.message), /loopback-only/, host)
        }
        // A forwarding-family header on a loopback Host is refused for the proxy reason.
        const forwarded = await proxiedManagementRequest(permissive.base, '/mgw/devices')
        assert.equal(forwarded.status, 403, 'adminLoopbackOnly:false still refuses a proxied request')
        assert.match(String(forwarded.body?.message), /not reachable through a proxy/)
        // ...and a plain loopback request is untouched: the switch was not the fence all along.
        const local = await proxiedManagementRequest(permissive.base, '/mgw/devices', {
          forwarding: false,
          headers: { Host: `127.0.0.1:${port}` },
        })
        assert.equal(local.status, 200, 'a plain loopback read still works with adminLoopbackOnly:false')
        assert.ok(Array.isArray(local.body?.devices), 'the local read answered its real body')
      } finally {
        await permissive.dispose()
      }
    }

    // -----------------------------------------------------------------------
    // (2) The device-facing path works through the proxy: pair, then `hello`.
    //     The peer is the proxy's own address and the Origin is the tailnet page.
    // -----------------------------------------------------------------------
    {
      // One offer per attempt: a pairing code is single-use, so each pairing below gets its own
      // (which is also what the real flow does — one QR, one phone).
      const pairOnce = async (peer) => {
        const pairResponse = await fetchWithin(`${gateway.base}/mgw/pair`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json', Origin: gateway.base },
          body: JSON.stringify({ kind: 'mobile', publicUrl: lanUrl }),
        })
        assert.equal(pairResponse.status, 201)
        const offer = await pairResponse.json()
        // The browser cannot inspect the leaf, so it presents the tailnet origin; the device id and
        // the one-time code ride subprotocols (a browser cannot set either header).
        return await withTlsPeerAddress(peer, async () => {
          const opened = new WebSocket(lanUrl, ['dsh-mobile-v1', `dsh-pair.${offer.payload.pairingCode}`], {
            rejectUnauthorized: false,
            headers: { 'X-DSH-Device-ID': DEVICE_ID, Origin: PAGE_ORIGIN, ...PROXY_HEADERS },
          })
          const paired = waitForMessage(opened, 'paired')
          const hello = waitForMessage(opened, 'hello')
          await withDeadline(once(opened, 'open'), 'pairing socket open')
          return { ws: opened, paired: await paired, hello: await hello }
        })
      }
      for (const peer of ['127.0.0.1', HOST_TAILNET_IP, '::ffff:100.100.10.20']) {
        const ws = await pairOnce(peer)
        assert.equal(ws.hello.authenticated, true, `peer ${peer} authenticated over the proxy`)
        assert.equal(ws.paired.gatewayId, gateway.status.gatewayId)
        assert.equal(typeof ws.paired.token, 'string', `peer ${peer} received its device token`)
        await closeSocket(ws.ws, `pairing socket ${peer}`)
        // One device record per redeeming installation: a re-pair replaces it, never duplicates.
        const devices = await (await fetchWithin(`${gateway.base}/mgw/devices`)).json()
        assert.equal(devices.devices.length, 1, 'the proxy did not create a second device')
      }
    }

    // -----------------------------------------------------------------------
    // (3) An Origin that is not the configured tailnet origin is still refused: the proxy does not
    //     widen the origin fence, which is also the WebAuthn site (spec 021 §14.1).
    // -----------------------------------------------------------------------
    {
      const foreign = await upgradeStatus(lanUrl, ['dsh-mobile-v1'], {
        rejectUnauthorized: false,
        headers: { Origin: 'https://evil.example.com', ...PROXY_HEADERS },
      })
      assert.equal(foreign.status, 403)
      assert.match(foreign.body, /Origin is not an allowed WebSocket origin/)

      // The tailnet origin itself is REFUSED on a listener with no site (the default). A browser
      // always sends an Origin, so a proxied page cannot reach a gateway whose `allowedOrigins` was
      // never configured — the deployment has to list the origin, and this test pins that.
      const noSite = await startGateway({ allowedOrigins: [] })
      try {
        const refused = await withTlsPeerAddress(HOST_TAILNET_IP, () => upgradeStatus(
          `wss://127.0.0.1:${noSite.lanPort}/ws/mobile`, ['dsh-mobile-v1'],
          { rejectUnauthorized: false, headers: { Origin: PAGE_ORIGIN, ...PROXY_HEADERS } },
        ))
        assert.equal(refused.status, 403)
        assert.match(refused.body, /Origin is not an allowed WebSocket origin/)
      } finally {
        await noSite.dispose()
      }
    }

    // -----------------------------------------------------------------------
    // (4) A PROXIED OTP pairing reaches the pending list, and that record does not claim the proxy's
    //     address as the caller. `/mgw/pending` shows the owner a client address, and through a proxy
    //     the peer address is this machine — so the field is left empty rather than answering with a
    //     confident wrong value. The unproxied flow keeps its real peer address.
    // -----------------------------------------------------------------------
    {
      /** Run a real OTP pairing proof over the TLS listener and return the pending request id. */
      const pendingFrom = async (peer, { proxied }) => {
        const offerResponse = await fetchWithin(`${gateway.base}/mgw/pair`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json', Origin: gateway.base },
          body: JSON.stringify({ kind: 'mobile', mode: 'otp' }),
        })
        assert.equal(offerResponse.status, 201)
        const offer = await offerResponse.json()
        const { otpProof } = await import('../lib/pairing-requests.mjs')
        return await withTlsPeerAddress(peer, async () => {
          const ws = new WebSocket(`wss://127.0.0.1:${gateway.lanPort}/ws/mobile`, ['dsh-mobile-v1', 'dsh-pair-otp.v1'], {
            rejectUnauthorized: false,
            headers: {
              'X-DSH-Device-ID': DEVICE_ID,
              Origin: PAGE_ORIGIN,
              ...(proxied ? PROXY_HEADERS : {}),
            },
          })
          const challenge = waitForMessage(ws, 'pairing-challenge')
          await withDeadline(once(ws, 'open'), 'OTP pairing socket open')
          const serverNonce = (await challenge).serverNonce
          const clientNonce = 'proxy-test-nonce-0001'
          // The client's proof is HMAC over the certificate it pinned, both nonces and the OTP. The
          // `wss://127.0.0.1` handshake presents the plugin's own certificate, so the status'
          // fingerprint is the one the client saw.
          const proof = otpProof(offer.otp, gateway.status.lan.certSha256, clientNonce, serverNonce)
          const pending = waitForMessage(ws, 'pairing-pending')
          ws.send(JSON.stringify({ type: 'pairing-proof', otpProof: proof, clientNonce }))
          const frame = await pending
          return { ws, requestId: frame.requestId }
        })
      }

      const proxied = await pendingFrom(HOST_TAILNET_IP, { proxied: true })
      try {
        const response = await fetchWithin(`${gateway.base}/mgw/pending`, { headers: { host: '127.0.0.1' } })
        assert.equal(response.status, 200)
        const listed = (await response.json()).pending.find((entry) => entry.id === proxied.requestId)
        assert.ok(listed !== undefined, 'the proxied request reached the pending list')
        assert.equal(listed.clientIp, '', 'a proxied request never reports the proxy as the client')
        assert.equal(listed.name, '未命名设备', 'the rest of the record is unchanged')
        assert.equal(typeof listed.verificationCode, 'string', 'the owner still gets a code to compare')
      } finally {
        await closeSocket(proxied.ws, 'proxied OTP socket')
      }

      const direct = await pendingFrom(null, { proxied: false })
      try {
        const response = await fetchWithin(`${gateway.base}/mgw/pending`, { headers: { host: '127.0.0.1' } })
        const listed = (await response.json()).pending.find((entry) => entry.id === direct.requestId)
        assert.ok(listed !== undefined)
        assert.equal(listed.clientIp, '127.0.0.1', 'an unproxied pairing still records its real peer')
      } finally {
        await closeSocket(direct.ws, 'direct OTP socket')
      }
    }

    console.log('PROXIED (tailscale serve) TESTS PASSED')
  } finally {
    await gateway.dispose()
  }
})().catch((error) => {
  console.error(error)
  process.exit(1)
})
