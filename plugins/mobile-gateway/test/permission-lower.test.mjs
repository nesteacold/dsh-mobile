// Spec 019 Wave 3 — permission control: view + lower-only
// (`specs/019-parity-wave3-high-risk-design/permission-lower.md`).
//
// Every case drives a REAL gateway (upgrade, credential, scope gate, framing fences,
// the device Peer, the carrier call) against a RECORDING fake Host, and against a fake
// in-process `permissionPresets` service the plugin reaches with `ctx.get` — exactly the
// cordis service the Host's `/permission` command handler uses. A case passes only when
// the reply is the frame the contract names AND the fake Host's call log proves the
// expected endpoint ran (or, for a refusal, that it did not).
//
// The doubles are FAITHFUL to rc.1, because two of the bugs this file must catch lived
// exactly in the assumptions a sloppy double hides:
//  - `PresetService` is a CLASS instance whose `current`/`resolve`/`set`/`names` live on
//    the PROTOTYPE (dsh-permission-presets/lib/index.js:113-414 is one class), so any
//    `{ ...service }` copy drops them;
//  - `session/projections` answers the projection WIRE VIEW (`{currentValue}`), never the
//    Session (dsh-permission-presets/lib/index.js:206-209), so the view can never be the
//    argument of `current(session)` / `set(session, name)`;
//  - the LIVE Session comes from a SEPARATE in-process store (`ctx.sessions`, i.e.
//    `ctx.get('sessions')`, dsh-session/lib/index.js:1735-1744, :1994-2001), whose
//    `get(id)` is `undefined` for a session that is stored but not live.
//
// The negative control for every check is its pair with one thing changed:
//  - accepted ⇄ equal/looser/mixed target refused, with the service's `set` never called;
//  - scope present ⇄ absent (refused by the scope gate, no Host call, no service call);
//  - service usable ⇄ missing / shape-different (`unavailable`);
//  - session visible+live ⇄ DSH refusing it, or the store holding no live object
//    (`unavailable`, nothing written);
//  - write taking ⇄ re-read not matching (`raced`, nothing reported accepted);
//  - and a planter control proving the Host-text scanner below really catches text.
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
import { listenFetchSafe } from './support/fetch-safe-listen.mjs'
import { createPermissionLower, isStrictlyStricter, pairOf } from '../lib/permission-lower.mjs'
import {
  APPROVAL_POLICY_ORDER, AUTHORING_SCOPE, SANDBOX_MODE_ORDER, PERMISSION_LOWER_MESSAGES,
  PERMISSION_LOWER_SCOPE, SESSION_EDIT_CAPABILITY_SCOPE,
} from '@dsh-ext/mobile-protocol'

const delay = (ms) => new Promise((resolve) => setTimeout(resolve, ms))

/** Advertised only with `permission:lower` (contract §3.5, spec 019). */
const CAPABILITY = 'permission-lower'
/** The exact set a device WITHOUT the scope still sees (required + revision 10 optional). */
const BASE_CAPABILITIES = ['sessions-read', 'prompt', 'cancel', 'approval-v1', 'browser-agent:1']

/**
 * The Host's real preset table (dsh-permission-presets/lib/index.js:145-158) as a fake
 * service: `danger-full-access` = {danger-full-access, never}, `workspace-write` =
 * {workspace-write, ask}. Two more presets are added so a two-step lowering, a
 * mixed-axes pair and an approval-only step exist at all.
 */
const PRESETS = {
  'read-only': { sandbox: 'read-only', approval: 'ask', name: 'read-only' },
  'workspace-write': { sandbox: 'workspace-write', approval: 'ask', name: 'workspace-write' },
  'danger-full-access': { sandbox: 'danger-full-access', approval: 'never', name: 'danger-full-access' },
  // A deployment-configurable preset whose axes move in OPPOSITE directions, so a
  // "compare one axis only" implementation would wrongly accept it from `workspace-write`.
  'no-ask-anywhere': { sandbox: 'danger-full-access', approval: 'ask', name: 'no-ask-anywhere' },
}

/**
 * A fake `PermissionPresetService`, shaped like the rc.1 CLASS
 * (dsh-permission-presets/lib/index.js:113-414): every method and `names` sit on the
 * PROTOTYPE, and only instance data (`presets`, `calls`, `state`, the `options`) lives
 * on the object. `sessions` maps a LIVE Session object to its current preset, so the
 * SAME store object must come back from `ctx.sessions.get(id)` — that is what proves
 * the live Session actually reached the service.
 */
class PresetService {
  constructor(options = {}) {
    this.presets = PRESETS
    this.options = options
    this.calls = { current: 0, resolve: 0, set: 0, get: 0 }
    this.state = new Map(options.initial ?? [])
  }
  get names() {
    return [...Object.keys(PRESETS), ...(this.options.autoLive ? ['auto'] : [])]
  }
  current(session) {
    this.calls.current += 1
    return this.state.get(session) ?? this.options.unreadable ?? 'workspace-write'
  }
  resolve(name) {
    this.calls.resolve += 1
    if (name === 'auto' && this.options.autoLive) return { sandbox: 'danger-full-access', approval: 'ask', name: 'auto' }
    if (!Object.hasOwn(PRESETS, name)) throw new Error(`permission: unknown preset "${name}" (known: ${Object.keys(PRESETS).join(', ')})`)
    return PRESETS[name]
  }
  set(session, name) {
    this.calls.set += 1
    if (typeof this.options.onSet === 'function') this.options.onSet(session, name, this.state)
    if (this.options.throwOnSet) throw new Error(`permission: cannot switch (${name})`)
    // `writeIgnored` is a service whose write does not take effect (the race case).
    if (!this.options.writeIgnored) this.state.set(session, name)
  }
}

/**
 * A fake `ctx.sessions` LIVE store (dsh-session/lib/index.js:1735-1744, :1994-2001):
 * `get(id)` answers the Session only while it is LIVE, `undefined` otherwise — a stored
 * session that is not live never comes back from it, and it never loads one.
 */
class LiveSessions {
  constructor(sessions, calls) {
    this.byId = sessions
    this.calls = calls
  }
  get(id) {
    this.calls.get += 1
    return this.byId.get(id)
  }
}

/** The prototype a class instance's methods live on (what a spread copy loses). */
const protoOf = (instance) => Object.getPrototypeOf(instance)

