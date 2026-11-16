// Spec 008 follow stream: a remote user turn renders ONCE (owner evidence
// 2026-11-14 21:20: one prompt with an image rendered twice — in its place and
// again at the bottom after the reply — while the Host committed one user turn).
//
// The duplicate this pins is the live path, not the resume path. A follow pumps:
// it opens on a snapshot, delivers live frames, and on a link loss re-opens the
// SAME follow and hands the reader only the durable events it has not seen
// (`resumedFollowFrames`, keyed by the Host's own `seq` — never by text, so the
// same prompt typed twice stays two rows).
//
// Runs with `node --test --test-isolation=none test/follow-dedupe.test.mjs`. No
// socket: the remote is a stub connection whose stream fails with the close code
// a dropped link produces, and the host set moves the way the link supervisor
// moves it (a state change, then `onHostsChanged`).
import assert from 'node:assert/strict'
import { test } from 'node:test'

import { createHostRouter, PINNED_DSH_VERSION } from '../lib/host-router.mjs'

const HOST = 'hostB'
const SESSION = 's1'

/** A pushable async sequence whose failure mode is a dropped link. */
function createQueue() {
  const items = []
  const waiters = []
  let closed = false
  let error = null
  // A closed stream settles each pending read with a real IteratorResult: `undefined`
  // instead would make `for await` throw "Iterator result undefined is not an object".
  const settle = () => { for (const waiter of waiters.splice(0)) waiter({ value: undefined, done: true }) }
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
      settle()
    },
    /** Fail with the exact error the client raises (a stream-protocol error, no close code). */
    failWith(cause) {
      if (closed) return
      error = cause
      closed = true
      settle()
    },
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
          settle()
          return { value: undefined, done: true }
        },
      }
    },
  }
}

const record = (seq, type, data = {}) => ({ type: 'event', event: { seq, type, data: { sessionId: SESSION, ...data } } })
const userTurn = (seq, text = 'first connect succeeded, cheer!') => record(seq, 'user/message',
  // The reported turn carried an image attachment next to its text.
  { content: [{ kind: 'text', text }, { kind: 'attachment', attachmentId: 'a1', mediaType: 'image/png' }] })
const assistantTurn = (seq) => record(seq, 'assistant/message', { content: [{ kind: 'text', text: 'reply' }] })

/** What a real Host answers: a full opening snapshot through `throughSeq`. */
const snapshot = (throughSeq) => ({
  type: 'snapshot', header: { version: 4, id: SESSION }, cursor: throughSeq,
  records: [], hasMore: false, projections: { asOfSeq: throughSeq, values: {} },
  assistantStream: { revision: 0 },
})

function createHarness() {
  const remote = { hostId: HOST, hostName: 'Host B', calls: [], streams: [] }
  const connection = {
    state: 'online',
    async call(endpoint, args) {
      remote.calls.push({ endpoint, args })
      return {}
    },
    async openStream(endpoint, args, options) {
      const queue = createQueue()
      remote.streams.push({ endpoint, args, options, queue })
      return queue
    },
  }
  let online = true
  const listeners = new Set()
  const notify = () => { for (const listener of [...listeners]) listener() }
  const gateway = {
    // rc.1 arities: the wrapper's self-test probes both (>= 4 and >= 5 parameters).
    async dispatchRpc(endpoint, payload, signal, peer) {
      void [endpoint, payload, signal, peer]
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
    hosts: () => (online ? [{ hostId: HOST, hostName: 'Host B', connection, online: true }] : []),
    onHostsChanged: (listener) => { listeners.add(listener); return () => listeners.delete(listener) },
  })
  const status = router.install()
  assert.equal(status.remote, true, 'the wrapper must be live for this test')
  return {
    router, gateway, remote, connection,
    /** The host's link dropped: the host leaves the connected set. */
    drop() { online = false; notify() },
    restore() { online = true; notify() },
  }
}

/** Wait until `condition` holds, so an asynchronous re-open cannot race the test. */
async function until(condition, label, tries = 300) {
  for (let attempt = 0; attempt < tries; attempt += 1) {
    if (condition()) return
    await new Promise((resolve) => setTimeout(resolve, 5))
  }
  throw new Error(`timed out waiting for ${label}`)
}

const settle = (ms = 30) => new Promise((resolve) => setTimeout(resolve, ms))

const followPayload = (extra = {}) => ({
  args: { request: { address: { kind: 'session', sessionId: `h:${HOST}:${SESSION}` }, ...extra } },
})

/** The reader's view of a follow: everything it was handed, in order. */
function createReader(harness, { payload = followPayload(), signal } = {}) {
  const seen = []
  const control = new AbortController()
  let error = null
  let source
  let ready
  const started = (async () => {
    source = await harness.gateway.openWireStream('session/follow', payload, undefined, {}, signal ?? control.signal, control, 64)
    const iterator = source[Symbol.asyncIterator]()
    ready = true
    void (async () => {
      for (;;) {
        const { value, done } = await iterator.next()
        if (done) break
        seen.push(value)
      }
    })().catch((cause) => { error = cause })
  })()
  return {
    seen,
    started,
    ready: () => ready === true,
    get error() { return error },
    /** The durable event seqs the reader was handed, in arrival order. */
    seqs() { return seen.filter((frame) => frame.type === 'event').map((frame) => frame.event.seq) },
    types() { return seen.map((frame) => frame.type) },
    stop() { control.abort() },
  }
}

