// Spec 038 R1-R3/R7 — offline retention of the merged workspace/session view and
// read-only transcript replay. No gateway, no real socket: a fake rc.1 carrier and
// one stub remote, with plugin-owned storage in a temp dir.
import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { test } from 'node:test'

import { PINNED_DSH_VERSION, createHostRouter } from '../lib/host-router.mjs'
import { createRetentionStore, createSessionCache } from '../lib/session-cache.mjs'

const tempDir = () => fs.mkdtempSync(path.join(os.tmpdir(), 'dsh-devices-retention-'))
const cleanup = (dir) => fs.rmSync(dir, { recursive: true, force: true })
const delay = (ms) => new Promise((resolve) => setTimeout(resolve, ms))

function queue() {
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
        async return() { this.close(); return { value: undefined, done: true } },
      }
    },
  }
}

function harness({ dir = tempDir(), workspaces = [], sessions = [], offlineHostListed = false, firstOpenTimeoutMs } = {}) {
  const gateway = {
    async dispatchRpc(endpoint, payload, signal, peer) { // eslint-disable-line no-unused-vars
      return { ok: true, value: { items: endpoint === 'session/list' ? [] : {} } }
    },
    async openWireStream(endpoint, payload, uplink, peer, signal, control, uplinkWindow) { // eslint-disable-line no-unused-vars
      const stream = queue()
      if (endpoint === 'workspace/follow') stream.push({ type: 'baseline', value: { items: [], archivedSessionIds: [], pinnedSessionIds: [] } })
      if (endpoint === 'session/follow') stream.push({ type: 'snapshot', cursor: 1, records: [] })
      control?.addEventListener?.('abort', () => stream.close(), { once: true })
      return stream
    },
  }
  const remoteQueue = queue()
  let remoteOpens = 0
  const connection = {
    state: 'online',
    async call(endpoint) {
      if (endpoint === 'session/list') return { items: sessions }
      return {}
    },
    async openStream(endpoint) {
      remoteOpens += 1
      const stream = queue()
      if (endpoint === 'workspace/follow') {
        stream.push({ type: 'baseline', value: {
          items: workspaces, archivedSessionIds: [], pinnedSessionIds: [],
        } })
      }
      remoteQueue.push(stream)
      return stream
    },
  }
  const listeners = new Set()
  const connected = new Set(['hostB'])
  const notify = () => { for (const listener of [...listeners]) listener() }
  const retention = createRetentionStore({ dir })
  const cache = createSessionCache({ dir: path.join(dir, 'sessions') })
  const router = createHostRouter({
    gateway, dshVersion: PINNED_DSH_VERSION, retention, cache, mergeBaselineTimeoutMs: 30, firstOpenTimeoutMs,
    // A link can still be in the inventory after it died: the route succeeds, but
    // its connection state is no longer online. The first open must use the cache.
    hosts: () => (connected.has('hostB')
      ? [{ hostId: 'hostB', hostName: 'Host B', connection, online: true }]
      : (offlineHostListed
        ? [{ hostId: 'hostB', hostName: 'Host B', connection: { ...connection, state: 'offline' }, online: true }]
        : [])),
    knownHosts: () => [{ hostId: 'hostB', hostName: 'Host B' }],
    onHostsChanged: (listener) => { listeners.add(listener); return () => listeners.delete(listener) },
  })
  router.install()
  return {
    dir, router, gateway, connection, retention, cache, remoteQueue,
    get remoteOpens() { return remoteOpens },
    disconnect() { connected.delete('hostB'); notify() },
    reconnect() { connected.add('hostB'); notify() },
    close() { router.uninstall() },
  }
}

async function nextFrame(iterator, label) {
  return Promise.race([
    iterator.next(),
    delay(1500).then(() => { throw new Error(`timed out waiting for ${label}`) }),
  ])
}

const workspaceRow = (id) => ({
  workspaceId: id, path: `/tmp/${id}`, title: id, sessionIds: [],
  createdAt: '2026-11-09T00:00:00.000Z', updatedAt: '2026-11-09T00:00:00.000Z',
})

const sessionRow = (id) => ({
  sessionId: id, running: false, updatedAt: 3,
  projections: { kind: 'sequenced', asOfSeq: 3, values: { title: id } },
})

