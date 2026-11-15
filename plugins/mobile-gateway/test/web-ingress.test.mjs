// Spec 031, step 2 (GATEWAY scope): the loopback web (Serve) ingress.
//
// What this suite pins (design-review matrix):
//  1. origin policy: exactly one canonical https://<label>.ts.net origin, never normalised from
//     another spelling; the tuple persists as ONE value with `enabled` defaulting to false;
//     a port collision with the direct listener is refused transactionally (409) and nothing
//     moves; a busy port reports the error and never claims a listener.
//  2. the web ingress requirement matrix: a missing / null / foreign Origin is refused before any
//     credential is read; a spoofed `Forwarded`/`X-Real-IP` from a caller grants nothing, while
//     Serve's own `x-forwarded-for` is not a refusal.
//  3. the admin fence: no static/admin/DSH route, and `/mgw` answers 404 on that port.
//  4. lifecycle: a direct rebind never strands the web ingress and a web disable leaves the direct
//     listener intact; the global switch-off gates both and the switch-on restores the ingress on a
//     FRESH listener whose sockets are the only ones that pass the liveness checks (activation,
//     approval, passkeys); a request whose ingress was disabled or replaced while deciding is
//     refused at approval time.
//  5. the existing native/desktop path is unchanged: the v3 payload still pins the gateway leaf
//     and never names the Serve origin, and a client that pins a different certificate fails
//     before any credential is sent.
//
// Every listener here is 127.0.0.1 on an ephemeral or test-chosen port in this process.
import assert from 'node:assert/strict'
import crypto from 'node:crypto'
import fs from 'node:fs'
import http from 'node:http'
import https from 'node:https'
import os from 'node:os'
import path from 'node:path'
import tls from 'node:tls'
import WebSocket from 'ws'
import plugin from '../lib/index.mjs'
import { createGatewayState } from '../lib/gateway-state.mjs'
import { listenFetchSafe } from './support/fetch-safe-listen.mjs'
import { createTestConnection, createTestRemoteAccess } from './helpers/peer.mjs'
import { WEB_WS_PATH, normalizeWebOrigin, planWebIngress, readWebIngress, webIngressStatus, webOriginAccepted } from '../lib/web-ingress.mjs'
import { PasskeyRefusal, createPasskeyService } from '../lib/passkey.mjs'
import { otpProof } from '../lib/pairing-requests.mjs'

const delay = (ms) => new Promise((resolve) => setTimeout(resolve, ms))
const ORIGIN = 'https://dsh-owner.tail1234.ts.net'
/** Contract §6 `CLOSE_CODES.revoked` (4401): how a socket whose ingress was invalidated closes. */
const CLOSE_REAUTH = 4401
const temp = fs.mkdtempSync(path.join(os.tmpdir(), 'dsh-web-ingress-'))
const failures = []
const passed = (label) => console.log(`PASS: ${label}`)
const failed = (label, error) => { failures.push({ label, error }); console.error(`FAIL: ${label}\n${error?.stack ?? error}`) }
let checks = 0
const check = async (label, body) => { checks += 1; try { await body(); passed(label) } catch (error) { failed(label, error) } }

const quiet = !process.env.WEB_INGRESS_DEBUG
const realLog = console.log
console.log = (message, ...rest) => {
  if (!quiet || (typeof message === 'string' && (message.startsWith('PASS') || message.startsWith('DEBUG')))) realLog(message, ...rest)
}
// A deterministic summary that does not depend on the console override or a redirection: the
// run counts its `check` calls (one module-level section runs without `check` and would abort the
// whole suite on failure), and this line names how many checks ran, how many passed, and the exit code.
process.on('exit', (code) => {
  process.stdout.write(`  [summary] ${checks - failures.length}/${checks} checks passed, ${failures.length} failed (exit ${code})\n`)
})

/** A real listening port nobody else uses: bind 0, read it, close. The probe is TCP-only:
 *  a bare server never answers the helper's fetch probe, and `server.close()` would then wait on
 *  that keep-alive socket forever. */
async function freePort() {
  const server = http.createServer()
  await listenFetchSafe(server, { probe: 'tcp' })
  const port = server.address().port
  await new Promise((resolve) => server.close(resolve))
  return port
}

async function startGateway(name, overrides = {}) {
  let management
  let upgrade
  let dispose = () => {}
  const state = { activationHold: null, gate2: null }
  const server = http.createServer((req, res) => {
    if (management) management.handler(req, res)
    else res.writeHead(404).end()
  })
  server.on('upgrade', (req, socket, head) => {
    if (upgrade) upgrade.handler(req, socket, head)
    else socket.destroy()
  })
  await listenFetchSafe(server)
  const port = server.address().port
  const config = {
    deviceFile: path.join(temp, `${name}-devices.json`),
    gatewayName: name,
    gatewayWaitTimeoutMs: 60_000,
    adminLoopbackOnly: true,
    pairingTtlMs: 60_000,
    lanEnabled: true,
    // OTP + owner approval is what the web ingress is for; the direct path uses the same flow.
    requireHostApproval: true,
    lanHost: '127.0.0.1',
    lanPort: 0,
    remoteControl: { enabled: true },
    gatewayMode: 'persistent',
    // The seam is sealed into the instance only as an APPLY argument (never from the config
    // spread), and it reads the mutable holder, so one instance can hold one activation.
    testActivationHold: (details) => state.activationHold?.(details),
    ...overrides,
  }
  const ctx = {
    webServer: {
      port,
      register(route) { management = route; return () => { management = undefined } },
      registerUpgrade(route) { upgrade = route; return () => { upgrade = undefined } },
    },
    connection: createTestConnection(),
    remoteAccess: createTestRemoteAccess(),
    typertGateway: {
      async invoke(request) {
        // The request hold of the duplicate-in-flight regression (`instance.state.gate2` holds
        // the first session/list at the Host; its `release` answers it once).
        if (request.namespace === 'session' && request.method === 'list') {
          const gate = state.gate2
          if (gate && typeof gate.release === 'function') {
            return await new Promise((resolve) => {
              gate.started = true
              gate.release = () => resolve({ items: [{ sessionId: 's1' }] })
            })
          }
          return { items: [{ sessionId: 's1' }] }
        }
        throw new Error(`unexpected invoke ${request.namespace}/${request.method}`)
      },
      async stream(request) {
        return (async function* () {
          yield { type: 'baseline', value: request.namespace === 'workspace'
            ? { items: [], archivedSessionIds: [] } : { projections: {} } }
          while (!request.signal.aborted) await delay(5)
        })()
      },
    },
    agentDefaultModel: {},
    on() { return () => {} },
    effect(factory) { dispose = factory() },
  }
  await plugin.apply(ctx, config)
  const base = `http://127.0.0.1:${port}`
  const instance = {
    port,
    base,
    config,
    state,
    stateFile: config.gatewayStateFile ?? `${config.deviceFile}.gateway.json`,
    async status() { return (await (await fetch(`${base}/mgw/status`)).json()) },
    async get(route) {
      const response = await fetch(`${base}/mgw/${route}`, { headers: { Origin: base } })
      return { status: response.status, data: await response.json() }
    },
    async post(route, body, { origin = base } = {}) {
      const response = await fetch(`${base}/mgw/${route}`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', ...(origin ? { Origin: origin } : {}) },
        body: JSON.stringify(body ?? {}),
      })
      return { status: response.status, data: await response.json() }
    },
    async waitForLan() {
      for (let attempt = 0; attempt < 200; attempt += 1) {
        const status = await instance.status()
        if (status.lan?.listening && status.lan.urls.length > 0) return status
        if (status.lan?.error) throw new Error(`direct listener failed: ${status.lan.error}`)
        await delay(20)
      }
      throw new Error('direct listener did not become ready')
    },
    async close() {
      dispose()
      await new Promise((resolve) => server.close(resolve))
    },
  }
  return instance
}

async function statusUntil(instance, predicate, label) {
  for (let attempt = 0; attempt < 300; attempt += 1) {
    const status = await instance.status()
    if (predicate(status)) return status
    await delay(20)
  }
  throw new Error(`timeout waiting for ${label}: ${JSON.stringify((await instance.status()).webIngress)}`)
}

/**
 * A WebSocket upgrade against a TLS port with explicit headers, over a raw TLS socket so a
 * header a real browser cannot send is still testable. Resolves with the open socket and the
 * first chunk once the server speaks a frame; rejects with `{status}` (an HTTP refusal),
 * `{reset}` or `{timeout}` (a silent close / no answer) — those answers are different on purpose.
 */
function webUpgrade({ port, headers = {}, protocols = [], pathName = '/ws/mobile' }) {
  return new Promise((resolve, reject) => {
    const socket = tls.connect({ host: '127.0.0.1', port, rejectUnauthorized: false })
    const timer = setTimeout(() => { socket.destroy(); reject(Object.assign(new Error('timeout'), { timeout: true })) }, 4000)
    const settle = (fn, value) => { clearTimeout(timer); fn(value) }
    socket.once('secureConnect', () => {
      const lines = [`GET ${pathName} HTTP/1.1`, 'Host: 127.0.0.1', 'Connection: Upgrade', 'Upgrade: websocket',
        'Sec-WebSocket-Version: 13', `Sec-WebSocket-Key: ${crypto.randomBytes(16).toString('base64')}`, 'X-DSH-Device-ID: web-device-1']
      for (const [name, value] of Object.entries(headers)) lines.push(`${name}: ${value}`)
      if (protocols.length > 0) lines.push(`Sec-WebSocket-Protocol: ${protocols.join(', ')}`)
      socket.write(`${lines.join('\r\n')}\r\n\r\n`)
    })
    socket.once('error', (error) => settle(reject, Object.assign(error, { reset: true })))
    socket.on('close', () => settle(reject, Object.assign(new Error('closed without a frame'), { reset: true })))
    socket.once('data', (chunk) => {
      const text = chunk.toString('latin1')
      const statusMatch = /^HTTP\/1\.1 (\d{3})/.exec(text)
      if (statusMatch) { socket.destroy(); settle(reject, Object.assign(new Error(`HTTP ${statusMatch[1]}`), { status: Number(statusMatch[1]) })); return }
      settle(resolve, { socket, data: chunk })
    })
  })
}