test('a user turn is delivered once, and the turn end (re-open) replays none of it', async () => {
  const harness = createHarness()
  const reader = createReader(harness)
  try {
    await reader.started
    await until(() => harness.remote.streams.length === 1, 'the follow to open')
    // Opening snapshot of a session whose turn has just been committed at the Host.
    harness.remote.streams[0].queue.push(snapshot(0))
    await until(() => reader.seen.length === 1, 'the opening snapshot')
    // The turn the owner reported: one prompt WITH an image, then the reply.
    harness.remote.streams[0].queue.push(userTurn(1))
    harness.remote.streams[0].queue.push(assistantTurn(2))
    await until(() => reader.seqs().length === 2, 'the live turn')
    assert.deepEqual(reader.seqs(), [1, 2], 'the turn arrives once, in Host order')

    // Turn end. Whatever the real code does next — the Host closes the stream, or the
    // link blips and comes back — the follow re-opens with a fresh snapshot holding
    // the whole turn again. None of it may reach a reader that already showed it.
    harness.remote.streams[0].queue.fail(1006)
    harness.drop()
    harness.restore()
    await until(() => harness.remote.streams.length === 2, 'the follow to re-open')
    const reopened = harness.remote.streams[1]
    assert.deepEqual(reopened.args, { request: { address: { kind: 'session', sessionId: SESSION } } },
      'the re-open asks the Host for its own id')
    reopened.queue.push({
      ...snapshot(2),
      records: [{ type: 'event', event: userTurn(1).event }, { type: 'event', event: assistantTurn(2).event }],
    })
    await settle()
    assert.deepEqual(reader.seqs(), [1, 2], 'no user event is replayed: the row appears once')
    assert.equal(reader.types()[0], 'snapshot', 'the reader saw exactly one opening snapshot')

    // The session stays live: the next turn crosses once more.
    reopened.queue.push(userTurn(3))
    await until(() => reader.seqs().length === 3, 'the next live event')
    assert.deepEqual(reader.seqs(), [1, 2, 3])
    assert.equal(reader.error, null, 'the re-open never failed the reader')
  } finally { reader.stop() }
})

test('reconnect resume after seq N: no duplicate of N, no gap after it', async () => {
  const harness = createHarness()
  const reader = createReader(harness)
  try {
    await reader.started
    await until(() => harness.remote.streams.length === 1, 'the follow to open')
    harness.remote.streams[0].queue.push(snapshot(5))
    await until(() => reader.seen.length === 1, 'the opening snapshot')
    // Live up to N = 8.
    for (const seq of [6, 7, 8]) harness.remote.streams[0].queue.push(record(seq, 'assistant/message'))
    await until(() => reader.seqs().length === 3, 'events up to N')
    assert.deepEqual(reader.seqs(), [6, 7, 8])

    harness.remote.streams[0].queue.fail(1006)
    harness.drop()
    harness.restore()
    await until(() => harness.remote.streams.length === 2, 'the resume')
    // The resume snapshot holds the whole session again — through the events already
    // shown AND the missed 9, 10 — as records it must filter, not re-deliver.
    harness.remote.streams[1].queue.push({
      ...snapshot(10),
      records: [6, 7, 8, 9, 10].map((seq) => ({ type: 'event', event: record(seq, 'user/message').event })),
    })
    await until(() => reader.seqs().length === 5, 'the missed stretch')
    assert.deepEqual(reader.seqs(), [6, 7, 8, 9, 10], 'N is not repeated and the gap after it is filled')
    assert.equal(reader.error, null)
    // And the resumed stream is live, not a one-shot replay.
    harness.remote.streams[1].queue.push(record(11, 'assistant/message'))
    await until(() => reader.seqs().length === 6, 'live after the resume')
    assert.deepEqual(reader.seqs(), [6, 7, 8, 9, 10, 11])
  } finally { reader.stop() }
})

test('the same prompt sent twice is TWO rows: dedupe is by Host seq, never by text', async () => {
  const harness = createHarness()
  const reader = createReader(harness)
  try {
    await reader.started
    await until(() => harness.remote.streams.length === 1, 'the follow to open')
    harness.remote.streams[0].queue.push(snapshot(0))
    await until(() => reader.seen.length === 1, 'the opening snapshot')
    // The user types the exact same message (image included) twice; the Host commits
    // two user/message events with their own seqs.
    harness.remote.streams[0].queue.push(userTurn(1))
    harness.remote.streams[0].queue.push(userTurn(2))
    await until(() => reader.seqs().length === 2, 'both prompts')
    assert.deepEqual(reader.seqs(), [1, 2], 'identical text is not collapsed: the seqs differ')
    const [first, second] = reader.seen.filter((frame) => frame.type === 'event')
    assert.deepEqual(first.event.data.content, second.event.data.content, 'the two rows say the same thing')
    assert.notEqual(first.event.seq, second.event.seq, 'but they are distinct durable events')

    // Same guarantee across a resume: both are distinct, so both stay.
    harness.remote.streams[0].queue.fail(1006)
    harness.drop()
    harness.restore()
    await until(() => harness.remote.streams.length === 2, 'the resume')
    harness.remote.streams[1].queue.push({
      ...snapshot(2),
      records: [{ type: 'event', event: userTurn(1).event }, { type: 'event', event: userTurn(2).event }],
    })
    await settle()
    assert.deepEqual(reader.seqs(), [1, 2], 'a resume replays neither of the two')
  } finally { reader.stop() }
})

