// Spec 036 — WIRE-level behaviour of the opt-in web unlock session.
// Real TLS listener, real WebSocket frames, real WebAuthn signatures. No /mgw calls from a
// device socket and no source regex: every claim below is an observed frame.
import assert from 'node:assert/strict'
import crypto from 'node:crypto'
import fs from 'node:fs'
import http from 'node:http'
import os from 'node:os'
import path from 'node:path'
import { once } from 'node:events'
import { test } from 'node:test'

import WebSocket from 'ws'
import plugin from '../lib/index.mjs'
import { createTestConnection, createTestRemoteAccess } from './helpers/peer.mjs'
import { encodeBase64url } from '../lib/webauthn.mjs'
import { otpProof } from '../lib/pairing-requests.mjs'
import { setOwnerOnlyProbeOverride } from '../lib/secure-file.mjs'
import { listenFetchSafe } from './support/fetch-safe-listen.mjs'

const delay = (ms) => new Promise((resolve) => setTimeout(resolve, ms))
const WEB_SCOPES = ['sessions:read', 'prompt:send', 'approval:respond', 'web:unlock']
const CAPABILITY = 'web-unlock-session.v1'

function cborHead(major, length) {
  if (length < 24) return Buffer.from([(major << 5) | length])
  if (length < 0x100) return Buffer.from([(major << 5) | 24, length])
  const head = Buffer.from([0, 0, 0]); head[0] = (major << 5) | 25; head.writeUInt16BE(length, 1); return head
}
function cbor(value) {
  if (Number.isSafeInteger(value)) return value >= 0 ? cborHead(0, value) : cborHead(1, -1 - value)
  if (Buffer.isBuffer(value)) return Buffer.concat([cborHead(2, value.length), value])
  if (typeof value === 'string') { const b = Buffer.from(value, 'utf8'); return Buffer.concat([cborHead(3, b.length), b]) }
  if (Array.isArray(value)) return Buffer.concat([cborHead(4, value.length), ...value.map(cbor)])
  const entries = [...value].map(([k, v]) => Buffer.concat([cbor(k), cbor(v)]))
  return Buffer.concat([cborHead(5, entries.length), ...entries])
}
const uint32 = (value) => { const b = Buffer.alloc(4); b.writeUInt32BE(value >>> 0); return b }
function authenticator() {
  const { privateKey, publicKey } = crypto.generateKeyPairSync('ec', { namedCurve: 'P-256' })
  const jwk = publicKey.export({ format: 'jwk' })
  const id = crypto.randomBytes(32)
  const cose = cbor(new Map([[1, 2], [3, -7], [-1, 1],
    [-2, Buffer.from(jwk.x, 'base64url')], [-3, Buffer.from(jwk.y, 'base64url')]]))
  let counter = 1
  const clientData = (challenge, type, origin) => Buffer.from(JSON.stringify({ type, challenge, origin, crossOrigin: false }))
  return {
    registration(challenge, origin, rpId) {
      const len = Buffer.alloc(2); len.writeUInt16BE(id.length)
      const authData = Buffer.concat([crypto.createHash('sha256').update(rpId).digest(), Buffer.from([0x45]),
        uint32(counter), Buffer.alloc(16), len, id, cose])
      return { id: encodeBase64url(id), rawId: encodeBase64url(id),
        clientDataJSON: encodeBase64url(clientData(challenge, 'webauthn.create', origin)),
        attestationObject: encodeBase64url(cbor(new Map([
          ['fmt', 'none'], ['attStmt', new Map()], ['authData', authData], ['type', 'public-key'],
        ]))) }
    },
    assertion(challenge, origin, rpId) {
      counter += 1
      const data = clientData(challenge, 'webauthn.get', origin)
      const authData = Buffer.concat([crypto.createHash('sha256').update(rpId).digest(), Buffer.from([0x05]), uint32(counter)])
      const signature = crypto.sign('sha256', Buffer.concat([authData, crypto.createHash('sha256').update(data).digest()]), privateKey)
      return { id: encodeBase64url(id), rawId: encodeBase64url(id), clientDataJSON: encodeBase64url(data),
        authenticatorData: encodeBase64url(authData), signature: encodeBase64url(signature) }
    },
  }
}

