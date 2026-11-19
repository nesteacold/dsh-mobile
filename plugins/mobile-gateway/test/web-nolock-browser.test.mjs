// Spec 045 — BEHAVIOURAL gateway tests: a browser-origin WS socket is never web-locked.
// Real TLS listener + real WebSocket frames; no source regex. The legacy suites keep the
// native/pre-045 lock path under `testWebUnlockLegacyBrowserLock`; this file uses production
// defaults: only a socket that presents a browser Origin skips the lock, all others keep it.
import assert from 'node:assert/strict'
import fs from 'node:fs'
import http from 'node:http'
import os from 'node:os'
import path from 'node:path'
import { once } from 'node:events'
import { test } from 'node:test'

import WebSocket from 'ws'
import plugin from '../lib/index.mjs'
import { createTestConnection, createTestRemoteAccess } from './helpers/peer.mjs'
import { setOwnerOnlyProbeOverride } from '../lib/secure-file.mjs'
import { listenFetchSafe } from './support/fetch-safe-listen.mjs'

const delay = (ms) => new Promise((resolve) => setTimeout(resolve, ms))
const WEB_SCOPES = ['sessions:read', 'prompt:send', 'approval:respond', 'web:unlock']

function fakeHost() {
  return {
    async invoke(request) {
      if (request.namespace === 'session' && request.method === 'list') return { items: [{ sessionId: 's1', title: 'SECRET-TITLE' }] }
      return {}
    },
    async stream(request) {
      return (async function* () {
        if (request.namespace === 'workspace' && request.method === 'follow') {
          yield { type: 'baseline', value: { items: [], archivedSessionIds: [] } }
        } else if (request.namespace === 'session' && request.method === 'follow') {
          yield { type: 'snapshot', header: { version: 4, id: 's1' }, cursor: 1, records: [], hasMore: false,
            projections: { asOfSeq: 1, values: {} }, assistantStream: { revision: 0 } }
        } else {
          yield { type: 'baseline', value: { projections: {} } }
        }
        while (!request.signal?.aborted) await delay(10)
      })()
    },
  }
}

async function factory(t, extraConfig = {}) {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'dsh-nolock-browser-'))
  setOwnerOnlyProbeOverride(() => null)
  t.after(() => { setOwnerOnlyProbeOverride(undefined) })
  const reservation = http.createServer()
  await listenFetchSafe(reservation)
  const lanPort = reservation.address().port
  await new Promise((resolve) => reservation.close(resolve))
  const origin = `https://127.0.0.1:${lanPort}`
  let management
  let upgrade
  let dispose = () => {}
  const server = http.createServer((req, res) => {
    if (management && (req.url === management.path || req.url.startsWith(`${management.path}/`))) {
      management.handler(req, res); return
    }
    res.writeHead(404).end()
  })
  server.on('upgrade', (req, socket, head) => { if (upgrade) upgrade.handler(req, socket, head); else socket.destroy() })
  await listenFetchSafe(server)
  const port = server.address().port
  await plugin.apply({
    webServer: {
      port,
      register(route) { management = route; return () => {} },
      registerUpgrade(route) { upgrade = route; return () => {} },
    },
    connection: createTestConnection(), remoteAccess: createTestRemoteAccess(), typertGateway: fakeHost(),
    agentDefaultModel: {}, on() { return () => {} }, effect(fn) { dispose = fn() },
  }, {
    remoteControl: { enabled: true }, gatewayMode: 'persistent', gatewayWaitTimeoutMs: 60_000,
    gatewayName: `nolock-browser-${port}`, deviceFile: path.join(directory, 'devices.json'),
    pairingTtlMs: 60_000, lanEnabled: true, lanHost: '127.0.0.1', lanPort,
    requireHostApproval: false, allowedOrigins: [origin],
    ...extraConfig,
  })
  const sockets = []
  const base = `http://127.0.0.1:${port}`
  let lanUrl
  let pin
  for (let attempt = 0; attempt < 200; attempt += 1) {
    const status = await (await fetch(`${base}/mgw/status`)).json()
    if (status.lan?.listening && status.lan.urls.length > 0) {
      lanUrl = status.lan.urls[0]; pin = status.lan.certSha256; break
    }
    await delay(20)
  }
  if (!lanUrl) throw new Error('TLS listener did not become ready')
  t.after(async () => {
    for (const socket of sockets) socket.terminate()
    try { dispose() } catch { /* already disposed */ }
    await new Promise((resolve) => server.close(resolve))
    fs.rmSync(directory, { recursive: true, force: true })
  })
  return {
    base, origin, lanUrl, pin, directory,
    async post(route, body) {
      const response = await fetch(`${base}/mgw/${route}`, {
        method: 'POST', headers: { 'Content-Type': 'application/json', Origin: base }, body: JSON.stringify(body ?? {}),
      })
      return { status: response.status, data: await response.json() }
    },
    // `browser: true` sends the browser Origin on the WS upgrade; native clients send none.
    open(protocols, headers = {}, browser = true) {
      const ws = new WebSocket(lanUrl, protocols, {
        headers: { 'X-DSH-Cert-SHA256': pin, ...headers },
        ...(browser ? { origin } : { origin: undefined }), rejectUnauthorized: false,
      })
      sockets.push(ws)
      record(ws)
      return ws
    },
  }
}

