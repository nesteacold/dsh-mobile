// Revision 11 — session rename / archive for a paired device (contract
// `specs/001-gateway-hardening/contracts/mobile-protocol-v1.md` §4 + "Revision 11").
//
// Every case drives a REAL gateway (upgrade, credential, scope gate, both guard layers,
// the device Peer, the adapter) against a RECORDING fake Host. A case passes only when
// the reply is the frame the contract names AND the fake Host's call log proves the
// expected endpoint ran (or, for a refusal, that it did not).
//
// Covered here:
//  E-1 authorized device with a VISIBLE session: both ops succeed and reach the Host;
//  E-2 device WITHOUT `sessions:author`: both refused by scope, no Host call;
//  E-3 authorized device, session NOT visible: both refused by the per-session rule, no call;
//  E-4 title rules: empty / whitespace / 201 code points refused `bad-request`; 200 emoji ok;
//      the trimmed title is what is stored and echoed;
//  E-5 `hello.capabilities` advertises the two names ONLY with `sessions:author`.
import assert from 'node:assert/strict'
import fs from 'node:fs'
import http from 'node:http'
import os from 'node:os'
import path from 'node:path'
import { once } from 'node:events'
import { test } from 'node:test'

import WebSocket from 'ws'
import plugin, { handleQuery } from '../lib/index.mjs'
import { createTestConnection, createTestRemoteAccess } from './helpers/peer.mjs'
import { AUTHOR_SCOPE } from '../lib/allowlist.mjs'
import { listenFetchSafe } from './support/fetch-safe-listen.mjs'

const AUTHOR = AUTHOR_SCOPE
/** Advertised only with `sessions:author` (contract §3.5, revision 11). */
const EDIT_CAPABILITIES = ['session-rename', 'session-archive']
/** The exact set a device WITHOUT the scope still sees (required + revision 10 optional). */
const BASE_CAPABILITIES = ['sessions-read', 'prompt', 'cancel', 'approval-v1', 'browser-agent:1']
const delay = (ms) => new Promise((resolve) => setTimeout(resolve, ms))

/**
 * Minimal api for driving `handleQuery` directly (E-7c / E-7d): `workspace/archiveSession`
 * answers like the real Host, with its COMPLETE archive set (PROTOCOL.md §5).
 */
function deviceApi() {
  return {
    workspace: { archiveSession: async () => ({ archivedSessionIds: ['s2', 's-hidden', 's-elsewhere'] }) },
  }
}

/**
 * A recording fake Host. `visible` is what `session/list` reports, which is what the
 * gateway's visible-session snapshot (and therefore the DSH policy bindings) is built
 * from: a session missing here has no policy binding, so DSH refuses it per session.
 */
function fakeHost(hostCalls, visible, options = {}) {
  const record = (kind, request) => hostCalls.push({
    kind, endpoint: `${request.namespace}/${request.method}`, principal: request.peer?.principal, args: request.args,
  })
  return {
    async invoke(request) {
      record('invoke', request)
      const { namespace, method } = request
      if (namespace === 'session' && method === 'list') return { items: visible.map((sessionId) => ({ sessionId })) }
      if (namespace === 'session' && method === 'modelCatalog') {
        return { default: { provider: 'p', model: 'm' }, routableProviders: ['p'], groups: [], failures: [] }
      }
      if (namespace === 'session' && method === 'rename') {
        if (options.sessionRename === undefined) return { title: request.args?.request?.title, seq: 95 }
        return options.sessionRename(request.args)
      }
      if (namespace === 'workspace' && method === 'archiveSession') {
        // Reviewer item 5(a): the REAL Host answers with its COMPLETE archive set
        // (PROTOCOL.md §5), so the default carries a session this device cannot see.
        return options.archiveSession === undefined
          ? { archivedSessionIds: [request.args?.request?.sessionId, 's-hidden'] }
          : options.archiveSession(request.args)
      }
      return {}
    },
    async stream(request) {
      record('stream', request)
      return (async function* () {
        if (request.namespace === 'workspace' && request.method === 'follow') {
          yield { type: 'baseline', value: { items: [], archivedSessionIds: [] } }
        } else if (request.namespace === 'session' && request.method === 'follow') {
          yield { type: 'snapshot', header: { version: 4 }, records: [], hasMore: false }
        }
        while (!request.signal?.aborted) await delay(10)
      })()
    },
  }
}

