// Spec 008 P2a — the multi-host gateway wrapper (lib/host-router.mjs).
//
// Runs with `node --test --test-isolation=none test/host-router.test.mjs`. No real
// socket is involved: the local carrier is a fake `typertGateway` with the rc.1
// signatures and each remote is a stub `RemoteConnection`, so every assertion is
// about routing / renaming / merging and about what actually crosses the wire to
// a remote Host.
import assert from 'node:assert/strict'
import { EventEmitter } from 'node:events'
import { test } from 'node:test'

import { RemoteConnection } from '../lib/remote-client.mjs'
import {
  DSH_ENGINES_RANGE, HOST_HINT, ID_FIELDS, PINNED_DSH_VERSION, createHostRouter, hostHintOf, hostIdOfId, hostIdsIn, namespaceId,
  namespaceIds, selfTest, stripHostIds, taggedIdsIn,
} from '../lib/host-router.mjs'
import { mountPlugin } from './helpers.mjs'

// -- harness ---------------------------------------------------------------

/** A pushable async sequence, the shape both carrier streams and stubs need. */
function createQueue() {
  const items = []
  const waiters = []
  let closed = false
  return {
    push(value) {
      const waiter = waiters.shift()
      if (waiter) waiter({ value, done: false })
      else items.push(value)
    },
    close() {
      if (closed) return
      closed = true
      for (const waiter of waiters.splice(0)) waiter({ value: undefined, done: true })
    },
    [Symbol.asyncIterator]() {
      return {
        async next() {
          if (items.length > 0) return { value: items.shift(), done: false }
          if (closed) return { value: undefined, done: true }
          return new Promise((resolve) => waiters.push(resolve))
        },
        async return() {
          closed = true
          for (const waiter of waiters.splice(0)) waiter({ value: undefined, done: true })
          return { value: undefined, done: true }
        },
      }
    },
  }
}

const clone = (value) => (value === undefined ? undefined : structuredClone(value))

const session = (id, updatedAt, extra = {}) => ({ sessionId: id, updatedAt, running: false, blank: false, projections: { kind: 'sequenced', asOfSeq: 1, values: {} }, ...extra })

/** A remote Host as the router sees it: one connection, recorded traffic. */
function createFakeRemote(hostId, hostName, options = {}) {
  const calls = []
  const streams = []
  const connection = {
    state: 'online',
    async call(endpoint, args, callOptions) {
      calls.push({ endpoint, args: clone(args), options: callOptions })
      const reply = options.replies?.[endpoint]
      if (reply instanceof Error) throw reply
      return typeof reply === 'function' ? reply(args) : clone(reply) ?? {}
    },
    async openStream(endpoint, args, streamOptions) {
      const queue = createQueue()
      streams.push({ endpoint, args: clone(args), options: streamOptions, queue })
      if (endpoint === 'workspace/follow') {
        queue.push({ type: 'baseline', value: {
          items: options.workspaces ?? [],
          archivedSessionIds: options.archived ?? [],
          pinnedSessionIds: options.pinned ?? [],
        } })
      }
      if (endpoint === 'session/control') {
        queue.push({ type: 'baseline', value: { projections: options.controlProjections ?? {} } })
      }
      return queue
    },
  }
  return {
    hostId, hostName, connection, calls, streams,
    /** Push one more frame into the most recent stream (e.g. a workspace upsert). */
    send(frame) { streams.at(-1).queue.push(frame) },
    closeStream() { streams.at(-1).queue.close() },
  }
}

const workspaceView = (workspaceId, sessionIds, extra = {}) => ({
  workspaceId, path: `/tmp/${workspaceId}`, title: workspaceId, sessionIds,
  createdAt: '2026-11-09T00:00:00.000Z', updatedAt: '2026-11-09T00:00:00.000Z', ...extra,
})

function createHarness({ remotes = [], dispatchRpc, connected: connectedIds, baseline = { items: [], archivedSessionIds: [], pinnedSessionIds: [] }, controlBaseline = { projections: {} } } = {}) {
  const localCalls = []
  const localStreams = []
  const logs = []
  const gateway = {
    // rc.1 signatures: dispatchRpc(endpoint, payload, signal, peer) and
    // openWireStream(endpoint, payload, uplink, peer, signal, control, window).
    // Both record the payload by REFERENCE (`payloadSeen`), so a test can tell the
    // caller's own object from a copy or an envelope this module built.
    async dispatchRpc(endpoint, payload, signal, peer) {
      localCalls.push({ endpoint, payload: clone(payload), payloadSeen: payload })
      return typeof dispatchRpc === 'function' ? dispatchRpc(endpoint, payload, peer) : { ok: true, value: { local: endpoint } }
    },
    async openWireStream(endpoint, payload, uplink, peer, signal, control, window) {
      // A test (or a client) that aborts its stream and walks away models a carrier
      // that is gone: the next harness installs a fresh router, so the previous one
      // must not stay wrapped underneath it. Aborting therefore tears down exactly
      // the router instances this harness installed — never an older one.
      if (endpoint === 'workspace/follow') control?.addEventListener?.('abort', () => { for (const router of installed) router.uninstall() }, { once: true })
      const queue = createQueue()
      localStreams.push({ endpoint, payload: clone(payload), payloadSeen: payload, window, queue })
      if (endpoint === 'workspace/follow') queue.push({ type: 'baseline', value: baseline })
      if (endpoint === 'session/control' && controlBaseline !== null) queue.push({ type: 'baseline', value: controlBaseline })
      return queue
    },
  }
  /** The routers this harness installed, torn down when their streams are aborted. */
  const installed = []
  const cards = new Map()
  const listeners = new Set()
  const connected = new Set(connectedIds ?? remotes.map((remote) => remote.hostId))
  const notify = () => { for (const listener of [...listeners]) listener() }
  const router = createHostRouter({
    gateway,
    // Constitution A1.1: the wrapper is enabled only on the pinned release.
    dshVersion: PINNED_DSH_VERSION,
    hosts: () => remotes.filter((remote) => connected.has(remote.hostId))
      .map((remote) => ({ hostId: remote.hostId, hostName: remote.hostName, connection: remote.connection, online: true })),
    // Every remote this harness owns is PAIRED, connected or not — the production shape
    // (`knownHosts` is what tells the router a host exists at all).
    knownHosts: () => remotes.map((remote) => ({ hostId: remote.hostId, hostName: remote.hostName })),
    onHostsChanged: (listener) => { listeners.add(listener); return () => listeners.delete(listener) },
    approvals: {
      card(hostId, ids) {
        for (const key of [ids?.rpcId, ids?.eventId, ids?.approvalId]) {
          if (typeof key === 'string' && cards.has(`${hostId}|${key}`)) return cards.get(`${hostId}|${key}`)
        }
        return undefined
      },
      // The merged `$events` stream seeds every connected host's buffered cards.
      pending: () => [],
    },
    mergeBaselineTimeoutMs: 100,
    log: (line) => logs.push(line),
  })
  const status = router.install()
  installed.push(router)
  return {
    gateway, router, status, localCalls, localStreams, remotes, cards, logs,
    pair(remote) { remotes.push(remote) },
    connect(hostId) { connected.add(hostId); notify() },
    disconnect(hostId) { connected.delete(hostId); notify() },
  }
}

/** Read one frame with a deadline, so a broken merge fails instead of hanging. */
function nextFrame(iterator, label = 'stream') {
  return Promise.race([
    iterator.next(),
    new Promise((_resolve, reject) => {
      const timer = setTimeout(() => reject(new Error(`${label}: no frame within 2 s`)), 2000)
      timer.unref?.()
    }),
  ])
}

/** Nothing that names another host may reach a remote Host. */
function assertNoNamespacedId(remote) {
  for (const entry of [...remote.calls, ...remote.streams]) {
    assert.deepEqual([...hostIdsIn(entry.args)], [],
      `${entry.endpoint} carried a host namespace: ${JSON.stringify(entry.args)}`)
    assert.equal(/h:[A-Za-z0-9._-]+:/.test(JSON.stringify(entry.args)), false,
      `${entry.endpoint} carried a namespaced id: ${JSON.stringify(entry.args)}`)
  }
}

// -- the table and the rename ----------------------------------------------

test('the rename table is one place and covers the documented fields', () => {
  for (const field of ['sessionId', 'workspaceId', 'agentId', 'parentSessionId', 'childSessionId', 'workspaceFileScopeId',
    'rpcId', 'sessionIds', 'archivedSessionIds', 'pinnedSessionIds', 'workspaceIds', 'subagentCatalog',
    // The reorder ANCHORS: a merged row's "land before this one".
    'beforeWorkspaceId', 'beforeSessionId']) {
    assert.ok(Object.hasOwn(ID_FIELDS, field), `${field} must be routable`)
  }
  assert.equal(hostIdOfId('h:hostB:s1'), 'hostB')
  assert.equal(hostIdOfId('local-session'), null)
  assert.equal(hostIdOfId('h:'), null)
})

test('rename round-trip: nested ids, subagent ids, arrays and $events payloads', () => {
  const local = {
    sessionId: 'h:hostB:s1',
    address: { kind: 'subagent', parentSessionId: 'h:hostB:s1', childSessionId: 'h:hostB:c1', mode: 'continuable' },
    items: [{ sessionId: 'h:hostB:s2' }],
    sessionIds: ['h:hostB:s1', 'h:hostB:s2'],
    pinnedSessionIds: [],
    projections: { values: { subagentCatalog: [{ id: 'h:hostB:c1', mode: 'one-shot', label: 'x' }] } },
    // $events payloads carry plain event args; ids inside them are renamed too.
    events: [{ type: 'emit', event: 'approval/request', args: { sessionId: 'h:hostB:s1', callId: 'call-9', text: 'see https://example.test/h:not-an-id:' } }],
    // Opaque fields are never touched.
    callId: 'h:hostB:not-an-id',
  }
  const raw = {
    sessionId: 's1',
    address: { kind: 'subagent', parentSessionId: 's1', childSessionId: 'c1', mode: 'continuable' },
    items: [{ sessionId: 's2' }],
    sessionIds: ['s1', 's2'],
    pinnedSessionIds: [],
    projections: { values: { subagentCatalog: [{ id: 'c1', mode: 'one-shot', label: 'x' }] } },
    events: [{ type: 'emit', event: 'approval/request', args: { sessionId: 's1', callId: 'call-9', text: 'see https://example.test/h:not-an-id:' } }],
    callId: 'h:hostB:not-an-id',
  }
  assert.deepEqual(stripHostIds(local, 'hostB'), raw)
  assert.deepEqual(namespaceIds(raw, 'hostB'), local)
  // A binary payload keeps its exact bytes (never rebuilt by the walker).
  const bytes = Buffer.from([1, 2, 3])
  assert.equal(namespaceIds({ sessionId: 's1', data: bytes }, 'hostB').data, bytes)
  // The namespace of one host is not applied to another host's ids.
  assert.deepEqual(stripHostIds({ sessionId: 'h:hostB:s1' }, 'hostC'), { sessionId: 'h:hostB:s1' })
  assert.deepEqual([...hostIdsIn({ args: { sessionId: 'h:hostB:s1', sessionIds: ['h:hostC:s2'] } })], ['hostB', 'hostC'])
})

// -- install / self-test ---------------------------------------------------

test('the most fundamental failure wins: gateway presence and carrier methods precede the version', () => {
  // A Host that composes no `typertGateway` reports the missing gateway whatever
  // the running version says — the version probe cannot describe a carrier that is
  // not there, and the Devices page must not blame the release for our fake Host.
  assert.equal(selfTest(undefined, {}), 'no-gateway')
  assert.equal(selfTest(undefined, { dshVersion: '0.3.0' }), 'no-gateway')
  assert.equal(selfTest(null, { dshVersion: PINNED_DSH_VERSION }), 'no-gateway')
  // Not an object (nor a function) is no gateway either.
  assert.equal(selfTest('typertGateway', { dshVersion: PINNED_DSH_VERSION }), 'no-gateway')
  assert.equal(selfTest(42, {}), 'no-gateway')
  // A present carrier with a missing method is still more specific than the version.
  assert.equal(selfTest({}, {}), 'dispatchRpc-missing')
  assert.equal(selfTest({ dispatchRpc() {} }, { dshVersion: '0.3.0' }), 'openWireStream-missing')
  // Only a carrier that has both methods can be blamed on the version.
  const carrier = () => ({ async dispatchRpc(a, b, c, d) { return { ok: true } }, openWireStream(a, b, c, d, e, f) {} })
  assert.equal(selfTest(carrier(), { dshVersion: '0.3.0' }), 'dsh-version-out-of-range')
  assert.equal(selfTest(carrier(), {}), 'dsh-version-unknown')
  // Correct version + correct carrier is the only null.
  assert.equal(selfTest(carrier(), { dshVersion: PINNED_DSH_VERSION }), null)
})

test('self-test mismatch: nothing is wrapped and status says why', () => {
  const legacy = (endpoint, payload, signal) => ({ endpoint, payload, signal }) // 3 params = pre-rc.1 opener
  const gateway = { async dispatchRpc(endpoint, payload, signal, peer) { return { ok: true } }, openWireStream: legacy }
  const dispatch = gateway.dispatchRpc
  const router = createHostRouter({ gateway, dshVersion: PINNED_DSH_VERSION })
  const status = router.install()
  assert.deepEqual({ remote: status.remote, reason: status.reason }, { remote: false, reason: 'openWireStream-signature' })
  assert.equal(gateway.dispatchRpc, dispatch, 'the carrier was not patched')
  assert.equal(gateway.openWireStream, legacy)

  assert.equal(selfTest(undefined, { dshVersion: PINNED_DSH_VERSION }), 'no-gateway')
  assert.equal(selfTest({}, { dshVersion: PINNED_DSH_VERSION }), 'dispatchRpc-missing')
  assert.equal(selfTest({ dispatchRpc() {} }, { dshVersion: PINNED_DSH_VERSION }), 'openWireStream-missing')
  assert.equal(selfTest({ dispatchRpc(a, b, c, d) {}, openWireStream(a, b, c, d, e, f) {} }, { dshVersion: PINNED_DSH_VERSION }), null)
  // A short dispatchRpc (pre-rc.3 shape, no peer) is refused.
  assert.equal(selfTest({ dispatchRpc(a, b, c) {}, openWireStream(a, b, c, d, e, f) {} }, { dshVersion: PINNED_DSH_VERSION }), 'dispatchRpc-signature')
})

test('A1.1: an unknown or different DSH version means no wrap, and the reason is reported', async () => {
  // The pinned release is the only one this wrapper was self-tested against.
  assert.equal(PINNED_DSH_VERSION, '0.2.2-rc.3')
  const carrier = () => ({ async dispatchRpc(a, b, c, d) { return { ok: true } }, openWireStream(a, b, c, d, e, f) {} })
  assert.equal(selfTest(carrier(), {}), 'dsh-version-unknown')
  assert.equal(selfTest(carrier(), { dshVersion: '' }), 'dsh-version-unknown')
  // Layer 2 (owner 2026-11-13): gated on shapes + the declared engines range, not on equality.
  assert.equal(DSH_ENGINES_RANGE, '>=0.2.2-rc.3 <0.3.0-0')
  for (const ok of ['0.2.2-rc.3', '0.2.2-rc.10', '0.2.2', '0.2.3-rc.1', '0.2.9']) {
    assert.equal(selfTest(carrier(), { dshVersion: ok }), null, ok)
  }
  for (const bad of ['0.2.2-rc.1', '0.2.2-rc.2', '0.2.2-beta.1', '0.2.1', '0.3.0-rc.1', '0.3.0', '1.0.0', 'garbage']) {
    assert.equal(selfTest(carrier(), { dshVersion: bad }), 'dsh-version-out-of-range', bad)
  }
  for (const [label, options, reason] of [
    ['no version at all', {}, 'dsh-version-unknown'],
    ['another minor', { dshVersion: '0.3.0' }, 'dsh-version-out-of-range'],
  ]) {
    const gateway = carrier()
    const dispatch = gateway.dispatchRpc
    const stream = gateway.openWireStream
    const router = createHostRouter({ gateway, ...options })
    const status = router.install()
    assert.deepEqual({ remote: status.remote, reason: status.reason }, { remote: false, reason }, label)
    assert.equal(gateway.dispatchRpc, dispatch, `${label}: dispatchRpc was not patched`)
    assert.equal(gateway.openWireStream, stream, `${label}: openWireStream was not patched`)
    // Responsible for the Devices page: the reason travels in the status.
    router.uninstall()
    assert.equal(router.status().reason, reason)
  }
})

test('a Host without a gateway stays "no-gateway" even on an unknown version, and never wraps', () => {
  // The guards suite composes exactly this Host; its reason must not be a version
  // one, and the A1.1 promise (a non-null reason means no wrap) has to hold.
  for (const options of [{}, { dshVersion: '' }, { dshVersion: '0.3.0' }]) {
    const router = createHostRouter({ gateway: undefined, ...options })
    const status = router.install()
    assert.deepEqual({ remote: status.remote, reason: status.reason },
      { remote: false, reason: 'no-gateway' }, JSON.stringify(options))
    assert.equal(router.status().reason, 'no-gateway')
    router.uninstall()
  }
})

test('install wraps both carrier methods and keeps the rc.1 arity the bridge probes', () => {
  const remote = createFakeRemote('hostB', 'Host B')
  const harness = createHarness({ remotes: [remote] })
  assert.equal(harness.status.remote, true)
  assert.equal(harness.status.reason, null)
  assert.equal(harness.gateway.openWireStream.length, 7, 'openWireStream arity survives the wrap')
  assert.equal(harness.gateway.dispatchRpc.length, 4)
  assert.deepEqual(harness.status.merged, ['session/list', 'workspace/follow', 'session/modelCatalog'])
  assert.deepEqual(harness.status.hosts, [{ hostId: 'hostB', hostName: 'Host B', online: true }])
  harness.router.uninstall()
})

test('uninstall restores the originals', async () => {
  const remote = createFakeRemote('hostB', 'Host B')
  const harness = createHarness({ remotes: [remote] })
  const wrapped = { dispatch: harness.gateway.dispatchRpc, open: harness.gateway.openWireStream }
  harness.router.uninstall()
  assert.notEqual(harness.gateway.dispatchRpc, wrapped.dispatch)
  assert.notEqual(harness.gateway.openWireStream, wrapped.open)
  assert.equal(harness.router.status().remote, false)
  // After the restore a tagged id is just an id again: the call stays Local.
  const answer = await harness.gateway.dispatchRpc('session/prompt', { args: { sessionId: 'h:hostB:s1' } }, undefined, {})
  assert.deepEqual(answer, { ok: true, value: { local: 'session/prompt' } })
  assert.equal(remote.calls.length, 0)
})

// -- routing ---------------------------------------------------------------

test('a tagged id routes the call to that host and the result comes back renamed', async () => {
  const hostB = createFakeRemote('hostB', 'Host B', { replies: { 'session/prompt': { accepted: true, sessionId: 's1' } } })
  const hostC = createFakeRemote('hostC', 'Host C')
  const harness = createHarness({ remotes: [hostB, hostC] })

  const answer = await harness.gateway.dispatchRpc('session/prompt', { args: { sessionId: 'h:hostB:s1', text: 'hi' } }, new AbortController().signal, {})
  assert.equal(answer.ok, true)
  assert.deepEqual(answer.value, { accepted: true, sessionId: 'h:hostB:s1' }, 'raw remote id never reaches the UI')
  assert.equal(hostB.calls.length, 1)
  assert.equal(hostB.calls[0].endpoint, 'session/prompt')
  assert.deepEqual(hostB.calls[0].args, { sessionId: 's1', text: 'hi' })
  assert.equal(hostC.calls.length, 0)
  assert.equal(harness.localCalls.length, 0)
  assertNoNamespacedId(hostB)

  // A remote failure keeps the Host's code instead of becoming a local answer.
  hostB.connection.call = async () => { throw Object.assign(new Error('nope'), { code: 'auth/forbidden-scope' }) }
  const refused = await harness.gateway.dispatchRpc('session/prompt', { args: { sessionId: 'h:hostB:s1' } }, undefined, {})
  assert.deepEqual(refused, { ok: false, error: { code: 'auth/forbidden-scope', message: 'nope', details: {} } })
})

test('a tagged workspaceFileScopeId routes workspaceFiles/list to that host with the untagged session id', async () => {
  // The right-panel Workspace files tab asks for its scope by `workspaceFileScopeId`
  // — the wire name of the `workspaceFiles` scope lookup, whose value is a SessionId —
  // never by `sessionId`. Before the table covered it, a tagged call stayed Local and
  // a remote session showed THIS machine's files.
  const listing = { path: 'src', entries: [{ name: 'index.mjs', type: 'file', size: 12 }], truncated: false }
  const hostB = createFakeRemote('hostB', 'Host B', { replies: { 'workspaceFiles/list': listing } })
  const hostC = createFakeRemote('hostC', 'Host C')
  const harness = createHarness({ remotes: [hostB, hostC] })

  const answer = await harness.gateway.dispatchRpc('workspaceFiles/list',
    { args: { workspaceFileScopeId: 'h:hostB:s1', path: 'src' } }, undefined, {})
  assert.equal(answer.ok, true)
  // A listing carries no ids, so the result reaches the UI exactly as it arrived.
  assert.deepEqual(answer.value, listing)
  assert.equal(hostB.calls.length, 1)
  assert.equal(hostB.calls[0].endpoint, 'workspaceFiles/list')
  assert.deepEqual(hostB.calls[0].args, { workspaceFileScopeId: 's1', path: 'src' }, 'the Host gets its own raw session id')
  assert.equal(hostC.calls.length, 0)
  assert.equal(harness.localCalls.length, 0, 'a remote scope is never answered by Local')
  assertNoNamespacedId(hostB)
})

test('workspaceFiles/list without a tagged scope stays Local', async () => {
  const hostB = createFakeRemote('hostB', 'Host B')
  const harness = createHarness({ remotes: [hostB] })

  const answer = await harness.gateway.dispatchRpc('workspaceFiles/list',
    { args: { workspaceFileScopeId: 's1', path: 'src' } }, undefined, {})
  assert.deepEqual(answer, { ok: true, value: { local: 'workspaceFiles/list' } })
  assert.equal(harness.localCalls.length, 1)
  assert.equal(harness.localCalls[0].endpoint, 'workspaceFiles/list')
  assert.deepEqual(harness.localCalls[0].payload.args, { workspaceFileScopeId: 's1', path: 'src' })
  assert.equal(hostB.calls.length, 0, 'an untagged scope is not sent to a remote')
})

// Spec 039: a remote readBytes result carries real bytes in `data`. The native
// gateway cannot put them in JSON, so the router must hand back DSH's attachment
// envelope with a null placeholder; otherwise the client validates `data: null`
// and the Document Preview fails with `path:['data'] invalid input`.
test('a tagged remote workspaceFiles/readBytes wraps Buffer data in an attachment', async () => {
  const raw = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0x00, 0xff])
  // A function reply keeps the Buffer intact (a cloned reply would lose its class).
  const hostB = createFakeRemote('hostB', 'Host B', { replies: {
    'workspaceFiles/readBytes': () => ({
      offset: 0, eof: true, absolutePath: '/srv/host/files/pic.png', version: 'v3', data: raw,
    }),
  } })
  const harness = createHarness({ remotes: [hostB] })

  const answer = await harness.gateway.dispatchRpc('workspaceFiles/readBytes',
    { args: { workspaceFileScopeId: 'h:hostB:s1', path: 'pic.png', offset: 0, maxBytes: 65536 } },
    undefined, {})
  assert.equal(answer.ok, true)
  assert.equal(answer.value.data, null, 'the JSON payload keeps the null placeholder')
  assert.deepEqual(answer.value, {
    offset: 0, eof: true, absolutePath: '/srv/host/files/pic.png', version: 'v3', data: null,
  }, 'the other result fields are kept')
  assert.equal(answer.attachments.length, 1)
  assert.deepEqual(answer.attachments[0].path, ['data'])
  const bytes = answer.attachments[0].bytes
  assert.equal(bytes.constructor, Uint8Array, 'a Buffer is normalized to a plain Uint8Array')
  assert.deepEqual([...bytes], [...raw], 'the attachment is byte-exact')
  assert.notEqual(bytes.buffer, raw.buffer, 'the attachment does not alias the remote Buffer')
  assert.equal(hostB.calls[0].endpoint, 'workspaceFiles/readBytes')
  assert.deepEqual(hostB.calls[0].args, { workspaceFileScopeId: 's1', path: 'pic.png', offset: 0, maxBytes: 65536 })
})

test('a root-level binary remote result becomes a root attachment', async () => {
  const raw = Buffer.from([0, 1, 2, 254, 255])
  const hostB = createFakeRemote('hostB', 'Host B', { replies: { 'custom/rootBytes': () => raw } })
  const harness = createHarness({ remotes: [hostB] })

  const answer = await harness.gateway.dispatchRpc('custom/rootBytes',
    { args: { workspaceFileScopeId: 'h:hostB:s1' } }, undefined, {})
  assert.deepEqual(Object.keys(answer).sort(), ['attachments', 'ok', 'value'])
  assert.equal(answer.ok, true)
  assert.equal(answer.value, null)
  assert.equal(answer.attachments.length, 1)
  assert.deepEqual(answer.attachments[0].path, [])
  assert.equal(answer.attachments[0].bytes.constructor, Uint8Array)
  assert.deepEqual([...answer.attachments[0].bytes], [...raw])
  assert.notEqual(answer.attachments[0].bytes.buffer, raw.buffer)
})

