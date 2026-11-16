// Spec 008 follow stream — the two symptoms the owner reported (2026-11-15) in a
// remote session opened from this window's native UI:
//
//   (a) the assistant reply renders BEFORE the prompt that triggered it;
//   (b) the prompt renders TWICE.
//
// The native chat draws its rows in the order the router hands the Host's events over
// (`ui-chat` `observedInputs` keys each row by its `anchorSeq`). A FIRST open delivers
// the Host's snapshot unchanged (the client validates that frame and it carries its rows
// in `records`, so nothing here is counted as an `event`). A RE-JOINED follow cannot do
// that — a second snapshot would replace the journal the reader already holds — so its
// page is handed over as plain `event` frames, and THAT is where the order and the
// duplication matter: the Host answers a repair in two regions (its own events past the
// page's cursor, then `records`), and only the router can merge them back into the one
// journal order the session happened in.
//
// Runs with `node --test --test-isolation=none test/follow-report.test.mjs`. No socket:
// the remote is a stub connection like test/follow-dedupe.test.mjs uses, and the
// "re-join" is a link blip it already models (`closeCode: 1006`).
import assert from 'node:assert/strict'
import { test } from 'node:test'

import { createHostRouter, PINNED_DSH_VERSION } from '../lib/host-router.mjs'
import { createSessionCache } from '../lib/session-cache.mjs'
import { tempDir } from './helpers.mjs'

const HOST = '0f0eca3e-d956-493c-8ec8-115faa4e5dbb'
const SESSION = 'sess-report'