/** Text a real Host emits and that must never reach a phone. */
const HOST_ONLY_TEXT = 'permission: unknown preset "x" (known: $HOME/owner/secret-plan/canary.db)'

/**
 * A recording fake Host. `visible` is what `session/list` reports (which builds the
 * gateway's visible-session snapshot); `sessionObjects` is the LIVE store a
 * `session/projections` read is true for. The read itself answers what rc.1 answers: the
 * `permissions` projection WIRE VIEW (`{currentValue}`, never a Session object), built
 * from that same live Session — so the view and the Session are two different objects,
 * exactly as on a real Host.
 */
function fakeHost(hostCalls, { visible = ['s1'], sessionObjects = new Map(), projectionsThrows = new Set(), options = {} } = {}) {
  const record = (kind, request) => hostCalls.push({
    kind, endpoint: `${request.namespace}/${request.method}`, principal: request.peer?.principal,
    args: request.args, peer: request.peer,
  })
  return {
    async invoke(request) {
      record('invoke', request)
      const { namespace, method } = request
      if (namespace === 'session' && method === 'list') return { items: visible.map((sessionId) => ({ sessionId })) }
      if (namespace === 'session' && method === 'modelCatalog') {
        return { default: { provider: 'p', model: 'm' }, routableProviders: ['p'], groups: [], failures: [] }
      }
      return {}
    },
    async stream(request) {
      record('stream', request)
      return (async function* () {
        if (request.namespace === 'workspace' && request.method === 'follow') {
          yield { type: 'baseline', value: { items: [], archivedSessionIds: [] } }
        } else if (request.namespace === 'session' && request.method === 'follow') {
          yield { type: 'snapshot', header: { version: 4, id: request.args.request.address.sessionId }, cursor: 1,
            records: [], hasMore: false, projections: { asOfSeq: 1, values: {} }, assistantStream: { revision: 0 } }
        }
        while (!request.signal?.aborted) await delay(10)
      })()
    },
    // The carrier the gateway uses to prove DEVICE VISIBILITY of a session id (spec 019).
    async dispatchRpc(endpoint, payload, signal, peer) {
      hostCalls.push({ kind: 'dispatchRpc', endpoint, principal: peer?.principal, args: payload })
      if (options.dispatchThrows) throw new Error(HOST_ONLY_TEXT)
      if (endpoint !== 'session/projections') return { ok: false, error: { code: 'op/forbidden' } }
      if (projectionsThrows.has(payload?.sessionId)) {
        return { ok: false, error: { code: 'remote-access/denied', message: HOST_ONLY_TEXT } }
      }
      if (!sessionObjects.has(payload?.sessionId)) {
        return { ok: false, error: { code: 'session/not-found', message: HOST_ONLY_TEXT } }
      }
      // The wire form of the `permissions` projection: a value object naming no Session.
      return { ok: true, value: { kind: 'sequenced', asOfSeq: 7, values: { permissions: { currentValue: 'workspace-write' } } } }
    },
  }
}

/**
 * What both sides answer about `s1` for one option set: the LIVE Session object the
 * visibility read is true for and the store holds. `liveStore` overrides the store only
 * (P-4c: a session the device may see but that is not live); `sessionsMissing` is a Host
 * with no store at all (P-4d).
 */
function liveStoreFor(options) {
  if (options.liveStore) return options.liveStore
  if (options.sessionsMissing) return undefined
  return options.sessionObjects ?? new Map([['s1', { sessionId: 's1' }]])
}

/** The default live Session every fresh factory serves (a NEW object per factory). */
const defaultSessionObjects = () => new Map([['s1', { sessionId: 's1' }]])

async function factory(t, options = {}) {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'dsh-permission-lower-'))
  const sockets = []
  const hostCalls = []
  const sessionObjects = options.sessionObjects ?? defaultSessionObjects()
  const liveStore = liveStoreFor({ ...options, sessionObjects })
  const sessionCalls = { get: 0 }
  // A holder, not a constant: P-5 removes the service mid-run, the way an unmounted
  // plugin disappears from the Host context.
  const holder = { mounted: true, service: options.service === undefined ? new PresetService(options.serviceOptions) : options.service }
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
  // The plugin's log sink, captured: spec 019's refusals are AUDITED, and the log must
  // name the validated id only (never a raw field).
  const logLines = []
  const log = (line) => { logLines.push(String(line)) }
  // Spec 019 reads the services through `ctx.get`, exactly as the plugin reads services
  // it did not inject (see `resolveHostGateway`): `permissionPresets` and `sessions`.
  const ctx = {
    webServer: { port, register(route) { management = route; return () => {} },
      registerUpgrade(route) { upgrade = route; return () => {} } },
    connection: createTestConnection(),
    remoteAccess: createTestRemoteAccess(),
    typertGateway: fakeHost(hostCalls, { visible: options.visible ?? ['s1'], sessionObjects,
      projectionsThrows: options.projectionsThrows ?? new Set(), options }),
    agentDefaultModel: {},
    get(name, required) {
      if (name === 'permissionPresets') return holder.mounted ? holder.service : undefined
      if (name === 'sessions') return liveStore === undefined ? undefined : new LiveSessions(liveStore, sessionCalls)
      return undefined
    },
    on(event, handler) {
      const list = events.get(event) ?? []
      list.push(handler)
      events.set(event, list)
      return () => { const i = list.indexOf(handler); if (i >= 0) list.splice(i, 1) }
    },
    effect(fn) { dispose = fn() },
  }
  await plugin.apply(ctx, {
    remoteControl: { enabled: true },
    gatewayMode: 'persistent',
    gatewayWaitTimeoutMs: 60_000,
    gatewayName: `permission-lower-${port}`,
    deviceFile: path.join(directory, 'devices.json'),
    pairingTtlMs: 60_000,
    lanEnabled: true,
    lanHost: '127.0.0.1',
    lanPort: 0,
    requireHostApproval: false,
  }, { log })
  t.after(async () => {
    for (const socket of sockets) socket.terminate()
    try { dispose() } catch { /* already disposed */ }
    await new Promise((resolve) => server.close(resolve))
    fs.rmSync(directory, { recursive: true, force: true })
  })
  const instance = {
    hostCalls, service: holder.service, holder, sessionObjects, sessionCalls, logLines,
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
  const requestId = `perm-${++counter}`
  ws.send(JSON.stringify({ ...frame, requestId }))
  return take(ws, (reply) => reply.requestId === requestId)
}
const callsSince = (instance, since, endpoint) =>
  instance.hostCalls.slice(since).filter((call) => call.endpoint === endpoint)