test('a remote result with a null data placeholder and a local binary result stay unchanged', async () => {
  const plain = { offset: 0, eof: true, absolutePath: '/srv/host/files/pic.png', version: 'v3', data: null }
  const hostB = createFakeRemote('hostB', 'Host B', { replies: { 'workspaceFiles/readBytes': () => plain } })
  const harness = createHarness({ remotes: [hostB] })
  const answer = await harness.gateway.dispatchRpc('workspaceFiles/readBytes',
    { args: { workspaceFileScopeId: 'h:hostB:s1', path: 'pic.png' } }, undefined, {})
  assert.deepEqual(answer, { ok: true, value: plain })
  assert.equal(Object.hasOwn(answer, 'attachments'), false)

  const localValue = { data: Buffer.from([1, 2, 3]), offset: 0 }
  const localHarness = createHarness({ dispatchRpc: () => ({ ok: true, value: localValue }) })
  const local = await localHarness.gateway.dispatchRpc('workspaceFiles/readBytes',
    { args: { workspaceFileScopeId: 's1', path: 'local.png' } }, undefined, {})
  assert.equal(local.value, localValue, 'Local keeps its exact reply object')
  assert.equal(Object.hasOwn(local, 'attachments'), false)
  assert.equal(localHarness.remotes.length, 0)
})

test('a global call stays Local by default and follows the host hint', async () => {
  const hostB = createFakeRemote('hostB', 'Host B', { replies: { 'llm/listProviders': { providers: ['b-only'] } } })
  const harness = createHarness({ remotes: [hostB] })

  const local = await harness.gateway.dispatchRpc('llm/listProviders', { args: {} }, undefined, {})
  assert.deepEqual(local, { ok: true, value: { local: 'llm/listProviders' } })
  assert.equal(hostB.calls.length, 0)

  const hinted = await harness.gateway.dispatchRpc('llm/listProviders', { args: { [HOST_HINT]: 'hostB' } }, undefined, {})
  assert.deepEqual(hinted, { ok: true, value: { providers: ['b-only'] } })
  assert.equal(hostB.calls.length, 1)
  assert.deepEqual(hostB.calls[0].args, {}, 'the hint itself is never forwarded')
  assert.equal(hostHintOf({ args: { [HOST_HINT]: 'hostB' } }), 'hostB')
  assertNoNamespacedId(hostB)
})

test('an unknown or offline host is a clear remote/host-offline, never a local fallback', async () => {
  const hostB = createFakeRemote('hostB', 'Host B')
  const harness = createHarness({ remotes: [hostB] })
  harness.disconnect('hostB')

  for (const sessionId of ['h:hostB:s1', 'h:ghost:s1']) {
    const answer = await harness.gateway.dispatchRpc('session/prompt', { args: { sessionId } }, undefined, {})
    assert.equal(answer.ok, false)
    assert.equal(answer.error.code, 'remote/host-offline')
    assert.match(answer.error.message, /not connected/)
  }
  assert.equal(harness.localCalls.length, 0, 'an offline host is not served by Local')
  assert.equal(hostB.calls.length, 0)
})

test('two host ids in one payload are refused instead of guessed', async () => {
  const hostB = createFakeRemote('hostB', 'Host B')
  const hostC = createFakeRemote('hostC', 'Host C')
  const harness = createHarness({ remotes: [hostB, hostC] })
  const answer = await harness.gateway.dispatchRpc('session/prompt', {
    args: { sessionId: 'h:hostB:s1', parentSessionId: 'h:hostC:s2' },
  }, undefined, {})
  assert.equal(answer.ok, false)
  assert.equal(answer.error.code, 'remote/host-conflict')
  assert.equal(hostB.calls.length + hostC.calls.length, 0)
})

// -- inbound ids are opaque (a remote may not choose a namespace) -----------

test('a remote result whose id already names a host namespace is refused: remote/id-leak', async () => {
  // A compromised Host B claims A's namespace. If that id were trusted (or merely
  // wrapped "unless it already looks tagged"), B's card/row would appear under A
  // and every later decision would route to the wrong Host.
  const hostile = {
    'session/page': { sessionId: 'h:hostA:s1', items: [{ sessionId: 'h:hostA:s2' }] },
    'session/search': { sessionIds: ['h:hostA:s1'], nested: { agentId: 'h:hostA:c1' } },
    'session/events': { sessionId: 'h:hostA:s1', rpcId: 'h:hostA:rpc-1', eventId: 'h:hostA:e1' },
  }
  for (const [endpoint, reply] of Object.entries(hostile)) {
    const hostB = createFakeRemote('hostB', 'Host B', { replies: { [endpoint]: reply } })
    const harness = createHarness({ remotes: [hostB] })
    const answer = await harness.gateway.dispatchRpc(endpoint,
      { args: { sessionId: 'h:hostB:s1' } }, undefined, {})
    assert.equal(answer.ok, false, `${endpoint}: the payload was refused`)
    assert.equal(answer.error.code, 'remote/id-leak', endpoint)
    assert.ok(harness.logs.some((line) => line.includes('remote/id-leak')), `${endpoint}: the refusal is logged`)
    // The Host was still asked (the ids are checked on the way back), but nothing
    // of what it answered reached this machine.
    assert.equal(hostB.calls.length, 1)
    assert.equal(JSON.stringify(answer.value ?? null).includes('h:hostA:'), false)
  }
})

test('a pseudo-tagged callId on ANY remote frame is refused: remote/id-leak', async () => {
  const hostB = createFakeRemote('hostB', 'Host B', {
    replies: { 'session/page': { sessionId: 's1', items: [{ part: { callId: 'h:hostA:c1' } }] } },
  })
  const harness = createHarness({ remotes: [hostB] })
  const answer = await harness.gateway.dispatchRpc('session/page', { args: { sessionId: 'h:hostB:s1' } }, undefined, {})
  assert.equal(answer.ok, false)
  assert.equal(answer.error.code, 'remote/id-leak')
  assert.ok(harness.logs.some((line) => line.includes('remote/id-leak')))
  // An ordinary callId still passes verbatim.
  const clean = createFakeRemote('hostB', 'Host B', { replies: { 'session/page': { items: [{ callId: 'c1' }] } } })
  const ok = await createHarness({ remotes: [clean] }).gateway.dispatchRpc('session/page', { args: { sessionId: 'h:hostB:s1' } }, undefined, {})
  assert.equal(ok.ok, true)
  assert.equal(ok.value.items[0].callId, 'c1')
})

test('remote browser handles (targetId/tabId/frameId) are tagged and route back without a sessionId or hint', async () => {
  // Follow-up browser calls are not guaranteed to carry a sessionId/__dshHost
  // (e.g. `close {tabId}`), so the handle itself must name the host.
  const hostB = createFakeRemote('hostB', 'Host B', {
    replies: { 'browser/open': { tabId: 't2', targetId: 't2', frameId: 'f1' }, 'browser/close': { closed: true, tabId: 't2' } },
  })
  const harness = createHarness({ remotes: [hostB] })
  const opened = await harness.gateway.dispatchRpc('browser/open', { args: { __dshHost: 'hostB' } }, undefined, {})
  assert.equal(opened.ok, true)
  assert.deepEqual(opened.value, { tabId: 'h:hostB:t2', targetId: 'h:hostB:t2', frameId: 'h:hostB:f1' })
  const closed = await harness.gateway.dispatchRpc('browser/close', { args: { tabId: opened.value.tabId } }, undefined, {})
  assert.equal(closed.ok, true)
  assert.equal(hostB.calls.length, 2, 'the untagged-session follow-up reached hostB, not Local')
  assert.equal(JSON.stringify(hostB.calls[1]).includes('h:hostB:'), false, 'the tag is stripped before the Host sees it')
})

test('anything a remote sends is wrapped in ITS namespace, never passed through', async () => {
  // Not hostile, just an id that happens to look tagged in a way that resolves to
  // no host: it is still wrapped in the authenticated source's namespace.
  const hostB = createFakeRemote('hostB', 'Host B', { replies: { 'session/page': { sessionId: 'h:' } } })
  const harness = createHarness({ remotes: [hostB] })
  const answer = await harness.gateway.dispatchRpc('session/page', { args: { sessionId: 'h:hostB:s1' } }, undefined, {})
  assert.equal(answer.ok, false)
  assert.equal(answer.error.code, 'remote/id-leak', 'even a half-tag is refused, never trusted')
  // The wrapper itself has no "already tagged, keep it" branch: it refuses.
  assert.throws(() => namespaceId('hostB', 'h:'), (error) => error.code === 'remote/id-leak')
  assert.throws(() => namespaceId('hostB', 'h:hostA:s1'), (error) => error.code === 'remote/id-leak')
  assert.equal(namespaceId('hostB', 's1'), 'h:hostB:s1')
})

test('session/list refuses a hostile row from one host and keeps the others', async () => {
  const hostB = createFakeRemote('hostB', 'Host B', {
    replies: { 'session/list': { items: [session('h:hostA:s1', 500), session('sb1', 300)] } },
  })
  const hostC = createFakeRemote('hostC', 'Host C', { replies: { 'session/list': { items: [session('sc1', 200)] } } })
  const harness = createHarness({ remotes: [hostB, hostC] })
  const answer = await harness.gateway.dispatchRpc('session/list', { args: {} }, undefined, {})
  assert.equal(answer.ok, true)
  // B's whole contribution is refused (the row is checked before it is trusted),
  // C's rows are untouched and every id is this controller's namespacing.
  assert.deepEqual(answer.value.items.map((row) => row.sessionId), ['h:hostC:sc1'])
  assert.ok(harness.logs.some((line) => line.includes('remote/id-leak')))
})

test('a workspace/follow baseline that names a namespace is refused and drops that host', async () => {
  // The hostile baseline arrives as the host's very first frame, so the refusal is
  // what keeps A's ids out of the merged map — not a race the test could win.
  const hostB = createFakeRemote('hostB', 'Host B', { workspaces: [workspaceView('h:hostA:w1', ['h:hostA:s1'])] })
  const hostC = createFakeRemote('hostC', 'Host C', { workspaces: [workspaceView('w2', ['s2'])] })
  const harness = createHarness({ remotes: [hostB, hostC] })
  const control = new AbortController()
  const source = await harness.gateway.openWireStream('workspace/follow', { args: {} }, undefined, {}, control.signal, control, 64)
  try {
    const iterator = source[Symbol.asyncIterator]()
    const baseline = await nextFrame(iterator, 'merged baseline')
    assert.equal(baseline.value.type, 'baseline')
    assert.deepEqual([...hostIdsIn(baseline.value)], ['hostC'], 'only the clean host contributes')
    assert.equal(JSON.stringify(baseline.value).includes('h:hostA:'), false)
    assert.equal(baseline.value.value.items.length, 1)
    assert.equal(/^h:hostC:/.test(baseline.value.value.items[0].workspaceId), true)
    assert.ok(harness.logs.some((line) => line.includes('remote/id-leak')))
    await iterator.return()
  } finally {
    control.abort()
  }
})

test('the same raw id from two hosts stays two ids and each call reaches its own host', async () => {
  const hostA = createFakeRemote('hostA', 'Host A', { replies: {
    'session/list': { items: [session('s1', 100)] },
    'session/prompt': { accepted: true },
  } })
  const hostB = createFakeRemote('hostB', 'Host B', { replies: {
    'session/list': { items: [session('s1', 200)] },
    'session/prompt': { accepted: true },
  } })
  const harness = createHarness({ remotes: [hostA, hostB] })
  const listed = await harness.gateway.dispatchRpc('session/list', { args: {} }, undefined, {})
  const ids = listed.value.items.map((row) => row.sessionId)
  assert.deepEqual(ids.sort(), ['h:hostA:s1', 'h:hostB:s1'].sort(), 'a colliding raw id becomes two namespaced ids')

  // Each decision goes to the host that owns the tag, with the RAW id.
  for (const [tag, host] of [['h:hostA:s1', hostA], ['h:hostB:s1', hostB]]) {
    const answer = await harness.gateway.dispatchRpc('session/prompt', { args: { sessionId: tag, text: 'x' } }, undefined, {})
    assert.equal(answer.ok, true)
    assert.deepEqual(host.calls.at(-1).args, { sessionId: 's1', text: 'x' })
  }
  assert.deepEqual(hostA.calls.filter((call) => call.endpoint === 'session/prompt').map((call) => call.args.sessionId), ['s1'])
  assert.deepEqual(hostB.calls.filter((call) => call.endpoint === 'session/prompt').map((call) => call.args.sessionId), ['s1'])
  assertNoNamespacedId(hostA)
  assertNoNamespacedId(hostB)
})

// -- payload shape: prototype-safe, depth-bounded ---------------------------

test('a __proto__ key in a remote payload neither pollutes nor survives the rename', async () => {
  // `JSON.parse` makes `__proto__` an own property; a plain assignment would then
  // rebuild the prototype of the renamed copy instead of copying a field.
  const hostile = JSON.parse('{"sessionId":"s1","__proto__":{"polluted":true},"constructor":{"polluted":true},"prototype":{"polluted":true}}')
  const hostB = createFakeRemote('hostB', 'Host B', { replies: { 'session/page': hostile } })
  const harness = createHarness({ remotes: [hostB] })
  const answer = await harness.gateway.dispatchRpc('session/page', { args: { sessionId: 'h:hostB:s1' } }, undefined, {})
  assert.equal(answer.ok, true, JSON.stringify(answer))
  const value = answer.value
  assert.equal({}.polluted, undefined, 'Object.prototype was not polluted')
  assert.equal(Object.getPrototypeOf(value), Object.prototype, 'the renamed copy is a plain object')
  assert.equal(Object.hasOwn(value, '__proto__'), false, 'the key was dropped, not assigned')
  assert.equal(Object.hasOwn(value, 'constructor'), false)
  assert.equal(Object.hasOwn(value, 'prototype'), false)
  assert.equal(value.sessionId, 'h:hostB:s1', 'the real data still arrived, renamed')
})

test('a payload nested past the depth bound is refused instead of passed through', async () => {
  const deep = (levels) => {
    let value = { sessionId: 's1' }
    for (let index = 0; index < levels; index += 1) value = { child: value }
    return value
  }
  // A ~100-level session history loads and its deep id is still renamed; 256 is the
  // bound, 257 are refused — a deeper subtree would come back unrenamed.
  const ok = createFakeRemote('hostB', 'Host B', { replies: { 'session/page': deep(100) } })
  const bounded = createHarness({ remotes: [ok] })
  const fine = await bounded.gateway.dispatchRpc('session/page', { args: { sessionId: 'h:hostB:s1' } }, undefined, {})
  assert.equal(fine.ok, true, JSON.stringify(fine))
  let leaf = fine.value
  while (leaf.child) leaf = leaf.child
  assert.equal(leaf.sessionId, 'h:hostB:s1', 'the deep id was renamed')
  const edge = createFakeRemote('hostB', 'Host B', { replies: { 'session/page': deep(256) } })
  const atBound = await createHarness({ remotes: [edge] }).gateway.dispatchRpc('session/page', { args: { sessionId: 'h:hostB:s1' } }, undefined, {})
  assert.equal(atBound.ok, true, JSON.stringify(atBound))

  const hostB = createFakeRemote('hostB', 'Host B', { replies: { 'session/page': deep(257) } })
  const harness = createHarness({ remotes: [hostB] })
  const refused = await harness.gateway.dispatchRpc('session/page', { args: { sessionId: 'h:hostB:s1' } }, undefined, {})
  assert.equal(refused.ok, false)
  assert.equal(refused.error.code, 'remote/payload-too-deep')
  assert.equal(refused.value, undefined, 'no subtree was returned')
  assert.ok(harness.logs.some((line) => line.includes('remote/payload-too-deep')))

  // The same bound guards what is SENT: a payload that names a host at the top but
  // nests past the bound deeper down is refused before any Host sees it.
  const hostC = createFakeRemote('hostC', 'Host C')
  const sending = createHarness({ remotes: [hostC] })
  const outbound = await sending.gateway.dispatchRpc('session/prompt',
    { args: { ...deep(257), sessionId: 'h:hostC:s1' } }, undefined, {})
  assert.equal(outbound.ok, false)
  assert.equal(outbound.error.code, 'remote/payload-too-deep')
  assert.equal(hostC.calls.length, 0, 'the Host never received the payload')
  // A too-deep payload that names no host is an ordinary Local call: nothing is
  // renamed on that path, so there is no id to leak.
  const localDeep = await sending.gateway.dispatchRpc('session/page', { args: deep(257) }, undefined, {})
  assert.deepEqual(localDeep, { ok: true, value: { local: 'session/page' } })
})

test('a stream opened for a remote session goes through remote-stream-open', async () => {  const hostB = createFakeRemote('hostB', 'Host B')
  const harness = createHarness({ remotes: [hostB] })
  const source = await harness.gateway.openWireStream('session/follow', { args: { request: { address: { kind: 'session', sessionId: 'h:hostB:s1' } } } }, undefined, {}, new AbortController().signal, new AbortController(), 64)
  hostB.streams.at(-1).queue.push({ type: 'snapshot', header: { version: 4, id: 's1' } })
  hostB.streams.at(-1).queue.push({ type: 'event', event: { type: 'session/title', seq: 2, time: 1, data: { sessionId: 's1' } } })
  const iterator = source[Symbol.asyncIterator]()
  const snapshot = await nextFrame(iterator)
  assert.deepEqual(snapshot.value, { type: 'snapshot', header: { version: 4, id: 'h:hostB:s1' } })
  const event = await nextFrame(iterator)
  assert.deepEqual(event.value.event.data, { sessionId: 'h:hostB:s1' })
  assert.equal(hostB.streams[0].endpoint, 'session/follow')
  assert.deepEqual(hostB.streams[0].args, { request: { address: { kind: 'session', sessionId: 's1' } } })
  assertNoNamespacedId(hostB)
  await iterator.return()
})

test('$events is the Local stream, plus the remotes cards (spec 008 P2c)', async () => {
  const hostB = createFakeRemote('hostB', 'Host B')
  const harness = createHarness({ remotes: [hostB] })
  const control = new AbortController()
  const source = await harness.gateway.openWireStream('$events', { args: {} }, undefined, {}, control.signal, control, 64)
  const iterator = source[Symbol.asyncIterator]()
  const first = iterator.next()
  // The Local carrier is opened as the spine of the merged stream; nothing is
  // asked of a remote just because the UI subscribed to its events.
  await new Promise((resolve) => setImmediate(resolve))
  assert.equal(harness.localStreams.length, 1)
  assert.equal(harness.localStreams[0].endpoint, '$events')
  harness.localStreams[0].queue.push({ type: 'ready', clientId: 'c1', host: { home: '/home/owner' } })
  assert.deepEqual((await first).value, { type: 'ready', clientId: 'c1', host: { home: '/home/owner' } })
  assert.equal(hostB.streams.length, 0, 'no remote stream is opened for the Local event feed')
  control.abort()
  await iterator.return()
})

test('$events carries remote session statuses in the host namespace, and refuses a tagged id', async () => {
  const hostB = createFakeRemote('hostB', 'Host B')
  // A real RemoteConnection emits `sessionStatus`; give only this stub the same
  // surface so the test drives the watcher through its actual listener contract.
  const pushed = new EventEmitter()
  hostB.connection.on = pushed.on.bind(pushed)
  hostB.connection.off = pushed.off.bind(pushed)
  const harness = createHarness({ remotes: [hostB] })
  const control = new AbortController()
  const source = await harness.gateway.openWireStream('$events', { args: {} }, undefined, {}, control.signal, control, 64)
  const iterator = source[Symbol.asyncIterator]()
  const first = iterator.next()
  await new Promise((resolve) => setImmediate(resolve))
  harness.localStreams[0].queue.push({ type: 'ready', clientId: 'c1', host: { home: '/home/owner' } })
  assert.equal((await first).value.type, 'ready', 'the Local spine still comes first')
  assert.equal(pushed.listenerCount('sessionStatus'), 1)

  const status = (sessionId, running) => ({ kind: 'session-status', sessionId, running })
  const frameOf = (sessionId, running) => ({ type: 'emit', event: 'api-session/status', args: [`h:hostB:${sessionId}`, running] })
  pushed.emit('sessionStatus', status('s1', true))
  assert.deepEqual((await nextFrame(iterator, 'status true')).value, frameOf('s1', true))
  pushed.emit('sessionStatus', status('s1', false))
  assert.deepEqual((await nextFrame(iterator, 'status false')).value, frameOf('s1', false))

  // The pre-tagged id must name no host but the one the frame came from: a valid
  // frame right after it proves the refusal published nothing at all.
  pushed.emit('sessionStatus', status('h:hostX:s1', true))
  assert.ok(harness.logs.some((line) => line.includes('remote/id-leak')), 'the refusal is logged')
  pushed.emit('sessionStatus', status('s2', true))
  assert.deepEqual((await nextFrame(iterator, 'status after refusal')).value, frameOf('s2', true))

  harness.disconnect('hostB')
  assert.equal(pushed.listenerCount('sessionStatus'), 0, 'the watcher detaches on disconnect')
  // A disconnect republishes the catalog; consume that announcement, then prove
  // the detached host can no longer put a status on the stream.
  const within = (ms) => Promise.race([
    iterator.next(),
    new Promise((resolve) => {
      const timer = setTimeout(() => resolve({ value: undefined, done: true }), ms)
      timer.unref?.()
    }),
  ])
  for (;;) {
    const next = await within(30)
    if (next.value?.event === 'llm/models-updated') continue
    assert.equal(next.value, undefined, 'no status frame from a detached host')
    break
  }
  control.abort()
  await iterator.return()
})

// -- the status of a session the sidebar has never listed ------------------
//
// The gateway forwards `{kind:'session-status'}` on `api-session/added` but drops
// the summary: without a list reload the native sidebar never creates the row,
// so the running dot is delivered to nobody.

/** Give a stub connection the real `RemoteConnection` listener surface. */
function attachPusher(remote) {
  const pushed = new EventEmitter()
  remote.connection.on = pushed.on.bind(pushed)
  remote.connection.off = pushed.off.bind(pushed)
  return pushed
}

async function openEventsStream(harness) {
  const control = new AbortController()
  const source = await harness.gateway.openWireStream('$events', { args: {} }, undefined, {}, control.signal, control, 64)
  const iterator = source[Symbol.asyncIterator]()
  const ready = iterator.next()
  await new Promise((resolve) => setImmediate(resolve))
  harness.localStreams[0].queue.push({ type: 'ready', clientId: 'c1', host: { home: '/home/owner' } })
  assert.equal((await ready).value.type, 'ready')
  return { control, iterator }
}

async function waitUntil(check, label, timeoutMs = 1500) {
  const deadline = Date.now() + timeoutMs
  while (Date.now() < deadline) {
    if (check()) return
    await new Promise((resolve) => setTimeout(resolve, 10))
  }
  assert.fail(`${label}: condition not met within ${timeoutMs} ms`)
}

/** One frame within `ms`, or undefined when the stream stayed quiet. */
function quietFrame(iterator, ms = 150) {
  return Promise.race([
    iterator.next(),
    new Promise((resolve) => {
      const timer = setTimeout(() => resolve(undefined), ms)
      timer.unref?.()
    }),
  ])
}

const listCalls = (remote) => remote.calls.filter((call) => call.endpoint === 'session/list')

test('an unknown status reloads the list once: added carries the tagged row before the repeated status, without cwd', async () => {
  const hostB = createFakeRemote('hostB', 'Host B', { replies: { 'session/list': {
    items: [session('new-session', 300, { cwd: 'C:\\Users\\remote\\REA_Project' })],
  } } })
  const pushed = attachPusher(hostB)
  const harness = createHarness({ remotes: [hostB] })
  const { control, iterator } = await openEventsStream(harness)
  try {
    pushed.emit('sessionStatus', { kind: 'session-status', sessionId: 'new-session', running: true })
    const first = await nextFrame(iterator, 'first status')
    assert.deepEqual(first.value, { type: 'emit', event: 'api-session/status', args: ['h:hostB:new-session', true] })

    await waitUntil(() => listCalls(hostB).length === 1, 'the debounced session/list call')
    assert.deepEqual(listCalls(hostB)[0].args, {}, 'the carrier takes the same bare args object as #mergeSessionList')
    assertNoNamespacedId(hostB)

    const added = await nextFrame(iterator, 'added row')
    assert.equal(added.value.event, 'api-session/added')
    const row = added.value.args[0]
    assert.equal(row.sessionId, 'h:hostB:new-session')
    assert.equal(Object.hasOwn(row, 'cwd'), false, 'a remote cwd is omitted, never replaced with a local path')
    assert.deepEqual(row, session('h:hostB:new-session', 300), 'every other field survives ingress')
    const repeated = await nextFrame(iterator, 'status after added')
    assert.deepEqual(repeated.value, first.value, 'the status is republished after the row exists')
    harness.router.uninstall()
  } finally {
    control.abort()
    await iterator.return()
  }
})

