// Spec 011 — ADVERSARIAL coverage for the `sessions:author` exposure.
//
// Every case below drives a REAL request through the gateway's own router (the
// plugin's `apply()` runs: upgrade, credential, scope gate, deny layers, adapter,
// remote bridge) against a RECORDING fake Host. A case passes only when the
// gateway refuses and the fake Host's call log proves nothing was attempted —
// so a gap shows up as an observed Host call or an accepted operation, not as an
// opinion about the code.
//
// Items (1)-(7) are the reviewer's mandated adversarial list; (8) is the
// reviewer's Minor 1 (`workspaces` must not leak Host filesystem paths) and the
// null-form of Minor 2. Read-only: this file never patches the implementation.
import assert from 'node:assert/strict'
import crypto from 'node:crypto'
import fs from 'node:fs'
import http from 'node:http'
import os from 'node:os'
import path from 'node:path'
import { once } from 'node:events'
import { test } from 'node:test'

import WebSocket from 'ws'
import * as contract from '@dsh-ext/mobile-protocol'
import plugin from '../lib/index.mjs'
import { createTestConnection, createTestRemoteAccess } from './helpers/peer.mjs'
import { COMPANION_ENDPOINTS, createCompanionAccessPolicy } from '../lib/companion-access.mjs'
import { AUTHOR_SCOPE, SCOPE_EXEMPT_TYPES, scopeDenial, scopeDenialAgainst } from '../lib/allowlist.mjs'
import { setOwnerOnlyProbeOverride } from '../lib/secure-file.mjs'
import { listenFetchSafe } from './support/fetch-safe-listen.mjs'

const AUTHOR = AUTHOR_SCOPE
const WORKSPACE_ID = 'w-host-1'
/** A path that must never reach a phone holding only `sessions:author`. */
const SECRET_PATH = '/Users/owner/secret-tax-2025'
const delay = (ms) => new Promise((resolve) => setTimeout(resolve, ms))

/** The Host endpoints spec 011 FR-004 keeps refused for EVERY device (revision 11
 * moved ONE session's rename/archive to `sessions:author`, see ADV-2c). */
const HARD_BLOCKED_ENDPOINTS = [
  'workspace/create', 'workspace/rename',
  'session/fork', 'session/updateQueue',
  'commands/list', 'commands/execute', 'settings/update', 'settings/mutate',
  'pluginManager/installBundle', 'pluginManager/setPluginEnabled',
  'schedule/create', 'schedule/edit', 'goals/set',
]

/** Typed router ops that must stay `op/forbidden` even with `sessions:author`. */
// Spec 018 item 2: `agent-team` and `subagents` are NOT here any more — they are read-on-demand
// of data `sessions:read` already grants, so they are refused BY SCOPE (asserted by ADV-16a)
// rather than as unknown operations. Every other family still stays op/forbidden here.
// Revision 11: `session-rename` / `session-archive` left this list on purpose — they are
// companion §4 ops now, refused BY SCOPE without `sessions:author` (ADV-2c / ADV-11).
const HARD_BLOCKED_TYPES = [
  'workspace-create', 'fork', 'queue-update',
  'commands', 'command-execute', 'settings', 'settings-update', 'settings-mutate',
  'plugin-catalog', 'plugin-install', 'schedule-create', 'schedule-edit', 'goal',
  'goal-edit', 'attachment', 'directories', 'directory-create',
]

function fakeHost(hostCalls, workspaceRows, sessionRows, options = {}) {
  const record = (kind, request) => hostCalls.push({
    kind, endpoint: `${request.namespace}/${request.method}`, principal: request.peer?.principal, args: request.args,
  })
  return {
    async invoke(request) {
      record('invoke', request)
      const { namespace, method } = request
      if (namespace === 'session' && method === 'list') return { items: sessionRows ?? [{ sessionId: 's1' }] }
      if (namespace === 'session' && method === 'modelCatalog') {
        return { default: { provider: 'p', model: 'm' }, routableProviders: ['p'], groups: [], failures: [] }
      }
      if (namespace === 'session' && method === 'create') return { sessionId: 's-new' }
    // Spec 018 item 2: the per-session projection snapshot the team/subagent frames read.
    // `projectionResult` lets a test choose the shape (including `null` = "this device may not
    // see that session", which is how the Host expresses per-item authorization).
    // Spec 018 item 3: the read-only schedule surface.
    if (namespace === 'schedule' && method === 'catalog') {
      // The adapter reads this endpoint as a raw array (it wraps it into `{ items }` itself).
      return options.scheduleCatalog === undefined ? [] : options.scheduleCatalog()
    }
    if (namespace === 'schedule' && method === 'list') {
      return options.scheduleList === undefined ? { items: [] } : options.scheduleList(request.args)
    }
    if (namespace === 'schedule' && method === 'view') {
      return options.scheduleView === undefined
        ? { id: request.args?.request?.id, target: { sessionId: 's1' }, involvedSessionIds: ['s1'] }
        : options.scheduleView(request.args)
    }
    if (namespace === 'session' && method === 'rename') {
      return options.sessionRename === undefined
        ? { title: request.args?.request?.title, seq: 95 }
        : options.sessionRename(request.args)
    }
    if (namespace === 'workspace' && method === 'archiveSession') {
      // Reviewer item 5(a): the REAL Host answers `workspace/archiveSession` with its
      // COMPLETE archive set, not just the id it just archived (PROTOCOL.md §5). The
      // default below mirrors that, so a test can verify the device never receives the
      // ids of sessions it cannot see; a test may still override it.
      return options.archiveSession === undefined
        ? { archivedSessionIds: [request.args?.request?.sessionId, 's-hidden'] }
        : options.archiveSession(request.args)
    }
    if (namespace === 'session' && method === 'projections') {
      // A test may pass a FUNCTION so the mock decides per session — that is what makes the
      // "session this device may not see" case discriminate from "the feature is broken".
      if (typeof options.projectionResult === 'function') return options.projectionResult(request.args)
      return options.projectionResult === undefined
        ? { kind: 'sequenced', asOfSeq: 1, values: {} }
        : options.projectionResult
    }
    if (namespace === 'session' && method === 'selectModel') {
      return { provider: request.args?.request?.provider, model: request.args?.request?.model }
    }
    return {}
  },
    async stream(request) {
      record('stream', request)
      return (async function* () {
        if (request.namespace === 'workspace' && request.method === 'follow') {
          // The Host's real baseline: identity + absolute path + members + times.
          // Measured 2026-11-10 on a real Host: `name` is EMPTY on every row and only
          // `path` is populated, which is what the label fallback exists for.
          yield {
            type: 'baseline',
            value: {
              items: workspaceRows ?? [{
                workspaceId: WORKSPACE_ID, title: 'proj', path: SECRET_PATH,
                sessionIds: ['s1', 's-hidden'], createdAt: '2026-11-01T00:00:00.000Z',
              }],
              archivedSessionIds: ['s-hidden'],
            },
          }
        } else if (request.namespace === 'session' && request.method === 'follow') {
          const address = request.args?.request?.address
          const id = address?.kind === 'subagent' ? address.childSessionId : address?.sessionId
          // Spec 018: exercise a Host-side per-item refusal (DSH's `allows()` says no).
          if (options.denySessionFollow === true) {
            throw Object.assign(
              new Error('remote access: session/follow: access denied (resource-not-allowed)'),
              { code: 'remote-access/denied' },
            )
          }
          // Spec 018: the metric handlers read session projections, so the fixture
          // has to be able to serve them (default: none, as a fresh Host session).
          const values = options.projectionValues?.[id] ?? {}
          yield { type: 'snapshot', header: { version: 4, id }, cursor: 1, records: [], hasMore: false,
            projections: { asOfSeq: 1, values }, assistantStream: { revision: 0 } }
        } else {
          yield { type: 'baseline', value: { projections: {} } }
        }
        while (!request.signal?.aborted) await delay(10)
      })()
    },
  }
}