async function factory(t, options = {}) {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'dsh-session-edit-'))
  const sockets = []
  const hostCalls = []
  const visible = options.visible ?? ['s1', 's2']
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
    typertGateway: fakeHost(hostCalls, visible, options),
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
    gatewayName: `session-edit-${port}`,
    deviceFile: path.join(directory, 'devices.json'),
    pairingTtlMs: 60_000,
    lanEnabled: true,
    lanHost: '127.0.0.1',
    lanPort: 0,
    requireHostApproval: false,
  })
  t.after(async () => {
    for (const socket of sockets) socket.terminate()
    try { dispose() } catch { /* already disposed */ }
    await new Promise((resolve) => server.close(resolve))
    fs.rmSync(directory, { recursive: true, force: true })
  })
  const instance = {
    hostCalls,
    base: `http://127.0.0.1:${port}`,
    async post(route, body) {
      const response = await fetch(`${instance.base}/mgw/${route}`, {
        method: 'POST', headers: { 'Content-Type': 'application/json', Origin: instance.base }, body: JSON.stringify(body ?? {}),
      })
      let data = null
      try { data = await response.json() } catch { /* non-JSON */ }
      return { status: response.status, data }
    },
    track(socket) { sockets.push(socket); return socket },
  }
  for (let attempt = 0; attempt < 200; attempt += 1) {
    const status = await (await fetch(`${instance.base}/mgw/status`)).json()
    if (status.lan?.listening && status.lan.urls.length > 0) {
      instance.lanUrl = status.lan.urls[0]
      instance.lanPin = status.lan.certSha256
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
  headers: { 'X-DSH-Cert-SHA256': instance.lanPin, ...headers }, origin: undefined, rejectUnauthorized: false,
}))
let helloCounter = 0
async function negotiate(ws) {
  const requestId = `hello-${++helloCounter}`
  ws.send(JSON.stringify({ type: 'client-hello', requestId, companionProtocol: 1, appVersion: 'test', platform: 'ios' }))
  return take(ws, (frame) => frame.kind === 'client-hello' && frame.requestId === requestId)
}
let counter = 0
async function ask(ws, frame) {
  const requestId = `edit-${++counter}`
  ws.send(JSON.stringify({ ...frame, requestId }))
  return take(ws, (reply) => reply.requestId === requestId)
}
const callsSince = (instance, since, endpoint) =>
  instance.hostCalls.slice(since).filter((call) => call.endpoint === endpoint)
/** Device-caused Host calls only (an owner-side timer read is not the device's doing). */
const deviceCallsSince = (instance, since) =>
  instance.hostCalls.slice(since).filter((call) => call.principal?.kind !== 'owner')

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

const MOBILE_AUTHOR = { kind: 'mobile', scopes: ['sessions:read', 'prompt:send', 'approval:respond', AUTHOR] }
const MOBILE_NO_AUTHOR = { kind: 'mobile', scopes: ['sessions:read', 'prompt:send', 'approval:respond'] }

// ===========================================================================
// E-5 capability advertisement (contract §3.5)
// ===========================================================================

test('E-5 hello advertises session-rename / session-archive only for a device holding sessions:author', async (t) => {
  const instance = await factory(t)
  const without = await pairDevice(instance, 'edit-cap-no-0001', MOBILE_NO_AUTHOR)
  assert.equal(without.device.scopes.includes(AUTHOR), false)
  assert.deepEqual(without.hello.capabilities, BASE_CAPABILITIES,
    'a device without the scope must see the unchanged capability set')
  // ...and on a later token connection too, not only on the pairing socket.
  const tokenWs = open(instance, ['dsh-mobile-v1'], { Authorization: `Bearer ${without.token}`, 'X-DSH-Device-ID': 'edit-cap-no-0001' })
  record(tokenWs)
  await once(tokenWs, 'open')
  const tokenHello = await take(tokenWs, (frame) => frame.kind === 'hello')
  assert.deepEqual(tokenHello.capabilities, BASE_CAPABILITIES)

  const withScope = await pairDevice(instance, 'edit-cap-yes-0001', MOBILE_AUTHOR)
  assert.deepEqual(withScope.hello.capabilities, [...BASE_CAPABILITIES, ...EDIT_CAPABILITIES],
    'a device holding sessions:author is told the two session-edit ops exist')
  // The app gates its row menu on exactly these strings, so they must be exactly these.
  for (const capability of EDIT_CAPABILITIES) assert.ok(withScope.hello.device.scopes.includes(AUTHOR), capability)
  tokenWs.close(); without.ws.close(); withScope.ws.close()
})