const frames = new WeakMap()
function record(ws) {
  const seen = []
  frames.set(ws, seen)
  ws.on('message', (data) => { try { seen.push(JSON.parse(data.toString())) } catch { /* not ours */ } })
  ws.on('error', () => {})
  return seen
}
async function take(ws, predicate, timeoutMs = 6000) {
  const seen = frames.get(ws) ?? record(ws)
  const deadline = Date.now() + timeoutMs
  while (Date.now() < deadline) { const frame = seen.find(predicate); if (frame) return frame; await delay(5) }
  throw new Error(`timed out waiting for a frame (seen: ${seen.map((f) => f.kind).join(', ') || 'none'})`)
}
let counter = 0
async function ask(ws, frame) {
  const requestId = `nl-${++counter}`
  ws.send(JSON.stringify({ ...frame, requestId }))
  return take(ws, (reply) => reply.requestId === requestId)
}
async function negotiate(ws, capabilities = []) {
  const requestId = `hello-${++counter}`
  ws.send(JSON.stringify({ type: 'client-hello', requestId, companionProtocol: 1, appVersion: 'test',
    platform: 'web', capabilities }))
  return take(ws, (reply) => reply.kind === 'client-hello' && reply.requestId === requestId)
}
async function pair(instance, id, browser = true) {
  const created = await instance.post('pair', { name: id, publicUrl: instance.lanUrl,
    kind: 'mobile', scopes: WEB_SCOPES })
  assert.equal(created.status, 201, JSON.stringify(created.data))
  const ws = instance.open(['dsh-mobile-v1', `dsh-pair.${created.data.payload.pairingCode}`],
    { 'X-DSH-Device-ID': id }, browser)
  await once(ws, 'open')
  const paired = await take(ws, (frame) => frame.kind === 'paired')
  const hello = await take(ws, (frame) => frame.kind === 'hello')
  await negotiate(ws)
  return { ws, token: paired.token, device: paired.device, hello }
}
function reconnect(instance, session, browser = true) {
  return instance.open(['dsh-mobile-v1'],
    { Authorization: `Bearer ${session.token}`, 'X-DSH-Device-ID': session.device.id }, browser)
}

// ---------------------------------------------------------------------------

