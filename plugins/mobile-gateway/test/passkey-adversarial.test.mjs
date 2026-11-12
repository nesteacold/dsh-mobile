// Spec 021 (contract revision 14) — the web passkey unlock, WIRE level.
//
// `test/passkey.test.mjs` proves the WebAuthn rules and the passkey service in isolation. This
// file proves the part that only the assembled gateway can show: a real socket over the real TLS
// listener, the real scope gate, the real lock gate and the real send gate. Every case drives a
// frame through `plugin.apply()` against a recording fake Host, so a regression in the WIRING (a
// missing exemption, a gate in the wrong order, a frame the lock still lets through) fails here
// even though the unit suite stays green — that is exactly the class of defect this file was
// written for.
//
// Read-only: nothing here patches the implementation. Keys, signatures and CBOR are real.
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
const PHONE_SCOPES = ['sessions:read', 'prompt:send', 'approval:respond']

// ---------------------------------------------------------------------------
// A CBOR writer and a genuine authenticator (test side)
// ---------------------------------------------------------------------------

function cborHead(major, length) {
  if (length < 24) return Buffer.from([(major << 5) | length])
  if (length < 0x100) return Buffer.from([(major << 5) | 24, length])
  const head = Buffer.from([(major << 5) | 25, 0, 0])
  head.writeUInt16BE(length, 1)
  return head
}

function cbor(value) {
  if (Number.isSafeInteger(value)) return value >= 0 ? cborHead(0, value) : cborHead(1, -1 - value)
  if (Buffer.isBuffer(value)) return Buffer.concat([cborHead(2, value.length), value])
  if (typeof value === 'string') {
    const bytes = Buffer.from(value, 'utf8')
    return Buffer.concat([cborHead(3, bytes.length), bytes])
  }
  if (Array.isArray(value)) return Buffer.concat([cborHead(4, value.length), ...value.map(cbor)])
  const entries = [...value].map(([key, entry]) => Buffer.concat([cbor(key), cbor(entry)]))
  return Buffer.concat([cborHead(5, entries.length), ...entries])
}

function uint32(value) {
  const bytes = Buffer.from([0, 0, 0, 0])
  bytes.writeUInt32BE(value >>> 0, 0)
  return bytes
}

/**
 * One genuine ES256 authenticator: a fresh P-256 key per run, a real COSE key and real
 * signatures over the real `authData || SHA-256(clientDataJSON)` input.
 */
function es256Authenticator(signCount = 1) {
  const { privateKey, publicKey } = crypto.generateKeyPairSync('ec', { namedCurve: 'P-256' })
  const jwk = publicKey.export({ format: 'jwk' })
  const credentialId = crypto.randomBytes(32)
  /** The authenticator's own counter: it advances with every signature it produces. */
  let signCounter = signCount
  const cose = cbor(new Map([
    [1, 2], [3, -7], [-1, 1],
    [-2, Buffer.from(jwk.x, 'base64url')], [-3, Buffer.from(jwk.y, 'base64url')],
  ]))
  const clientData = (challenge, { origin, type }) => Buffer.from(JSON.stringify({
    type, challenge, origin, crossOrigin: false,
  }), 'utf8')
  return {
    credentialId,
    /** A `passkey-register` payload the gateway should accept (fmt `none`). */
    registration(challenge, { origin, rpId, flags = 0x45, counter = signCount } = {}) {
      const idLength = Buffer.from([0, 0])
      idLength.writeUInt16BE(credentialId.length, 0)
      // Attested credential data is AAGUID(16) + credentialIdLength(2) + id + COSE key
      // (WebAuthn §6.5.2). The AAGUID is real on the wire, so the fixture sends it too.
      const authData = Buffer.concat([
        crypto.createHash('sha256').update(rpId, 'utf8').digest(),
        Buffer.from([flags]),
        uint32(counter),
        Buffer.alloc(16, 0),
        idLength,
        credentialId,
        cose,
      ])
      return {
        id: encodeBase64url(credentialId),
        rawId: encodeBase64url(credentialId),
        clientDataJSON: encodeBase64url(clientData(challenge, { origin, type: 'webauthn.create' })),
        attestationObject: encodeBase64url(cbor(new Map([
          ['fmt', 'none'], ['attStmt', new Map()], ['authData', authData], ['type', 'public-key'],
        ]))),
      }
    },
    /**
     * A `passkey-assert` payload signed over `authData || SHA-256(clientDataJSON)`.
     *
     * The counter advances on every call unless a case fixes it: a real authenticator counts, and
     * the gateway refuses a non-increasing counter, so two assertions from the same helper must
     * not carry the same value.
     */
    assertion(challenge, { origin, rpId, flags = 0x05, counter = null } = {}) {
      const value = counter === null ? ++signCounter : counter
      const clientDataJSON = clientData(challenge, { origin, type: 'webauthn.get' })
      const authData = Buffer.concat([
        crypto.createHash('sha256').update(rpId, 'utf8').digest(),
        Buffer.from([flags]),
        uint32(value),
      ])
      const digest = crypto.createHash('sha256').update(clientDataJSON).digest()
      return {
        id: encodeBase64url(credentialId),
        rawId: encodeBase64url(credentialId),
        clientDataJSON: encodeBase64url(clientDataJSON),
        authenticatorData: encodeBase64url(authData),
        signature: encodeBase64url(crypto.sign('sha256', Buffer.concat([authData, digest]), privateKey)),
      }
    },
  }
}

// ---------------------------------------------------------------------------
// The assembled gateway
// ---------------------------------------------------------------------------