test('a burst of unknown statuses causes exactly one session/list call', async () => {
  const hostB = createFakeRemote('hostB', 'Host B', { replies: { 'session/list': {
    items: ['s1', 's2', 's3'].map((id) => session(id, 100)),
  } } })
  const pushed = attachPusher(hostB)
  const harness = createHarness({ remotes: [hostB] })
  const { control, iterator } = await openEventsStream(harness)
  try {
    for (const id of ['s1', 's2', 's3']) {
      pushed.emit('sessionStatus', { kind: 'session-status', sessionId: id, running: true })
    }
    for (const id of ['s1', 's2', 's3']) {
      const frame = await nextFrame(iterator, 'burst status')
      assert.deepEqual(frame.value, { type: 'emit', event: 'api-session/status', args: [`h:hostB:${id}`, true] })
    }
    await waitUntil(() => listCalls(hostB).length === 1, 'the single session/list call')
    await new Promise((resolve) => setTimeout(resolve, 400))
    assert.equal(listCalls(hostB).length, 1, 'the rest of the burst shared the one debounce window')
    harness.router.uninstall()
  } finally {
    control.abort()
    await iterator.return()
  }
})

test('a status for a retained row causes no session/list call', async () => {
  const hostB = createFakeRemote('hostB', 'Host B', { replies: { 'session/list': {
    items: [session('sb1', 200)],
  } } })
  const pushed = attachPusher(hostB)
  const harness = createHarness({ remotes: [hostB] })
  const listed = await harness.gateway.dispatchRpc('session/list', { args: {} }, undefined, {})
  assert.deepEqual(listed.value.items.map((row) => row.sessionId), ['h:hostB:sb1'])
  const before = listCalls(hostB).length
  const { control, iterator } = await openEventsStream(harness)
  try {
    pushed.emit('sessionStatus', { kind: 'session-status', sessionId: 'sb1', running: true })
    assert.deepEqual((await nextFrame(iterator, 'known status')).value,
      { type: 'emit', event: 'api-session/status', args: ['h:hostB:sb1', true] })
    await new Promise((resolve) => setTimeout(resolve, 400))
    assert.equal(listCalls(hostB).length, before, 'no reload and no added frame for a known row')
    const extra = await quietFrame(iterator)
    assert.notEqual(extra?.value?.event, 'api-session/added')
    harness.router.uninstall()
  } finally {
    control.abort()
    await iterator.return()
  }
})

test('a refreshed list withdraws a tagged id that disappeared', async () => {
  let rows = [session('s1', 300), session('s2', 200)]
  const hostB = createFakeRemote('hostB', 'Host B', { replies: { get 'session/list'() { return { items: rows } } } })
  const pushed = attachPusher(hostB)
  const harness = createHarness({ remotes: [hostB] })
  const listed = await harness.gateway.dispatchRpc('session/list', { args: {} }, undefined, {})
  assert.deepEqual(listed.value.items.map((row) => row.sessionId), ['h:hostB:s1', 'h:hostB:s2'])
  rows = [session('s1', 300), session('s3', 400)]
  const { control, iterator } = await openEventsStream(harness)
  try {
    pushed.emit('sessionStatus', { kind: 'session-status', sessionId: 's3', running: false })
    assert.deepEqual((await nextFrame(iterator, 'new status')).value,
      { type: 'emit', event: 'api-session/status', args: ['h:hostB:s3', false] })
    const added = await nextFrame(iterator, 'added s3')
    assert.deepEqual(added.value, { type: 'emit', event: 'api-session/added', args: [session('h:hostB:s3', 400)] })
    assert.deepEqual((await nextFrame(iterator, 'repeated status')).value,
      { type: 'emit', event: 'api-session/status', args: ['h:hostB:s3', false] })
    const removed = await nextFrame(iterator, 'removed s2')
    assert.deepEqual(removed.value, { type: 'emit', event: 'api-session/removed', args: ['h:hostB:s2'] })
    harness.router.uninstall()
  } finally {
    control.abort()
    await iterator.return()
  }
})

test('a refresh row with a pre-tagged id is logged and publishes no row', async () => {
  const hostB = createFakeRemote('hostB', 'Host B', { replies: { 'session/list': {
    items: [session('h:hostX:evil', 300)],
  } } })
  const pushed = attachPusher(hostB)
  const harness = createHarness({ remotes: [hostB] })
  const { control, iterator } = await openEventsStream(harness)
  try {
    pushed.emit('sessionStatus', { kind: 'session-status', sessionId: 'fresh', running: true })
    await nextFrame(iterator, 'first status')
    await waitUntil(() => harness.logs.some((line) => line.includes('session/list refresh from hostB failed: remote/id-leak')), 'the refusal log')
    assert.ok(harness.logs.some((line) => line.includes('remote/id-leak')))
    const extra = await quietFrame(iterator)
    assert.notEqual(extra?.value?.event, 'api-session/added', 'a hostile row creates no row')
    assert.equal(JSON.stringify(extra?.value ?? {}).includes('h:hostX:evil'), false, 'no raw remote id leaks')
    harness.router.uninstall()
  } finally {
    control.abort()
    await iterator.return()
  }
})

test('a failed refresh logs and leaves the retained rows alone', async () => {
  let reply = { items: [session('sb1', 200)] }
  const hostB = createFakeRemote('hostB', 'Host B', { replies: { get 'session/list'() { return reply } } })
  const pushed = attachPusher(hostB)
  const harness = createHarness({ remotes: [hostB] })
  await harness.gateway.dispatchRpc('session/list', { args: {} }, undefined, {})
  reply = Object.assign(new Error('offline'), { code: 'remote/host-offline' })
  const { control, iterator } = await openEventsStream(harness)
  try {
    pushed.emit('sessionStatus', { kind: 'session-status', sessionId: 'fresh', running: true })
    await nextFrame(iterator, 'first status')
    await waitUntil(() => harness.logs.some((line) => line.includes('session/list refresh from hostB failed: remote/host-offline')), 'the failure log')
    const extra = await quietFrame(iterator)
    assert.notEqual(extra?.value?.event, 'api-session/added')
    assert.notEqual(extra?.value?.event, 'api-session/removed', 'the old row was not withdrawn by a failed call')
    harness.router.uninstall()
  } finally {
    control.abort()
    await iterator.return()
  }
})

test('disconnect cancels a pending refresh and detaches the watcher', async () => {
  const hostB = createFakeRemote('hostB', 'Host B', { replies: { 'session/list': {
    items: [session('fresh', 300)],
  } } })
  const pushed = attachPusher(hostB)
  const harness = createHarness({ remotes: [hostB] })
  const { control, iterator } = await openEventsStream(harness)
  try {
    pushed.emit('sessionStatus', { kind: 'session-status', sessionId: 'fresh', running: true })
    await nextFrame(iterator, 'first status')
    harness.disconnect('hostB')
    assert.equal(pushed.listenerCount('sessionStatus'), 0)
    await new Promise((resolve) => setTimeout(resolve, 400))
    assert.equal(listCalls(hostB).length, 0, 'the debounced call was cancelled with the host')
    harness.router.uninstall()
  } finally {
    control.abort()
    await iterator.return()
  }
})

test('an in-flight refresh resolved after disconnect+reconnect is stale and commits nothing', async () => {
  let calls = 0
  let resolveOld
  const oldAnswer = new Promise((resolve) => { resolveOld = resolve })
  const hostB = createFakeRemote('hostB', 'Host B', { replies: {
    'session/list': () => {
      calls += 1
      return calls === 2 ? oldAnswer : { items: [session('sb1', 200)] }
    },
  } })
  const pushed = attachPusher(hostB)
  const harness = createHarness({ remotes: [hostB] })
  const listed = await harness.gateway.dispatchRpc('session/list', { args: {} }, undefined, {})
  assert.deepEqual(listed.value.items.map((row) => row.sessionId), ['h:hostB:sb1'])
  const { control, iterator } = await openEventsStream(harness)
  try {
    pushed.emit('sessionStatus', { kind: 'session-status', sessionId: 'fresh', running: true })
    assert.deepEqual((await nextFrame(iterator, 'first status')).value,
      { type: 'emit', event: 'api-session/status', args: ['h:hostB:fresh', true] })
    await waitUntil(() => listCalls(hostB).length === 2, 'the in-flight refresh call')
    const oldSignal = listCalls(hostB)[1].options.signal
    assert.equal(oldSignal.aborted, false, 'the call is live while its watcher owns it')
    harness.disconnect('hostB')
    assert.equal(oldSignal.aborted, true, 'disconnect cancels the in-flight call')
    harness.connect('hostB')
    resolveOld({ items: [session('fresh', 300)] })
    const emitted = []
    for (let i = 0; i < 4; i += 1) {
      const frame = await quietFrame(iterator, 80)
      if (typeof frame?.value?.event === 'string' && frame.value.event.startsWith('api-session/')) emitted.push(frame.value)
    }
    assert.deepEqual(emitted, [], 'the old generation published no added/removed/status frame')
    // Read retention through the merged list of a PAIRED host that is offline:
    // dispatching while it was connected would overwrite retention with a new answer.
    harness.disconnect('hostB')
    const retained = await harness.gateway.dispatchRpc('session/list', { args: {} }, undefined, {})
    assert.deepEqual(retained.value.items.map((row) => row.sessionId), ['h:hostB:sb1'],
      'the old generation did not replace the retained rows')
    harness.router.uninstall()
  } finally {
    control.abort()
    await iterator.return()
  }
})

test('malformed refresh rows are ignored whole: no events and no retained update', async () => {
  const badRows = [
    ['an empty object', {}],
    ['null', null],
    ['an empty sessionId', session('', 300)],
    ['a non-string sessionId', session(42, 300)],
    ['a malformed projection', session('fresh', 300, { projections: { kind: 'sequenced', values: {} } })],
  ]
  for (const [label, badRow] of badRows) {
    let rows = [session('sb1', 200)]
    const hostB = createFakeRemote('hostB', 'Host B', { replies: { get 'session/list'() { return { items: rows } } } })
    const pushed = attachPusher(hostB)
    const harness = createHarness({ remotes: [hostB] })
    const listed = await harness.gateway.dispatchRpc('session/list', { args: {} }, undefined, {})
    assert.deepEqual(listed.value.items.map((row) => row.sessionId), ['h:hostB:sb1'], `${label}: baseline`)
    rows = [session('sb1', 200), badRow]
    const { control, iterator } = await openEventsStream(harness)
    try {
      pushed.emit('sessionStatus', { kind: 'session-status', sessionId: 'fresh', running: true })
      assert.deepEqual((await nextFrame(iterator, `${label}: first status`)).value,
        { type: 'emit', event: 'api-session/status', args: ['h:hostB:fresh', true] })
      await waitUntil(() => harness.logs.some((line) => line.includes('malformed-session-row')),
        `${label}: the malformed batch log`)
      const log = harness.logs.find((line) => line.includes('malformed-session-row'))
      assert.equal(/h:hostB:|\bfresh\b/.test(log), false, `${label}: the log names no session id`)
      const emitted = []
      for (let i = 0; i < 3; i += 1) {
        const frame = await quietFrame(iterator, 80)
        if (typeof frame?.value?.event === 'string' && frame.value.event.startsWith('api-session/')) emitted.push(frame.value)
      }
      assert.deepEqual(emitted, [], `${label}: no added/removed/status frame`)
      harness.disconnect('hostB')
      const retained = await harness.gateway.dispatchRpc('session/list', { args: {} }, undefined, {})
      assert.deepEqual(retained.value.items.map((row) => row.sessionId), ['h:hostB:sb1'],
        `${label}: retained rows were left untouched`)
      harness.router.uninstall()
    } finally {
      control.abort()
      await iterator.return()
    }
  }
})

// -- approvals -------------------------------------------------------------

test('a remote $events/result carries the argsHash of the Host card and the right ids', async () => {
  const hostB = createFakeRemote('hostB', 'Host B', { replies: { '$events/result': { accepted: true } } })
  const harness = createHarness({ remotes: [hostB] })
  const card = { rpcId: 'rpc-1', sessionId: 's1', approvalId: 'a1', argsHash: 'a'.repeat(64), toolName: 'bash' }
  harness.cards.set('hostB|rpc-1', card)

  const answer = await harness.gateway.dispatchRpc('$events/result', {
    args: { clientId: 'c1', eventId: 'h:hostB:rpc-1', outcome: { kind: 'result', value: 'allowed-once' } },
  }, undefined, {})
  assert.equal(answer.ok, true)
  assert.deepEqual(answer.value, { accepted: true })
  assert.equal(hostB.calls.length, 1)
  assert.deepEqual(hostB.calls[0].args, {
    clientId: 'c1',
    eventId: 'rpc-1',
    outcome: { kind: 'result', value: 'allowed-once' },
    argsHash: card.argsHash,
    rpcId: 'rpc-1',
    approvalId: 'a1',
    sessionId: 's1',
  })
  assertNoNamespacedId(hostB)
})

test('a remote decision the UI cannot bind is refused, not forwarded', async () => {
  const hostB = createFakeRemote('hostB', 'Host B')
  const harness = createHarness({ remotes: [hostB] })
  const answer = await harness.gateway.dispatchRpc('$events/result', {
    args: { clientId: 'c1', eventId: 'h:hostB:rpc-1', outcome: { kind: 'result', value: 'rejected' } },
  }, undefined, {})
  assert.equal(answer.ok, false)
  assert.equal(answer.error.code, 'remote/approval-unbound')
  assert.equal(hostB.calls.length, 0)
})

test('an argsHash already in the payload is kept verbatim', async () => {
  const hostB = createFakeRemote('hostB', 'Host B', { replies: { '$events/result': { accepted: true } } })
  const harness = createHarness({ remotes: [hostB] })
  const argsHash = 'b'.repeat(64)
  await harness.gateway.dispatchRpc('$events/result', {
    args: { sessionId: 'h:hostB:s1', rpcId: 'h:hostB:rpc-9', approvalId: 'h:hostB:a9', argsHash, outcome: 'allowed-once' },
  }, undefined, {})
  assert.deepEqual(hostB.calls[0].args, { sessionId: 's1', rpcId: 'rpc-9', approvalId: 'a9', argsHash, outcome: 'allowed-once' })
  assertNoNamespacedId(hostB)
})

// -- merge: workspace/follow ----------------------------------------------

test('workspace/follow merges Local plus each host: baseline, renamed upsert, reconnect replace', async () => {
  const hostB = createFakeRemote('hostB', 'Host B', {
    workspaces: [workspaceView('wb1', ['sb1'])], archived: ['sb9'], pinned: ['sb1'],
  })
  const hostC = createFakeRemote('hostC', 'Host C', {
    workspaces: [workspaceView('wc1', ['sc1'])], archived: ['sc9'],
  })
  const harness = createHarness({
    remotes: [hostB, hostC],
    baseline: { items: [workspaceView('w1', ['s1'])], archivedSessionIds: ['s9'], pinnedSessionIds: [] },
  })
  const control = new AbortController()
  const source = await harness.gateway.openWireStream('workspace/follow', { args: {} }, undefined, {}, control.signal, control, 64)
  const iterator = source[Symbol.asyncIterator]()

  const first = await nextFrame(iterator, 'merged baseline')
  assert.equal(first.value.type, 'baseline')
  assert.deepEqual(first.value.value.items.map((item) => item.workspaceId), ['w1', 'h:hostB:wb1', 'h:hostC:wc1'])
  // The extra host fields are additive (`additionalProperties` is allowed); the
  // path of a remote workspace stays host-side text. The title carries the host
  // name so the native sidebar says which Host owns the row.
  assert.deepEqual(first.value.value.items[1], {
    workspaceId: 'h:hostB:wb1', path: '/tmp/wb1', title: 'wb1 · Host B', sessionIds: ['h:hostB:sb1'],
    createdAt: '2026-11-09T00:00:00.000Z', updatedAt: '2026-11-09T00:00:00.000Z',
    hostId: 'hostB', hostName: 'Host B',
  })
  assert.deepEqual(first.value.value.archivedSessionIds, ['s9', 'h:hostB:sb9', 'h:hostC:sc9'], 'archived is a union')
  assert.deepEqual(first.value.value.pinnedSessionIds, ['h:hostB:sb1'], 'pinned is a union')
  assert.equal(first.value.value.items[0].title, 'w1', 'a Local workspace title is untouched: only a remote row is labelled')

  hostB.send({ type: 'upsert', workspace: workspaceView('wb2', ['sb2']) })
  const upsert = await nextFrame(iterator, 'upsert')
  assert.deepEqual(upsert.value, {
    type: 'upsert',
    workspace: {
      workspaceId: 'h:hostB:wb2', path: '/tmp/wb2', title: 'wb2 · Host B', sessionIds: ['h:hostB:sb2'],
      createdAt: '2026-11-09T00:00:00.000Z', updatedAt: '2026-11-09T00:00:00.000Z',
      hostId: 'hostB', hostName: 'Host B',
    },
  })

  hostB.send({ type: 'archived', archivedSessionIds: ['sb1'] })
  const archived = await nextFrame(iterator, 'archived')
  assert.deepEqual(archived.value, { type: 'archived', archivedSessionIds: ['s9', 'h:hostB:sb1', 'h:hostC:sc9'] })

  hostB.send({ type: 'remove', workspaceId: 'wb1' })
  const removed = await nextFrame(iterator, 'remove')
  assert.deepEqual(removed.value, { type: 'remove', workspaceId: 'h:hostB:wb1' })

  // Disconnect: the host's workspaces leave the merged state and the UI is told
  // to republish everything (a `replace`, not a silent drop).
  harness.disconnect('hostC')
  const dropped = await nextFrame(iterator, 'replace after disconnect')
  assert.equal(dropped.value.type, 'replace')
  assert.deepEqual(dropped.value.value.items.map((item) => item.workspaceId), ['w1', 'h:hostB:wb2'])
  assert.deepEqual(dropped.value.value.archivedSessionIds, ['s9', 'h:hostB:sb1'])

  // Reconnect: the host's baseline comes back and the merged state is republished.
  harness.connect('hostC')
  const refreshed = await nextFrame(iterator, 'replace after reconnect')
  assert.equal(refreshed.value.type, 'replace')
  assert.deepEqual(refreshed.value.value.items.map((item) => item.workspaceId), ['w1', 'h:hostB:wb2', 'h:hostC:wc1'])
  hostC.send({ type: 'upsert', workspace: workspaceView('wc2', ['sc2']) })
  const reupsert = await nextFrame(iterator, 'upsert after reconnect')
  assert.deepEqual(reupsert.value, {
    type: 'upsert',
    workspace: {
      workspaceId: 'h:hostC:wc2', path: '/tmp/wc2', title: 'wc2 · Host C', sessionIds: ['h:hostC:sc2'],
      createdAt: '2026-11-09T00:00:00.000Z', updatedAt: '2026-11-09T00:00:00.000Z',
      hostId: 'hostC', hostName: 'Host C',
    },
  })

  control.abort()
  await iterator.return()
  assertNoNamespacedId(hostB)
  assertNoNamespacedId(hostC)
})

// Owner defect (owner 2026-11-16, zero PAIRED hosts): "New chat → choose workspace" came back
// as "Choose workspace". With nothing paired the wrapper had no host to route, rename or hold
// back for, yet it still stood between the UI and Local: Local's re-baselined `replace` was
// swallowed, a Local frame type it did not model was dropped, and a `session/list` payload with
// no `args` was answered from `{args:{}}` in a rewritten envelope. These pin the zero-host
// carrier as the pure call it wraps — the SAME stream and the SAME reply Local gave — and pin
// that one paired host still gets the merge.
const WORKSPACE_ID = 'ea6ef60e-f343-4517-a00b-7b9a1cbc879a'
const firstName = (value) => value.items.map((item) => item.workspaceId)

/** Read the frame the stream delivers next, or `null` when it delivers none within `ms`. */
async function frameWithin(iterator, ms = 50) {
  let timer
  const timeout = new Promise((resolve) => { timer = setTimeout(() => resolve('timeout'), ms); timer.unref?.() })
  const result = await Promise.race([iterator.next(), timeout])
  clearTimeout(timer)
  return result === 'timeout' ? null : result
}

test('zero hosts: workspace/follow is Local\'s own stream — baseline, upsert, replace, order, unknown type, in order', async () => {
  // Zero PAIRED hosts, the production shape (`knownHosts` is supplied and empty): the carrier
  // is the pure Local call it wrapped.
  const harness = createHarness({ remotes: [] })
  const control = new AbortController()
  const payload = { args: {} }
  const source = await harness.gateway.openWireStream('workspace/follow', payload, undefined, {}, control.signal, control, 64)
  const local = harness.localStreams.at(-1)
  assert.equal(local.payloadSeen, payload, 'the payload reaches Local as the caller own object')
  assert.equal(source, local.queue, 'Local own stream is handed back, not a merged one')
  const iterator = source[Symbol.asyncIterator]()
  // The harness Local carrier has already put its opening baseline on the stream: a
  // passthrough forwards it as it is, never a merged re-baseline.
  const opening = await nextFrame(iterator, 'local baseline')
  assert.equal(opening.value.type, 'baseline', 'Local baseline is the first frame')

  // Every shape the merge rewrote, swallowed or never modelled: an upsert, Local re-baselined
  // `replace`, a reorder, and a frame type this router has never been taught. Each must arrive
  // exactly once, in order, byte-identical.
  const frames = [
    { type: 'upsert', workspace: workspaceView(WORKSPACE_ID, ['s1', 's2']) },
    { type: 'replace', value: { items: [workspaceView(WORKSPACE_ID, ['s1', 's2'])], archivedSessionIds: [], pinnedSessionIds: ['s2'] } },
    { type: 'order', workspaceIds: [WORKSPACE_ID] },
    { type: 'workspace/unknown-to-this-router', workspaceId: WORKSPACE_ID },
  ]
  for (const frame of frames) local.queue.push(frame)
  for (const frame of frames) {
    const next = await nextFrame(iterator, frame.type)
    assert.equal(next.done, false)
    assert.equal(JSON.stringify(next.value), JSON.stringify(frame), frame.type + ' is forwarded byte-identically, in order')
  }
  assert.equal(await frameWithin(iterator), null, 'nothing else is delivered, nothing is invented')
  control.abort()
  await iterator.return()
})

test('zero hosts: session/list returns Local reply as it is, an empty-args payload included', async () => {
  const harness = createHarness({ remotes: [] })
  // The exact shape that used to come back rewritten: the payload carries no `args`, and the
  // merge answered Local with `{args:{}}` and wrapped the reply.
  const payloads = [{}, { args: {} }, { args: { cursor: 'page-2' } }]
  for (const payload of payloads) {
    const answer = await harness.gateway.dispatchRpc('session/list', payload, undefined, {})
    assert.equal(harness.localCalls.at(-1).payloadSeen, payload,
      JSON.stringify(payload) + ': Local receives the caller own payload, never an `{args:{}}` rewrite')
    assert.deepEqual(answer, { ok: true, value: { local: 'session/list' } },
      JSON.stringify(payload) + ': the reply is Local, unwrapped')
  }
})

test('zero hosts: a tagged id or a host hint still reaches the routing, which refuses it', async () => {
  // Passthrough is for calls that name NO host. One that names a host this controller does
  // not have keeps its clear refusal instead of being answered by Local.
  const harness = createHarness({ remotes: [] })
  const tagged = await harness.gateway.dispatchRpc('session/prompt', { args: { sessionId: 'h:hostB:s1' } }, undefined, {})
  assert.equal(tagged.ok, false)
  assert.equal(tagged.error.code, 'remote/host-offline')
  const hinted = await harness.gateway.dispatchRpc('llm/list', { args: { [HOST_HINT]: 'hostB' } }, undefined, {})
  assert.equal(hinted.ok, false)
  assert.equal(hinted.error.code, 'remote/host-offline')
  assert.deepEqual(harness.localCalls, [], 'Local was never asked')
})

test('one PAIRED host (offline) is not a passthrough: the same calls merge and keep its rows', async () => {
  // The switch is "no host at all", not "no connected host": a paired-but-offline host has
  // retained rows the merged list must carry. `createHarness` pairs exactly the remotes it is
  // given, and `disconnect` takes one offline without forgetting it.
  const hostB = createFakeRemote('hostB', 'Host B', { replies: { 'session/list': { items: [session('sb1', 200)] } } })
  const harness = createHarness({ remotes: [hostB] })
  // First with the link up, so the host lists its row and the controller retains it.
  const payload = { args: {} }
  const listed = await harness.gateway.dispatchRpc('session/list', payload, undefined, {})
  assert.deepEqual(listed.value.items.map((row) => row.sessionId), ['h:hostB:sb1'])
  harness.disconnect('hostB')
  assert.equal(harness.router.status().disconnected.length, 1, 'the host is still paired')
  const answer = await harness.gateway.dispatchRpc('session/list', { args: {} }, undefined, {})
  assert.deepEqual(answer.value.items.map((row) => row.sessionId), ['h:hostB:sb1'],
    'the offline host\'s retained rows are still merged in — a passthrough would answer Local only')
  const control = new AbortController()
  const source = await harness.gateway.openWireStream('workspace/follow', { args: {} }, undefined, {}, control.signal, control, 64)
  const iterator = source[Symbol.asyncIterator]()
  const first = await nextFrame(iterator, 'merged baseline')
  assert.equal(first.value.type, 'baseline', 'a paired host keeps the merged follow stream')
  control.abort()
  await iterator.return()
  harness.router.uninstall()
})