test('a link drop keeps workspace rows; reconnect replaces; forget drops them', async () => {
  const h = harness({ workspaces: [workspaceRow('wb1')] })
  try {
    const control = new AbortController()
    const source = await h.gateway.openWireStream('workspace/follow', { args: {} }, undefined, {}, control.signal, control, 64)
    const iterator = source[Symbol.asyncIterator]()
    const first = (await nextFrame(iterator, 'baseline')).value
    assert.deepEqual(first.value.items.map((item) => item.workspaceId), ['h:hostB:wb1'])

    h.disconnect()
    const stale = (await nextFrame(iterator, 'stale replace')).value
    assert.equal(stale.type, 'replace')
    assert.deepEqual(stale.value.items.map((item) => item.workspaceId), ['h:hostB:wb1'],
      'the last merged rows stay on screen while the host is offline')
    assert.equal('stale' in stale.value, false, 'the internal stale bit is never a DSH field')
    assert.equal(JSON.stringify(stale).includes('dropHost'), false)

    h.reconnect()
    const back = (await nextFrame(iterator, 'fresh baseline')).value
    assert.deepEqual(back.value.items.map((item) => item.workspaceId), ['h:hostB:wb1'])
    assert.equal(h.router.status().hosts[0].retainedWorkspaces, 1)

    h.router.forgetHost('hostB')
    const gone = (await nextFrame(iterator, 'explicit drop')).value
    assert.deepEqual(gone.value.items, [], 'only an explicit forget removes the rows')
    assert.equal(h.retention.readHost('hostB'), null)
    control.abort()
    await iterator.return()
  } finally { h.close(); cleanup(h.dir) }
})

test('a persisted workspace snapshot is restored stale by a new router', async () => {
  const dir = tempDir()
  const first = harness({ dir, workspaces: [workspaceRow('wb1')] })
  try {
    const control = new AbortController()
    const source = await first.gateway.openWireStream('workspace/follow', { args: {} }, undefined, {}, control.signal, control, 64)
    const iterator = source[Symbol.asyncIterator]()
    await nextFrame(iterator, 'baseline')
    assert.equal(first.retention.readHost('hostB')?.workspace?.items.length, 1)
    control.abort()
    await iterator.return()
  } finally { first.close() }

  // A fresh router over the SAME plugin-owned file, with the host still away.
  const gateway = {
    async dispatchRpc(endpoint, payload, signal, peer) { // eslint-disable-line no-unused-vars
      return { ok: true, value: { items: [] } }
    },
    async openWireStream(endpoint, payload, uplink, peer, signal, control, uplinkWindow) { // eslint-disable-line no-unused-vars
      const stream = queue()
      stream.push({ type: 'baseline', value: { items: [], archivedSessionIds: [], pinnedSessionIds: [] } })
      control?.addEventListener?.('abort', () => stream.close(), { once: true })
      return stream
    },
  }
  const router = createHostRouter({
    gateway, dshVersion: PINNED_DSH_VERSION,
    retention: createRetentionStore({ dir }), mergeBaselineTimeoutMs: 30,
    knownHosts: () => [{ hostId: 'hostB', hostName: 'Host B' }],
    hosts: () => [],
  })
  router.install()
  try {
    const control = new AbortController()
    const source = await gateway.openWireStream('workspace/follow', { args: {} }, undefined, {}, control.signal, control, 64)
    const restored = (await nextFrame(source[Symbol.asyncIterator](), 'restored baseline')).value
    assert.deepEqual(restored.value.items.map((item) => item.workspaceId), ['h:hostB:wb1'])
    control.abort()
  } finally { router.uninstall(); cleanup(dir) }
})

test('session rows outlive the link, marked cached, and come from the persisted snapshot', async () => {
  const h = harness({ sessions: [sessionRow('s1')] })
  try {
    const answer = await h.gateway.dispatchRpc('session/list', { args: {} }, undefined, {})
    assert.deepEqual(answer.value.items.map((row) => row.sessionId), ['h:hostB:s1'])
    assert.equal(answer.value.items[0].projections.kind, 'sequenced')

    h.disconnect()
    const offline = await h.gateway.dispatchRpc('session/list', { args: {} }, undefined, {})
    assert.equal(offline.value.items.length, 1, 'the row did not vanish with the link')
    assert.deepEqual(offline.value.items[0], { ...sessionRow('s1'), sessionId: 'h:hostB:s1',
      projections: { kind: 'cached', asOfSeq: 3, values: { title: 's1' } } })
    const stored = h.retention.readHost('hostB').sessions
    assert.equal(stored[0].projections.kind, 'cached')
    assert.equal(h.router.status().disconnected[0].retainedSessions, 1)
  } finally { h.close(); cleanup(h.dir) }
})