function fakeHost(hostCalls) {
  return {
    async invoke(request) {
      hostCalls.push({ endpoint: `${request.namespace}/${request.method}`, principal: request.peer?.principal })
      if (request.namespace === 'session' && request.method === 'list') return { items: [{ sessionId: 's1', title: 'SECRET-TITLE' }] }
      return {}
    },
    async stream(request) {
      return (async function* () {
        // The gateway validates the baseline shapes; a wrong one makes it retry forever, which
        // keeps the process alive. Match what `test/session-authoring-adversarial.test.mjs` serves.
        if (request.namespace === 'workspace' && request.method === 'follow') {
          yield { type: 'baseline', value: { items: [], archivedSessionIds: [] } }
        } else if (request.namespace === 'session' && request.method === 'follow') {
          yield { type: 'snapshot', header: { version: 4, id: 's1' }, cursor: 1, records: [], hasMore: false,
            projections: { asOfSeq: 1, values: {} }, assistantStream: { revision: 0 } }
        } else {
          yield { type: 'baseline', value: { projections: {} } }
        }
        // End with the socket's signal rather than looping: an unending generator here would keep
        // the whole test process alive after the last assertion.
        while (!request.signal?.aborted) await delay(10)
      })()
    },
  }
}

async function factory(t, config = {}) {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'dsh-passkey-adv-'))
  setOwnerOnlyProbeOverride(() => null)
  t.after(() => setOwnerOnlyProbeOverride(undefined))
  // The passkey site is the EXACT Origin the page runs on, and it must be one of the gateway's
  // `allowedOrigins` — the same list the WS upgrade fence reads (spec 005 FR5). That list is read
  // once at startup, so the test has to know the listener's port BEFORE the plugin binds it:
  // reserve a free port here, release it, and hand the gateway that exact number.
  const reservation = http.createServer()
  await listenFetchSafe(reservation)
  const lanPort = reservation.address().port
  await new Promise((resolve) => reservation.close(resolve))
  const origin = `https://127.0.0.1:${lanPort}`
  const hostCalls = []
  let management
  let upgrade
  let dispose = () => {}
  const server = http.createServer((req, res) => {
    if (management && (req.url === management.path || req.url.startsWith(`${management.path}/`))) { management.handler(req, res); return }
    res.writeHead(404).end()
  })
  server.on('upgrade', (req, socket, head) => { if (upgrade) upgrade.handler(req, socket, head); else socket.destroy() })
  await listenFetchSafe(server)
  const port = server.address().port
  const events = new Map()
  await plugin.apply({
    webServer: {
      port,
      register(route) { management = route; return () => {} },
      registerUpgrade(route) { upgrade = route; return () => {} },
    },
    connection: createTestConnection(),
    remoteAccess: createTestRemoteAccess(),
    typertGateway: fakeHost(hostCalls),
    agentDefaultModel: {},
    on(event, handler) {
      const list = events.get(event) ?? []
      list.push(handler)
      events.set(event, list)
      return () => { const i = list.indexOf(handler); if (i >= 0) list.splice(i, 1) }
    },
    effect(fn) { dispose = fn() },
  }, {
    remoteControl: { enabled: true },
    gatewayMode: 'persistent',
    gatewayWaitTimeoutMs: 60_000,
    gatewayName: `passkey-adv-${port}`,
    deviceFile: path.join(directory, 'devices.json'),
    pairingTtlMs: 60_000,
    lanEnabled: true,
    lanHost: '127.0.0.1',
    lanPort,
    requireHostApproval: false,
    allowedOrigins: [origin],
    ...config,
  })
  const sockets = []
  t.after(async () => {
    for (const socket of sockets) socket.terminate()
    try { dispose() } catch { /* already disposed */ }
    await new Promise((resolve) => server.close(resolve))
    fs.rmSync(directory, { recursive: true, force: true })
  })
  const instance = {
    hostCalls,
    directory,
    events,
    base: `http://127.0.0.1:${port}`,
    async post(route, body) {
      const response = await fetch(`${instance.base}/mgw/${route}`, {
        method: 'POST', headers: { 'Content-Type': 'application/json', Origin: instance.base }, body: JSON.stringify(body ?? {}),
      })
      let data = null
      try { data = await response.json() } catch { /* non-JSON error page */ }
      return { status: response.status, data }
    },
    async pending() {
      const response = await fetch(`${instance.base}/mgw/pending`, { headers: { Origin: instance.base } })
      return response.json()
    },
    track(socket) { sockets.push(socket); return socket },
  }
  for (let attempt = 0; attempt < 200; attempt += 1) {
    const status = await (await fetch(`${instance.base}/mgw/status`)).json()
    if (status.lan?.listening && status.lan.urls.length > 0) {
      instance.lanUrl = status.lan.urls[0]
      instance.lanPin = status.lan.certSha256
      // The exact Origin the page runs on: the passkey site, and the one `allowedOrigins` lists.
      instance.origin = origin
      return instance
    }
    await delay(20)
  }
  throw new Error('TLS listener did not become ready')
}

const frames = new WeakMap()
function record(ws) {
  const seen = []
  frames.set(ws, seen)
  ws.on('message', (data) => { try { seen.push(JSON.parse(data.toString())) } catch { /* not ours */ } })
  ws.on('error', () => {})
  return seen
}
async function take(ws, predicate, timeoutMs = 6_000) {
  const seen = frames.get(ws) ?? record(ws)
  const deadline = Date.now() + timeoutMs
  while (Date.now() < deadline) { const frame = seen.find(predicate); if (frame) return frame; await delay(5) }
  throw new Error(`timed out waiting for a frame (seen: ${seen.map((frame) => frame.kind).join(', ') || 'none'})`)
}
const open = (instance, protocols, headers = {}) => instance.track(new WebSocket(instance.lanUrl, protocols, {
  headers: { 'X-DSH-Cert-SHA256': instance.lanPin, ...headers }, origin: instance.origin, rejectUnauthorized: false,
}))
let helloCounter = 0
async function negotiate(ws) {
  const requestId = `hello-${++helloCounter}`
  ws.send(JSON.stringify({ type: 'client-hello', requestId, companionProtocol: 1, appVersion: 'test', platform: 'web' }))
  return take(ws, (frame) => frame.kind === 'client-hello' && frame.requestId === requestId)
}
let counter = 0
async function ask(ws, frame) {
  const requestId = `pk-${++counter}`
  ws.send(JSON.stringify({ ...frame, requestId }))
  return take(ws, (reply) => reply.requestId === requestId)
}