test('with a remote: the local replace reaches the UI as the merged state, host rows included, after the remote baseline', async () => {
  // Order, end to end: the merged baseline (Local + the remote, renamed), the remote's
  // baseline re-baselined as a `replace`, then Local's `replace` — which must carry the
  // remote's rows too, because the UI applies it whole.
  const hostB = createFakeRemote('hostB', 'Host B', { workspaces: [workspaceView('wb1', ['sb1'])] })
  const harness = createHarness({ remotes: [hostB], baseline: { items: [], archivedSessionIds: [], pinnedSessionIds: [] } })
  const control = new AbortController()
  const source = await harness.gateway.openWireStream('workspace/follow', { args: {} }, undefined, {}, control.signal, control, 64)
  const iterator = source[Symbol.asyncIterator]()
  const first = await nextFrame(iterator, 'merged baseline')
  assert.equal(first.value.type, 'baseline')
  // Frames are `{type, value}` envelopes; a baseline's `value` is the merged picture, not a
  // row list, so `firstName` takes it.
  assert.deepEqual(firstName(first.value.value), ['h:hostB:wb1'], 'the remote row is in the opening baseline')
  // The merge publishes its opening baseline as soon as ONE side has re-baselined it (Local's
  // own baseline, or a host's when Local's has not arrived yet), and the host side always
  // re-publishes when it folds in. So here Local re-baselines next: its picture is empty.
  harness.localStreams.at(-1).queue.push({ type: 'baseline', value: { items: [], archivedSessionIds: [], pinnedSessionIds: [] } })
  const rehosted = await nextFrame(iterator, 'the local baseline folded in')
  assert.equal(rehosted.value.type, 'replace', 'a re-baseline after ready re-publishes the merged state')
  assert.deepEqual(firstName(rehosted.value.value), ['h:hostB:wb1'])

  const pick = { items: [workspaceView(WORKSPACE_ID, ['s1'])], archivedSessionIds: [], pinnedSessionIds: [] }
  harness.localStreams.at(-1).queue.push({ type: 'replace', value: pick })
  const emitted = await nextFrame(iterator, 'the local replace')
  assert.equal(emitted.value.type, 'replace')
  assert.deepEqual(firstName(emitted.value.value), [WORKSPACE_ID, 'h:hostB:wb1'], 'Local first, then the host')
  assert.deepEqual(emitted.value.value.items[0], pick.items[0], 'the Local Workspace keeps its own id and sessionIds')
  assert.equal(emitted.value.value.items[1].hostId, 'hostB', 'the remote row stays marked for its host')
  assert.deepEqual(emitted.value.value.items[1].sessionIds, ['h:hostB:sb1'])
  assert.equal(await frameWithin(iterator), null, 'one replace, not a second frame')
  control.abort()
  await iterator.return()
  // A previous test's router may still be wrapped underneath this one (the suite runs
  // in one process); tearing this harness down restores the carrier it installed.
  harness.router.uninstall()
  assertNoNamespacedId(hostB)
})

test('a merged remote workspace title carries its host name, and the default sentinel stays readable', async () => {
  // The native sidebar renders merged rows as they arrive (no replacement browser),
  // so the host name has to ride on the title. `default-workspace` is the one title
  // the native client localizes, and only the EXACT string: suffixed, it would show
  // up verbatim on the row, so it reads as a plain word instead.
  const hostB = createFakeRemote('hostB', 'Host B', {
    workspaces: [workspaceView('wb1', ['sb1'], { title: 'REA_Project' }), workspaceView('wb2', [], { title: 'default-workspace' })],
  })
  const harness = createHarness({ remotes: [hostB] })
  const control = new AbortController()
  const source = await harness.gateway.openWireStream('workspace/follow', { args: {} }, undefined, {}, control.signal, control, 64)
  const iterator = source[Symbol.asyncIterator]()
  const first = await nextFrame(iterator, 'merged baseline')
  assert.deepEqual(first.value.value.items.map((item) => item.title), ['REA_Project · Host B', 'Default · Host B'])

  // A later upsert takes the same road: the Host renames its own workspace and the
  // controller's row follows, still naming the host.
  hostB.send({ type: 'upsert', workspace: workspaceView('wb2', [], { title: 'scripts' }) })
  const upsert = await nextFrame(iterator, 'renamed upsert')
  assert.equal(upsert.value.workspace.title, 'scripts · Host B')

  control.abort()
  await iterator.return()
})

test('workspace/rename strips the display suffix: the remote Host keeps its own title', async () => {
  // `workspace/rename` takes exactly {workspaceId, title}, and the native dialog
  // starts from the title it shows — so a partly edited draft still ends with the
  // suffix. It must not travel: the Host would store another host's name.
  const hostB = createFakeRemote('hostB', 'Host B', { replies: { 'workspace/rename': { workspaceId: 'wb1', title: 'REA_Project' } } })
  const harness = createHarness({ remotes: [hostB] })
  await harness.gateway.dispatchRpc('workspace/rename', { args: { workspaceId: 'h:hostB:wb1', title: 'REA_Project · Host B' } }, undefined, {})
  assert.equal(hostB.calls[0].endpoint, 'workspace/rename')
  assert.deepEqual(hostB.calls[0].args, { workspaceId: 'wb1', title: 'REA_Project' }, 'the tag and the suffix both stay home')
  // Only THIS host's exact suffix is ours; any other title passes through untouched.
  await harness.gateway.dispatchRpc('workspace/rename', { args: { workspaceId: 'h:hostB:wb1', title: 'Notes · Draft' } }, undefined, {})
  assert.deepEqual(hostB.calls[1].args, { workspaceId: 'wb1', title: 'Notes · Draft' })
  await harness.gateway.dispatchRpc('workspace/rename', { args: { workspaceId: 'h:hostB:wb1', title: 'REA_Project · Host C' } }, undefined, {})
  assert.deepEqual(hostB.calls[2].args, { workspaceId: 'wb1', title: 'REA_Project · Host C' })
  assertNoNamespacedId(hostB)
})

// -- reorder (workspace/insertBefore, workspace/insertSessionBefore) -------

/** A remote Host that keeps a real durable order, like dsh-workspace's registry. */
function createOrderedRemote(hostId, hostName, order) {
  const runtime = {
    order: [...order],
    async call(endpoint, args) {
      if (endpoint !== 'workspace/insertBefore') return { ok: true, workspace: { workspaceId: args.workspaceId } }
      // The registry's own semantics: an unknown mover or anchor is not-found, and
      // without an anchor the row appends (dsh-workspace `insertBefore`).
      if (!runtime.order.includes(args.workspaceId)) {
        return { ok: false, error: { code: 'workspace/not-found', message: `unknown workspace '${args.workspaceId}'` } }
      }
      if (args.beforeWorkspaceId !== undefined && !runtime.order.includes(args.beforeWorkspaceId)) {
        return { ok: false, error: { code: 'workspace/not-found', message: `unknown workspace '${args.beforeWorkspaceId}'` } }
      }
      const without = runtime.order.filter((id) => id !== args.workspaceId)
      const at = args.beforeWorkspaceId === undefined ? without.length : without.indexOf(args.beforeWorkspaceId)
      runtime.order = [...without.slice(0, at), args.workspaceId, ...without.slice(at)]
      return { ok: true, workspaceIds: [...runtime.order] }
    },
  }
  const remote = createFakeRemote(hostId, hostName)
  remote.connection.call = async (endpoint, args, options) => {
    remote.calls.push({ endpoint, args: clone(args), options })
    return runtime.call(endpoint, args)
  }
  return { remote, runtime }
}

test('a reorder of a remote Workspace reaches its Host untagged, anchor included', async () => {
  // Measured live before this test: the merged sidebar produces the anchor from the
  // row the user dropped on (`h:hostB:wb2`), and the rename table did not cover
  // `beforeWorkspaceId`, so the Host was asked to place `wb1` before a workspace
  // named `h:hostB:wb2` and answered `workspace/not-found`. The drag did nothing.
  const { remote: hostB, runtime } = createOrderedRemote('hostB', 'Host B', ['wb1', 'wb2'])
  const harness = createHarness({ remotes: [hostB] })
  // Drag the SECOND row above the first: `wb1` was already before `wb2`, and the
  // registry treats that as a no-op (it would mask the bug this test pins).
  const answer = await harness.gateway.dispatchRpc('workspace/insertBefore',
    { args: { workspaceId: 'h:hostB:wb2', beforeWorkspaceId: 'h:hostB:wb1' } }, undefined, {})

  assert.deepEqual(hostB.calls[0].args, { workspaceId: 'wb2', beforeWorkspaceId: 'wb1' }, 'both ids are the Host\'s own')
  assert.deepEqual(runtime.order, ['wb2', 'wb1'], 'the Host actually reordered')
  // What comes back is a local id list, so the native sidebar can rank its rows.
  assert.deepEqual(answer, { ok: true, value: { ok: true, workspaceIds: ['h:hostB:wb2', 'h:hostB:wb1'] } })
  assertNoNamespacedId(hostB)
})

test('a reorder of a remote session within its Workspace strips beforeSessionId too', async () => {
  const hostB = createFakeRemote('hostB', 'Host B', {
    replies: { 'workspace/insertSessionBefore': { workspace: workspaceView('wb1', ['sb2', 'sb1']) } },
  })
  const harness = createHarness({ remotes: [hostB] })
  const answer = await harness.gateway.dispatchRpc('workspace/insertSessionBefore',
    { args: { workspaceId: 'h:hostB:wb1', sessionId: 'h:hostB:sb1', beforeSessionId: 'h:hostB:sb2' } }, undefined, {})

  assert.deepEqual(hostB.calls[0].args, { workspaceId: 'wb1', sessionId: 'sb1', beforeSessionId: 'sb2' })
  // The reply is a Workspace projection: its `sessionIds` come back in the host's
  // namespace, including the two rows the reorder just swapped.
  assert.deepEqual(answer.value.workspace.sessionIds, ['h:hostB:sb2', 'h:hostB:sb1'])
  assertNoNamespacedId(hostB)
})

test('a reorder with no anchor appends within the mover\'s own list', async () => {
  const { remote: hostB, runtime } = createOrderedRemote('hostB', 'Host B', ['wb1', 'wb2'])
  const harness = createHarness({ remotes: [hostB] })
  const answer = await harness.gateway.dispatchRpc('workspace/insertBefore',
    { args: { workspaceId: 'h:hostB:wb1' } }, undefined, {})
  assert.deepEqual(hostB.calls[0].args, { workspaceId: 'wb1' }, 'no anchor is invented')
  assert.deepEqual(runtime.order, ['wb2', 'wb1'])
  assert.deepEqual(answer.value.workspaceIds, ['h:hostB:wb2', 'h:hostB:wb1'])
})

test('a reorder that crosses lists is refused, and reaches no Host and no Local carrier', async () => {
  // The merged sidebar draws Local and every remote Workspace as ONE list, so a drag
  // can land a row of one list beside a row of another. No Host stores another
  // list's order, so this is refused rather than forwarded: a tag naming someone
  // else's namespace must never travel, and Local must not be asked to place a
  // foreign row either.
  const hostB = createFakeRemote('hostB', 'Host B')
  const hostC = createFakeRemote('hostC', 'Host C')
  const harness = createHarness({ remotes: [hostB, hostC] })

  const cases = [
    { args: { workspaceId: 'w1', beforeWorkspaceId: 'h:hostB:wb2' }, movedHost: null, anchorHost: 'hostB' },
    { args: { workspaceId: 'h:hostB:wb1', beforeWorkspaceId: 'w1' }, movedHost: 'hostB', anchorHost: null },
    { args: { workspaceId: 'h:hostB:wb1', beforeWorkspaceId: 'h:hostC:wc1' }, movedHost: 'hostB', anchorHost: 'hostC' },
  ]
  for (const { args, movedHost, anchorHost } of cases) {
    const answer = await harness.gateway.dispatchRpc('workspace/insertBefore', { args }, undefined, {})
    assert.equal(answer.ok, false, `${JSON.stringify(args)} must be refused`)
    assert.equal(answer.error.code, 'remote/reorder-cross-host')
    assert.deepEqual({ movedHost: answer.error.details.movedHost, anchorHost: answer.error.details.anchorHost },
      { movedHost, anchorHost })
    // The refusal names lists, never a raw id or a namespace tag.
    assert.equal(/h:[A-Za-z0-9._-]+:/.test(answer.error.message), false)
  }
  assert.deepEqual([...hostB.calls, ...hostC.calls], [], 'no remote Host was asked')
  assert.deepEqual(harness.localCalls, [], 'the Local carrier was not asked either')
})

test('a Local reorder stays Local, anchor included, and is never renamed', async () => {
  const hostB = createFakeRemote('hostB', 'Host B')
  const harness = createHarness({ remotes: [hostB] })
  await harness.gateway.dispatchRpc('workspace/insertBefore',
    { args: { workspaceId: 'w1', beforeWorkspaceId: 'w2' } }, undefined, {})
  assert.deepEqual(harness.localCalls.at(-1).payload.args, { workspaceId: 'w1', beforeWorkspaceId: 'w2' })
  assert.deepEqual(hostB.calls, [], 'a Local reorder asks no remote')
})

test('a reorder survives as the merged `order` frame, and each list keeps its own order', async () => {
  // The durable order of a Host is republished as a `workspace/follow` `order`
  // increment (dsh-api-workspace-controller `feed.changed`). That is the frame the
  // sidebar ranks rows by, so a reorder is only real if it comes back through it —
  // and a remote `order` may only ever reseat the rows of its OWN list.
  const hostB = createFakeRemote('hostB', 'Host B', { workspaces: [workspaceView('wb1', ['sb1']), workspaceView('wb2', ['sb2'])] })
  const harness = createHarness({
    remotes: [hostB],
    baseline: { items: [workspaceView('w1', ['s1']), workspaceView('w2', ['s2'])], archivedSessionIds: [], pinnedSessionIds: [] },
  })
  const control = new AbortController()
  const source = await harness.gateway.openWireStream('workspace/follow', { args: {} }, undefined, {}, control.signal, control, 64)
  const iterator = source[Symbol.asyncIterator]()
  const first = await nextFrame(iterator, 'merged baseline')
  assert.deepEqual(first.value.value.items.map((item) => item.workspaceId), ['w1', 'w2', 'h:hostB:wb1', 'h:hostB:wb2'])

  // The Host committed `wb2, wb1` (the reorder above): it pushes the whole order.
  hostB.send({ type: 'order', workspaceIds: ['wb2', 'wb1'] })
  const reordered = await nextFrame(iterator, 'order')
  assert.deepEqual(reordered.value, {
    // Local first, untouched, then that host's rows in ITS new order.
    type: 'order', workspaceIds: ['w1', 'w2', 'h:hostB:wb2', 'h:hostB:wb1'],
  })
  // A raw remote order must never reach the UI untagged: the ids are the aliases.
  assert.equal(JSON.stringify(reordered.value).includes('"wb1"'), false)

  // Reconnect: the host's baseline comes back and the order is republished from it,
  // so a refresh does not undo the move.
  harness.disconnect('hostB')
  const dropped = await nextFrame(iterator, 'replace after disconnect')
  assert.deepEqual(dropped.value.value.items.map((item) => item.workspaceId), ['w1', 'w2'])
  harness.connect('hostB')
  const back = await nextFrame(iterator, 'replace after reconnect')
  assert.deepEqual(back.value.value.items.map((item) => item.workspaceId), ['w1', 'w2', 'h:hostB:wb1', 'h:hostB:wb2'],
    'the Host resends its own durable order; nothing here invents one')

  // A Local reorder reseats only Local rows: the remote rows keep their places.
  hostB.send({ type: 'order', workspaceIds: ['wb1', 'wb2'] })
  const awaiting = nextFrame(iterator, 'order before local move')
  await awaiting
  const localSource = harness.localStreams.at(-1)
  localSource.queue.push({ type: 'order', workspaceIds: ['w2', 'w1'] })
  const localMove = await nextFrame(iterator, 'local order')
  assert.deepEqual(localMove.value, { type: 'order', workspaceIds: ['w2', 'w1', 'h:hostB:wb1', 'h:hostB:wb2'] })

  control.abort()
  await iterator.return()
  assertNoNamespacedId(hostB)
})

test('a remote `order` frame that names a host namespace is refused, not merged', async () => {
  // The order frame is a list of ids like any other, so the same rule applies: a
  // Host may not name another controller's namespace, and it may not pretend a row
  // is Local by sending an untagged-but-already-tagged id.
  const hostB = createFakeRemote('hostB', 'Host B', { workspaces: [workspaceView('wb1', ['sb1'])] })
  const harness = createHarness({ remotes: [hostB] })
  const control = new AbortController()
  const source = await harness.gateway.openWireStream('workspace/follow', { args: {} }, undefined, {}, control.signal, control, 64)
  const iterator = source[Symbol.asyncIterator]()
  await nextFrame(iterator, 'merged baseline')

  hostB.send({ type: 'order', workspaceIds: ['h:hostC:wc1'] })
  // The hostile frame drops that host's merged rows rather than reseating them.
  const after = await nextFrame(iterator, 'replace after refusal')
  assert.equal(after.value.type, 'replace')
  assert.deepEqual(after.value.value.items, [], 'nothing of the refused host survives')
  assert.ok(harness.logs.some((line) => line.includes('remote/id-leak')), JSON.stringify(harness.logs))

  control.abort()
  await iterator.return()
})

// -- merge: session/list ---------------------------------------------------

test('session/list concatenates Local and every host, newest activity first', async () => {
  const hostB = createFakeRemote('hostB', 'Host B', { replies: { 'session/list': { items: [session('sb1', 200)] } } })
  const hostC = createFakeRemote('hostC', 'Host C', { replies: { 'session/list': { items: [session('sc1', 400)] } } })
  const harness = createHarness({
    remotes: [hostB, hostC],
    dispatchRpc: (endpoint) => (endpoint === 'session/list'
      ? { ok: true, value: { items: [session('s1', 100), session('s3', 300, { parentSessionId: 's1', projections: { kind: 'sequenced', asOfSeq: 2, values: { subagentCatalog: [{ id: 's3', mode: 'one-shot' }] } } })] } }
      : { ok: true, value: {} }),
  })
  const answer = await harness.gateway.dispatchRpc('session/list', { args: { cursor: 'page-2', [HOST_HINT]: 'hostB' } }, undefined, {})
  assert.equal(answer.ok, true)
  assert.deepEqual(answer.value.items.map((item) => [item.sessionId, item.updatedAt]), [
    ['h:hostC:sc1', 400], ['s3', 300], ['h:hostB:sb1', 200], ['s1', 100],
  ])
  // Local entries keep their raw ids (including their own subagent ids), remote
  // subagent ids are renamed with the host's namespace.
  assert.deepEqual(answer.value.items[1].projections.values.subagentCatalog, [{ id: 's3', mode: 'one-shot' }])
  // The merged view is not paginated: the request cursor is not forwarded, and
  // the hint is stripped before any Host sees it.
  assert.deepEqual(hostB.calls[0].args, {})
  assert.deepEqual(hostC.calls[0].args, {})
  assert.equal(harness.localCalls[0].payload.args.cursor, undefined)
  assertNoNamespacedId(hostB)
})

test('a remote session row loses cwd, so the native "Show in folder" item stays disabled', async () => {
  // The reveal item is enabled by the row's `cwd` and hands that path to THIS
  // machine's file manager (`ctx.sessions.list.getSnapshot().byId[sessionId]?.cwd`
  // in dsh-client-ui-open-in-app), while a remote session's files live on the other
  // machine. The merged row therefore reports no working directory at all — spec
  // 012: Show in folder must never open a window for a remote session.
  const remoteCwd = 'C:\\Users\\remote\\REA_Project'
  const localCwd = 'C:\\Users\\me\\Documents\\DSH_Project'
  const hostB = createFakeRemote('hostB', 'Host B', { replies: { 'session/list': {
    items: [session('sb1', 200, { cwd: remoteCwd })],
  } } })
  const harness = createHarness({
    remotes: [hostB],
    dispatchRpc: (endpoint) => (endpoint === 'session/list'
      ? { ok: true, value: { items: [session('s1', 100, { cwd: localCwd })] } }
      : { ok: true, value: {} }),
  })
  const answer = await harness.gateway.dispatchRpc('session/list', { args: {} }, undefined, {})
  assert.equal(answer.ok, true)
  const byId = Object.fromEntries(answer.value.items.map((item) => [item.sessionId, item]))
  // The reveal precondition, exactly as the menu reads it.
  assert.equal(byId['h:hostB:sb1'].cwd, undefined, 'a remote session must not name a working directory')
  assert.equal(Object.hasOwn(byId['h:hostB:sb1'], 'cwd'), false, 'the key is omitted, not filled with our own path')
  assert.equal(byId.s1.cwd, localCwd, 'a Local row keeps its own working directory')
  // Only `cwd` was dropped: ids, activity, flags and projections survive.
  assert.deepEqual(byId['h:hostB:sb1'], session('h:hostB:sb1', 200))
  assert.deepEqual(answer.value.items.map((item) => item.sessionId), ['h:hostB:sb1', 's1'])
  harness.router.uninstall()
})

test('a host that refuses session/list is reported in status(); a later success clears it', async () => {
  // Measured end to end: a grant without `harness:remote` makes the Host refuse the
  // bridge call, the merged list keeps only Local rows, and the only symptom used to
  // be the log line. The refusal now rides `status().hosts[].error`, which the
  // Devices page shows on that host's row.
  const refusal = Object.assign(new Error('scope refused'), { code: 'auth/forbidden-scope', scope: 'harness:remote' })
  let reply = refusal
  const hostB = createFakeRemote('hostB', 'Host B', { replies: { get 'session/list'() { return reply } } })
  const harness = createHarness({ remotes: [hostB] })
  const answer = await harness.gateway.dispatchRpc('session/list', { args: {} }, undefined, {})
  assert.equal(answer.ok, true, 'a failing remote must not fail the merged list')
  const [host] = harness.router.status().hosts
  assert.equal(host.hostId, 'hostB')
  assert.equal(host.error.code, 'auth/forbidden-scope')
  assert.equal(host.error.scope, 'harness:remote')
  assert.ok(harness.logs.some((line) => line.includes('session/list from hostB failed: auth/forbidden-scope')),
    'the id-only log line stays the audit trail')
  // Re-paired with the scope: the next merged list carries the rows and no error.
  reply = { items: [session('sb1', 200)] }
  const healed = await harness.gateway.dispatchRpc('session/list', { args: {} }, undefined, {})
  assert.deepEqual(healed.value.items.map((item) => item.sessionId), ['h:hostB:sb1'])
  assert.deepEqual(harness.router.status().hosts, [{ hostId: 'hostB', hostName: 'Host B', online: true }],
    'a host that never refused a call carries no error field')
  harness.router.uninstall()
})

// -- merge: session/modelCatalog -------------------------------------------
//
// The native picker loads ONE catalog per Host generation (the endpoint takes no
// argument, so it cannot be scoped to a session) and decides whether the session's
// own selection is selectable by looking its provider/model up in that catalog —
// and it marks the current row the same way. The picker has no per-host slot (a
// group renders only `group.name`), so Local and each remote Host become separate
// SECTIONS: Local's groups keep their own ids and come first, a remote group is
// renamed `<provider>@<hostId>` and headed `Remote · <host> — <provider name>`,
// and a remote session's projected selection carries the same tagged provider.

const catalog = (groups, extra = {}) => ({
  default: { provider: 'deepseek-official', model: 'deepseek-chat' },
  routableProviders: groups.map((group) => group.id),
  groups,
  failures: [],
  ...extra,
})
const providerGroup = (id, name, models) => ({ id, name, models: models.map((model) => ({ id: model, name: model })) })
const localCatalog = (groups) => (endpoint) => (endpoint === 'session/modelCatalog'
  ? { ok: true, value: catalog(groups) }
  : { ok: true, value: {} })
/** The selection a remote Host projects for a session (`{lastUsed, next}`). */
const selection = (provider, model) => ({ provider, model })
const projectedSelection = (provider, model, asOfSeq = 7) => ({
  kind: 'sequenced',
  asOfSeq,
  values: { modelSelection: { lastUsed: selection(provider, model), next: selection(provider, model) } },
})
/** DSH's snapshot-stream rule, applied to the frames this test reads from `session/control`. */
const createControlProtocolReader = () => {
  let baselineSeen = false
  return async (iterator, label = 'control frame') => {
    const frame = (await nextFrame(iterator, label)).value
    if (frame.type === 'baseline') {
      assert.equal(baselineSeen, false, `${label}: a second opening baseline ends the stream`)
      baselineSeen = true
    } else {
      assert.equal(baselineSeen, true, `${label}: an update arrived before the opening baseline`)
    }
    return frame
  }
}

// Native admission, mirrored from the INSTALLED rc.1 sources (not invented here):
// `SessionSeq` (dsh-session/lib/types/types.js:15-19) throws for a negative or
// unsafe integer; `sessionSeqCursor` (dsh-api-session-controller's manager)
// admits -1 ONLY for a baseline cursor; `handleControlFrame` admits projection
// frames with SessionSeq(seq) and seeds baselines through ProjectionValueStore
// (projection-store.js seed/apply: seed clears keys the cut omits, apply never).
const admitSessionSeq = (value, label) => {
  if (!Number.isSafeInteger(value) || value < 0 || Object.is(value, -0)) {
    throw new TypeError(`${label}: SessionSeq must be a non-negative safe integer, got ${String(value)}`)
  }
  return value
}
const admitBaselineCursor = (value, label) => value === -1 ? -1 : admitSessionSeq(value, label)
const createNativeProjectionStore = () => {
  const rows = new Map()
  return {
    seed(block) {
      const seq = admitBaselineCursor(block.asOfSeq, 'baseline cursor')
      for (const key of Object.keys(block.values)) {
        if ((rows.get(key)?.seq ?? -Infinity) < seq) rows.set(key, { value: block.values[key], seq })
      }
      for (const [key, row] of [...rows]) {
        if (Object.hasOwn(block.values, key) || row.seq > seq) continue
        rows.delete(key)
      }
    },
    apply(key, value, seq) {
      admitSessionSeq(seq, 'projection seq')
      if ((rows.get(key)?.seq ?? -Infinity) < seq) rows.set(key, { value, seq })
    },
    get(key) { return rows.get(key)?.value },
    keys() { return [...rows.keys()] },
  }
}