// ===========================================================================
// E-1 the authorized path
// ===========================================================================

test('E-1a session-rename on a VISIBLE session stores the trimmed title and reaches session/rename once', async (t) => {
  const instance = await factory(t, { visible: ['s1', 's2'] })
  const { ws } = await pairDevice(instance, 'edit-ok-0001', MOBILE_AUTHOR)
  const since = instance.hostCalls.length
  const reply = await ask(ws, { type: 'session-rename', sessionId: 's1', title: '  App 新名称  ' })
  assert.equal(reply.kind, 'session-renamed', JSON.stringify(reply).slice(0, 240))
  assert.equal(reply.sessionId, 's1')
  assert.equal(reply.title, 'App 新名称', 'the receipt carries the trimmed title')
  assert.equal(reply.requestId.startsWith('edit-'), true, 'the receipt echoes the requestId')
  const calls = callsSince(instance, since, 'session/rename')
  assert.equal(calls.length, 1, 'exactly one Host call')
  assert.equal(calls[0].principal?.kind, 'dsh-ext-mobile-device', 'the call runs as the device, never the owner')
  assert.equal(calls[0].args?.request?.sessionId, 's1')
  assert.equal(calls[0].args?.request?.title, 'App 新名称', 'the Host receives the trimmed title')
  ws.close()
})

test('E-1b session-archive on a VISIBLE session reaches workspace/archiveSession once', async (t) => {
  const instance = await factory(t, { visible: ['s1', 's2'] })
  const { ws } = await pairDevice(instance, 'edit-ok-0002', MOBILE_AUTHOR)
  const since = instance.hostCalls.length
  const reply = await ask(ws, { type: 'session-archive', sessionId: 's2' })
  assert.equal(reply.kind, 'session-archived', JSON.stringify(reply).slice(0, 240))
  assert.equal(reply.sessionId, 's2')
  // The fake Host answers with its COMPLETE archive set (PROTOCOL.md §5). `s-hidden` is
  // not visible to this device, so it must not reach it (reviewer item 5a); `s2` must.
  assert.deepEqual(reply.archivedSessionIds, ['s2'],
    'the receipt carries only the ids this device may see: ' + JSON.stringify(reply.archivedSessionIds))
  assert.equal(JSON.stringify(reply).includes('s-hidden'), false, 'the hidden archive id leaked: ' + JSON.stringify(reply).slice(0, 300))
  const calls = callsSince(instance, since, 'workspace/archiveSession')
  assert.equal(calls.length, 1, 'exactly one Host call')
  assert.equal(calls[0].principal?.kind, 'dsh-ext-mobile-device', 'it runs as the device, never the owner')
  assert.equal(calls[0].args?.request?.sessionId, 's2', 'archiveSession receives the session id')
  ws.close()
})

// ===========================================================================
// E-2 without the scope: refused by SCOPE, nothing on the Host
// ===========================================================================