function fakeHost() {
  return {
    async invoke(request) {
      if (request.namespace === 'session' && request.method === 'list') return { items: [] }
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

async function factory(t) {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'dsh-session-wire-'))
  setOwnerOnlyProbeOverride(() => null)
  t.after(() => { setOwnerOnlyProbeOverride(undefined); fs.rmSync(directory, { recursive: true, force: true }) })
  const reservation = http.createServer()
  await listenFetchSafe(reservation)
  const lanPort = reservation.address().port
  await new Promise((resolve) => reservation.close(resolve))
  const origin = `https://127.0.0.1:${lanPort}`
  let management; let upgrade; let dispose = () => {}
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
    gatewayName: `session-wire-${port}`, deviceFile: path.join(directory, 'devices.json'),
    pairingTtlMs: 60_000, lanEnabled: true, lanHost: '127.0.0.1', lanPort,
    requireHostApproval: false, allowedOrigins: [origin],
  }, {
    // Spec 045: this suite drives the legacy per-socket lock path with real WebAuthn frames.
    testWebUnlockLegacyBrowserLock: true,
  })
  const sockets = []
  const base = `http://127.0.0.1:${port}`
  let lanUrl; let pin
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
  })
  return {
    base, origin, lanUrl, pin,
    async pending() {
      const response = await fetch(`${base}/mgw/pending`, { headers: { Origin: base } })
      return response.json()
    },
    async post(route, body) {
      const response = await fetch(`${base}/mgw/${route}`, {
        method: 'POST', headers: { 'Content-Type': 'application/json', Origin: base }, body: JSON.stringify(body ?? {}),
      })
      return { status: response.status, data: await response.json() }
    },
    open(protocols, headers = {}) {
      const ws = new WebSocket(lanUrl, protocols, {
        headers: { 'X-DSH-Cert-SHA256': pin, ...headers }, origin, rejectUnauthorized: false,
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
let helloCounter = 0
async function negotiate(ws, capabilities = []) {
  const requestId = `hello-${++helloCounter}`
  ws.send(JSON.stringify({ type: 'client-hello', requestId, companionProtocol: 1, appVersion: 'test',
    platform: 'web', capabilities }))
  return take(ws, (frame) => frame.kind === 'client-hello' && frame.requestId === requestId)
}
let counter = 0
async function ask(ws, frame) {
  const requestId = `pk-${++counter}`
  ws.send(JSON.stringify({ ...frame, requestId }))
  return take(ws, (reply) => reply.requestId === requestId)
}
async function pair(instance, id) {
  const created = await instance.post('pair', { name: id, publicUrl: instance.lanUrl,
    kind: 'mobile', scopes: WEB_SCOPES })
  assert.equal(created.status, 201, JSON.stringify(created.data))
  const ws = instance.open(['dsh-mobile-v1', `dsh-pair.${created.data.payload.pairingCode}`], { 'X-DSH-Device-ID': id })
  await once(ws, 'open')
  const paired = await take(ws, (f) => f.kind === 'paired')
  await take(ws, (f) => f.kind === 'hello')
  return { ws, token: paired.token }
}
function reconnect(instance, token, id) {
  const ws = instance.open(['dsh-mobile-v1'], { Authorization: `Bearer ${token}`, 'X-DSH-Device-ID': id })
  return ws
}
async function register(ws, instance, auth) {
  const rpId = new URL(instance.origin).hostname
  const options = await ask(ws, { type: 'passkey-register-options' })
  const reply = await ask(ws, { type: 'passkey-register',
    attestation: auth.registration(options.challenge, instance.origin, rpId) })
  assert.equal(reply.ok, true, JSON.stringify(reply))
}
async function unlock(ws, instance, auth) {
  const rpId = new URL(instance.origin).hostname
  const options = await ask(ws, { type: 'passkey-assert-options' })
  return ask(ws, { type: 'passkey-assert', assertion: auth.assertion(options.challenge, instance.origin, rpId) })
}

test('WS-1 per-socket opt-in, refreshed hello, inbound/outbound gate and device-wide Lock', async (t) => {
  const instance = await factory(t)
  const id = 'ws-session-01'
  const first = await pair(instance, id)
  await negotiate(first.ws, [CAPABILITY])
  const auth = authenticator()
  await register(first.ws, instance, auth)
  assert.equal((await unlock(first.ws, instance, auth)).unlocked, true)
  assert.equal((await ask(first.ws, { type: 'sessions' })).kind, 'sessions', 'the asserting socket is served')
  first.ws.close()
  await delay(80)

  // Capable reconnect: first hello is locked; the accepted capability triggers a second,
  // authoritative hello carrying the persisted grant.
  const capable = reconnect(instance, first.token, id)
  await once(capable, 'open')
  const initial = await take(capable, (f) => f.kind === 'hello')
  assert.equal(initial.webLock, 'locked', 'the pre-negotiation hello never reveals the grant')
  await negotiate(capable, [CAPABILITY])
  const refreshed = await take(capable, (f) => f.kind === 'hello' && f !== initial && f.webLock === 'unlocked')
  assert.ok(refreshed, 'a second, granted hello arrived after client-hello')
  assert.equal((await ask(capable, { type: 'sessions' })).kind, 'sessions')
  assert.equal((await ask(capable, { type: 'history', sessionId: 's1' })).kind, 'history')

  // Same device, NO capability: the persisted grant does not cross to this socket.
  const legacy = reconnect(instance, first.token, id)
  await once(legacy, 'open')
  const legacyHello = await take(legacy, (f) => f.kind === 'hello')
  await negotiate(legacy)
  await delay(120)
  assert.equal(frames.get(legacy).filter((f) => f.kind === 'hello').length, 1, 'no second hello without the opt-in')
  assert.equal(legacyHello.webLock, 'locked')
  const refused = await ask(legacy, { type: 'sessions' })
  assert.equal(refused.code, 'auth/locked')

  // Explicit Lock from A is device-wide: BOTH sockets stop receiving data.
  assert.equal((await ask(capable, { type: 'passkey-lock' })).locked, true)
  assert.equal((await ask(capable, { type: 'sessions' })).code, 'auth/locked')
  assert.equal((await ask(legacy, { type: 'sessions' })).code, 'auth/locked')

  // A fresh capable socket after the Lock is locked too: the grant was cleared, not suspended.
  const afterLock = reconnect(instance, first.token, id)
  await once(afterLock, 'open')
  await take(afterLock, (f) => f.kind === 'hello')
  await negotiate(afterLock, [CAPABILITY])
  await delay(120)
  assert.equal(frames.get(afterLock).filter((f) => f.kind === 'hello').at(-1).webLock, 'locked')
  assert.equal((await ask(afterLock, { type: 'sessions' })).code, 'auth/locked')
})

test('WS-4 a re-pair through HOST APPROVAL of a pending pairing also invalidates the old grant', async (t) => {
  const instance = await factory(t)
  const id = 'ws-session-04'
  const first = await pair(instance, id)
  await negotiate(first.ws, [CAPABILITY])
  const auth = authenticator()
  await register(first.ws, instance, auth)
  assert.equal((await unlock(first.ws, instance, auth)).unlocked, true)

  // Promote a NEW OTP offer for the SAME installation through the pending-approval path.
  const offer = await instance.post('pair', { mode: 'otp', kind: 'mobile', scopes: WEB_SCOPES })
  assert.equal(offer.status, 201, JSON.stringify(offer.data))
  const pending = instance.open(['dsh-mobile-v1', 'dsh-pair-otp.v1'], {
    'X-DSH-Device-ID': id, 'X-DSH-Device-Name': Buffer.from('Repaired tab').toString('base64'),
  })
  await once(pending, 'open')
  const challenge = await take(pending, (frame) => frame.kind === 'pairing-challenge')
  const clientNonce = crypto.randomBytes(18).toString('base64url')
  pending.send(JSON.stringify({ type: 'pairing-proof', clientNonce,
    otpProof: otpProof(offer.data.otp, instance.pin, clientNonce, challenge.serverNonce) }))
  await take(pending, (frame) => frame.kind === 'pairing-pending')
  const [request] = (await instance.pending()).pending
  assert.ok(request, 'the pending approval exists')
  const approved = await instance.post(`pending/${encodeURIComponent(request.id)}/approve`, {})
  assert.equal(approved.status, 200, JSON.stringify(approved.data))
  await take(pending, (frame) => frame.kind === 'paired')
  await take(pending, (frame) => frame.kind === 'hello')
  await negotiate(pending, [CAPABILITY])
  await delay(120)
  assert.equal(frames.get(pending).filter((f) => f.kind === 'hello').at(-1).webLock, 'locked',
    'the approved re-pair did not inherit the old grant')
  assert.equal((await ask(pending, { type: 'sessions' })).code, 'auth/locked')
})

test('WS-3 disabling the gateway clears the grant permanently; enable + reconnect re-asserts', async (t) => {
  const instance = await factory(t)
  const id = 'ws-session-03'
  const first = await pair(instance, id)
  await negotiate(first.ws, [CAPABILITY])
  const auth = authenticator()
  await register(first.ws, instance, auth)
  assert.equal((await unlock(first.ws, instance, auth)).unlocked, true)

  const disabled = await instance.post('gateway', { mode: 'disabled' })
  assert.equal(disabled.status, 200, JSON.stringify(disabled.data))
  const enabled = await instance.post('gateway', { mode: 'persistent' })
  assert.equal(enabled.status, 200, JSON.stringify(enabled.data))
  for (let attempt = 0; attempt < 200; attempt += 1) {
    const status = await (await fetch(`${instance.base}/mgw/status`)).json()
    if (status.lan?.listening && status.lan.urls.length > 0) break
    await delay(20)
  }
  const reconnecting = reconnect(instance, first.token, id)
  await once(reconnecting, 'open')
  await take(reconnecting, (f) => f.kind === 'hello')
  await negotiate(reconnecting, [CAPABILITY])
  await delay(120)
  assert.equal(frames.get(reconnecting).filter((f) => f.kind === 'hello').at(-1).webLock, 'locked')
  assert.equal((await ask(reconnecting, { type: 'sessions' })).code, 'auth/locked')
})

test('WS-2 re-pair invalidates the grant before the new socket is activated', async (t) => {
  const instance = await factory(t)
  const id = 'ws-session-02'
  const first = await pair(instance, id)
  await negotiate(first.ws, [CAPABILITY])
  const auth = authenticator()
  await register(first.ws, instance, auth)
  assert.equal((await unlock(first.ws, instance, auth)).unlocked, true)
  // Re-pair the SAME installation: a fresh offer/code replaces the credential.
  const again = await instance.post('pair', { name: id, publicUrl: instance.lanUrl,
    kind: 'mobile', scopes: WEB_SCOPES })
  assert.equal(again.status, 201, JSON.stringify(again.data))
  const replacement = instance.open(['dsh-mobile-v1', `dsh-pair.${again.data.payload.pairingCode}`],
    { 'X-DSH-Device-ID': id })
  await once(replacement, 'open')
  const paired = await take(replacement, (f) => f.kind === 'paired')
  await take(replacement, (f) => f.kind === 'hello')
  await negotiate(replacement, [CAPABILITY])
  await delay(120)
  const current = frames.get(replacement).filter((f) => f.kind === 'hello').at(-1)
  assert.equal(current.webLock, 'locked', 'a re-pair never inherits the old grant')
  assert.equal((await ask(replacement, { type: 'sessions' })).code, 'auth/locked')
  assert.ok(paired.token, 'the replacement credential was issued')
})