test('an offline session/follow replays only the cached read-only frames', async () => {
  const h = harness()
  try {
    h.cache.append('hostB', 's1', { type: 'snapshot', cursor: 1, records: [],
      projections: { asOfSeq: 1, values: {} }, assistantStream: { revision: 0 } })
    h.cache.append('hostB', 's1', { type: 'event', event: { type: 'user/message', seq: 2, data: {} } })
    h.disconnect()
    const stream = await h.gateway.openWireStream('session/follow',
      { args: { request: { address: { kind: 'session', sessionId: 'h:hostB:s1' } } } },
      undefined, {}, new AbortController().signal, new AbortController(), 64)
    const iterator = stream[Symbol.asyncIterator]()
    const first = (await nextFrame(iterator, 'cached snapshot')).value
    const second = (await nextFrame(iterator, 'cached event')).value
    assert.equal(first.type, 'snapshot')
    assert.equal(second.type, 'event')
    assert.equal(second.event.seq, 2)
    const end = await nextFrame(iterator, 'cache boundary')
    assert.equal(end.done, true, 'the stream ends where the cache ends')
  } finally { h.close(); cleanup(h.dir) }
})

test('a first follow open on a dead link still listed in the inventory replays its cache', async () => {
  const h = harness({ offlineHostListed: true })
  try {
    h.cache.append('hostB', 's1', { type: 'snapshot', header: { version: 4, id: 's1' }, cursor: 1,
      records: [], projections: { asOfSeq: 1, values: {} }, assistantStream: { revision: 0 } })
    h.cache.append('hostB', 's1', { type: 'event', event: { type: 'user/message', seq: 2, data: { sessionId: 's1' } } })
    h.disconnect()
    const opened = await Promise.race([
      h.gateway.openWireStream('session/follow',
        { args: { request: { address: { kind: 'session', sessionId: 'h:hostB:s1' } } } },
        undefined, {}, new AbortController().signal, new AbortController(), 64),
      delay(1500).then(() => { throw new Error('the first open stayed pending on the dead link') }),
    ])
    assert.equal(h.remoteOpens, 0, 'no stream was opened on the dead link')
    const iterator = opened[Symbol.asyncIterator]()
    assert.equal((await nextFrame(iterator, 'cached snapshot')).value.type, 'snapshot')
    assert.equal((await nextFrame(iterator, 'cached event')).value.event.seq, 2)
    assert.equal((await nextFrame(iterator, 'cache boundary')).done, true)
  } finally { h.close(); cleanup(h.dir) }
})

test('a live Host that stalls before its opening snapshot replays the real cache at the timeout', async () => {
  // The link is up and the stream open is accepted, but the Host never sends its
  // opening snapshot. With a persisted cache the first open must still settle:
  // the timeout replays the cached transcript read-only instead of hanging in
  // `openState:'loading'` (spec 038 R3).
  const h = harness({ firstOpenTimeoutMs: 50 })
  try {
    h.cache.append('hostB', 's1', { type: 'snapshot', header: { version: 4, id: 's1' }, cursor: 1,
      records: [], projections: { asOfSeq: 1, values: {} }, assistantStream: { revision: 0 } })
    h.cache.append('hostB', 's1', { type: 'event', event: { type: 'user/message', seq: 2, data: { sessionId: 's1' } } })
    const stream = await h.gateway.openWireStream('session/follow',
      { args: { request: { address: { kind: 'session', sessionId: 'h:hostB:s1' } } } },
      undefined, {}, new AbortController().signal, new AbortController(), 64)
    const iterator = stream[Symbol.asyncIterator]()
    assert.equal((await nextFrame(iterator, 'cached snapshot after stall')).value.type, 'snapshot')
    assert.equal((await nextFrame(iterator, 'cached event after stall')).value.event.seq, 2)
    assert.equal((await nextFrame(iterator, 'cache boundary after stall')).done, true)
    assert.equal(h.remoteOpens, 1, 'the stalled stream was opened once, then stopped')
  } finally { h.close(); cleanup(h.dir) }
})
