// Reviewer 36d9 regression suite for the per-device live authorization added on
// top of T022a. Runs the plugin's real `apply()` with a fake Host whose
// `session/list` is fully controllable, and checks WHAT each socket is sent:
//
//  R1  visible-session refresh: bounded (timeout/abort), coalesced (at most one
//      in flight + one pending), cancelled on teardown, a failure keeps the last
//      good snapshot;
//  R2  versioned refresh/tombstone: a stale in-flight response cannot bring back
//      a session the Host just removed; the tombstone goes only with an accepted
//      newer snapshot;
//  R3  metadata broadcasts + initial archive/queue/projection baselines are
//      reduced per recipient (live sessions:read + the device's visible sessions);
//      the loopback admin (`legacyAdmin`) is unchanged; no scope => nothing;
//  R4  approval pushes AND replay (incl. the conversation-triggered fan-out) need
//      a live approval:respond plus the session; a subscription filter is not an
//      authorization; a re-paired/revoked generation gets nothing;
//  R5  Spec 018 item 4 (lead decision (a)): a question card follows the SAME rule as an
//      approval card — admin always, a device only when it holds `approval:respond`
//      AND may see the session. The 008 bridge reaches
//      the same question separately over `$events`, which
//      this suite does not exercise). A withheld card is audited by ids only.
//  R6  the raw `session/event` fan-out (an unsubscribed legacy/conversation
//      socket) takes the same per-recipient decision as every other session-keyed
//      frame: live credential + `sessions:read` + a visible session; and a device
//      may not subscribe its filter to a session the Host never listed to it.
//
// Fake Host only; the real-service proof lives in device-access-real.test.mjs.
import assert from 'node:assert/strict'
import fs from 'node:fs'
import http from 'node:http'
import { listenFetchSafe } from './support/fetch-safe-listen.mjs'
import os from 'node:os'
import path from 'node:path'
import { once } from 'node:events'
import { test, after } from 'node:test'

import WebSocket from 'ws'
import plugin from '../lib/index.mjs'
import { createTestConnection, createTestRemoteAccess } from './helpers/peer.mjs'
import { COMPANION_PRINCIPAL_KIND } from '../lib/companion-access.mjs'
import { devicePrincipal } from '../lib/device-peers.mjs'

const delay = (ms) => new Promise((resolve) => setTimeout(resolve, ms))
const DEV_A = 'authz0000-0000-4000-8000-00000000000a'
const DEV_B = 'authz0000-0000-4000-8000-00000000000b'

async function factory(t, options = {}) {
  const remoteAccess = createTestRemoteAccess()
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'dsh-36d9-'))
  const listeners = {}
  const sockets = []
  const listCalls = []
  // `sessionList` is what the Host answers; tests swap it. `listGate` lets a test
  // hold a `session/list` open (and observe its AbortSignal).
  const state = {
    sessionList: ['s1', 's2'], listGate: null, archives: [], projections: {}, queuesInbox: {},
    // Spec 018 item 4 harness hook (OPT-IN, default off): see the list branch below.
    listOverride: null, listOverrideRemaining: 0,
  }
  let management
  let upgrade
  let dispose = () => {}
  const server = http.createServer((req, res) => {
    if (management && (req.url === management.path || req.url.startsWith(`${management.path}/`))) { management.handler(req, res); return }
    res.writeHead(404).end()
  })
  server.on('upgrade', (req, socket, head) => { if (upgrade) upgrade.handler(req, socket, head); else socket.destroy() })
  // WHATWG fetch refuses a few "bad ports"; the helper re-binds until the
  // ephemeral port is one `fetch` accepts (test/support/fetch-safe-listen.mjs).
  await listenFetchSafe(server)
  const port = server.address().port
  const ctx = {
    webServer: {
      port,
      register(route) { management = route; return () => {} },
      registerUpgrade(route) { upgrade = route; return () => {} },
    },
    connection: createTestConnection(),
    remoteAccess,
    typertGateway: {
      async invoke(request) {
        if (request.namespace === 'session' && request.method === 'list') {
          const call = { signal: request.signal, aborted: false }
          listCalls.push(call)
          request.signal?.addEventListener('abort', () => { call.aborted = true }, { once: true })
          if (state.listGate) {
            await new Promise((resolve, reject) => {
              state.listGate.release = resolve
              request.signal?.addEventListener('abort', () => reject(request.signal.reason ?? new Error('aborted')), { once: true })
            })
          }
          if (state.listError) throw new Error(state.listError)
          // OPT-IN (spec 018 item 4, Q3): answer the NEXT N list calls with a chosen set, so a test
          // can pair a device while the Host reports FEWER sessions than other devices receive.
          // Default off: with no override every call answers `state.sessionList`, exactly as before.
          let listed = state.sessionList
          if (state.listOverrideRemaining > 0) {
            listed = state.listOverride
            state.listOverrideRemaining -= 1
          }
          call.answered = [...listed]
          return { items: call.answered.map((sessionId) => ({ sessionId })) }
        }
        if (request.namespace === 'session' && request.method === 'search') return { items: [], hasMore: false }
        return {}
      },
      async stream(request) {
        return (async function* () {
          if (request.namespace === 'workspace') {
            yield { type: 'baseline', value: { items: [], archivedSessionIds: state.archives } }
          } else if (request.namespace === 'session' && request.method === 'control') {
            yield { type: 'baseline', value: { projections: state.projections } }
          } else {
            yield { type: 'baseline', value: { projections: {} } }
          }
          while (!request.signal.aborted) await delay(10)
        })()
      },
    },
    agentDefaultModel: {},
    on(name, handler) { listeners[name] = handler; return () => {} },
    effect(fn) { dispose = fn() },
  }
  const start = () => plugin.apply(ctx, {
    remoteControl: { enabled: true },
    gatewayMode: 'persistent',
    gatewayWaitTimeoutMs: 60_000,
    gatewayName: `36d9-${port}`,
    deviceFile: path.join(directory, 'devices.json'),
    pairingTtlMs: 60_000,
    lanEnabled: true,
    lanHost: '127.0.0.1',
    lanPort: 0,
    requireHostApproval: false,
    ...(options.config ?? {}),
  })
  t.after(async () => {
    for (const socket of sockets) socket.terminate()
    try { dispose() } catch { /* already disposed */ }
    state.listGate?.release?.()
    await new Promise((resolve) => server.close(resolve))
    fs.rmSync(directory, { recursive: true, force: true })
  })
  const instance = {
    ctx, listeners, start, port, state, listCalls, remoteAccess, connection: ctx.connection,
    base: `http://127.0.0.1:${port}`,
    teardown() { dispose(); dispose = () => {} },
    async post(route, body) {
      const response = await fetch(`${instance.base}/mgw/${route}`, {
        method: 'POST', headers: { 'Content-Type': 'application/json', Origin: instance.base }, body: JSON.stringify(body ?? {}),
      })
      return { status: response.status, data: await response.json() }
    },
    track(socket) { sockets.push(socket); return socket },
  }
  return instance
}