test('session/modelCatalog keeps every host as its own section, tagged by host', async () => {
  const hostB = createFakeRemote('hostB', 'Host B', { replies: {
    'session/modelCatalog': catalog([
      // The SAME provider id Local lists. It is kept and tagged: a remote model
      // must never sit under an id that routes to this Host, and the picker tells
      // the two sections apart by that id (`current.provider === group.id`).
      providerGroup('deepseek-official', 'DeepSeek', ['deepseek-chat', 'deepseek-reasoner']),
      // A provider only this Host offers.
      providerGroup('r9-fallback', 'R9 Fallback', ['ds41-cmc-ccsonnet']),
    ]),
  } })
  const hostC = createFakeRemote('hostC', 'Host C', { replies: {
    'session/modelCatalog': Object.assign(new Error('no catalog'), { code: 'auth/forbidden-scope', scope: 'prompt:send' }),
  } })
  const harness = createHarness({
    remotes: [hostB, hostC],
    dispatchRpc: localCatalog([providerGroup('deepseek-official', 'DeepSeek', ['deepseek-chat'])]),
  })
  const answer = await harness.gateway.dispatchRpc('session/modelCatalog', { args: {} }, undefined, {})
  assert.equal(answer.ok, true, JSON.stringify(answer))
  const value = answer.value
  // Local keeps its own default and failures: the picker falls back to
  // `catalog.default` for a session with no recorded selection, so it must stay a
  // Local provider — a tagged one there would be a remote pick for every session.
  assert.deepEqual(value.default, { provider: 'deepseek-official', model: 'deepseek-chat' })
  assert.deepEqual(value.failures, [], 'a host failure is not mixed into the Local failures')
  assert.deepEqual(value.groups.map((group) => [group.id, group.name, group.models.map((model) => model.id)]), [
    ['deepseek-official', 'DeepSeek', ['deepseek-chat']],
    ['deepseek-official@hostB', 'Remote · Host B — DeepSeek', ['deepseek-chat', 'deepseek-reasoner']],
    ['r9-fallback@hostB', 'Remote · Host B — R9 Fallback', ['ds41-cmc-ccsonnet']],
  ], 'Local first and untouched, then one section per host')
  assert.deepEqual(value.routableProviders,
    ['deepseek-official', 'deepseek-official@hostB', 'r9-fallback@hostB'],
    'routableProviders follows the merged groups (the Host derives it from them)')
  // The point of the merge: the selection a remote session projects arrives
  // tagged by ingress (see the projection tests below), and that is exactly the
  // picker's `routable` check + ✗/✓ mark. A remote model never merges under the
  // Local id, so a remote selection can never read as the Local current one.
  const routable = (provider, model) => value.groups.some((group) => group.id === provider
    && group.models.some((entry) => entry.id === model))
  assert.equal(routable('r9-fallback@hostB', 'ds41-cmc-ccsonnet'), true)
  assert.equal(routable('deepseek-official@hostB', 'deepseek-reasoner'), true)
  assert.equal(routable('deepseek-official@hostB', 'deepseek-chat'), true,
    'same provider id as Local, different section: both models are offered')
  assert.equal(routable('deepseek-official', 'deepseek-reasoner'), false,
    'a remote-only model is never reachable through the Local provider id')
  // The reasoning table is keyed [group.id, model.id] — the tagged id is the key.
  assert.deepEqual(value.groups[2].models, [{ id: 'ds41-cmc-ccsonnet', name: 'ds41-cmc-ccsonnet' }])
  // A failing host contributes nothing (the merged answer above is complete) and is
  // reported on its row instead.
  const failed = harness.router.status().hosts.find((host) => host.hostId === 'hostC')
  assert.equal(failed.error.code, 'auth/forbidden-scope')
  assert.equal(failed.error.scope, 'prompt:send')
  assert.ok(harness.logs.some((line) => line.includes('session/modelCatalog from hostC failed: auth/forbidden-scope')))
  // The catalog request is forwarded as-is: no hint, no namespaced id.
  assert.deepEqual(hostB.calls[0].args, {})
  assertNoNamespacedId(hostB)
})

test('a remote catalog with a host-tagged id contributes nothing, and its headers are bounded', async () => {
  // The catalog value is remote data like every other answer: an id that already
  // names a namespace is refused whole (no rename, no partial merge), and the
  // section header the picker renders is capped instead of trusted.
  const hostB = createFakeRemote('hostB', 'Host B', { replies: {
    'session/modelCatalog': catalog([providerGroup('only-on-b', `${'L'.repeat(300)}`, ['m'])]),
  } })
  const hostD = createFakeRemote('hostD', 'Host D', { replies: {
    'session/modelCatalog': catalog([providerGroup('only-on-d', 'D', ['m'])], { sessionId: 'h:hostB:s1' }),
  } })
  const harness = createHarness({
    remotes: [hostB, hostD],
    dispatchRpc: localCatalog([providerGroup('deepseek-official', 'DeepSeek', ['deepseek-chat'])]),
  })
  const answer = await harness.gateway.dispatchRpc('session/modelCatalog', { args: {} }, undefined, {})
  assert.equal(answer.ok, true, JSON.stringify(answer))
  const value = answer.value
  assert.deepEqual(value.groups.map((group) => group.id), ['deepseek-official', 'only-on-b@hostB'],
    'the tagged host contributes no group at all')
  assert.equal(value.routableProviders.includes('only-on-d'), false)
  const header = value.groups[1].name
  assert.equal(header.length, 120, 'the section header is capped at 120 characters')
  assert.equal(header.startsWith('Remote · Host B — '), true,
    'the host label survives the cap: it is what makes the section tellable apart')
  assert.ok(harness.logs.some((line) => line.includes('session/modelCatalog from hostD refused: remote/id-leak')),
    'the refusal is reported on the host, without the value')
  assert.equal(harness.logs.some((line) => line.includes('h:hostB:s1')), false, 'the leaked id itself is never logged')
})

test('a remote group id carrying the host tag is dropped, and model labels are bounded without cutting ids', async () => {
  // `<provider>@<hostId>` is the shape this module mints: a remote id that already
  // contains `@` would be compared against the wrong host by the picker, so the whole
  // group is dropped. A model id is a routing key (a cut one names nothing), so an
  // over-long id drops the model; only its display label is truncated.
  const longId = 'm'.repeat(121)
  const keptId = 'k'.repeat(120)
  const hostB = createFakeRemote('hostB', 'Host B', { replies: {
    'session/modelCatalog': catalog([
      providerGroup('evil@hostZ', 'Tagged', ['m']),
      { id: 'ok-provider', name: 'OK', models: [
        { id: 'short', name: 'N'.repeat(300) },
        { id: longId, name: 'too long an id' },
        { id: keptId, name: 'exactly at the cap' },
        { id: 'unnamed' },
      ] },
      providerGroup('only-long', 'Only long', [longId]),
    ]),
  } })
  const harness = createHarness({
    remotes: [hostB],
    dispatchRpc: localCatalog([providerGroup('deepseek-official', 'DeepSeek', ['deepseek-chat'])]),
  })
  const answer = await harness.gateway.dispatchRpc('session/modelCatalog', { args: {} }, undefined, {})
  assert.equal(answer.ok, true, JSON.stringify(answer))
  const groups = answer.value.groups
  assert.deepEqual(groups.map((group) => group.id), ['deepseek-official', 'ok-provider@hostB'],
    'the tagged group and the group with no usable model are both gone')
  const models = groups[1].models
  assert.deepEqual(models.map((model) => model.id), ['short', keptId, 'unnamed'],
    'the over-long id is dropped whole, never truncated')
  assert.equal(models[0].name.length, 120, 'a model label is capped')
  assert.equal(models[2].name, 'unnamed', 'a model with no name shows its id')
  assert.deepEqual(answer.value.routableProviders, ['deepseek-official', 'ok-provider@hostB'])
})

test('a broken Local catalog is returned as-is: no host is asked, nothing is papered over', async () => {
  const hostB = createFakeRemote('hostB', 'Host B', { replies: {
    'session/modelCatalog': catalog([providerGroup('only-on-b', 'B', ['m'])]),
  } })
  const harness = createHarness({ remotes: [hostB],
    dispatchRpc: () => ({ ok: false, error: { code: 'internal', message: 'no catalog', details: {} } }) })
  const answer = await harness.gateway.dispatchRpc('session/modelCatalog', { args: {} }, undefined, {})
  assert.deepEqual(answer, { ok: false, error: { code: 'internal', message: 'no catalog', details: {} } })
  assert.equal(hostB.calls.length, 0, 'a Local failure is the answer; no host is asked')
})

// -- model selection: provider tagging in, tag stripping out ----------------
//
// The picker only ever sees merged ids, so `session/selectModel` arrives with the
// provider it matched (`r9-fallback@hostB`) and the tag belongs to the routing
// layer, not to the Host. The reverse — an id for another Host, or a Local id on a
// remote session — is refused: silently running a model on the wrong machine is
// the one outcome this tag exists to prevent.

test('session/selectModel strips the host tag from the provider the picker matched', async () => {
  const selected = { selected: { provider: 'r9-fallback', model: 'ds41-cmc-ccsonnet' } }
  const hostB = createFakeRemote('hostB', 'Host B', { replies: { 'session/selectModel': selected } })
  const harness = createHarness({ remotes: [hostB] })
  const answer = await harness.gateway.dispatchRpc('session/selectModel', {
    args: { sessionId: 'h:hostB:s1', provider: 'r9-fallback@hostB', model: 'ds41-cmc-ccsonnet' },
  }, undefined, {})
  assert.equal(answer.ok, true, JSON.stringify(answer))
  // The Host receives its own provider id: the tag is minted for the UI, and it is
  // taken off before the call crosses the wire.
  assert.deepEqual(hostB.calls[0].args, { sessionId: 's1', provider: 'r9-fallback', model: 'ds41-cmc-ccsonnet' })
  // The answer comes back the way the UI reads it: `selected` is a selection, so
  // ingress tags it for the host that selected.
  assert.deepEqual(answer.value, { selected: { provider: 'r9-fallback@hostB', model: 'ds41-cmc-ccsonnet' } })
  assert.equal(harness.localCalls.length, 0)
  assertNoNamespacedId(hostB)
  // The same call in the other legal arg shape (a nested `request`, which is how the
  // gateway carries a named parameter): the tag is stripped where it sits.
  await harness.gateway.dispatchRpc('session/selectModel', {
    args: { request: { sessionId: 'h:hostB:s2', provider: 'r9-fallback@hostB', model: 'ds41-cmc-ccsonnet' } },
  }, undefined, {})
  assert.deepEqual(hostB.calls[1].args,
    { request: { sessionId: 's2', provider: 'r9-fallback', model: 'ds41-cmc-ccsonnet' } })
  assertNoNamespacedId(hostB)
  // Selecting a Local provider for a Local session stays Local and untagged.
  const local = await harness.gateway.dispatchRpc('session/selectModel',
    { args: { sessionId: 's1', provider: 'deepseek-official', model: 'm' } }, undefined, {})
  assert.deepEqual(local, { ok: true, value: { local: 'session/selectModel' } })
  assert.deepEqual(harness.localCalls.at(-1).payload.args,
    { sessionId: 's1', provider: 'deepseek-official', model: 'm' })
})

test('session/control emits one opening baseline: a delayed remote baseline becomes projection frames', async () => {
  // DSH's snapshot stream ends on a second opening baseline (snapshot-stream.ts:
  // `snapshotSeen`). A remote whose baseline arrives after the merged stream
  // started must therefore be folded in as ordinary projections, never as a
  // second baseline.
  const hostB = createFakeRemote('hostB', 'Host B')
  const controlQueues = []
  const originalOpenStream = hostB.connection.openStream.bind(hostB.connection)
  hostB.connection.openStream = async (endpoint, args, options) => {
    if (endpoint !== 'session/control') return originalOpenStream(endpoint, args, options)
    const queue = createQueue()
    controlQueues.push(queue)
    return queue
  }
  const harness = createHarness({ remotes: [hostB] })
  const control = new AbortController()
  const source = await harness.gateway.openWireStream('session/control', { args: {} },
    undefined, {}, control.signal, control, 64)
  const iterator = source[Symbol.asyncIterator]()
  const nextControl = createControlProtocolReader()
  const opening = await nextControl(iterator, 'opening baseline')
  assert.equal(opening.type, 'baseline')
  assert.deepEqual(opening.value.projections, {}, 'the late remote is not in the one opening baseline')

  const oldSelection = selection('r9-fallback', 'old-model')
  controlQueues[0].push({ type: 'baseline', value: { projections: {
    s1: projectedSelection('r9-fallback', 'old-model'),
    s2: { kind: 'sequenced', asOfSeq: 5, values: { title: 'Host B title' } },
  } } })
  const first = await nextControl(iterator, 'late baseline projection for s1')
  const second = await nextControl(iterator, 'late baseline projection for s2')
  assert.deepEqual([first, second], [
    {
      type: 'projection', sessionId: 'h:hostB:s1', seq: 7,
      changes: [{ key: 'modelSelection', val: {
        lastUsed: { ...oldSelection, provider: 'r9-fallback@hostB' },
        next: { ...oldSelection, provider: 'r9-fallback@hostB' },
      } }],
    },
    {
      type: 'projection', sessionId: 'h:hostB:s2', seq: 5,
      changes: [{ key: 'title', val: 'Host B title' }],
    },
  ], 'each block is re-sent as one per-session frame, with ids and provider ingress-applied')
  const extra = await frameWithin(iterator, 50)
  assert.equal(extra, null, 'no second baseline was emitted after the late remote baseline')
  assertNoNamespacedId(hostB)
  control.abort()
  await iterator.return()
})

test('session/control emits one opening baseline: a late Local baseline also becomes projections', async () => {
  // The same snapshot-stream rule applies to Local: after the opening baseline,
  // a re-baseline from the carrier must not be forwarded as another opening
  // snapshot. Hold Local's greeting until after the merge has started.
  const hostB = createFakeRemote('hostB', 'Host B')
  const originalOpenStream = hostB.connection.openStream.bind(hostB.connection)
  hostB.connection.openStream = async (endpoint, args, options) => {
    if (endpoint !== 'session/control') return originalOpenStream(endpoint, args, options)
    return createQueue()
  }
  const harness = createHarness({ remotes: [hostB], controlBaseline: null })
  const control = new AbortController()
  const source = await harness.gateway.openWireStream('session/control', { args: {} },
    undefined, {}, control.signal, control, 64)
  const iterator = source[Symbol.asyncIterator]()
  const nextControl = createControlProtocolReader()
  const opening = await nextControl(iterator, 'opening baseline after Local timeout')
  assert.equal(opening.type, 'baseline')
  assert.deepEqual(opening.value.projections, {})

  harness.localStreams.at(-1).queue.push({ type: 'baseline', value: { projections: {
    local: { kind: 'sequenced', asOfSeq: 3, values: { title: 'Local title' } },
  } } })
  const localLate = await nextControl(iterator, 'late Local baseline projection')
  assert.deepEqual(localLate, {
    type: 'projection', sessionId: 'local', seq: 3,
    changes: [{ key: 'title', val: 'Local title' }],
  })
  const afterLocal = await frameWithin(iterator, 50)
  assert.equal(afterLocal, null, 'the late Local baseline did not emit a second opening baseline')
  control.abort()
  await iterator.return()
})

test('a late -1 baseline reopens once: the carried cut seeds the replacement opening baseline and a late repeat does not reopen', async () => {
  // Native contract (installed rc.1): a baseline's `asOfSeq` may be -1
  // (`sessionSeqCursor` keeps it), but a projection frame's `seq` is admitted by
  // `SessionSeq` and THROWS for -1. Mapping -1 to 0 would mask the real event 0.
  // The cut must be carried to the native retry's ONE opening baseline: a remote
  // greeting is asynchronous and normally arrives after Local, so waiting for it
  // would end generation after generation with the same -1 cut.
  const emptyBlock = { kind: 'sequenced', asOfSeq: -1, values: {
    modelSelection: { lastUsed: selection('r9-fallback', 'old-model'), next: selection('r9-fallback', 'old-model') },
  } }
  const hostB = createFakeRemote('hostB', 'Host B')
  const controlQueues = []
  const originalOpenStream = hostB.connection.openStream.bind(hostB.connection)
  hostB.connection.openStream = async (endpoint, args, options) => {
    if (endpoint !== 'session/control') return originalOpenStream(endpoint, args, options)
    const queue = createQueue()
    controlQueues.push(queue)
    // No synchronous greeting on ANY generation: the Host greets asynchronously.
    return queue
  }
  const harness = createHarness({ remotes: [hostB] })
  const control = new AbortController()
  const source1 = await harness.gateway.openWireStream('session/control', { args: {} },
    undefined, {}, control.signal, control, 64)
  const iterator1 = source1[Symbol.asyncIterator]()
  const next1 = createControlProtocolReader()
  const opening1 = await next1(iterator1, 'first opening baseline')
  assert.equal(opening1.type, 'baseline')
  assert.deepEqual(opening1.value.projections, {}, 'the host had not greeted yet')

  // The -1 baseline arrives late: it must NOT be converted to a projection with
  // seq -1 (native SessionSeq throws), and it must NOT be a second baseline here.
  controlQueues[0].push({ type: 'baseline', value: { projections: { s1: emptyBlock } } })
  const afterNegative = await nextFrame(iterator1, 'stream end after negative baseline')
  assert.equal(afterNegative.done, true, 'the merged stream ends so the native can retry')
  assert.throws(() => admitSessionSeq(-1, 'invented projection'), /non-negative safe integer/,
    'the native projection admission would have thrown on the old seq -1 conversion')
  assert.ok(harness.logs.some((line) => line.includes('re-opening merged stream')),
    'the rebase reason is logged')

  // Simulate the native RemoteStream retry: a new physical stream generation.
  const source2 = await harness.gateway.openWireStream('session/control', { args: {} },
    undefined, {}, control.signal, control, 64)
  const iterator2 = source2[Symbol.asyncIterator]()
  const next2 = createControlProtocolReader()
  const opening2 = await next2(iterator2, 'reopened opening baseline')
  assert.equal(opening2.type, 'baseline')
  const block = opening2.value.projections['h:hostB:s1']
  assert.ok(block, 'the carried -1 cut is in the ONE opening baseline without waiting for a greeting')
  assert.equal(block.asOfSeq, -1, 'the empty cursor is preserved, never mapped to 0')
  assert.deepEqual(admitBaselineCursor(block.asOfSeq, 'baseline'), -1)
  assert.throws(() => admitSessionSeq(block.asOfSeq, 'projection'), TypeError,
    'the same number would be refused as a projection frame seq')

  // Local already greeted (it is the opening baseline's spine). The remote now
  // greets late, after Local, with the SAME cut. It must neither reopen again nor
  // emit a -1 projection; hold the pending read so a later frame is not stolen.
  const pendingAfterGreeting = iterator2.next()
  controlQueues[1].push({ type: 'baseline', value: { projections: { s1: emptyBlock } } })
  const quiet = await Promise.race([
    pendingAfterGreeting.then((result) => ({ result })),
    new Promise((resolve) => { const timer = setTimeout(() => resolve({ quiet: true }), 120); timer.unref?.() }),
  ])
  assert.ok(quiet.quiet, `a repeated late -1 greeting must be quiet, got ${JSON.stringify(quiet.result)}`)
  assert.equal(controlQueues.length, 2, 'no repeated reopening after the carried cut')

  // The first live event is seq 0 — the value a -1 -> 0 remap would have masked.
  controlQueues.at(-1).push({ type: 'projection', sessionId: 's1', seq: 0,
    changes: [{ key: 'modelSelection', val: { lastUsed: selection('r9-fallback', 'old-model'), next: selection('r9-fallback', 'new-model') } }] })
  const event0Result = await pendingAfterGreeting
  assert.equal(event0Result.done, false, 'the reopened generation is still open after the late greeting')
  const event0 = event0Result.value
  assert.equal(event0.type, 'projection')
  assert.equal(event0.seq, 0)
  assert.equal(admitSessionSeq(event0.seq, 'event 0 seq'), 0, 'native admits event 0')
  assert.equal(event0.changes[0].val.next.model, 'new-model')

  // A positive update still flows in the same generation.
  controlQueues.at(-1).push({ type: 'projection', sessionId: 's1', seq: 4,
    changes: [{ key: 'title', val: 'Live title' }] })
  const positive = await next2(iterator2, 'positive projection')
  assert.equal(positive.seq, 4)
  assert.equal(admitSessionSeq(positive.seq, 'positive seq'), 4)
  control.abort()
  await iterator1.return()
  await iterator2.return()
})

test('a reconnect cut that omits a prior key is carried: the replacement opening baseline clears the stale row', async () => {
  // ProjectionValueStore.seed clears a key the cut omits; apply (what a late
  // baseline converted to projection frames would use) never does. When the
  // Host re-greets with a cut that drops `modelSelection`, the whole merged
  // stream must reopen and the cut must be carried into the retry's ONE opening
  // baseline. A normal Host greeting is asynchronous (after Local); if the new
  // generation opened with only Local's empty baseline, no seed would ever clear
  // the already-seeded `modelSelection` row.
  const initial = projectedSelection('r9-fallback', 'old-model', 5)
  const omitted = { kind: 'sequenced', asOfSeq: 8, values: { title: 'Host B title' } }
  const hostB = createFakeRemote('hostB', 'Host B', { controlProjections: { s1: initial } })
  const controlQueues = []
  const originalOpenStream = hostB.connection.openStream.bind(hostB.connection)
  hostB.connection.openStream = async (endpoint, args, options) => {
    if (endpoint !== 'session/control') return originalOpenStream(endpoint, args, options)
    const queue = createQueue()
    controlQueues.push(queue)
    // Generation 1 greets with the initial cut. The reopened generation does NOT
    // greet here: its greeting is asynchronous and pushed after Local below.
    if (controlQueues.length === 1) queue.push({ type: 'baseline', value: { projections: { s1: initial } } })
    return queue
  }
  const harness = createHarness({ remotes: [hostB] })
  const control = new AbortController()
  const source1 = await harness.gateway.openWireStream('session/control', { args: {} },
    undefined, {}, control.signal, control, 64)
  const iterator1 = source1[Symbol.asyncIterator]()
  const next1 = createControlProtocolReader()
  const opening1 = await next1(iterator1, 'opening baseline before omission')
  const block1 = opening1.value.projections['h:hostB:s1']
  assert.ok(block1.values.modelSelection, 'the first cut carries the selection key')
  const store = createNativeProjectionStore()
  store.seed(block1)
  assert.deepEqual(store.keys().sort(), ['modelSelection'], 'native seed holds the prior key')

  // Reconnect cut: same session, newer watermark, `modelSelection` omitted.
  controlQueues[0].push({ type: 'baseline', value: { projections: { s1: omitted } } })
  const afterOmission = await nextFrame(iterator1, 'stream end after omission')
  assert.equal(afterOmission.done, true, 'a synthesized apply cannot clear the key; the stream reopens')
  assert.equal((await nextFrame(iterator1, 'stream already ended')).done, true,
    'no projection frame papered over the omission')

  // The native retry's ONE opening baseline seeds the whole cut, omission included,
  // before the reopened generation's remote greeting arrives.
  const source2 = await harness.gateway.openWireStream('session/control', { args: {} },
    undefined, {}, control.signal, control, 64)
  const iterator2 = source2[Symbol.asyncIterator]()
  const opening2 = await (createControlProtocolReader())(iterator2, 'reopened baseline after omission')
  assert.equal(opening2.type, 'baseline')
  const block2 = opening2.value.projections['h:hostB:s1']
  assert.equal(block2.asOfSeq, 8)
  assert.deepEqual(Object.keys(block2.values), ['title'], 'the omitted key is absent from the fresh cut')
  store.seed(block2)
  assert.equal(store.get('title'), 'Host B title')
  assert.equal(store.get('modelSelection'), undefined, 'native seed clears the key the cut omitted')
  assert.deepEqual(store.keys(), ['title'])

  // Local has greeted; the remote greeting now arrives asynchronously with the
  // same omitted cut. It must not restore the key nor reopen the stream.
  const pendingAfterGreeting = iterator2.next()
  controlQueues[1].push({ type: 'baseline', value: { projections: { s1: omitted } } })
  const quiet = await Promise.race([
    pendingAfterGreeting.then((result) => ({ result })),
    new Promise((resolve) => { const timer = setTimeout(() => resolve({ quiet: true }), 120); timer.unref?.() }),
  ])
  assert.ok(quiet.quiet, `a repeated late omitted-key greeting must be quiet, got ${JSON.stringify(quiet.result)}`)
  assert.equal(controlQueues.length, 2, 'the late greeting did not reopen the stream')

  // A live update still flows; the native store keeps only the fresh cut's keys.
  controlQueues.at(-1).push({ type: 'projection', sessionId: 's1', seq: 9,
    changes: [{ key: 'title', val: 'Live title' }] })
  const liveResult = await pendingAfterGreeting
  assert.equal(liveResult.done, false, 'the reopened generation is still open after the late greeting')
  store.apply('title', liveResult.value.changes[0].val, liveResult.value.seq)
  assert.equal(store.get('modelSelection'), undefined, 'no stale projection is restored by the late greeting')
  control.abort()
  await iterator1.return()
  await iterator2.return()
})