test('a live follow keeps the Host\'s assistant-stream frames; a resume does not replay them', async () => {
  const harness = createHarness()
  const reader = createReader(harness, { payload: followPayload({ assistantStream: true }) })
  try {
    await reader.started
    await until(() => harness.remote.streams.length === 1, 'the follow to open')
    harness.remote.streams[0].queue.push(snapshot(1))
    await until(() => reader.seen.length === 1, 'the opening snapshot')
    // Live streaming text: presentation frames, not durable events.
    harness.remote.streams[0].queue.push({ type: 'assistant-stream', frame: {
      type: 'start', attemptId: 'a1', revision: 1, turn: 1, step: 1, startedAfterSeq: 1,
    } })
    harness.remote.streams[0].queue.push({ type: 'assistant-stream', frame: {
      type: 'chunk', attemptId: 'a1', revision: 2, index: 0, time: 1, chunk: { type: 'text', text: 'rep' },
    } })
    await until(() => reader.types().filter((type) => type === 'assistant-stream').length === 2,
      'the live assistant frames')
    assert.deepEqual(reader.types(), ['snapshot', 'assistant-stream', 'assistant-stream'],
      'live streaming text reaches the client')
    assert.equal(reader.seen[2].frame.revision, 2, 'renamed, not dropped')

    // The link drops while turn 1 is still streaming: its attempt was open at revision
    // 1. The Host re-opens with a baseline naming exactly that (`revision: 1`,
    // `activeAttempt.a4` — what `SessionAssistantStreamAccumulator.snapshot()` sends).
    // Its next frame sits at the revision the baseline named (2: the Host resumes the
    // open attempt, so it is the reader's own text continued, delivered), and the frame
    // after that (3) is a new counter → held only if it continues the stale attempt.
    harness.remote.streams[0].queue.fail(1006)
    harness.drop()
    harness.restore()
    await until(() => harness.remote.streams.length === 2, 'the resume')
    const resumed = harness.remote.streams[1]
    resumed.queue.push({
      ...snapshot(2),
      records: [{ type: 'event', event: assistantTurn(2).event }],
      assistantStream: {
        revision: 1,
        activeAttempt: {
          attemptId: 'a4', startedAfterSeq: 1, turn: 2, step: 1, nextIndex: 1,
          stream: { time: 1, turns: [], calls: [], errors: [] },
        },
      },
    })
    resumed.queue.push({ type: 'assistant-stream', frame: {
      type: 'chunk', attemptId: 'a4', revision: 2, index: 1, time: 2, chunk: { type: 'text', text: 'x' },
    } })
    // The next turn's own start: a NEW attempt, so it crosses and the reader keeps
    // streaming after the resume.
    resumed.queue.push({ type: 'assistant-stream', frame: {
      type: 'start', attemptId: 'b9', revision: 4, turn: 3, step: 1, startedAfterSeq: 2,
    } })
    await until(() => reader.seqs().length === 1, 'the committed reply')
    await settle()
    assert.deepEqual(reader.types(), ['snapshot', 'assistant-stream', 'assistant-stream', 'event', 'assistant-stream', 'assistant-stream'],
      'the open attempt continues at the revision the baseline named; the replay is never doubled')
    assert.deepEqual(reader.seqs(), [2], 'the committed reply crosses exactly once')
    assert.equal(reader.seen.at(-1).frame.type, 'start', 'a new attempt streams after a resume')
    assert.equal(reader.seen.at(-1).frame.attemptId, 'b9')
  } finally { reader.stop() }
})

/**
 * A real re-opened follow, as the Host sends it (`session/follow` in
 * dsh-api-session-controller): the snapshot page (`records`, here the newest events
 * through `cursor`), then the assistant-stream baseline naming the attempt still open
 * and the revision its stream continues at (`{revision: R}`), then live frames.
 */
const resumeSnapshot = ({ cursor, records, revision, activeAttempt }) => ({
  ...snapshot(cursor),
  records: records.map((event) => ({ type: 'event', event })),
  assistantStream: { revision, ...(activeAttempt === undefined ? {} : { activeAttempt }) },
})

/** One assistant-stream frame as the Host writes it (`{type:'assistant-stream', frame}`). */
const streamFrame = (revision, wire) => ({ type: 'assistant-stream', frame: { revision, ...wire } })