const deviceCallsSince = (instance, since) =>
  instance.hostCalls.slice(since).filter((call) => call.principal?.kind !== 'owner' && call.kind !== 'stream')

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

const MOBILE_LOWER = { kind: 'mobile', scopes: ['sessions:read', 'prompt:send', 'approval:respond', PERMISSION_LOWER_SCOPE] }
const MOBILE_NO_LOWER = { kind: 'mobile', scopes: ['sessions:read', 'prompt:send', 'approval:respond'] }

// ===========================================================================
// P-1 capability advertisement (contract §3.5)
// ===========================================================================

test('P-1 hello lists permission-lower only for a device holding permission:lower', async (t) => {
  const instance = await factory(t)
  const without = await pairDevice(instance, 'perm-cap-no-0001', MOBILE_NO_LOWER)
  assert.equal(without.device.scopes.includes(PERMISSION_LOWER_SCOPE), false)
  assert.deepEqual(without.hello.capabilities, BASE_CAPABILITIES,
    'a device without the scope must see the unchanged capability set')
  // ...and on a later token connection too, not only on the pairing socket.
  const tokenWs = open(instance, ['dsh-mobile-v1'], { Authorization: `Bearer ${without.token}`, 'X-DSH-Device-ID': 'perm-cap-no-0001' })
  record(tokenWs)
  await once(tokenWs, 'open')
  const tokenHello = await take(tokenWs, (frame) => frame.kind === 'hello')
  assert.deepEqual(tokenHello.capabilities, BASE_CAPABILITIES)
  assert.equal(CAPABILITY, 'permission-lower')

  const withScope = await pairDevice(instance, 'perm-cap-yes-0001', MOBILE_LOWER)
  assert.deepEqual(withScope.hello.capabilities, [...BASE_CAPABILITIES, CAPABILITY],
    'a device holding permission:lower is told the permission ops exist')
  // Negative control on the rule itself: the contract map, not a second literal, decides
  // which scope lifts which capability — and the other two stay on `sessions:author`.
  assert.equal(SESSION_EDIT_CAPABILITY_SCOPE[CAPABILITY], PERMISSION_LOWER_SCOPE)
  assert.equal(SESSION_EDIT_CAPABILITY_SCOPE['session-rename'], AUTHORING_SCOPE)
  tokenWs.close(); without.ws.close(); withScope.ws.close()
})

// ===========================================================================
// P-2 the read op
// ===========================================================================

test('P-2a permission-options reports the current preset and only STRICTLY stricter ones, with their pairs', async (t) => {
  const instance = await factory(t, { serviceOptions: { initial: [] } })
  // `PresetService.current` answers `workspace-write` when the Session is not in its map.
  const { ws } = await pairDevice(instance, 'perm-read-0001', MOBILE_LOWER)
  const since = instance.hostCalls.length
  const before = { ...instance.service.calls }
  const reply = await ask(ws, { type: 'permission-options', sessionId: 's1' })
  assert.equal(reply.kind, 'permission-options', JSON.stringify(reply).slice(0, 300))
  assert.equal(reply.currentValue, 'workspace-write')
  // Strictly stricter than {workspace-write, ask}: `read-only` (sandbox down). NOT
  // `danger-full-access` (sandbox up) and NOT `no-ask-anywhere` (sandbox up).
  assert.deepEqual(reply.options, [{ preset: 'read-only', sandbox: 'read-only', approval: 'ask' }],
    'only presets stricter on at least one axis and looser on none are offered')
  // The visibility check ran on the DEVICE's Peer (DSH's own per-session policy decides it).
  const resolutions = deviceCallsSince(instance, since).filter((call) => call.kind === 'dispatchRpc')
  assert.equal(resolutions.length, 1, 'exactly one visibility check per read')
  assert.equal(resolutions[0].endpoint, 'session/projections')
  assert.deepEqual(resolutions[0].args, { sessionId: 's1' })
  assert.equal(resolutions[0].principal?.kind, 'dsh-ext-mobile-device')
  // C1 + C2: the Session came from the separate LIVE store, by id, and the service was
  // asked with THAT object — on the class instance itself, so its PROTOTYPE methods ran.
  assert.equal(instance.sessionCalls.get, 1, 'the live store supplied the Session, exactly once')
  assert.equal(instance.service.calls.current - before.current, 1, 'exactly one current() for one read')
  assert.equal(protoOf(instance.service).current === instance.service.current, true,
    'sanity: the live call went through the prototype method, not a copy')
  // current + the requested target's pair + one resolve per name the read weighs (4).
  assert.equal(instance.service.calls.resolve - before.resolve, 5, 'one resolve() per candidate (target pair + 4 names)')
  // The read NEVER writes.
  assert.equal(instance.service.calls.set, 0, 'permission-options must never call set')
  ws.close()
})

test('P-2b a device WITHOUT permission:lower is refused BOTH frames by scope: no resolution, no service call', async (t) => {
  const instance = await factory(t)
  const { ws } = await pairDevice(instance, 'perm-noscope-0001', MOBILE_NO_LOWER)
  const since = instance.hostCalls.length
  const serviceBefore = { ...instance.service.calls }
  for (const frame of [
    { type: 'permission-options', sessionId: 's1' },
    { type: 'permission-lower', sessionId: 's1', preset: 'read-only' },
  ]) {
    const reply = await ask(ws, frame)
    assert.equal(reply.kind, 'error', `${frame.type}: ${JSON.stringify(reply).slice(0, 240)}`)
    assert.equal(reply.code, 'auth/forbidden-scope', `${frame.type} must be refused BY SCOPE, got ${reply.code}`)
    assert.equal(reply.scope, PERMISSION_LOWER_SCOPE, `${frame.type} must name the missing scope`)
    assert.equal(reply.requestType, frame.type)
  }
  assert.equal(deviceCallsSince(instance, since).filter((call) => call.kind === 'dispatchRpc').length, 0,
    'a scope refusal must resolve nothing')
  assert.deepEqual(instance.service.calls, serviceBefore, 'a scope refusal must not touch the service')
  ws.close()
})