test('two hosts alternating rebases carry both still-required cuts across three generations and go quiet', async () => {
  // Reviewer finding: taking ALL carried cuts at generation start and then
  // remembering only the triggering cut loses a second host's cut that has not
  // re-greeted yet. Host A triggers generation 1 -> 2; Host B triggers 2 -> 3;
  // generation 3's ONE opening baseline must still seed both cuts.
  const cut = (model) => ({ kind: 'sequenced', asOfSeq: -1, values: {
    modelSelection: { lastUsed: selection('r9-fallback', model), next: selection('r9-fallback', model) },
  } })
  const cutA = cut('model-A')
  const cutB = cut('model-B')
  const hostA = createFakeRemote('hostA', 'Host A')
  const hostB = createFakeRemote('hostB', 'Host B')
  const queues = { hostA: [], hostB: [] }
  for (const host of [hostA, hostB]) {
    const original = host.connection.openStream.bind(host.connection)
    host.connection.openStream = async (endpoint, args, options) => {
      if (endpoint !== 'session/control') return original(endpoint, args, options)
      const queue = createQueue()
      queues[host.hostId].push(queue)
      // No synchronous greeting: a Host normally greets asynchronously, after
      // the merged opening baseline has already been published.
      return queue
    }
  }
  const harness = createHarness({ remotes: [hostA, hostB] })
  const control = new AbortController()
  const openGeneration = async (label) => {
    const source = await harness.gateway.openWireStream('session/control', { args: {} },
      undefined, {}, control.signal, control, 64)
    const iterator = source[Symbol.asyncIterator]()
    const opening = await (createControlProtocolReader())(iterator, label)
    return { source, iterator, opening }
  }
  const pause = (ms) => new Promise((resolve) => { const timer = setTimeout(resolve, ms); timer.unref?.() })

  const gen1 = await openGeneration('generation 1 opening')
  assert.deepEqual(gen1.opening.value.projections, {}, 'neither host has greeted yet')
  queues.hostA[0].push({ type: 'baseline', value: { projections: { s1: cutA } } })
  assert.equal((await nextFrame(gen1.iterator, 'generation 1 ends')).done, true, 'A rebased')

  const gen2 = await openGeneration('generation 2 opening')
  assert.equal(gen2.opening.value.projections['h:hostA:s1']?.asOfSeq, -1,
    'A cut seeds the second generation before A greets')

  // B's late cut triggers the second rebase. A has still not re-greeted, so its
  // cut is still required and must survive alongside B's.
  queues.hostB[1].push({ type: 'baseline', value: { projections: { s2: cutB } } })
  assert.equal((await nextFrame(gen2.iterator, 'generation 2 ends')).done, true, 'B rebased')

  const gen3 = await openGeneration('generation 3 opening')
  const projections = gen3.opening.value.projections
  assert.equal(projections['h:hostA:s1']?.asOfSeq, -1,
    'A still-required cut survives B rebase into the third generation')
  assert.equal(projections['h:hostB:s2']?.asOfSeq, -1, 'the triggering B cut is carried too')
  // Ingress names each Host's provider, so the carried values are the merged
  // ones the native store actually seeds (not the Host's raw provider id).
  assert.equal(projections['h:hostA:s1']?.values.modelSelection.next.model, 'model-A')
  assert.equal(projections['h:hostA:s1']?.values.modelSelection.next.provider, 'r9-fallback@hostA')
  assert.equal(projections['h:hostB:s2']?.values.modelSelection.next.model, 'model-B')
  assert.equal(projections['h:hostB:s2']?.values.modelSelection.next.provider, 'r9-fallback@hostB')

  // Both hosts now greet late with their seeded cuts: both are duplicates and
  // must be retired without another reopen (quiescence).
  const pending = gen3.iterator.next()
  queues.hostA[2].push({ type: 'baseline', value: { projections: { s1: cutA } } })
  queues.hostB[2].push({ type: 'baseline', value: { projections: { s2: cutB } } })
  const quiet = await Promise.race([
    pending.then((result) => ({ result })),
    pause(150).then(() => ({ quiet: true })),
  ])
  assert.ok(quiet.quiet, `late greetings must be quiet, got ${JSON.stringify(quiet.result)}`)
  assert.equal(queues.hostA.length, 3, 'no fourth generation for A')
  assert.equal(queues.hostB.length, 3, 'no fourth generation for B')

  queues.hostA[2].push({ type: 'projection', sessionId: 's1', seq: 4,
    changes: [{ key: 'title', val: 'A live' }] })
  const live = await pending
  assert.equal(live.done, false, 'the third generation is still open')
  assert.equal(live.value.type, 'projection')
  assert.equal(live.value.sessionId, 'h:hostA:s1')
  control.abort()
  await gen1.iterator.return()
  await gen2.iterator.return()
  await gen3.iterator.return()
})

test('a hostile payload at a carried watermark is refused by ingress before duplicate suppression', async () => {
  // Reviewer finding: the carried-watermark shortcut skipped #ingress, so a
  // same-watermark payload with a pre-tagged id was quietly treated as a
  // duplicate instead of being refused and logged.
  const hostB = createFakeRemote('hostB', 'Host B')
  const queues = []
  const original = hostB.connection.openStream.bind(hostB.connection)
  hostB.connection.openStream = async (endpoint, args, options) => {
    if (endpoint !== 'session/control') return original(endpoint, args, options)
    const queue = createQueue()
    queues.push(queue)
    return queue
  }
  const harness = createHarness({ remotes: [hostB] })
  const control = new AbortController()
  const source1 = await harness.gateway.openWireStream('session/control', { args: {} },
    undefined, {}, control.signal, control, 64)
  const iterator1 = source1[Symbol.asyncIterator]()
  await (createControlProtocolReader())(iterator1, 'first opening')
  const cut = { kind: 'sequenced', asOfSeq: -1, values: {
    modelSelection: { lastUsed: selection('r9-fallback', 'old-model'), next: selection('r9-fallback', 'old-model') },
  } }
  queues[0].push({ type: 'baseline', value: { projections: { s1: cut } } })
  assert.equal((await nextFrame(iterator1, 'first generation ends')).done, true)

  const source2 = await harness.gateway.openWireStream('session/control', { args: {} },
    undefined, {}, control.signal, control, 64)
  const iterator2 = source2[Symbol.asyncIterator]()
  const opening2 = await (createControlProtocolReader())(iterator2, 'reopened opening')
  assert.equal(opening2.value.projections['h:hostB:s1']?.asOfSeq, -1,
    'the cut was seeded by the reopened generation')
  const pending = iterator2.next()
  // Same watermark as the carried cut, but it smuggles an id that already names
  // this controller's namespace; it must never be mistaken for a clean repeat.
  queues[1].push({ type: 'baseline', value: { projections: { s1: {
    kind: 'sequenced', asOfSeq: -1,
    values: { sessionId: 'h:hostB:smuggled', title: 'hostile' },
  } } } })
  const quiet = await Promise.race([
    pending.then((result) => ({ result })),
    new Promise((resolve) => { const timer = setTimeout(() => resolve({ quiet: true }), 150); timer.unref?.() }),
  ])
  assert.ok(quiet.quiet, `the hostile frame must not be delivered, got ${JSON.stringify(quiet.result)}`)
  assert.ok(harness.logs.some((line) => line.includes('session/control from hostB refused: remote/id-leak')),
    'the same-watermark payload was validated and refused by ingress')
  assert.equal(queues.length, 2, 'the hostile duplicate did not trigger another rebase')
  control.abort()
  await iterator1.return()
  await iterator2.return()
})

test('a remote prompt carries requestId out and the durable user message returns the same rpcId', async () => {
  // DSH's native controller settles its optimistic echo only when a durable
  // user/message (or inbox row) carries source.rpcId === beginSubmission's
  // requestId. Both ends cross this wrapper, so neither id may be renamed.
  const hostB = createFakeRemote('hostB', 'Host B', { replies: { 'session/prompt': { accepted: true } } })
  const harness = createHarness({ remotes: [hostB] })
  const answer = await harness.gateway.dispatchRpc('session/prompt', { args: {
    sessionId: 'h:hostB:s1', requestId: 'req-echo-1', mode: 'instant', content: [{ type: 'text', text: 'hello' }],
  } }, undefined, {})
  assert.equal(answer.ok, true)
  assert.equal(hostB.calls.length, 1)
  assert.equal(hostB.calls[0].args.sessionId, 's1', 'the session id is stripped for the Host')
  assert.equal(hostB.calls[0].args.requestId, 'req-echo-1',
    'the Host records this as source.rpcId; an id tag here would break echo settlement')
  assertNoNamespacedId(hostB)

  const source = await harness.gateway.openWireStream('session/follow',
    { args: { request: { address: { kind: 'session', sessionId: 'h:hostB:s1' } } } },
    undefined, {}, new AbortController().signal, new AbortController(), 64)
  hostB.streams.at(-1).queue.push({ type: 'event', event: {
    type: 'user/message', seq: 3, time: 1,
    data: { id: 'm1', content: [{ type: 'text', text: 'hello' }], source: { kind: 'user', rpcId: 'req-echo-1' } },
  } })
  const iterator = source[Symbol.asyncIterator]()
  const frame = (await nextFrame(iterator, 'remote user message')).value
  assert.equal(frame.event.type, 'user/message')
  assert.equal(frame.event.data.source.kind, 'user')
  assert.equal(frame.event.data.source.rpcId, 'req-echo-1',
    'the local controller looks up its pending echo by this exact id')
  await iterator.return()
})

test('a successful remote selectModel reaches the native model chip through the control projection', async () => {
  // The RPC answer alone never moves the chip: dsh-client-ui-model-selection's
  // ModelDirectory current is derived from the `modelSelection` projection face
  // (directory.ts syncInputs). The Host appends a durable `model/selection` event
  // and folds it into a `session/control` projection frame; that frame is what
  // this test follows from the remote Host to the projection store.
  const oldSelection = selection('r9-fallback', 'old-model')
  const newSelection = selection('r9-fallback', 'ds41-cmc-ccsonnet')
  let hostB
  hostB = createFakeRemote('hostB', 'Host B', {
    controlProjections: { s1: projectedSelection('r9-fallback', 'old-model') },
    replies: {
      'session/selectModel'() {
        // The frame DSH's SessionControlController broadcasts on onEventChanged
        // when the Host folds `model/selection` (dsh-agent modelSelectionProjectionDefinition).
        hostB.send({
          type: 'projection', sessionId: 's1', seq: 9,
          changes: [{ key: 'modelSelection', val: { lastUsed: oldSelection, next: newSelection } }],
        })
        return { selected: newSelection }
      },
    },
  })
  const harness = createHarness({ remotes: [hostB] })
  // The native client opens ONE `session/control` stream for all sessions.
  const control = new AbortController()
  const source = await harness.gateway.openWireStream('session/control', { args: {} },
    undefined, {}, control.signal, control, 64)
  // The opening baseline names the remote session in this controller's namespace.
  const baseline = (await nextFrame(source, 'session/control baseline')).value
  assert.equal(baseline.type, 'baseline')
  assert.deepEqual(Object.keys(baseline.value.projections), ['h:hostB:s1'])
  assert.deepEqual(baseline.value.projections['h:hostB:s1'].values.modelSelection,
    { lastUsed: { ...oldSelection, provider: 'r9-fallback@hostB' }, next: { ...oldSelection, provider: 'r9-fallback@hostB' } })

  const answer = await harness.gateway.dispatchRpc('session/selectModel', {
    args: { sessionId: 'h:hostB:s1', provider: 'r9-fallback@hostB', model: 'ds41-cmc-ccsonnet' },
  }, undefined, {})
  assert.equal(answer.ok, true, JSON.stringify(answer))

  // The frame the native projection store consumes: key namespaced, seq kept,
  // and the selection's provider tagged so it matches the merged picker catalog.
  const frame = (await nextFrame(source, 'modelSelection projection frame')).value
  assert.deepEqual(frame, {
    type: 'projection', sessionId: 'h:hostB:s1', seq: 9,
    changes: [{ key: 'modelSelection', val: {
      lastUsed: { ...oldSelection, provider: 'r9-fallback@hostB' },
      next: { ...newSelection, provider: 'r9-fallback@hostB' },
    } }],
  })
  // Fold it the way ProjectionValueStore.apply + directory.syncInputs do: the
  // chip's `current` is projection.next, so this is the value that must move.
  const face = { ...baseline.value.projections['h:hostB:s1'].values.modelSelection }
  const change = frame.changes.find((entry) => entry.key === 'modelSelection')
  face.next = change.val.next
  assert.deepEqual(face.next, { provider: 'r9-fallback@hostB', model: 'ds41-cmc-ccsonnet' })
  assert.notDeepEqual(face.next, face.lastUsed, 'the chip reads a new selection, not the old one')
  assertNoNamespacedId(hostB)
  control.abort()
})

test('a remote claim splice reconstructs the surviving inbox in ONE id namespace', async () => {
  // rc.3 retires an admitted echo with receipt.index===null only when
  // seqOf('inbox') reaches the claim's seq. The splice is durable on follow; its
  // projection can be missing from session/control. The router must reconstruct
  // the WHOLE post-splice inbox from a sequenced baseline/snapshot, fold the
  // splice with DSH's own rules in the SAME id coordinate, and publish that value.
  const wireMessage = (id, text, rpcId) => ({
    id, content: [{ type: 'text', text }],
    sessionId: 's1', agentId: 'agent-a', workspaceId: 'ws-a',
    source: { kind: 'user', rpcId },
  })
  const turnA = wireMessage('turn-a', 'A', 'rpc-a')
  const turnB = wireMessage('turn-b', 'B', 'rpc-b')
  const turnC = wireMessage('turn-c', 'C', 'rpc-c')
  const step = wireMessage('step-1', 'step', 'rpc-step')
  const baselineInbox = { 'next-turn': [turnA, turnB], 'next-step': [] }
  const snapshotInbox = { 'next-turn': [turnA, turnB], 'next-step': [step] }
  const rawSurviving = { 'next-turn': [turnC, turnB], 'next-step': [step] }
  const renamedSurviving = namespaceIds(rawSurviving, 'hostB')
  const hostB = createFakeRemote('hostB', 'Host B', {
    controlProjections: { s1: { asOfSeq: 5, values: { inbox: baselineInbox } } },
  })
  const harness = createHarness({ remotes: [hostB] })
  const control = new AbortController()
  const controlSource = await harness.gateway.openWireStream('session/control', { args: {} },
    undefined, {}, control.signal, control, 64)
  const controlIterator = controlSource[Symbol.asyncIterator]()
  const opening = (await nextFrame(controlIterator, 'control opening baseline')).value
  assert.equal(opening.type, 'baseline')
  assert.deepEqual(opening.value.projections['h:hostB:s1'].values.inbox, namespaceIds(baselineInbox, 'hostB'),
    'the merged baseline stores the ingress-renamed inbox cut')

  const followAbort = new AbortController()
  const followSource = await harness.gateway.openWireStream('session/follow',
    { args: { request: { address: { kind: 'session', sessionId: 'h:hostB:s1' } } } },
    undefined, {}, followAbort.signal, followAbort, 64)
  const followIterator = followSource[Symbol.asyncIterator]()
  const deadline = Date.now() + 2000
  let remoteFollow = null
  while (!remoteFollow && Date.now() < deadline) {
    remoteFollow = hostB.streams.find((entry) => entry.endpoint === 'session/follow') ?? null
    if (!remoteFollow) await new Promise((resolve) => setTimeout(resolve, 5))
  }
  assert.ok(remoteFollow, 'the remote follow stream was opened')
  assert.equal(remoteFollow.args.request.address.sessionId, 's1',
    'the Host sees only its own id; the namespace is minted on the way back')

  // A follow opening snapshot is the session's own RAW projection cut; its higher
  // seq adds the untouched next-step queue the control baseline did not have.
  remoteFollow.queue.push({ type: 'snapshot', cursor: 6, header: { version: 4, id: 's1' },
    records: [], projections: { asOfSeq: 6, values: { inbox: snapshotInbox } }, hasMore: false })
  const opened = (await nextFrame(followIterator, 'follow opening snapshot')).value
  assert.equal(opened.type, 'snapshot')
  assert.deepEqual(opened.projections.values.inbox, namespaceIds(snapshotInbox, 'hostB'),
    'the delivered snapshot is ingressed once; nested ids are renamed, source.rpcId stays opaque')

  const claim = (seq) => ({ type: 'event', event: {
    type: 'agent/inbox/spliced', seq, time: seq,
    data: { target: 'next-turn', start: 0, removedCount: 1, inserted: [turnC] },
  } })
  remoteFollow.queue.push(claim(8))
  const frame = (await nextFrame(controlIterator, 'fallback inbox projection')).value
  assert.equal(frame.sessionId, 'h:hostB:s1')
  assert.equal(frame.seq, 8)
  assert.equal(frame.changes[0].key, 'inbox')
  assert.deepEqual(frame.changes[0].val, renamedSurviving,
    'the full synthesized value is in the controller id namespace')
  const inserted = frame.changes[0].val['next-turn'][0]
  assert.equal(inserted.sessionId, namespaceId('hostB', 's1'), 'nested sessionId is renamed')
  assert.equal(inserted.agentId, namespaceId('hostB', 'agent-a'), 'nested agentId is renamed')
  assert.equal(inserted.workspaceId, namespaceId('hostB', 'ws-a'), 'nested workspaceId is renamed')
  assert.equal(inserted.source.rpcId, 'rpc-c', 'kind:user source.rpcId stays the controller-minted id')
  const followed = (await nextFrame(followIterator, 'claim on follow')).value
  assert.equal(followed.event.seq, 8, 'the durable follow frame is unchanged')
  assert.deepEqual(followed.event.data.inserted, namespaceIds([turnC], 'hostB'),
    'the follow frame keeps the inserted message, ingressed once like every remote payload')

  // The real Host frame carries the same RAW value. After the router's normal
  // ingress it must be byte-for-byte the frame we synthesized at the same seq.
  const remoteControl = hostB.streams.find((entry) => entry.endpoint === 'session/control')
  assert.ok(remoteControl, 'the remote control pump is open')
  remoteControl.queue.push({ type: 'projection', sessionId: 's1', seq: 8,
    changes: [{ key: 'inbox', val: rawSurviving }] })
  const realFrame = (await nextFrame(controlIterator, 'real same-seq inbox projection')).value
  assert.deepEqual(realFrame, frame,
    'synthesized value equals the real Host projection after ingress, at the same seq')

  // Native-equivalent ProjectionValueStore.apply drops that real frame at seq 8.
  const store = new Map([['inbox', { kind: 'sequenced', seq: frame.seq, value: frame.changes[0].val }]])
  const nativeApply = (key, value, seq) => {
    const row = store.get(key)
    if (row?.kind === 'sequenced' && seq <= row.seq) return
    store.set(key, { kind: 'sequenced', value, seq })
  }
  nativeApply('inbox', realFrame.changes[0].val, 8)
  assert.deepEqual(store.get('inbox').value, renamedSurviving,
    'the equal-seq real projection cannot replace the reconstructed full value')

  // A replayed older claim is not republished. Even if it were, ProjectionValueStore.apply
  // drops seq <= row.seq, so a lower watermark can never roll the store back.
  remoteFollow.queue.push(claim(5))
  assert.equal(await frameWithin(controlIterator, 50), null, 'an older seq is not republished')
  nativeApply('inbox', { 'next-turn': [], 'next-step': [] }, 5)
  assert.deepEqual(store.get('inbox').value, renamedSurviving, 'a stale seq cannot regress the native store')
  assertNoNamespacedId(hostB)
  control.abort()
  followAbort.abort()
  await controlIterator.return()
  await followIterator.return()
})

test('a remote inbox splice with no known authoritative state publishes no fallback', async () => {
  // A baseline/snapshot that never carried `inbox` means UNKNOWN, not empty.
  // A synthetic empty value here would erase real queued state the router could
  // not see and no later real frame at the same seq could repair it.
  const hostB = createFakeRemote('hostB', 'Host B')
  const harness = createHarness({ remotes: [hostB] })
  const control = new AbortController()
  const controlSource = await harness.gateway.openWireStream('session/control', { args: {} },
    undefined, {}, control.signal, control, 64)
  const controlIterator = controlSource[Symbol.asyncIterator]()
  assert.equal((await nextFrame(controlIterator, 'control opening baseline')).value.type, 'baseline')

  const followAbort = new AbortController()
  const followSource = await harness.gateway.openWireStream('session/follow',
    { args: { request: { address: { kind: 'session', sessionId: 'h:hostB:s1' } } } },
    undefined, {}, followAbort.signal, followAbort, 64)
  const followIterator = followSource[Symbol.asyncIterator]()
  const deadline = Date.now() + 2000
  let remoteFollow = null
  while (!remoteFollow && Date.now() < deadline) {
    remoteFollow = hostB.streams.find((entry) => entry.endpoint === 'session/follow') ?? null
    if (!remoteFollow) await new Promise((resolve) => setTimeout(resolve, 5))
  }
  assert.ok(remoteFollow, 'the remote follow stream was opened')
  remoteFollow.queue.push({ type: 'event', event: {
    type: 'agent/inbox/spliced', seq: 8, time: 8,
    data: { target: 'next-turn', start: 0, removedCount: 1, inserted: [] },
  } })
  assert.equal((await nextFrame(followIterator, 'claim with unknown state')).value.event.seq, 8)
  assert.equal(await frameWithin(controlIterator, 80), null,
    'no fallback is synthesized from unknown state')
  assertNoNamespacedId(hostB)
  control.abort()
  followAbort.abort()
  await controlIterator.return()
  await followIterator.return()
})

test('a local session inbox splice never publishes a synthetic control projection', async () => {
  const hostB = createFakeRemote('hostB', 'Host B')
  const harness = createHarness({ remotes: [hostB] })
  const control = new AbortController()
  const controlSource = await harness.gateway.openWireStream('session/control', { args: {} },
    undefined, {}, control.signal, control, 64)
  const controlIterator = controlSource[Symbol.asyncIterator]()
  assert.equal((await nextFrame(controlIterator, 'control opening baseline')).value.type, 'baseline')

  // An untagged session id stays Local; the router has no remote follow to learn
  // a watermark from, so it must not invent one for the controller's own stream.
  const followAbort = new AbortController()
  const followSource = await harness.gateway.openWireStream('session/follow',
    { args: { request: { address: { kind: 'session', sessionId: 'local-s1' } } } },
    undefined, {}, followAbort.signal, followAbort, 64)
  const followIterator = followSource[Symbol.asyncIterator]()
  const localFollow = harness.localStreams.at(-1)
  assert.ok(localFollow, 'the Local carrier opened the follow')
  localFollow.queue.push({ type: 'event', event: {
    type: 'agent/inbox/spliced', seq: 8, time: 8,
    data: { target: 'next-turn', start: 0, removedCount: 1, inserted: [] },
  } })
  assert.equal((await nextFrame(followIterator, 'local claim')).value.event.seq, 8)
  assert.equal(await frameWithin(controlIterator, 80), null,
    'no control frame was invented for a Local session')
  assertNoNamespacedId(hostB)
  control.abort()
  followAbort.abort()
  await controlIterator.return()
  await followIterator.return()
})