/** Frame reader for a ws socket (the pairing state machine answers with ordered frames). */
function framesOf(ws) {
  const frames = []
  const waiters = []
  ws.on('message', (data) => {
    const frame = JSON.parse(data.toString())
    frames.push(frame)
    for (const waiter of [...waiters]) {
      if (!waiter.match(frame)) continue
      waiters.splice(waiters.indexOf(waiter), 1)
      waiter.finish(frame)
    }
  })
  return {
    frames,
    next(match, timeoutMs = 4000) {
      const found = frames.find(match)
      if (found !== undefined) return Promise.resolve(found)
      return new Promise((resolve, reject) => {
        const entry = { match, finish: (frame) => { clearTimeout(timer); resolve(frame) } }
        const timer = setTimeout(() => {
          waiters.splice(waiters.indexOf(entry), 1)
          reject(new Error('frame timeout'))
        }, timeoutMs)
        waiters.push(entry)
      })
    },
  }
}
/**
 * A passkey-ceremony driver over an ALREADY negotiated frame stream, and a helper that pairs a
 * `web:unlock` device with OTP + owner approval on a chosen endpoint (web ingress or direct).
 */
async function passkeyCeremony(stream, origin, rpId) {
  const authenticator = es256Authenticator(1)
  const options = await ask(stream, { type: 'passkey-register-options' })
  let registered = null
  if (options.kind === 'passkey-register-options') {
    assert.equal(options.rp.id, rpId)
    registered = await ask(stream, {
      type: 'passkey-register',
      attestation: authenticator.registration(options.challenge, { origin, rpId }),
    })
  }
  const assertOptions = await ask(stream, { type: 'passkey-assert-options' })
  let asserted = null
  if (assertOptions.kind === 'passkey-assert-options') {
    asserted = await ask(stream, {
      type: 'passkey-assert',
      assertion: authenticator.assertion(assertOptions.challenge, { origin, rpId }),
    })
  }
  return { authenticator, registerOptions: options, registered, assertOptions, asserted }
}

/** Open the OTP flow on `endpoint`, prove it, and take the owner's approval through /mgw/pending.
 *  The socket is negotiated, so an authorized request may run on it. */
async function approveOtp(instance, endpoint, { origin, protocols, deviceId, scopes = WEB_SCOPES, onPending }) {
  const created = await instance.post('pair', { kind: 'mobile', mode: 'otp', scopes })
  assert.equal(created.status, 201, JSON.stringify(created.data))
  const ws = new WebSocket(endpoint, protocols, {
    ...(origin ? { origin } : {}), rejectUnauthorized: false, headers: { 'X-DSH-Device-ID': deviceId },
  })
  ws.on('error', () => {})
  const stream = framesOf(ws)
  stream.wsRef = [ws]
  const challenge = await stream.next((frame) => frame.kind === 'pairing-challenge')
  const clientNonce = crypto.randomBytes(18).toString('base64url')
  ws.send(JSON.stringify({ type: 'pairing-proof', otpProof: otpProof(created.data.otp, challenge.certSha256, clientNonce, challenge.serverNonce), clientNonce }))
  const pending = await stream.next((frame) => frame.kind === 'pairing-pending')
  onPending?.(pending)
  const approved = await instance.post(`pending/${encodeURIComponent(pending.requestId)}/approve`, {})
  assert.equal(approved.status, 200, JSON.stringify(approved.data))
  const paired = await stream.next((frame) => frame.kind === 'paired')
  const hello = await stream.next((frame) => frame.kind === 'hello')
  await negotiate(stream)
  return { ws, stream, paired, hello }
}
const WEB_UNLOCK_SCOPES = ['sessions:read', 'web:unlock']
/** The passkey frames need a live device record (enough for `siteFor`): no scope at all. */
const NO_SCOPES = []
/** Mobile scopes the passkey + device-request path needs (the passkey suite's own set). */
const WEB_SCOPES = ['sessions:read', 'prompt:send', 'approval:respond', 'web:unlock']

/** Open the web ingress (OTP flow, exact origin) and drive the proof up to a pending request. */
async function webPending(instance, webPort, extraHeaders = {}) {
  const created = await instance.post('pair', { kind: 'mobile', mode: 'otp' })
  assert.equal(created.status, 201, JSON.stringify(created.data))
  // A browser sends its Origin on every WebSocket; `dsh-pair-otp.v1` is the OTP flow's marker
  // (the same two protocols the direct approval suite uses).
  const ws = new WebSocket(`wss://127.0.0.1:${webPort}/ws/mobile`, ['dsh-mobile-v1', 'dsh-pair-otp.v1'], {
    origin: ORIGIN, rejectUnauthorized: false, headers: { 'X-DSH-Device-ID': 'web-device-1', ...extraHeaders },
  })
  ws.on('error', () => {})
  const stream = framesOf(ws)
  const challenge = await stream.next((frame) => frame.kind === 'pairing-challenge')
  const clientNonce = crypto.randomBytes(18).toString('base64url')
  ws.send(JSON.stringify({ type: 'pairing-proof', otpProof: otpProof(created.data.otp, challenge.certSha256, clientNonce, challenge.serverNonce), clientNonce }))
  const pending = await stream.next((frame) => frame.kind === 'pairing-pending')
  return { ws, stream, pending, otp: created.data.otp, challenge }
}

/** Reconnect with a device token through the web ingress (the browser's reload path). */
async function webToken(instance, webPort, token) {
  const ws = new WebSocket(`wss://127.0.0.1:${webPort}/ws/mobile`, ['dsh-mobile-v1', `dsh-auth.${token}`], {
    origin: ORIGIN, rejectUnauthorized: false, headers: { 'X-DSH-Device-ID': 'web-device-1' },
  })
  ws.on('error', () => {})
  return { ws, stream: framesOf(ws) }
}

/**
 * One genuine ES256 authenticator (the passkey-adversarial suite's fixture, kept local): a fresh
 * P-256 key, a real COSE key and real signatures over the real `authData || SHA-256(clientData)`.
 */
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
function es256Authenticator(signCount = 1) {
  const { privateKey, publicKey } = crypto.generateKeyPairSync('ec', { namedCurve: 'P-256' })
  const jwk = publicKey.export({ format: 'jwk' })
  const credentialId = crypto.randomBytes(32)
  let signCounter = signCount
  const cose = cbor(new Map([
    [1, 2], [3, -7], [-1, 1],
    [-2, Buffer.from(jwk.x, 'base64url')], [-3, Buffer.from(jwk.y, 'base64url')],
  ]))
  const clientData = (challenge, { origin, type }) => Buffer.from(JSON.stringify({
    type, challenge, origin, crossOrigin: false,
  }), 'utf8')
  return {
    registration(challenge, { origin, rpId, flags = 0x45, counter = signCount } = {}) {
      const idLength = Buffer.from([0, 0])
      idLength.writeUInt16BE(credentialId.length, 0)
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
        id: credentialId.toString('base64url'),
        rawId: credentialId.toString('base64url'),
        clientDataJSON: clientData(challenge, { origin, type: 'webauthn.create' }).toString('base64url'),
        attestationObject: cbor(new Map([['fmt', 'none'], ['attStmt', new Map()], ['authData', authData], ['type', 'public-key']])).toString('base64url'),
      }
    },
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
        id: credentialId.toString('base64url'),
        rawId: credentialId.toString('base64url'),
        clientDataJSON: clientDataJSON.toString('base64url'),
        authenticatorData: authData.toString('base64url'),
        signature: crypto.sign('sha256', Buffer.concat([authData, digest]), privateKey).toString('base64url'),
      }
    },
  }
}

/** The contract's client-hello exchange: an authorized operation may not run before its ack. */
let helloSeq = 0
async function negotiate(stream) {
  const requestId = `hello-${++helloSeq}`
  stream.wsRef[0].send(JSON.stringify({ type: 'client-hello', requestId, companionProtocol: 1, appVersion: 'test', platform: 'web' }))
  return stream.next((frame) => frame.kind === 'client-hello' && frame.requestId === requestId)
}

/** One request/answer pair on a socket, matched on its requestId. */
let askSeq = 0
async function ask(stream, frame) {
  const requestId = `ask-${++askSeq}`
  stream.wsRef[0].send(JSON.stringify({ ...frame, requestId }))
  return stream.next((reply) => reply.requestId === requestId)
}

/** The web ingress answers (fence + path passed) and asks for a credential: HTTP 401. A 403/404
 *  here would mean the origin or the path was refused instead. */
async function expectServed(port) {
  await assert.rejects(webUpgrade({ port, headers: { Origin: ORIGIN }, protocols: ['dsh-mobile-v1'] }),
    (error) => error.status === 401)
}