test('after a reconnect a NEW turn streams start/chunk/end, and no old presentation is replayed', async () => {
  // Reviewer finding (review-webunlock2, Major): `resuming` was set for the whole
  // re-opened attempt, so every frame after a reconnect or DESYNC went through the
  // resume filter — which keeps only a snapshot's events and durable events — and the
  // assistant-stream frames of every LATER turn were dropped: only committed messages
  // arrived. This pins the repair: the resume boundary is the Opening (the snapshot
  // and the stretch lost with it), and the connection is live from there on.
  const harness = createHarness()
  const reader = createReader(harness, { payload: followPayload({ assistantStream: true }) })
  try {
    await reader.started
    await until(() => harness.remote.streams.length === 1, 'the follow to open')
    harness.remote.streams[0].queue.push(snapshot(0))
    await until(() => reader.seen.length === 1, 'the opening snapshot')
    // Turn 1 streams and completes BEFORE the link drops.
    harness.remote.streams[0].queue.push(streamFrame(1, {
      type: 'start', attemptId: 'a1', turn: 1, step: 1, startedAfterSeq: -1,
    }))
    harness.remote.streams[0].queue.push(streamFrame(2, {
      type: 'chunk', attemptId: 'a1', index: 0, time: 1, chunk: { type: 'text', text: 'old' },
    }))
    harness.remote.streams[0].queue.push(streamFrame(3, {
      type: 'end', attemptId: 'a1', index: 1, outcome: { kind: 'settled', seq: 1, eventType: 'assistant/message' },
    }))
    // The commit the `end` names, as the Host follows it with (the durable window).
    harness.remote.streams[0].queue.push(assistantTurn(1))
    await until(() => reader.seqs().length === 1, 'turn 1 to commit')
    assert.deepEqual(reader.types(), ['snapshot', 'assistant-stream', 'assistant-stream', 'assistant-stream', 'event'])

    // Reconnect. The re-opened follow carries turn 1 again in its page AND names it
    // still open in its baseline — the stale presentation of a turn that completed.
    harness.remote.streams[0].queue.fail(1006)
    harness.drop()
    harness.restore()
    await until(() => harness.remote.streams.length === 2, 'the follow to re-open')
    const resumed = harness.remote.streams[1]
    resumed.queue.push(resumeSnapshot({
      cursor: 1,
      records: [assistantTurn(1).event],
      revision: 3,
      activeAttempt: {
        attemptId: 'a1', startedAfterSeq: -1, turn: 1, step: 1, nextIndex: 1,
        stream: { time: 1, turns: [], calls: [], errors: [] },
      },
    }))
    // The Host's residue of that attempt: another `chunk` of turn 1, at the counter its
    // baseline also names (the same attempt, a revision the reader already showed).
    resumed.queue.push(streamFrame(3, {
      type: 'chunk', attemptId: 'a1', index: 1, time: 1, chunk: { type: 'text', text: 'stale' },
    }))
    await settle()
    assert.deepEqual(reader.seqs(), [1], 'no durable event is replayed after the reconnect')
    assert.equal(reader.types().filter((type) => type === 'snapshot').length, 1, 'one opening snapshot, ever')
    assert.equal(reader.types().filter((type) => type === 'assistant-stream').length, 3,
      'the stale presentation of the completed turn 1 is not replayed')

    // A user prompt arrives after the reconnect. That turn is NEW: the Host restarts
    // its counter for a fresh attempt (`start` at revision 1, after the baseline's 3),
    // and its chunks must reach the reader.
    resumed.queue.push(record(2, 'user/message', { content: [{ kind: 'text', text: 'next one' }] }))
    resumed.queue.push(streamFrame(1, { type: 'start', attemptId: 'b1', turn: 3, step: 1, startedAfterSeq: 2 }))
    await until(() => reader.types().filter((type) => type === 'assistant-stream').length === 4,
      "the new turn's start frame after the reconnect")
    resumed.queue.push(streamFrame(2, {
      type: 'chunk', attemptId: 'b1', index: 0, time: 2, chunk: { type: 'text', text: 'new' },
    }))
    resumed.queue.push(streamFrame(3, {
      type: 'end', attemptId: 'b1', index: 1, outcome: { kind: 'settled', seq: 3, eventType: 'assistant/message' },
    }))
    resumed.queue.push(assistantTurn(3))
    await until(() => reader.seqs().length === 3, 'the new turn committed')
    // Durable events stay gap-free and single: 1 (turn 1), 2 (the prompt), 3 (the reply).
    assert.deepEqual(reader.seqs(), [1, 2, 3], 'durable events are still de-duplicated by Host seq, with no gap')
    assert.deepEqual(reader.types().slice(-5),
      ['event', 'assistant-stream', 'assistant-stream', 'assistant-stream', 'event'],
      'start, chunk and end of the new turn all reached the reader')
    const streamed = reader.seen.filter((frame) => frame.type === 'assistant-stream').slice(-3)
    assert.deepEqual(streamed.map((frame) => frame.frame.type), ['start', 'chunk', 'end'],
      'the new turn streams to the reader, it does not wait for the commit')
    assert.deepEqual(streamed.map((frame) => frame.frame.revision), [1, 2, 3],
      'whole revision counter, so the consumer sees no gap')
    assert.equal(reader.error, null)
  } finally { reader.stop() }
})

test('the same new-turn streaming holds after a DESYNC re-open', async () => {
  // The DESYNC path re-opens through exactly the same pump (`isLinkFailure`), and it
  // used to leave `resuming` set for the whole attempt as well.
  const harness = createHarness()
  const reader = createReader(harness, { payload: followPayload({ assistantStream: true }) })
  try {
    await reader.started
    await until(() => harness.remote.streams.length === 1, 'the follow to open')
    harness.remote.streams[0].queue.push(snapshot(5))
    await until(() => reader.seen.length === 1, 'the opening snapshot')
    harness.remote.streams[0].queue.push(streamFrame(1, {
      type: 'start', attemptId: 'a1', turn: 2, step: 1, startedAfterSeq: 5,
    }))
    harness.remote.streams[0].queue.push(streamFrame(2, {
      type: 'chunk', attemptId: 'a1', index: 0, time: 1, chunk: { type: 'text', text: 'dropped' },
    }))
    await until(() => reader.types().filter((type) => type === 'assistant-stream').length === 2, 'the turn to start')
    assert.deepEqual(reader.seqs(), [], 'no durable event yet: the snapshot carried none, and the turn is streaming')

    // Out-of-order frames: the client's own transport guard fails the stream with this
    // code, and the pump re-opens from the last durable sequence.
    harness.remote.streams[0].queue.failWith(
      Object.assign(new Error('the remote stream arrived out of order'), { code: 'remote/stream-desync' }))
    await until(() => harness.remote.streams.length === 2, 'the follow to re-open after the desync')
    const resumed = harness.remote.streams[1]
    // The stretch the reader missed (6..7), then a turn 6 that is new to the reader.
    resumed.queue.push(resumeSnapshot({ cursor: 7, records: [record(6, 'step/end').event, record(7, 'step/start').event], revision: 2 }))
    await until(() => reader.seqs().length === 2, 'the missed stretch')
    assert.deepEqual(reader.seqs(), [6, 7], 'the DESYNC gap is filled once, and the opening cut is not repeated')

    resumed.queue.push(streamFrame(1, { type: 'start', attemptId: 'c1', turn: 6, step: 1, startedAfterSeq: 7 }))
    await until(() => reader.types().filter((type) => type === 'assistant-stream').length === 3,
      'the new turn start after a DESYNC re-open')
    resumed.queue.push(streamFrame(2, {
      type: 'chunk', attemptId: 'c1', index: 0, time: 2, chunk: { type: 'text', text: 'after desync' },
    }))
    resumed.queue.push(streamFrame(3, {
      type: 'end', attemptId: 'c1', index: 1, outcome: { kind: 'settled', seq: 8, eventType: 'assistant/message' },
    }))
    resumed.queue.push(assistantTurn(8))
    await until(() => reader.seqs().length === 3, 'the new turn to commit')
    assert.deepEqual(reader.seqs(), [6, 7, 8], 'no duplicate and no gap across the DESYNC repair')
    assert.equal(reader.types().filter((type) => type === 'snapshot').length, 1, 'one opening snapshot, ever')
    const streamed = reader.seen.filter((frame) => frame.type === 'assistant-stream').slice(-3)
    assert.deepEqual(streamed.map((frame) => frame.frame.type), ['start', 'chunk', 'end'],
      'the new turn after a DESYNC streams, it does not freeze until commit')
    assert.equal(reader.error, null)
  } finally { reader.stop() }
})