/** Pair a device with an EXPLICIT grant and return its live, negotiated connection. */
async function pairDevice(instance, deviceId, offer) {
  const created = await instance.post('pair', { name: deviceId, publicUrl: instance.lanUrl, ...offer })
  assert.equal(created.status, 201, JSON.stringify(created.data))
  const ws = open(instance, ['dsh-mobile-v1', `dsh-pair.${created.data.payload.pairingCode}`], { 'X-DSH-Device-ID': deviceId })
  record(ws)
  await once(ws, 'open')
  const paired = await take(ws, (frame) => frame.kind === 'paired')
  const hello = await take(ws, (frame) => frame.kind === 'hello')
  await negotiate(ws)
  return { ws, token: paired.token, device: paired.device, hello }
}

/** Run the whole registration ceremony on `ws` and return the authenticator that now owns it. */
async function registerPasskey(instance, ws, origin, rpId) {
  const authenticator = es256Authenticator(1)
  const options = await ask(ws, { type: 'passkey-register-options' })
  assert.equal(options.kind, 'passkey-register-options', JSON.stringify(options).slice(0, 240))
  assert.equal(options.rp.id, rpId)
  const reply = await ask(ws, {
    type: 'passkey-register',
    attestation: authenticator.registration(options.challenge, { origin, rpId }),
  })
  assert.equal(reply.kind, 'passkey-register', JSON.stringify(reply).slice(0, 240))
  assert.equal(reply.ok, true)
  return authenticator
}

/** Run the assertion ceremony on `ws`; returns the reply (a success or a refusal). */
async function assertPasskey(instance, ws, origin, rpId, authenticator, options = {}) {
  const answer = await ask(ws, { type: 'passkey-assert-options' })
  if (answer.kind !== 'passkey-assert-options') return answer
  return ask(ws, {
    type: 'passkey-assert',
    assertion: authenticator.assertion(answer.challenge, { origin, rpId, ...options }),
  })
}

// ===========================================================================
// (1) The lock a new connection starts in
// ===========================================================================

test('WL-1 a web device starts LOCKED: hello says so, and every non-passkey frame is refused auth/locked before any Host call', async (t) => {
  const instance = await factory(t)
  const web = await pairDevice(instance, 'wl-locked-01', { kind: 'mobile', scopes: WEB_SCOPES })
  // Before any passkey exists the state is `unregistered` — the client must register first.
  assert.equal(web.hello.webLock, 'unregistered', JSON.stringify(web.hello).slice(0, 240))
  // §14.2 also covers the metadata in `hello`: a locked socket learns nothing about the Host,
  // and "how many clients are connected" is Host state, so the count is withheld while locked.
  assert.equal(Object.hasOwn(web.hello, 'clients'), false, 'a locked web socket gets no client count')

  const since = instance.hostCalls.length
  for (const frame of [
    { type: 'sessions' },
    { type: 'history', sessionId: 's1' },
  ]) {
    const reply = await ask(web.ws, frame)
    assert.equal(reply.kind, 'error', JSON.stringify(reply).slice(0, 200))
    assert.equal(reply.code, 'auth/locked', `${frame.type} must be locked, got ${JSON.stringify(reply).slice(0, 200)}`)
    assert.equal(reply.reason, 'unregistered', 'the refusal names the lock state')
    // Nothing about sessions travels with it: no ids, titles or counts.
    assert.equal(JSON.stringify(reply).includes('SECRET-TITLE'), false)
    assert.equal(Object.hasOwn(reply, 'sessions'), false)
  }
  assert.deepEqual(instance.hostCalls.slice(since), [], 'a locked socket must reach nothing on the Host')

  // The handshake and the keep-alive are channel-neutral and still run (§14.2).
  assert.equal((await ask(web.ws, { type: 'ping' })).kind, 'pong')
  await negotiate(web.ws)

  // A phone without web:unlock is never affected: no lock, no gate — and its hello keeps the
  // client count it has always carried.
  const phone = await pairDevice(instance, 'wl-locked-02', { kind: 'mobile', scopes: PHONE_SCOPES })
  assert.equal(Object.hasOwn(phone.hello, 'webLock'), false, 'hello.webLock is only for a web device')
  assert.equal(typeof phone.hello.clients, 'number', 'a device with no lock keeps hello.clients')
  assert.equal((await ask(phone.ws, { type: 'sessions' })).kind, 'sessions')
  phone.ws.close()
  web.ws.close()
})