test('a normally-ended remote control stream is reopened and republishes the model chip', async () => {
  // Regression: when a remote `session/control` iterator ends normally (the Host
  // sent `remote-stream-closed`, remote-client.mjs:1020-1024), the pump must not
  // stay registered as if it were still live. Otherwise a later host-change — or
  // the reopen timer — cannot resubscribe, and the native model chip freezes on
  // the last selection while the Host itself stays connected.
  const oldSelection = selection('r9-fallback', 'old-model')
  const midSelection = selection('r9-fallback', 'mid-model')
  const newSelection = selection('r9-fallback', 'ds41-cmc-ccsonnet')
  const hostB = createFakeRemote('hostB', 'Host B', {
    controlProjections: { s1: projectedSelection('r9-fallback', 'old-model') },
  })
  const harness = createHarness({ remotes: [hostB] })
  // One merged `session/control` stream, as the native client opens it.
  const control = new AbortController()
  const source = await harness.gateway.openWireStream('session/control', { args: {} },
    undefined, {}, control.signal, control, 64)
  const iterator = source[Symbol.asyncIterator]()
  const nextControl = createControlProtocolReader()
  // The opening baseline carries the remote session, tagged into this controller.
  const baseline = await nextControl(iterator, 'session/control baseline')
  assert.equal(baseline.type, 'baseline')
  assert.deepEqual(Object.keys(baseline.value.projections), ['h:hostB:s1'])
  assert.deepEqual(baseline.value.projections['h:hostB:s1'].values.modelSelection,
    { lastUsed: { ...oldSelection, provider: 'r9-fallback@hostB' }, next: { ...oldSelection, provider: 'r9-fallback@hostB' } })
  assert.equal(hostB.streams.filter((stream) => stream.endpoint === 'session/control').length, 1)

  // The remote control stream ends NORMALLY — no error, the Host is still online.
  // This is the harness's stream-close, mirroring remote-client's normal end.
  hostB.closeStream()

  // The pump must re-open a fresh `session/control` stream on the same, still-
  // connected Host. Bound the wait so a stuck pump fails instead of hanging.
  let reopened = false
  const reopenDeadline = Date.now() + 1500
  while (Date.now() < reopenDeadline) {
    if (hostB.streams.filter((stream) => stream.endpoint === 'session/control').length >= 2) { reopened = true; break }
    await new Promise((resolve) => setTimeout(resolve, 10))
  }
  assert.equal(reopened, true, 'a normally-ended control stream must be re-opened while the Host stays connected')
  assert.equal(harness.router.status().hosts.find((host) => host.hostId === 'hostB').online, true,
    'the Host was never disconnected')

  // A fresh baseline on the re-opened stream is a projection frame, not a second
  // opening snapshot. The test advances its watermark to 8: ProjectionValueStore
  // drops an equal-seq write, so a same-watermark baseline cannot model a newer
  // selection. The re-open also greets with the old seq-7 block first; read past
  // that until the mid selection shows up.
  hostB.send({ type: 'baseline', value: { projections: {
    s1: projectedSelection('r9-fallback', 'mid-model', 8),
  } } })
  let republished
  const baselineDeadline = Date.now() + 1500
  while (Date.now() < baselineDeadline) {
    const frame = await nextControl(iterator, 'control frame after re-open')
    if (frame.type === 'projection' && frame.sessionId === 'h:hostB:s1'
        && frame.changes.some((entry) => entry.key === 'modelSelection' && entry.val?.next?.model === 'mid-model')) {
      republished = frame
      break
    }
  }
  assert.ok(republished, 'the re-opened stream republished the new selection as a projection')
  assert.deepEqual(republished, {
    type: 'projection', sessionId: 'h:hostB:s1', seq: 8,
    changes: [{ key: 'modelSelection', val: {
      lastUsed: { ...midSelection, provider: 'r9-fallback@hostB' },
      next: { ...midSelection, provider: 'r9-fallback@hostB' },
    } }],
  })

  // A projection increment (seq past the baseline) still reaches the chip after
  // the re-open, and folds into the face whose `next` the model directory reads.
  hostB.send({
    type: 'projection', sessionId: 's1', seq: 9,
    changes: [{ key: 'modelSelection', val: { lastUsed: midSelection, next: newSelection } }],
  })
  const frame = await nextControl(iterator, 'modelSelection projection frame after re-open')
  assert.deepEqual(frame, {
    type: 'projection', sessionId: 'h:hostB:s1', seq: 9,
    changes: [{ key: 'modelSelection', val: {
      lastUsed: { ...midSelection, provider: 'r9-fallback@hostB' },
      next: { ...newSelection, provider: 'r9-fallback@hostB' },
    } }],
  })
  const face = { ...baseline.value.projections['h:hostB:s1'].values.modelSelection }
  for (const update of [republished, frame]) {
    const change = update.changes.find((entry) => entry.key === 'modelSelection')
    face.lastUsed = change.val.lastUsed
    face.next = change.val.next
  }
  assert.deepEqual(face.next, { provider: 'r9-fallback@hostB', model: 'ds41-cmc-ccsonnet' })
  assert.notDeepEqual(face.next, face.lastUsed, 'the chip reads a new selection, not the mid one')
  assertNoNamespacedId(hostB)
  control.abort()
})

test('a host drop emits no baseline; only the reopened baseline rides as projections', async () => {
  // The store does not withdraw a session's projections when a Host disappears,
  // so `drop()` must never publish a replacement baseline. A reopen is allowed,
  // but its greeting baseline is still a projection frame in the one open stream.
  const hostB = createFakeRemote('hostB', 'Host B', {
    controlProjections: { s1: projectedSelection('r9-fallback', 'old-model') },
  })
  const harness = createHarness({ remotes: [hostB] })
  const control = new AbortController()
  const source = await harness.gateway.openWireStream('session/control', { args: {} },
    undefined, {}, control.signal, control, 64)
  const iterator = source[Symbol.asyncIterator]()
  const nextControl = createControlProtocolReader()
  const opening = await nextControl(iterator, 'opening baseline')
  assert.equal(opening.type, 'baseline')

  hostB.closeStream()
  let reopened = false
  const deadline = Date.now() + 1500
  while (Date.now() < deadline) {
    if (hostB.streams.filter((stream) => stream.endpoint === 'session/control').length >= 2) { reopened = true; break }
    await new Promise((resolve) => setTimeout(resolve, 10))
  }
  assert.equal(reopened, true, 'the control stream re-opened before the drop')
  const reopenedGreeting = await nextControl(iterator, 're-opened baseline projection')
  assert.equal(reopenedGreeting.type, 'projection', 'the reopen greeting is not a second baseline')
  assert.equal(reopenedGreeting.sessionId, 'h:hostB:s1')
  assert.deepEqual(reopenedGreeting.changes.map((entry) => entry.key), ['modelSelection'])

  harness.disconnect('hostB')
  const afterDrop = await frameWithin(iterator, 100)
  assert.equal(afterDrop, null, 'a host drop emitted no replacement baseline')
  control.abort()
  await iterator.return()
})

test('a Host that greets with a baseline then closes stops reopening, and abort leaves no pending timer', async () => {
  // Reviewer round 2: an opening baseline must not reset the reopen budget. A
  // Host that sends its normal opening baseline and then closes (or throws a
  // transient error) must not be re-opened every 100 ms forever.
  const hostB = createFakeRemote('hostB', 'Host B')
  const greetedStreams = []
  const originalOpenStream = hostB.connection.openStream.bind(hostB.connection)
  hostB.connection.openStream = async (endpoint, args, options) => {
    if (endpoint !== 'session/control') return originalOpenStream(endpoint, args, options)
    const queue = createQueue()
    greetedStreams.push(queue)
    queue.push({ type: 'baseline', value: { projections: { s1: projectedSelection('r9-fallback', 'old-model') } } })
    // A short-lived stream: closes on its own without any test-side pumping.
    const timer = setTimeout(() => queue.close(), 20)
    timer.unref?.()
    return queue
  }
  const harness = createHarness({ remotes: [hostB] })
  const control = new AbortController()
  const source = await harness.gateway.openWireStream('session/control', { args: {} },
    undefined, {}, control.signal, control, 64)
  const baseline = (await nextFrame(source, 'session/control baseline')).value
  assert.equal(baseline.type, 'baseline')

  // Reopens do happen: the greeting baseline must not have made them unbounded.
  let sawReopen = false
  const firstDeadline = Date.now() + 1500
  while (Date.now() < firstDeadline) {
    if (greetedStreams.length >= 2) { sawReopen = true; break }
    await new Promise((resolve) => setTimeout(resolve, 10))
  }
  assert.equal(sawReopen, true, 'a normally-ended control stream is re-opened at least once')

  // The streak must terminate: the count settles and stays bounded.
  let last = greetedStreams.length
  let stableSince = Date.now()
  const settleDeadline = Date.now() + 3000
  while (Date.now() < settleDeadline) {
    if (greetedStreams.length !== last) { last = greetedStreams.length; stableSince = Date.now() }
    if (greetedStreams.length >= 2 && Date.now() - stableSince > 600) break
    await new Promise((resolve) => setTimeout(resolve, 10))
  }
  assert.ok(greetedStreams.length <= 7,
    `reopening must stop after a small bound, got ${greetedStreams.length}`)
  assert.equal(greetedStreams.length, last, 'reopening settled')

  // Aborting the control must clear the pending reopen delay: no timer storm.
  const atAbort = greetedStreams.length
  control.abort()
  await new Promise((resolve) => setTimeout(resolve, 500))
  assert.equal(greetedStreams.length, atAbort, 'aborting control leaves no pending reopen timer')
})

test('aborting during the first reopen delay cancels that pending reopen', async () => {
  // Reviewer round 3: the case above aborts after the streak has already settled,
  // so it never proves a live timer is cleared. Here the first stream ends at once
  // and the abort lands inside its 100 ms reopen window.
  const hostB = createFakeRemote('hostB', 'Host B')
  const streams = []
  const originalOpenStream = hostB.connection.openStream.bind(hostB.connection)
  let firstEnded
  const firstStreamEnded = new Promise((resolve) => { firstEnded = resolve })
  hostB.connection.openStream = async (endpoint, args, options) => {
    if (endpoint !== 'session/control') return originalOpenStream(endpoint, args, options)
    const queue = createQueue()
    streams.push(queue)
    queue.push({ type: 'baseline', value: { projections: {} } })
    queue.close()
    if (streams.length === 1) firstEnded()
    return queue
  }
  const harness = createHarness({ remotes: [hostB] })
  const control = new AbortController()
  const source = await harness.gateway.openWireStream('session/control', { args: {} },
    undefined, {}, control.signal, control, 64)
  // Pull one frame to start the merge, but abort while the first reopen is pending.
  const firstFrame = nextFrame(source, 'merged baseline before reopen')
  await firstStreamEnded
  await firstFrame
  await new Promise((resolve) => setTimeout(resolve, 10))
  const atAbort = streams.length
  assert.equal(atAbort, 1, 'the first reopen delay is still pending at abort')
  control.abort()
  await new Promise((resolve) => setTimeout(resolve, 400))
  assert.equal(streams.length, atAbort, 'aborting during the delay opens no further control stream')
})

test('a terminal refusal is not retried by a later host-set notification on the same connection', async () => {
  // Reviewer round 2: a refused Host drops its pump, but a later host-set
  // notification used to call start() again and re-open the refused stream.
  let attempts = 0
  const hostB = createFakeRemote('hostB', 'Host B')
  hostB.connection.openStream = async () => {
    attempts += 1
    throw Object.assign(new Error('forbidden'), { code: 'auth/forbidden-scope' })
  }
  const harness = createHarness({ remotes: [hostB] })
  const control = new AbortController()
  const source = await harness.gateway.openWireStream('session/control', { args: {} },
    undefined, {}, control.signal, control, 64)
  const baseline = (await nextFrame(source, 'merged baseline after refusal')).value
  assert.equal(baseline.type, 'baseline')

  const waitForAttempts = async (expected) => {
    const deadline = Date.now() + 1500
    while (Date.now() < deadline) {
      if (attempts >= expected) return true
      await new Promise((resolve) => setTimeout(resolve, 10))
    }
    return false
  }
  assert.equal(await waitForAttempts(1), true, 'the refused stream was attempted once')

  // A host-set notification on the SAME connection must not resurrect the pump.
  harness.connect('hostB')
  await new Promise((resolve) => setTimeout(resolve, 300))
  assert.equal(attempts, 1, 'a terminal refusal is not retried on the same connection')

  // A genuinely new connection for the same Host clears the marker and may retry.
  hostB.connection = {
    state: 'online',
    async openStream() {
      attempts += 1
      const queue = createQueue()
      queue.push({ type: 'baseline', value: { projections: {} } })
      return queue
    },
  }
  harness.connect('hostB')
  assert.equal(await waitForAttempts(2), true, 'a new connection may retry the refused Host')
  control.abort()
})

test('a stale stream refusal cannot blacklist the connection that replaced it', async () => {
  // Reviewer round 3: the terminal-error handler used to record whichever
  // connection was live when the error arrived. If A was replaced by B while A's
  // open was still settling, the host-change notification could not start B (a
  // pump already existed), and A's later refusal then marked B refused instead.
  const hostB = createFakeRemote('hostB', 'Host B')
  const connectionA = hostB.connection
  const originalOpenA = connectionA.openStream.bind(connectionA)
  let rejectA
  const refusalA = new Promise((_resolve, reject) => { rejectA = reject })
  refusalA.catch(() => {})
  let attemptsA = 0
  connectionA.openStream = async (endpoint, args, options) => {
    if (endpoint !== 'session/control') return originalOpenA(endpoint, args, options)
    attemptsA += 1
    await refusalA // settles only after the host has switched to B
  }
  let attemptsB = 0
  const connectionB = {
    state: 'online',
    async openStream(endpoint, args, options) {
      if (endpoint !== 'session/control') return originalOpenA(endpoint, args, options)
      attemptsB += 1
      const queue = createQueue()
      queue.push({ type: 'baseline', value: { projections: {} } })
      return queue
    },
  }
  const harness = createHarness({ remotes: [hostB] })
  const control = new AbortController()
  const source = await harness.gateway.openWireStream('session/control', { args: {} },
    undefined, {}, control.signal, control, 64)
  const baseline = (await nextFrame(source, 'merged baseline while A is pending')).value
  assert.equal(baseline.type, 'baseline')
  assert.equal(attemptsA, 1, 'A opened the first control stream')

  // The host-change notification sees A's live pump and cannot start B yet.
  hostB.connection = connectionB
  harness.connect('hostB')
  assert.equal(attemptsB, 0, 'B is blocked by A pump until A settles')

  const waitFor = async (predicate) => {
    const deadline = Date.now() + 1500
    while (Date.now() < deadline) {
      if (predicate()) return true
      await new Promise((resolve) => setTimeout(resolve, 10))
    }
    return false
  }
  rejectA(Object.assign(new Error('forbidden'), { code: 'auth/forbidden-scope' }))
  assert.equal(await waitFor(() => attemptsB >= 1), true, 'A refusal must hand the slot to B')

  // A refusal recorded against B would survive this remove/re-add on the SAME
  // connection object and suppress the retry. No marker belongs to B here.
  harness.disconnect('hostB')
  await new Promise((resolve) => setTimeout(resolve, 50))
  harness.connect('hostB')
  assert.equal(await waitFor(() => attemptsB >= 2), true, 'B was not marked refused by A')
  control.abort()
})

test('a host removed from the inventory loses its refusal marker', async () => {
  // Reviewer round 3: a marker for a host that left the configured inventory
  // must not outlive it, while an offline paired host keeps its marker.
  const hostB = createFakeRemote('hostB', 'Host B')
  const originalOpenStream = hostB.connection.openStream.bind(hostB.connection)
  let attempts = 0
  hostB.connection.openStream = async (endpoint, args, options) => {
    if (endpoint !== 'session/control') return originalOpenStream(endpoint, args, options)
    attempts += 1
    if (attempts === 1) throw Object.assign(new Error('forbidden'), { code: 'auth/forbidden-scope' })
    const queue = createQueue()
    queue.push({ type: 'baseline', value: { projections: {} } })
    return queue
  }
  const harness = createHarness({ remotes: [hostB] })
  const control = new AbortController()
  const source = await harness.gateway.openWireStream('session/control', { args: {} },
    undefined, {}, control.signal, control, 64)
  const baseline = (await nextFrame(source, 'merged baseline after refusal')).value
  assert.equal(baseline.type, 'baseline')
  const waitFor = async (expected) => {
    const deadline = Date.now() + 1500
    while (Date.now() < deadline) {
      if (attempts >= expected) return true
      await new Promise((resolve) => setTimeout(resolve, 10))
    }
    return false
  }
  assert.equal(await waitFor(1), true, 'the refusal was observed')

  // Remove the host from BOTH connected hosts and knownHosts, then re-add the
  // same connection object: the old marker must have been pruned on removal.
  harness.remotes.length = 0
  harness.disconnect('hostB')
  await new Promise((resolve) => setTimeout(resolve, 50))
  harness.remotes.push(hostB)
  harness.connect('hostB')
  assert.equal(await waitFor(2), true, 'a Host re-added after removal is not suppressed')
  control.abort()
})

test('a provider tagged for another host is refused instead of being rerouted', async () => {
  const hostB = createFakeRemote('hostB', 'Host B')
  const harness = createHarness({ remotes: [hostB] })
  // The session is hostB's, but the provider belongs to hostC: two hosts in one
  // call is exactly the cross-routing this refusal exists for.
  const answer = await harness.gateway.dispatchRpc('session/selectModel', {
    args: { sessionId: 'h:hostB:s1', provider: 'r9-fallback@hostC', model: 'm' },
  }, undefined, {})
  assert.equal(answer.ok, false)
  assert.equal(answer.error.code, 'model/wrong-host')
  assert.equal(answer.error.details.hostId, 'hostC')
  assert.equal(hostB.calls.length, 0, 'nothing was sent to either host')
  assert.equal(harness.localCalls.length, 0, 'and nothing was run locally')
})

test('an untagged provider on a remote session is refused: a Local model is not a fallback', async () => {
  const hostB = createFakeRemote('hostB', 'Host B')
  const harness = createHarness({ remotes: [hostB] })
  const answer = await harness.gateway.dispatchRpc('session/selectModel', {
    args: { sessionId: 'h:hostB:s1', provider: 'deepseek-official', model: 'deepseek-chat' },
  }, undefined, {})
  assert.equal(answer.ok, false)
  assert.equal(answer.error.code, 'model/wrong-host')
  assert.equal(answer.error.details.hostId, 'hostB')
  assert.equal(hostB.calls.length, 0)
})

test('a tagged provider on a Local session is refused: it would run on another machine', async () => {
  const harness = createHarness()
  for (const provider of ['r9-fallback@hostB', 'deepseek-official@hostB']) {
    const answer = await harness.gateway.dispatchRpc('session/selectModel',
      { args: { sessionId: 's1', provider, model: 'm' } }, undefined, {})
    assert.equal(answer.ok, false, provider)
    assert.equal(answer.error.code, 'model/wrong-host')
    assert.equal(answer.error.details.hostId, 'hostB')
  }
  assert.equal(harness.localCalls.length, 0, 'the Local carrier never saw the call')
})

test('a tagged provider is refused even with zero hosts: the zero-host passthrough is not a route', async () => {
  // The passthrough that lets a purely Local call reach Local byte for byte must
  // not swallow a provider tag: the tag IS the route, and forwarding it would run
  // another machine's model here.
  const harness = createHarness({ remotes: [] })
  const both = [
    { args: { sessionId: 's1', provider: 'r9-fallback@hostB', model: 'm' } },
    // The nested `request` shape the gateway also accepts.
    { args: { request: { sessionId: 's1', provider: 'r9-fallback@hostB', model: 'm' } } },
  ]
  for (const payload of both) {
    const answer = await harness.gateway.dispatchRpc('session/selectModel', payload, undefined, {})
    assert.equal(answer.ok, false, JSON.stringify(payload))
    assert.equal(answer.error.code, 'model/wrong-host')
    assert.equal(answer.error.details.hostId, 'hostB')
  }
  assert.equal(harness.localCalls.length, 0, 'nothing ran locally, with no host paired or connected')
  // The semantic survives: with no host at all, a Local selection is still untouched.
  const local = await harness.gateway.dispatchRpc('session/selectModel',
    { args: { sessionId: 's1', provider: 'deepseek-official', model: 'm' } }, undefined, {})
  assert.deepEqual(local, { ok: true, value: { local: 'session/selectModel' } })
  assert.equal(harness.localCalls.length, 1)
})

test('two hosts offering the same provider stay two sections, in host order after Local', async () => {
  // The one thing the old merge did was collapse remote groups: same provider id
  // meant "the same selection". With the host in the id they are two selections on
  // two machines, and the picker must offer both.
  const hostB = createFakeRemote('hostB', 'Host B', { replies: {
    'session/modelCatalog': catalog([providerGroup('r9-fallback', 'R9 Fallback', ['ds41-cmc-ccsonnet'])]),
  } })
  const hostC = createFakeRemote('hostC', 'Host C', { replies: {
    'session/modelCatalog': catalog([providerGroup('r9-fallback', 'R9 Fallback', ['ds41-cmc-ccsonnet'])]),
  } })
  const harness = createHarness({
    remotes: [hostB, hostC],
    dispatchRpc: localCatalog([providerGroup('r9-fallback', 'R9 Fallback', ['ds41-cmc-ccsonnet'])]),
  })
  const value = (await harness.gateway.dispatchRpc('session/modelCatalog', { args: {} }, undefined, {})).value
  assert.deepEqual(value.groups.map((group) => [group.id, group.name]), [
    ['r9-fallback', 'R9 Fallback'],
    ['r9-fallback@hostB', 'Remote · Host B — R9 Fallback'],
    ['r9-fallback@hostC', 'Remote · Host C — R9 Fallback'],
  ], 'Local first, then every host in connected order — nothing is collapsed')
  // Same provider/model, three distinct routes: each one is its own selection.
  assert.equal(new Set(value.groups.map((group) => group.id)).size, 3)
})

test('a remote model selection reaches the picker tagged, in every payload that carries one', async () => {
  // The picker reads a session's selection from the projection, which arrives in
  // three shapes the router ingresses: a `session/list` row, the `session/follow`
  // opening snapshot, and the `session/selectModel` result.
  const hostB = createFakeRemote('hostB', 'Host B', { replies: {
    'session/list': { items: [session('sb1', 200, { projections: projectedSelection('r9-fallback', 'ds41-cmc-ccsonnet') })] },
    'session/projections': projectedSelection('r9-fallback', 'ds41-cmc-ccsonnet'),
    'session/modelCatalog': catalog([providerGroup('r9-fallback', 'R9 Fallback', ['ds41-cmc-ccsonnet'])]),
  } })
  const harness = createHarness({
    remotes: [hostB],
    dispatchRpc: localCatalog([providerGroup('deepseek-official', 'DeepSeek', ['deepseek-chat'])]),
  })
  const listed = await harness.gateway.dispatchRpc('session/list', { args: {} }, undefined, {})
  assert.deepEqual(listed.value.items[0].projections.values.modelSelection, {
    lastUsed: { provider: 'r9-fallback@hostB', model: 'ds41-cmc-ccsonnet' },
    next: { provider: 'r9-fallback@hostB', model: 'ds41-cmc-ccsonnet' },
  })
  assert.equal(listed.value.items[0].sessionId, 'h:hostB:sb1', 'ids are namespaced as before')
  assert.equal(listed.value.items[0].projections.asOfSeq, 7, 'the block watermark is untouched')
  // The opening snapshot of a followed session carries the same block.
  const control = new AbortController()
  const source = await harness.gateway.openWireStream('session/follow',
    { args: { request: { address: { kind: 'session', sessionId: 'h:hostB:sb1' } } } },
    undefined, {}, control.signal, control, 64)
  const iterator = source[Symbol.asyncIterator]()
  hostB.streams.at(-1).queue.push({
    type: 'snapshot',
    header: { version: 4, id: 'sb1' },
    projections: projectedSelection('deepseek-official', 'deepseek-reasoner'),
  })
  const snapshot = (await nextFrame(iterator, 'follow snapshot')).value
  assert.deepEqual(snapshot.projections.values.modelSelection.next,
    { provider: 'deepseek-official@hostB', model: 'deepseek-reasoner' })
  assert.deepEqual(snapshot.header, { version: 4, id: 'h:hostB:sb1' })
  control.abort()
  await iterator.return()
  // `session/projections` is the on-demand read the picker re-syncs with, so the
  // same block must arrive tagged there too (`{kind, asOfSeq, values}`).
  const reread = await harness.gateway.dispatchRpc('session/projections',
    { args: { sessionId: 'h:hostB:sb1' } }, undefined, {})
  assert.deepEqual(reread.value.values.modelSelection.next,
    { provider: 'r9-fallback@hostB', model: 'ds41-cmc-ccsonnet' })
  assert.equal(reread.value.kind, 'sequenced')
  assert.deepEqual(hostB.calls.at(-1).args, { sessionId: 'sb1' })
  // End to end: the tag ingress minted is the tag the merged catalog publishes, so
  // the picker's `routable` check finds this session's own provider, while the
  // Local group with the same raw id stays a different section.
  const catalogValue = (await harness.gateway.dispatchRpc('session/modelCatalog', { args: {} }, undefined, {})).value
  assert.deepEqual(catalogValue.groups.map((group) => group.id), ['deepseek-official', 'r9-fallback@hostB'])
  assert.equal(catalogValue.groups.some((group) => group.id === listed.value.items[0].projections.values.modelSelection.next.provider
    && group.models.some((model) => model.id === 'ds41-cmc-ccsonnet')), true)
  assert.equal(catalogValue.groups.some((group) => group.id === snapshot.projections.values.modelSelection.next.provider), false,
    'a provider this Host does not offer stays unavailable — it never falls back to the Local group of the same name')
})