test('a durable event the Host re-sends on the live stream is not rendered twice', async () => {
  const harness = createHarness()
  const reader = createReader(harness)
  try {
    await reader.started
    await until(() => harness.remote.streams.length === 1, 'the follow to open')
    harness.remote.streams[0].queue.push(snapshot(0))
    await until(() => reader.seen.length === 1, 'the opening snapshot')
    harness.remote.streams[0].queue.push(userTurn(1))
    await until(() => reader.seqs().length === 1, 'the user event')
    // The same durable event, again, on the live stream: one `seq`, one row.
    harness.remote.streams[0].queue.push(userTurn(1))
    await settle()
    assert.deepEqual(reader.seqs(), [1], 'a repeated seq is dropped, not rendered twice')
    // A NEW event is still delivered after it.
    harness.remote.streams[0].queue.push(assistantTurn(2))
    await until(() => reader.seqs().length === 2, 'the next event')
    assert.deepEqual(reader.seqs(), [1, 2])
  } finally { reader.stop() }
})

// The owner's second report (2026-11-14 21:2x): prompts keep reaching the Host and
// calls keep succeeding, but no follow frame arrives on the client — the stream is
// open and silent. This pins what the router does with that: it neither invents
// frames nor loses or repeats the ones a later resume delivers, and a successful
// prompt call in between does not disturb the transcript.
test('a silent follow (frames stop, calls still succeed) loses nothing when it resumes', async () => {
  const harness = createHarness()
  const reader = createReader(harness)
  try {
    await reader.started
    await until(() => harness.remote.streams.length === 1, 'the follow to open')
    harness.remote.streams[0].queue.push(snapshot(3))
    harness.remote.streams[0].queue.push(record(4, 'user/message'))
    await until(() => reader.seqs().length === 1, 'the last frame before the silence')
    const before = reader.seqs().length

    // The stream goes silent: no frame, no close, no credit grill — and the device
    // keeps working, exactly as the Host log showed (prompt calls at 14:20..14:24).
    for (const [index, text] of ['zip prompt', 'second prompt'].entries()) {
      const answered = await harness.connection.call('session/prompt', {
        args: { sessionId: `h:${HOST}:${SESSION}`, text },
      })
      assert.deepEqual(answered, {}, `prompt ${index} still reaches the Host`)
      harness.remote.streams[0].queue.push(record(5 + index, 'user/message', { content: [{ kind: 'text', text }] }))
      await until(() => reader.seqs().length === before + 1 + index, `prompt ${index} to show up`)
    }
    assert.deepEqual(reader.seqs(), [4, 5, 6], 'each prompt renders once while the stream is healthy')

    // Now the silence is real and the link finally drops: the resume must deliver the
    // replies the silent stretch hid, and repeat nothing it already showed.
    harness.remote.streams[0].queue.fail(1006)
    harness.drop()
    harness.restore()
    await until(() => harness.remote.streams.length === 2, 'the resume')
    harness.remote.streams[1].queue.push({
      ...snapshot(8),
      records: [4, 5, 6, 7, 8].map((seq) => ({ type: 'event', event: assistantTurn(seq).event })),
    })
    await until(() => reader.seqs().length === 5, 'the hidden stretch')
    assert.deepEqual(reader.seqs(), [4, 5, 6, 7, 8], 'the silent stretch is filled in once, with no repeat')
    assert.equal(reader.error, null, 'a silent stream is not turned into a failed reader')
    assert.equal(harness.remote.streams[1].endpoint, 'session/follow', 'the resume re-opens the same follow')
  } finally { reader.stop() }
})

/**
 * The baseline a Host sends for an attempt it still has open (`assistantStream` on a
 * re-opened follow): the attempt id, the revision its stream continues at and the
 * chunk ordinal its next chunk carries (`activeAttempt.nextIndex`).
 */
const activeAttempt = (attemptId, nextIndex = 2) => ({
  attemptId, startedAfterSeq: 0, turn: 1, step: 1, nextIndex,
  stream: { time: 1, turns: [], calls: [], errors: [] },
})