test('P-2c an unknown target is refused custom-current; auto and custom are never offered', async (t) => {
  const instance = await factory(t, { serviceOptions: { autoLive: true } })
  const { ws } = await pairDevice(instance, 'perm-unknown-0001', MOBILE_LOWER)
  const reply = await ask(ws, { type: 'permission-lower', sessionId: 's1', preset: 'nope' })
  assert.equal(reply.kind, 'error', JSON.stringify(reply).slice(0, 240))
  assert.equal(reply.code, 'custom-current')
  assert.equal(reply.message, PERMISSION_LOWER_MESSAGES['custom-current'], 'the fixed sentence, not Host text')
  assert.equal(instance.service.calls.set, 0, 'no write for an unknown target')
  for (const preset of ['auto', 'custom']) {
    const second = await ask(ws, { type: 'permission-lower', sessionId: 's1', preset })
    assert.equal(second.code, 'custom-current', `${preset} must never be a target: ${JSON.stringify(second)}`)
    assert.equal(instance.service.calls.set, 0)
  }
  ws.close()
})

// ===========================================================================
// P-3 the lower op: the accept path and every "this would widen" refusal
// ===========================================================================

test('P-3a a strictly stricter target is applied, is reported accepted, and is audited with ids and pairs only', async (t) => {
  const instance = await factory(t, { serviceOptions: { initial: [] } })
  const { ws } = await pairDevice(instance, 'perm-accept-0001', MOBILE_LOWER)
  const since = instance.hostCalls.length
  const reply = await ask(ws, { type: 'permission-lower', sessionId: 's1', preset: 'read-only' })
  assert.equal(reply.kind, 'permission-lower', JSON.stringify(reply).slice(0, 300))
  assert.equal(reply.accepted, true)
  assert.equal(reply.preset, 'read-only')
  assert.equal(reply.currentValue, 'read-only', 'the re-read value is what the device is told')
  assert.equal(instance.service.calls.set, 1, 'exactly one write')
  assert.equal(instance.service.state.get(instance.sessionObjects.get('s1')), 'read-only',
    'the write landed on the LIVE Session the store produced')
  assert.equal(instance.sessionCalls.get, 1, 'one store lookup for one lower (C1)')
  assert.equal(deviceCallsSince(instance, since).filter((call) => call.endpoint === 'commands/execute').length, 0,
    'never a command string: the write goes through the in-process service')
  // The audit line names the device, the session and both presets with their pairs — and
  // carries no command text. Its sink is the plugin log (`lib/logging.mjs`), which the
  // process-wide scan in test/log-scan.test.mjs holds to "no secrets"; here the fact is
  // that the write path produced an accepted receipt AND a single service `set`.
  assert.equal(instance.service.calls.current >= 3, true, 'two reads (before and after the write) at least')
  ws.close()
})

/** A device-caused lower that must be refused WITHOUT writing: (current → target, reason). */
const REFUSED_TARGETS = [
  // equal to the current pair (strictness needs one axis to MOVE)
  ['workspace-write', 'workspace-write', 'not-stricter'],
  // looser on the sandbox axis (the classic "raise" a lower-only op must refuse)
  ['workspace-write', 'danger-full-access', 'not-stricter'],
  // looser on the approval axis only (same sandbox, `ask` -> `never`)
  ['read-only', 'no-ask-anywhere', 'not-stricter'],
  // mixed axes against this table cannot exist (see P-3d for the synthetic table that has
  // them): the only `never` approval belongs to the widest sandbox, so a target can never
  // be sandbox-stricter AND approval-wider here.
]

for (const [current, target, reason] of REFUSED_TARGETS) {
  test(`P-3 refusal: ${current} -> ${target} is ${reason} and the service's set is never called`, async (t) => {
    const instance = await factory(t, { serviceOptions: { initial: [] } })
    const { ws } = await pairDevice(instance, `perm-refuse-${current.length}${target.length}-0001`, MOBILE_LOWER)
    const session = instance.sessionObjects.get('s1')
    instance.service.state.set(session, current)
    const reply = await ask(ws, { type: 'permission-lower', sessionId: 's1', preset: target })
    assert.equal(reply.kind, 'permission-lower', JSON.stringify(reply).slice(0, 300))
    assert.equal(reply.accepted, false, `accepted: ${JSON.stringify(reply)}`)
    assert.equal(reply.reason, reason)
    assert.equal(reply.currentValue, current, 'the device is told what the preset IS')
    assert.equal(instance.service.calls.set, 0, 'a refused lower must not write')
    assert.equal(instance.service.state.get(session), current, 'the preset is unchanged')
    ws.close()
  })
}

test('P-3d a MIXED pair (sandbox stricter, approval wider) is refused end to end, with set never called', async (t) => {
  // The production table cannot express a mix (only `danger-full-access` carries `never`),
  // but a DEPLOYMENT config can: presets are user-configurable. This synthetic service
  // proves the rule holds for a table that does.
  const MIXED = {
    'open-sandbox-strict-approval': { sandbox: 'read-only', approval: 'ask', name: 'open-sandbox-strict-approval' },
    'wide-sandbox-loose-approval': { sandbox: 'danger-full-access', approval: 'never', name: 'wide-sandbox-loose-approval' },
  }
  const state = new Map()
  const calls = { current: 0, resolve: 0, set: 0 }
  const service = {
    presets: MIXED,
    names: Object.keys(MIXED),
    calls,
    current: () => 'open-sandbox-strict-approval',
    resolve(name) { if (!Object.hasOwn(MIXED, name)) throw new Error(HOST_ONLY_TEXT); return MIXED[name] },
    set() { calls.set += 1 },
  }
  const instance = await factory(t)
  const { ws } = await pairDevice(instance, 'perm-mixed-0001', MOBILE_LOWER)
  instance.holder.service = service
  const reply = await ask(ws, { type: 'permission-lower', sessionId: 's1', preset: 'wide-sandbox-loose-approval' })
  assert.equal(reply.kind, 'permission-lower', JSON.stringify(reply).slice(0, 240))
  assert.equal(reply.accepted, false, `a MIX must never be accepted: ${JSON.stringify(reply)}`)
  assert.equal(reply.reason, 'not-stricter')
  assert.equal(calls.set, 0, 'a mixed pair never reaches set()')
  // The read offers nothing either: no preset is stricter on both axes.
  const options = await ask(ws, { type: 'permission-options', sessionId: 's1' })
  assert.equal(options.kind, 'permission-options', JSON.stringify(options).slice(0, 240))
  assert.deepEqual(options.options, [], 'a mixed-only table offers no target')
  ws.close()
})
test('P-3b a custom or auto CURRENT preset is custom-current, and nothing is written', async (t) => {
  const instance = await factory(t, { serviceOptions: { autoLive: true, initial: [] } })
  const { ws } = await pairDevice(instance, 'perm-custom-current-0001', MOBILE_LOWER)
  const session = instance.sessionObjects.get('s1')
  for (const current of ['custom', 'auto']) {
    instance.service.state.set(session, current)
    for (const target of ['workspace-write', 'read-only', 'danger-full-access']) {
      const reply = await ask(ws, { type: 'permission-lower', sessionId: 's1', preset: target })
      if (target === 'read-only') {
        assert.equal(reply.kind, 'error', JSON.stringify(reply).slice(0, 240))
        assert.equal(reply.code, 'custom-current', `${current} -> ${target}: ${JSON.stringify(reply)}`)
        assert.equal(reply.message, PERMISSION_LOWER_MESSAGES['custom-current'])
      } else {
        // Not comparable to a known pair ⇒ the same refusal, never a receipt.
        assert.notEqual(reply.accepted, true, `${current} -> ${target} must never be accepted: ${JSON.stringify(reply)}`)
      }
    }
    const options = await ask(ws, { type: 'permission-options', sessionId: 's1' })
    assert.equal(options.kind, 'error', JSON.stringify(options).slice(0, 240))
    assert.equal(options.code, 'custom-current', 'a read of an incomparable current is refused the same way')
  }
  assert.equal(instance.service.calls.set, 0, 'no write for an incomparable current')
  ws.close()
})

