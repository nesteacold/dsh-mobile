// Spec 008 P2a — the multi-host gateway wrapper (lib/host-router.mjs).
//
// Runs with `node --test --test-isolation=none test/host-router.test.mjs`. No real
// socket is involved: the local carrier is a fake `typertGateway` with the rc.1
// signatures and each remote is a stub `RemoteConnection`, so every assertion is
// about routing / renaming / merging and about what actually crosses the wire to
// a remote Host.
import assert from 'node:assert/strict'
import { test } from 'node:test'

import { RemoteConnection } from '../lib/remote-client.mjs'
import {
  HOST_HINT, ID_FIELDS, PINNED_DSH_VERSION, createHostRouter, hostHintOf, hostIdOfId, hostIdsIn, namespaceId,
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

function createHarness({ remotes = [], dispatchRpc, baseline = { items: [], archivedSessionIds: [], pinnedSessionIds: [] } } = {}) {
  const localCalls = []
  const localStreams = []
  const logs = []
  const gateway = {
    // rc.1 signatures: dispatchRpc(endpoint, payload, signal, peer) and
    // openWireStream(endpoint, payload, uplink, peer, signal, control, window).
    async dispatchRpc(endpoint, payload, signal, peer) {
      localCalls.push({ endpoint, payload: clone(payload) })
      return typeof dispatchRpc === 'function' ? dispatchRpc(endpoint, payload, peer) : { ok: true, value: { local: endpoint } }
    },
    async openWireStream(endpoint, payload, uplink, peer, signal, control, window) {
      const queue = createQueue()
      localStreams.push({ endpoint, payload: clone(payload), window, queue })
      if (endpoint === 'workspace/follow') queue.push({ type: 'baseline', value: baseline })
      return queue
    },
  }
  const cards = new Map()
  const listeners = new Set()
  const connected = new Set(remotes.map((remote) => remote.hostId))
  const notify = () => { for (const listener of [...listeners]) listener() }
  const router = createHostRouter({
    gateway,
    // Constitution A1.1: the wrapper is enabled only on the pinned release.
    dshVersion: PINNED_DSH_VERSION,
    hosts: () => remotes.filter((remote) => connected.has(remote.hostId))
      .map((remote) => ({ hostId: remote.hostId, hostName: remote.hostName, connection: remote.connection, online: true })),
    onHostsChanged: (listener) => { listeners.add(listener); return () => listeners.delete(listener) },
    approvals: {
      card(hostId, ids) {
        for (const key of [ids?.rpcId, ids?.eventId, ids?.approvalId]) {
          if (typeof key === 'string' && cards.has(`${hostId}|${key}`)) return cards.get(`${hostId}|${key}`)
        }
        return undefined
      },
    },
    mergeBaselineTimeoutMs: 100,
    log: (line) => logs.push(line),
  })
  const status = router.install()
  return {
    gateway, router, status, localCalls, localStreams, remotes, cards, logs,
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
    'rpcId', 'sessionIds', 'archivedSessionIds', 'pinnedSessionIds', 'workspaceIds', 'subagentCatalog']) {
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
  const carrier = () => ({ async dispatchRpc() { return { ok: true } }, openWireStream(a, b, c, d, e) {} })
  assert.equal(selfTest(carrier(), { dshVersion: '0.3.0' }), 'dsh-version-mismatch')
  assert.equal(selfTest(carrier(), {}), 'dsh-version-unknown')
  // Correct version + correct carrier is the only null.
  assert.equal(selfTest(carrier(), { dshVersion: PINNED_DSH_VERSION }), null)
})

test('self-test mismatch: nothing is wrapped and status says why', () => {
  const legacy = (endpoint, payload, signal) => ({ endpoint, payload, signal }) // 3 params = pre-rc.1 opener
  const gateway = { async dispatchRpc() { return { ok: true } }, openWireStream: legacy }
  const dispatch = gateway.dispatchRpc
  const router = createHostRouter({ gateway, dshVersion: PINNED_DSH_VERSION })
  const status = router.install()
  assert.deepEqual({ remote: status.remote, reason: status.reason }, { remote: false, reason: 'openWireStream-signature' })
  assert.equal(gateway.dispatchRpc, dispatch, 'the carrier was not patched')
  assert.equal(gateway.openWireStream, legacy)

  assert.equal(selfTest(undefined, { dshVersion: PINNED_DSH_VERSION }), 'no-gateway')
  assert.equal(selfTest({}, { dshVersion: PINNED_DSH_VERSION }), 'dispatchRpc-missing')
  assert.equal(selfTest({ dispatchRpc() {} }, { dshVersion: PINNED_DSH_VERSION }), 'openWireStream-missing')
  assert.equal(selfTest({ dispatchRpc() {}, openWireStream(a, b, c, d, e) {} }, { dshVersion: PINNED_DSH_VERSION }), null)
})