test('an attempt active at the reconnect keeps streaming chunk after chunk, and its end', async () => {
  // Reviewer finding (review-follow-reconcile, Major): `continuesOpeningAttempt` allowed
  // only `baseline.revision + 1` and the baseline never advanced, so the attempt the
  // reconnect landed in streamed ONE chunk (revision 12) and then froze: every later
  // revision (13 …) and the `end` that closes it were held back and waited for the commit.
  // The reader's state is advanced with every chunk delivered, so the run continues.
  const harness = createHarness()
  const reader = createReader(harness, { payload: followPayload({ assistantStream: true }) })
  try {
    await reader.started
    await until(() => harness.remote.streams.length === 1, 'the follow to open')
    harness.remote.streams[0].queue.push(snapshot(10))
    await until(() => reader.seen.length === 1, 'the opening snapshot')
    harness.remote.streams[0].queue.push(streamFrame(11, {
      type: 'start', attemptId: 'a7', turn: 2, step: 1, startedAfterSeq: 10,
    }))
    harness.remote.streams[0].queue.push(streamFrame(12, {
      type: 'chunk', attemptId: 'a7', index: 0, time: 1, chunk: { type: 'text', text: 'before the drop ' },
    }))
    await until(() => reader.types().filter((type) => type === 'assistant-stream').length === 2,
      'the turn to stream before the drop')

    // The link drops while a7 is still streaming. The re-opened follow lands at
    // revision 12 (`nextIndex` 2: two chunks, 11 and 12, already in the Host's stream).
    harness.remote.streams[0].queue.fail(1006)
    harness.drop()
    harness.restore()
    await until(() => harness.remote.streams.length === 2, 'the follow to re-open')
    harness.remote.streams[1].queue.push(resumeSnapshot({
      cursor: 10, records: [], revision: 12, activeAttempt: activeAttempt('a7', 2),
    }))
    await settle()
    // The same attempt, still live: both its remaining chunks and the end that closes it.
    harness.remote.streams[1].queue.push(streamFrame(13, {
      type: 'chunk', attemptId: 'a7', index: 1, time: 2, chunk: { type: 'text', text: 'after the drop' },
    }))
    harness.remote.streams[1].queue.push(streamFrame(14, {
      type: 'chunk', attemptId: 'a7', index: 2, time: 3, chunk: { type: 'text', text: ' and done' },
    }))
    harness.remote.streams[1].queue.push(streamFrame(15, {
      type: 'end', attemptId: 'a7', index: 3, outcome: { kind: 'settled', seq: 11, eventType: 'assistant/message' },
    }))
    await until(() => reader.types().filter((type) => type === 'assistant-stream').length === 5,
      'the attempt to finish after the reconnect')
    const resumed = reader.seen.filter((frame) => frame.type === 'assistant-stream').slice(-3)
    assert.deepEqual(resumed.map((frame) => [frame.frame.revision, frame.frame.index]),
      [[13, 1], [14, 2], [15, 3]], 'every chunk and the end continue the attempt once each, in order')
    assert.deepEqual(resumed.map((frame) => frame.frame.type), ['chunk', 'chunk', 'end'])
    assert.equal(resumed[0].frame.chunk.text, 'after the drop', 'the renamed text reaches the reader')
    // The commit the end named arrives afterwards as the durable message, once.
    harness.remote.streams[1].queue.push(assistantTurn(11))
    await until(() => reader.seqs().length === 1, 'the turn to commit')
    assert.deepEqual(reader.seqs(), [11])
    assert.equal(reader.error, null, 'the resumed attempt never failed the carrier')
  } finally { reader.stop() }
})

test('an attempt active at a DESYNC re-open delivers its chunks and end too, and drops the residue', async () => {
  // The DESYNC path re-opens through the same pump, and its baseline names the same
  // kind of open attempt. Its residue (a revision the reader already holds) is dropped
  // once, and everything after it arrives exactly once: no duplicated frame, no gap.
  const harness = createHarness()
  const reader = createReader(harness, { payload: followPayload({ assistantStream: true }) })
  try {
    await reader.started
    await until(() => harness.remote.streams.length === 1, 'the follow to open')
    harness.remote.streams[0].queue.push(snapshot(3))
    await until(() => reader.seen.length === 1, 'the opening snapshot')
    harness.remote.streams[0].queue.push(streamFrame(1, { type: 'start', attemptId: 'd2', turn: 1, step: 1, startedAfterSeq: 3 }))
    harness.remote.streams[0].queue.push(streamFrame(2, {
      type: 'chunk', attemptId: 'd2', index: 0, time: 1, chunk: { type: 'text', text: 'one' },
    }))
    await until(() => reader.types().filter((type) => type === 'assistant-stream').length === 2, 'the turn to start')

    harness.remote.streams[0].queue.failWith(
      Object.assign(new Error('the remote stream arrived out of order'), { code: 'remote/stream-desync' }))
    await until(() => harness.remote.streams.length === 2, 'the follow to re-open after the desync')
    const resumed = harness.remote.streams[1]
    // The run's first frame is the chunk whose ordinal the consumer's own count had
    // reached (the Host's `nextIndex`, here 2: chunks 0 and 1 were drawn before the gap).
    resumed.queue.push(resumeSnapshot({ cursor: 3, records: [], revision: 2, activeAttempt: activeAttempt('d2', 2) }))
    await settle()
    // A frame at the revision the reader already holds is residue: dropped, not doubled.
    resumed.queue.push(streamFrame(2, {
      type: 'chunk', attemptId: 'd2', index: 0, time: 1, chunk: { type: 'text', text: 'residue' },
    }))
    resumed.queue.push(streamFrame(3, {
      type: 'chunk', attemptId: 'd2', index: 1, time: 2, chunk: { type: 'text', text: 'two' },
    }))
    resumed.queue.push(streamFrame(4, {
      type: 'chunk', attemptId: 'd2', index: 2, time: 3, chunk: { type: 'text', text: 'three' },
    }))
    resumed.queue.push(streamFrame(5, {
      type: 'end', attemptId: 'd2', index: 3, outcome: { kind: 'settled', seq: 4, eventType: 'assistant/message' },
    }))
    await until(() => reader.types().filter((type) => type === 'assistant-stream').length === 5,
      'the attempt to finish after the desync')
    const streamed = reader.seen.filter((frame) => frame.type === 'assistant-stream')
    assert.deepEqual(streamed.map((frame) => frame.frame.revision), [1, 2, 3, 4, 5],
      'the residue is dropped once and the run continues 3, 4, end')
    assert.equal(streamed.filter((frame) => frame.frame.type === 'end').length, 1, 'one end, not none')
    assert.deepEqual(streamed.slice(-2).map((frame) => frame.frame.revision), [4, 5], 'no duplicated chunk before the end')
    resumed.queue.push(assistantTurn(4))
    await until(() => reader.seqs().length === 1, 'the turn to commit')
    assert.deepEqual(reader.seqs(), [4])
    assert.equal(reader.error, null)
  } finally { reader.stop() }
})