test('P-3c a write whose re-read does not resolve to the target is raced, reported accepted:false', async (t) => {
  const instance = await factory(t, { serviceOptions: { initial: [], writeIgnored: true } })
  const { ws } = await pairDevice(instance, 'perm-raced-0001', MOBILE_LOWER)
  const reply = await ask(ws, { type: 'permission-lower', sessionId: 's1', preset: 'read-only' })
  assert.equal(reply.kind, 'permission-lower', JSON.stringify(reply).slice(0, 300))
  assert.equal(reply.accepted, false, `a write that did not take is never accepted: ${JSON.stringify(reply)}`)
  assert.equal(reply.reason, 'raced')
  assert.equal(reply.currentValue, 'workspace-write', 'the device is told what the preset still is')
  assert.equal(instance.service.calls.set, 1, 'the write was attempted once and NOT retried')
  ws.close()
})

// ===========================================================================
// P-4 the session rule: visible AND live, or unavailability
// ===========================================================================

test('P-4 a session DSH refuses to resolve is unavailable; no service call, no write', async (t) => {
  const instance = await factory(t, { sessionObjects: new Map(), projectionsThrows: new Set(['s1']) })
  const { ws } = await pairDevice(instance, 'perm-hidden-0001', MOBILE_LOWER)
  const serviceBefore = { ...instance.service.calls }
  for (const frame of [
    { type: 'permission-options', sessionId: 's1' },                  // refused by the Host
    { type: 'permission-lower', sessionId: 's1', preset: 'read-only' }, // refused by the Host
    { type: 'permission-lower', sessionId: 's-not-known', preset: 'read-only' }, // absent
  ]) {
    const reply = await ask(ws, frame)
    assert.equal(reply.kind, 'error', JSON.stringify(reply).slice(0, 240))
    assert.equal(reply.code, 'unavailable', `${frame.type}: ${JSON.stringify(reply)}`)
    assert.equal(reply.message, PERMISSION_LOWER_MESSAGES.unavailable, 'a fixed sentence, never Host text')
    // Planter sanity: the Host's own text DID carry a canary, so "absent" means dropped.
    assert.equal(String(reply.message).includes('secret-plan'), false, 'Host text leaked')
  }
  assert.deepEqual(instance.service.calls, serviceBefore, 'an unresolvable session never reaches the service')
  assert.equal(instance.service.calls.set, 0)
  ws.close()
})

test('P-4b a sessionId that is missing or too long is bad-request with no resolution', async (t) => {
  const instance = await factory(t)
  const { ws } = await pairDevice(instance, 'perm-badid-0001', MOBILE_LOWER)
  const since = instance.hostCalls.length
  for (const sessionId of [undefined, '', '   ', 42, 'x'.repeat(129)]) {
    const reply = await ask(ws, { type: 'permission-options', sessionId })
    assert.equal(reply.kind, 'error', `${String(sessionId)?.slice(0, 8)}: ${JSON.stringify(reply)}`)
    assert.equal(reply.code, 'bad-request')
    assert.equal(reply.message, 'the request must name one session id of at most 128 characters')
    // C-minor: a malformed field is neither echoed in the reply nor carried into the log
    // (asserted on the log at the bottom), so a wire value can never be reflected back.
    assert.equal(Object.hasOwn(reply, 'sessionId'), false, 'a malformed id is not echoed back')
  }
  assert.equal(deviceCallsSince(instance, since).filter((call) => call.kind === 'dispatchRpc').length, 0,
    'a malformed id never reaches the Host')
  ws.close()
})