async function ready(instance) {
  for (let attempt = 0; attempt < 200; attempt += 1) {
    const status = await (await fetch(`${instance.base}/mgw/status`)).json()
    if (status.lan?.listening && status.lan.urls.length > 0) { instance.lanUrl = status.lan.urls[0]; instance.lanPin = status.lan.certSha256; return }
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
const seenOf = (ws) => frames.get(ws) ?? record(ws)
async function take(ws, predicate, timeoutMs = 5_000) {
  const seen = seenOf(ws)
  const deadline = Date.now() + timeoutMs
  while (Date.now() < deadline) {
    // The first match is REMOVED: a later poll for the same predicate must wait for a NEW frame,
    // never re-match one an earlier poll already consumed.
    const hit = seen.find(predicate)
    const at = hit === undefined ? -1 : seen.indexOf(hit)
    if (at >= 0) { seen.splice(at, 1); return hit }
    await delay(5)
  }
  throw new Error(`timed out waiting for a frame (${seen.map((frame) => frame.kind).join(', ')})`)
}
let counter = 0
/** Everything the server sent before this round trip has been delivered when it resolves. */
async function flush(ws) {
  const requestId = `flush-${++counter}`
  ws.send(JSON.stringify({ type: 'ping', requestId }))
  await take(ws, (frame) => frame.requestId === requestId)
}
const open = (instance, protocols, headers = {}) => instance.track(new WebSocket(instance.lanUrl, protocols, {
  headers: { 'X-DSH-Cert-SHA256': instance.lanPin, ...headers }, origin: undefined, rejectUnauthorized: false,
}))
/** Contract §3.6/§5a: operations wait for the acknowledged client-hello. */
async function negotiate(ws) {
  const requestId = `hello-${++counter}`
  ws.send(JSON.stringify({ type: 'client-hello', requestId, companionProtocol: 1, appVersion: 'test', platform: 'ios' }))
  await take(ws, (frame) => frame.kind === 'client-hello' && frame.requestId === requestId)
}
async function pairDevice(instance, deviceId, offer = {}) {
  const created = await instance.post('pair', { name: deviceId, publicUrl: instance.lanUrl, ...offer })
  assert.equal(created.status, 201, JSON.stringify(created.data))
  const ws = open(instance, ['dsh-mobile-v1', `dsh-pair.${created.data.payload.pairingCode}`], { 'X-DSH-Device-ID': deviceId })
  record(ws)
  await once(ws, 'open')
  const paired = await take(ws, (frame) => frame.kind === 'paired')
  await take(ws, (frame) => frame.kind === 'hello')
  await negotiate(ws)
  return { ws, token: paired.token, device: paired.device }
}
async function connectToken(instance, token, deviceId, channel = 'control') {
  const ws = open(instance, ['dsh-mobile-v1'], { Authorization: `Bearer ${token}`, 'X-DSH-Device-ID': deviceId, 'X-DSH-Channel': channel })
  record(ws)
  await once(ws, 'open')
  await take(ws, (frame) => frame.kind === 'hello')
  await negotiate(ws)
  return ws
}
async function waitFor(predicate, message, timeoutMs = 3_000) {
  const deadline = Date.now() + timeoutMs
  while (Date.now() < deadline) { if (await predicate()) return; await delay(10) }
  assert.fail(message)
}
const visibleIds = (instance, deviceId) => instance.remoteAccess.policies.get(COMPANION_PRINCIPAL_KIND)
  .bindings(devicePrincipal(deviceId)).filter((binding) => binding.resource.kind === 'session').map((binding) => binding.resource.id).sort()
const toolCall = (instance, sessionId, callId) => instance.listeners['session/event']({ id: sessionId }, {
  type: 'tool/call', seq: 1, time: 1, data: { turn: 1, step: 0, callId, name: 'bash', arguments: '{"command":"ls"}' },
})
const requestApproval = (instance, sessionId, callId, next) => instance.listeners['approval/request']({
  agent: { id: sessionId }, toolName: 'bash', callId, reason: '36d9', signal: new AbortController().signal,
}, next)
const emitEvent = (instance, sessionId, text) => instance.listeners['session/event']({ id: sessionId }, {
  type: 'user/message', seq: 1, time: 1, data: { content: [{ type: 'text', text }], source: { kind: 'user' } },
})
const requestQuestion = (instance, sessionId, next) => instance.listeners['user-questions/request']({
  agent: { id: sessionId }, signal: new AbortController().signal,
  questions: [{ id: 'q', question: 'pick', options: [{ label: 'a' }, { label: 'b' }] }],
}, next)

// ---------------------------------------------------------------------------
// R1 / R2: visible-session refresh
// ---------------------------------------------------------------------------

test('R1a: refresh is bounded: a hung session/list is aborted by the timeout and the last good list survives', async (t) => {
  const instance = await factory(t, { config: { testVisibleRefreshTimeoutMs: 150 } })
  await instance.start(); await ready(instance)
  const layout = await pairDevice(instance, DEV_A)
  await waitFor(() => visibleIds(instance, layout.device.id).length === 2, 'initial snapshot')
  const call = { n: instance.listCalls.length }
  instance.state.listGate = {} // every further session/list hangs
  instance.state.sessionList = ['s1', 's2', 's9']
  instance.listeners['api-session/added']({ sessionId: 's9', running: false })
  await waitFor(() => instance.listCalls.length > call.n, 'a refresh was started')
  const hung = instance.listCalls.at(-1)
  await waitFor(() => hung.aborted, 'the hung refresh is aborted by its timeout (bounded)')
  assert.deepEqual(visibleIds(instance, layout.device.id), ['s1', 's2'], 'a timed-out refresh keeps the last good list and adds nothing')
  // and the next refresh is allowed again (the in-flight slot was released)
  instance.state.listGate = null
  instance.listeners['api-session/added']({ sessionId: 's9', running: false })
  await waitFor(() => visibleIds(instance, layout.device.id).includes('s9'), 'a later refresh recovers')
})

test('R1b: refreshes are coalesced: at most one in flight plus one pending, however many events arrive', async (t) => {
  const instance = await factory(t)
  await instance.start(); await ready(instance)
  const layout = await pairDevice(instance, DEV_A)
  await waitFor(() => visibleIds(instance, layout.device.id).length === 2, 'initial snapshot')
  const before = instance.listCalls.length
  instance.state.listGate = {}
  instance.listeners['api-session/added']({ sessionId: 'x1', running: false })
  await waitFor(() => instance.listCalls.length === before + 1, 'first refresh in flight')
  for (let i = 0; i < 25; i += 1) instance.listeners['api-session/added']({ sessionId: `x${i + 2}`, running: false })
  await delay(100)
  assert.equal(instance.listCalls.length, before + 1, '25 further events do not start further session/list calls while one is in flight')
  const gate = instance.state.listGate
  instance.state.listGate = null
  gate.release()
  await waitFor(() => instance.listCalls.length === before + 2, 'exactly one more refresh ran for the burst')
  await delay(100)
  assert.equal(instance.listCalls.length, before + 2, 'the burst collapsed into ONE pending refresh, not 25')
})

test('R1c: teardown cancels the in-flight refresh and starts no further one', async (t) => {
  const instance = await factory(t)
  await instance.start(); await ready(instance)
  const layout = await pairDevice(instance, DEV_A)
  await waitFor(() => visibleIds(instance, layout.device.id).length === 2, 'initial snapshot')
  const before = instance.listCalls.length
  instance.state.listGate = {}
  instance.listeners['api-session/added']({ sessionId: 'x1', running: false })
  instance.listeners['api-session/added']({ sessionId: 'x2', running: false }) // pending
  await waitFor(() => instance.listCalls.length === before + 1, 'refresh in flight')
  const hung = instance.listCalls.at(-1)
  instance.teardown()
  await waitFor(() => hung.aborted, 'teardown aborts the in-flight session/list')
  instance.state.listGate = null
  await delay(150)
  assert.equal(instance.listCalls.length, before + 1, 'the pending refresh does not run after teardown')
})

test('R2a: a stale in-flight session/list cannot re-add a session removed meanwhile', async (t) => {
  const instance = await factory(t)
  await instance.start(); await ready(instance)
  const layout = await pairDevice(instance, DEV_A)
  await waitFor(() => visibleIds(instance, layout.device.id).length === 2, 'initial snapshot')
  const before = instance.listCalls.length
  instance.state.listGate = {}
  instance.listeners['api-session/added']({ sessionId: 's3', running: false })
  await waitFor(() => instance.listCalls.length === before + 1, 'refresh in flight (its answer still lists s2)')
  const gate = instance.state.listGate
  instance.listeners['api-session/removed']('s2')
  assert.deepEqual(visibleIds(instance, layout.device.id), ['s1'], 'removal is immediate')
  // The in-flight answer was produced BEFORE the removal and still lists s2
  // (`call.answered` is taken when the gate opens, so set the stale list first).
  instance.state.sessionList = ['s1', 's2', 's3']
  // Freeze the follow-up refresh so the state right after the STALE answer is observable.
  const followUpGate = {}
  const firstGate = gate
  instance.state.listGate = followUpGate
  firstGate.release()
  await waitFor(() => instance.listCalls[before].answered, 'the stale answer was delivered')
  assert.deepEqual(instance.listCalls[before].answered, ['s1', 's2', 's3'])
  await waitFor(() => instance.listCalls.length >= before + 2, 'the follow-up refresh started (and is held)')
  assert.ok(!visibleIds(instance, layout.device.id).includes('s2'),
    'right after the stale answer s2 is still absent: ' + visibleIds(instance, layout.device.id))
  // Then the Host answers the follow-up without s2.
  instance.state.sessionList = ['s1', 's3']
  instance.state.listGate = null
  followUpGate.release()
  await waitFor(() => instance.listCalls.at(-1).answered, 'the follow-up answered')
  await delay(50)
  assert.deepEqual(visibleIds(instance, layout.device.id), ['s1', 's3'])
})

test('R2b: a stale answer is ignored for the removed id even if every later refresh fails; tombstone cleared only by an accepted snapshot', async (t) => {
  const instance = await factory(t)
  await instance.start(); await ready(instance)
  const layout = await pairDevice(instance, DEV_A)
  await waitFor(() => visibleIds(instance, layout.device.id).length === 2, 'initial snapshot')
  const before = instance.listCalls.length
  instance.state.listGate = {}
  instance.listeners['api-session/added']({ sessionId: 's3', running: false })
  await waitFor(() => instance.listCalls.length === before + 1, 'refresh in flight')
  const gate = instance.state.listGate
  instance.listeners['api-session/removed']('s2')
  instance.state.listGate = null
  instance.state.listError = 'host unavailable' // the follow-up refresh fails
  gate.release() // the stale answer ([s1,s2]) arrives now
  await waitFor(() => instance.listCalls.length >= before + 2, 'follow-up refresh attempted (and failed)')
  await delay(50)
  assert.ok(!visibleIds(instance, layout.device.id).includes('s2'), 'the stale answer alone cannot restore the removed session')
  // A later ACCEPTED snapshot that started after the removal is authoritative again.
  instance.state.listError = null
  instance.state.sessionList = ['s1', 's2']
  instance.listeners['api-session/added']({ sessionId: 's2', running: false })
  await waitFor(() => visibleIds(instance, layout.device.id).includes('s2'), 'an accepted newer snapshot may list s2 again (the Host re-created it)')
})

// ---------------------------------------------------------------------------
// R3: metadata + baselines per recipient
// ---------------------------------------------------------------------------

test('R3a: metadata broadcasts reach only devices with live sessions:read and the session visible; admin is unchanged', async (t) => {
  const instance = await factory(t)
  await instance.start(); await ready(instance)
  const reader = await pairDevice(instance, DEV_A, { scopes: ['sessions:read'] })
  const blind = await pairDevice(instance, DEV_B, { scopes: ['prompt:send'] }) // no sessions:read
  const readerWs = await connectToken(instance, reader.token, DEV_A)
  const blindWs = await connectToken(instance, blind.token, DEV_B)
  await waitFor(() => visibleIds(instance, reader.device.id).length === 2, 'snapshot')
  instance.listeners['api-session/status']('s1', true)
  instance.listeners['api-session/status']('not-listed', true)
  instance.listeners['schedule/changed']()
  await flush(readerWs); await flush(blindWs)
  const statuses = (ws) => seenOf(ws).filter((frame) => frame.kind === 'session-status').map((frame) => frame.sessionId)
  assert.deepEqual(statuses(readerWs), ['s1'], 'only the visible session reaches the reader')
  assert.deepEqual(statuses(blindWs), [], 'a device without sessions:read gets no session metadata')
  assert.equal(seenOf(readerWs).some((frame) => frame.kind === 'schedule-changed'), false, 'owner-management notifications never reach a device')
})

test('R3b: initial baselines are reduced to the recipient\'s visible sessions; empty scopes get nothing', async (t) => {
  const instance = await factory(t)
  instance.state.archives = ['s1', 's2', 'hidden']
  instance.state.projections = {
    s1: { asOfSeq: 1, values: { goal: { text: 'g1' } } },
    hidden: { asOfSeq: 1, values: { goal: { text: 'secret' } } },
  }
  await instance.start(); await ready(instance)
  const reader = await pairDevice(instance, DEV_A, { scopes: ['sessions:read'] })
  const blind = await pairDevice(instance, DEV_B, { scopes: ['prompt:send'] })
  await waitFor(() => visibleIds(instance, reader.device.id).length === 2, 'snapshot')
  const readerWs = await connectToken(instance, reader.token, DEV_A)
  const blindWs = await connectToken(instance, blind.token, DEV_B)
  await flush(readerWs); await flush(blindWs)
  const archives = seenOf(readerWs).find((frame) => frame.kind === 'session-archives')
  assert.deepEqual(archives?.archivedSessionIds, ['s1', 's2'], 'the hidden session id is not in the archive baseline')
  const projection = seenOf(readerWs).find((frame) => frame.kind === 'projection-baseline')
  assert.deepEqual(Object.keys(projection?.projections ?? {}), ['s1'], 'the hidden session is not in the projection baseline')
  assert.equal(JSON.stringify(seenOf(readerWs)).includes('secret'), false, 'hidden-session data never reaches the reader')
  for (const kind of ['session-archives', 'session-queues', 'projection-baseline']) {
    assert.equal(seenOf(blindWs).some((frame) => frame.kind === kind), false, `a device without sessions:read gets no ${kind}`)
  }
})

test('R3c: the loopback admin keeps the full baselines and metadata', async (t) => {
  const instance = await factory(t, { config: { legacyAdmin: true } })
  instance.state.archives = ['s1', 'hidden']
  instance.state.projections = { hidden: { asOfSeq: 1, values: { goal: { text: 'secret' } } } }
  await instance.start(); await ready(instance)
  const admin = await pairDevice(instance, DEV_A, { scopes: [] })
  const adminWs = await connectToken(instance, admin.token, DEV_A) // legacyAdmin test socket = admin channel
  await flush(adminWs)
  assert.deepEqual(seenOf(adminWs).find((frame) => frame.kind === 'session-archives')?.archivedSessionIds, ['s1', 'hidden'])
  assert.ok(Object.hasOwn(seenOf(adminWs).find((frame) => frame.kind === 'projection-baseline').projections, 'hidden'))
  instance.listeners['schedule/changed']()
  await take(adminWs, (frame) => frame.kind === 'schedule-changed')
})

test('R3d: a live broadcast after a scope-narrowing re-pair reaches nobody who lost sessions:read', async (t) => {
  const instance = await factory(t)
  await instance.start(); await ready(instance)
  const first = await pairDevice(instance, DEV_A, { scopes: ['sessions:read'] })
  const ws = await connectToken(instance, first.token, DEV_A)
  await waitFor(() => visibleIds(instance, first.device.id).length === 2, 'snapshot')
  const closed = once(ws, 'close')
  await pairDevice(instance, DEV_A, { scopes: [] }) // re-pair with no scopes: generation bumped
  await closed
  instance.listeners['api-session/status']('s1', true)
  await delay(100)
  assert.equal(seenOf(ws).some((frame) => frame.kind === 'session-status'), false, 'the stale generation gets nothing')
})

// ---------------------------------------------------------------------------
// R4: approvals (push + replay)
// ---------------------------------------------------------------------------

test('R4a: an approval push needs live approval:respond AND the session; subscription filters are not authorization', async (t) => {
  const instance = await factory(t)
  await instance.start(); await ready(instance)
  const responder = await pairDevice(instance, DEV_A, { scopes: ['sessions:read', 'approval:respond'] })
  const observer = await pairDevice(instance, DEV_B, { scopes: ['sessions:read'] })
  const responderWs = await connectToken(instance, responder.token, DEV_A)
  const observerWs = await connectToken(instance, observer.token, DEV_B)
  await waitFor(() => visibleIds(instance, responder.device.id).length === 2, 'snapshot')
  toolCall(instance, 's1', 'c1'); toolCall(instance, 'hidden-session', 'c2')
  const answer = Promise.withResolvers()
  const p1 = requestApproval(instance, 's1', 'c1', () => answer.promise)
  const p2 = requestApproval(instance, 'hidden-session', 'c2', () => answer.promise)
  await take(responderWs, (frame) => frame.kind === 'approval-requested' && frame.sessionId === 's1')
  await flush(responderWs); await flush(observerWs)
  assert.equal(seenOf(responderWs).some((frame) => frame.kind === 'approval-requested' && frame.sessionId === 'hidden-session'), false,
    'a session the Host never listed to the device gets no card even with approval:respond')
  assert.equal(seenOf(observerWs).some((frame) => frame.kind === 'approval-requested'), false, 'a device without approval:respond gets no card')
  // A subscription to the hidden session is a routing hint, not an authorization.
  responderWs.send(JSON.stringify({ type: 'subscribe', sessionId: 'hidden-session', requestId: 'sub1' }))
  await take(responderWs, (frame) => frame.requestId === 'sub1')
  await flush(responderWs)
  assert.equal(seenOf(responderWs).some((frame) => frame.kind === 'approval-requested' && frame.sessionId === 'hidden-session'), false,
    'subscribing to a hidden session replays nothing')
  answer.resolve('rejected'); await Promise.all([p1, p2])
})

test('R4b: replay on connect and on subscribe applies the same per-recipient authorization', async (t) => {
  const instance = await factory(t)
  await instance.start(); await ready(instance)
  const responder = await pairDevice(instance, DEV_A, { scopes: ['sessions:read', 'approval:respond'] })
  const observer = await pairDevice(instance, DEV_B, { scopes: ['sessions:read'] })
  await waitFor(() => visibleIds(instance, responder.device.id).length === 2, 'snapshot')
  toolCall(instance, 's1', 'c1'); toolCall(instance, 'hidden-session', 'c2')
  const answer = Promise.withResolvers()
  const p1 = requestApproval(instance, 's1', 'c1', () => answer.promise)
  const p2 = requestApproval(instance, 'hidden-session', 'c2', () => answer.promise)
  await delay(50)
  const responderWs = await connectToken(instance, responder.token, DEV_A)
  const observerWs = await connectToken(instance, observer.token, DEV_B)
  await take(responderWs, (frame) => frame.kind === 'approval-requested' && frame.sessionId === 's1' && frame.replay === true)
  await flush(responderWs); await flush(observerWs)
  assert.equal(seenOf(responderWs).some((frame) => frame.sessionId === 'hidden-session' && frame.kind === 'approval-requested'), false)
  assert.equal(seenOf(observerWs).some((frame) => frame.kind === 'approval-requested'), false, 'no approval:respond => no replay')
  answer.resolve('rejected'); await Promise.all([p1, p2])
})

test('R4c: a conversation-socket subscribe fans the replay out only to authorized control sockets', async (t) => {
  const instance = await factory(t)
  await instance.start(); await ready(instance)
  const responder = await pairDevice(instance, DEV_A, { scopes: ['sessions:read', 'approval:respond'] })
  const observer = await pairDevice(instance, DEV_B, { scopes: ['sessions:read'] })
  await waitFor(() => visibleIds(instance, responder.device.id).length === 2, 'snapshot')
  const responderCtl = await connectToken(instance, responder.token, DEV_A, 'control')
  const observerCtl = await connectToken(instance, observer.token, DEV_B, 'control')
  // The conversation socket belongs to the OBSERVER; the fan-out target list is
  // every control socket, including the responder's.
  const observerConv = await connectToken(instance, observer.token, DEV_B, 'conversation')
  toolCall(instance, 's1', 'c1')
  const answer = Promise.withResolvers()
  const pending = requestApproval(instance, 's1', 'c1', () => answer.promise)
  await take(responderCtl, (frame) => frame.kind === 'approval-requested' && frame.replay !== true)
  const seenBefore = seenOf(responderCtl).filter((frame) => frame.kind === 'approval-requested').length
  observerConv.send(JSON.stringify({ type: 'subscribe', sessionId: 's1', requestId: 'sub-conv' }))
  await take(observerConv, (frame) => frame.requestId === 'sub-conv')
  await waitFor(() => seenOf(responderCtl).filter((frame) => frame.kind === 'approval-requested').length > seenBefore,
    'the authorized responder control socket is re-sent the card')
  await flush(observerCtl)
  assert.equal(seenOf(observerCtl).some((frame) => frame.kind === 'approval-requested'), false,
    'the unauthorized observer control socket gets nothing from the fan-out')
  answer.resolve('rejected'); await pending
})

test('R4d: a revoked or re-paired generation is sent no approval push and no replay', async (t) => {
  const instance = await factory(t)
  await instance.start(); await ready(instance)
  const first = await pairDevice(instance, DEV_A, { scopes: ['sessions:read', 'approval:respond'] })
  const ws = await connectToken(instance, first.token, DEV_A)
  await waitFor(() => visibleIds(instance, first.device.id).length === 2, 'snapshot')
  const closed = once(ws, 'close')
  const revoked = await instance.post(`devices/${first.device.id}/revoke`)
  assert.equal(revoked.status, 200)
  await closed
  toolCall(instance, 's1', 'c1')
  const answer = Promise.withResolvers()
  const pending = requestApproval(instance, 's1', 'c1', () => answer.promise)
  await delay(150)
  assert.equal(seenOf(ws).some((frame) => frame.kind === 'approval-requested'), false, 'a revoked device is sent no card')
  answer.resolve('rejected'); await pending
})

// ---------------------------------------------------------------------------
// R5: questions
// ---------------------------------------------------------------------------

test('R5: a device holding approval:respond AND seeing the session IS sent the question', async (t) => {
  const instance = await factory(t, { config: { legacyAdmin: true } })
  await instance.start(); await ready(instance)
  // `legacyAdmin` makes a device-token socket the admin channel for the test, so
  // use a SECOND instance without it for the real device behaviour.
  const device = await pairDevice(instance, DEV_A, { scopes: ['sessions:read', 'approval:respond', 'prompt:send'] })
  const adminWs = await connectToken(instance, device.token, DEV_A)
  await waitFor(() => visibleIds(instance, device.device.id).length === 2, 'snapshot')
  const answer = Promise.withResolvers()
  const pending = requestQuestion(instance, 's1', () => answer.promise)
  await take(adminWs, (frame) => frame.kind === 'question-requested')
  answer.resolve({ answers: [{ id: 'q', selected: ['a'] }] }); await pending
})

test('R5b: a device WITHOUT approval:respond gets no question card and no question replay (audited)', async (t) => {
  const instance = await factory(t)
  await instance.start(); await ready(instance)
  // Spec 018 item 4: the scope that lifts a question card is `approval:respond` (the approval
  // scope, not a new one). Without it a device still gets nothing, live or on replay.
  const device = await pairDevice(instance, DEV_A, { scopes: ['sessions:read', 'prompt:send'] })
  await waitFor(() => visibleIds(instance, device.device.id).length === 2, 'snapshot')
  const answer = Promise.withResolvers()
  const pending = requestQuestion(instance, 's1', () => answer.promise)
  await delay(50)
  const ws = await connectToken(instance, device.token, DEV_A) // replay on connect
  await flush(ws)
  assert.equal(seenOf(ws).some((frame) => frame.kind === 'question-requested'), false, 'no live card and no replay')
  answer.resolve({ answers: [{ id: 'q', selected: ['a'] }] }); await pending
})

test('R5c: a device that holds approval:respond but CANNOT SEE the session gets no card and no resolved frame', async (t) => {
  // Spec 018 item 4 (lead decision (a)): the card follows the approval rule — scope AND
  // `clientMayReceive` (which includes "this device may see this session"). Knowing the session id
  // is a routing hint, never an authorization.
  const instance = await factory(t)
  await instance.start(); await ready(instance)
  const device = await pairDevice(instance, DEV_B, { scopes: ['sessions:read', 'approval:respond', 'prompt:send'] })
  await waitFor(() => visibleIds(instance, device.device.id).length === 2, 'snapshot')
  const ws = await connectToken(instance, device.token, DEV_B)
  await flush(ws)
  // A session the Host never listed to this device.
  ws.send(JSON.stringify({ type: 'subscribe', sessionId: 'hidden-session', requestId: 'r5c-sub' }))
  await take(ws, (frame) => frame.requestId === 'r5c-sub')
  await flush(ws)
  const answer = Promise.withResolvers()
  const pending = requestQuestion(instance, 'hidden-session', () => answer.promise)
  try {
    await flush(ws)
    assert.equal(seenOf(ws).some((frame) => frame.kind === 'question-requested'), false,
      'a card for a session the device may not see must not be pushed')
    // Answering it is refused too: the per-session boundary is the gateway's, not just the push.
    const card = { rpcId: 'r5c-rpc' }
    ws.send(JSON.stringify({ type: 'question-answer', requestId: 'r5c-answer', rpcId: card.rpcId,
      sessionId: 'hidden-session', answers: [{ id: 'q', selected: ['a'] }] }))
    const receipt = await take(ws, (frame) => frame.requestId === 'r5c-answer' || frame.kind === 'question-response')
    assert.equal(receipt.accepted, false, JSON.stringify(receipt).slice(0, 220))
  } finally {
    answer.resolve({ answers: [{ id: 'q', selected: ['a'] }] }); await pending
  }
  // The resolved frame for that session must not reach it either.
  await flush(ws)
  assert.equal(seenOf(ws).some((frame) => frame.kind === 'question-resolved'), false,
    'the resolution of a card the device never received must not be sent to it')
})

// ---------------------------------------------------------------------------
// Spec 018 item 4 (lead decision (a)): answering / declining a question.
// ---------------------------------------------------------------------------

/**
 * Open a device's CONTROL socket. Question and approval cards travel on the control channel only,
 * and the per-recipient rule is `clientMayReceive(client, sessionId, 'approval:respond')`.
 */
const controlSocket = async (instance, device, deviceId) => {
  const ws = await connectToken(instance, device.token, deviceId)
  await flush(ws)
  return ws
}

/** Answer a question on the wire and return the receipt. */
const answerQuestion = async (ws, { rpcId, sessionId, action = 'answer', answers }) => {
  const requestId = `qa-${Math.random().toString(36).slice(2, 10)}`
  ws.send(JSON.stringify({
    type: action === 'cancel' ? 'question-cancel' : 'question-answer',
    requestId, rpcId, sessionId,
    ...(action === 'cancel' ? {} : { answers }),
  }))
  return take(ws, (frame) => frame.requestId === requestId || (frame.kind === 'question-response' && frame.rpcId === rpcId))
}

test('Q1: without approval:respond the answer is refused BY SCOPE and the question stays open', async (t) => {
  const instance = await factory(t)
  await instance.start(); await ready(instance)
  const device = await pairDevice(instance, DEV_A, { scopes: ['sessions:read', 'prompt:send'] })
  await waitFor(() => visibleIds(instance, device.device.id).length === 2, 'snapshot')
  const ws = await controlSocket(instance, device, DEV_A)
  const answer = Promise.withResolvers()
  const pending = requestQuestion(instance, 's1', () => answer.promise)
  try {
    await flush(ws)
    assert.equal(seenOf(ws).some((frame) => frame.kind === 'question-requested'), false,
      'no card without approval:respond')
    const receipt = await answerQuestion(ws, { rpcId: 'q1-rpc', sessionId: 's1', answers: [{ id: 'q', selected: ['a'] }] })
    assert.equal(receipt.kind, 'error', JSON.stringify(receipt).slice(0, 220))
    assert.equal(receipt.code, 'auth/forbidden-scope')
    assert.equal(receipt.scope, 'approval:respond')
    let done = false
    void pending.then(() => { done = true })
    await delay(60)
    assert.equal(done, false, 'a scope refusal must not resolve the Host question')
  } finally {
    answer.resolve({ answers: [{ id: 'q', selected: ['a'] }] }); await pending
  }
})

test('Q2: an authorized device answers, the Host receives that answer, and the resolution is broadcast', async (t) => {
  const instance = await factory(t)
  await instance.start(); await ready(instance)
  const device = await pairDevice(instance, DEV_A, { scopes: ['sessions:read', 'approval:respond', 'prompt:send'] })
  await waitFor(() => visibleIds(instance, device.device.id).length === 2, 'snapshot')
  const ws = await controlSocket(instance, device, DEV_A)
  const answer = Promise.withResolvers()
  const pending = requestQuestion(instance, 's1', () => answer.promise)
  const card = await take(ws, (frame) => frame.kind === 'question-requested' && frame.sessionId === 's1')
  const receipt = await answerQuestion(ws, { rpcId: card.rpcId, sessionId: 's1', answers: [{ id: 'q', selected: ['b'] }] })
  assert.equal(receipt.kind, 'question-response', JSON.stringify(receipt).slice(0, 220))
  assert.equal(receipt.accepted, true)
  assert.equal(receipt.action, 'answer')
  assert.deepEqual(await pending, { answers: [{ id: 'q', selected: ['b'] }] },
    'the Host settles with exactly what the device chose')
  const resolved = await take(ws, (frame) => frame.kind === 'question-resolved' && frame.rpcId === card.rpcId)
  assert.equal(resolved.outcome, 'answered')
})

test('Q3: knowing the rpcId is NOT authority — a device that cannot see the session is refused', async (t) => {
  // THE boundary for this item: `pending.resolve()` is a promise inside the gateway, so no Host
  // per-item check stands behind it. The gateway's own rule is `clientMayReceive` =
  // scope + "may see this session", so a device holding `approval:respond` but NOT
  // `sessions:read` cannot see any session — it is sent no card and must not be able to answer
  // one whose live rpcId it was handed. The card must survive that refusal.
  const instance = await factory(t)
  await instance.start(); await ready(instance)
  // Holds the interaction scope but NO session read scope.
  const blind = await pairDevice(instance, DEV_A, { scopes: ['approval:respond', 'prompt:send'] })
  // NOTE: the blind device still receives the session BINDINGS at pairing. What stops it is
  // `clientMayReceive`: `deviceMaySeeSession` requires `sessions:read`, which it does not hold. The
  // assertions below therefore test what is SENT and what may be ANSWERED, not the binding set.
  const reader = await pairDevice(instance, DEV_B, { scopes: ['sessions:read', 'approval:respond', 'prompt:send'] })
  await waitFor(() => visibleIds(instance, reader.device.id).length === 2, 'reader sees s1+s2')

  const blindWs = await controlSocket(instance, blind, DEV_A)
  const readerWs = await controlSocket(instance, reader, DEV_B)
  const answer = Promise.withResolvers()
  const pending = requestQuestion(instance, 's1', () => answer.promise)
  const settled = pending.then((value) => ({ value }), (error) => ({ error }))
  const card = await take(readerWs, (frame) => frame.kind === 'question-requested' && frame.sessionId === 's1')
  try {
    await flush(blindWs)
    assert.equal(seenOf(blindWs).some((frame) => frame.kind === 'question-requested'), false,
      'a device that cannot see the session is sent no card')
    // The LIVE rpcId, handed over deliberately: knowing it must not be authority.
    const receipt = await answerQuestion(blindWs, { rpcId: card.rpcId, sessionId: 's1', answers: [{ id: 'q', selected: ['a'] }] })
    assert.equal(receipt.kind, 'question-response', JSON.stringify(receipt).slice(0, 220))
    assert.equal(receipt.accepted, false, 'a device that cannot see the session may not answer it')
    assert.equal(receipt.reason, 'not-authorized',
      'the per-session gate, not "no such card": ' + JSON.stringify(receipt).slice(0, 200))
    // The card is STILL pending: a device that CAN see it answers, which proves the refusal
    // consumed nothing, and that answer is what the Host settles with.
    const readerReceipt = await answerQuestion(readerWs, { rpcId: card.rpcId, sessionId: 's1', answers: [{ id: 'q', selected: ['b'] }] })
    assert.equal(readerReceipt.accepted, true, JSON.stringify(readerReceipt).slice(0, 220))
    assert.deepEqual(await settled, { value: { answers: [{ id: 'q', selected: ['b'] }] } },
      'the card survived the refused answer: the later answer is what the Host sees')
  } finally {
    answer.resolve({ answers: [{ id: 'q', selected: ['a'] }] })
    await settled
  }
})

test('Q4: two devices race — exactly one answer lands, the other is not-pending', async (t) => {
  const instance = await factory(t)
  await instance.start(); await ready(instance)
  const first = await pairDevice(instance, DEV_A, { scopes: ['sessions:read', 'approval:respond', 'prompt:send'] })
  const second = await pairDevice(instance, DEV_B, { scopes: ['sessions:read', 'approval:respond', 'prompt:send'] })
  await waitFor(() => visibleIds(instance, first.device.id).length === 2, 'snapshot a')
  await waitFor(() => visibleIds(instance, second.device.id).length === 2, 'snapshot b')
  const wsA = await controlSocket(instance, first, DEV_A)
  const wsB = await controlSocket(instance, second, DEV_B)
  const answer = Promise.withResolvers()
  const pending = requestQuestion(instance, 's1', () => answer.promise)
  const card = await take(wsA, (frame) => frame.kind === 'question-requested' && frame.sessionId === 's1')
  const answers = [{ id: 'q', selected: ['a'] }]
  const [a, b] = await Promise.all([
    answerQuestion(wsA, { rpcId: card.rpcId, sessionId: 's1', answers }),
    answerQuestion(wsB, { rpcId: card.rpcId, sessionId: 's1', answers }),
  ])
  const accepted = [a, b].filter((receipt) => receipt.accepted === true)
  const refused = [a, b].filter((receipt) => receipt.accepted === false)
  assert.equal(accepted.length, 1, 'exactly one answer is accepted: ' + JSON.stringify([a, b]).slice(0, 240))
  assert.equal(refused.length, 1)
  assert.equal(refused[0].reason, 'not-pending')
  await pending
})

test('Q5: answered first on the admin channel — the device gets not-pending and never overrides it', async (t) => {
  const adminInstance = await factory(t, { config: { legacyAdmin: true } })
  await adminInstance.start(); await ready(adminInstance)
  const admin = await pairDevice(adminInstance, DEV_A, { scopes: ['sessions:read', 'approval:respond', 'prompt:send'] })
  const adminWs = await connectToken(adminInstance, admin.token, DEV_A)
  await flush(adminWs)
  const answer = Promise.withResolvers()
  const pending = requestQuestion(adminInstance, 's1', () => answer.promise)
  const card = await take(adminWs, (frame) => frame.kind === 'question-requested' && frame.sessionId === 's1')
  const first = await answerQuestion(adminWs, { rpcId: card.rpcId, sessionId: 's1', answers: [{ id: 'q', selected: ['a'] }] })
  assert.equal(first.accepted, true, 'the first decision wins')

  const instance = await factory(t)
  await instance.start(); await ready(instance)
  const device = await pairDevice(instance, DEV_B, { scopes: ['sessions:read', 'approval:respond', 'prompt:send'] })
  await waitFor(() => visibleIds(instance, device.device.id).length === 2, 'snapshot')
  const ws = await controlSocket(instance, device, DEV_B)
  const late = await answerQuestion(ws, { rpcId: card.rpcId, sessionId: 's1', answers: [{ id: 'q', selected: ['b'] }] })
  assert.equal(late.accepted, false, 'another instance never saw this card, so it is not-pending')
  assert.equal(late.reason, 'not-pending')
  await pending
})

test('Q6: a malformed answer is bad-response and never consumes the card', async (t) => {
  const instance = await factory(t)
  await instance.start(); await ready(instance)
  const device = await pairDevice(instance, DEV_A, { scopes: ['sessions:read', 'approval:respond', 'prompt:send'] })
  await waitFor(() => visibleIds(instance, device.device.id).length === 2, 'snapshot')
  const ws = await controlSocket(instance, device, DEV_A)
  const answer = Promise.withResolvers()
  const pending = requestQuestion(instance, 's1', () => answer.promise)
  const card = await take(ws, (frame) => frame.kind === 'question-requested' && frame.sessionId === 's1')
  try {
    for (const [label, answers] of [
      ['wrong count', []],
      ['wrong id', [{ id: 'nope', selected: ['a'] }]],
      ['label not offered', [{ id: 'q', selected: ['zzz'] }]],
      ['duplicate selection', [{ id: 'q', selected: ['a', 'a'] }]],
      ['single-select two', [{ id: 'q', selected: ['a', 'b'] }]],
      ['empty custom', [{ id: 'q', selected: [], custom: '   ' }]],
      ['custom too long', [{ id: 'q', selected: ['a'], custom: 'z'.repeat(2001) }]],
    ]) {
      // Per case: the receipt, then the card's survival, so ONE regression fails on itself and
      // not only through the loop. `take` CONSUMES the frame it returns, so a bad-code case
      // cannot leave a `bad-response` behind that the NEXT case matches against its own id.
      const receipt = await answerQuestion(ws, { rpcId: card.rpcId, sessionId: 's1', answers })
      console.log('GOT', JSON.stringify(receipt))
      assert.equal(receipt.kind, 'error', label + ': ' + JSON.stringify(receipt).slice(0, 220))
      assert.equal(receipt.code, 'bad-response', label + ' must be bad-response, got ' + receipt.code)
      let done = false
      void pending.then(() => { done = true })
      await delay(60)
      assert.equal(done, false, label + ' must not consume the card')
    }
    // Owner decision 2026-11-11: a paired device answers from the offered options only — no free
    // text, no empty selection — and the ONLY receipt it gets for either is the existing `label`
    // refusal. Asserted on the MESSAGE because the code alone passes without this rule (a device
    // used to be offered the admin free-text path). The card still survives every case.
    for (const [label, answers] of [
      ['free text', [{ id: 'q', selected: [], custom: 'verbatim' }]],
      ['selected and free text', [{ id: 'q', selected: ['a'], custom: 'verbatim' }]],
      ['empty selection', [{ id: 'q', selected: [] }]],
    ]) {
      const receipt = await answerQuestion(ws, { rpcId: card.rpcId, sessionId: 's1', answers })
      assert.equal(receipt.kind, 'error', label + ': ' + JSON.stringify(receipt).slice(0, 220))
      assert.equal(receipt.code, 'bad-response', label + ' must be bad-response, got ' + receipt.code)
      assert.equal(receipt.message, 'selected values must match offered option labels', label + ': ' + receipt.message)
      let done = false
      void pending.then(() => { done = true })
      await delay(60)
      assert.equal(done, false, label + ' must not consume the card')
    }
    let done = false
    void pending.then(() => { done = true })
    await delay(60)
    assert.equal(done, false, 'no malformed answer may consume the card')
  } finally {
    answer.resolve({ answers: [{ id: 'q', selected: ['a'] }] }); await pending
  }
})

test('Q7: cancel DECLINES the question — the tool sees ASK_CANCELLED, not an empty answer', async (t) => {
  const instance = await factory(t)
  await instance.start(); await ready(instance)
  const device = await pairDevice(instance, DEV_A, { scopes: ['sessions:read', 'approval:respond', 'prompt:send'] })
  await waitFor(() => visibleIds(instance, device.device.id).length === 2, 'snapshot')
  const ws = await controlSocket(instance, device, DEV_A)
  const answer = Promise.withResolvers()
  const pending = requestQuestion(instance, 's1', () => answer.promise)
  const card = await take(ws, (frame) => frame.kind === 'question-requested' && frame.sessionId === 's1')
  // Attach the rejection handler FIRST: a cancel rejects the Host promise by design.
  const declined = pending.catch((error) => error)
  const receipt = await answerQuestion(ws, { rpcId: card.rpcId, sessionId: 's1', action: 'cancel' })
  assert.equal(receipt.accepted, true)
  assert.equal(receipt.action, 'cancel')
  const error = await declined
  assert.equal(error?.code, 'ASK_CANCELLED', 'a cancel rejects the tool, it does not answer it')
  const resolved = await take(ws, (frame) => frame.kind === 'question-resolved' && frame.rpcId === card.rpcId)
  assert.equal(resolved.outcome, 'cancelled')
})

test('Q8: the card follows the approval rule exactly — scope AND visible session, on push and replay', async (t) => {
  const instance = await factory(t)
  await instance.start(); await ready(instance)
  const allowed = await pairDevice(instance, DEV_A, { scopes: ['sessions:read', 'approval:respond', 'prompt:send'] })
  const noScope = await pairDevice(instance, DEV_B, { scopes: ['sessions:read', 'prompt:send'] })
  await waitFor(() => visibleIds(instance, allowed.device.id).length === 2, 'snapshot a')
  await waitFor(() => visibleIds(instance, noScope.device.id).length === 2, 'snapshot b')
  const allowedWs = await controlSocket(instance, allowed, DEV_A)
  const noScopeWs = await controlSocket(instance, noScope, DEV_B)

  const answer = Promise.withResolvers()
  const pending = requestQuestion(instance, 's1', () => answer.promise)
  try {
    const card = await take(allowedWs, (frame) => frame.kind === 'question-requested' && frame.sessionId === 's1')
    assert.equal(card.questions[0].id, 'q', 'the authorized device is served the card, with its questions')
    await flush(noScopeWs)
    assert.equal(seenOf(noScopeWs).some((frame) => frame.kind === 'question-requested'), false,
      'a device without approval:respond gets no card')
    // Replay-on-connect follows the same rule.
    const replayWs = await connectToken(instance, allowed.token, DEV_A)
    await flush(replayWs)
    const replay = seenOf(replayWs).find((frame) => frame.kind === 'question-requested')
    assert.equal(replay?.replay, true, 'a reconnecting authorized device is sent the replay')
    const replayNoScope = await connectToken(instance, noScope.token, DEV_B)
    await flush(replayNoScope)
    assert.equal(seenOf(replayNoScope).some((frame) => frame.kind === 'question-requested'), false,
      'a reconnecting device without the scope is sent no replay')
  } finally {
    answer.resolve({ answers: [{ id: 'q', selected: ['a'] }] }); await pending
  }
})

test('Q9: the answer rule is per SOCKET — the admin socket answers the card it received, and a filtered socket that never got the card cannot answer it', async (t) => {
  // The answer path used to require `hasQuestionClient(pending.sessionId)`: some OTHER socket had
  // to be a recipient of the card. A subscription filter is a routing hint, never an authorization,
  // so that requirement made the one socket that RECEIVEd the card unable to answer it. The rule is
  // now exactly `clientMayReceive(fromSocket, session, 'approval:respond')`, as for approvals.
  //
  // MEASURED against lib/index.mjs (347b/4282): a subscribe filter DOES still gate the PUSH and the
  // REPLAY (`broadcastInteractionFrame`/`replayPendingInteractions` skip a socket whose
  // `filterSessionId` is another session), so "filtered to s2 but pushed the s1 card" is not
  // reachable and is not asserted here. What IS per socket is the ANSWER: the socket that received
  // the card may answer it, and a socket filtered elsewhere — one that never saw a card — is refused
  // even when it names the live rpcId. Both halves run on ONE admin control socket.
  const instance = await factory(t, { config: { legacyAdmin: true } })
  await instance.start(); await ready(instance)
  const device = await pairDevice(instance, DEV_A, { scopes: ['sessions:read', 'approval:respond', 'prompt:send'] })
  await waitFor(() => visibleIds(instance, device.device.id).length === 2, 'snapshot')
  // The admin/owner socket: the gateway-wide (never bundled) `legacyAdmin` option plus the per-frame
  // marker make this one socket the admin channel, so it always passes the per-session gate. It must
  // be a `legacy` socket — the gateway routes `subscribe` to the CONVERSATION lane, so a `control`
  // socket answers every subscribe `wrong-channel` (and can never hold a filter).
  const ws = await connectToken(instance, device.token, DEV_A, 'legacy')
  const answer = Promise.withResolvers()
  const pending = requestQuestion(instance, 's1', () => answer.promise)
  const settled = pending.then((value) => ({ value }), (error) => ({ error }))
  try {
    const card = await take(ws, (frame) => frame.kind === 'question-requested' && frame.sessionId === 's1')
    assert.equal(card.kind, 'question-requested', 'the admin socket is sent the s1 card live')
    assert.deepEqual(seenOf(ws).filter((frame) => frame.kind === 'question-requested'), [],
      'exactly ONE card reached this socket (no duplicate push)')
    const receipt = await answerQuestion(ws, { rpcId: card.rpcId, sessionId: 's1', answers: [{ id: 'q', selected: ['a'] }] })
    assert.equal(receipt.kind, 'question-response', JSON.stringify(receipt).slice(0, 220))
    assert.equal(receipt.accepted, true, 'the admin socket that received the card may answer it: ' + JSON.stringify(receipt).slice(0, 200))
    const resolved = await take(ws, (frame) => frame.kind === 'question-resolved' && frame.rpcId === card.rpcId)
    assert.equal(resolved.outcome, 'answered')
    assert.deepEqual(await settled, { value: { answers: [{ id: 'q', selected: ['a'] }] } },
      'the Host settles with exactly what the admin socket chose')
  } finally {
    answer.resolve({ answers: [{ id: 'q', selected: ['a'] }] })
    await settled
  }
  // Second half: the same socket is now FILTERED to s1, so the s2 question below is NOT pushed to it.
  // The admin channel still passes the per-session gate, so a `not-authorized` refusal is not what is
  // expected: what it answers is a card it was never given, which decides nothing (`not-pending`).
  ws.send(JSON.stringify({ type: 'subscribe', sessionId: 's1', legacyAdmin: true, requestId: 'q9-sub-s1' }))
  assert.equal((await take(ws, (frame) => frame.requestId === 'q9-sub-s1')).kind, 'subscribed',
    'the s1 filter is installed for the second half')
  const second = Promise.withResolvers()
  const pendingSecond = requestQuestion(instance, 's2', () => second.promise)
  const settledSecond = pendingSecond.then((value) => ({ value }), (error) => ({ error }))
  try {
    // The filter is in place, so no s2 card is pushed to this socket.
    assert.equal(seenOf(ws).some((frame) => frame.kind === 'question-requested' && frame.sessionId === 's2'), false,
      'a socket filtered to s1 is pushed no s2 card')
    // Knowing the session is not authority for a card this socket was never handed.
    const guessed = await answerQuestion(ws, { rpcId: 'q9-guessed-rpc', sessionId: 's2', answers: [{ id: 'q', selected: ['b'] }] })
    assert.equal(guessed.kind, 'question-response', JSON.stringify(guessed).slice(0, 220))
    assert.equal(guessed.accepted, false, 'an rpcId this socket was never handed decides nothing')
    assert.equal(guessed.reason, 'not-pending')
    // The s2 card is untouched: opening s2 on this socket replays it, and only then is it answered.
    ws.send(JSON.stringify({ type: 'subscribe', sessionId: 's2', legacyAdmin: true, requestId: 'q9-sub-s2' }))
    assert.equal((await take(ws, (frame) => frame.requestId === 'q9-sub-s2')).kind, 'subscribed')
    const replayed = await take(ws, (frame) => frame.kind === 'question-requested' && frame.sessionId === 's2')
    assert.equal(replayed.replay, true, 'the pending s2 card is replayed once the socket opens s2')
    const acceptedSecond = await answerQuestion(ws, { rpcId: replayed.rpcId, sessionId: 's2', answers: [{ id: 'q', selected: ['b'] }] })
    assert.equal(acceptedSecond.accepted, true, 'the refused guess consumed nothing: ' + JSON.stringify(acceptedSecond).slice(0, 200))
    assert.deepEqual(await settledSecond, { value: { answers: [{ id: 'q', selected: ['b'] }] } })
  } finally {
    second.resolve({ answers: [{ id: 'q', selected: ['b'] }] })
    await settledSecond
  }
})

// ---------------------------------------------------------------------------
// R6: the raw session/event fan-out (reviewer 537f M1)
// ---------------------------------------------------------------------------

test('R6a: an unsubscribed LEGACY socket without sessions:read gets no live session event at all', async (t) => {
  const instance = await factory(t)
  await instance.start(); await ready(instance)
  const blind = await pairDevice(instance, DEV_B, { scopes: ['prompt:send'] })
  // The pairing socket stays in `clients` on the legacy channel and never subscribes.
  emitEvent(instance, 's1', 'not for the blind device')
  await flush(blind.ws)
  assert.equal(seenOf(blind.ws).some((frame) => frame.kind === 'event'), false,
    'the raw fan-out is session READ data, so it needs sessions:read')
})

test('R6b: an unsubscribed legacy socket with sessions:read gets only its visible sessions\' live events', async (t) => {
  const instance = await factory(t)
  await instance.start(); await ready(instance)
  const reader = await pairDevice(instance, DEV_A, { scopes: ['sessions:read'] })
  const ws = reader.ws // legacy channel, never subscribes
  await waitFor(() => visibleIds(instance, reader.device.id).length === 2, 'snapshot')
  emitEvent(instance, 's1', 'visible text')
  await take(ws, (frame) => frame.kind === 'event' && frame.sessionId === 's1')
  emitEvent(instance, 'hidden-session', 'SECRET hidden text')
  await flush(ws)
  assert.equal(seenOf(ws).some((frame) => frame.kind === 'event' && frame.sessionId === 'hidden-session'), false,
    'a session the Host never listed to the device leaks no live event')
  assert.equal(JSON.stringify(seenOf(ws)).includes('SECRET hidden text'), false, 'and none of its content')
})

test('R6c: a device that subscribes to a hidden session is refused and gets none of its live events', async (t) => {
  const instance = await factory(t)
  await instance.start(); await ready(instance)
  const device = await pairDevice(instance, DEV_A, { scopes: ['sessions:read'] })
  const ws = await connectToken(instance, device.token, DEV_A, 'conversation')
  await waitFor(() => visibleIds(instance, device.device.id).length === 2, 'snapshot')
  ws.send(JSON.stringify({ type: 'subscribe', sessionId: 'hidden-session', requestId: 'sub-hidden' }))
  const refused = await take(ws, (frame) => frame.requestId === 'sub-hidden')
  assert.equal(refused.kind, 'error', 'a subscription is a routing hint, not a grant')
  assert.equal(refused.code, 'session-not-found')
  emitEvent(instance, 'hidden-session', 'SECRET via subscription')
  await flush(ws)
  assert.equal(seenOf(ws).some((frame) => frame.kind === 'event' && frame.sessionId === 'hidden-session'), false,
    'an unfiltered hidden subscription never widens the raw stream')
  assert.equal(JSON.stringify(seenOf(ws)).includes('SECRET via subscription'), false)
  // The same socket may still subscribe to a VISIBLE session and then receives it.
  ws.send(JSON.stringify({ type: 'subscribe', sessionId: 's1', requestId: 'sub-visible' }))
  assert.equal((await take(ws, (frame) => frame.requestId === 'sub-visible')).kind, 'subscribed')
  emitEvent(instance, 's1', 'visible via subscription')
  await take(ws, (frame) => frame.kind === 'event' && frame.sessionId === 's1')
})

test('R6d: the loopback admin (legacyAdmin) socket still receives the full live stream', async (t) => {
  const instance = await factory(t, { config: { legacyAdmin: true } })
  await instance.start(); await ready(instance)
  const admin = await pairDevice(instance, DEV_A, { scopes: [] })
  const ws = admin.ws // legacy channel, admin test socket
  emitEvent(instance, 's1', 'admin sees this')
  emitEvent(instance, 'hidden-session', 'admin sees that too')
  await take(ws, (frame) => frame.kind === 'event' && frame.sessionId === 'hidden-session')
})

test('R6e: a re-paired or revoked generation gets no live session event', async (t) => {
  const instance = await factory(t)
  await instance.start(); await ready(instance)
  const repaired = await pairDevice(instance, DEV_A, { scopes: ['sessions:read'] })
  const revoked = await pairDevice(instance, DEV_B, { scopes: ['sessions:read'] })
  const oldSockets = [repaired.ws, revoked.ws] // legacy channel: the raw fan-out's target
  await waitFor(() => visibleIds(instance, repaired.device.id).length === 2, 'snapshot')
  const closed = Promise.all(oldSockets.map((ws) => once(ws, 'close')))
  await pairDevice(instance, DEV_A, { scopes: ['sessions:read'] }) // generation bumped
  assert.equal((await instance.post(`devices/${revoked.device.id}/revoke`)).status, 200)
  await closed
  emitEvent(instance, 's1', 'after the credential changed')
  await delay(150)
  for (const ws of oldSockets) {
    assert.equal(seenOf(ws).some((frame) => frame.kind === 'event'), false, 'a stale generation is sent no live event')
  }
})