test('NL-1 browser-origin web:unlock socket: no hello.webLock, ordinary ops run at once, close/reconnect stays usable', async (t) => {
  const instance = await factory(t)
  const web = await pair(instance, 'nolock-browser-01', true)
  // The gateway half of version skew: an OLD gateway would say `webLock:'unregistered'` and
  // refuse ordinary frames `auth/locked`. Neither appears for a browser socket now.
  assert.equal(Object.hasOwn(web.hello, 'webLock'), false, JSON.stringify(web.hello).slice(0, 240))
  assert.equal(typeof web.hello.clients, 'number', 'the client count is no longer withheld')
  const served = await ask(web.ws, { type: 'sessions' })
  assert.equal(served.kind, 'sessions', JSON.stringify(served).slice(0, 240))
  assert.ok(JSON.stringify(served).includes('SECRET-TITLE'), 'real session data reaches the browser')
  assert.equal((await ask(web.ws, { type: 'history', sessionId: 's1' })).kind, 'history')
  // The capability from an older/newer bundle does not re-arm anything.
  await negotiate(web.ws, ['web-unlock-session.v1'])
  assert.equal((await ask(web.ws, { type: 'sessions' })).kind, 'sessions')

  web.ws.close()
  await delay(80)
  const again = reconnect(instance, web, true)
  await once(again, 'open')
  const hello = await take(again, (frame) => frame.kind === 'hello')
  assert.equal(Object.hasOwn(hello, 'webLock'), false, 'reconnect starts unlocked too')
  await negotiate(again)
  assert.equal((await ask(again, { type: 'sessions' })).kind, 'sessions', 'reconnect is usable')
})

test('NL-4 a profile config key cannot enable the legacy lock seam', async (t) => {
  // Reviewer: the seam is a sealed third `apply()` argument. A config key with the same
  // name must be deleted from `options` and must never re-arm a browser socket.
  const instance = await factory(t, { testWebUnlockLegacyBrowserLock: true })
  const web = await pair(instance, 'nolock-config-seam-01', true)
  assert.equal(Object.hasOwn(web.hello, 'webLock'), false)
  assert.equal((await ask(web.ws, { type: 'sessions' })).kind, 'sessions')
})

test('NL-2 non-browser web:unlock socket keeps the spec 021 lock path', async (t) => {
  const instance = await factory(t)
  const native = await pair(instance, 'nolock-native-01', false)
  assert.equal(native.hello.webLock, 'unregistered', JSON.stringify(native.hello).slice(0, 240))
  const refused = await ask(native.ws, { type: 'sessions' })
  assert.equal(refused.kind, 'error')
  assert.equal(refused.code, 'auth/locked')
  assert.equal(refused.reason, 'unregistered')
  assert.equal((await ask(native.ws, { type: 'ping' })).kind, 'pong', 'handshake frames still run')
})

test('NL-3 explicit passkey-lock broadcast cannot re-arm an already-open browser socket', async (t) => {
  const instance = await factory(t)
  const browser = await pair(instance, 'nolock-browser-02', true)
  const native = await pair(instance, 'nolock-native-02', false)
  // `passkey-lock` on the native socket is device-wide for NATIVE sockets; the browser
  // socket must keep serving data (no broadcast re-arm).
  const locked = await ask(native.ws, { type: 'passkey-lock' })
  assert.equal(locked.kind, 'passkey-lock', JSON.stringify(locked).slice(0, 240))
  assert.equal(locked.locked, true)
  assert.equal((await ask(native.ws, { type: 'sessions' })).code, 'auth/locked', 'native is locked')
  assert.equal((await ask(browser.ws, { type: 'sessions' })).kind, 'sessions', 'browser is not')
  // A legacy browser bundle still gets a valid contract reply to the passkey frames; the
  // gateway keeps the service available but never gates on it.
  const legacy = await ask(browser.ws, { type: 'passkey-lock' })
  assert.equal(legacy.kind, 'error')
  assert.equal(legacy.code, 'passkey/not-registered')
  assert.equal((await ask(browser.ws, { type: 'sessions' })).kind, 'sessions', 'still not gated')
})