test('a host joining or leaving the connected set asks the picker to reload the catalog; a flap does not', async () => {
  // The rule is the catalog's COVERAGE of the connected set (`#catalogHostKey`), not
  // the connect/disconnect edge: a reload racing a host's link used to leave the
  // picker Local-only with no further edge to repair it (see the race test below).
  const catalogOf = catalog([providerGroup('r9-fallback', 'R9 Fallback', ['ds41-cmc-ccsonnet'])])
  const hostB = createFakeRemote('hostB', 'Host B', { replies: { 'session/modelCatalog': catalogOf } })
  const hostC = createFakeRemote('hostC', 'Host C', { replies: { 'session/modelCatalog': catalogOf } })
  const harness = createHarness({
    remotes: [hostB, hostC],
    // hostC is paired but not connected yet, so the connected set starts as {hostB}. It is
    // withheld HERE, not with `disconnect` below: that emits a host change before the
    // `$events` sink exists, and the sink would then announce the shrunk set at open.
    connected: ['hostB'],
    dispatchRpc: localCatalog([providerGroup('r9-fallback', 'R9 Fallback', ['ds41-cmc-ccsonnet'])]),
  })
  const control = new AbortController()
  const source = await harness.gateway.openWireStream('$events', { args: {} }, undefined, {}, control.signal, control, 64)
  const iterator = source[Symbol.asyncIterator]()
  const ready = iterator.next()
  await new Promise((resolve) => setImmediate(resolve))
  harness.localStreams[0].queue.push({ type: 'ready', clientId: 'c1', host: { home: '/home/owner' } })
  assert.equal((await ready).value.type, 'ready')

  // A notify that leaves the SET unchanged is silent: the marker pushed through the
  // Local stream is the very next frame. No catalog has been merged yet, so nothing
  // is known about the picker's catalog and only a change of set is announced.
  harness.connect('hostB')
  harness.connect('hostB')
  harness.localStreams[0].queue.push({ type: 'emit', event: 'local/marker', args: [] })
  assert.deepEqual((await nextFrame(iterator, 'local marker')).value, { type: 'emit', event: 'local/marker', args: [] })

  // The catalog the picker loaded while hostC was still linking covers {hostB} only.
  // hostC then joins: the connected set is no longer that key, so the picker is told
  // to reload. The frame carries exactly the three keys the client's `$events`
  // parser accepts.
  await harness.gateway.dispatchRpc('session/modelCatalog', { args: {} }, undefined, {})
  harness.connect('hostC')
  const refresh = (await nextFrame(iterator, 'catalog refresh')).value
  assert.deepEqual(refresh, { type: 'emit', event: 'llm/models-updated', args: [] })
  assert.deepEqual(Object.keys(refresh).sort(), ['args', 'event', 'type'])

  // The answer that now covers both hosts, then a re-identify flap that leaves the
  // set exactly as it was: the picker already holds these hosts, so the SAME set says
  // nothing — even though a connect/disconnect edge happened.
  await harness.gateway.dispatchRpc('session/modelCatalog', { args: {} }, undefined, {})
  harness.disconnect('hostC')
  harness.connect('hostC')
  harness.localStreams[0].queue.push({ type: 'emit', event: 'local/marker', args: [] })
  assert.deepEqual((await nextFrame(iterator, 'local marker after a re-identified set')).value,
    { type: 'emit', event: 'local/marker', args: [] }, 'no reload when the catalog already includes every connected host')

  // hostC leaves while the catalog still names it: the picker holds a section whose
  // Host is gone, so the connected set no longer equals the key and the picker is told.
  // (`#catalogHostKey` records what the last answer covered. A disconnect updates the
  // picker only through this frame, so there is no answer to re-key against first.)
  harness.disconnect('hostC')
  assert.deepEqual((await nextFrame(iterator, 'catalog refresh after disconnect')).value,
    { type: 'emit', event: 'llm/models-updated', args: [] })

  // hostC reconnects while its catalog FAILS, so the merged answer leaves it out: a
  // reload racing that failure is what used to strand the picker with Local only, so
  // the next answer says so instead of keeping it quiet.
  hostC.connection.call = async () => { throw Object.assign(new Error('no catalog'), { code: 'auth/forbidden-scope' }) }
  harness.connect('hostC')
  const short = (await harness.gateway.dispatchRpc('session/modelCatalog', { args: {} }, undefined, {})).value
  assert.deepEqual(short.groups.map((group) => group.id), ['r9-fallback', 'r9-fallback@hostB'],
    'a host that fails twice contributes no section')
  assert.deepEqual((await nextFrame(iterator, 'catalog refresh after a short answer')).value,
    { type: 'emit', event: 'llm/models-updated', args: [] },
    'a catalog shorter than the connected set asks for a reload')

  control.abort()
  await iterator.return()
})

// -- model catalog: what the picker is holding --------------------------------
//
// The picker caches ONE merged catalog per Host generation and reloads it only on
// `llm/models-updated`. A catalog loaded before a remote Host linked — or answered
// while that Host's own catalog call was failing — therefore lists Local only, and
// every remote pick from it is refused by `routedProvider` (`remote/wrong-host`).
// So the router keeps `#catalogHostKey`, the hosts the last answer really included,
// and reloads whenever the connected set is not that key.

test('a catalog loaded before the host linked is repaired when $events opens', async () => {
  const hostB = createFakeRemote('hostB', 'Host B', { replies: {
    'session/modelCatalog': catalog([providerGroup('r9-fallback', 'R9 Fallback', ['ds41-cmc-ccsonnet'])]),
  } })
  const harness = createHarness({
    remotes: [hostB],
    dispatchRpc: localCatalog([providerGroup('deepseek-official', 'DeepSeek', ['deepseek-chat'])]),
  })
  harness.disconnect('hostB')
  // The UI's own load, while hostB is still linking: Local's sections only.
  const early = (await harness.gateway.dispatchRpc('session/modelCatalog', { args: {} }, undefined, {})).value
  assert.deepEqual(early.groups.map((group) => group.id), ['deepseek-official'])

  // The host links; the picker is not reloaded (no `$events` stream yet).
  harness.connect('hostB')
  const control = new AbortController()
  const source = await harness.gateway.openWireStream('$events', { args: {} }, undefined, {}, control.signal, control, 64)
  const iterator = source[Symbol.asyncIterator]()
  const ready = iterator.next()
  await new Promise((resolve) => setImmediate(resolve))
  harness.localStreams[0].queue.push({ type: 'ready', clientId: 'c1', host: { home: '/home/owner' } })
  assert.equal((await ready).value.type, 'ready')
  // No edge can repair that catalog any more: hostB connected before the stream
  // opened, so the reload is owed at `ready`, where it can actually reach the UI.
  assert.deepEqual((await nextFrame(iterator, 'catalog refresh after ready')).value,
    { type: 'emit', event: 'llm/models-updated', args: [] })
  const reloaded = (await harness.gateway.dispatchRpc('session/modelCatalog', { args: {} }, undefined, {})).value
  assert.deepEqual(reloaded.groups.map((group) => group.id), ['deepseek-official', 'r9-fallback@hostB'])
  harness.localStreams[0].queue.push({ type: 'emit', event: 'local/marker', args: [] })
  assert.deepEqual((await nextFrame(iterator, 'marker after the reload')).value, { type: 'emit', event: 'local/marker', args: [] },
    'the covering answer asks for nothing further')
  control.abort()
  await iterator.return()
})

test('a host whose catalog keeps failing is announced exactly once, then recovers', async () => {
  let reply = Object.assign(new Error('no catalog'), { code: 'auth/forbidden-scope', scope: 'prompt:send' })
  const hostB = createFakeRemote('hostB', 'Host B', { replies: { get 'session/modelCatalog'() { return reply } } })
  const harness = createHarness({
    remotes: [hostB],
    dispatchRpc: localCatalog([providerGroup('deepseek-official', 'DeepSeek', ['deepseek-chat'])]),
  })
  const control = new AbortController()
  const source = await harness.gateway.openWireStream('$events', { args: {} }, undefined, {}, control.signal, control, 64)
  const iterator = source[Symbol.asyncIterator]()
  const ready = iterator.next()
  await new Promise((resolve) => setImmediate(resolve))
  harness.localStreams[0].queue.push({ type: 'ready', clientId: 'c1', host: { home: '/home/owner' } })
  assert.equal((await ready).value.type, 'ready')
  const short = await harness.gateway.dispatchRpc('session/modelCatalog', { args: {} }, undefined, {})
  assert.deepEqual(short.value.groups.map((group) => group.id), ['deepseek-official'])
  assert.equal(hostB.calls.length, 2, 'the failing host is asked once, then retried once')
  // One frame, then quiet: the picker reloading again would find the same short
  // catalog, so a second emit per failure would only cost a round trip.
  assert.deepEqual((await nextFrame(iterator, 'catalog refresh')).value,
    { type: 'emit', event: 'llm/models-updated', args: [] })
  await harness.gateway.dispatchRpc('session/modelCatalog', { args: {} }, undefined, {})
  harness.localStreams[0].queue.push({ type: 'emit', event: 'local/marker', args: [] })
  assert.deepEqual((await nextFrame(iterator, 'local marker while still failing')).value,
    { type: 'emit', event: 'local/marker', args: [] })

  // The Host answers again: the answer covers the set, so the picker needs nothing.
  reply = catalog([providerGroup('r9-fallback', 'R9 Fallback', ['ds41-cmc-ccsonnet'])])
  const healed = (await harness.gateway.dispatchRpc('session/modelCatalog', { args: {} }, undefined, {})).value
  assert.deepEqual(healed.groups.map((group) => group.id), ['deepseek-official', 'r9-fallback@hostB'])
  harness.localStreams[0].queue.push({ type: 'emit', event: 'local/marker', args: [] })
  assert.deepEqual((await nextFrame(iterator, 'local marker after recovery')).value,
    { type: 'emit', event: 'local/marker', args: [] })
  control.abort()
  await iterator.return()
})

test('a permanently failing catalog does not re-arm the refresh timer on each picker reload', async () => {
  // Reviewer finding 3: #catalogHostKey stays short of the connected host, so a
  // reload the previous emit asked for used to look "stale" again and schedule the
  // next timer — a permanent once-a-second reload loop. Across a FULL interval the
  // picker must stay quiet about the same failure.
  const refusal = Object.assign(new Error('no catalog'), { code: 'auth/forbidden-scope', scope: 'prompt:send' })
  const hostB = createFakeRemote('hostB', 'Host B', { replies: { 'session/modelCatalog': refusal } })
  const harness = createHarness({
    remotes: [hostB],
    dispatchRpc: localCatalog([providerGroup('deepseek-official', 'DeepSeek', ['deepseek-chat'])]),
  })
  const control = new AbortController()
  const source = await harness.gateway.openWireStream('$events', { args: {} }, undefined, {}, control.signal, control, 64)
  const iterator = source[Symbol.asyncIterator]()
  const ready = iterator.next()
  await new Promise((resolve) => setImmediate(resolve))
  harness.localStreams[0].queue.push({ type: 'ready', clientId: 'c1', host: { home: '/home/owner' } })
  assert.equal((await ready).value.type, 'ready')

  await harness.gateway.dispatchRpc('session/modelCatalog', { args: {} }, undefined, {})
  assert.deepEqual((await nextFrame(iterator, 'the one refresh')).value,
    { type: 'emit', event: 'llm/models-updated', args: [] })
  // Two more picker reloads, spanning the whole rate-limit window: the SAME stale
  // state is already announced and must not emit a second frame or schedule a retry.
  await harness.gateway.dispatchRpc('session/modelCatalog', { args: {} }, undefined, {})
  await new Promise((resolve) => setTimeout(resolve, 1200))
  await harness.gateway.dispatchRpc('session/modelCatalog', { args: {} }, undefined, {})
  harness.localStreams[0].queue.push({ type: 'emit', event: 'local/marker', args: [] })
  assert.deepEqual((await nextFrame(iterator, 'the marker after a full interval')).value,
    { type: 'emit', event: 'local/marker', args: [] }, 'the failing catalog stayed quiet')
  control.abort()
  await iterator.return()
})

test('a catalog call that fails once is retried: the section is there and nothing is announced', async () => {
  const refusal = Object.assign(new Error('no catalog yet'), { code: 'remote/not-ready' })
  let calls = 0
  const reply = catalog([providerGroup('r9-fallback', 'R9 Fallback', ['ds41-cmc-ccsonnet'])])
  const connection = {
    state: 'online',
    async call() { calls += 1; if (calls === 1) throw refusal; return structuredClone(reply) },
    async openStream() { throw new Error('not used in this test') },
    // The merged `$events` watcher only listens on a live connection object.
    on() {},
    off() {},
  }
  const hostB = { hostId: 'hostB', hostName: 'Host B', connection }
  const harness = createHarness({
    remotes: [hostB],
    dispatchRpc: localCatalog([providerGroup('deepseek-official', 'DeepSeek', ['deepseek-chat'])]),
  })
  const control = new AbortController()
  const source = await harness.gateway.openWireStream('$events', { args: {} }, undefined, {}, control.signal, control, 64)
  const iterator = source[Symbol.asyncIterator]()
  const ready = iterator.next()
  await new Promise((resolve) => setImmediate(resolve))
  harness.localStreams[0].queue.push({ type: 'ready', clientId: 'c1', host: { home: '/home/owner' } })
  assert.equal((await ready).value.type, 'ready')

  // The retry lands inside the one answer: the picker gets the section without a
  // reload, and the host's refused call leaves no error on its row.
  const value = (await harness.gateway.dispatchRpc('session/modelCatalog', { args: {} }, undefined, {})).value
  assert.deepEqual(value.groups.map((group) => group.id), ['deepseek-official', 'r9-fallback@hostB'])
  assert.equal(calls, 2, 'one failure, one retry')
  assert.equal(harness.router.status().hosts[0].error, undefined)
  harness.localStreams[0].queue.push({ type: 'emit', event: 'local/marker', args: [] })
  assert.deepEqual((await nextFrame(iterator, 'local marker')).value, { type: 'emit', event: 'local/marker', args: [] },
    'a retried answer that covers the set needs no reload')
  control.abort()
  await iterator.return()
})

test('a Local provider on a new remote session is still refused: repairing the catalog adds routes, it does not invent one', async () => {
  const hostB = createFakeRemote('hostB', 'Host B', { replies: {
    'session/modelCatalog': catalog([providerGroup('r9-fallback', 'R9 Fallback', ['ds41-cmc-ccsonnet'])]),
  } })
  const harness = createHarness({
    remotes: [hostB],
    dispatchRpc: localCatalog([providerGroup('deepseek-official', 'DeepSeek', ['deepseek-chat'])]),
  })
  // The repaired catalog offers Local's provider only as a LOCAL section, so the
  // same pick on hostB's session is a refusal, never a cross-host run.
  await harness.gateway.dispatchRpc('session/modelCatalog', { args: {} }, undefined, {})
  const answer = await harness.gateway.dispatchRpc('session/selectModel',
    { args: { sessionId: 'h:hostB:new', provider: 'deepseek-official', model: 'deepseek-chat' } }, undefined, {})
  assert.equal(answer.ok, false)
  assert.equal(answer.error.code, 'model/wrong-host')
  assert.equal(answer.error.details.hostId, 'hostB')
  assert.equal(hostB.calls.length, 1, 'only the catalog call crossed the wire')
  assertNoNamespacedId(hostB)
})

// -- transport: remote streams --------------------------------------------

// -- reload stacking (measured live on 0.2.2-rc.1) --------------------------

test('a reload that stacks a second router never breaks the carrier', async () => {
  const harness = createHarness()
  const dsh = harness.gateway.dispatchRpc
  // Router A installs, then a reload installs Router B on top of A's wrapper.
  const a = harness.router
  const b = createHostRouter({
    gateway: harness.gateway,
    dshVersion: PINNED_DSH_VERSION,
    hosts: () => [],
    onHostsChanged: () => () => {},
    approvals: { pending: () => [], onCard: () => () => {} },
    audit: () => {},
  })
  b.install()
  // A is disposed first (the reload order that used to null A's originals while
  // A's wrapper was still under B) — a call must still reach the real DSH method.
  a.uninstall()
  const reply = await harness.gateway.dispatchRpc('session/list', { args: {} }, undefined, {})
  assert.ok(reply, 'the carrier still answers')
  assert.equal(harness.gateway.dispatchRpc, harness.gateway.dispatchRpc)
  b.uninstall()
  assert.equal(harness.gateway.dispatchRpc, dsh, 'the true DSH original is restored')
})

// -- index.mjs wiring ------------------------------------------------------

test('GET /devices/remotes exposes the routing status and teardown restores the carrier', async () => {
  const harness = createHarness()
  const original = harness.gateway.dispatchRpc
  const mounted = await mountPlugin({ services: { typertGateway: harness.gateway },
    // The running DSH version resolved from process.argv is not this test runner.
    testDshVersion: PINNED_DSH_VERSION })
  const answer = await mounted.call('GET', '/devices/remotes')
  assert.equal(answer.status, 200)
  assert.equal(answer.json.routing.remote, true)
  assert.equal(answer.json.routing.reason, null)
  assert.deepEqual(answer.json.routing.merged, ['session/list', 'workspace/follow', 'session/modelCatalog'])
  assert.equal(harness.gateway.dispatchRpc.length, 4, 'the Host carrier is wrapped while the plugin is mounted')
  mounted.close()
  assert.equal(harness.gateway.dispatchRpc, original, 'plugin teardown uninstalls the wrapper')
})

test('remoteSessions:false leaves the carrier alone and reports why', async () => {
  const harness = createHarness()
  const original = harness.gateway.dispatchRpc
  const mounted = await mountPlugin({ remoteSessions: false, services: { typertGateway: harness.gateway } })
  const answer = await mounted.call('GET', '/devices/remotes')
  assert.deepEqual(answer.json.routing, { remote: false, reason: 'disabled', hosts: [], merged: [] })
  assert.equal(harness.gateway.dispatchRpc, original)
  mounted.close()
})

// Owner defect (DSH desktop, profile `desktop`, `remotes: []`): "New session" in a Workspace left
// the composer's Workspace chip on "Choose workspace" and minted no Session. With no remote paired
// every authoring call belongs to Local, so the wrapper must be a pure pass-through for
// `session/create`: the request goes to the ROOT DSH carrier byte-for-byte (an untagged Local
// `workspaceId` is never stripped, tagged, or refused) and the Host's `{sessionId}` reply reaches the
// UI unwrapped, which is what lets the native `startSession` open the new Session.
// Source: `dsh-api-session-controller` `session/create { workspaceId?, cwd?, sessionId?, agentPreset? }
// → { sessionId, agentPreset? }`; `dsh-client-ui-workspace` opens the returned id directly.
test('session/create with no remote host reaches Local unchanged and its sessionId is not rewritten', async () => {
  const verdict = { ok: true, value: { sessionId: 'session-566b825c-3954-4fd4-9f45-690c3273e315', agentPreset: 'standard' } }
  const harness = createHarness({ remotes: [], dispatchRpc: () => verdict })
  assert.equal(harness.status.remote, true, 'the wrapper is installed even with zero hosts')

  const payload = { args: { workspaceId: 'ea6ef60e-f343-4517-a00b-7b9a1cbc879a' } }
  const answer = await harness.gateway.dispatchRpc('session/create', payload, undefined, {})
  assert.equal(harness.localCalls.at(-1).payloadSeen, payload,
    'the Local call keeps the caller\'s exact payload object: no hint, no strip, no tag, no copy')
  assert.deepEqual(harness.localCalls.at(-1), { endpoint: 'session/create', payload, payloadSeen: payload })
  assert.deepEqual(answer, verdict, 'the {sessionId} reply is returned untouched')

  // The same rule for the two workspaces the owner reported, one on another volume.
  for (const workspaceId of ['ea6ef60e-f343-4517-a00b-7b9a1cbc879a', '7df03885-fb65-43a1-bbe4-fdf2b65dac01']) {
    await harness.gateway.dispatchRpc('session/create', { args: { workspaceId } }, undefined, {})
    assert.deepEqual(harness.localCalls.at(-1).payload, { args: { workspaceId } },
      `${workspaceId}: the id is forwarded as the UI sent it`)
  }
  assert.equal([...hostIdsIn(harness.localCalls.at(-1).payload)].length, 0, 'nothing is namespaced')
  assert.deepEqual(harness.remotes.length, 0, 'no remote was asked')
})

test('RemoteConnection.call stops waiting when the caller cancels', async () => {
  const sent = []
  const connection = new RemoteConnection({ remote: { publicUrl: 'wss://127.0.0.1:9' }, readToken: () => 'token' })
  connection.ws = { readyState: 1, send(text, callback) { sent.push(JSON.parse(text)); callback?.() } }
  connection.state = 'online'
  const control = new AbortController()
  const pending = connection.call('session/prompt', { sessionId: 's1' }, { signal: control.signal })
  pending.catch(() => {})
  // `call` awaits the connection before it writes the frame.
  await new Promise((resolve) => setImmediate(resolve))
  assert.equal(sent[0].type, 'remote-call')
  control.abort()
  await assert.rejects(() => pending, (error) => error.code === 'cancelled')
  assert.equal(connection.waiters.size, 0, 'no waiter is left behind')
})

test('RemoteConnection.openStream speaks remote-stream-open and cancels on abort', async () => {
  const sent = []
  const fakeSocket = {
    readyState: 1,
    send(text, callback) { sent.push(JSON.parse(text)); callback?.() },
  }
  const connection = new RemoteConnection({ remote: { publicUrl: 'wss://127.0.0.1:9' }, readToken: () => 'token' })
  connection.ws = fakeSocket
  connection.state = 'online'

  const control = new AbortController()
  const source = await connection.openStream('session/follow', { request: { address: { kind: 'session', sessionId: 's1' } } }, { signal: control.signal })
  assert.equal(sent[0].type, 'remote-stream-open')
  assert.match(sent[0].streamId, /^[A-Za-z0-9._-]{1,64}$/)
  assert.equal(sent[0].streamId.startsWith('res.'), false)
  assert.equal(sent[0].endpoint, 'session/follow')
  assert.deepEqual(sent[0].args, { request: { address: { kind: 'session', sessionId: 's1' } } })

  const iterator = source[Symbol.asyncIterator]()
  const pending = iterator.next()
  control.abort()
  assert.equal(sent[1].type, 'remote-stream-cancel')
  assert.equal(sent[1].streamId, sent[0].streamId)
  await assert.rejects(() => pending, (error) => error.code === 'cancelled')
  assert.equal(connection.wireStreams.size, 0, 'the stream is released')
})

test('a resumed session/follow honours an overflow marker before walking the Host\'s huge created end', async () => {
  // A remote Host may name a `created` fill with an `end` far past the reader. The
  // repair already returns a resume-overflow marker for it; the pump must act on
  // that marker BEFORE enumerating the range. A full walk would never finish.
  const hostB = createFakeRemote('hostB', 'Host B')
  const harness = createHarness({ remotes: [hostB] })
  const control = new AbortController()
  const source = await harness.gateway.openWireStream('session/follow',
    { args: { request: { address: { kind: 'session', sessionId: 'h:hostB:s1' } } } },
    undefined, {}, control.signal, control, 64)
  const iterator = source[Symbol.asyncIterator]()
  const openingStream = hostB.streams.at(-1)
  openingStream.queue.push({ type: 'snapshot', cursor: 1, header: { version: 4, id: 's1' } })
  assert.equal((await nextFrame(iterator, 'first opening snapshot')).value.type, 'snapshot')
  // The stream ends normally; the pump re-opens it and the second attempt is a RESUME.
  openingStream.queue.close()
  let resumedStream
  const reopenDeadline = Date.now() + 1500
  while (Date.now() < reopenDeadline) {
    if (hostB.streams.length >= 2) { resumedStream = hostB.streams.at(-1); break }
    await new Promise((resolve) => setTimeout(resolve, 10))
  }
  assert.ok(resumedStream, 'the follow re-opened after the stream ended')
  // The re-open's snapshot opens this page (its own events are already seen, so it
  // is not forwarded); the next created record is part of it, and followFrames has
  // already turned its huge end into an overflow marker.
  resumedStream.queue.push({ type: 'snapshot', cursor: 1, header: { version: 4, id: 's1' } })
  const hugeEnd = Number.MAX_SAFE_INTEGER
  resumedStream.queue.push({ firstLiveSeq: 2, end: hugeEnd })
  let terminal
  try { await nextFrame(iterator, 'resume overflow') } catch (error) { terminal = error }
  assert.equal(terminal?.code, 'remote/stream-resume-overflow', 'the resized follow failed visibly')
  assert.equal(terminal?.details?.unseen, hugeEnd - 2 + 1,
    'the count is computed from the Host end — no integer range was enumerated')
  control.abort()
  await iterator.return()
})

test('a resumed session/follow bounds an unmarked huge created end at MAX_RESUME_GAP', async () => {
  // The same huge end BEFORE the re-open's snapshot has no marker to short-circuit:
  // the pump's own bound must stop inserting once the page Set crosses the gap.
  const hostB = createFakeRemote('hostB', 'Host B')
  const harness = createHarness({ remotes: [hostB] })
  const control = new AbortController()
  const source = await harness.gateway.openWireStream('session/follow',
    { args: { request: { address: { kind: 'session', sessionId: 'h:hostB:s1' } } } },
    undefined, {}, control.signal, control, 64)
  const iterator = source[Symbol.asyncIterator]()
  const openingStream = hostB.streams.at(-1)
  openingStream.queue.push({ type: 'snapshot', cursor: 1, header: { version: 4, id: 's1' } })
  assert.equal((await nextFrame(iterator, 'first opening snapshot')).value.type, 'snapshot')
  openingStream.queue.close()
  let resumedStream
  const reopenDeadline = Date.now() + 1500
  while (Date.now() < reopenDeadline) {
    if (hostB.streams.length >= 2) { resumedStream = hostB.streams.at(-1); break }
    await new Promise((resolve) => setTimeout(resolve, 10))
  }
  assert.ok(resumedStream, 'the follow re-opened after the stream ended')
  resumedStream.queue.push({ firstLiveSeq: 2, end: Number.MAX_SAFE_INTEGER })
  let terminal
  try { await nextFrame(iterator, 'bounded resume overflow') } catch (error) { terminal = error }
  assert.equal(terminal?.code, 'remote/stream-resume-overflow', 'the unmarked huge end is refused')
  assert.equal(terminal?.details?.unseen, 4097, 'count stops at MAX_RESUME_GAP + 1, not the Host end')
  control.abort()
  await iterator.return()
})