function createQueue() {
  const items = []
  const waiters = []
  let closed = false
  let error = null
  const settle = () => { for (const waiter of waiters.splice(0)) waiter({ value: undefined, done: true }) }
  return {
    push(value) {
      const waiter = waiters.shift()
      if (waiter) waiter({ value, done: false })
      else items.push(value)
    },
    fail(code) {
      if (closed) return
      error = Object.assign(new Error(`the connection closed (${code})`), { closeCode: code })
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

const userTurn = (seq, text) => ({ seq, type: 'user/message',
  data: { sessionId: SESSION, source: { kind: 'user', rpcId: `rpc-${seq}` }, content: [{ kind: 'text', text }] } })
const assistantTurn = (seq) => ({ seq, type: 'assistant/message', data: { sessionId: SESSION, content: [{ kind: 'text', text: 'reply' }] } })
const record = (event) => ({ type: 'event', event })

/**
 * The page the Host opens with: its records reach back over the page, up to its own last
 * event. The page's OWN events (the ones it lists past `cursor`) are a separate, optional
 * list, because the Host orders them before the records and never repeats them there.
 */
const page = (cursor, records, own = []) => ({
  type: 'snapshot', request: { reason: 'anonymous', cursor: 'older' }, header: { version: 4, id: SESSION }, cursor,
  records: [...records.map(record)], ...(own.length > 0 ? { events: own.map(record) } : {}),
  hasMore: false, projections: { asOfSeq: cursor, values: {} }, assistantStream: { revision: 0 },
})

/** The same records as the `created` fill of a relative request: no events of its own. */
const fill = (records) => ({ records: [...records.map(record)], created: true })

function createHarness({ withCache = false } = {}) {
  const remote = { hostId: HOST, hostName: 'Sigma-Remote', streams: [] }
  const connection = {
    state: 'online',
    async call() { return {} },
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
    async dispatchRpc(endpoint, payload, signal, peer) { void [endpoint, payload, signal, peer]; return { ok: true, value: {} } },
    async openWireStream(endpoint, payload, uplink, peer, signal, control, window) {
      void [endpoint, payload, uplink, peer, signal, control, window]
      return createQueue()
    },
  }
  const cache = withCache ? createSessionCache({ dir: tempDir('dsh-devices-report-') }) : undefined
  const router = createHostRouter({
    gateway,
    dshVersion: PINNED_DSH_VERSION,
    hosts: () => (online ? [{ hostId: HOST, hostName: 'Sigma-Remote', connection, online: true }] : []),
    onHostsChanged: (listener) => { listeners.add(listener); return () => listeners.delete(listener) },
    ...(cache ? { cache } : {}),
  })
  assert.equal(router.install().remote, true)
  return {
    router, gateway, remote, cache,
    drop() { online = false; notify() },
    restore() { online = true; notify() },
  }
}

async function until(condition, label, tries = 400) {
  for (let attempt = 0; attempt < tries; attempt += 1) {
    if (condition()) return
    await new Promise((resolve) => setTimeout(resolve, 5))
  }
  throw new Error(`timed out waiting for ${label}`)
}

const settle = (ms = 40) => new Promise((resolve) => setTimeout(resolve, ms))

/** One reader of a `session/follow`, as the native client reads it. */
function createReader(harness) {
  const seen = []
  const control = new AbortController()
  let error = null
  // The client's own cancellation lives in the payload (rc.1 `signal`). The pump's
  // stream is its own iterator, so the reader walks the stream itself.
  const started = (async () => {
    const stream = await harness.gateway.openWireStream('session/follow', {
      args: { request: { address: { kind: 'session', sessionId: `h:${HOST}:${SESSION}` } } },
      signal: control.signal,
    }, undefined, {}, undefined, control, 64)
    void (async () => {
      for await (const value of stream) seen.push(value)
    })().catch((cause) => { error = cause })
  })()
  return {
    seen, started,
    get error() { return error },
    /** The plain `event` frames: what a RE-JOINED follow hands over (a first open is a snapshot). */
    events() { return seen.filter((frame) => frame.type === 'event').map((frame) => frame.event) },
    /** Every row the reader holds, wherever the frame carried it. */
    rows() {
      const out = []
      for (const frame of seen) {
        if (frame.type === 'event') out.push(frame.event.seq)
        for (const part of [frame, ...(Array.isArray(frame.records) ? frame.records : [])]) {
          if (part?.type === 'event' && Number.isSafeInteger(part.event?.seq)) out.push(part.event.seq)
        }
      }
      return out
    },
    stop() { control.abort() },
  }
}

/** Blip the link and re-join the follow once; the new stream is the last one. */
async function reconnect(harness) {
  const before = harness.remote.streams.length
  harness.remote.streams.at(-1).queue.fail(1006)
  harness.drop()
  harness.restore()
  await until(() => harness.remote.streams.length === before + 1, 'the follow to re-open')
  return harness.remote.streams.at(-1)
}

test('a first open is the Host\'s snapshot, and the re-joined page adds no duplicate', async () => {
  const harness = createHarness()
  const reader = createReader(harness)
  try {
    await reader.started
    await until(() => harness.remote.streams.length === 1, 'the follow to open')
    harness.remote.streams[0].queue.push(page(2, [userTurn(1, 'first prompt'), assistantTurn(2)]))
    await until(() => reader.rows().length === 2, 'the opening snapshot')
    assert.deepEqual(reader.rows(), [1, 2], 'the first open is the snapshot, its rows in Host order')
    assert.equal(reader.events().length, 0, 'a first open is not rewritten into events')

    const reopened = await reconnect(harness)
    // The Host answers the re-join with the page it holds. Every seq the reader already
    // shows is in it; nothing of it may reach the reader a second time.
    reopened.queue.push(page(2, [assistantTurn(2), userTurn(1, 'first prompt')]))
    await settle()
    assert.deepEqual(reader.events().map((event) => event.seq), [],
      'a re-join repeats nothing the reader already holds')
    assert.equal(reader.error, null)
  } finally { reader.stop() }
  harness.router.uninstall()
})

test('a re-joined page past the reader is handed over oldest first, and its created fill adds no duplicate', async () => {
  const harness = createHarness()
  const reader = createReader(harness)
  try {
    await reader.started
    await until(() => harness.remote.streams.length === 1, 'the follow to open')
    harness.remote.streams[0].queue.push(page(2, [userTurn(1, 'first prompt'), assistantTurn(2)]))
    await until(() => reader.rows().length === 2, 'the opening snapshot')

    // The re-join brings the next turn: the Host sends it as ITS OWN events first (newest
    // first: reply 5, then prompt 4), then the records that reach back over the page.
    const reopened = await reconnect(harness)
    reopened.queue.push(page(5, [userTurn(4, 'final prompt')], [assistantTurn(5)]))
    reopened.queue.push(fill([userTurn(4, 'final prompt'), assistantTurn(5)]))
    await until(() => reader.events().length === 2, 'the missed turn')
    await settle()
    assert.deepEqual(reader.events().map((event) => event.seq), [4, 5],
      'the prompt is handed over BEFORE the reply it triggered, in either region')
    assert.equal(reader.error, null)

    // The next re-join replays the same page: nothing reaches the reader twice.
    const again = await reconnect(harness)
    again.queue.push(page(5, [userTurn(4, 'final prompt')], [assistantTurn(5)]))
    again.queue.push(fill([userTurn(4, 'final prompt'), assistantTurn(5)]))
    await settle()
    assert.deepEqual(reader.events().map((event) => event.seq), [4, 5], 'the replay adds nothing')
  } finally { reader.stop() }
  harness.router.uninstall()
})

test('a re-joined page is written to the offline copy once, in commit order', async () => {
  const harness = createHarness({ withCache: true })
  const reader = createReader(harness)
  try {
    await reader.started
    await until(() => harness.remote.streams.length === 1, 'the follow to open')
    harness.remote.streams[0].queue.push(page(2, [userTurn(1, 'first prompt'), assistantTurn(2)]))
    await until(() => reader.rows().length === 2, 'the opening snapshot')
    const reopened = await reconnect(harness)
    reopened.queue.push(page(5, [userTurn(4, 'final prompt')], [assistantTurn(5)]))
    reopened.queue.push(fill([userTurn(4, 'final prompt'), assistantTurn(5)]))
    await settle()
    const cached = harness.cache.history(HOST, SESSION)
    assert.deepEqual(cached.events.map((event) => event.seq), [1, 2, 4, 5],
      'a transcript replayed for an offline host reads in the order it happened, once')
  } finally { reader.stop() }
  harness.router.uninstall()
})