test('A1.1: an unknown or different DSH version means no wrap, and the reason is reported', async () => {
  // The pinned release is the only one this wrapper was self-tested against.
  assert.equal(PINNED_DSH_VERSION, '0.2.2-rc.1')
  const carrier = () => ({ async dispatchRpc() { return { ok: true } }, openWireStream(a, b, c, d, e) {} })
  assert.equal(selfTest(carrier(), {}), 'dsh-version-unknown')
  assert.equal(selfTest(carrier(), { dshVersion: '' }), 'dsh-version-unknown')
  assert.equal(selfTest(carrier(), { dshVersion: '0.2.2-rc.2' }), 'dsh-version-mismatch')

  for (const [label, options, reason] of [
    ['no version at all', {}, 'dsh-version-unknown'],
    ['another release', { dshVersion: '0.3.0' }, 'dsh-version-mismatch'],
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
  // 32 levels are fine (the bound), 33 are refused — a deeper subtree would come
  // back unrenamed, i.e. a raw remote id in the local UI.
  const ok = createFakeRemote('hostB', 'Host B', { replies: { 'session/page': deep(32) } })
  const bounded = createHarness({ remotes: [ok] })
  const fine = await bounded.gateway.dispatchRpc('session/page', { args: { sessionId: 'h:hostB:s1' } }, undefined, {})
  assert.equal(fine.ok, true, JSON.stringify(fine))

  const hostB = createFakeRemote('hostB', 'Host B', { replies: { 'session/page': deep(33) } })
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
    { args: { ...deep(33), sessionId: 'h:hostC:s1' } }, undefined, {})
  assert.equal(outbound.ok, false)
  assert.equal(outbound.error.code, 'remote/payload-too-deep')
  assert.equal(hostC.calls.length, 0, 'the Host never received the payload')
  // A too-deep payload that names no host is an ordinary Local call: nothing is
  // renamed on that path, so there is no id to leak.
  const localDeep = await sending.gateway.dispatchRpc('session/page', { args: deep(33) }, undefined, {})
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
const projectedSelection = (provider, model) => ({
  kind: 'sequenced',
  asOfSeq: 7,
  values: { modelSelection: { lastUsed: selection(provider, model), next: selection(provider, model) } },
})

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
  const hostB = createFakeRemote('hostB', 'Host B')
  const hostC = createFakeRemote('hostC', 'Host C')
  const harness = createHarness({ remotes: [hostB, hostC] })
  // hostC is paired but not connected yet, so the connected set starts as {hostB}.
  harness.disconnect('hostC')
  const control = new AbortController()
  const source = await harness.gateway.openWireStream('$events', { args: {} }, undefined, {}, control.signal, control, 64)
  const iterator = source[Symbol.asyncIterator]()
  const ready = iterator.next()
  await new Promise((resolve) => setImmediate(resolve))
  harness.localStreams[0].queue.push({ type: 'ready', clientId: 'c1', host: { home: '/home/owner' } })
  assert.equal((await ready).value.type, 'ready')

  // A notify that leaves the SET unchanged is silent: the marker pushed through the
  // Local stream is the very next frame.
  harness.connect('hostB')
  harness.connect('hostB')
  harness.localStreams[0].queue.push({ type: 'emit', event: 'local/marker', args: [] })
  assert.deepEqual((await nextFrame(iterator, 'local marker')).value, { type: 'emit', event: 'local/marker', args: [] })

  // A host joining the set asks the picker to reload the one catalog it caches. The
  // frame carries exactly the three keys the client's `$events` parser accepts.
  harness.connect('hostC')
  const refresh = (await nextFrame(iterator, 'catalog refresh')).value
  assert.deepEqual(refresh, { type: 'emit', event: 'llm/models-updated', args: [] })
  assert.deepEqual(Object.keys(refresh).sort(), ['args', 'event', 'type'])

  // Leaving the set is announced the same way.
  harness.disconnect('hostC')
  assert.deepEqual((await nextFrame(iterator, 'catalog refresh after disconnect')).value,
    { type: 'emit', event: 'llm/models-updated', args: [] })

  control.abort()
  await iterator.return()
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