/** Open the direct listener's channel and drive the OTP proof up to a pending request. */
async function directPending(instance) {
  const status = await instance.waitForLan()
  const created = await instance.post('pair', { kind: 'mobile', mode: 'otp' })
  assert.equal(created.status, 201, JSON.stringify(created.data))
  const ws = new WebSocket(status.lan.urls[0], ['dsh-mobile-v1', 'dsh-pair-otp.v1'], {
    rejectUnauthorized: false, headers: { 'X-DSH-Device-ID': 'direct-device-1' },
  })
  ws.on('error', () => {})
  const stream = framesOf(ws)
  const challenge = await stream.next((frame) => frame.kind === 'pairing-challenge')
  const clientNonce = crypto.randomBytes(18).toString('base64url')
  ws.send(JSON.stringify({ type: 'pairing-proof', otpProof: otpProof(created.data.otp, challenge.certSha256, clientNonce, challenge.serverNonce), clientNonce }))
  const pending = await stream.next((frame) => frame.kind === 'pairing-pending')
  return { ws, stream, pending }
}

try {
  // ---------------------------------------------------------------------------------------
  // 1. Pure origin policy and the persisted tuple
  // ---------------------------------------------------------------------------------------
  await check('origin: only one canonical https://<label>.ts.net spelling is accepted', () => {
    for (const good of [ORIGIN, 'https://box.tailnet-1234.ts.net']) assert.equal(normalizeWebOrigin(good), good)
    for (const bad of [
      'http://dsh-owner.tail1234.ts.net', 'https://dsh-owner.tail1234.ts.net/', 'https://dsh-owner.tail1234.ts.net:443',
      'https://dsh-owner.tail1234.ts.net:30443/ws/mobile', 'https://dsh-owner.tail1234.ts.net.', 'https://ts.net',
      'https://dsh-owner.tail1234.ts.net#x', 'https://user:pw@dsh-owner.tail1234.ts.net', 'https://100.64.1.2',
      'https://localhost', ' HTTPS://dsh-owner.tail1234.ts.net', 'Dsh-owner.tail1234.ts.net',
    ]) assert.equal(normalizeWebOrigin(bad), null, bad)
  })

  await check('tuple: disabled default, one-value persistence, refused write leaves the file as it was', () => {
    const stateFile = path.join(temp, 'tuple-state.json')
    const state = createGatewayState(stateFile)
    assert.equal(state.webIngress, undefined, 'absent means never configured, not "disabled with a port"')
    assert.deepEqual(readWebIngress({ enabled: false, port: 0, origin: '' }), { enabled: false, port: 0, origin: '' })
    for (const bad of [null, [], 'x', { enabled: 1, port: 0, origin: '' }, { enabled: true, port: 70_000, origin: '' },
      { enabled: true, port: 30_443, origin: '' }, { enabled: true, port: 30_443, origin: 'https://box.tailnet.ts.net', extra: 1 }]) {
      assert.throws(() => readWebIngress(bad), /web ingress/)
    }
    // A half tuple (no port / no origin key) must be refused, never read as the default.
    assert.throws(() => readWebIngress({ enabled: true, port: 30_443 }), /web ingress origin/)
    assert.throws(() => readWebIngress({ enabled: true, origin: ORIGIN }), /web ingress port/)
    state.setWebIngress({ enabled: true, port: 30_443, origin: ORIGIN })
    const reloaded = createGatewayState(stateFile)
    assert.deepEqual(reloaded.webIngress, { enabled: true, port: 30_443, origin: ORIGIN })
    assert.equal(reloaded.gatewayId, state.gatewayId, 'a tuple write keeps the identity')
    const before = fs.readFileSync(stateFile, 'utf8')
    assert.throws(() => state.setWebIngress({ enabled: true, port: 30_444, origin: 'https://evil.example' }), /web ingress origin/)
    assert.equal(fs.readFileSync(stateFile, 'utf8'), before)
    fs.writeFileSync(stateFile, JSON.stringify({ version: 1, gatewayId: state.gatewayId, mode: null, webIngress: { enabled: 'yes', port: 1, origin: ORIGIN } }))
    assert.throws(() => createGatewayState(stateFile), /failed to load gateway state/)
  })

  await check('collision with the direct port is refused (409) with no other change', () => {
    const current = { enabled: false, port: 0, origin: '' }
    assert.throws(() => planWebIngress({ enabled: true, origin: ORIGIN, port: 31_111 }, current, 31_111),
      (error) => error.status === 409 && error.code === 'port-conflict')
    assert.throws(() => planWebIngress({ enabled: true, origin: ORIGIN, port: 0 }, current, 31_111), (error) => error.status === 400)
    assert.throws(() => planWebIngress({ enabled: true }, current, 31_111), (error) => error.status === 400)
    assert.throws(() => planWebIngress({ surprise: true }, current, 31_111), (error) => error.status === 400)
    assert.deepEqual(planWebIngress({ enabled: true, origin: ORIGIN, port: 30_443 }, current, 31_111),
      { enabled: true, port: 30_443, origin: ORIGIN })
    assert.deepEqual(planWebIngress({ enabled: false }, { enabled: true, port: 30_443, origin: ORIGIN }, 31_111),
      { enabled: false, port: 30_443, origin: ORIGIN }, 'a disable keeps the configured identity')
  })

  await check('origin gate: missing, null, foreign and repeated Origins are all refused', () => {
    for (const headers of [{}, { origin: 'null' }, { origin: 'https://evil.example' }, { origin: 'http://dsh-owner.tail1234.ts.net' },
      { origin: `${ORIGIN}/` }, { origin: `${ORIGIN},${ORIGIN}` }]) {
      const verdict = webOriginAccepted({ headers }, ORIGIN)
      assert.equal(verdict.ok, false, JSON.stringify(headers))
      assert.match(verdict.reason, /origin-(missing|foreign)/)
    }
    assert.equal(webOriginAccepted({ headers: { origin: ORIGIN } }, ORIGIN).ok, true)
    assert.equal(webOriginAccepted({ headers: { origin: ORIGIN } }, '').ok, false)
  })

  await check('owner guidance is browser-only, fixed /ws/mobile, and never claims readiness', () => {
    const guidance = webIngressStatus({ enabled: false, origin: ORIGIN, listening: false, port: 30_443, error: null })
    assert.deepEqual(Object.keys(guidance).sort(),
      ['configured', 'enabled', 'error', 'host', 'listening', 'origin', 'port', 'trust', 'wsPath'])
    // Spec 031 §2/§7: the browser path is the contract's `/ws/mobile` regardless of the direct
    // listener's configurable path, and the guidance reports `listening`, never a `ready`.
    assert.equal(guidance.wsPath, WEB_WS_PATH)
    assert.equal(WEB_WS_PATH, '/ws/mobile')
    assert.equal('ready' in guidance, false, 'listening is not authenticated readiness')
    assert.equal(guidance.trust, 'browser-ca-same-origin')
    assert.equal(guidance.host, '127.0.0.1')
    assert.equal(guidance.origin, ORIGIN, 'the guidance names the origin even while the ingress is off')
    assert.equal('certSha256' in guidance, false)
    assert.equal('endpoints' in guidance, false)
    const unconfigured = webIngressStatus({ enabled: false, origin: '', listening: false, port: 0, error: null })
    assert.equal(unconfigured.origin, null)
    assert.equal(unconfigured.configured, false)
  })

  // ---------------------------------------------------------------------------------------
  // 2. Live instance: configure, fences, lifecycle
  // ---------------------------------------------------------------------------------------
  const webPort = await freePort()
  const directPort = await freePort()
  const instance = await startGateway('main', {
    lanPort: directPort,
    webIngress: { enabled: false, port: 0, origin: '' },
    gatewayStateFile: path.join(temp, 'main-state.json'),
  })
  try {
    await instance.waitForLan()
    const initialStatus = await instance.status()
    assert.equal(initialStatus.webIngress.enabled, false, 'the default is off')
    assert.equal(initialStatus.webIngress.listening, false)
    assert.equal(initialStatus.webIngress.port, 0)
    assert.equal(initialStatus.webIngress.origin, null)

    await check('configure: enable reports the tuple and a listening loopback upstream', async () => {
      const applied = await instance.post('web-ingress', { enabled: true, port: webPort, origin: ORIGIN })
      assert.equal(applied.status, 200, JSON.stringify(applied.data))
      assert.equal(applied.data.enabled, true)
      assert.equal(applied.data.listening, true)
      assert.equal(applied.data.origin, ORIGIN)
      assert.equal(applied.data.host, '127.0.0.1')
      assert.equal(applied.data.wsPath, '/ws/mobile')
      assert.equal(applied.data.trust, 'browser-ca-same-origin')
      const status = await instance.status()
      assert.equal(status.webIngress.enabled, true)
      assert.equal(status.webIngress.active, true)
      // Spec 031 §7: `ready` is never reported — readiness needs an accepted client-hello after
      // pairing, which a listening loopback upstream does not stand in for.
      assert.equal('ready' in status.webIngress, false, 'listening is not readiness')
      assert.equal(status.webIngress.wsPath, WEB_WS_PATH, 'the browser path is the fixed /ws/mobile')
      assert.equal(status.webIngress.port, webPort)
      assert.equal(status.webIngress.error, null)
      assert.equal(status.lan.listening, true, 'the direct listener is untouched by this transition')
      assert.equal(status.lan.port, directPort)
      assert.deepEqual(createGatewayState(instance.stateFile).webIngress, { enabled: true, port: webPort, origin: ORIGIN })
    })

    await check('collision with the live direct port is refused (409) and nothing moves', async () => {
      const before = fs.readFileSync(instance.stateFile, 'utf8')
      const conflict = await instance.post('web-ingress', { port: directPort })
      assert.equal(conflict.status, 409, JSON.stringify(conflict.data))
      assert.equal(conflict.data.code, 'port-conflict')
      const status = await instance.status()
      assert.equal(status.webIngress.port, webPort, 'nothing moved')
      assert.equal(status.webIngress.active, true)
      assert.equal(fs.readFileSync(instance.stateFile, 'utf8'), before, 'the stored tuple is unchanged')
    })

    await check('a busy port is reported, never shifted, and an identical re-apply retries it', async () => {
      // Keep the direct port known to the owner tuple while this runs (a later check restores the
      // fixture's web port): the tuple under test is `{enabled:true, port: busy, origin}`.
      const blocker = http.createServer()
      await listenFetchSafe(blocker, { probe: 'tcp' })
      const busy = blocker.address().port
      const attempted = await instance.post('web-ingress', { port: busy })
      assert.equal(attempted.status, 409, JSON.stringify(attempted.data))
      assert.equal(attempted.data.code, 'web-ingress/bind-failed')
      assert.equal(attempted.data.webIngress.listening, false)
      assert.equal(attempted.data.webIngress.port, busy, 'the owner tuple was saved and reported')
      assert.equal(attempted.data.webIngress.active, false, 'a failure answer never claims a listener')
      const status = await instance.status()
      assert.equal(status.webIngress.active, false)
      assert.equal(status.webIngress.listening, false)
      assert.equal('ready' in status.webIngress, false)
      assert.equal(status.webIngress.error, 'EADDRINUSE', 'the failure stays reported until a retry succeeds')
      // The failed attempt holds no listener: the configured tuple IS this one, so a re-apply is
      // an identical tuple. It must be a RETRY against the now-free port, not "already applied".
      await new Promise((resolve) => blocker.close(resolve))
      const retried = await instance.post('web-ingress', { port: busy })
      assert.equal(retried.status, 200, JSON.stringify(retried.data))
      assert.equal(retried.data.changed, true, 'an identical tuple with no listener is a fresh attempt')
      assert.equal(retried.data.listening, true)
      assert.equal(retried.data.error, null)
      const after = await instance.status()
      assert.equal(after.webIngress.active, true)
      assert.equal(after.webIngress.port, busy)
      assert.equal(after.webIngress.error, null)
      await expectServed(busy)
      // A retry that then succeeds is "changed"; a re-apply of a HEALTHY tuple still short-circuits.
      const again = await instance.post('web-ingress', { port: busy })
      assert.equal(again.status, 200, JSON.stringify(again.data))
      assert.equal(again.data.changed, false, 'a live listener is configured-and-unchanged')
      // Back to the fixture's port for the sections after this.
      const restored = await instance.post('web-ingress', { port: webPort })
      assert.equal(restored.status, 200, JSON.stringify(restored.data))
      assert.equal(restored.data.listening, true)
    })

    await check('path: the web listener serves only /ws/mobile whatever the configured direct path', async () => {
      // Spec 031 §2: Serve is mounted on the browser origin's `/ws/mobile`. A gateway whose DIRECT
      // listener uses a non-default path must not move the browser path — nor the guidance.
      const directCustom = await freePort()
      const customWeb = await freePort()
      const custom = await startGateway('custom-path', {
        path: '/ws/owner-mobile',
        lanPort: directCustom,
        gatewayStateFile: path.join(temp, 'custom-path-state.json'),
        deviceFile: path.join(temp, 'custom-path-devices.json'),
      })
      try {
        await custom.waitForLan()
        const applied = await custom.post('web-ingress', { enabled: true, port: customWeb, origin: ORIGIN })
        assert.equal(applied.status, 200, JSON.stringify(applied.data))
        assert.equal(applied.data.wsPath, WEB_WS_PATH, 'guidance names the fixed browser path')
        const status = await custom.status()
        assert.equal(status.wsPath, '/ws/owner-mobile', 'the direct listener keeps its configured path')
        assert.equal(status.webIngress.wsPath, WEB_WS_PATH)
        assert.match(String(status.lan.urls[0]), /\/ws\/owner-mobile$/)
        // The web listener serves ONLY the fixed path: the direct path is a 404 there.
        await assert.rejects(webUpgrade({ port: customWeb, headers: { Origin: ORIGIN }, protocols: ['dsh-mobile-v1'], pathName: '/ws/owner-mobile' }),
          (error) => error.status === 404)
        await expectServed(customWeb)
        // The direct listener serves the path it was configured with, and not the browser path.
        await assert.rejects(webUpgrade({ port: directCustom, headers: { Origin: ORIGIN }, protocols: ['dsh-mobile-v1'], pathName: '/ws/owner-mobile' }),
          (error) => error.status !== 404)
        await assert.rejects(webUpgrade({ port: directCustom, headers: { Origin: ORIGIN }, protocols: ['dsh-mobile-v1'], pathName: WEB_WS_PATH }),
          (error) => error.status === 404, 'the direct listener does not serve a path it was never given')
      } finally {
        await custom.close()
      }
    })

    await check('pending records: a web-ingress request is the shared proxied bucket and never shows an address', async () => {
      // Finding 5: the web ingress peers with Serve, not the browser, so its pairing request is
      // the conservative `proxied` class (clientIp empty) whatever headers it carries — and the
      // source brake keys on that bucket, so adding/removing/varying a forwarding header cannot
      // move it to a different bucket.
      const listed = async (id) => (await instance.get('pending')).data.pending.find((entry) => entry.id === id)
      const headers = [{}, { 'X-Forwarded-For': '100.64.1.2' }, { 'X-Forwarded-For': '203.0.113.9, 100.64.9.9' }, { 'Tailscale-User-Login': 'owner@example' }]
      for (const extra of headers) {
        const { ws, pending } = await webPending(instance, webPort, extra)
        const record = await listed(pending.requestId)
        assert.ok(record !== undefined, JSON.stringify(extra))
        assert.equal(record.clientIp, '', `the web ingress never records the proxy as the client (${JSON.stringify(extra)})`)
        ws.terminate()
      }

      // The recorded class is what this check pins; the brake below spends the shared `proxied`
      // budget on its OWN gateway (spec 023/031: one conservative `proxied` bucket for the whole
      // Host, pinned by pairing-approval P16b), so every check of the live `instance` starts unspent.
      const budget = await startGateway('proxied-budget', {
        lanPort: await freePort(),
        gatewayStateFile: path.join(temp, 'proxied-budget-state.json'),
        deviceFile: path.join(temp, 'proxied-budget-devices.json'),
      })
      try {
        await budget.waitForLan()
        const budgetWebPort = await freePort()
        const applied = await budget.post('web-ingress', { enabled: true, port: budgetWebPort, origin: ORIGIN })
        assert.equal(applied.status, 200, JSON.stringify(applied.data))

        // Reviewer round 2, MINOR 2: the brake, not only the recorded class. Each web-ingress
        // socket spends ONE wrong proof under a DIFFERENT forwarding-header presence/value; every
        // one of them lands in the same `proxied` bucket (the web ingress joins it unconditionally,
        // so a header can neither move the bucket nor be read). SOURCE_MAX_FAILURES (2) wrong
        // proofs spend it, and the NEXT proof from that bucket is refused UNTESTED — so the owner's
        // offer has not burned, exactly as the direct suites' P16/P16b show. A sheet that were
        // recorded under a different per-socket key would answer the third proof normally and the
        // fourth would succeed with the right code: both assertions below would then fail.
        const wrongFor = (otp) => (otp === '00000000' ? '11111111' : '00000000')
        const closedWithin = (ws, budgetMs = 8000) => Promise.race([
          new Promise((resolve) => ws.once('close', (code) => resolve(code))),
          delay(budgetMs).then(() => 'no-close'),
        ])
        let keptOtp
        const spend = async (extra) => {
          const created = await budget.post('pair', { kind: 'mobile', mode: 'otp' })
          assert.equal(created.status, 201, JSON.stringify(created.data))
          const ws = new WebSocket(`wss://127.0.0.1:${budgetWebPort}/ws/mobile`, ['dsh-mobile-v1', 'dsh-pair-otp.v1'], {
            origin: ORIGIN, rejectUnauthorized: false, headers: { 'X-DSH-Device-ID': 'web-device-1', ...extra },
          })
          ws.on('error', () => {})
          const stream = framesOf(ws)
          const challenge = await stream.next((frame) => frame.kind === 'pairing-challenge')
          const closed = closedWithin(ws)
          const clientNonce = crypto.randomBytes(18).toString('base64url')
          ws.send(JSON.stringify({ type: 'pairing-proof', otpProof: otpProof(wrongFor(created.data.otp), challenge.certSha256, clientNonce, challenge.serverNonce), clientNonce }))
          // The same wire answer whatever refused it: the wrong-or-expired code close.
          assert.equal(await closed, 4410, `wrong proof refused (${JSON.stringify(extra)})`)
          // One of these offers is kept for the "right code, limited bucket" proof below.
          if (extra['X-Forwarded-For'] === '100.64.7.7') keptOtp = created.data.otp
        }
        await spend({})
        await spend({ 'X-Forwarded-For': '100.64.7.7' })
        // The bucket is spent now, and the refusal is UNTESTED: the owner's live offer survives.
        await spend({ 'Tailscale-User-Login': 'someone@example' })
        assert.ok((await budget.get('pending')).data.offers >= 1, 'the offer was not burned by the shared bucket')
        // Proven by the RIGHT code: the bucket is limited, so even a correct proof is refused there.
        const limited = await new Promise((resolve, reject) => {
          const ws = new WebSocket(`wss://127.0.0.1:${budgetWebPort}/ws/mobile`, ['dsh-mobile-v1', 'dsh-pair-otp.v1'], {
            origin: ORIGIN, rejectUnauthorized: false, headers: { 'X-DSH-Device-ID': 'web-device-1', 'X-Forwarded-For': '100.64.8.8' },
          })
          ws.on('error', () => {})
          const stream = framesOf(ws)
          stream.next((frame) => frame.kind === 'pairing-challenge').then((challenge) => {
            const clientNonce = crypto.randomBytes(18).toString('base64url')
            ws.send(JSON.stringify({ type: 'pairing-proof', otpProof: otpProof(keptOtp, challenge.certSha256, clientNonce, challenge.serverNonce), clientNonce }))
            resolve(closedWithin(ws))
          }, reject)
        })
        assert.equal(limited, 4410, 'a source-limited bucket is refused even with the right code')
      } finally {
        await budget.close()
      }
    })

    await check('passkey: a web-ingress PWA registers + asserts via its configured origin; the DIRECT listener still refuses it', async () => {
      // Spec 021 + spec 031 §7: the browser reached this WSS through the configured origin, so
      // that origin is its passkey site even though it is NOT in `allowedOrigins` (the gateway's
      // config lists no origin at all). A direct socket with the SAME origin must stay refused.
      const web = await approveOtp(instance, `wss://127.0.0.1:${webPort}/ws/mobile`, {
        origin: ORIGIN, protocols: ['dsh-mobile-v1', 'dsh-pair-otp.v1'], deviceId: 'pk-web-1', scopes: WEB_UNLOCK_SCOPES,
      })
      assert.equal(web.hello.webLock, 'unregistered', 'a web:unlock device starts unregistered')
      // A locked socket is refused an authorized request before any passkey exists.
      const locked = await ask(web.stream, { type: 'sessions' })
      assert.equal(locked.code, 'auth/locked', JSON.stringify(locked).slice(0, 200))
      const ceremony = await passkeyCeremony(web.stream, ORIGIN, 'dsh-owner.tail1234.ts.net')
      assert.equal(ceremony.registered?.ok, true, `register on the web ingress: ${JSON.stringify(ceremony.registered).slice(0, 200)}`)
      assert.equal(ceremony.asserted?.unlocked, true, `assert on the web ingress: ${JSON.stringify(ceremony.asserted).slice(0, 200)}`)
      const sessions = await ask(web.stream, { type: 'sessions' })
      assert.equal(sessions.kind, 'sessions', `an unlocked web socket is served: ${JSON.stringify(sessions).slice(0, 200)}`)
      web.ws.terminate()

      // The SAME exact origin, on the DIRECT listener (which also speaks TLS and pins the leaf),
      // is not a passkey site: `allowedOrigins` never listed it, and the ingress rule admits only
      // sockets that arrived on the web ingress. Paired through the direct endpoint like the PWA
      // (same kind, `web:unlock`, no Origin — a native-style upgrade the direct fence allows),
      // it starts locked; the first frame that must reach `siteFor` is the register options, and
      // it is refused there before any challenge exists.
      const direct = await approveOtp(instance, (await instance.waitForLan()).lan.urls[0], {
        origin: null, protocols: ['dsh-mobile-v1', 'dsh-pair-otp.v1'], deviceId: 'pk-direct-1', scopes: WEB_UNLOCK_SCOPES,
      })
      assert.equal(direct.hello.webLock, 'unregistered', 'the same device kind on the direct listener')
      const stillLocked = await ask(direct.stream, { type: 'sessions' })
      assert.equal(stillLocked.code, 'auth/locked', JSON.stringify(stillLocked).slice(0, 200))
      // A direct browser tab on that origin IS refused, though: the direct listener's own Origin
      // fence (`allowedOrigins`) still governs it, and this checkout lists no origin.
      await assert.rejects(webUpgrade({ port: directPort, headers: { Origin: ORIGIN }, protocols: ['dsh-mobile-v1'] }),
        (error) => error.status === 403)
      const refused = await ask(direct.stream, { type: 'passkey-register-options' })
      assert.equal(refused.kind, 'error', `a direct socket must not get options: ${JSON.stringify(refused).slice(0, 200)}`)
      assert.equal(refused.code, 'passkey/verification-failed', 'the site rule refuses before any challenge exists')
      direct.ws.terminate()
    })

    await check('passkey policy (assembled): the site follows the socket INGRESS, current, and never widens allowedOrigins', async () => {
      // Reviewer round 2, MINOR 1: no imitation. The rule is driven through the assembled
      // gateway (its own `passkeyOriginPolicy` over its own listener identities), so what is
      // under test is the identity a listener hands its upgrades. Each leg runs on its OWN gateway
      // instance and its own device id (the passkey per-device failure budget must not make a
      // later leg answer `rate-limited` instead of the site refusal), and the order is fixed: a
      // stale socket is always made stale BEFORE a fresh socket is exercised on that gateway.
      const otherOrigin = 'https://owner.example.test'
      const webPortOf = async (gateway) => (await gateway.status()).webIngress.port
      const unlock = async (gateway, deviceId) => {
        const paired = await approveOtp(gateway, `wss://127.0.0.1:${await webPortOf(gateway)}/ws/mobile`, {
          origin: ORIGIN, protocols: ['dsh-mobile-v1', 'dsh-pair-otp.v1'], deviceId, scopes: WEB_UNLOCK_SCOPES,
        })
        assert.equal(paired.hello.webLock, 'unregistered')
        return paired
      }
      const startPolicyGateway = async (name) => {
        const gateway = await startGateway(name, {
          lanPort: await freePort(),
          allowedOrigins: [otherOrigin],
          deviceFile: path.join(temp, `${name}-devices.json`),
          gatewayStateFile: path.join(temp, `${name}-state.json`),
        })
        await gateway.waitForLan()
        const applied = await gateway.post('web-ingress', { enabled: true, port: await freePort(), origin: ORIGIN })
        assert.equal(applied.status, 200, JSON.stringify(applied.data))
        return gateway
      }
      /** Register + assert on a socket; returns the ceremony so a failing leg names its frame. */
      const ceremonyOn = async (paired) => {
        const ceremony = await passkeyCeremony(paired.stream, ORIGIN, 'dsh-owner.tail1234.ts.net')
        assert.equal(ceremony.registered?.ok, true, `registers: ${JSON.stringify(ceremony.registered).slice(0, 200)}`)
        assert.equal(ceremony.asserted?.unlocked, true, `asserts: ${JSON.stringify(ceremony.asserted).slice(0, 200)}`)
        return ceremony
      }
      /** The only refusal a non-site socket may get: the site decision runs before any challenge. */
      const siteRefused = async (paired) => {
        const refused = await ask(paired.stream, { type: 'passkey-register-options' })
        assert.equal(refused.kind, 'error', JSON.stringify(refused).slice(0, 200))
        assert.equal(refused.code, 'passkey/verification-failed', JSON.stringify(refused).slice(0, 200))
      }
      try {
        // Leg 1: the current attempt is a site even though `allowedOrigins` never listed it, and
        // an unlocked socket is then served an authorized request.
        const originGateway = await startPolicyGateway('policy-origin')
        try {
          const paired = await unlock(originGateway, 'pk-policy-origin')
          await ceremonyOn(paired)
          const served = await ask(paired.stream, { type: 'sessions' })
          assert.equal(served.kind, 'sessions', JSON.stringify(served).slice(0, 200))
          paired.ws.terminate()
          // The list is never widened by it. `/mgw/status` carries no `allowedOrigins` field, so the
          // assertion is the rule the site decision itself reads (`siteFor` -> the gateway's
          // `passkeyOriginPolicy`): the SAME origin is a site only for a socket that arrived on the
          // web ingress. A socket without that ingress (the DIRECT listener) is refused it, which is
          // what the configured list admits — and it was never the web origin.
          const { PasskeyRefusal, createPasskeyService } = await import('../lib/passkey.mjs')
          const service = createPasskeyService({ records: {}, file: path.join(temp, 'policy-probe-store.json'), allowedOrigins: [otherOrigin], log: () => {} })
          assert.throws(() => service.siteFor({ origin: ORIGIN, passkeySlot: { stateKey: 'probe' } }),
            (error) => error instanceof PasskeyRefusal && error.code === 'passkey/verification-failed',
            'a non-web socket on the web origin is not a site')
        } finally {
          await originGateway.close()
        }

        // Leg 2: disable -> enable restores the SAME port on a NEW listener (the reviewer's
        // stale-activation sequence): the socket was activated while its attempt existed, its
        // record survives the switch (the credential is not revoked), and its ingress no longer
        // is the current one — so the restored listener must refuse it the site.
        const offOnGateway = await startPolicyGateway('policy-off-on')
        try {
          const stale = await unlock(offOnGateway, 'pk-policy-off-on')
          const restoredPort = await webPortOf(offOnGateway)
          const disabled = await offOnGateway.post('web-ingress', { enabled: false })
          assert.equal(disabled.status, 200, JSON.stringify(disabled.data))
          // A disable CLOSES the connections it served (spec 031: an invalidated ingress ends its
          // sockets with the contract re-authenticate code), so the stale socket witnesses that
          // first, and the restored listener then refuses it should it come back.
          const closedCode = await new Promise((resolve) => {
            if (stale.ws.readyState === 3) { resolve(CLOSE_REAUTH); return }
            const timer = setTimeout(() => resolve('no-close'), 4000)
            stale.ws.once('close', (code) => { clearTimeout(timer); resolve(code) })
          })
          assert.equal(closedCode, CLOSE_REAUTH, 'the disable ended the socket it served')
          const persists = await offOnGateway.post('web-ingress', { enabled: true, port: restoredPort, origin: ORIGIN })
          assert.equal(persists.status, 200, JSON.stringify(persists.data))
          assert.equal(persists.data.port, restoredPort, 'the re-enabled ingress is on the same port')
          // The restored CURRENT attempt is a site for a fresh socket (register + assert).
          const current = await unlock(offOnGateway, 'pk-policy-current')
          await ceremonyOn(current)
          current.ws.terminate()
        } finally {
          await offOnGateway.close()
        }

        // Leg 3: a replacement on a NEW port invalidates the previous attempt the same way: the
        // socket it served is closed (4401) and only the replacement's attempt is a site.
        const replacedGateway = await startPolicyGateway('policy-replaced')
        try {
          const oldAttempt = await unlock(replacedGateway, 'pk-policy-replaced')
          const closedCode = Promise.race([
            new Promise((resolve) => {
              if (oldAttempt.ws.readyState === 3) { resolve(CLOSE_REAUTH); return }
              const timer = setTimeout(() => resolve('no-close'), 4000)
              oldAttempt.ws.once('close', (code) => { clearTimeout(timer); resolve(code) })
            }),
          ])
          const replaced = await replacedGateway.post('web-ingress', { enabled: true, port: await freePort() })
          assert.equal(replaced.status, 200, JSON.stringify(replaced.data))
          assert.equal(await closedCode, CLOSE_REAUTH, 'the replacement ended the socket of the old attempt')
          oldAttempt.ws.terminate()
          const replacement = await unlock(replacedGateway, 'pk-policy-replacement')
          await ceremonyOn(replacement)
          replacement.ws.terminate()
        } finally {
          await replacedGateway.close()
        }
      } finally {
        fs.rmSync(path.join(temp, 'site-policy-passkeys.json'), { force: true })
      }
    })

    await check('duplicate-in-flight bookkeeping wraps the web-ingress activation (contract §1)', async () => {
      // The regression this pins: activation through the web ingress must still initialize
      // `ws.inFlightRequestIds` (it had been merged into a comment line, so duplicates re-ran).
      // The gate BEFORE activation is the product's own test seam (`testActivationHold`): the
      // duplicate must be refused by the in-flight rule, not by the negotiation fence.
      const activation = { started: false, release: () => {} }
      instance.state.activationHold = ({ deviceId }) => {
        if (deviceId !== 'dup-web-1') return undefined
        activation.started = true
        return new Promise((resolve) => { activation.release = resolve })
      }
      const request = { started: false, release: () => {} }
      instance.state.gate2 = request
      let ws
      try {
        const created = await instance.post('pair', { kind: 'mobile', mode: 'otp', scopes: ['sessions:read'] })
        assert.equal(created.status, 201, JSON.stringify(created.data))
        ws = new WebSocket(`wss://127.0.0.1:${webPort}/ws/mobile`, ['dsh-mobile-v1', 'dsh-pair-otp.v1'], {
          origin: ORIGIN, rejectUnauthorized: false, headers: { 'X-DSH-Device-ID': 'dup-web-1' },
        })
        ws.on('error', () => {})
        const stream = framesOf(ws)
        stream.wsRef = [ws]
        const challenge = await stream.next((frame) => frame.kind === 'pairing-challenge')
        const clientNonce = crypto.randomBytes(18).toString('base64url')
        ws.send(JSON.stringify({ type: 'pairing-proof', otpProof: otpProof(created.data.otp, challenge.certSha256, clientNonce, challenge.serverNonce), clientNonce }))
        const pending = await stream.next((frame) => frame.kind === 'pairing-pending')
        // The approval hands the socket to activation, which this hold is delaying.
        const decision = instance.post(`pending/${encodeURIComponent(pending.requestId)}/approve`, {})
        assert.equal((await decision).status, 200)
        activation.release()
        const paired = await stream.next((frame) => frame.kind === 'paired')
        assert.equal(paired.token.length, 43)
        await stream.next((frame) => frame.kind === 'hello')
        const ack = await negotiate(stream)
        assert.equal(ack.kind, 'client-hello')
        const id = 'dup-web-request-1'
        ws.send(JSON.stringify({ type: 'sessions', requestId: id }))
        for (let attempt = 0; attempt < 200 && !request.started; attempt += 1) await delay(10)
        assert.equal(request.started, true, 'the first request must reach the Host')
        ws.send(JSON.stringify({ type: 'sessions', requestId: id }))
        const refused = await stream.next((frame) => frame.kind === 'error' && frame.requestId === id)
        assert.equal(refused.code, 'bad-request', JSON.stringify(refused).slice(0, 200))
        assert.match(refused.message, /already in flight/, 'the duplicate is the in-flight rule, not a missing set')
        request.release()
        const reply = await stream.next((frame) => frame.kind === 'sessions' && frame.requestId === id)
        assert.ok(Array.isArray(reply.items), 'the original request is answered exactly once')
      } finally {
        instance.state.activationHold = undefined
        instance.state.gate2 = undefined
        if (ws) ws.terminate()
      }
    })

    await check('admin fence: /mgw and the static/DSH surface answer 404 on the web port', async () => {
      for (const [pathName, headers] of [['/mgw/pending', { Origin: ORIGIN }], ['/', {}], ['/mgw', { Forwarded: 'for=203.0.113.9', Origin: ORIGIN }]]) {
        const answer = await new Promise((resolve, reject) => {
          const socket = tls.connect({ host: '127.0.0.1', port: webPort, rejectUnauthorized: false })
          socket.once('secureConnect', () => {
            const lines = [`GET ${pathName} HTTP/1.1`, 'Host: 127.0.0.1', 'Connection: close']
            for (const [name, value] of Object.entries(headers)) lines.push(`${name}: ${value}`)
            socket.write(`${lines.join('\r\n')}\r\n\r\n`)
          })
          socket.once('error', reject)
          socket.once('data', (chunk) => { socket.destroy(); resolve(chunk.toString('latin1')) })
        })
        assert.match(answer, /^HTTP\/1\.1 404 /, `${pathName} must not be served on the web port`)
      }
    })

    await check('WS fence: missing / null / foreign Origin and a caller-forwarding header are refused', async () => {
      for (const headers of [{}, { Origin: 'null' }, { Origin: 'https://evil.example' }, { Origin: ORIGIN, Forwarded: 'for=203.0.113.9' }, { Origin: ORIGIN, 'X-Real-IP': '203.0.113.9' }]) {
        await assert.rejects(webUpgrade({ port: webPort, headers, protocols: ['dsh-mobile-v1'] }),
          (error) => error.status === 403, JSON.stringify(headers))
      }
      // Only `/ws/mobile` is served; anything else answers 404 before any fence decision.
      for (const pathName of ['/mgw/', '/', '/ws/other']) {
        await assert.rejects(webUpgrade({ port: webPort, headers: { Origin: ORIGIN }, protocols: ['dsh-mobile-v1'], pathName }),
          (error) => error.status === 404, pathName)
      }
      // A spoofed Host on the web port cannot reach management either: the fence is peer-based.
      await assert.rejects(webUpgrade({ port: webPort, headers: { Origin: ORIGIN, Host: 'dsh-owner.tail1234.ts.net' }, protocols: ['dsh-mobile-v1'], pathName: '/mgw/pending' }),
        (error) => error.status === 404)
    })

    await check('the exact configured origin is served; Serve-own x-forwarded-for is not a refusal', async () => {
      // A real ws client with the accepted origin reaches the pairing state machine; the upgrade
      // itself proves the fence let it through (a refusal would be HTTP 403 before any frame).
      const stream = await new Promise((resolve, reject) => {
        const ws = new WebSocket(`wss://127.0.0.1:${webPort}/ws/mobile`, ['dsh-mobile-v1', 'dsh-pair-otp.v1'], {
          origin: ORIGIN, rejectUnauthorized: false,
          headers: { 'X-DSH-Device-ID': 'web-device-1', 'X-Forwarded-For': '100.64.1.2' },
        })
        const frames = framesOf(ws)
        ws.on('error', reject)
        frames.next((frame) => frame.kind === 'pairing-challenge').then((frame) => {
          ws.terminate()
          resolve(frame)
        }, (error) => { ws.terminate(); reject(error) })
      })
      assert.equal(stream.kind, 'pairing-challenge')
    })

    await check('web OTP pairing: proof -> pending -> owner approval -> paired -> hello', async () => {
      const status = await instance.status()
      const { ws, stream, pending, challenge } = await webPending(instance, webPort)
      // The challenge names the certificate THIS process presents (protocol material).
      assert.equal(challenge.certSha256, status.tls.fingerprint256)
      const listed = await instance.get('pending')
      assert.equal(listed.status, 200)
      assert.equal(listed.data.pending.some((entry) => entry.id === pending.requestId), true)
      const approved = await instance.post(`pending/${encodeURIComponent(pending.requestId)}/approve`, {})
      assert.equal(approved.status, 200, JSON.stringify(approved.data))
      const paired = await stream.next((frame) => frame.kind === 'paired')
      const hello = await stream.next((frame) => frame.kind === 'hello')
      assert.equal(paired.token.length, 43)
      assert.equal(hello.gatewayId, status.gatewayId, 'both ingresses speak for ONE identity')
      ws.close(1000)
    })

    await check('reconnect with the issued token goes through the web ingress', async () => {
      const { ws, stream, pending } = await webPending(instance, webPort)
      const approved = await instance.post(`pending/${encodeURIComponent(pending.requestId)}/approve`, { scopes: ['sessions:read'] })
      assert.equal(approved.status, 200, JSON.stringify(approved.data))
      const paired = await stream.next((frame) => frame.kind === 'paired')
      ws.close(1000)
      const { ws: ws2, stream: stream2 } = await webToken(instance, webPort, paired.token)
      const hello = await stream2.next((frame) => frame.kind === 'hello')
      assert.equal(typeof hello.device.id, 'string')
      ws2.terminate()
    })

    await check('concurrency: two simultaneous transitions serialize into one listener', async () => {
      // Both requests run through the listener lane: the direct port is validated again inside it,
      // so exactly one web listener exists afterwards and the status names the winner.
      const first = await freePort()
      const second = await freePort()
      const [a, b] = await Promise.all([
        instance.post('web-ingress', { enabled: true, port: first }),
        instance.post('web-ingress', { enabled: true, port: second }),
      ])
      assert.equal(a.status, 200, JSON.stringify(a.data))
      assert.equal(b.status, 200, JSON.stringify(b.data))
      const status = await instance.status()
      assert.equal(status.webIngress.listening, true)
      assert.equal([first, second].includes(status.webIngress.port), true, 'the winner is one of the two attempts')
      // Exactly one of the two ports serves; the other is closed (no orphaned listener).
      const serving = []
      for (const port of [first, second]) {
        try { await expectServed(port); serving.push(port) } catch { /* not this one */ }
      }
      assert.deepEqual(serving, [status.webIngress.port], 'one listener, and the status names it')
      // Back to the fixture's port for the sections after this.
      const restored = await instance.post('web-ingress', { port: webPort })
      assert.equal(restored.status, 200, JSON.stringify(restored.data))
      assert.equal((await instance.status()).webIngress.port, webPort)
    })

    await check('lifecycle: a disabled ingress refuses approval of its pending request and keeps direct alive', async () => {
      // Devices paired by earlier checks stay paired: the assertion is that THIS approval minted
      // nothing, so the count is compared before and after.
      const devicesBefore = (await instance.get('devices')).data.devices.length
      const { ws, pending } = await webPending(instance, webPort)
      const closed = Promise.race([new Promise((resolve) => ws.once('close', (code) => resolve(code))), delay(3000).then(() => 'no-close')])
      const disabled = await instance.post('web-ingress', { enabled: false })
      assert.equal(disabled.status, 200, JSON.stringify(disabled.data))
      assert.notEqual(await closed, 'no-close', 'the pending socket was ended with the disable')
      const late = await instance.post(`pending/${encodeURIComponent(pending.requestId)}/approve`, {})
      assert.equal(late.status, 404, JSON.stringify(late.data))
      const devices = await instance.get('devices')
      assert.equal(devices.data.devices.length, devicesBefore, 'no credential was minted for the refused request')
      const status = await instance.status()
      assert.equal(status.lan.listening, true, 'a web disable leaves the direct listener intact')
      assert.equal(status.webIngress.enabled, false)
      assert.equal(status.webIngress.listening, false)
      assert.equal(status.webIngress.origin, ORIGIN, 'the configured origin is kept for guidance')
    })

    await check('lifecycle: replacing the ingress (new port) invalidates the old attempt', async () => {
      const before = (await instance.status()).webIngress.port
      const next = await freePort()
      const applied = await instance.post('web-ingress', { enabled: true, port: next })
      assert.equal(applied.status, 200, JSON.stringify(applied.data))
      assert.equal(applied.data.port, next)
      await assert.rejects(webUpgrade({ port: before, headers: { Origin: ORIGIN }, protocols: ['dsh-mobile-v1'] }),
        (error) => error.reset === true || error.timeout === true)
      await expectServed(next)
      const restored = await instance.post('web-ingress', { port: webPort })
      assert.equal(restored.status, 200, JSON.stringify(restored.data))
      const status = await instance.status()
      assert.equal(status.webIngress.port, webPort)
      assert.equal(status.lan.listening, true, 'a web replacement never touches the direct listener')
    })

    await check('lifecycle: a direct rebind never strands an enabled web ingress', async () => {
      const status = await instance.status()
      assert.equal(status.webIngress.active, true)
      const prime = await directPending(instance)
      const moved = await instance.post('listen', { target: 'loopback' })
      assert.equal(moved.status, 200, JSON.stringify(moved.data))
      const after = await instance.status()
      assert.equal(after.webIngress.active, true, 'the web ingress still listens after a direct rebind')
      assert.equal(after.webIngress.port, webPort)
      // A direct request raised before the address moved keeps its existing meaning: the rebind
      // does not terminate upgraded sockets, so it is still approvable (spec 031: the direct
      // semantics are unchanged). Only a switch-off invalidates it.
      const stillApproved = await instance.post(`pending/${encodeURIComponent(prime.pending.requestId)}/approve`, {})
      assert.equal(stillApproved.status, 200, JSON.stringify(stillApproved.data))
      // A fresh direct request on the NEW attempt is approvable as well.
      const fresh = await directPending(instance)
      const approved = await instance.post(`pending/${encodeURIComponent(fresh.pending.requestId)}/approve`, {})
      assert.equal(approved.status, 200, JSON.stringify(approved.data))
      fresh.ws.close(1000)
    })

    await check('lifecycle: the global switch-off gates both ingresses, switch-on restores them', async () => {
      const off = await instance.post('remote-control', { enabled: false })
      assert.equal(off.status, 200, JSON.stringify(off.data))
      const status = await instance.status()
      assert.equal(status.webIngress.active, false)
      assert.equal(status.webIngress.listening, false)
      assert.equal(status.lan.listening, false)
      await assert.rejects(webUpgrade({ port: webPort, headers: { Origin: ORIGIN }, protocols: ['dsh-mobile-v1'] }),
        (error) => error.reset === true || error.timeout === true)
      const on = await instance.post('remote-control', { enabled: true })
      assert.equal(on.status, 200, JSON.stringify(on.data))
      await instance.post('gateway', { mode: 'persistent' })
      await instance.waitForLan()
      await statusUntil(instance, (value) => value.webIngress.active, 'web ingress restored after switch-on')
    })

    await check('lifecycle: a switch-on in TEMPORARY mode restores the web ingress too (reviewer round 3)', async () => {
      // Reviewer round-3 MAJOR: `temporary` with no connected client is the DEFAULT of
      // POST /mgw/gateway {enabled:true}, and that branch used to reopen only the direct
      // listener — an owner-enabled persisted ingress stayed down behind a global off/on.
      // Spec 031: the switch-on restores exactly what the switch-off closed.
      const enabled = await instance.post('web-ingress', { enabled: true, port: webPort })
      assert.equal(enabled.status, 200, JSON.stringify(enabled.data))
      await statusUntil(instance, (value) => value.webIngress.active, 'web ingress before the global off')
      for (const [label, body] of [['{enabled:true} (temporary default)', { enabled: true }], ['{mode:\'temporary\'}', { mode: 'temporary' }]]) {
        const off = await instance.post('remote-control', { enabled: false })
        assert.equal(off.status, 200, JSON.stringify(off.data))
        const down = await instance.status()
        assert.equal(down.webIngress.listening, false, `${label}: the switch-off closed the web listener`)
        assert.equal(down.lan.listening, false, `${label}: the switch-off closed the direct listener`)
        const on = await instance.post('remote-control', { enabled: true })
        assert.equal(on.status, 200, JSON.stringify(on.data))
        // Only the chosen mode is posted: a persistent selection would take the path the check
        // above already covers and hide the branch under test.
        const switched = await instance.post('gateway', body)
        assert.equal(switched.status, 200, JSON.stringify(switched.data))
        assert.equal(switched.data.gatewayMode, 'temporary', label)
        await instance.waitForLan()
        const status = await statusUntil(instance, (value) => value.webIngress.active, `${label}: web ingress restored after switch-on`)
        assert.equal(status.webIngress.port, webPort, `${label}: the SAME configured web port serves again`)
        // `active` is a flag: the port itself must answer, which is what a phone would see.
        await expectServed(webPort)
      }
    })

    await check('activation held across a GLOBAL off/on is not served by the restored listener (reviewer round 2)', async () => {
      // Reviewer round-2 MAJOR: the GLOBAL gateway switch (gatewayEnabled false -> true) is a
      // restoration path of its OWN — `setGatewayMode` -> reopenWebIngress -> openWebListener on
      // the SAME tuple and the same port. It moves only the web ATTEMPT generation
      // (`beginWebAttempt`), never the tuple generation an ingress identity carries, so an
      // authenticated socket whose activation was held across the switch read as live on the
      // restored listener.
      //
      // The credential is issued first through the REAL web OTP flow (Origin fence, proof, owner
      // approval); the held socket then presents it as `dsh-auth.<token>`, the token upgrade a
      // reload makes. The hold is keyed on the CREDENTIAL id, which the OTP offer cannot know, so
      // the pairing activation is released at once and only the token connection waits.
      const name = 'global-switch'
      let heldDeviceId
      const holds = []
      const gateway = await startGateway(name, {
        lanPort: await freePort(),
        gatewayStateFile: path.join(temp, `${name}-state.json`),
        deviceFile: path.join(temp, `${name}-devices.json`),
        testActivationHold: ({ deviceId }) => {
          if (deviceId !== heldDeviceId) return undefined
          const gate = Promise.withResolvers()
          holds.push(gate)
          return gate.promise
        },
      })
      const isKind = (kind) => (frame) => frame.kind === kind
      /** What the held socket saw by `deadlineMs`: a `paired`/`hello` (served) must never appear; a
       *  4401 close is the contract's "re-authenticate". */
      const settled = async (ws, deadlineMs) => {
        const seen = []
        ws.on('message', (data) => { try { seen.push(JSON.parse(data.toString()).kind) } catch { /* not a frame */ } })
        const closed = new Promise((resolve) => ws.once('close', (code) => resolve(code)))
        const served = new Promise((resolve) => {
          const inspect = () => {
            const found = seen.find((kind) => kind === 'hello' || kind === 'paired')
            if (found) resolve(`served:${found}`)
          }
          ws.on('message', inspect)
        })
        const outcome = await Promise.race([served, closed.then((code) => `closed:${code}`),
          delay(deadlineMs).then(() => 'no-close')])
        assert.equal(outcome, `closed:${CLOSE_REAUTH}`, `the held activation must close without paired/hello (${outcome}); frames=${JSON.stringify(seen)}`)
        await delay(400)
        assert.equal(seen.includes('paired') || seen.includes('hello'), false, `no paired/hello ever: ${JSON.stringify(seen)}`)
      }
      try {
        await gateway.waitForLan()
        const webPort = await freePort()
        const applied = await gateway.post('web-ingress', { enabled: true, port: webPort, origin: ORIGIN })
        assert.equal(applied.status, 200, JSON.stringify(applied.data))
        // 1. The real web OTP pairing on listener A issues the token; its activation is not held.
        const offer = await gateway.post('pair', { kind: 'mobile', mode: 'otp', scopes: ['sessions:read'] })
        assert.equal(offer.status, 201, JSON.stringify(offer.data))
        const first = new WebSocket(`wss://127.0.0.1:${webPort}/ws/mobile`, ['dsh-mobile-v1', 'dsh-pair-otp.v1'], {
          origin: ORIGIN, rejectUnauthorized: false, headers: { 'X-DSH-Device-ID': 'web-global-1' },
        })
        first.on('error', () => {})
        try {
          const stream = framesOf(first)
          stream.wsRef = [first]
          const challenge = await stream.next(isKind('pairing-challenge'))
          const clientNonce = crypto.randomBytes(18).toString('base64url')
          first.send(JSON.stringify({ type: 'pairing-proof', otpProof: otpProof(offer.data.otp, challenge.certSha256, clientNonce, challenge.serverNonce), clientNonce }))
          const pending = await stream.next(isKind('pairing-pending'))
          const approved = await gateway.post(`pending/${encodeURIComponent(pending.requestId)}/approve`, {})
          assert.equal(approved.status, 200, JSON.stringify(approved.data))
          const issued = await stream.next(isKind('paired'))
          assert.equal(issued.token.length, 43)
          heldDeviceId = approved.data.device.id
          assert.equal((await stream.next(isKind('hello'))).device.id, heldDeviceId)
          first.terminate()
          // 2. The SAME credential on listener A: authenticates, then waits on the hold.
          const held = new WebSocket(`wss://127.0.0.1:${webPort}/ws/mobile`, ['dsh-mobile-v1', `dsh-auth.${issued.token}`], {
            origin: ORIGIN, rejectUnauthorized: false, headers: { 'X-DSH-Device-ID': 'web-global-1' },
          })
          held.on('error', () => {})
          try {
            for (let attempt = 0; attempt < 400 && holds.length === 0; attempt += 1) await delay(5)
            assert.equal(holds.length, 1, 'the token socket reaches activation (and is held there)')
            // 3. Global off, then on: one switch, both ingresses; the owner tuple is unchanged.
            const off = await gateway.post('remote-control', { enabled: false })
            assert.equal(off.status, 200, JSON.stringify(off.data))
            assert.equal((await gateway.status()).webIngress.listening, false, 'the switch-off closed listener A')
            assert.deepEqual(createGatewayState(gateway.stateFile).webIngress, { enabled: true, port: webPort, origin: ORIGIN })
            const on = await gateway.post('remote-control', { enabled: true })
            assert.equal(on.status, 200, JSON.stringify(on.data))
            await gateway.post('gateway', { mode: 'persistent' })
            await gateway.waitForLan()
            await statusUntil(gateway, (value) => value.webIngress.active, 'web ingress restored after the switch-on')
            assert.equal((await gateway.status()).webIngress.port, webPort, 'restored on the same tuple')
            // 4. The hold outlives the switch: this socket is not served by the current listener.
            holds[0].resolve()
            await settled(held, 4000)
          } finally {
            for (const gate of holds) gate.resolve()
            held.terminate()
          }
          // 5. The restoration itself is healthy: a fresh token connection through activation on
          //    the restored listener reaches `hello` (the device record was never revoked). The
          //    hold is disarmed first: the point under test is the stale socket, not this one.
          heldDeviceId = undefined
          for (const gate of holds) gate.resolve()
          const fresh = await webToken(gateway, webPort, issued.token)
          assert.equal((await fresh.stream.next(isKind('hello'), 4000)).kind, 'hello')
          fresh.ws.terminate()
        } finally {
          first.terminate()
        }
      } finally {
        for (const gate of holds) gate.resolve()
        await gateway.close()
      }
    })

    await check('direct path unchanged: v3 payload pins the gateway leaf, never the Serve origin', async () => {
      const created = await instance.post('pair', { kind: 'desktop' })
      assert.equal(created.status, 201, JSON.stringify(created.data))
      const payload = created.data.payload
      const status = await instance.status()
      assert.equal(payload.version, 3)
      assert.equal(Array.isArray(payload.endpoints), true)
      assert.equal(payload.certSha256, status.tls.fingerprint256)
      const serveHost = new URL(ORIGIN).hostname
      for (const endpoint of [payload.publicUrl, ...payload.endpoints]) {
        assert.equal(endpoint.startsWith('wss://'), true, endpoint)
        assert.notEqual(new URL(endpoint).hostname, serveHost, 'a Serve name is never a pinned endpoint')
      }
      assert.equal('webIngress' in payload, false)
      assert.equal(JSON.stringify(payload).includes(serveHost), false)
      assert.equal(created.data.svg.startsWith('<svg'), true)
    })

    await check('proxy B vs direct A: pinning A fails on B before any credential is sent', async () => {
      // A: the gateway's direct TLS listener (its npm-installed test identity generator supplies
      // the impostor leaf too, so no external tool is needed).
      const status = await instance.status()
      const realPin = status.tls.fingerprint256
      const { loadOrCreateTlsIdentity, tlsServerOptions } = await import('../lib/tls.mjs')
      const identity = await loadOrCreateTlsIdentity({ directory: path.join(temp, 'impostor-tls') })
      const impostor = https.createServer(tlsServerOptions(identity), (req, res) => res.writeHead(200).end('ok'))
      await new Promise((resolve) => impostor.listen(0, '127.0.0.1', resolve))
      const impostorPort = impostor.address().port
      assert.notEqual(String(identity.fingerprint256).toLowerCase(), realPin, 'the impostor presents its own leaf')
      let applicationData = false
      impostor.on('secureConnection', (socket) => socket.on('data', () => { applicationData = true }))
      // The pinned client: read the leaf first, compare, and only then send the upgrade. On a
      // mismatch it aborts — the same order lib/devices' `openPinnedTlsSocket` uses.
      const outcome = await new Promise((resolve, reject) => {
        const socket = tls.connect({ host: '127.0.0.1', port: impostorPort, rejectUnauthorized: false })
        socket.once('secureConnect', () => {
          const actual = crypto.createHash('sha256').update(socket.getPeerCertificate().raw).digest('hex')
          if (actual.toLowerCase() !== realPin) { socket.destroy(); resolve({ pinMismatch: true, sent: false }); return }
          socket.write(`GET /ws/mobile HTTP/1.1\r\nHost: 127.0.0.1\r\nConnection: Upgrade\r\nUpgrade: websocket\r\nSec-WebSocket-Version: 13\r\nSec-WebSocket-Key: ${crypto.randomBytes(16).toString('base64')}\r\nX-DSH-Device-ID: pinned-device\r\nSec-WebSocket-Protocol: dsh-mobile-v1, dsh-pair.00000000\r\n\r\n`)
          resolve({ pinMismatch: false, sent: true })
        })
        socket.once('error', reject)
      })
      assert.deepEqual(outcome, { pinMismatch: true, sent: false })
      await delay(50)
      assert.equal(applicationData, false, 'no credential and no upgrade reached B')
      await new Promise((resolve) => impostor.close(resolve))
    })
  } finally {
    await instance.close()
  }

  // ---------------------------------------------------------------------------------------
  // 3. Restart: the persisted tuple comes back, and a disabled one stays off
  // ---------------------------------------------------------------------------------------
  const restartDirect = await freePort()
  const restartWeb = await freePort()
  const restartState = path.join(temp, 'restart-state.json')
  createGatewayState(restartState).setWebIngress({ enabled: true, port: restartWeb, origin: ORIGIN })
  const restarted = await startGateway('restart', {
    lanPort: restartDirect,
    gatewayStateFile: restartState,
    deviceFile: path.join(temp, 'restart-devices.json'),
  })
  try {
    await restarted.waitForLan()
    const status = await statusUntil(restarted, (value) => value.webIngress.listening, 'persisted web ingress')
    assert.equal(status.webIngress.origin, ORIGIN)
    assert.equal(status.webIngress.port, restartWeb)
    assert.equal(status.webIngress.active, true)
    await expectServed(restartWeb)
    // A disabled tuple at start: no listener at all.
    createGatewayState(restartState).setWebIngress({ enabled: false, port: restartWeb, origin: ORIGIN })
  } finally {
    await restarted.close()
  }
  const afterDisable = await startGateway('restart-off', {
    lanPort: await freePort(),
    gatewayStateFile: restartState,
    deviceFile: path.join(temp, 'restart-off-devices.json'),
  })
  try {
    await afterDisable.waitForLan()
    const status = await afterDisable.status()
    assert.equal(status.webIngress.enabled, false)
    assert.equal(status.webIngress.listening, false)
    await assert.rejects(webUpgrade({ port: restartWeb, headers: { Origin: ORIGIN }, protocols: ['dsh-mobile-v1'] }),
      (error) => error.reset === true || error.timeout === true)
  } finally {
    await afterDisable.close()
  }

  if (failures.length > 0) {
    console.error(`\n${failures.length} check(s) failed:`)
    for (const entry of failures) console.error(` - ${entry.label}: ${entry.error?.message ?? entry.error}`)
    process.exitCode = 1
  } else {
    console.log('\nall spec-031 web ingress checks passed')
  }
} catch (error) {
  console.error(error?.stack ?? error)
  process.exitCode = 1
}