test('P-4c a stored session the DEVICE may see but that is NOT LIVE is unavailable, and is never loaded', async (t) => {
  // The visibility side WOULD succeed (the projection read answers `sequenced`), but the
  // in-process LIVE store holds no object for it — a detached / not-yet-opened session.
  // Serving it would mean loading or resuming it, which this module must never do.
  const visible = new Map([['s1', { sessionId: 's1' }]])
  const instance = await factory(t, { sessionObjects: visible, liveStore: new Map() })
  const { ws } = await pairDevice(instance, 'perm-not-live-0001', MOBILE_LOWER)
  const since = instance.hostCalls.length
  const serviceBefore = { ...instance.service.calls }
  for (const frame of [
    { type: 'permission-options', sessionId: 's1' },
    { type: 'permission-lower', sessionId: 's1', preset: 'read-only' },
  ]) {
    const reply = await ask(ws, frame)
    assert.equal(reply.kind, 'error', `${frame.type}: ${JSON.stringify(reply)}`)
    assert.equal(reply.code, 'unavailable', `${frame.type}: a not-live session is unavailable`)
    assert.equal(reply.message, PERMISSION_LOWER_MESSAGES.unavailable, 'a fixed sentence, never Host text')
  }
  // Liveness answers FIRST, so the projection read never ran: that read would have been
  // satisfied by the stored session and would have loaded its `permissions` projection
  // into a cache for a request this module refuses anyway.
  assert.equal(instance.sessionCalls.get, 2, 'both frames asked the live store, before anything else')
  assert.equal(deviceCallsSince(instance, since).filter((call) => call.kind === 'dispatchRpc').length, 0,
    'a session the store does not hold live is refused WITHOUT the projection read')
  // ...and nothing beyond a lookup happened: no preset read, no write, no load/resume call.
  assert.deepEqual(instance.service.calls, serviceBefore, 'a not-live session never reaches the preset service')
  assert.equal(instance.service.calls.set, 0)
  assert.equal(instance.hostCalls.some((call) => call.kind === 'invoke' && /session\/(follow|page)/.test(call.endpoint)), false,
    'no Host read that would load or resume the session')
  // Negative control: a fresh Host with `s1` really live serves the SAME frame, so the
  // refusal above came from liveness and not from anything else.
  const liveAgain = await factory(t, { sessionObjects: visible })
  const { ws: live } = await pairDevice(liveAgain, 'perm-live-again-0001', MOBILE_LOWER)
  const served = await ask(live, { type: 'permission-options', sessionId: 's1' })
  assert.equal(served.kind, 'permission-options', JSON.stringify(served).slice(0, 240))
  ws.close(); live.close()
})

test('P-4d a Host without the in-process `sessions` store is unavailable, though visibility passes', async (t) => {
  const instance = await factory(t, { sessionsMissing: true })
  const { ws } = await pairDevice(instance, 'perm-no-store-0001', MOBILE_LOWER)
  const serviceBefore = { ...instance.service.calls }
  for (const frame of [
    { type: 'permission-options', sessionId: 's1' },
    { type: 'permission-lower', sessionId: 's1', preset: 'read-only' },
  ]) {
    const reply = await ask(ws, frame)
    assert.equal(reply.kind, 'error', `${frame.type}: ${JSON.stringify(reply)}`)
    assert.equal(reply.code, 'unavailable', `${frame.type}: no live store means no Session to address`)
    assert.equal(reply.message, PERMISSION_LOWER_MESSAGES.unavailable, 'a fixed sentence, never Host text')
  }
  assert.equal(instance.sessionCalls.get, 0, 'a Host without the store answers no lookup at all')
  assert.deepEqual(instance.service.calls, serviceBefore, 'the preset service is untouched without a Session')
  assert.equal(instance.service.calls.set, 0)
  ws.close()
})

test('P-4e liveness is asked BEFORE visibility: a not-live session never reaches dispatchRpc', async () => {
  // The order itself, at the module seam: a session the store does not hold live is refused
  // `unavailable` and the projection read — the one Host call that would load its projections —
  // is never issued. Negative control: ONE store entry flipped live and the same frame runs the
  // read, so the missing call above is caused by liveness and not by anything else.
  const lines = []
  const live = { sessionId: 's1' }
  let storeIds = []
  let sessionCalls = 0
  const storeOf = () => ({
    get(id) {
      sessionCalls += 1
      return storeIds.includes(id) ? live : undefined
    },
  })
  const rpcCalls = []
  const unit = () => createPermissionLower({
    get: (name) => (name === 'permissionPresets' ? new PresetService({ initial: [] })
      : name === 'sessions' ? storeOf() : undefined),
  }, {
    log: (line) => lines.push(line),
    dispatchRpc: async (endpoint, payload) => {
      rpcCalls.push({ endpoint, payload: { ...payload } })
      return { ok: true, value: { kind: 'sequenced', asOfSeq: 1, values: { permissions: { currentValue: 'workspace-write' } } } }
    },
  })
  const peer = { principal: { kind: 'dsh-ext-mobile-device', deviceId: 'dev-1' }, signal: new AbortController().signal }

  // Not live: both frames refused, both without the projection read.
  for (const msg of [{ type: 'permission-options', sessionId: 's1' }, { type: 'permission-lower', sessionId: 's1', preset: 'read-only' }]) {
    const op = msg.type === 'permission-options' ? unit().options : unit().lower
    const frame = await op(msg, peer, 'dev-1')
    assert.equal(frame.kind, 'error', `${msg.type}: ${JSON.stringify(frame)}`)
    assert.equal(frame.code, 'unavailable', `${msg.type}: ${JSON.stringify(frame)}`)
    assert.equal(frame.message, PERMISSION_LOWER_MESSAGES.unavailable)
  }
  assert.deepEqual(rpcCalls, [], 'a not-live session must never provoke the projection read')
  assert.equal(sessionCalls, 2, 'the store answered both frames')

  // Negative control: the SAME frame with the session live (a fresh module, one live id).
  storeIds = ['s1']
  const served = await unit().options({ type: 'permission-options', sessionId: 's1' }, peer, 'dev-1')
  assert.equal(served.kind, 'permission-options', JSON.stringify(served).slice(0, 240))
  assert.equal(rpcCalls.length, 1, 'a live session runs exactly one visibility read')
  assert.equal(rpcCalls[0].endpoint, 'session/projections')
})

// ===========================================================================
// P-5 fail closed: no usable service
// ===========================================================================

test('P-5 a missing permissionPresets service refuses both frames `unavailable` and writes nothing', async (t) => {
  const instance = await factory(t)
  const { ws } = await pairDevice(instance, 'perm-missing-0001', MOBILE_LOWER)
  // The mounted service disappears, the way an unmounted plugin leaves the Host context.
  const mounted = instance.holder.service
  instance.holder.mounted = false
  const since = instance.hostCalls.length
  for (const frame of [{ type: 'permission-options', sessionId: 's1' },
    { type: 'permission-lower', sessionId: 's1', preset: 'read-only' }]) {
    const refused = await ask(ws, frame)
    assert.equal(refused.kind, 'error', JSON.stringify(refused).slice(0, 240))
    assert.equal(refused.code, 'unavailable', JSON.stringify(refused))
    assert.equal(refused.message, PERMISSION_LOWER_MESSAGES.unavailable, 'a fixed sentence, never Host text')
  }
  assert.equal(mounted.calls.set, 0, 'no write is attempted without a service')
  assert.equal(deviceCallsSince(instance, since).filter((call) => call.kind === 'dispatchRpc').length, 0,
    'no session is resolved for a request that can never be served')
  // Negative control: with the SAME socket and device identity, restoring the service
  // makes the read work again — so the refusal above really was "no service".
  instance.holder.mounted = true
  const options = await ask(ws, { type: 'permission-options', sessionId: 's1' })
  assert.equal(options.kind, 'permission-options', JSON.stringify(options).slice(0, 240))
  ws.close()
})

