// Spec 008 connection lifecycle: a session the user has OPEN receives its updates
// again after the link drops and comes back, without reopening the session or
// restarting DSH.
//
// The bug this pins down: a remote `session/follow` was a pass-through of one
// `openStream`, so a dropped socket ENDED the stream — a clean end, which the
// consumer reads as "nothing more in this session". The conversation froze until the
// whole page was reopened. The router now pumps the follow: it waits for the host,
// re-opens the same follow, and hands the reader the frames it has not seen yet.
//
// Runs with `node --test --test-isolation=none test/follow-reconnect.test.mjs`. No
// socket is involved: the remote is a stub connection whose stream is failed with the
// close code a dropped link produces, and the host set is moved exactly the way the
// link supervisor moves it (a state change, then `onHostsChanged`).
import assert from 'node:assert/strict'
import { test } from 'node:test'

import { createHostRouter, namespaceIds, PINNED_DSH_VERSION } from '../lib/host-router.mjs'

const HOST = 'hostB'
const SESSION = 's1'

/** A pushable async sequence whose failure mode is a dropped link. */
function createQueue() {
  const items = []
  const waiters = []
  let closed = false
  let error = null
  const settle = (value, done) => { for (const waiter of waiters.splice(0)) waiter({ value, done }) }
  return {
    push(value) {
      const waiter = waiters.shift()
      if (waiter) waiter({ value, done: false })
      else items.push(value)
    },
    /** The host's link dropped with `code`: this is what a closed socket looks like. */
    fail(code) {
      if (closed) return
      error = Object.assign(new Error(`the connection closed (${code})`), { closeCode: code })
      closed = true
      settle(undefined, true)
    },
    close() { if (closed) return; closed = true; settle(undefined, true) },
    [Symbol.asyncIterator]() {
      return {
        async next() {
          if (items.length > 0) return { value: items.shift(), done: false }
          if (closed) { if (error) throw error; return { value: undefined, done: true } }
          return new Promise((resolve) => waiters.push(resolve))
        },
        async return() {
          closed = true
          error = null
          settle(undefined, true)
          return { value: undefined, done: true }
        },
      }
    },
  }
}

const snapshot = (throughSeq, extra = {}) => {
  const records = []
  for (let seq = 1; seq <= throughSeq; seq += 1) {
    records.push({ type: 'event', event: { seq, type: 'assistant/message', data: { sessionId: SESSION, text: `line ${seq}` } } })
  }
  return {
    type: 'snapshot',
    header: { version: 4, id: SESSION },
    cursor: throughSeq,
    records,
    hasMore: false,
    projections: { asOfSeq: throughSeq, values: { title: 'Live' } },
    assistantStream: { revision: 0 },
    ...extra,
  }
}
const increment = (seq) => ({ type: 'event', event: { seq, type: 'assistant/message', data: { sessionId: SESSION, text: `line ${seq}` } } })

/**
 * A remote Host whose every `session/follow` opens on `snapshot(throughSeq)`: that
 * is what a real Host answers, because a follow always opens on a fresh snapshot of
 * everything already committed.
 */
function createFakeRemote() {
  const streams = []
  const calls = []
  const connection = {
    state: 'online',
    async call(endpoint, args) {
      calls.push({ endpoint, args })
      return {}
    },
    async openStream(endpoint, args, options) {
      const queue = createQueue()
      streams.push({ endpoint, args, options, queue })
      return queue
    },
  }
  return { hostId: HOST, hostName: 'Host B', connection, streams, calls }
}

function createHarness() {
  const localCalls = []
  const logs = []
  const gateway = {
    async dispatchRpc(endpoint, payload, signal, peer) { // eslint-disable-line no-unused-vars
      localCalls.push({ endpoint, payload })
      return { ok: true, value: { local: endpoint } }
    },
    // rc.1 arity: the wrapper's self-test probes it (>= 5 parameters).
    async openWireStream(endpoint, payload, uplink, peer, signal, control, window) {
      void [endpoint, payload, uplink, peer, signal, control, window]
      return createQueue()
    },
  }
  const listeners = new Set()
  const remote = createFakeRemote()
  let online = true
  const notify = () => { for (const listener of [...listeners]) listener() }
  const router = createHostRouter({
    gateway,
    dshVersion: PINNED_DSH_VERSION,
    hosts: () => (online
      ? [{ hostId: HOST, hostName: 'Host B', connection: remote.connection, online: true }]
      : []),
    onHostsChanged: (listener) => { listeners.add(listener); return () => listeners.delete(listener) },
    log: (line) => logs.push(line),
  })
  router.install()
  return {
    router, gateway, remote, localCalls, logs,
    get listenerCount() { return listeners.size },
    drop() { online = false; notify() },
    restore() { online = true; notify() },
  }
}

