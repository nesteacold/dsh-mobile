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
  /** True while a reader is waiting: a mid-stream failure only exists once a read is pending. */
  let readingFlag = false
  const settle = () => { for (const waiter of waiters.splice(0)) waiter({ value: undefined, done: true }) }
  const failWaiters = (cause) => {
    // The real client's reader throws the code from the read that is already pending: a
    // `done` here instead would end the `for await` cleanly and the pump would just re-open.
    for (const waiter of waiters.splice(0)) waiter({ error: cause })
  }
  const queue = {
    /** How many reads this stream has answered: a failed stream throws from the NEXT one. */
    readCount: 0,
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
      failWaiters(error)
      settle()
    },
    /** Fail with the exact error the real client raises (a stream-protocol error, no close code). */
    failWith(cause) {
      if (closed) return
      error = cause
      closed = true
      failWaiters(cause)
      settle()
    },
    close() { if (closed) return; closed = true; settle() },
    /** Whether a reader is waiting on this stream right now (the client's state mid-stream). */
    set reading(value) { readingFlag = value },
    get reading() { return readingFlag },
    [Symbol.asyncIterator]() {
      return {
        async next() {
          if (items.length > 0) { queue.readCount += 1; return { value: items.shift(), done: false } }
          if (closed) { if (error) throw error; return { value: undefined, done: true } }
          readingFlag = true
          try {
            const result = await new Promise((resolve) => waiters.push(resolve))
            if (result.error) throw result.error
            queue.readCount += 1
            return result
          } finally { readingFlag = false }
        },
        async return() {
          closed = true
          error = null
          settle()
          return { value: undefined, done: true }
        },
      }
    },
  }
  return queue
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
 *
 * It also refuses to hold two subscriptions at once (`overlaps` records the attempt):
 * a re-open that happened while the previous stream was still open is exactly the leak
 * the DESYNC cancel fix exists to prevent, so here it is a loud failure, not a count.
 */