test('a resumed page\'s created record reaches the reader as the seq range it stands for', async () => {
  // Reviewer finding (review-follow-reconcile, Major): `isSnapshotFrame` called any
  // object with an integer `end` a snapshot, so a resumed created record
  // (`{firstLiveSeq, end}`) took the snapshot branch first, replaced the attempt state
  // and delivered none of the seqs it covers — the gap reconciliation was unreachable.
  const harness = createHarness()
  const reader = createReader(harness)
  try {
    await reader.started
    await until(() => harness.remote.streams.length === 1, 'the follow to open')
    harness.remote.streams[0].queue.push(snapshot(4))
    harness.remote.streams[0].queue.push(record(5, 'user/message'))
    await until(() => reader.seqs().length === 1, 'a live event before the drop')

    harness.remote.streams[0].queue.fail(1006)
    harness.drop()
    harness.restore()
    await until(() => harness.remote.streams.length === 2, 'the follow to re-open')
    const resumed = harness.remote.streams[1]
    // The re-joined page: its own events (6, 7) after the snapshot, then the `created`
    // record that stands for seqs 8..10, whose fill is never sent on the wire.
    resumed.queue.push(resumeSnapshot({ cursor: 10, records: [], revision: 5, activeAttempt: undefined }))
    resumed.queue.push(record(6, 'step/start'))
    resumed.queue.push(record(7, 'step/end'))
    resumed.queue.push({ type: 'created', firstLiveSeq: 8, end: 10 })
    await until(() => reader.seqs().length === 6, 'the created record to be filled')
    assert.deepEqual(reader.seqs(), [5, 6, 7, 8, 9, 10],
      'the reader holds 5, so the created record fills exactly 8..10 and nothing repeats')
    // A already-shown seq inside another record of the same page is still never replayed,
    // and the stream is live again after it.
    resumed.queue.push({ type: 'created', firstLiveSeq: 4, end: 7 })
    resumed.queue.push(record(11, 'assistant/message'))
    await until(() => reader.seqs().length === 7, 'live after the created record')
    assert.deepEqual(reader.seqs(), [5, 6, 7, 8, 9, 10, 11], 'no duplicate of a covered seq, no gap after it')
    assert.equal(reader.error, null)
  } finally { reader.stop() }
})

test('a created record that stands for more than the gap is not folded into the reader', async () => {
  // The fill is a repair for the stretch LOST with the link, never a second window:
  // beyond MAX_RESUME_GAP (4096) the record is refused, so a Host cannot make this
  // router replay a whole session as rows. A refused fill ends the follow visibly
  // (`remote/stream-resume-overflow`) instead of dropping it, which would let later
  // live events carry the reader past seqs it never saw.
  const harness = createHarness()
  const reader = createReader(harness)
  try {
    await reader.started
    await until(() => harness.remote.streams.length === 1, 'the follow to open')
    harness.remote.streams[0].queue.push(snapshot(2))
    await until(() => reader.seen.length === 1, 'the opening snapshot')

    harness.remote.streams[0].queue.fail(1006)
    harness.drop()
    harness.restore()
    await until(() => harness.remote.streams.length === 2, 'the follow to re-open')
    const resumed = harness.remote.streams[1]
    resumed.queue.push(resumeSnapshot({ cursor: 5000, records: [], revision: 0, activeAttempt: undefined }))
    // 4097 seqs unseen: one past the bound.
    resumed.queue.push({ type: 'created', firstLiveSeq: 3, end: 4099 })
    await until(() => reader.error !== null, 'the oversize fill to be refused')
    assert.equal(reader.error.code, 'remote/stream-resume-overflow', 'the refusal is visible')
    assert.deepEqual(reader.seqs(), [], 'an oversize created record delivers nothing')
    assert.equal(harness.remote.streams.length, 2, 'and nothing is accepted behind it')
  } finally { reader.stop() }
})