/** One frame, bounded, so a pump that stops delivering fails instead of hanging. */
function nextFrame(iterator, label) {
  return Promise.race([
    iterator.next(),
    new Promise((_resolve, reject) => {
      const timer = setTimeout(() => reject(new Error(`${label}: no frame within 2 s`)), 2000)
      timer.unref?.()
    }),
  ])
}

const followPayload = () => ({ args: { request: { address: { kind: 'session', sessionId: `h:${HOST}:${SESSION}` } } } })

/** Wait until the pump has opened its next stream (a reconnect is asynchronous). */
async function until(condition, label, { tries = 200, every = 5 } = {}) {
  for (let attempt = 0; attempt < tries; attempt += 1) {
    if (condition()) return
    await new Promise((resolve) => setTimeout(resolve, every))
  }
  throw new Error(`timed out waiting for ${label}`)
}

test('an open follow delivers new updates after the link returns, twice, with no duplicate', async () => {
  const harness = createHarness()
  const control = new AbortController()
  try {
    const source = await harness.gateway.openWireStream('session/follow', followPayload(),
      undefined, {}, control.signal, control, 64)
    const iterator = source[Symbol.asyncIterator]()

    // One opening snapshot, then the live increment the user is watching arrive.
    harness.remote.streams[0].queue.push(snapshot(2))
    assert.equal((await nextFrame(iterator, 'opening snapshot')).value.cursor, 2)
    harness.remote.streams[0].queue.push(increment(3))
    assert.equal((await nextFrame(iterator, 'first increment')).value.event.seq, 3)

    // Two full drop → reconnect cycles on the SAME open stream: a restart or a
    // reopened session is exactly what the owner must not need.
    for (const round of [1, 2]) {
      const opened = harness.remote.streams.length
      harness.remote.streams.at(-1).queue.fail(1006)
      harness.drop()
      harness.restore()

      // The pump re-opens the SAME follow, in the host's own namespace.
      await until(() => harness.remote.streams.length === opened + 1, `round ${round}: the follow to re-open`)
      assert.deepEqual(harness.remote.streams.at(-1).args,
        { request: { address: { kind: 'session', sessionId: SESSION } } },
        `round ${round}: the re-open asks the host for its own id`)

      // The re-open carries a fresh snapshot of everything committed, including the
      // lines the reader already showed: only what it has not seen may cross. Round 1
      // ends on `next + 1`, so round 2 must commit one line FURTHER or its snapshot
      // would hold nothing the reader has not already seen.
      const next = round === 1 ? 4 : 6
      harness.remote.streams.at(-1).queue.push(snapshot(next))
      const frame = (await nextFrame(iterator, `round ${round}: the missed update`)).value
      assert.equal(frame.type, 'event', `round ${round}: a resumed opening is not a second snapshot`)
      assert.equal(frame.event.seq, next, `round ${round}: exactly the missed update`)
      assert.equal(frame.event.data.sessionId, `h:${HOST}:${SESSION}`, `round ${round}: renamed into the host namespace`)

      // Nothing repeated (the earlier seqs stayed filtered) and the stream is live.
      harness.remote.streams.at(-1).queue.push(increment(next + 1))
      const after = (await nextFrame(iterator, `round ${round}: the next live update`)).value
      assert.equal(after.event.seq, next + 1, `round ${round}: live again after the reconnect`)
    }

    // No write was replayed: only the follow stream ever reached the host, and the
    // Local carrier was never asked for anything on the user's behalf.
    assert.deepEqual(harness.remote.calls, [], 'no call was replayed against the host')
    assert.deepEqual(harness.localCalls, [], 'nothing was replayed into Local')
    for (const stream of harness.remote.streams) assert.equal(stream.endpoint, 'session/follow')
    // One pump, not one per cycle: the reconnect re-used the open stream.
    assert.equal(harness.remote.streams.length, 3, 'two reconnects, three opens, one stream')
  } finally { control.abort() }
})

test('cancelling the open follow stops the retries for good', async () => {
  const harness = createHarness()
  const control = new AbortController()
  const source = await harness.gateway.openWireStream('session/follow', followPayload(),
    undefined, {}, control.signal, control, 64)
  const iterator = source[Symbol.asyncIterator]()
  harness.remote.streams[0].queue.push(snapshot(2))
  assert.equal((await nextFrame(iterator, 'opening snapshot')).value.cursor, 2)
  harness.remote.streams[0].queue.push(increment(3))
  assert.equal((await nextFrame(iterator, 'first increment')).value.event.seq, 3)

  // The reader goes away while the host is dropping: the pump must not keep a link,
  // a host subscription or a timer alive behind it.
  harness.remote.streams.at(-1).queue.fail(1006)
  harness.drop()
  control.abort()
  const ended = await nextFrame(iterator, 'the cancelled stream to end')
  assert.equal(ended.done, true, 'a cancellation ends the stream quietly')
  assert.equal(harness.listenerCount, 0, 'the host subscription was released')

  // The host coming back must NOT start a new attempt.
  const opens = harness.remote.streams.length
  harness.restore()
  await new Promise((resolve) => setTimeout(resolve, 150))
  assert.equal(harness.remote.streams.length, opens, 'a cancelled follow is never retried')
})