function createFakeRemote() {
  const streams = []
  const calls = []
  const overlaps = []
  const openedAt = []
  /** The streamId the REAL client announced for each open (a stub connection has none). */
  const announced = []
  const connection = {
    state: 'online',
    async call(endpoint, args) {
      calls.push({ endpoint, args })
      return {}
    },
    async openStream(endpoint, args, options) {
      // The subscription the Host holds until its reader lets go of it (or it fails).
      if (streams.some((stream) => !stream.released)) overlaps.push(streams.length)
      const base = createQueue()
      streams.push({ endpoint, args, options, queue: base, released: false })
      openedAt.push(Date.now())
      return base
    },
  }
  return { hostId: HOST, hostName: 'Host B', connection, streams, calls, overlaps, openedAt, announced,
    /** The subscription the reader is on right now (or was, after a desync ended it). */
    old() { return streams.at(-1) },
    /** The client's own streamId: the live client announces it on the socket. */
    streamIdOf(stream) { return announced[streams.indexOf(stream)] ?? null },
    release(stream) { stream.released = true },
    /** Subscriptions the Host is still holding: what the gateway's per-device cap counts. */
    live() { return streams.filter((stream) => !stream.released).length } }
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

test('a stream DESYNC re-opens the follow once, with no duplicate and no gap', async () => {
  // Measured defect: a plain Error from the out-of-order guard in the client ended the follow for
  // the rest of the session (opens=1, a frozen transcript) while prompts kept working. A desync is
  // a broken frame ORDER on this connection, not an answer from the Host, so the follow it feeds
  // must re-open from the last durable sequence exactly as a dropped link does.
  const harness = createHarness()
  const control = new AbortController()
  try {
    const source = await harness.gateway.openWireStream('session/follow', followPayload(),
      undefined, {}, control.signal, control, 64)
    const iterator = source[Symbol.asyncIterator]()
    harness.remote.streams[0].queue.push(snapshot(2))
    assert.equal((await nextFrame(iterator, 'opening snapshot')).value.cursor, 2)
    harness.remote.streams[0].queue.push(increment(3))
    assert.equal((await nextFrame(iterator, 'first increment')).value.event.seq, 3)

    // The client's own out-of-order guard: an Error carrying only the resumable code.
    harness.remote.streams.at(-1).queue.failWith(
      Object.assign(new Error('the remote stream arrived out of order'), { code: 'remote/stream-desync' }))

    // One re-open, on the same follow, in the host's namespace.
    await until(() => harness.remote.streams.length === 2, 'the follow to re-open after a desync')
    assert.equal(harness.remote.streams.at(-1).endpoint, 'session/follow')
    assert.deepEqual(harness.remote.streams.at(-1).args,
      { request: { address: { kind: 'session', sessionId: SESSION } } })

    // The re-opened follow answers with a snapshot through seq 6: seqs 4-6 are the stretch the
    // reader missed. It gets exactly those, in order, once each — no second snapshot, no repeat
    // of 2-3 (already delivered), and then the stream is live again.
    harness.remote.streams.at(-1).queue.push(snapshot(6))
    for (const seq of [4, 5, 6]) {
      const frame = (await nextFrame(iterator, `resumed seq ${seq}`)).value
      assert.equal(frame.type, 'event', 'a resumed opening is not a second snapshot')
      assert.equal(frame.event.seq, seq, `the gap is filled exactly: ${seq}`)
      assert.equal(frame.event.data.sessionId, `h:${HOST}:${SESSION}`)
    }
    harness.remote.streams.at(-1).queue.push(increment(7))
    assert.equal((await nextFrame(iterator, 'live again')).value.event.seq, 7)

    assert.equal(harness.remote.streams.length, 2, 'exactly one re-open for one desync')
    assert.deepEqual(harness.remote.calls, [], 'nothing was replayed against the host')
  } finally { control.abort() }
})

/** The client's own out-of-order guard: an Error carrying only the resumable code. */
const desync = () => Object.assign(new Error('the remote stream arrived out of order'),
  { code: 'remote/stream-desync' })

/**
 * The Host side of a follow whose every attempt answers the open and then delivers nothing
 * (a Host that accepts the connection and has no frames for it yet). It strictly refuses to
 * hold two subscriptions at once (`overlaps` records the attempt), so a re-open that lands
 * while the previous stream is still open - the leak this fix exists to prevent - is a
 * failing test here, not a count.
 */
function createStrictRemote() {
  const streams = []
  const overlaps = []
  const openedAt = []
  const releases = []
  const connection = {
    state: 'online',
    async call() { return {} },
    async openStream(endpoint, args, options) {
      if (streams.some((stream) => !stream.released)) overlaps.push(streams.length)
      const queue = createQueue()
      const stream = { endpoint, args, options, queue, released: false }
      streams.push(stream)
      openedAt.push(Date.now())
      return queue
    },
  }
  return { hostId: HOST, hostName: 'Host B', connection, streams, overlaps, openedAt, releases,
    /** The attempt the reader is on (its queue failed or the reader let go: it is over). */
    old() { return streams.at(-1) },
    /** The reader let go of this subscription (the DESYNC path, at the router fakes' level). */
    release(stream) { stream.released = true; releases.push(stream) },
    live() { return streams.filter((stream) => !stream.released).length } }
}

/**
 * A harness over `createStrictRemote`, which is the same router wiring as `createHarness`
 * but with a Host that accounts for its subscriptions.
 */
function createStrictHarness() {
  const remote = createStrictRemote()
  const logs = []
  const gateway = {
    // rc.1 arity: the wrapper's self-test probes both (>= 4 and >= 5 parameters).
    async dispatchRpc(endpoint, payload, signal, peer) { // eslint-disable-line no-unused-vars
      return { ok: true, value: {} }
    },
    async openWireStream(endpoint, payload, uplink, peer, signal, control, window) {
      void [endpoint, payload, uplink, peer, signal, control, window]
      return createQueue()
    },
  }
  const router = createHostRouter({
    gateway,
    dshVersion: PINNED_DSH_VERSION,
    hosts: () => [{ hostId: HOST, hostName: 'Host B', connection: remote.connection, online: true }],
    onHostsChanged: () => () => {},
    log: (line) => logs.push(line),
  })
  const installed = router.install()
  assert.equal(installed.remote, true, `the carrier must be wrapped for this test (${installed.reason})`)
  return { router, gateway, remote, logs }
}

/** Open the follow through the router's wrapper, as the native UI does. */
async function strictFollow(harness, control) {
  assert.deepEqual(harness.remote.openedAt.length, 0, 'the Host has opened nothing yet')
  const source = await harness.gateway.openWireStream('session/follow', followPayload(),
    undefined, {}, control.signal, control, 64)
  return source[Symbol.asyncIterator]()
}

test('a DESYNC ends the old subscription and the router opens the follow exactly once more', async () => {
  // Reviewer finding (review-webunlock, Major): the DESYNC guard deleted the stream from
  // `wireStreams` BEFORE failing its reader, so the iterator's `finally` cancel found nothing
  // to release and NO `remote-stream-cancel` reached the Host. The old subscription stayed
  // alive on credit while re-opens piled up until the gateway's per-device cap made a
  // recoverable desync terminal. The frame itself is pinned in test/stream-open.test.mjs;
  // what is checked here is the router's half: one attempt at a time, never overlapping.
  const harness = createStrictHarness()
  const control = new AbortController()
  try {
    const iterator = await strictFollow(harness, control)
    harness.remote.old().queue.push(snapshot(2))
    assert.equal((await nextFrame(iterator, 'opening snapshot')).value.cursor, 2)

    for (const round of [1, 2, 3]) {
      const before = harness.remote.openedAt.length
      const old = harness.remote.old()
      // The Host holds the old stream right now: a replacement must not overlap it.
      assert.equal(harness.remote.live(), 1, `round ${round}: one subscription before the desync`)
      old.queue.failWith(desync())
      // The reader's iterator ends on the failure: in the client that is the exactly-once
      // cancel for this stream name (test/stream-open.test.mjs), and it runs before the throw
      // reaches this pump, so the re-open below can never overtake it.
      harness.remote.release(old)
      await until(() => harness.remote.openedAt.length === before + 1, `round ${round}: the follow to re-open`)
      assert.deepEqual(harness.remote.overlaps, [], `round ${round}: no open overlapped a live subscription`)
      assert.equal(harness.remote.live(), 1, `round ${round}: exactly one subscription after the re-open`)
      assert.equal(harness.remote.openedAt.length, before + 1, `round ${round}: one replacement, no duplicate open`)
    }
    // Each re-open is a real follow: a frame from the current attempt reaches the reader.
    harness.remote.old().queue.push(increment(3))
    assert.equal((await nextFrame(iterator, 'live again')).value.event.seq, 3)
    assert.deepEqual(harness.remote.overlaps, [], 'the Host never held two subscriptions at once')
    assert.equal(harness.remote.openedAt.length, 4, 'the opening and exactly three re-opens, one per desync')
  } finally { control.abort() }
})

test('consecutive DESYNCs back off, then stop the follow with remote/stream-desync-repeated', async () => {
  const harness = createStrictHarness()
  const control = new AbortController()
  try {
    const iterator = await strictFollow(harness, control)
    harness.remote.old().queue.push(snapshot(2))
    assert.equal((await nextFrame(iterator, 'opening snapshot')).value.cursor, 2)
    const opening = harness.remote.openedAt[0]

    // Every attempt after the first: the open succeeds and its reader is failed with the
    // DESYNC code. A Host like this answers 'open ok' forever, so the open alone resets
    // nothing; the cap needs four re-opens on the 100/200/300/400 ms schedule (~1 s).
    let ended
    const watch = iterator.next().then((result) => { ended = result }, (error) => { ended = { done: true, error } })
    watch.catch(() => {})
    // Fail the attempt the reader is on, once per open, as soon as it exists.
    let watched = harness.remote.openedAt.length
    const desyncCurrent = () => {
      const stream = harness.remote.old()
      stream.queue.failWith(desync())
      harness.remote.release(stream)
    }
    desyncCurrent()
    for (let tick = 0; tick < 400 && !ended; tick += 1) {
      await new Promise((resolve) => setTimeout(resolve, 20))
      if (ended || harness.remote.openedAt.length === watched) continue
      watched = harness.remote.openedAt.length
      desyncCurrent()
    }

    assert.ok(ended, 'the follow ends instead of looping forever')
    assert.equal(ended.done, true, 'the end is not a frame')

    // The cap decided, not the reader: the opening plus five DESYNC attempts (the fifth is
    // the one that reaches MAX_CONSECUTIVE_DESYNCS), each opened only after the previous
    // stream was released, each waiting longer than the one before.
    assert.equal(harness.remote.openedAt.length, 6,
      `the opening plus five desync attempts, then the cap (saw ${harness.remote.openedAt.length}, logs: ${JSON.stringify(harness.logs)})`)
    const attempts = harness.remote.openedAt.slice(1)
    const gaps = attempts.slice(1).map((at, index) => at - attempts[index])
    for (const [index, gap] of gaps.entries()) {
      // Generous bounds: the pump's timer is the schedule under test, the poll is only noise.
      assert.ok(gap >= 100 * (index + 1) - 40, `gap ${index + 1} waited >= ${100 * (index + 1)} ms (saw ${gap} ms)`)
    }
    assert.ok(attempts[0] - opening >= 50, 'the first re-open waited the minimum delay')
    assert.deepEqual(harness.remote.overlaps, [], 'no re-open ever overlapped a live subscription')
    assert.equal(harness.logs.filter((line) => line.includes('remote/stream-desync-repeated')).length, 1,
      'the visible terminal code is logged exactly once')
  } finally { control.abort() }
})
test('a DESYNC followed by healthy frames starts the counter over', async () => {
  const harness = createStrictHarness()
  const control = new AbortController()
  try {
    const iterator = await strictFollow(harness, control)
    harness.remote.old().queue.push(snapshot(2))
    assert.equal((await nextFrame(iterator, 'opening snapshot')).value.cursor, 2)

    // Four consecutive desyncs: one short of the cap.
    for (let round = 1; round <= 4; round += 1) {
      const before = harness.remote.openedAt.length
      const old = harness.remote.old()
      old.queue.failWith(desync())
      harness.remote.release(old)
      await until(() => harness.remote.openedAt.length === before + 1, `desync ${round} to re-open`)
    }
    // Then an attempt that delivers: that, not the open, is what resets the counter.
    harness.remote.old().queue.push(increment(3))
    assert.equal((await nextFrame(iterator, 'a healthy frame')).value.event.seq, 3)
    harness.remote.old().queue.push(increment(4))
    assert.equal((await nextFrame(iterator, 'another healthy frame')).value.event.seq, 4)
    const progressedAt = Date.now()

    // Four more desyncs right after: without the reset the fifth would have been the cap.
    for (let round = 1; round <= 4; round += 1) {
      const before = harness.remote.openedAt.length
      const old = harness.remote.old()
      old.queue.failWith(desync())
      harness.remote.release(old)
      await until(() => harness.remote.openedAt.length === before + 1, `second series desync ${round}`)
    }
    assert.equal(harness.logs.filter((line) => line.includes('remote/stream-desync-repeated')).length, 0,
      'no terminal error: the counter started over after the frames')
    // The backoff restarted too: the first re-open after progress waited the minimum delay
    // (the fourth desync of the first series had waited ~400 ms).
    const firstGap = harness.remote.openedAt.at(-4) - progressedAt
    assert.ok(firstGap < 300, `the first re-open after progress waited the short delay (saw ${firstGap} ms)`)

    // The follow is still repairing itself, one subscription at a time.
    harness.remote.old().queue.push(increment(5))
    assert.equal((await nextFrame(iterator, 'live after the second series')).value.event.seq, 5)
    assert.deepEqual(harness.remote.overlaps, [], 'the Host never held two subscriptions at once')
    assert.equal(harness.remote.live(), 1, 'exactly one subscription is held while the follow runs')
  } finally { control.abort() }
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