test('WL-2 registering a passkey does NOT unlock the socket; only an assertion on THAT socket does', async (t) => {
  const instance = await factory(t)
  const web = await pairDevice(instance, 'wl-unlock-01', { kind: 'mobile', scopes: WEB_SCOPES })
  const rpId = new URL(instance.origin).hostname
  // Contract §14.2: only a successful `passkey-assert` unlocks. A registration proves the page
  // may create a credential; it is not a user authentication, so the socket stays locked —
  // exactly what the reviewer rejected the first implementation for.
  const authenticator = await registerPasskey(instance, web.ws, instance.origin, rpId)
  const stillLocked = await ask(web.ws, { type: 'sessions' })
  assert.equal(stillLocked.kind, 'error', JSON.stringify(stillLocked).slice(0, 200))
  assert.equal(stillLocked.code, 'auth/locked', 'a registration must not unlock: ' + JSON.stringify(stillLocked).slice(0, 200))
  assert.equal(stillLocked.reason, 'locked', 'the device now HAS a passkey, so the state is plain `locked`')

  // The assertion on the same socket is what opens it.
  const unlocked = await assertPasskey(instance, web.ws, instance.origin, rpId, authenticator)
  assert.equal(unlocked.kind, 'passkey-assert', JSON.stringify(unlocked).slice(0, 240))
  assert.equal(unlocked.unlocked, true)
  assert.equal((await ask(web.ws, { type: 'sessions' })).kind, 'sessions', 'the asserting socket is served')

  // Close, and open a NEW socket with the same credential: it starts locked (a reload re-asserts).
  web.ws.close()
  const again = open(instance, ['dsh-mobile-v1'], { Authorization: 'Bearer ' + web.token, 'X-DSH-Device-ID': 'wl-unlock-01' })
  record(again)
  await once(again, 'open')
  const hello = await take(again, (frame) => frame.kind === 'hello')
  await negotiate(again)
  assert.equal(hello.webLock, 'locked', 'a passkey exists, so the new socket is locked: ' + JSON.stringify(hello).slice(0, 200))
  assert.equal((await ask(again, { type: 'sessions' })).code, 'auth/locked')

  // The assertion is the only way in, and it unlocks ONLY this socket.
  const reopened = await assertPasskey(instance, again, instance.origin, rpId, authenticator)
  assert.equal(reopened.unlocked, true, JSON.stringify(reopened).slice(0, 240))
  const after = await ask(again, { type: 'sessions' })
  assert.equal(after.kind, 'sessions', 'an unlocked socket is served: ' + JSON.stringify(after).slice(0, 200))
  again.terminate()
})

// ===========================================================================
// (2) A wrong assertion keeps the socket locked, and reveals nothing
// ===========================================================================

test('WL-3 a forged assertion (wrong signature, wrong origin, wrong rpId, UV=0) stays locked with no detail', async (t) => {
  const instance = await factory(t)
  const web = await pairDevice(instance, 'wl-forge-01', { kind: 'mobile', scopes: WEB_SCOPES })
  const rpId = new URL(instance.origin).hostname
  const authenticator = await registerPasskey(instance, web.ws, instance.origin, rpId)
  web.ws.close()

  const again = open(instance, ['dsh-mobile-v1'], { Authorization: 'Bearer ' + web.token, 'X-DSH-Device-ID': 'wl-forge-01' })
  record(again)
  await once(again, 'open')
  await take(again, (frame) => frame.kind === 'hello')
  await negotiate(again)

  const foreign = es256Authenticator(1) // a DIFFERENT key: its signature cannot verify
  const cases = [
    ['a foreign key', foreign, {}],
    ['a wrong origin', authenticator, { origin: 'https://evil.example.test' }],
    ['a wrong rpId', authenticator, { rpId: 'evil.example.test' }],
    ['UV=0', authenticator, { flags: 0x01 }],
    ['UP=0', authenticator, { flags: 0x04 }],
  ]
  for (const [label, key, options] of cases) {
    const reply = await assertPasskey(instance, again, instance.origin, rpId, key, options)
    assert.equal(reply.kind, 'error', `${label} must be refused: ${JSON.stringify(reply).slice(0, 240)}`)
    assert.equal(reply.code, 'passkey/verification-failed', `${label} → ${reply.code}`)
    // The refusal names no check and carries no field beyond code/requestType/requestId/message.
    for (const field of ['challenge', 'origin', 'rpId', 'signature', 'credentialId', 'reason']) {
      assert.equal(Object.hasOwn(reply, field), false, `${label}: the refusal must not carry ${field}`)
    }
    assert.equal(String(reply.message).includes('challenge'), false)
  }
  // Still locked after every failure: a refusal never opens the surface.
  assert.equal((await ask(again, { type: 'sessions' })).code, 'auth/locked')
  again.terminate()
})

test('WL-4 a replayed challenge is refused once it has been used (single use, bound to the socket)', async (t) => {
  const instance = await factory(t)
  const web = await pairDevice(instance, 'wl-replay-01', { kind: 'mobile', scopes: WEB_SCOPES })
  const rpId = new URL(instance.origin).hostname
  const authenticator = await registerPasskey(instance, web.ws, instance.origin, rpId)
  web.ws.close()

  const again = open(instance, ['dsh-mobile-v1'], { Authorization: 'Bearer ' + web.token, 'X-DSH-Device-ID': 'wl-replay-01' })
  record(again)
  await once(again, 'open')
  await take(again, (frame) => frame.kind === 'hello')
  await negotiate(again)

  const options = await ask(again, { type: 'passkey-assert-options' })
  assert.equal(options.kind, 'passkey-assert-options')
  // The genuine answer, once: it consumes the challenge.
  const first = await ask(again, { type: 'passkey-assert', assertion: authenticator.assertion(options.challenge, { origin: instance.origin, rpId }) })
  assert.equal(first.unlocked, true, JSON.stringify(first).slice(0, 200))
  // The SAME answer again: the challenge is gone, so it is refused (never re-served).
  const replay = await ask(again, { type: 'passkey-assert', assertion: authenticator.assertion(options.challenge, { origin: instance.origin, rpId }) })
  assert.equal(replay.kind, 'error', JSON.stringify(replay).slice(0, 200))
  assert.equal(replay.code, 'passkey/challenge-expired', 'a used challenge is expired, not re-verifiable')
  again.terminate()
})

// ===========================================================================
// (3) The lock covers every family, including the ones dispatched before the scope gate
// ===========================================================================