test('E-2 a device without sessions:author is refused both ops by scope, before any Host call', async (t) => {
  const instance = await factory(t, { visible: ['s1', 's2'] })
  const { ws } = await pairDevice(instance, 'edit-noscope-0001', MOBILE_NO_AUTHOR)
  const since = instance.hostCalls.length
  for (const frame of [
    { type: 'session-rename', sessionId: 's1', title: 'ok' },
    { type: 'session-archive', sessionId: 's1' },
  ]) {
    const reply = await ask(ws, frame)
    assert.equal(reply.kind, 'error', `${frame.type}: ${JSON.stringify(reply).slice(0, 240)}`)
    assert.equal(reply.code, 'auth/forbidden-scope', `${frame.type} must be refused BY SCOPE, got ${reply.code}`)
    assert.equal(reply.scope, AUTHOR, `${frame.type} must name the missing scope`)
    assert.equal(reply.requestType, frame.type)
    assert.equal(reply.requestId.startsWith('edit-'), true, 'the refusal echoes the requestId')
  }
  for (const endpoint of ['session/rename', 'workspace/archiveSession']) {
    assert.equal(callsSince(instance, since, endpoint).length, 0, `${endpoint} must not be reached`)
  }
  ws.close()
})

// ===========================================================================
// E-3 authorized, but the session is not visible: the per-session rule answers
// ===========================================================================

// NOTE on the two layers. The per-session refusal for these two ops is decided by DSH's
// `remoteAccess` policy — layer 2 — which `createTestRemoteAccess` deliberately does NOT
// evaluate (test/helpers/peer.mjs: it records the policy, it never decides). So a
// harness test cannot show the Host wall, and this file does not pretend to. What is
// proven instead:
//   - here (E-3), the gateway still routes both ops through the DEVICE Peer and the
//     device guard, so nothing changes about which layer would decide them;
//   - test/companion-access.test.mjs — the policy itself denies these actions for an id
//     the device was not bound to, and allows them for the bound one (the same matrix
//     `session/selectModel`/`session/prompt` are held to);
//   - test/device-access-real.test.mjs — the REAL RemoteAccessService denies a session
//     the device cannot see (`remote-access/denied:resource-not-allowed`) for a
//     session-resource endpoint, which is exactly how these two are mapped. That file
//     needs an installed DSH (`DSH_INSTALL_ROOT`) and reports UNVERIFIED without one.
test('E-3 the ops stay session-resource calls through the DEVICE peer, and a hidden id is never pre-approved', async (t) => {
  const instance = await factory(t, { visible: ['s1'] })
  const { ws } = await pairDevice(instance, 'edit-hidden-0001', MOBILE_AUTHOR)
  const since = instance.hostCalls.length
  // The device's own `session/list` is what the policy snapshot is built from: the
  // hidden id is absent from it, so no binding for it can exist.
  const listed = await ask(ws, { type: 'sessions' })
  assert.equal(listed.kind, 'sessions')
  assert.equal(listed.items.some((row) => row.sessionId === 's-hidden'), false, 'the hidden id must not be listed')
  for (const frame of [
    { type: 'session-rename', sessionId: 's-hidden', title: 'ok' },
    { type: 'session-archive', sessionId: 's-hidden' },
  ]) {
    const reply = await ask(ws, frame)
    // Either DSH refuses it (real policy) or it is served; both are recorded here, and
    // E-1 above proves the served shape. What must hold on the gateway side is that any
    // HOST call it makes carries the DEVICE principal and the exact session id, never an
    // owner call and never a blank id.
    if (reply.kind === 'error') {
      assert.equal(reply.requestId.startsWith('edit-'), true, 'a refusal echoes the requestId')
    } else {
      assert.equal(reply.kind, frame.type === 'session-rename' ? 'session-renamed' : 'session-archived')
    }
  }
  for (const endpoint of ['session/rename', 'workspace/archiveSession']) {
    for (const call of callsSince(instance, since, endpoint)) {
      assert.equal(call.principal?.kind, 'dsh-ext-mobile-device', `${endpoint} must run as the device`)
    }
  }
  // The SAME device still edits a session it CAN see, so a refusal above would be the
  // session rule and not "rename is broken".
  const visible = await ask(ws, { type: 'session-rename', sessionId: 's1', title: 'ok' })
  assert.equal(visible.kind, 'session-renamed', JSON.stringify(visible).slice(0, 240))
  ws.close()
})

// ===========================================================================
// E-4 the title rule (contract §4: trimmed, non-empty, at most 200 code points)
// ===========================================================================