test('abandoning the iterator also stops the retries', async () => {
  const harness = createHarness()
  const source = await harness.gateway.openWireStream('session/follow', followPayload(),
    undefined, {}, undefined, undefined, 64)
  const iterator = source[Symbol.asyncIterator]()
  harness.remote.streams[0].queue.push(snapshot(2))
  assert.equal((await nextFrame(iterator, 'opening snapshot')).value.cursor, 2)

  harness.remote.streams.at(-1).queue.fail(1006)
  harness.drop()
  await iterator.return()
  assert.equal(harness.listenerCount, 0, 'the host subscription was released')

  const opens = harness.remote.streams.length
  harness.restore()
  await new Promise((resolve) => setTimeout(resolve, 150))
  assert.equal(harness.remote.streams.length, opens, 'an abandoned follow is never retried')
})

test('a refusal from the host ends the follow instead of retrying it', async () => {
  const harness = createHarness()
  const control = new AbortController()
  try {
    const source = await harness.gateway.openWireStream('session/follow', followPayload(),
      undefined, {}, control.signal, control, 64)
    const iterator = source[Symbol.asyncIterator]()
    harness.remote.streams[0].queue.push(snapshot(2))
    await nextFrame(iterator, 'opening snapshot')

    // `auth/forbidden-scope` is an answer, not a dropped link: re-opening would only
    // ask the same question again.
    harness.remote.streams.at(-1).queue.fail(4401)
    harness.remote.connection.openStream = async () => {
      throw Object.assign(new Error('scope refused'), { code: 'auth/forbidden-scope' })
    }
    harness.drop()
    harness.restore()
    const opens = harness.remote.streams.length
    await until(() => harness.remote.streams.length > opens || harness.logs.length > 0, 'the refusal to be recorded')
    await new Promise((resolve) => setTimeout(resolve, 150))
    assert.equal(harness.remote.streams.length, opens, 'a refusal is never retried')
  } finally { control.abort() }
})

test('a follow frame is renamed into its host namespace, never trusted as already tagged', async () => {
  const harness = createHarness()
  const control = new AbortController()
  try {
    const source = await harness.gateway.openWireStream('session/follow', followPayload(),
      undefined, {}, control.signal, control, 64)
    const iterator = source[Symbol.asyncIterator]()
    harness.remote.streams[0].queue.push(snapshot(1))
    const opening = (await nextFrame(iterator, 'opening snapshot')).value
    // The whole frame passes through the same rename every other remote payload does.
    assert.deepEqual(opening, namespaceIds(snapshot(1), HOST))
    assert.equal(opening.header.id, `h:${HOST}:${SESSION}`)
  } finally { control.abort() }
})

test('forgetHost ends that host\'s open follow instead of leaving it stalled', async () => {
  const harness = createHarness()
  const control = new AbortController()
  try {
    const source = await harness.gateway.openWireStream('session/follow', followPayload(),
      undefined, {}, control.signal, control, 64)
    const iterator = source[Symbol.asyncIterator]()
    harness.remote.streams[0].queue.push(snapshot(2))
    assert.equal((await nextFrame(iterator, 'opening snapshot')).value.cursor, 2)

    // The link drops: the pump is now waiting for a host that a forget/revoke means
    // will never come back.
    harness.remote.streams.at(-1).queue.fail(1006)
    harness.drop()
    const pending = nextFrame(iterator, 'the stream to end on forget')
    assert.equal(harness.router.forgetHost(HOST), false, 'no retained rows were held for this host')
    const ended = await pending
    assert.equal(ended.done, true, 'the stream ends instead of stalling')
    assert.equal(harness.listenerCount, 0, 'the host subscription was released')

    // The host returning does not resurrect a forgotten follow.
    const opens = harness.remote.streams.length
    harness.restore()
    await new Promise((resolve) => setTimeout(resolve, 150))
    assert.equal(harness.remote.streams.length, opens, 'a forgotten host\'s follow is never re-opened')
  } finally { control.abort() }
})

test('forgetHost leaves another host\'s follow running', async () => {
  const harness = createHarness()
  const control = new AbortController()
  try {
    const source = await harness.gateway.openWireStream('session/follow', followPayload(),
      undefined, {}, control.signal, control, 64)
    const iterator = source[Symbol.asyncIterator]()
    harness.remote.streams[0].queue.push(snapshot(2))
    await nextFrame(iterator, 'opening snapshot')
    harness.router.forgetHost('some-other-host')
    harness.remote.streams[0].queue.push(increment(3))
    assert.equal((await nextFrame(iterator, 'a live update')).value.event.seq, 3, 'the unrelated forget did not end it')
  } finally { control.abort() }
})