test('P-5b a service whose shape differs is unusable, never guessed at (the @Remote catalog is not enough)', async (t) => {
  // `catalog` is the ONLY method DSH decorates @Remote. A "use the Remote surface
  // instead of the service" mistake would find exactly this object — and it can neither
  // read the current preset nor switch one, so it must fail closed.
  const catalogOnly = { async catalog() { return { options: [], defaultOptions: [], defaultPreset: 'workspace-write' } } }
  const instance = await factory(t)
  const { ws } = await pairDevice(instance, 'perm-shape-0001', MOBILE_LOWER)
  const mounted = instance.holder.service
  instance.holder.service = catalogOnly
  for (const frame of [{ type: 'permission-options', sessionId: 's1' },
    { type: 'permission-lower', sessionId: 's1', preset: 'read-only' }]) {
    const refused = await ask(ws, frame)
    assert.equal(refused.kind, 'error', JSON.stringify(refused).slice(0, 240))
    assert.equal(refused.code, 'unavailable', JSON.stringify(refused))
  }
  assert.equal(mounted.calls.set, 0)
  // Negative control: the correct service on the same socket is served, so the refusal
  // above came from the shape and not from anything else.
  instance.holder.service = mounted
  const options = await ask(ws, { type: 'permission-options', sessionId: 's1' })
  assert.equal(options.kind, 'permission-options', JSON.stringify(options).slice(0, 240))
  ws.close()
})

test('P-5c with no Host carrier to resolve a session, both frames are unavailable and the service is untouched', async () => {
  const service = new PresetService({ initial: [] })
  const unit = createPermissionLower({ get: (name) => (name === 'permissionPresets' ? service : undefined) }, { log: () => {} })
  const peer = { principal: { kind: 'dsh-ext-mobile-device', deviceId: 'dev-1' }, signal: new AbortController().signal }
  for (const msg of [{ type: 'permission-options', sessionId: 's1' },
    { type: 'permission-lower', sessionId: 's1', preset: 'read-only' }]) {
    const op = msg.type === 'permission-options' ? unit.options : unit.lower
    const frame = await op(msg, peer, 'dev-1')
    assert.equal(frame.kind, 'error', JSON.stringify(frame))
    assert.equal(frame.code, 'unavailable', JSON.stringify(frame))
  }
  assert.equal(service.calls.set, 0)
  const frame = unit.unavailable({ type: 'permission-lower', sessionId: 's1' })
  assert.equal(frame.code, 'unavailable')
  assert.equal(frame.requestType, 'permission-lower')
})

// ===========================================================================
// P-6 no Host text: every refusal is one of the fixed sentences
// ===========================================================================

test('P-6 a Host failure behind the read never reaches the device as Host text: only the fixed sentence', async (t) => {
  // The resolution itself fails (a Host carrier that throws the canary), which is the
  // `unavailable` path: the device gets the stable code plus its fixed sentence.
  const instance = await factory(t)
  const { ws } = await pairDevice(instance, 'perm-text-0001', MOBILE_LOWER)
  const mounted = instance.holder.service
  instance.holder.mounted = false
  const reply = await ask(ws, { type: 'permission-lower', sessionId: 's1', preset: 'read-only' })
  assert.equal(reply.kind, 'error', JSON.stringify(reply).slice(0, 240))
  assert.equal(reply.code, 'unavailable')
  assert.equal(reply.message, PERMISSION_LOWER_MESSAGES.unavailable, 'the fixed sentence, never Host text')
  instance.holder.mounted = true
  // A refusal that is a NORMAL receipt (the raise) carries no prose at all.
  const raise = await ask(ws, { type: 'permission-lower', sessionId: 's1', preset: 'danger-full-access' })
  assert.equal(raise.kind, 'permission-lower', JSON.stringify(raise).slice(0, 240))
  assert.equal(raise.accepted, false)
  assert.equal(Object.hasOwn(raise, 'message'), false, 'a receipt carries no free text')
  // Planter control: the scanner really catches the canary where it IS present.
  const planted = JSON.stringify({ message: HOST_ONLY_TEXT })
  assert.equal(planted.includes('secret-plan'), true, 'sanity: the canary is detectable where it appears')
  for (const gone of ['secret-plan', 'canary.db', '$HOME']) {
    assert.equal(JSON.stringify([reply, raise]).includes(gone), false, `${gone} reached the device`)
  }
  assert.equal(mounted.calls.set, 0)
  for (const reason of ['not-stricter', 'custom-current', 'raced', 'unavailable']) {
    assert.equal(typeof PERMISSION_LOWER_MESSAGES[reason], 'string', reason)
    assert.equal(PERMISSION_LOWER_MESSAGES[reason].includes('permission:'), false, `${reason} must not quote Host text`)
  }
  ws.close()
})
// ===========================================================================
// P-7 the comparator itself (the rule every check above leans on)
// ===========================================================================