test('WL-5 a locked desktop device cannot reach the bridge, the upload or the browser family around the gate', async (t) => {
  const instance = await factory(t)
  // A desktop holding web:unlock TOGETHER with the bridge, upload and browser scopes, so each of
  // those families would otherwise be authorized: only the LOCK stands between it and the Host.
  const web = await pairDevice(instance, 'wl-families-01', {
    kind: 'desktop',
    scopes: [...WEB_SCOPES, 'harness:remote', 'attachments:write', 'browser:control'],
  })
  const since = instance.hostCalls.length
  const probes = [
    { type: 'remote-call', endpoint: 'session/list', args: {} },
    { type: 'remote-stream-open', streamId: 's-1', endpoint: 'session/control', args: {} },
    { type: 'remote-upload-open', sessionId: 's1', name: 'a.png', size: 4, sha256: '0'.repeat(64) },
    { type: 'browser-result', commandId: 'c-1', ok: true },
    // A companion op the device IS scoped for (sessions:read), so the lock is the only refusal.
    { type: 'sessions' },
  ]
  for (const probe of probes) {
    const reply = await ask(web.ws, probe)
    assert.equal(reply.kind, 'error', `${probe.type} must be refused: ${JSON.stringify(reply).slice(0, 200)}`)
    assert.equal(reply.code, 'auth/locked', `${probe.type} must be LOCKED (not a scope/op refusal), got ${reply.code}`)
  }
  // A family whose SCOPE this device lacks is answered by the scope gate, which by design runs
  // before the lock gate — the contract keeps scope and lock refusals distinct, and a device with
  // no `sessions:author` learns nothing more from the lock than from the scope.
  const authoring = await ask(web.ws, { type: 'session-create' })
  assert.equal(authoring.code, 'auth/forbidden-scope', 'a missing scope is reported as a scope refusal')
  assert.equal(authoring.scope, 'sessions:author')

  assert.deepEqual(instance.hostCalls.slice(since), [], 'a locked device reaches nothing on the Host through any family')
  web.ws.terminate()
})

// ===========================================================================
// (4) Re-lock: close, 15 min idle, the explicit lock frame
// ===========================================================================

test('WL-6 `passkey-lock` re-locks the socket in any lock state, and a reloaded locked socket can still say so', async (t) => {
  const instance = await factory(t)
  const web = await pairDevice(instance, 'wl-lock-01', { kind: 'mobile', scopes: WEB_SCOPES })
  const rpId = new URL(instance.origin).hostname
  const authenticator = await registerPasskey(instance, web.ws, instance.origin, rpId)
  // A registration does not open the socket; the assertion does.
  assert.equal((await assertPasskey(instance, web.ws, instance.origin, rpId, authenticator)).unlocked, true)
  assert.equal((await ask(web.ws, { type: 'sessions' })).kind, 'sessions', 'unlocked first')

  // The PWA's "Lock now" (contract §14.2): the answer is exactly the frame the app waits for.
  const locked = await ask(web.ws, { type: 'passkey-lock' })
  assert.equal(locked.kind, 'passkey-lock', JSON.stringify(locked).slice(0, 200))
  assert.equal(locked.locked, true)
  assert.equal((await ask(web.ws, { type: 'sessions' })).code, 'auth/locked', 'the lock took effect at once')

  // Accepted again while ALREADY locked: a tab that reloaded into a locked socket can say so.
  const repeated = await ask(web.ws, { type: 'passkey-lock' })
  assert.equal(repeated.kind, 'passkey-lock')
  assert.equal(repeated.locked, true)

  // And the socket can unlock again afterwards (the lock is not a one-way door on a live socket).
  const reopened = await assertPasskey(instance, web.ws, instance.origin, rpId, authenticator)
  assert.equal(reopened.unlocked, true, JSON.stringify(reopened).slice(0, 200))
  assert.equal((await ask(web.ws, { type: 'sessions' })).kind, 'sessions')
  web.ws.close()
})

test('WL-7 closing the socket is a lock: the next connection must assert again, and its old challenge is gone', async (t) => {
  const instance = await factory(t)
  const web = await pairDevice(instance, 'wl-close-01', { kind: 'mobile', scopes: WEB_SCOPES })
  const rpId = new URL(instance.origin).hostname
  const authenticator = await registerPasskey(instance, web.ws, instance.origin, rpId)
  const options = await ask(web.ws, { type: 'passkey-assert-options' })
  const challenge = options.challenge
  web.ws.close()
  await delay(100)

  const again = open(instance, ['dsh-mobile-v1'], { Authorization: 'Bearer ' + web.token, 'X-DSH-Device-ID': 'wl-close-01' })
  record(again)
  await once(again, 'open')
  const hello = await take(again, (frame) => frame.kind === 'hello')
  await negotiate(again)
  assert.equal(hello.webLock, 'locked')
  // The previous socket's challenge does not work here: it was bound to that socket, not the device.
  const stale = await ask(again, { type: 'passkey-assert', assertion: authenticator.assertion(challenge, { origin: instance.origin, rpId }) })
  assert.equal(stale.kind, 'error', JSON.stringify(stale).slice(0, 200))
  assert.equal(stale.code, 'passkey/challenge-expired')
  again.terminate()
})

// ===========================================================================
// (5) Revocation deletes the record and closes the socket 4401
// ===========================================================================