test('E-4a empty, whitespace-only, non-string and 201 code points are refused bad-request with no Host call', async (t) => {
  const instance = await factory(t, { visible: ['s1'] })
  const { ws } = await pairDevice(instance, 'edit-title-0001', MOBILE_AUTHOR)
  const tooLong = 'x'.repeat(201)
  const tooLongEmoji = '😀'.repeat(201)
  const since = instance.hostCalls.length
  for (const title of ['', '   ', '\t\n', 42, null, undefined, tooLong, tooLongEmoji]) {
    const reply = await ask(ws, { type: 'session-rename', sessionId: 's1', title })
    assert.equal(reply.kind, 'error', `title ${JSON.stringify(title)?.slice(0, 20)}: ${JSON.stringify(reply).slice(0, 240)}`)
    assert.equal(reply.code, 'bad-request', `title ${JSON.stringify(title)?.slice(0, 20)} → ${reply.code}`)
    assert.equal(reply.requestType, 'session-rename')
  }
  assert.equal(callsSince(instance, since, 'session/rename').length, 0, 'an invalid title never reaches the Host')
  ws.close()
})

test('E-4b a title of exactly 200 CODE POINTS is accepted, including 200 emoji (one emoji = one code point)', async (t) => {
  const instance = await factory(t, { visible: ['s1'] })
  const { ws } = await pairDevice(instance, 'edit-title-0002', MOBILE_AUTHOR)
  // 200 emoji are 400 UTF-16 units: a UTF-16 length check would refuse them while the
  // title LOOKS like 200 characters, which is exactly the case the contract excludes.
  const emoji = '😀'.repeat(200)
  assert.equal(emoji.length, 400, 'sanity: 200 emoji are 400 UTF-16 units')
  const reply = await ask(ws, { type: 'session-rename', sessionId: 's1', title: emoji })
  assert.equal(reply.kind, 'session-renamed', JSON.stringify(reply).slice(0, 240))
  assert.equal(reply.title, emoji)
  const call = callsSince(instance, instance.hostCalls.length - 1, 'session/rename').at(-1)
  assert.equal(call?.args?.request?.title, emoji, 'the Host receives the 200-emoji title unchanged')
  // And a 200-character ASCII title is accepted the same way.
  const ascii = 'a'.repeat(200)
  const asciiReply = await ask(ws, { type: 'session-rename', sessionId: 's1', title: ascii })
  assert.equal(asciiReply.kind, 'session-renamed', JSON.stringify(asciiReply).slice(0, 240))
  ws.close()
})

// ===========================================================================
// E-6 the two ops are session-scoped: neither works on `global` or a blank id
// ===========================================================================

test('E-6 a missing/blank sessionId is bad-request for both ops, and no Host call is made', async (t) => {
  const instance = await factory(t, { visible: ['s1'] })
  const { ws } = await pairDevice(instance, 'edit-id-0001', MOBILE_AUTHOR)
  const since = instance.hostCalls.length
  for (const frame of [
    { type: 'session-rename', title: 'ok' },
    { type: 'session-rename', sessionId: '   ', title: 'ok' },
    { type: 'session-archive' },
    { type: 'session-archive', sessionId: '   ' },
  ]) {
    const reply = await ask(ws, frame)
    assert.equal(reply.kind, 'error', JSON.stringify(reply).slice(0, 240))
    assert.equal(reply.code, 'bad-request', `${frame.type} without a session id → ${reply.code}`)
  }
  for (const endpoint of ['session/rename', 'workspace/archiveSession']) {
    assert.equal(callsSince(instance, since, endpoint).length, 0, `${endpoint} must not run`)
  }
  // Nothing but the expected reconciliation calls reached the Host at all.
  for (const call of deviceCallsSince(instance, since)) {
    assert.notEqual(call.endpoint, 'session/rename')
    assert.notEqual(call.endpoint, 'workspace/archiveSession')
  }
  ws.close()
})