test('a created record one below the gap is still a lost stretch, and it is filled', async () => {
  const harness = createHarness()
  const reader = createReader(harness)
  try {
    await reader.started
    await until(() => harness.remote.streams.length === 1, 'the follow to open')
    harness.remote.streams[0].queue.push(snapshot(2))
    await until(() => reader.seen.length === 1, 'the opening snapshot')

    harness.remote.streams[0].queue.fail(1006)
    harness.drop()
    harness.restore()
    await until(() => harness.remote.streams.length === 2, 'the follow to re-open')
    const resumed = harness.remote.streams[1]
    resumed.queue.push(resumeSnapshot({ cursor: 5000, records: [], revision: 0, activeAttempt: undefined }))
    // One seq fewer is still a lost stretch, and it is filled.
    resumed.queue.push({ type: 'created', firstLiveSeq: 3, end: 4000 })
    await until(() => reader.seqs().length === 3998, 'the bounded created record to be filled')
    assert.equal(reader.seqs()[0], 3, 'the fill starts at the record, not before it')
    assert.equal(reader.seqs().at(-1), 4000, 'the fill ends at the record')
    assert.equal(reader.error, null)
  } finally { reader.stop() }
})

test('an oversize resume page ends the follow visibly and no later live event is accepted', async () => {
  // Reviewer finding (review-follow-reconcile, Major): the oversize page was returned as
  // `[]` — silently dropped — and the next LIVE event of the same connection advanced
  // `lastSeq` past the whole unseen stretch, so what was skipped for being "too big" was
  // never shown and never could be: permanent loss. The page is now REFUSED, which ends
  // the follow on `remote/stream-resume-overflow` before any later frame is delivered.
  const harness = createHarness()
  const reader = createReader(harness)
  try {
    await reader.started
    await until(() => harness.remote.streams.length === 1, 'the follow to open')
    harness.remote.streams[0].queue.push(snapshot(2))
    await until(() => reader.seen.length === 1, 'the opening snapshot')

    harness.remote.streams[0].queue.fail(1006)
    harness.drop()
    harness.restore()
    await until(() => harness.remote.streams.length === 2, 'the follow to re-open')
    const resumed = harness.remote.streams[1]
    // A gateway-built page has no `cursor` at all, so it is recognised only after a next
    // read (`host-router` `followFrames`, the pre-opening branch): the page is handed to
    // the pump in PARTS — a `created` record standing for 4097 seqs the fill never sends,
    // 3..4099, and the cursor-carrying frame that closes the page — and only then does
    // the repair run and refuse it.
    resumed.queue.push({ type: 'created', firstLiveSeq: 3, end: 4099 })
    resumed.queue.push({ ...resumeSnapshot({ cursor: 4099, records: [], revision: 0, activeAttempt: undefined }), type: 'history' })
    // A live event of this very connection, right behind the refused page: it must never
    // be delivered (nor move `lastSeq`) across the stretch the reader never saw.
    resumed.queue.push(record(4100, 'assistant/message'))
    await until(() => reader.error !== null, 'the follow to end visibly')
    assert.equal(reader.error.code, 'remote/stream-resume-overflow', 'the refusal is the documented code')
    assert.match(reader.error.message, /4097 events this window has not seen, more than 4096/,
      'the message counts what was refused')
    assert.deepEqual(reader.seqs(), [], 'nothing is skipped silently and nothing after it leaks through')
    assert.equal(harness.remote.streams.length, 2, 'the follow does not re-open against the same page')
  } finally { reader.stop() }
})

test('the created record stays part of the page: the resume state it lands in is unchanged', async () => {
  const harness = createHarness()
  const reader = createReader(harness, { payload: followPayload({ assistantStream: true }) })
  try {
    await reader.started
    await until(() => harness.remote.streams.length === 1, 'the follow to open')
    harness.remote.streams[0].queue.push(snapshot(2))
    await until(() => reader.seen.length === 1, 'the opening snapshot')

    harness.remote.streams[0].queue.fail(1006)
    harness.drop()
    harness.restore()
    await until(() => harness.remote.streams.length === 2, 'the follow to re-open')
    const resumed = harness.remote.streams[1]
    // `cursor` 8, a created record covering 3..5, and the attempt this resume landed in
    // (its next chunk is ordinal 0: the resume starts the attempt's run at its rejoin).
    resumed.queue.push(resumeSnapshot({ cursor: 8, records: [], revision: 4, activeAttempt: activeAttempt('e1', 0) }))
    resumed.queue.push({ type: 'created', firstLiveSeq: 3, end: 5 })
    // The created record expands to the seqs 3..5 the reader lacks; the own region of a
    // captured page is delivered after it.
    await until(() => reader.seqs().length === 3, 'the created record to be filled')
    assert.deepEqual(reader.seqs(), [3, 4, 5], 'the record fills exactly the seqs the reader lacks')
    // The created record did not take the snapshot branch: the baseline the page named
    // still governs, so this attempt's next step continues it (the created record added
    // no assistant frame of its own).
    resumed.queue.push(streamFrame(5, {
      type: 'chunk', attemptId: 'e1', index: 0, time: 2, chunk: { type: 'text', text: 'kept' },
    }))
    await until(() => reader.types().filter((type) => type === 'assistant-stream').length === 1,
      'the open attempt to continue after the created record')
    assert.deepEqual(reader.seen.filter((frame) => frame.type === 'assistant-stream')
      .map((frame) => [frame.frame.revision, frame.frame.index]), [[5, 0]],
    'the created record delivered its seqs and left the attempt state alone')
    assert.equal(reader.types().filter((type) => type === 'snapshot').length, 1, 'one opening snapshot, ever')
    assert.equal(reader.error, null)
  } finally { reader.stop() }
})