test('WL-8 revoking the device deletes its passkey record and closes its sockets 4401', (t) => {
  // Deliberately NOT a socket test: revocation is driven by the owner route, and the close code
  // is what the PWA keys on. Asserted through the store the gateway itself reads back.
  return factory(t).then(async (instance) => {
    const web = await pairDevice(instance, 'wl-revoke-01', { kind: 'mobile', scopes: WEB_SCOPES })
    const rpId = new URL(instance.origin).hostname
    await registerPasskey(instance, web.ws, instance.origin, rpId)
    const storeFile = path.join(instance.directory, 'mobile-gateway-passkeys.json')
    assert.equal(fs.existsSync(storeFile), true, 'the passkey store exists after a registration: ' + fs.readdirSync(instance.directory).join(','))
    assert.equal(JSON.parse(fs.readFileSync(storeFile, 'utf8')).records.length, 1)

    const closed = new Promise((resolve) => web.ws.once('close', (code) => resolve(code)))
    const revoked = await instance.post('devices/' + encodeURIComponent(web.device.id) + '/revoke', {})
    assert.equal(revoked.status, 200, JSON.stringify(revoked.data))
    assert.equal(await Promise.race([closed, delay(4_000).then(() => 'still-open')]), 4401,
      'a revoked device is closed with 4401 so the PWA wipes its credential')
    // The record is gone: a re-paired device must register again (never inherit the old key).
    assert.deepEqual(JSON.parse(fs.readFileSync(storeFile, 'utf8')).records, [])
  })
})

// ===========================================================================
// (6) Rate limits
// ===========================================================================

test('WL-9 five failed assertions lock the device out, and the request path reports rate-limited', async (t) => {
  const instance = await factory(t)
  const web = await pairDevice(instance, 'wl-rate-01', { kind: 'mobile', scopes: WEB_SCOPES })
  const rpId = new URL(instance.origin).hostname
  // Register, then ASSERT on this same socket, so the limit is the only thing that can refuse
  // it: a socket that was never unlocked would report the plain lock and prove nothing.
  const authenticator = await registerPasskey(instance, web.ws, instance.origin, rpId)
  assert.equal((await assertPasskey(instance, web.ws, instance.origin, rpId, authenticator)).unlocked, true)
  assert.equal((await ask(web.ws, { type: 'sessions' })).kind, 'sessions', 'unlocked before the failures')

  // Five FAILED assertions on the same live socket (the contract's per-device window).
  const foreign = es256Authenticator(1)
  for (let attempt = 0; attempt < 5; attempt += 1) {
    const answer = await ask(web.ws, { type: 'passkey-assert-options' })
    assert.equal(answer.kind, 'passkey-assert-options', `attempt ${attempt + 1} still gets options: ${JSON.stringify(answer).slice(0, 200)}`)
    const reply = await ask(web.ws, {
      type: 'passkey-assert',
      assertion: foreign.assertion(answer.challenge, { origin: instance.origin, rpId }),
    })
    assert.equal(reply.code, 'passkey/verification-failed', `attempt ${attempt + 1} → ${reply.code}`)
  }
  // Locked out: even OPTIONS is refused, so no challenge is issued to a limited device.
  const options = await ask(web.ws, { type: 'passkey-assert-options' })
  assert.equal(options.kind, 'error', JSON.stringify(options).slice(0, 200))
  assert.equal(options.code, 'passkey/rate-limited')
  // The request path reports the SAME state — and `rate-limited` wins over `locked`, because a
  // fresh assertion would not help: the socket is still over its budget (§14.5).
  const blocked = await ask(web.ws, { type: 'sessions' })
  assert.equal(blocked.code, 'auth/locked')
  assert.equal(blocked.reason, 'rate-limited', JSON.stringify(blocked).slice(0, 200))
  // The genuine key cannot get in either while the window holds.
  const genuine = await ask(web.ws, { type: 'passkey-assert-options' })
  assert.equal(genuine.code, 'passkey/rate-limited')
  void authenticator

  // Another device is untouched: the limit is per device, and it keeps its own lock state.
  const other = await pairDevice(instance, 'wl-rate-02', { kind: 'mobile', scopes: WEB_SCOPES })
  const otherReply = await ask(other.ws, { type: 'sessions' })
  assert.equal(otherReply.code, 'auth/locked')
  assert.equal(otherReply.reason, 'unregistered', 'the second device has its own state, not the first one\'s limit')

  // A phone without web:unlock never sees a lock at all, whatever the web device did.
  const phone = await pairDevice(instance, 'wl-rate-03', { kind: 'mobile', scopes: PHONE_SCOPES })
  assert.equal((await ask(phone.ws, { type: 'sessions' })).kind, 'sessions')
  phone.ws.close()
  other.ws.terminate()
  web.ws.terminate()
})

// ===========================================================================
// (7) Re-registration approval (contract §14.3) — the contracted frame, and its effect
// ===========================================================================