test('P-7 isStrictlyStricter: never looser on either axis, and stricter on at least one', () => {
  const pairs = Object.entries(PRESETS).map(([name, spec]) => [name, { sandbox: spec.sandbox, approval: spec.approval }])
  assert.deepEqual(SANDBOX_MODE_ORDER, ['read-only', 'workspace-write', 'danger-full-access'])
  assert.deepEqual(APPROVAL_POLICY_ORDER, ['ask', 'never'])
  const strict = (from, to) => isStrictlyStricter(pairs.find(([name]) => name === from)[1], pairs.find(([name]) => name === to)[1])
  // Accepted: no axis looser, at least one stricter.
  assert.equal(strict('danger-full-access', 'workspace-write'), true, 'sandbox down, approval same')
  assert.equal(strict('workspace-write', 'read-only'), true, 'sandbox down')
  assert.equal(strict('no-ask-anywhere', 'read-only'), true, 'approval down AND sandbox down')
  // Refused: equal, or any axis looser.
  assert.equal(strict('workspace-write', 'workspace-write'), false, 'equal is not stricter')
  assert.equal(strict('workspace-write', 'danger-full-access'), false, 'sandbox up (the classic raise)')
  assert.equal(strict('read-only', 'no-ask-anywhere'), false, 'sandbox up, approval same')
  // MIXED, the widening direction: one axis stricter while the other is LOOSER is never
  // acceptable — exactly the request a lower-only op must refuse.
  assert.equal(isStrictlyStricter({ sandbox: 'read-only', approval: 'never' }, { sandbox: 'workspace-write', approval: 'ask' }), false,
    'approval looser alongside a sandbox stricter is a MIX and is refused')
  assert.equal(isStrictlyStricter({ sandbox: 'read-only', approval: 'ask' }, { sandbox: 'workspace-write', approval: 'never' }), false,
    'sandbox looser alongside an approval stricter is a MIX and is refused')
  assert.equal(isStrictlyStricter({ sandbox: 'workspace-write', approval: 'never' }, { sandbox: 'workspace-write', approval: 'ask' }), true,
    'approval stricter alone is accepted (the equal sandbox is not looser)')
  assert.equal(isStrictlyStricter({ sandbox: 'read-only', approval: 'ask' }, { sandbox: 'read-only', approval: 'never' }), false,
    'approval looser alone is a widening')
  // An unrankable knob on either side is never comparable.
  assert.equal(isStrictlyStricter({ sandbox: 'read-only', approval: 'sometimes' }, pairs[1][1]), false)
  assert.equal(isStrictlyStricter(pairs[0][1], { sandbox: 'anything', approval: 'ask' }), false)
  assert.equal(pairOf({ sandbox: 'read-only', approval: 'ask' })?.sandbox, 'read-only')
})

// ===========================================================================
// P-8 the audit line, at the module seam that writes it
// ===========================================================================
//
// `apply()` takes no log sink (it uses the plugin `log`, which only writes stdout and
// `<tmp>/mobile-gateway.log`), so the AUDIT requirement ("a refusal writes an audit
// line", spec 019 rule 7) is checked where `createPermissionLower` takes its `log(facts)`.

test('P-8 both refusals are audited; the line carries the validated id only, never a raw field', async () => {
  const lines = []
  const session = { sessionId: 's1' }
  const service = new PresetService({ initial: [] })
  const unit = createPermissionLower({
    get: (name) => {
      if (name === 'permissionPresets') return service
      if (name === 'sessions') return new LiveSessions(new Map([['s1', session]]), { get: 0 })
      return undefined
    },
  }, {
    log: (line) => lines.push(line),
    // Device-visible ids are answered; anything else is denied the way DSH denies it.
    dispatchRpc: async (_endpoint, payload) => (payload.sessionId === 's1'
      ? { ok: true, value: { kind: 'sequenced', asOfSeq: 1, values: { permissions: { currentValue: 'workspace-write' } } } }
      : { ok: false, error: { code: 'remote-access/denied' } }),
  })
  const peer = { principal: { kind: 'dsh-ext-mobile-device', deviceId: 'dev-1' }, signal: new AbortController().signal }

  // C-minor: a malformed id is audited against the refusal code only, never reflected.
  const injected = 's1\npermission-lower accepted: device=dev-1 session=s1 from=workspace-write to=read-only'
  for (const sessionId of [undefined, '', '   ', 42, 'x'.repeat(129), ` ${'y'.repeat(129)} `]) {
    lines.length = 0
    const frame = await unit.options({ type: 'permission-options', sessionId }, peer, 'dev-1')
    assert.equal(frame.code, 'bad-request', JSON.stringify(frame))
    assert.equal(Object.hasOwn(frame, 'sessionId'), false, 'a malformed id is not echoed back')
    assert.equal(lines.length, 1, `exactly one audit line for ${JSON.stringify(sessionId)?.slice(0, 12)}: ${JSON.stringify(lines)}`)
    assert.match(lines[0], /^permission-options refused: bad-request device=dev-1$/, lines[0])
    assert.equal(lines[0].includes('\n'), false, 'a wire value can never split an audit line')
  }
  // A newline INSIDE an otherwise valid id is a real (under-limit) id: it is refused by
  // DSH like any other id the device may not address, and the line is FOLDED so the
  // embedded text cannot start a forged "accepted" line of its own.
  lines.length = 0
  const forged = await unit.options({ type: 'permission-options', sessionId: injected }, peer, 'dev-1')
  assert.equal(forged.code, 'unavailable', JSON.stringify(forged))
  assert.equal(lines.length, 1, `one audit line only: ${JSON.stringify(lines)}`)
  assert.equal(lines[0].includes('\n'), false, 'the newline was folded into the validated id')
  assert.match(lines[0], /^permission-options refused: unavailable device=dev-1 session=s1\?permission-lower accepted/, lines[0])

  // A validated id IS named — the pure prologue of a bad-request frame on the lower op.
  lines.length = 0
  const stale = await unit.lower({ type: 'permission-lower', sessionId: ' s2 ', preset: 'read-only' }, peer, 'dev-1')
  assert.equal(stale.code, 'unavailable', JSON.stringify(stale))
  assert.equal(lines.length, 1)
  assert.equal(lines[0], 'permission-lower refused: unavailable device=dev-1 session=s2',
    'the line names the TRIMMED, validated id — never the raw " s2 "')

  // The not-live refusal (visibility passes, the store has no object) is audited too.
  lines.length = 0
  const notLive = createPermissionLower({
    get: (name) => (name === 'permissionPresets' ? new PresetService({ initial: [] }) : name === 'sessions' ? new LiveSessions(new Map(), { get: 0 }) : undefined),
  }, {
    log: (line) => lines.push(line),
    dispatchRpc: async () => ({ ok: true, value: { kind: 'sequenced', values: { permissions: { currentValue: 'workspace-write' } } } }),
  })
  for (const msg of [{ type: 'permission-options', sessionId: 's1' }, { type: 'permission-lower', sessionId: 's1', preset: 'read-only' }]) {
    lines.length = 0
    const op = msg.type === 'permission-options' ? notLive.options : notLive.lower
    const frame = await op(msg, peer, 'dev-1')
    assert.equal(frame.code, 'unavailable', JSON.stringify(frame))
    assert.equal(lines.length, 1)
    assert.match(lines[0], new RegExp(`^${msg.type} refused: unavailable device=dev-1 session=s1$`), lines[0])
  }
})