async function factory(t, options = {}) {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'dsh-author-adv-'))
  // One DACL read per fixture kept a 10 s PowerShell probe per warm-up, and under load
  // several timed out (`ETIMEDOUT`), failing this file and stretching the run. The
  // fixtures' data directories are created by this process seconds earlier, so they
  // are owner-only exactly as the real probe requires; `tls-pin.test.mjs` still runs
  // that probe for real on a generated key and its directory. Restored by the `t.after` below.
  setOwnerOnlyProbeOverride(() => null)
  // Registered HERE, not with the teardown below: `apply()` can throw, and the override
  // must be cleared even then (a process-wide seam left installed would answer the
  // owner-only check for every later fixture).
  t.after(() => setOwnerOnlyProbeOverride(undefined))
  const sockets = []
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
  // Host events the plugin subscribes to (`api-session/added`, `api-session/removed`,
  // …). Recorded so a test can drive the reconciliation path the way the Host does.
  const events = new Map()
  const remoteAccess = createTestRemoteAccess()
  await plugin.apply({
    webServer: {
      port,
      register(route) { management = route; return () => {} },
      registerUpgrade(route) { upgrade = route; return () => {} },
    },
    connection: createTestConnection(),
    remoteAccess,
    typertGateway: fakeHost(hostCalls, options.workspaceRows, options.sessionRows, options),
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
    gatewayName: `author-adv-${port}`,
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
    directory,
    events,
    remoteAccess,
    base: `http://127.0.0.1:${port}`,
    async post(route, body) {
      const response = await fetch(`${instance.base}/mgw/${route}`, {
        method: 'POST', headers: { 'Content-Type': 'application/json', Origin: instance.base }, body: JSON.stringify(body ?? {}),
      })
      let data = null
      try { data = await response.json() } catch { /* non-JSON error page */ }
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
  const requestId = `adv-${++counter}`
  ws.send(JSON.stringify({ ...frame, requestId }))
  return take(ws, (reply) => reply.requestId === requestId)
}
const callsSince = (instance, since, endpoint) =>
  instance.hostCalls.slice(since).filter((call) => call.endpoint === endpoint)
// What the DEVICE caused. A device peer can never be the owner principal, so an owner-attributed
// call excluded here is never one a device asked for (spec 021: the gateway reads no account on
// its own any more, so in practice every call below is device-attributed).
const callsSinceSet = (instance, since) =>
  [...new Set(instance.hostCalls.slice(since)
    .filter((call) => call.principal?.kind !== 'owner')
    .map((call) => call.endpoint))]

/** Pair a device with an EXPLICIT grant, and return its live connection. */
async function pairDevice(instance, deviceId, offer) {
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

const MOBILE_AUTHOR = { kind: 'mobile', scopes: ['sessions:read', 'prompt:send', 'approval:respond', AUTHOR] }
const DESKTOP_AUTHOR = { kind: 'desktop', scopes: ['sessions:read', 'prompt:send', 'approval:respond', AUTHOR] }
const MOBILE_NO_AUTHOR = { kind: 'mobile', scopes: ['sessions:read', 'prompt:send', 'approval:respond'] }
/** Spec 018 item 4: the scope tuple that answers questions and approvals. */
const DESKTOP_BRIDGE_NO_AUTHOR = {
  kind: 'desktop', scopes: ['sessions:read', 'prompt:send', 'approval:respond', 'harness:remote'],
}
const DESKTOP_BRIDGE_AUTHOR = {
  kind: 'desktop', scopes: ['sessions:read', 'prompt:send', 'approval:respond', 'harness:remote', AUTHOR],
}

// ===========================================================================
// (1) The grant is revoked while the socket is open
// ===========================================================================

test('ADV-1a re-pairing with a narrower grant makes the open socket stale: the next authoring frame is refused with no Host call', async (t) => {
  const instance = await factory(t)
  const deviceId = 'adv-revoke-0001'
  const first = await pairDevice(instance, deviceId, MOBILE_AUTHOR)
  // Prove the socket works before the change.
  const ok = await ask(first.ws, { type: 'workspaces' })
  assert.equal(ok.kind, 'workspaces', JSON.stringify(ok).slice(0, 200))

  // Re-pair the SAME installation without the scope: the registry rotates the
  // credential and bumps its generation, and the gateway closes every socket the
  // old grant opened (`credential re-paired`, close 4401). Either outcome is a
  // refusal — a closed socket, or `auth/revoked` if the frame raced the close.
  const closed = new Promise((resolve) => first.ws.on('close', (code) => resolve({ closed: code })))
  const narrowed = await pairDevice(instance, deviceId, MOBILE_NO_AUTHOR)
  assert.equal(narrowed.device.scopes.includes(AUTHOR), false, 'the new record must not hold the scope')

  const since = instance.hostCalls.length
  const afterRePair = await Promise.race([
    closed,
    ask(first.ws, { type: 'workspaces' }).then((reply) => ({ reply })).catch(() => ({ closed: 'no-reply' })),
  ])
  if (afterRePair.closed !== undefined) {
    assert.equal(afterRePair.closed, 4401, `a re-paired installation's socket must close 4401 (got ${afterRePair.closed})`)
  } else {
    assert.equal(afterRePair.reply.kind, 'error', JSON.stringify(afterRePair.reply).slice(0, 200))
    assert.equal(afterRePair.reply.code, 'auth/revoked', `→ ${afterRePair.reply.code}`)
  }
  assert.deepEqual(callsSinceSet(instance, since), [], `a stale socket must reach nothing on the Host: ${callsSinceSet(instance, since)}`)
  first.ws.close()
  narrowed.ws.close()
})

test('ADV-1b revoking the device closes the socket and its token cannot reconnect', async (t) => {
  const instance = await factory(t)
  const deviceId = 'adv-revoke-0002'
  const { ws, token, device } = await pairDevice(instance, deviceId, MOBILE_AUTHOR)
  const closed = new Promise((resolve) => ws.on('close', (code) => resolve(code)))
  // The route names the REGISTRY's device id, which is what the pairing answered.
  const revoked = await instance.post(`devices/${device.id}/revoke`, {})
  assert.equal(revoked.status, 200, JSON.stringify(revoked.data))
  assert.equal(revoked.data.revoked, true, JSON.stringify(revoked.data))
  assert.equal(await closed, 4401, 'a revoked credential closes with 4401')
  // The token is dead: a fresh upgrade with it must be refused before any frame.
  const retry = open(instance, ['dsh-mobile-v1', `dsh-auth.${token}`], {})
  record(retry)
  const code = await new Promise((resolve) => { retry.on('error', () => resolve('error')); retry.on('close', (c) => resolve(c)) })
  assert.ok(code === 4401 || code === 'error', `a revoked token must not reconnect (got ${code})`)
})

// ===========================================================================
// (2) Every hard-blocked endpoint, through every route a phone has
// ===========================================================================

test('ADV-2a typed ops: all FR-004 families stay op/forbidden for a device holding sessions:author, and never reach the Host', async (t) => {
  const instance = await factory(t)
  const deviceId = 'adv-carve-0001'
  const { ws } = await pairDevice(instance, deviceId, DESKTOP_AUTHOR)
  const since = instance.hostCalls.length
  for (const type of HARD_BLOCKED_TYPES) {
    const reply = await ask(ws, { type, path: SECRET_PATH, name: 'x', sessionId: 's1', title: 't', ns: 'permission' })
    assert.equal(reply.kind, 'error', `${type}: ${JSON.stringify(reply).slice(0, 220)}`)
    assert.equal(reply.code, 'op/forbidden', `${type} → ${reply.code} (must stay op/forbidden with ${AUTHOR})`)
  }
  assert.deepEqual(callsSinceSet(instance, since), [], `no hard-blocked op may reach the Host: ${callsSinceSet(instance, since)}`)
  ws.close()
})

test('ADV-2b remote-bridge passthrough: the same endpoints are refused for a desktop holding harness:remote + sessions:author', async (t) => {
  const instance = await factory(t)
  const deviceId = 'adv-carve-0002'
  const { ws } = await pairDevice(instance, deviceId, DESKTOP_BRIDGE_AUTHOR)
  const since = instance.hostCalls.length
  for (const endpoint of HARD_BLOCKED_ENDPOINTS) {
    const reply = await ask(ws, { type: 'remote-call', endpoint, args: { request: { path: SECRET_PATH, sessionId: 's1' } } })
    // The bridge answers in-band with a `remote-result` receipt, never a success.
    assert.equal(reply.kind, 'remote-result', `${endpoint} via the bridge: ${JSON.stringify(reply).slice(0, 240)}`)
    assert.equal(reply.ok, false, `${endpoint} must not be honoured by the bridge`)
    assert.equal(typeof reply.error?.code, 'string', `${endpoint} must name a refusal code`)
    assert.notEqual(reply.error.code, 'internal')
  }
  // The remote bridge forwards with the DEVICE's own peer, so what must never appear here is a
  // hard-blocked endpoint forwarded ON BEHALF OF THE DEVICE.
  const devicePeerCalls = instance.hostCalls.slice(since)
    .filter((call) => call.principal?.kind !== 'owner')
    .map((call) => call.endpoint)
  assert.deepEqual([...new Set(devicePeerCalls)], [],
    'the bridge must not forward a hard-blocked endpoint: ' + [...new Set(devicePeerCalls)].join(', '))
  ws.close()
})

// ===========================================================================
// (3) Case / whitespace / slash / encoding variants, device WITHOUT the scope
// ===========================================================================

test('ADV-3a type variants of the authoring ops are refused for a device without the scope, with no Host call', async (t) => {
  const instance = await factory(t)
  const deviceId = 'adv-variant-0001'
  const { ws } = await pairDevice(instance, deviceId, MOBILE_NO_AUTHOR)
  const since = instance.hostCalls.length
  const variants = [
    'Session-Create', 'SESSION-CREATE', 'session-create ', ' session-create', 'session-create\n',
    'session/selectModel', 'session-create/', 'session%2Fcreate', 'Select-Model', 'select-model ',
    'WORKSPACES', 'workspaces ', 'Models',
  ]
  for (const type of variants) {
    const reply = await ask(ws, { type, sessionId: 's1', provider: 'p', model: 'm', workspaceId: WORKSPACE_ID })
    assert.equal(reply.kind, 'error', `${JSON.stringify(type)}: ${JSON.stringify(reply).slice(0, 200)}`)
    assert.ok(['op/forbidden', 'auth/forbidden-scope', 'bad-request'].includes(reply.code),
      `${JSON.stringify(type)} → unexpected code ${reply.code}`)
    assert.notEqual(reply.kind, 'workspaces')
    assert.notEqual(reply.kind, 'session-created')
  }
  assert.deepEqual(callsSinceSet(instance, since), [], `a type variant must not reach the Host: ${callsSinceSet(instance, since)}`)
  ws.close()
})

test('ADV-3b endpoint spelling variants cannot slip through the remote bridge for a device without the scope', async (t) => {
  const instance = await factory(t)
  const deviceId = 'adv-variant-0002'
  const { ws } = await pairDevice(instance, deviceId, DESKTOP_BRIDGE_NO_AUTHOR)
  const since = instance.hostCalls.length
  const variants = [
    'Session/Create', 'session/Create', 'session/create ', 'session/create/', 'session//create',
    'session%2Fcreate', 'session/create?x=1', ' session/create', 'session/selectModel ', 'Session/SelectModel',
    'workspace/follow ', 'Workspace/Follow',
  ]
  for (const endpoint of variants) {
    const reply = await ask(ws, { type: 'remote-call', endpoint, args: { request: { sessionId: 's1' } }, requestId: `v-${endpoint}` })
    assert.equal(reply.kind, 'remote-result', `${JSON.stringify(endpoint)}: ${JSON.stringify(reply).slice(0, 220)}`)
    assert.equal(reply.ok, false, `${JSON.stringify(endpoint)} must not be forwarded`)
    // A malformed name is refused as `bad-request` before the allowlist runs; a
    // well-formed but unlisted one as `op/forbidden`. Both are refusals.
    assert.ok(['op/forbidden', 'bad-request'].includes(reply.error?.code),
      `${JSON.stringify(endpoint)} → ${reply.error?.code}`)
  }
  assert.deepEqual(callsSinceSet(instance, since), [], `an endpoint variant must not reach the Host: ${callsSinceSet(instance, since)}`)
  ws.close()
})

// ===========================================================================
// (4) Malformed scope lists can never yield the author scope
// ===========================================================================

test('ADV-4a a pairing request with a malformed scope list is refused or grants nothing — never sessions:author', async (t) => {
  const instance = await factory(t)
  const malformed = [
    'sessions:author',            // a bare string, not an array
    { scopes: AUTHOR },           // an object where a list belongs
    null,
    42,
    [['sessions:author']],        // nested array
    ['sessions:author '],         // trailing space
    [' sessions:author'],         // leading space
    ['*'],                        // wildcard
    ['sessions:*'],
    ['SESSIONS:AUTHOR'],
    ['sessions:author', 'not-a-scope'],
  ]
  for (const scopes of malformed) {
    const reply = await instance.post('pair', { mode: 'otp', kind: 'mobile', scopes })
    if (reply.status === 201) {
      assert.equal(reply.data.pairing.scopes.includes(AUTHOR), false,
        `malformed ${JSON.stringify(scopes)} must not yield the scope`)
    } else {
      assert.ok(reply.status >= 400 && reply.status < 500, `malformed ${JSON.stringify(scopes)} → ${reply.status}`)
    }
  }
})

test('ADV-4b a hand-edited device record with malformed scopes grants nothing', async (t) => {
  const instance = await factory(t)
  const deviceId = 'adv-malformed-0001'
  // Pair without the scope, then rewrite the record on disk the way an attacker
  // with local access would try to escalate, and restart the registry.
  const first = await pairDevice(instance, deviceId, MOBILE_NO_AUTHOR)
  first.ws.close()
  const storePath = path.join(instance.directory, 'devices.json')
  const store = JSON.parse(fs.readFileSync(storePath, 'utf8'))
  for (const scopes of ['sessions:author', [['sessions:author']], ['sessions:author '], ['*'], [AUTHOR, 'junk-scope']]) {
    const tampered = JSON.parse(JSON.stringify(store))
    tampered.devices[0].scopes = scopes
    fs.writeFileSync(storePath, JSON.stringify(tampered))
    const reply = await instance.post('pair', { mode: 'otp', kind: 'mobile', scopes: [AUTHOR] })
    assert.equal(reply.status, 201)
    // The live registry decides from memory; a malformed record must never be
    // repaired into a grant. Assert through the next authoring request instead of
    // trusting the file alone.
    const probe = await (async () => {
      const { ws } = await pairDevice(instance, `adv-malformed-${Math.random().toString(16).slice(2, 8)}`, MOBILE_NO_AUTHOR)
      const since = instance.hostCalls.length
      const answer = await ask(ws, { type: 'workspaces' })
      const calls = callsSinceSet(instance, since)
      ws.close()
      return { answer, calls }
    })()
    assert.equal(probe.answer.code, 'auth/forbidden-scope', JSON.stringify(scopes))
    assert.deepEqual(probe.calls, [], JSON.stringify(scopes))
  }
})

// ===========================================================================
// (5) session-create argument smuggling, incl. the null forms (Minor 2)
// ===========================================================================

test('ADV-5a session-create refuses cwd / agentPreset (including explicit null) for a phone holding ONLY the author scope, with no Host call', async (t) => {
  const instance = await factory(t)
  const deviceId = 'adv-create-0001'
  const { ws } = await pairDevice(instance, deviceId, MOBILE_AUTHOR)
  const since = instance.hostCalls.length
  const smuggles = [
    { cwd: SECRET_PATH },
    { cwd: 'C:\\Windows\\System32' },
    { cwd: '/etc' },
    { cwd: '' },
    { cwd: null },
    { agentPreset: 'minimal' },
    { agentPreset: null },
    { agentPreset: '' },
    { cwd: SECRET_PATH, workspaceId: WORKSPACE_ID },
    { agentPreset: 'minimal', workspaceId: WORKSPACE_ID },
    { cwd: null, agentPreset: null },
  ]
  for (const extra of smuggles) {
    const reply = await ask(ws, { type: 'session-create', ...extra })
    assert.equal(reply.kind, 'error', `${JSON.stringify(extra)}: ${JSON.stringify(reply).slice(0, 240)}`)
    // `cwd`/`agentPreset` present with ANY value (null included) is a refusal: the
    // phone must not be able to choose a directory or an agent composition.
    assert.equal(reply.code, 'remote/argument-denied', `${JSON.stringify(extra)} → ${reply.code}`)
    assert.equal(reply.requestType, 'session-create')
  }
  assert.deepEqual(callsSince(instance, since, 'session/create'), [],
    'a refused session-create must not create a session on the Host')
  ws.close()
})

test('ADV-5b session-create refuses a foreign, blank, omitted or non-string workspace and permission/mode smuggling', async (t) => {
  const instance = await factory(t)
  const deviceId = 'adv-create-0002'
  const { ws } = await pairDevice(instance, deviceId, MOBILE_AUTHOR)
  const since = instance.hostCalls.length
  // A workspaceId this Host does not have, or one the device never names, is
  // refused (FR-005 + lead decision 2026-11-10: a phone holding only
  // `sessions:author` must NAME a workspace — omission would let the create land in
  // the Host's own default working directory, which the phone did not choose).
  const refusedWorkspaces = [
    'w-somewhere-else', '../w-host-1', 'w-host-1/../x', 'w-host-1\u0000', 'w-host-1\u0007',
    undefined, '', '   ', '\t\n', 0, 42, true, null, ['w-host-1'], { workspaceId: WORKSPACE_ID },
  ]
  for (const workspaceId of refusedWorkspaces) {
    const frame = { type: 'session-create', ...(workspaceId === undefined ? {} : { workspaceId }) }
    const reply = await ask(ws, frame)
    assert.equal(reply.kind, 'error', `workspaceId=${JSON.stringify(workspaceId)}: ${JSON.stringify(reply).slice(0, 240)}`)
    assert.equal(reply.code, 'remote/argument-denied', `workspaceId=${JSON.stringify(workspaceId)} → ${reply.code}`)
    assert.equal(reply.requestType, 'session-create')
  }
  assert.deepEqual(callsSince(instance, since, 'session/create'), [],
    'no refused session-create may reach the Host')

  // A workspace of this Host still works, and smuggled extra fields never travel.
  const accepted = await ask(ws, { type: 'session-create', workspaceId: WORKSPACE_ID })
  assert.equal(accepted.kind, 'session-created', JSON.stringify(accepted).slice(0, 240))
  const first = callsSince(instance, since, 'session/create')
  assert.equal(first.length, 1, JSON.stringify(first))

  const after = instance.hostCalls.length
  const smuggled = await ask(ws, {
    type: 'session-create', workspaceId: WORKSPACE_ID,
    permission: 'bypass', permissionMode: 'yolo', mode: 'full-access', scopes: [AUTHOR], kind: 'desktop', path: SECRET_PATH,
  })
  assert.equal(smuggled.kind, 'session-created', JSON.stringify(smuggled).slice(0, 200))
  const created = callsSince(instance, after, 'session/create')
  assert.equal(created.length, 1)
  const payload = JSON.stringify(created[0].args ?? {})
  for (const leak of ['bypass', 'yolo', 'full-access', SECRET_PATH, 'sessions:author']) {
    assert.equal(payload.includes(leak), false, `the create payload must not carry ${leak}: ${payload.slice(0, 300)}`)
  }
  ws.close()
})

// ===========================================================================
// (6) select-model cannot widen what the device may address or choose
// ===========================================================================

test('ADV-6a select-model is a per-session resource: the policy grants nothing for a session outside the visible set', () => {
  // The gateway forwards `session/selectModel` as a `session` resource, so DSH
  // applies to it the identical rule it applies to `session/prompt` (proven
  // against the real RemoteAccessService in test/device-access-real.test.mjs).
  assert.deepEqual({ ...COMPANION_ENDPOINTS['session/selectModel'] },
    { scope: AUTHOR, resource: 'session' }, 'select-model must stay a per-session resource')
  assert.deepEqual({ ...COMPANION_ENDPOINTS['session/prompt'] },
    { scope: 'prompt:send', resource: 'session' }, 'session/prompt is the reference rule')
  const policy = createCompanionAccessPolicy({
    getDevice: () => ({ kind: 'mobile', scopes: ['sessions:read', AUTHOR] }),
    getSessionIds: () => ['s1'],
  })
  const explain = policy.explain({ resource: { kind: 'session', id: 's-foreign' }, action: 'session/selectModel' })
  assert.notEqual(explain, undefined, 'a session outside the visible set must not be explained as allowed')
  const denied = policy.explain({ resource: { kind: 'session', id: 's1' }, action: 'session/selectModel' })
  assert.notEqual(denied, true, 'the visible session must be decided by the bindings, not by a wildcard')
})

test('ADV-6b select-model for an unknown session is never answered with a success frame', async (t) => {
  const instance = await factory(t)
  const deviceId = 'adv-select-0001'
  const { ws } = await pairDevice(instance, deviceId, MOBILE_AUTHOR)
  // The fake Host answers only what it is asked; an unaddressable session is
  // refused by DSH before this fake is reached in production. Here we assert the
  // gateway never turns such a request into an accepted selection on its own.
  const reply = await ask(ws, { type: 'select-model', sessionId: 's-foreign', provider: 'p', model: 'm' })
  assert.notEqual(reply.kind, 'session-created')
  if (reply.kind === 'select-model') {
    // Acceptable ONLY because this harness has no DSH policy: the fake Host answers
    // every call. The gate that stops it in a real Host is the per-session resource
    // mapping asserted in ADV-6a, exercised against the real RemoteAccessService in
    // test/device-access-real.test.mjs.
    assert.equal(reply.kind, 'select-model')
  } else {
    assert.equal(reply.kind, 'error')
  }
  ws.close()
})

// ===========================================================================
// (7) The grant can only come from the owner's offer, never from the client
// ===========================================================================

test('ADV-7a no-scope offers never carry the author scope, on both pairing paths', async (t) => {
  const instance = await factory(t)
  for (const kind of ['mobile', 'desktop']) {
    const reply = await instance.post('pair', { mode: 'otp', kind })
    assert.equal(reply.status, 201, JSON.stringify(reply.data))
    assert.equal(reply.data.pairing.scopes.includes(AUTHOR), false, `${kind} default offer must not include ${AUTHOR}`)
  }
  // The direct claim path grants the registry default, which is narrower still.
  const direct = await pairDevice(instance, 'adv-offer-0001', {})
  assert.equal(direct.device.scopes.includes(AUTHOR), false, 'a no-scope claim must not grant the author scope')
  direct.ws.close()
})

test('ADV-7b a client cannot assert its own scopes through client-hello, the pairing claim or a smuggled device record', async (t) => {
  const instance = await factory(t)
  const deviceId = 'adv-selfassert-0001'
  const created = await instance.post('pair', { name: deviceId, publicUrl: instance.lanUrl, ...MOBILE_NO_AUTHOR })
  assert.equal(created.status, 201)
  const ws = open(instance, ['dsh-mobile-v1', `dsh-pair.${created.data.payload.pairingCode}`], { 'X-DSH-Device-ID': deviceId })
  record(ws)
  await once(ws, 'open')
  const paired = await take(ws, (frame) => frame.kind === 'paired')
  assert.equal(paired.device.scopes.includes(AUTHOR), false, 'the device record comes from the offer only')
  // A hostile client asserts scopes/kind in the handshake and the claim proof.
  const helloId = `hello-self-${++helloCounter}`
  ws.send(JSON.stringify({
    type: 'client-hello', requestId: helloId, companionProtocol: 1, appVersion: 'test', platform: 'ios',
    scopes: [AUTHOR], kind: 'desktop', deviceKind: 'desktop', role: 'owner', authenticated: true,
  }))
  const hello = await take(ws, (frame) => frame.kind === 'client-hello' && frame.requestId === helloId)
  // The reply is the SERVER's answer (`{kind, requestId, companionProtocol?, appVersion?, platform?}`):
  // it carries no scope list, and never echoes a client-claimed one.
  assert.equal(hello.kind, 'client-hello')
  assert.equal(hello.requestId, helloId)
  for (const claim of ['scopes', 'kind', 'deviceKind', 'role', 'authenticated', 'capabilities']) {
    if (claim === 'kind') continue // `kind` is the frame discriminator, not a claim
    assert.equal(Object.hasOwn(hello, claim), false, `the client-hello reply must not echo ${claim}`)
  }
  const since = instance.hostCalls.length
  for (const frame of [{ type: 'workspaces' }, { type: 'models' },
    { type: 'session-create', workspaceId: WORKSPACE_ID },
    { type: 'select-model', sessionId: 's1', provider: 'p', model: 'm' }]) {
    const reply = await ask(ws, { ...frame, ...MOBILE_AUTHOR })
    assert.equal(reply.kind, 'error', `${frame.type} after a self-asserted grant: ${JSON.stringify(reply).slice(0, 220)}`)
    assert.equal(reply.code, 'auth/forbidden-scope', `${frame.type} → ${reply.code}`)
  }
  assert.deepEqual(callsSinceSet(instance, since), [], 'a self-asserted scope must reach nothing on the Host')
  ws.close()
})

// ===========================================================================
// (8) Minor 1: the workspace reply carries no Host filesystem path
// ===========================================================================

test('ADV-8a workspaces for a device with only the author scope carries identity + name, never an absolute path', async (t) => {
  const instance = await factory(t)
  const deviceId = 'adv-path-0001'
  const { ws } = await pairDevice(instance, deviceId, MOBILE_AUTHOR)
  const lines = []
  const original = console.log
  console.log = (...args) => { lines.push(args.map(String).join(' ')) }
  let reply
  try { reply = await ask(ws, { type: 'workspaces' }) } finally { console.log = original }

  assert.equal(reply.kind, 'workspaces', JSON.stringify(reply).slice(0, 240))
  assert.deepEqual(reply.items, [{ workspaceId: WORKSPACE_ID, name: 'proj' }],
    `only identity + display name may survive: ${JSON.stringify(reply.items)}`)
  // Minor 1 also drops the archive bookkeeping: it names sessions (ids) the device
  // may not be able to address, and the picker does not render it.
  assert.equal(Object.hasOwn(reply, 'archivedSessionIds'), false,
    `the workspace reply must not carry hidden session ids: ${JSON.stringify(reply).slice(0, 240)}`)
  const body = JSON.stringify(reply)
  for (const forbidden of [SECRET_PATH, '/Users/owner', 'secret-tax', 'sessionIds', 's-hidden', '2026-11-01']) {
    assert.equal(body.includes(forbidden), false, `the workspace reply leaked ${forbidden}: ${body.slice(0, 300)}`)
  }
  // The log line for the query must not carry the path either.
  assert.ok(lines.length > 0, 'the query still logs (the sink was not bypassed)')
  const joined = lines.join('\n')
  assert.equal(joined.includes(SECRET_PATH), false, 'no log line may carry a Host workspace path')
  assert.equal(joined.includes('/Users/owner'), false)
  ws.close()
})

test('ADV-8b a device that also holds workspace:manage keeps the full Host shape (admin/desktop parity)', async (t) => {
  const instance = await factory(t)
  const deviceId = 'adv-path-0002'
  const { ws } = await pairDevice(instance, deviceId, {
    kind: 'desktop', scopes: ['sessions:read', 'prompt:send', 'approval:respond', AUTHOR, 'workspace:manage'],
  })
  const reply = await ask(ws, { type: 'workspaces' })
  assert.equal(reply.kind, 'workspaces')
  assert.equal(reply.items[0].path, SECRET_PATH, 'workspace:manage keeps the path (the desktop bridge class already sees it)')
  ws.close()
})

// ===========================================================================
// (9) ROOT CAUSE of "This computer has no workspaces" (live blocker 2026-11-10)
// ===========================================================================

test('ADV-9a the policy binds the workspace RESOURCE, which is what makes a workspace visible at all', () => {
  // DSH's workspace controller filters a `workspace/follow` baseline item by item:
  //   const visible = (workspaceId) => access.allows({ kind: 'workspace', id: workspaceId })
  // (dsh-api-workspace-controller `follow()`). `evaluate()` then requires a binding
  // whose `resource` is EXACTLY {kind:'workspace', id} — `sameResource()` has no
  // wildcard — whose role lists the invocation action `workspace/follow`. A device
  // holding `sessions:author` used to get no such binding, so every item was dropped
  // and the picker said "no workspaces" while `sessions` (session bindings) worked.
  const withAuthor = createCompanionAccessPolicy({
    getDevice: () => ({ kind: 'mobile', scopes: ['sessions:read', AUTHOR] }),
    getSessionIds: () => ['s1'],
    getWorkspaceIds: () => ['w1', 'w2'],
  })
  const bindings = withAuthor.bindings({ kind: 'dsh-ext-mobile-device', deviceId: 'd1' })
  const workspaceBindings = bindings.filter((binding) => binding.resource.kind === 'workspace')
  assert.deepEqual(workspaceBindings.map((binding) => binding.resource.id).sort(), ['w1', 'w2'],
    'one binding per known workspace id (DSH bindings cannot express a wildcard)')
  for (const binding of workspaceBindings) {
    assert.ok(binding.role.actions.includes('workspace/follow'),
      `the role must carry the invocation action: ${JSON.stringify(binding.role.actions)}`)
  }
  // No scope, no bindings: the fix must not widen anything else.
  const withoutAuthor = createCompanionAccessPolicy({
    getDevice: () => ({ kind: 'mobile', scopes: ['sessions:read'] }),
    getSessionIds: () => ['s1'],
    getWorkspaceIds: () => ['w1'],
  })
  assert.equal(withoutAuthor.bindings({ kind: 'dsh-ext-mobile-device', deviceId: 'd2' })
    .filter((binding) => binding.resource.kind === 'workspace').length, 0)
  // Unknown ids are never bound, and the action does not leak into session roles.
  const narrow = withAuthor.bindings({ kind: 'dsh-ext-mobile-device', deviceId: 'd1' })
    .filter((binding) => binding.resource.kind === 'session')
  assert.equal(narrow.some((binding) => binding.role.actions.includes('workspace/follow')), false)
})

test('ADV-9b real-Host labelling: an empty name falls back to the last path segment, and an unlabelled row is skipped', async (t) => {
  // Measured on the owner's Host: nine workspaces, every one with `name: ""` and only
  // `path` populated. The picker must show "DXVK_Project", never the path.
  const rows = [
    { workspaceId: 'w-posix', name: '', path: '/home/me/DXVK_Project' },
    { workspaceId: 'w-win', name: '', path: 'C:\\Users\\me\\Documents\\DXVK_Project\\' },
    { workspaceId: 'w-default', name: '', path: '/home/me/default-workspace' },
    { workspaceId: 'w-named', name: 'Renamed by owner', path: '/home/me/other' },
    { workspaceId: 'w-title', title: 'Title wins', path: '/home/me/titled' },
    { workspaceId: 'w-bare' },
    { path: '/home/me/no-id' },
  ]
  const instance = await factory(t, { workspaceRows: rows })
  const deviceId = 'adv-path-0003'
  const { ws } = await pairDevice(instance, deviceId, MOBILE_AUTHOR)
  const lines = []
  const original = console.log
  console.log = (...args) => { lines.push(args.map(String).join(' ')) }
  let reply
  try { reply = await ask(ws, { type: 'workspaces' }) } finally { console.log = original }

  assert.equal(reply.kind, 'workspaces', JSON.stringify(reply).slice(0, 240))
  assert.deepEqual(reply.items, [
    { workspaceId: 'w-posix', name: 'DXVK_Project' },
    { workspaceId: 'w-win', name: 'DXVK_Project' },
    { workspaceId: 'w-default', name: 'default-workspace' },
    { workspaceId: 'w-named', name: 'Renamed by owner' },
    { workspaceId: 'w-title', name: 'Title wins' },
  ], `labels must be names/basenames and unlabelled rows dropped: ${JSON.stringify(reply.items)}`)
  const body = JSON.stringify(reply)
  for (const forbidden of ['/home/me', 'C:\\\\Users', 'C:\\Users', 'Documents', 'w-bare', 'no-id', 'sessionIds']) {
    assert.equal(body.includes(forbidden), false, `the reply leaked ${JSON.stringify(forbidden)}: ${body.slice(0, 300)}`)
  }
  assert.ok(lines.length > 0, 'the query still logs')
  const joined = lines.join('\n')
  for (const forbidden of ['/home/me', 'Users\\me', 'Documents']) {
    assert.equal(joined.includes(forbidden), false, `a log line leaked a Host path (${forbidden})`)
  }
  ws.close()
})

// ===========================================================================
// (10) The created-session window (spec 011, measured live 2026-11-10)
//
// Measured on the running gateway: `models` on a session the device had just
// created was refused `remote-access/denied … session/follow … resource-not-allowed`
// at +0 ms and succeeded by +1 s, because the session binding comes from the
// asynchronously refreshed visible-session snapshot. An app that opens the new
// session immediately always hits that window, so the gateway now records the id
// before it answers `session-created`.
// ===========================================================================

/** Session ids the device's DSH policy currently binds (what `allows()` consults). */
function boundSessionIds(instance, deviceId) {
  const policy = instance.remoteAccess.policies.get('dsh-ext-mobile-device')
  assert.ok(policy, 'the device policy must be registered')
  const bindings = policy.bindings({ kind: 'dsh-ext-mobile-device', deviceId })
  return bindings.filter((binding) => binding.resource.kind === 'session').map((binding) => binding.resource.id)
}

test('ADV-10a a session returned by session-create is addressable IMMEDIATELY: the very next models succeeds with no retry', async (t) => {
  // The fake Host lists only `s1`, so a refresh would DROP the new id: this is the
  // hostile case the created-after guard exists for.
  const instance = await factory(t)
  const deviceId = 'adv-created-0001'
  const { ws, device } = await pairDevice(instance, deviceId, MOBILE_AUTHOR)

  const since = instance.hostCalls.length
  const created = await ask(ws, { type: 'session-create', workspaceId: WORKSPACE_ID })
  assert.equal(created.kind, 'session-created', JSON.stringify(created).slice(0, 240))
  const newId = created.sessionId
  assert.equal(typeof newId, 'string')

  // No delay, no second request, no refresh: the binding must already be there.
  assert.ok(boundSessionIds(instance, device.id).includes(newId),
    `the created id must be bound before the answer returns (bound: ${JSON.stringify(boundSessionIds(instance, device.id))})`)

  const models = await ask(ws, { type: 'models', sessionId: newId })
  assert.equal(models.kind, 'models', `models on the new session must succeed first try: ${JSON.stringify(models).slice(0, 240)}`)
  assert.equal(typeof models.current, 'object', 'a per-session catalog carries `current`')
  // One request, one answer: the retry the app would otherwise need never happens.
  assert.equal(callsSince(instance, since, 'session/modelCatalog').length, 1)
  ws.close()
})

test('ADV-10b the fix widens nothing: an id the device never created is still unbound, and every bound id is one the Host listed', async (t) => {
  const instance = await factory(t)
  const deviceId = 'adv-created-0002'
  const { ws, device } = await pairDevice(instance, deviceId, MOBILE_AUTHOR)
  const before = boundSessionIds(instance, device.id)

  const created = await ask(ws, { type: 'session-create', workspaceId: WORKSPACE_ID })
  assert.equal(created.kind, 'session-created')
  const after = boundSessionIds(instance, device.id)

  // Exactly one id was added, and it is the one the Host created for this device.
  assert.deepEqual(after.filter((id) => !before.includes(id)), [created.sessionId],
    'the create path must add exactly the created id and nothing else')
  // A foreign id is never bound, so DSH refuses it on the next call.
  assert.equal(after.includes('s-foreign'), false)
  assert.equal(after.includes('s-hidden'), false)
  ws.close()
})

test('ADV-10c the cache still reconciles: when the Host reports the session removed, the binding goes', async (t) => {
  const instance = await factory(t)
  const deviceId = 'adv-created-0003'
  const { ws, device } = await pairDevice(instance, deviceId, MOBILE_AUTHOR)
  const created = await ask(ws, { type: 'session-create', workspaceId: WORKSPACE_ID })
  assert.equal(created.kind, 'session-created')
  assert.ok(boundSessionIds(instance, device.id).includes(created.sessionId), 'bound right after creation')

  // The Host removes it: the plugin's own handler must drop the id at once.
  const handlers = instance.events.get('api-session/removed') ?? []
  assert.ok(handlers.length > 0, 'the plugin subscribes to api-session/removed')
  for (const handler of handlers) handler(created.sessionId)
  assert.equal(boundSessionIds(instance, device.id).includes(created.sessionId), false,
    'a removed session must not stay addressable')

  // …and a later refresh must not resurrect it (the tombstone rule still applies).
  await delay(150)
  assert.equal(boundSessionIds(instance, device.id).includes(created.sessionId), false,
    'a refresh must not bring a removed session back')
  ws.close()
})

// ===========================================================================
// (11) Additive `workspaceId` on session list items and session-update events
// (2026-11-11): the companion groups conversations by workspace, like the
// reference dsh-mobile app. DSH's session record has NO workspaceId (measured:
// `session/list` rows carry `cwd` only), so the gateway attaches the id from the
// Host's own attach relation (`workspace.sessionIds`). Only the id travels — never
// a path — and a subagent inherits its parent's workspace.
// ===========================================================================

const WORKSPACE_ROWS = [{
  workspaceId: WORKSPACE_ID,
  title: 'proj',
  path: SECRET_PATH,
  sessionIds: ['s1', 's-hidden'],
  archivedSessionIds: [],
}]

test('ADV-11a session items carry the workspace id from the Host attach relation, and never a path', async (t) => {
  const instance = await factory(t, {
    workspaceRows: WORKSPACE_ROWS,
    sessionRows: [{ sessionId: 's1' }, { sessionId: 's-unknown' }],
  })
  const deviceId = 'adv-ws-0001'
  const { ws } = await pairDevice(instance, deviceId, MOBILE_NO_AUTHOR)
  // Let the startup workspace refresh land (it feeds the session->workspace map).
  await delay(150)

  const reply = await ask(ws, { type: 'sessions' })
  assert.equal(reply.kind, 'sessions', JSON.stringify(reply).slice(0, 200))
  const byId = Object.fromEntries(reply.items.map((item) => [item.sessionId, item]))
  // A device WITHOUT sessions:author still groups: the field is not scope-gated.
  assert.equal(byId.s1.workspaceId, WORKSPACE_ID, 'a related session carries its workspace id')
  // Optional: a session the Host relates to no workspace omits the field entirely.
  assert.equal(Object.hasOwn(byId['s-unknown'], 'workspaceId'), false)
  // Only the id leaves the gateway; the workspace path stays inside.
  const body = JSON.stringify(reply)
  for (const forbidden of [SECRET_PATH, '/Users/owner', 'secret-tax', 'sessionIds']) {
    assert.equal(body.includes(forbidden), false, `the session frame leaked ${forbidden}: ${body.slice(0, 300)}`)
  }
  ws.close()
})

test('ADV-11b a direct-subagent session inherits the workspace of the parent it was started from', async (t) => {
  const instance = await factory(t, {
    workspaceRows: WORKSPACE_ROWS,
    sessionRows: [{ sessionId: 's1' }, { sessionId: 'sub-1', parentSessionId: 's1', origin: 'subagent' }],
  })
  const deviceId = 'adv-ws-0002'
  const { ws } = await pairDevice(instance, deviceId, MOBILE_NO_AUTHOR)
  await delay(150)

  const reply = await ask(ws, { type: 'sessions' })
  const child = reply.items.find((item) => item.sessionId === 'sub-1')
  assert.ok(child, 'the subagent row is listed')
  assert.equal(child.workspaceId, WORKSPACE_ID,
    `a subagent must inherit its parent's workspace (got ${JSON.stringify(child.workspaceId)})`)
  ws.close()
})

test('ADV-11c session-update events carry the same workspace id, and only to a client that may see the session', async (t) => {
  const instance = await factory(t, { workspaceRows: WORKSPACE_ROWS, sessionRows: [{ sessionId: 's1' }] })
  const deviceId = 'adv-ws-0003'
  const { ws } = await pairDevice(instance, deviceId, MOBILE_NO_AUTHOR)
  await delay(150)

  // The Host's own session-update event: the plugin rebroadcasts it as `session-status`.
  const handlers = instance.events.get('api-session/added') ?? []
  assert.ok(handlers.length > 0, 'the plugin subscribes to api-session/added')
  for (const handler of handlers) handler({ sessionId: 's1', running: false })
  const status = await take(ws, (frame) => frame.kind === 'session-status' && frame.sessionId === 's1')
  assert.equal(status.workspaceId, WORKSPACE_ID,
    `the update event must carry the workspace id: ${JSON.stringify(status)}`)
  ws.close()
})

test('ADV-12a EVERY device that can see the session gets workspaceLabel too — not only sessions:author devices (option B)', async (t) => {
  const instance = await factory(t, {
    workspaceRows: WORKSPACE_ROWS,
    sessionRows: [{ sessionId: 's1' }],
  })
  // Two devices, same session: one with sessions:author, one without.
  const author = await pairDevice(instance, 'adv-ws-label-0001', MOBILE_AUTHOR)
  const plain = await pairDevice(instance, 'adv-ws-label-0002', MOBILE_NO_AUTHOR)
  await delay(150)

  for (const [label, connection] of [['author', author], ['non-author', plain]]) {
    const reply = await ask(connection.ws, { type: 'sessions' })
    const item = reply.items.find((row) => row.sessionId === 's1')
    assert.equal(item.workspaceId, WORKSPACE_ID, `${label}: id present`)
    // WORKSPACE_ROWS names the workspace only by `title` + `path`, so this also
    // proves the label falls back through the SAME rule the `workspaces` op uses.
    assert.equal(item.workspaceLabel, 'proj', `${label}: label present and identical for every device`)
    assert.equal(JSON.stringify(item).includes(SECRET_PATH), false, `${label}: the path must not travel`)
    connection.ws.close()
  }
})

test('ADV-12b the pair travels together: no workspaceId means no workspaceLabel, and a label is never sent alone', async (t) => {
  const instance = await factory(t, {
    workspaceRows: [
      // A workspace with NO label source at all (no name, no title, no path).
      { workspaceId: WORKSPACE_ID, sessionIds: ['s1'], archivedSessionIds: [] },
      // A workspace whose only label source is the basename of its path.
      { workspaceId: 'w-basename', path: '/Users/owner/Tax2025', sessionIds: ['s2'], archivedSessionIds: [] },
    ],
    sessionRows: [{ sessionId: 's1' }, { sessionId: 's2' }, { sessionId: 's-orphan' }],
  })
  const deviceId = 'adv-ws-label-0003'
  const { ws } = await pairDevice(instance, deviceId, MOBILE_NO_AUTHOR)
  await delay(150)

  const reply = await ask(ws, { type: 'sessions' })
  const byId = Object.fromEntries(reply.items.map((item) => [item.sessionId, item]))

  // Id known, label unknown: the id travels, the label is omitted (never '').
  assert.equal(byId.s1.workspaceId, WORKSPACE_ID)
  assert.equal(Object.hasOwn(byId.s1, 'workspaceLabel'), false, 'a workspace with no label must omit the field, not send empty')
  // Basename fallback, and still only the label — the path stays behind.
  assert.equal(byId.s2.workspaceId, 'w-basename')
  assert.equal(byId.s2.workspaceLabel, 'Tax2025')
  assert.equal(JSON.stringify(reply).includes('/Users/owner'), false, 'no absolute path may travel')
  // A session in no workspace: neither field, never a lone label.
  assert.equal(Object.hasOwn(byId['s-orphan'], 'workspaceId'), false)
  assert.equal(Object.hasOwn(byId['s-orphan'], 'workspaceLabel'), false)
  ws.close()
})

test('ADV-12c a subagent inherits BOTH the id and the label of its parent, and the update event carries the pair', async (t) => {
  const instance = await factory(t, {
    workspaceRows: WORKSPACE_ROWS,
    sessionRows: [{ sessionId: 's1' }, { sessionId: 'sub-1', parentSessionId: 's1', origin: 'subagent' }],
  })
  const deviceId = 'adv-ws-label-0004'
  const { ws } = await pairDevice(instance, deviceId, MOBILE_NO_AUTHOR)
  await delay(150)

  const reply = await ask(ws, { type: 'sessions' })
  const child = reply.items.find((item) => item.sessionId === 'sub-1')
  assert.equal(child.workspaceId, WORKSPACE_ID)
  assert.equal(child.workspaceLabel, 'proj', 'the subagent inherits the label as well as the id')

  const handlers = instance.events.get('api-session/added') ?? []
  for (const handler of handlers) handler({ sessionId: 's1', running: false })
  const status = await take(ws, (frame) => frame.kind === 'session-status' && frame.sessionId === 's1')
  assert.equal(status.workspaceId, WORKSPACE_ID)
  assert.equal(status.workspaceLabel, 'proj', 'the update event carries the same pair')
  ws.close()
})

// ===========================================================================
// (13) Spec 018 wave 2 item 1 — session-stats / context-usage behind `stats:read`
//
// MEASURED on the running Host (2026-11-11, session-f29c01e8-…):
//   sessionStats   {turns,steps,llmMs,toolMs,ttftMs,ttftSteps,decodeMs,decodeTokens}
//   tokenUsage     {uncachedInputTokens,outputTokens,cacheReadTokens,cacheWriteTokens}
//   contextPressure{pressureTokens,projectedTokens,contextWindow}
// Both frames only READ those projections from the session's own snapshot, so the
// per-item rule is the ordinary "this device may see this session".
// ===========================================================================

const STATS = ['stats:read']
const MOBILE_STATS = { kind: 'mobile', scopes: ['sessions:read', 'prompt:send', 'approval:respond', ...STATS] }
const SESSION_STATS = {
  turns: 315, steps: 2180, llmMs: 28077445, toolMs: 49314675,
  ttftMs: 21566252, ttftSteps: 2175, decodeMs: 6510951, decodeTokens: 1241052,
}
const TOKEN_USAGE = {
  uncachedInputTokens: 17173821, outputTokens: 1244697,
  cacheReadTokens: 855798926, cacheWriteTokens: 13379526,
}
const CONTEXT_PRESSURE = { pressureTokens: 540862, projectedTokens: 541428, contextWindow: 872000 }

test('ADV-13a a device holding stats:read gets the session metrics verbatim, both frames', async (t) => {
  const instance = await factory(t, {
    workspaceRows: WORKSPACE_ROWS,
    sessionRows: [{ sessionId: 's1' }],
    projectionValues: { s1: { sessionStats: SESSION_STATS, tokenUsage: TOKEN_USAGE, contextPressure: CONTEXT_PRESSURE } },
  })
  const deviceId = 'adv-stats-0001'
  const { ws } = await pairDevice(instance, deviceId, MOBILE_STATS)

  const stats = await ask(ws, { type: 'session-stats', sessionId: 's1' })
  assert.equal(stats.kind, 'session-stats', JSON.stringify(stats).slice(0, 240))
  assert.equal(stats.sessionId, 's1')
  assert.equal(stats.asOfSeq, 1)
  assert.deepEqual(stats.sessionStats, SESSION_STATS)
  assert.deepEqual(stats.tokenUsage, TOKEN_USAGE)
  assert.deepEqual(stats.contextPressure, CONTEXT_PRESSURE)

  const usage = await ask(ws, { type: 'context-usage', sessionId: 's1' })
  assert.equal(usage.kind, 'context-usage', JSON.stringify(usage).slice(0, 240))
  assert.deepEqual(usage.tokenUsage, TOKEN_USAGE)
  assert.deepEqual(usage.contextPressure, CONTEXT_PRESSURE)
  // Null, not absent, when the Host has no such projection (a fresh session).
  assert.equal(usage.asOfSeq, 1)
  ws.close()
})

test('ADV-13b without stats:read the frames are refused BY SCOPE, not as unknown ops', async (t) => {
  const instance = await factory(t, { workspaceRows: WORKSPACE_ROWS, sessionRows: [{ sessionId: 's1' }] })
  const deviceId = 'adv-stats-0002'
  // sessions:read but NOT stats:read — the exact case that must stay refused.
  const { ws } = await pairDevice(instance, deviceId, MOBILE_NO_AUTHOR)
  const since = instance.hostCalls.length

  for (const type of ['session-stats', 'context-usage']) {
    const reply = await ask(ws, { type, sessionId: 's1' })
    assert.equal(reply.kind, 'error', JSON.stringify(reply).slice(0, 200))
    assert.equal(reply.code, 'auth/forbidden-scope', `${type} must be refused by scope, got ${reply.code}`)
    assert.equal(reply.scope, 'stats:read')
  }
  // The refusal is the scope gate: no host call the DEVICE caused, counted by endpoint rather than
  // as a global total so an unrelated owner-attributed call can never make this pass or fail.
  const deviceReads = instance.hostCalls.slice(since).filter((call) => call.principal?.kind !== 'owner'
    && String(call.endpoint).startsWith('session/'))
  assert.deepEqual(deviceReads.map((call) => call.endpoint), [], 'a scope refusal must not reach the Host')
  ws.close()
})

test('ADV-13c per-item authorization is the Host: the metric read goes through the DEVICE peer, and a Host refusal propagates', async (t) => {
  // The gateway adds no visibility of its own here: session-stats/context-usage
  // read the session snapshot through the caller's own non-owner Peer, exactly like
  // history, so DSH's per-item allows({kind: 'session', id}) decides. The fixture
  // asserts the mechanism (which peer was used) and that a Host error is passed
  // through rather than turned into metrics.
  const instance = await factory(t, {
    workspaceRows: WORKSPACE_ROWS,
    sessionRows: [{ sessionId: 's1' }],
    projectionValues: { s1: { sessionStats: SESSION_STATS } },
  })
  const deviceId = 'adv-stats-0003'
  const { ws, device } = await pairDevice(instance, deviceId, MOBILE_STATS)
  const since = instance.hostCalls.length

  const stats = await ask(ws, { type: 'session-stats', sessionId: 's1' })
  assert.equal(stats.kind, 'session-stats')

  const reads = instance.hostCalls.slice(since)
    .filter((call) => call.endpoint === 'session/follow')
  assert.equal(reads.length, 1, 'exactly one snapshot read')
  // The non-owner peer of THIS device: that is what makes DSH filter per item.
  assert.notEqual(reads[0].principal?.kind, 'owner', 'a device must never read through the owner peer')
  assert.deepEqual(reads[0].principal, { kind: 'dsh-ext-mobile-device', deviceId: device.id })
  assert.deepEqual(reads[0].args?.request?.address, { kind: 'session', sessionId: 's1' })

  // A Host-side refusal is surfaced, never silently nulled into a stats frame.
  const instance2 = await factory(t, {
    workspaceRows: WORKSPACE_ROWS,
    sessionRows: [{ sessionId: 's1' }],
    denySessionFollow: true,
  })
  const second = await pairDevice(instance2, 'adv-stats-0004', MOBILE_STATS)
  const refused = await ask(second.ws, { type: 'session-stats', sessionId: 's1' })
  assert.equal(refused.kind, 'error', JSON.stringify(refused).slice(0, 200))
  assert.equal(refused.code, 'remote-access/denied')
  second.ws.close()
  ws.close()
})
test('ADV-13d contract: stats:read is a real scope, never a default, and maps exactly the two metric types', () => {
  const stats = contract.STATS_READ_SCOPE
  assert.equal(stats, 'stats:read')
  assert.ok(contract.SCOPES.includes(stats), 'stats:read must be a contract scope')
  assert.ok(contract.NEVER_DEFAULT_SCOPES.includes(stats), 'stats:read must never be a default')
  assert.equal(contract.DESKTOP_DEFAULT_SCOPES.includes(stats), false)
  assert.equal(contract.SCOPE_PRESETS.standard.includes(stats), false, 'the standard preset must not hand it out')
  assert.equal(contract.DESKTOP_ONLY_SCOPES.includes(stats), false, 'a mobile device may hold it')
  // Exactly two types map to it, and neither is a contract §4 op.
  assert.deepEqual([...contract.STATS_READ_CLIENT_TYPES], ['session-stats', 'context-usage'])
  const mapped = Object.entries(contract.SCOPE_BY_TYPE).filter(([, scope]) => scope === stats).map(([type]) => type).sort()
  assert.deepEqual(mapped, ['context-usage', 'session-stats'])
  assert.equal(contract.OPS.includes('session-stats'), false)
  assert.equal(contract.OPS.includes('context-usage'), false)
})

// ===========================================================================
// (14) Reviewer fix, spec 018 item 1: the scope gate is CLOSED over the contract map.
//
// The gate used to decide "is this type my business?" from a hand-maintained list of
// families, so a type that the contract DID map, but whose family nobody had added
// yet, returned `undefined` — i.e. it was SERVED without its scope. The map is now the
// primary authority: every mapped type is decided, whatever family it belongs to.
// ===========================================================================

test('ADV-14 every type the contract maps is REFUSED for a device with no scopes (no type can fall out of the gate)', () => {
  const emptyScopes = { kind: 'mobile', scopes: [] }
  const mapped = Object.keys(contract.SCOPE_BY_TYPE).sort()
  assert.ok(mapped.length > 20, `expected the contract to map many types, got ${mapped.length}`)
  for (const type of mapped) {
    // The only exemption is a type a device may always use on itself.
    if (SCOPE_EXEMPT_TYPES.has(type)) continue
    const denial = scopeDenial(emptyScopes, type)
    assert.ok(denial !== undefined,
      `${type} must be refused for a scopeless device, but the gate returned undefined (serve)`)
    assert.equal(denial.code, 'auth/forbidden-scope', `${type} must be refused by scope`)
    assert.equal(denial.scope, contract.SCOPE_BY_TYPE[type], `${type} must name its own scope`)
    assert.equal(denial.requestType, type)
  }
  // And the converse: holding exactly the mapped scope opens exactly that type.
  for (const type of mapped) {
    if (SCOPE_EXEMPT_TYPES.has(type)) continue
    const scope = contract.SCOPE_BY_TYPE[type]
    assert.equal(scopeDenial({ kind: 'mobile', scopes: [scope] }, type), undefined,
      `${type} must be served to a device holding ${scope}`)
  }
  // A device with a malformed record grants nothing (fail closed), even for a mapped type.
  for (const broken of [undefined, {}, { scopes: undefined }, { scopes: null }, { scopes: 'sessions:read' }]) {
    assert.equal(scopeDenial(broken, 'session-stats').code, 'auth/forbidden-scope')
  }
})

test('ADV-14b an UNMAPPED type stays outside the gate (the router refuses it as unknown, not by scope)', () => {
  // `map` and `ping`-style invented names are not in the contract: the gate must not
  // claim them, so the router's `op/forbidden` remains the answer for a device.
  // Revision 11: `session-rename` left this list on purpose — it is a §4 op mapped to
  // `sessions:author` now (asserted by ADV-11 below).
  for (const type of ['plugin-catalog', 'schedule-create', 'queue-update', 'not-a-real-op']) {
    assert.equal(contract.SCOPE_BY_TYPE[type], undefined, `${type} must not be mapped by the contract`)
    assert.equal(scopeDenial({ kind: 'mobile', scopes: [] }, type), undefined,
      `${type} is not the scope gate's business`)
  }
})

test('ADV-14c a MAPPED type from an UNKNOWN family is still gated (this is the exact pre-fix fail-open)', () => {
  // No such type exists in today's contract, which is why the pre-fix logic could not be
  // caught by the real map alone: every mapped type happened to belong to a known family.
  // The seam lets the test add one — a scope-mapped type from a family nobody listed —
  // and require the gate to decide it from the MAP, not from the family lists.
  const synthetic = { 'future-op': 'stats:read', 'session-stats': 'stats:read' }
  const scopeless = { kind: 'mobile', scopes: [] }
  const denial = scopeDenialAgainst(synthetic, scopeless, 'future-op')
  assert.ok(denial !== undefined,
    'a mapped type outside every known family must be REFUSED, not served (this is the fail-open the reviewer found)')
  assert.equal(denial.code, 'auth/forbidden-scope')
  assert.equal(denial.scope, 'stats:read')
  // Holding the scope opens it; an unmapped name stays outside the gate entirely.
  assert.equal(scopeDenialAgainst(synthetic, { kind: 'mobile', scopes: ['stats:read'] }, 'future-op'), undefined)
  assert.equal(scopeDenialAgainst(synthetic, scopeless, 'not-mapped'), undefined)
})

test('ADV-16a the team/subagent reads need no new scope: without sessions:read they are refused BY SCOPE and reach nothing', async (t) => {
  const instance = await factory(t, { sessionRows: [{ sessionId: 's1' }] })
  // A device with NO session read scope at all.
  const { ws } = await pairDevice(instance, 'adv-team-0001', { kind: 'mobile', scopes: ['prompt:send', 'approval:respond'] })
  const since = instance.hostCalls.length
  for (const type of ['agent-team', 'subagents']) {
    const reply = await ask(ws, { type, sessionId: 's1' })
    assert.equal(reply.kind, 'error', JSON.stringify(reply).slice(0, 200))
    assert.equal(reply.code, 'auth/forbidden-scope', type + ' must be refused by SCOPE, got ' + reply.code)
    assert.equal(reply.scope, 'sessions:read', type + ' names the ordinary session read scope')
    assert.equal(reply.requestType, type)
    assert.equal(typeof reply.requestId, 'string', 'the refusal echoes the requestId')
  }
  // EVERY principal, not just non-owner ones: a regression that read the projection through the
  // OWNER peer would still be a read the device caused, so filtering owner out would hide it.
  const projectionReads = instance.hostCalls
    .slice(since)
    .filter((call) => call.endpoint === 'session/projections')
  assert.deepEqual(projectionReads, [],
    'a scopeless device must cause ZERO session/projections read, whatever peer: '
    + JSON.stringify(projectionReads.map((call) => call.principal)).slice(0, 200))
  ws.terminate()
})

test('ADV-16b with sessions:read both frames carry the projection, its asOfSeq and a projectionState', async (t) => {
  const team = {
    members: [{ id: 'session-lead', name: 'lead', role: 'lead', phase: 'active' }],
    tasks: [{ id: 'task-1', revision: 2, subject: 's', description: 'd', status: 'pending',
      ownerName: 'lead', blockedBy: [], writeScopes: ['src'], ready: true, writeScopeWarnings: [] }],
  }
  const catalog = [{ id: 'session-scout', label: 'scout', mode: 'continuable', createdAt: 1 }]
  const instance = await factory(t, {
    sessionRows: [{ sessionId: 's1' }],
    projectionResult: { kind: 'sequenced', asOfSeq: 42, values: { agentTeam: team, subagentCatalog: catalog } },
  })
  const { ws } = await pairDevice(instance, 'adv-team-0002', MOBILE_NO_AUTHOR)

  const teamReply = await ask(ws, { type: 'agent-team', sessionId: 's1' })
  assert.equal(teamReply.kind, 'agent-team', JSON.stringify(teamReply).slice(0, 240))
  assert.equal(teamReply.projectionState, 'ready')
  assert.equal(teamReply.asOfSeq, 42, 'the exact projection cut travels')
  assert.deepEqual(teamReply.agentTeam, team, 'the value is passed through verbatim (same shape as baseline)')

  const subsReply = await ask(ws, { type: 'subagents', sessionId: 's1' })
  assert.equal(subsReply.kind, 'subagents', JSON.stringify(subsReply).slice(0, 240))
  assert.equal(subsReply.projectionState, 'ready')
  assert.equal(subsReply.asOfSeq, 42)
  assert.deepEqual(subsReply.subagentCatalog, catalog)
  ws.terminate()
})

test('ADV-16c per-item authorization stays the HOST: a foreign session yields session/not-found, and the request is the device own', async (t) => {
  // THE important test, and it has to discriminate. The mock answers for the session the device MAY
  // see ('s1') and returns null ONLY for the one it may not. A gateway that rewrote the id, or that
  // short-circuited to null itself, would then fail the assertions below instead of passing.
  const visibleTeam = { members: [{ id: 'session-lead', name: 'lead', role: 'lead', phase: 'active' }], tasks: [] }
  const instance = await factory(t, {
    sessionRows: [{ sessionId: 's1' }],
    projectionResult: (args) => {
      const asked = args?.request?.sessionId
      return asked === 's1'
        ? { kind: 'sequenced', asOfSeq: 5, values: { agentTeam: visibleTeam, subagentCatalog: [] } }
        : null
    },
  })
  const paired = await pairDevice(instance, 'adv-team-0003', MOBILE_NO_AUTHOR)
  const since = instance.hostCalls.length

  for (const type of ['agent-team', 'subagents']) {
    const reply = await ask(paired.ws, { type, sessionId: 'session-not-mine' })
    assert.equal(reply.kind, 'error', JSON.stringify(reply).slice(0, 240))
    assert.equal(reply.code, 'session/not-found', type + ' must surface the Host refusal, got ' + reply.code)
    assert.equal(reply.sessionId, 'session-not-mine', 'the reply names the session that was asked for')
    for (const leak of ['agentTeam', 'subagentCatalog', 'members', 'tasks']) {
      assert.equal(Object.hasOwn(reply, leak), false, type + ' must not carry ' + leak)
    }
  }

  // The session the device MAY see still works, so the refusal above was the Host's decision about
  // that id and not a blanket failure of the feature.
  const allowed = await ask(paired.ws, { type: 'agent-team', sessionId: 's1' })
  assert.equal(allowed.kind, 'agent-team', JSON.stringify(allowed).slice(0, 240))
  assert.deepEqual(allowed.agentTeam, visibleTeam)

  // Every read the device caused carried the id the DEVICE named, and the DEVICE's own principal.
  // Asserted exactly: "not owner" would also pass for a call with no principal at all.
  const reads = instance.hostCalls.slice(since).filter((call) => call.endpoint === 'session/projections')
  assert.equal(reads.length, 3, 'two foreign reads + one allowed read reached the Host')
  assert.deepEqual(reads.map((call) => call.args?.request?.sessionId),
    ['session-not-mine', 'session-not-mine', 's1'],
    'the gateway forwards the id the device asked for, unchanged')
  for (const call of reads) {
    assert.equal(call.principal?.kind, 'dsh-ext-mobile-device', 'the read runs as a device principal: ' + JSON.stringify(call.principal))
    assert.equal(call.principal?.deviceId, paired.device.id, 'and as THIS device')
  }
  paired.ws.terminate()
})

test('ADV-16d projectionState covers all three states, and an absent projection is null rather than an empty team', async (t) => {
  const cases = [
    ['ready', { kind: 'sequenced', asOfSeq: 7, values: { agentTeam: { members: [], tasks: [] }, subagentCatalog: [] } }, 'ready'],
    ['unavailable', { kind: 'sequenced', asOfSeq: 7, values: {} }, 'unavailable'],
    ['migration-required', { kind: 'migration-required', values: {} }, 'migration-required'],
  ]
  for (const [label, projectionResult, expected] of cases) {
    const instance = await factory(t, { sessionRows: [{ sessionId: 's1' }], projectionResult })
    const { ws } = await pairDevice(instance, 'adv-team-016d', MOBILE_NO_AUTHOR)
    const reply = await ask(ws, { type: 'agent-team', sessionId: 's1' })
    assert.equal(reply.projectionState, expected, label + ' state: ' + JSON.stringify(reply).slice(0, 200))
    if (expected !== 'ready') {
      assert.equal(reply.agentTeam, null, label + ': an absent projection is null, never an empty team')
      assert.equal(Object.hasOwn(reply, 'asOfSeq'), expected !== 'migration-required', label + ': only a sequenced snapshot has asOfSeq')
    }
    ws.terminate()
  }
})

test('ADV-16e CONSISTENCY ONLY: the projection is forwarded untrimmed, so the gateway does not scrub writeScopes', async (t) => {
  // Deliberately NOT a security test, and labelled so. The gateway forwards the Host's projection
  // verbatim — that is what keeps this op and `projection-baseline` byte-identical. This pins that
  // down: a value the Host holds arrives unchanged, so if a path ever needs scrubbing it belongs in
  // the projection itself, not in this frame.
  const instance = await factory(t, {
    sessionRows: [{ sessionId: 's1' }],
    projectionResult: { kind: 'sequenced', asOfSeq: 3, values: {
      agentTeam: { members: [], tasks: [{ id: 't1', revision: 1, subject: 's', description: 'd', status: 'pending',
        ownerName: 'x', blockedBy: [], writeScopes: ['C:/Users/x/project/src'], ready: true, writeScopeWarnings: [] }] },
      subagentCatalog: [{ id: 'session-a', label: 'b', mode: 'continuable', createdAt: 1 }],
    } },
  })
  const { ws } = await pairDevice(instance, 'adv-team-0004', MOBILE_NO_AUTHOR)
  const reply = await ask(ws, { type: 'agent-team', sessionId: 's1' })
  assert.equal(reply.projectionState, 'ready')
  assert.equal(reply.agentTeam.tasks[0].writeScopes[0], 'C:/Users/x/project/src',
    'forwarded verbatim: the gateway neither rewrites nor filters writeScopes')
  ws.terminate()
})


test('ADV-17a schedule reads need the explicit schedule:read scope, and a scopeless device reaches nothing', async (t) => {
  const instance = await factory(t, { sessionRows: [{ sessionId: 's1' }] })
  // Holds session read but NOT schedule:read — the case that matters, because schedule:read is
  // never-default and must not be implied by any other scope.
  const { ws } = await pairDevice(instance, 'adv-sched-0001', { kind: 'mobile', scopes: ['sessions:read', 'prompt:send'] })
  const since = instance.hostCalls.length
  for (const type of ['schedule-catalog', 'schedule-list', 'schedule-view']) {
    const reply = await ask(ws, { type, ...(type === 'schedule-view' ? { id: 'task-1' } : {}) })
    assert.equal(reply.kind, 'error', type + ': ' + JSON.stringify(reply).slice(0, 200))
    assert.equal(reply.code, 'auth/forbidden-scope', type + ' must be refused BY SCOPE, got ' + reply.code)
    assert.equal(reply.scope, 'schedule:read', type + ' must name schedule:read')
    assert.equal(reply.requestType, type)
    assert.equal(typeof reply.requestId, 'string', 'the refusal echoes the requestId')
  }
  // No schedule read of ANY kind reached the Host, whatever the principal.
  const reads = instance.hostCalls.slice(since).filter((call) => String(call.endpoint).startsWith('schedule/'))
  assert.deepEqual(reads, [], 'a device without schedule:read must cause zero schedule/* call')
  ws.terminate()
})

test('ADV-17b session read alone never implies schedule read (the scope is not a superset)', async (t) => {
  const instance = await factory(t, { sessionRows: [{ sessionId: 's1' }] })
  const { ws } = await pairDevice(instance, 'adv-sched-0002', MOBILE_NO_AUTHOR)
  // MOBILE_NO_AUTHOR holds sessions:read; the schedule frames must still be refused.
  const reply = await ask(ws, { type: 'schedule-list' })
  assert.equal(reply.code, 'auth/forbidden-scope', 'sessions:read must not lift schedule reads')
  assert.equal(reply.scope, 'schedule:read')
  ws.terminate()
})

test('ADV-17c with schedule:read the list and its next run are served, and the reply is the Host projection', async (t) => {
  const items = [{
    id: 'task-1', kind: 'recurring', title: 'nightly', active: true,
    scheduledAt: null, everySeconds: 86_400, time: '03:00', timeZone: 'UTC', weekdays: [1, 2],
    nextRunAt: 1_763_000_000_000, target: { sessionId: 's1' }, updatedAt: 'rev-1',
  }]
  const instance = await factory(t, {
    sessionRows: [{ sessionId: 's1' }],
    scheduleCatalog: () => [{ kind: 'recurring', label: 'recurring' }],
    scheduleList: () => ({ items }),
  })
  const { ws } = await pairDevice(instance, 'adv-sched-0003', { kind: 'mobile', scopes: ['sessions:read', 'schedule:read'] })

  const list = await ask(ws, { type: 'schedule-list', active: true, limit: 5 })
  assert.equal(list.kind, 'schedule-list', JSON.stringify(list).slice(0, 240))
  assert.deepEqual(list.items, items, 'the Host projection is passed through verbatim')
  assert.equal(list.items[0].nextRunAt, 1_763_000_000_000, 'the next run travels with the task')

  const catalog = await ask(ws, { type: 'schedule-catalog' })
  assert.equal(catalog.kind, 'schedule-catalog', 'catalog reply: ' + JSON.stringify(catalog).slice(0, 300))
  assert.deepEqual(catalog.items, [{ kind: 'recurring', label: 'recurring' }])
  ws.terminate()
})

test('ADV-17d the read scope never unlocks a mutation: every schedule write stays admin-only', async (t) => {
  const instance = await factory(t, { sessionRows: [{ sessionId: 's1' }], scheduleList: () => ({ items: [] }) })
  const { ws } = await pairDevice(instance, 'adv-sched-0004', { kind: 'mobile', scopes: ['sessions:read', 'schedule:read'] })
  const since = instance.hostCalls.length
  const writes = [
    { type: 'schedule-create', title: 't', prompt: 'p', timing: { kind: 'once', at: 1 } },
    { type: 'schedule-update', id: 'task-1', patch: { title: 'x' } },
    { type: 'schedule-delete', id: 'task-1' },
    { type: 'schedule-edit', id: 'task-1' },
    { type: 'schedule-run', id: 'task-1' },
    { type: 'schedule-delete-inactive', confirm: true },
    { type: 'schedule-history', id: 'task-1', limit: 10 },
  ]
  for (const frame of writes) {
    const reply = await ask(ws, frame)
    assert.equal(reply.kind, 'error', frame.type + ': ' + JSON.stringify(reply).slice(0, 200))
    assert.equal(reply.code, 'op/forbidden', frame.type + ' must stay op/forbidden with schedule:read, got ' + reply.code)
  }
  const calls = instance.hostCalls.slice(since).filter((call) => String(call.endpoint).startsWith('schedule/'))
  assert.deepEqual(calls, [], 'no mutating schedule call may reach the Host on a read scope')
  ws.terminate()
})

test('ADV-17e schedule:read is never-default and is the scope of exactly the three read frames', async (t) => {
  const contract = await import('@dsh-ext/mobile-protocol')
  assert.equal(contract.SCHEDULE_READ_SCOPE, 'schedule:read')
  assert.deepEqual([...contract.SCHEDULE_READ_CLIENT_TYPES].sort(), ['schedule-catalog', 'schedule-list', 'schedule-view'])
  assert.equal(contract.NEVER_DEFAULT_SCOPES.includes('schedule:read'), true,
    'schedule:read must never be granted by default')
  // "Never-default" means the DEFAULT preset does not hand it out; `full` is the explicit
  // "every scope a mobile may hold" choice (it carries stats:read and web:unlock the same way), so it
  // is the only preset that may include it.
  assert.equal(contract.SCOPE_PRESETS.standard.includes('schedule:read'), false,
    'the default (standard) preset must not include schedule:read')
  assert.equal(contract.SCOPE_PRESETS.full.includes('schedule:read'), true,
    'full is the explicit every-scope choice, so it carries the explicit-only scopes')
  assert.equal(contract.SCOPES.includes('schedule:read'), true, 'a mobile may hold it when it is granted explicitly')
  const mapped = Object.entries(contract.SCOPE_BY_TYPE)
    .filter(([, scope]) => scope === 'schedule:read').map(([type]) => type).sort()
  assert.deepEqual(mapped, ['schedule-catalog', 'schedule-list', 'schedule-view'])
})

// ===========================================================================
// (18) Revision 11 — session rename / archive join `sessions:author`
//
// The scope is the SAME never-default one the authoring surface already used: no new
// grant, no new default, and the two ops add nothing else. `test/session-edit.test.mjs`
// drives the positive path and the wire-level refusals; this item pins the adversarial
// half — a device WITHOUT the scope, and a device that names no session, reach no Host.
// ===========================================================================

const SESSION_EDIT_TYPES = ['session-rename', 'session-archive']

test('ADV-18a revision 11 adds exactly two types to the authoring family, and only on sessions:author', () => {
  assert.deepEqual(
    Object.entries(contract.SCOPE_BY_TYPE)
      .filter(([, scope]) => scope === 'sessions:author').map(([type]) => type).sort(),
    ['models', 'select-model', 'session-archive', 'session-create', 'session-rename', 'workspaces'],
  )
  // No new scope was introduced: the contract vocabulary and the presets are unchanged by
  // revision 11, and `sessions:author` stays out of every default.
  assert.equal(contract.NEVER_DEFAULT_SCOPES.includes('sessions:author'), true)
  assert.equal(contract.SCOPE_PRESETS.standard.includes('sessions:author'), false,
    'the standard preset must never hand out session authoring')
  // Every §4 authoring row really is in OPS, and the two new ones map to their own kinds.
  for (const type of SESSION_EDIT_TYPES) {
    assert.equal(contract.OPS.includes(type), true, type + ' must be a §4 op')
    assert.equal(contract.OP_RESPONSES[type], type === 'session-rename' ? 'session-renamed' : 'session-archived')
  }
})

test('ADV-18b a device WITHOUT sessions:author is refused both ops by scope, and nothing reaches the Host', async (t) => {
  const instance = await factory(t, { sessionRows: [{ sessionId: 's1' }] })
  const { ws } = await pairDevice(instance, 'adv-edit-0001', MOBILE_NO_AUTHOR)
  const since = instance.hostCalls.length
  for (const frame of [
    { type: 'session-rename', sessionId: 's1', title: 'ok' },
    { type: 'session-archive', sessionId: 's1' },
  ]) {
    const reply = await ask(ws, frame)
    assert.equal(reply.kind, 'error', frame.type + ': ' + JSON.stringify(reply).slice(0, 220))
    assert.equal(reply.code, 'auth/forbidden-scope', frame.type + ' → ' + reply.code)
    assert.equal(reply.scope, AUTHOR)
    assert.equal(reply.requestType, frame.type)
  }
  assert.deepEqual(callsSinceSet(instance, since), [],
    'no session-edit frame may reach the Host: ' + callsSinceSet(instance, since))
  ws.close()
})

test('ADV-18c an AUTHOR device naming no session gets bad-request for both ops, and nothing reaches the Host', async (t) => {
  const instance = await factory(t, { sessionRows: [{ sessionId: 's1' }] })
  const { ws } = await pairDevice(instance, 'adv-edit-0002', MOBILE_AUTHOR)
  const since = instance.hostCalls.length
  for (const frame of [
    { type: 'session-rename', title: 'ok' },
    { type: 'session-archive' },
    { type: 'session-rename', sessionId: 7, title: 'ok' },
    { type: 'session-archive', sessionId: {} },
  ]) {
    const reply = await ask(ws, frame)
    assert.equal(reply.kind, 'error', JSON.stringify(reply).slice(0, 220))
    assert.equal(reply.code, 'bad-request', frame.type + ' → ' + reply.code)
  }
  assert.deepEqual(callsSinceSet(instance, since), [],
    'a malformed session id must not reach the Host: ' + callsSinceSet(instance, since))
  ws.close()
})

// ===========================================================================
// (19) Reviewer item 5, MAJOR (a): the `session-archived` reply carries the
// DEVICE's visible archive set, never the Host's complete one.
//
// `workspace/archiveSession` answers with every archived id the Host holds
// (PROTOCOL.md §5). The broadcast `session-archives` already reduces that set to
// the recipient's visible sessions (aggregateFrameFor); the direct reply must use
// the SAME rule, or a phone learns the ids of sessions it was never listed.
// The admin path is unchanged and still gets the complete set.
// ===========================================================================

test('ADV-19a a device archiving a VISIBLE session never receives an archived id it cannot see', async (t) => {
  const instance = await factory(t, {
    sessionRows: [{ sessionId: 's1' }, { sessionId: 's2' }],
    // The Host's complete archive set after this call. Only `s2` is visible to the device.
    archiveSession: () => ({ archivedSessionIds: ['s2', 's-hidden'] }),
  })
  const { ws } = await pairDevice(instance, 'adv-archive-0001', MOBILE_AUTHOR)
  const since = instance.hostCalls.length
  const reply = await ask(ws, { type: 'session-archive', sessionId: 's2' })
  assert.equal(reply.kind, 'session-archived', JSON.stringify(reply).slice(0, 240))
  assert.equal(reply.sessionId, 's2')
  // The archive the device itself made stays in its set: the app merges it from this frame.
  assert.deepEqual(reply.archivedSessionIds, ['s2'],
    'the device gets its own archive entry and nothing else: ' + JSON.stringify(reply.archivedSessionIds))
  // Belt and braces: the hidden id must not appear anywhere in the wire frame.
  assert.equal(JSON.stringify(reply).includes('s-hidden'), false, 'the hidden id leaked: ' + JSON.stringify(reply).slice(0, 240))
  const calls = callsSince(instance, since, 'workspace/archiveSession')
  assert.equal(calls.length, 1, 'exactly one Host call')
  assert.equal(calls[0].principal?.kind, 'dsh-ext-mobile-device', 'it runs as the device, never the owner')
  // The SAME reduction the broadcast applies, read off the device's own baseline: the
  // reply must agree with what the device is allowed to learn there.
  const baseline = await take(ws, (frame) => frame.kind === 'session-archives')
  assert.deepEqual(baseline.archivedSessionIds.filter((id) => id !== 's2'), [], 'sanity: the baseline names no hidden id')
  ws.close()
})

// ===========================================================================
// (20) Reviewer item 5, MINOR (b): a device never receives the Host's
// `error.message` for the three READ-ONLY schedule frames. The structured `code`
// survives; the text is a fixed sentence per code. (session-rename / session-archive
// are covered in test/session-edit.test.mjs, which owns the admin-path parity case.)
// ===========================================================================

/** Text a real Host emits and that must never reach a phone. */
const HIDDEN_HOST_TEXT = '$HOME/owner/secret-tax-2025/tax.db: permission denied'

test('ADV-20b a Host refusal of the three schedule reads reaches a device as its code plus a fixed sentence', async (t) => {
  for (const type of ['schedule-catalog', 'schedule-list', 'schedule-view']) {
    // One instance per frame, so each read really reaches the Host and is refused there.
    const options = { sessionRows: [{ sessionId: 's1' }] }
    options[type === 'schedule-catalog' ? 'scheduleCatalog' : type === 'schedule-list' ? 'scheduleList' : 'scheduleView']
      = () => { throw Object.assign(new Error(HIDDEN_HOST_TEXT), { code: 'schedule/denied' }) }
    const instance = await factory(t, options)
    const { ws } = await pairDevice(instance, `adv-text-${type}`, { kind: 'mobile', scopes: ['sessions:read', 'schedule:read'] })
    const frame = type === 'schedule-view' ? { type, id: 'task-1' } : { type, ...(type === 'schedule-list' ? { active: true, limit: 5 } : {}) }
    const reply = await ask(ws, frame)
    assert.equal(reply.kind, 'error', type + ': ' + JSON.stringify(reply).slice(0, 240))
    assert.equal(reply.code, 'schedule/denied', 'the structured code must survive: ' + JSON.stringify(reply))
    assert.equal(reply.requestType, type)
    assert.equal(String(reply.message).includes(HIDDEN_HOST_TEXT), false,
      'the Host text must not reach the device: ' + String(reply.message))
    assert.equal(String(reply.message).includes('/owner/'), false, 'no Host path may reach the device: ' + String(reply.message))
    ws.close()
  }
})

test('ADV-20c each frame keeps its own sentence for the same code (no one "bad-request" string)', async (t) => {
  // These are the gateway's OWN argument refusals (schedule:read, malformed arguments), so
  // they never reach the Host. They prove the table is keyed per frame as well as per code:
  // collapsing every `bad-request` onto one sentence would fail here.
  const instance = await factory(t, { sessionRows: [{ sessionId: 's1' }] })
  const { ws } = await pairDevice(instance, 'adv-text-0003', { kind: 'mobile', scopes: ['sessions:read', 'schedule:read'] })
  const notices = []
  for (const frame of [
    { type: 'schedule-list', sessionId: 's1', limit: 5 },
    { type: 'schedule-view', id: 'task-1', sessionId: 7 },
  ]) {
    const reply = await ask(ws, frame)
    assert.equal(reply.code, 'bad-request', frame.type + ': ' + JSON.stringify(reply).slice(0, 240))
    notices.push(`${frame.type}: ${reply.message}`)
  }
  assert.equal(new Set(notices.map((notice) => notice.slice(notice.indexOf(': ') + 2))).size, notices.length,
    'the two frames must not share one sentence: ' + JSON.stringify(notices))
  ws.close()
})