test('WL-10 the owner decision is the contracted `passkey-approval` frame; a reject re-locks the asking socket', async (t) => {
  const instance = await factory(t)
  const web = await pairDevice(instance, 'wl-approve-01', { kind: 'mobile', scopes: WEB_SCOPES })
  const rpId = new URL(instance.origin).hostname
  const first = await registerPasskey(instance, web.ws, instance.origin, rpId)
  assert.equal((await assertPasskey(instance, web.ws, instance.origin, rpId, first)).unlocked, true)
  assert.equal((await ask(web.ws, { type: 'sessions' })).kind, 'sessions', 'unlocked before the replacement')

  // A second registration on a device that already has one: refused, and an owner approval
  // is raised. The gateway does not decide; the Host does.
  const replacement = es256Authenticator(1)
  const options = await ask(web.ws, { type: 'passkey-register-options' })
  const refused = await ask(web.ws, { type: 'passkey-register', attestation: replacement.registration(options.challenge, { origin: instance.origin, rpId }) })
  assert.equal(refused.code, 'passkey/already-registered', JSON.stringify(refused).slice(0, 240))
  const pending = (await instance.pending()).pending.filter((request) => request.kind === 'passkey')
  assert.equal(pending.length, 1, JSON.stringify(await instance.pending()).slice(0, 300))
  assert.equal(pending[0].verificationCode.length, 8)
  // The refusal did not touch the unlock: failing to REPLACE is not a failed proof.
  assert.equal((await ask(web.ws, { type: 'sessions' })).kind, 'sessions')

  // Reject: the asking socket is LOCKED again and the answer is the contracted frame.
  const rejected = await instance.post(`pending/${encodeURIComponent(pending[0].id)}/reject`, {})
  assert.equal(rejected.status, 200, JSON.stringify(rejected.data))
  const notice = await take(web.ws, (frame) => frame.kind === 'passkey-approval')
  assert.equal(notice.approvalId, pending[0].id, 'the frame names the approval the owner decided')
  assert.equal(notice.action, 'reject', JSON.stringify(notice).slice(0, 240))
  assert.equal(notice.verificationCode, pending[0].verificationCode, 'the owner and the device compare the same code')
  assert.equal(Object.hasOwn(notice, 'approved'), false, 'the invented `approved` field is gone')
  const afterReject = await ask(web.ws, { type: 'sessions' })
  assert.equal(afterReject.code, 'auth/locked', JSON.stringify(afterReject).slice(0, 200))
  assert.equal(afterReject.reason, 'locked', 'the reject re-locked the socket that asked')
  // The old passkey still works: a reject only refuses the REPLACEMENT.
  const stillValid = await assertPasskey(instance, web.ws, instance.origin, rpId, first)
  assert.equal(stillValid.unlocked, true, JSON.stringify(stillValid).slice(0, 200))

  // Approve a second attempt: the frame says so and the socket may now re-register.
  const options2 = await ask(web.ws, { type: 'passkey-register-options' })
  assert.equal((await ask(web.ws, { type: 'passkey-register', attestation: replacement.registration(options2.challenge, { origin: instance.origin, rpId }) })).code,
    'passkey/already-registered')
  const pending2 = (await instance.pending()).pending.filter((request) => request.kind === 'passkey')
  assert.equal(pending2.length, 1)
  const approved = await instance.post(`pending/${encodeURIComponent(pending2[0].id)}/approve`, {})
  assert.equal(approved.status, 200, JSON.stringify(approved.data))
  assert.equal(approved.data.verificationCode, pending2[0].verificationCode)
  const granted = await take(web.ws, (frame) => frame.kind === 'passkey-approval' && frame.approvalId === pending2[0].id)
  assert.equal(granted.action, 'approve', JSON.stringify(granted).slice(0, 240))
  assert.equal(granted.verificationCode, pending2[0].verificationCode)
  const options3 = await ask(web.ws, { type: 'passkey-register-options' })
  const replaced = await ask(web.ws, { type: 'passkey-register', attestation: replacement.registration(options3.challenge, { origin: instance.origin, rpId }) })
  assert.equal(replaced.ok, true, JSON.stringify(replaced).slice(0, 240))
  // A replacement is not an unlock either: the new key must be asserted.
  assert.equal((await ask(web.ws, { type: 'sessions' })).code, 'auth/locked')
  assert.equal((await assertPasskey(instance, web.ws, instance.origin, rpId, replacement)).unlocked, true)
  assert.equal((await ask(web.ws, { type: 'sessions' })).kind, 'sessions', 'the replacement key opens the socket')
  // The OLD key no longer does.
  assert.equal((await assertPasskey(instance, web.ws, instance.origin, rpId, first)).code, 'passkey/verification-failed')
  web.ws.terminate()
})

// ===========================================================================
// (8) The pending routes are not satisfiable by a DNS-rebinding page
// ===========================================================================

test('WL-11 the pending routes refuse a non-loopback Host/Origin pair even from a loopback peer', async (t) => {
  const instance = await factory(t)
  const web = await pairDevice(instance, 'wl-pending-01', { kind: 'mobile', scopes: WEB_SCOPES })
  const rpId = new URL(instance.origin).hostname
  await registerPasskey(instance, web.ws, instance.origin, rpId)
  const options = await ask(web.ws, { type: 'passkey-register-options' })
  await ask(web.ws, { type: 'passkey-register', attestation: es256Authenticator(1).registration(options.challenge, { origin: instance.origin, rpId }) })
  const [request] = (await instance.pending()).pending.filter((entry) => entry.kind === 'passkey')
  assert.ok(request, 'a pending approval exists to protect')

  // A rebound page reaches 127.0.0.1 with a Host AND Origin it controls: they agree with each
  // other, so `isSameOrigin` passes, and the peer really is loopback.
  const url = new URL(`${instance.base}/mgw/pending`)
  const call = (method, path, headers) => new Promise((resolve, reject) => {
    const req = http.request({ host: url.hostname, port: url.port, path, method, headers }, (res) => {
      let text = ''
      res.on('data', (chunk) => { text += chunk })
      res.on('end', () => resolve({ status: res.statusCode, text }))
    })
    req.on('error', reject)
    req.end(method === 'POST' ? '{}' : undefined)
  })
  for (const attacker of ['attacker.example', 'attacker.example:80']) {
    const origin = `http://${attacker}`
    const read = await call('GET', '/mgw/pending', { Host: attacker, Origin: origin })
    assert.equal(read.status, 403, `GET /mgw/pending with Host=${attacker} must be refused, got ${read.status}`)
    // The refusal must not leak a pairing name or a verification code.
    assert.equal(read.text.includes(request.verificationCode), false)
    const decided = await call('POST', `/mgw/pending/${encodeURIComponent(request.id)}/approve`, {
      Host: attacker, Origin: origin, 'Content-Type': 'application/json', 'Content-Length': 2,
    })
    assert.equal(decided.status, 403, `POST approve with Host=${attacker} must be refused, got ${decided.status}`)
  }
  // Nothing was decided by any refused attempt: the approval is still pending.
  assert.equal((await instance.pending()).pending.filter((entry) => entry.kind === 'passkey').length, 1)
  // The canonical loopback authority still works.
  assert.equal((await instance.pending()).pending.length >= 1, true)
  web.ws.terminate()
})