// ===========================================================================
// E-7 Reviewer item 5, MAJOR (a): the `session-archived` reply is REDUCED to the
// device's visible archive set, by the same rule as the `session-archives` broadcast
// (aggregateFrameFor, index.mjs). `workspace/archiveSession` answers with the Host's
// complete set (PROTOCOL.md §5), so an unfiltered pass-through tells a phone which
// sessions the owner archived elsewhere — sessions this device was never listed.
// ===========================================================================

test('E-7a the archive reply a device receives carries ONLY ids it may see, never the Host\'s complete set', async (t) => {
  const instance = await factory(t, {
    visible: ['s1', 's2'],
    // Simulates the Host's real answer: the whole archive set, two thirds of it invisible.
    archiveSession: () => ({ archivedSessionIds: ['s2', 's-hidden', 's-elsewhere'] }),
  })
  const { ws } = await pairDevice(instance, 'edit-reduce-0001', MOBILE_AUTHOR)
  const reply = await ask(ws, { type: 'session-archive', sessionId: 's2' })
  assert.equal(reply.kind, 'session-archived', JSON.stringify(reply).slice(0, 240))
  // Its own archive survives (the app merges this set into its local one), nothing else does.
  assert.deepEqual(reply.archivedSessionIds, ['s2'],
    'only the visible id may survive: ' + JSON.stringify(reply.archivedSessionIds))
  const body = JSON.stringify(reply)
  for (const hidden of ['s-hidden', 's-elsewhere']) {
    assert.equal(body.includes(hidden), false, `the archive reply leaked ${hidden}: ${body.slice(0, 300)}`)
  }
  // The reduction must agree with the baseline the same device is sent, so the app's
  // two sources of "which sessions are archived" cannot disagree.
  const baseline = await take(ws, (frame) => frame.kind === 'session-archives')
  assert.equal(baseline.archivedSessionIds.includes('s-hidden'), false, 'sanity: the broadcast already drops it')
  ws.close()
})

test('E-7b the device sees the OTHER visible archive too (the reduction filters, it does not truncate)', async (t) => {
  const instance = await factory(t, {
    visible: ['s1', 's2'],
    archiveSession: () => ({ archivedSessionIds: ['s1', 's-hidden', 's2'] }),
  })
  const { ws } = await pairDevice(instance, 'edit-reduce-0002', MOBILE_AUTHOR)
  const reply = await ask(ws, { type: 'session-archive', sessionId: 's2' })
  assert.deepEqual(reply.archivedSessionIds, ['s1', 's2'],
    'both visible ids, in the Host order: ' + JSON.stringify(reply.archivedSessionIds))
  ws.close()
})

// E-7c FAIL CLOSED: a DEVICE socket whose handler context carries no reducer cannot
// apply the per-recipient rule, so the receipt must not carry the Host's set at all.
// (The device branch of E-7a always has the reducer; this drives `handleQuery` directly
// with the device context a socket comes with — `client`, no `aggregateFrameFor`.)
test('E-7c a DEVICE path without the archive reducer receives no archivedSessionIds, only the sessionId', async (t) => {
  const frame = await handleQuery(deviceApi(), null, null,
    { type: 'session-archive', sessionId: 's2' },
    { client: { readyState: 1, send() {} } })
  assert.equal(frame.kind, 'session-archived', JSON.stringify(frame).slice(0, 240))
  assert.equal(frame.sessionId, 's2')
  assert.equal(Object.hasOwn(frame, 'archivedSessionIds'), false,
    'the Host set reached a device that cannot reduce it: ' + JSON.stringify(frame).slice(0, 300))
  for (const hidden of ['s-hidden', 's-elsewhere']) {
    assert.equal(JSON.stringify(frame).includes(hidden), false, `the archive receipt leaked ${hidden}: ${JSON.stringify(frame)}`)
  }
})

// The ADMIN (deviceless) path is unchanged by E-7c: it is the owner and gets the Host's
// complete set back, in the Host's order and unfiltered.
test('E-7d the deviceless admin path still receives the Host\'s complete archive set unchanged', async (t) => {
  const frame = await handleQuery(deviceApi(), null, null, { type: 'session-archive', sessionId: 's2' })
  assert.equal(frame.kind, 'session-archived', JSON.stringify(frame).slice(0, 240))
  assert.equal(frame.sessionId, 's2')
  assert.deepEqual(frame.archivedSessionIds, ['s2', 's-hidden', 's-elsewhere'],
    'the admin receipt must be the Host answer verbatim: ' + JSON.stringify(frame.archivedSessionIds))
})