// ===========================================================================
// (9) The idle re-lock, measured from the last frame
// ===========================================================================

test('WL-12 active traffic extends the unlock; a frame after real idle finds the socket locked', async (t) => {
  // The idle bound is 15 minutes in production; this instance shortens it through the test-only
  // option so a live socket can actually idle out.
  const idleMs = 600
  const instance = await factory(t, { testWebUnlockIdleMs: idleMs })
  const web = await pairDevice(instance, 'wl-idle-01', { kind: 'mobile', scopes: WEB_SCOPES })
  const rpId = new URL(instance.origin).hostname
  const authenticator = await registerPasskey(instance, web.ws, instance.origin, rpId)
  assert.equal((await assertPasskey(instance, web.ws, instance.origin, rpId, authenticator)).unlocked, true)

  // Traffic every third of the bound keeps the socket unlocked past 2× the bound, which it would
  // not survive without `touch()`: the clock is measured from the LAST frame.
  for (let round = 0; round < 6; round += 1) {
    await delay(Math.floor(idleMs / 3))
    assert.equal((await ask(web.ws, { type: 'sessions' })).kind, 'sessions', `round ${round + 1} is still unlocked`)
  }

  // Now genuinely idle: past the bound, the very next frame is refused — and it must NOT have
  // refreshed the unlock first (the reviewer's finding: check the idle expiry BEFORE touching).
  await delay(idleMs + 150)
  const refusals = []
  for (let attempt = 0; attempt < 3; attempt += 1) {
    const reply = await ask(web.ws, { type: 'sessions' })
    refusals.push(reply)
    await delay(30)
  }
  for (const reply of refusals) {
    assert.equal(reply.kind, 'error', `an idle socket must stay locked, got ${JSON.stringify(reply).slice(0, 200)}`)
    assert.equal(reply.code, 'auth/locked')
    assert.equal(reply.reason, 'locked')
  }
  // A new assertion is the only way back in.
  assert.equal((await assertPasskey(instance, web.ws, instance.origin, rpId, authenticator)).unlocked, true)
  assert.equal((await ask(web.ws, { type: 'sessions' })).kind, 'sessions')
  web.ws.terminate()
})

// ===========================================================================
// (10) An approved pending socket keeps the BROWSER's Origin, not the approver's
// ===========================================================================

// A pending pairing socket is created by the BROWSER's WebSocket upgrade and promoted by a
// completely different request: the Host's `POST /mgw/pending/:id/approve` on the management
// route. Reading `req.headers.origin` at promotion took the OWNER PAGE's origin (and, in a
// rebound-proof deployment, no origin at all), so the passkey site was the wrong origin and no
// ceremony could ever succeed on the socket the owner had just approved.
test('WL-13 an approved pending pairing keeps the browser upgrade Origin, never the management POST Origin', async (t) => {
  const instance = await factory(t)
  // Two distinct origins by construction: the passkey site is the TLS listener the page runs on,
  // the approval arrives on the plaintext loopback management route.
  const browserOrigin = instance.origin
  assert.notEqual(browserOrigin, instance.base, 'the fixture must present two different origins')
  const rpId = new URL(browserOrigin).hostname

  // An OTP offer granting `web:unlock`, so the socket that comes out of approval is a web device.
  const offer = await instance.post('pair', { mode: 'otp', kind: 'mobile', scopes: WEB_SCOPES })
  assert.equal(offer.status, 201, JSON.stringify(offer.data))
  const ws = instance.track(new WebSocket(instance.lanUrl, ['dsh-mobile-v1', 'dsh-pair-otp.v1'], {
    headers: { 'X-DSH-Device-ID': 'wl-origin-01', 'X-DSH-Device-Name': Buffer.from('Web tab').toString('base64') },
    origin: browserOrigin, rejectUnauthorized: false,
  }))
  const seen = record(ws)
  await once(ws, 'open')
  const challenge = await take(ws, (frame) => frame.kind === 'pairing-challenge')
  const clientNonce = crypto.randomBytes(18).toString('base64url')
  ws.send(JSON.stringify({
    type: 'pairing-proof', clientNonce,
    otpProof: otpProof(offer.data.otp, instance.lanPin, clientNonce, challenge.serverNonce),
  }))
  await take(ws, (frame) => frame.kind === 'pairing-pending')

  // The Host approves from the management page. That POST carries the MANAGEMENT origin; the
  // promoted socket must not adopt it.
  const [request] = (await instance.pending()).pending
  assert.ok(request, 'the OTP proof raised a pending request')
  const approved = await instance.post(`pending/${encodeURIComponent(request.id)}/approve`, {})
  assert.equal(approved.status, 200, JSON.stringify(approved.data))
  await take(ws, (frame) => frame.kind === 'paired')
  const hello = await take(ws, (frame) => frame.kind === 'hello')
  assert.equal(hello.webLock, 'unregistered', JSON.stringify(hello).slice(0, 240))
  await negotiate(ws)

  // The promoted socket's passkey site is the BROWSER's origin, so the ceremony the page runs is
  // accepted. Under the defect this is refused `passkey/verification-failed`: the management
  // origin is not (and must never need to be) a member of `allowedOrigins`.
  const authenticator = await registerPasskey(instance, ws, browserOrigin, rpId)
  assert.equal((await assertPasskey(instance, ws, browserOrigin, rpId, authenticator)).unlocked, true)
  assert.equal((await ask(ws, { type: 'sessions' })).kind, 'sessions', 'the promoted web socket works once unlocked')
  assert.equal(seen.some((frame) => frame.code === 'passkey/verification-failed'), false,
    'the promoted socket never rejected the browser origin it actually ran on')
  ws.terminate()
})