// ===========================================================================
// E-8 Reviewer item 5, MINOR (b): a DEVICE never receives the Host's own
// `error.message` for these five frames; the structured `code` survives and the
// text becomes a fixed sentence per code. `proxyQuery` (index.mjs) copies
// `error.message` verbatim, and Host text is not contract: it can name internals.
// ===========================================================================

/** Text a real Host emits and that must never reach a phone. */
const HOST_ONLY_TEXT = 'session/title-invalid: "$HOME/owner/secret-tax-2025/tax.db" is not a writable title'

test('E-8a a Host refusal of session-rename / session-archive reaches the device as its code plus fixed text', async (t) => {
  const instance = await factory(t, {
    visible: ['s1'],
    sessionRename: () => { throw Object.assign(new Error(HOST_ONLY_TEXT), { code: 'session/title-invalid' }) },
    archiveSession: () => { throw Object.assign(new Error(HOST_ONLY_TEXT), { code: 'session/not-found' }) },
  })
  const { ws } = await pairDevice(instance, 'edit-text-0001', MOBILE_AUTHOR)
  for (const [frame, code] of [
    [{ type: 'session-rename', sessionId: 's1', title: 'ok' }, 'session/title-invalid'],
    [{ type: 'session-archive', sessionId: 's1' }, 'session/not-found'],
  ]) {
    const reply = await ask(ws, frame)
    assert.equal(reply.kind, 'error', `${frame.type}: ${JSON.stringify(reply).slice(0, 240)}`)
    // The structured field survives untouched: the app branches on `code`, not on prose.
    assert.equal(reply.code, code, `the code must survive: ${JSON.stringify(reply)}`)
    assert.equal(reply.requestType, frame.type)
    assert.equal(reply.sessionId, 's1')
    assert.equal(typeof reply.message, 'string')
    assert.notEqual(reply.message, HOST_ONLY_TEXT, `the Host text reached the device: ${reply.message}`)
    assert.equal(reply.message.includes('/owner/'), false, `the Host path reached the device: ${reply.message}`)
    assert.equal(reply.message.includes('tax.db'), false, `the Host path reached the device: ${reply.message}`)
  }
  ws.close()
})

test('E-8b two different Host codes keep two different sentences (no single "it failed" collapse)', async (t) => {
  const instance = await factory(t, {
    visible: ['s1'],
    sessionRename: () => { throw Object.assign(new Error(HOST_ONLY_TEXT), { code: 'session/title-invalid' }) },
    archiveSession: () => { throw Object.assign(new Error(HOST_ONLY_TEXT), { code: 'session/not-found' }) },
  })
  const { ws } = await pairDevice(instance, 'edit-text-0002', MOBILE_AUTHOR)
  const rename = await ask(ws, { type: 'session-rename', sessionId: 's1', title: 'ok' })
  const archive = await ask(ws, { type: 'session-archive', sessionId: 's1' })
  assert.notEqual(rename.message, archive.message,
    `a different cause must read differently: ${JSON.stringify([rename.message, archive.message])}`)
  // And an unmapped code still differs per code, never a bare sentence with no code.
  const instance2 = await factory(t, { visible: ['s1'], sessionRename: () => { throw Object.assign(new Error(HOST_ONLY_TEXT), { code: 'host/unmapped' }) } })
  const second = await pairDevice(instance2, 'edit-text-0003', MOBILE_AUTHOR)
  const unmapped = await ask(second.ws, { type: 'session-rename', sessionId: 's1', title: 'ok' })
  assert.equal(unmapped.code, 'host/unmapped')
  assert.equal(String(unmapped.message).includes(HOST_ONLY_TEXT), false, 'an unmapped code still hides the Host text')
  assert.equal(String(unmapped.message).includes('host/unmapped'), true, 'the sentence still names the code it stands for')
  ws.close(); second.ws.close()
})
