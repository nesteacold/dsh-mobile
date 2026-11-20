// Spec 008 P2c (T026) — remote approval/question cards inside the NATIVE
// conversation stream (lib/host-router.mjs `$events` merge).
//
// Runs with `node --test --test-isolation=none test/interactions.test.mjs`. The
// card-shape cases use no socket: the local carrier is a fake `typertGateway` with
// the rc.1 signatures and each remote is a stub connection (an EventEmitter, like
// `RemoteConnection`), so every assertion is about what the controller's own UI
// sees and about what actually crosses the wire to a remote Host. The last two
// cases run the REAL plugins/mobile-gateway in-process (as test/e2e.test.mjs
// does). Two paths, two invariants (owner decision 2026-11-11): a question never
// reaches a PAIRED DEVICE (it has no scope on this channel, and the withholding is
// audited with ids only), while a remote Host's question card DOES reach the
// OWNER's native `$events` stream with its payload so he can answer it — and an
// approval still reaches that device and is applied over the pinned WSS + the bridge.
import assert from 'node:assert/strict'
import fs from 'node:fs'
import http from 'node:http'
import os from 'node:os'
import path from 'node:path'
import { EventEmitter } from 'node:events'
import { test } from 'node:test'

import { PINNED_DSH_VERSION, createHostRouter, hostIdsIn, namespaceId } from '../lib/host-router.mjs'
import { RemoteConnection, claimPairing } from '../lib/remote-client.mjs'
import { requestJson } from './fixture-http.mjs'

// The remote gateway is imported read-only; nothing in it is edited (spec 008).
const gatewayPlugin = (await import('../../mobile-gateway/lib/index.mjs')).default
const { createTestConnection, createTestRemoteAccess } = await import('../../mobile-gateway/test/helpers/peer.mjs')

const HOST = 'hostB'
const HASH = 'a'.repeat(64)
const clone = (value) => (value === undefined ? undefined : structuredClone(value))

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

/** A remote Host: its bridge answers `$events/result`, its device socket pushes cards. */
function createFakeRemote(hostId, hostName, options = {}) {
  const calls = []
  const requests = []
  const streams = []
  const connection = new EventEmitter()
  connection.state = 'online'
  connection.call = async (endpoint, args, callOptions) => {
    calls.push({ endpoint, args: clone(args), options: callOptions })
    // Card tests run against a session the controller already listed on this generation.
    if (endpoint === 'session/list' && options.replies?.['session/list'] === undefined) {
      return { items: [{ sessionId: 's1', updatedAt: 1, running: false, blank: false,
        projections: { kind: 'sequenced', asOfSeq: 1, values: {} } }] }
    }
    const reply = options.replies?.[endpoint]
    if (reply instanceof Error) throw reply
    return typeof reply === 'function' ? reply(args) : clone(reply) ?? {}
  }
  connection.request = async (frame, requestOptions) => {
    requests.push({ frame: clone(frame), options: requestOptions })
    const reply = options.requestReply
    return typeof reply === 'function' ? reply(frame) : clone(reply) ?? { kind: 'question-response', accepted: true }
  }
  connection.openStream = async (endpoint, args) => {
    const queue = createQueue()
    streams.push({ endpoint, args: clone(args), queue })
    return queue
  }
  return {
    hostId, hostName, connection, calls, requests, streams,
    /** The Host pushes one of its own cards to this device. */
    card(frame) { connection.emit(frame.kind === 'question-requested' ? 'question' : 'approval', frame) },
    resolved(frame) { connection.emit(frame.kind === 'question-resolved' ? 'questionResolved' : 'resolved', frame) },
    setState(state) { connection.state = state; connection.emit('state', state) },
  }
}

function createHarness({ remotes = [], pending = () => [], dispatchRpc } = {}) {
  const localCalls = []
  const localStreams = []
  const logs = []
  const gateway = {
    async dispatchRpc(endpoint, payload, signal, peer) {
      localCalls.push({ endpoint, payload: clone(payload) })
      return typeof dispatchRpc === 'function' ? dispatchRpc(endpoint, payload, peer) : { ok: true, value: { local: endpoint } }
    },
    async openWireStream(endpoint, payload, uplink, peer, signal, control, window) {
      const queue = createQueue()
      localStreams.push({ endpoint, payload: clone(payload), window, queue })
      if (endpoint === '$events') queue.push({ type: 'ready', clientId: 'local-client', host: { home: '/home/owner' } })
      return queue
    },
  }
  const listeners = new Set()
  const connected = new Set(remotes.map((remote) => remote.hostId))
  const notify = () => { for (const listener of [...listeners]) listener() }
  const router = createHostRouter({
    gateway,
    dshVersion: PINNED_DSH_VERSION,
    hosts: () => remotes.filter((remote) => connected.has(remote.hostId))
      .map((remote) => ({ hostId: remote.hostId, hostName: remote.hostName, connection: remote.connection, online: true })),
    onHostsChanged: (listener) => { listeners.add(listener); return () => listeners.delete(listener) },
    approvals: { pending: (hostId) => pending(hostId) },
    // The cards in this suite belong to a session the controller already listed.
    // Hydration makes that row known, so a card is published on arrival; the
    // deferred-until-row path has its own test in host-router.test.mjs.
    retention: {
      list: () => remotes.map((remote) => ({ hostId: remote.hostId, sessions: [{
        sessionId: namespaceId(remote.hostId, 's1'), updatedAt: 1, running: false, blank: false,
        projections: { kind: 'sequenced', asOfSeq: 1, values: {} },
      }] })),
      setSessions() {}, setWorkspace() {}, removeHost() {},
    },
    log: (line) => logs.push(line),
  })
  router.install()
  return {
    gateway, router, localCalls, localStreams, remotes, logs,
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

async function openEvents(harness) {
  const control = new AbortController()
  const source = await harness.gateway.openWireStream('$events', { args: {} }, undefined, {}, control.signal, control, 64)
  const iterator = source[Symbol.asyncIterator]()
  const ready = await nextFrame(iterator, '$events ready')
  assert.equal(ready.value.type, 'ready', 'the local stream must start with its own ready frame')
  assert.equal(ready.value.clientId, 'local-client')
  // Prove the CURRENT connection generation has a fresh session/list answer. A stale retained
  // row must never be enough to publish a card: the native binding may be gone after a reconnect.
  await harness.gateway.dispatchRpc('session/list', { args: {} }, undefined, {})
  for (const remote of harness.remotes ?? []) if (Array.isArray(remote.calls)) remote.calls.length = 0
  if (harness.localCalls) harness.localCalls.length = 0
  return { control, iterator }
}

const approvalCard = (rpcId = 'rpc-1', extra = {}) => ({
  kind: 'approval-requested',
  rpcId,
  sessionId: 's1',
  approvalId: 'a1',
  toolName: 'bash',
  callId: 'call-9',
  reason: 'needs a shell',
  argsHash: HASH,
  argsPreview: '{"command":"rm -rf build"}',
  ...extra,
})

const answer = (eventId, value, extra = {}) => ({
  args: { clientId: 'local-client', eventId, outcome: { kind: 'result', value }, ...extra },
})

test('a remote approval card is injected into the native $events stream with a namespaced id', async () => {
  const remote = createFakeRemote(HOST, 'Host B')
  const harness = createHarness({ remotes: [remote] })
  const { control, iterator } = await openEvents(harness)
  try {
    remote.card(approvalCard())
    const card = (await nextFrame(iterator, 'card')).value
    assert.deepEqual(card, {
      type: 'waterfall',
      event: 'approval/request',
      eventId: namespaceId(HOST, 'rpc-1'),
      agentId: namespaceId(HOST, 's1'),
      request: {
        toolName: 'bash',
        callId: 'call-9',
        reason: 'needs a shell',
        argsPreview: '{"command":"rm -rf build"}',
      },
    })
    // The frame is exactly the five keys the rc.1 client validates, and the
    // request carries no `agent`/`signal` (it would be rejected as invalid).
    assert.deepEqual(Object.keys(card).sort(), ['agentId', 'event', 'eventId', 'request', 'type'])
    assert.equal(Object.hasOwn(card.request, 'agent'), false)
    assert.equal(Object.hasOwn(card.request, 'signal'), false)
    // Nothing was sent to the Host just because a card showed up.
    assert.equal(remote.calls.length, 0)
  } finally {
    control.abort()
    await iterator.return()
  }
})

test('answering through the native path sends $events/result to that Host with its ids and argsHash', async () => {
  const remote = createFakeRemote(HOST, 'Host B', { replies: { '$events/result': { accepted: true, outcome: 'allowed-once' } } })
  const harness = createHarness({ remotes: [remote] })
  const { control, iterator } = await openEvents(harness)
  try {
    remote.card(approvalCard())
    await nextFrame(iterator, 'card')

    // The native UI answers with the namespaced eventId it was shown. It has no
    // argsHash of its own: the router binds the card the Host issued.
    const result = await harness.gateway.dispatchRpc('$events/result',
      answer(namespaceId(HOST, 'rpc-1'), 'allowed-once'), undefined, {})
    assert.equal(result.ok, true, JSON.stringify(result))
    assert.deepEqual(result.value, { accepted: true, outcome: 'allowed-once' })
    assert.equal(remote.calls.length, 1)
    assert.equal(remote.calls[0].endpoint, '$events/result')
    assert.deepEqual(remote.calls[0].args, {
      clientId: 'local-client',
      eventId: 'rpc-1',
      rpcId: 'rpc-1',
      sessionId: 's1',
      approvalId: 'a1',
      argsHash: HASH,
      outcome: { kind: 'result', value: 'allowed-once' },
    })
    // No namespaced id may reach a remote Host.
    assert.deepEqual([...hostIdsIn(remote.calls[0].args)], [])
    assert.equal(/h:hostB:/.test(JSON.stringify(remote.calls[0].args)), false)
    // The decision went to the Host, never to the local gateway.
    assert.equal(harness.localCalls.length, 0)
  } finally {
    control.abort()
    await iterator.return()
  }
})

test('a wrong argsHash is refused by the Host and the card stays pending', async () => {
  const remote = createFakeRemote(HOST, 'Host B', {
    replies: {
      '$events/result': (args) => (args.argsHash === HASH
        ? { accepted: true, outcome: 'allowed-once' }
        : { accepted: false, reason: 'hash-mismatch' }),
    },
  })
  const harness = createHarness({ remotes: [remote] })
  const { control, iterator } = await openEvents(harness)
  try {
    remote.card(approvalCard())
    await nextFrame(iterator, 'card')

    const wrong = await harness.gateway.dispatchRpc('$events/result',
      answer(namespaceId(HOST, 'rpc-1'), 'allowed-once', { argsHash: 'b'.repeat(64) }), undefined, {})
    assert.equal(wrong.ok, true)
    assert.deepEqual(wrong.value, { accepted: false, reason: 'hash-mismatch' })
    // The echoed hash travels verbatim (the Host is the authority) …
    assert.equal(remote.calls[0].args.argsHash, 'b'.repeat(64))
    // … and the card is still addressable: the same decision without a hash binds
    // the buffered one and applies exactly once.
    const retried = await harness.gateway.dispatchRpc('$events/result',
      answer(namespaceId(HOST, 'rpc-1'), 'allowed-once'), undefined, {})
    assert.deepEqual(retried.value, { accepted: true, outcome: 'allowed-once' })
    assert.equal(remote.calls[1].args.argsHash, HASH)
  } finally {
    control.abort()
    await iterator.return()
  }
})

test('a decision the controller cannot bind is remote/approval-unbound, not forwarded', async () => {
  const remote = createFakeRemote(HOST, 'Host B')
  const harness = createHarness({ remotes: [remote] })
  const result = await harness.gateway.dispatchRpc('$events/result',
    answer(namespaceId(HOST, 'rpc-unknown'), 'allowed-once'), undefined, {})
  assert.equal(result.ok, false)
  assert.equal(result.error.code, 'remote/approval-unbound')
  assert.equal(remote.calls.length, 0)
})

test('a remote disconnect withdraws its pending cards from the native stream', async () => {
  const remote = createFakeRemote(HOST, 'Host B')
  const harness = createHarness({ remotes: [remote] })
  const { control, iterator } = await openEvents(harness)
  try {
    remote.card(approvalCard('rpc-1'))
    remote.card(approvalCard('rpc-2', { approvalId: 'a2' }))
    await nextFrame(iterator, 'card 1')
    await nextFrame(iterator, 'card 2')

    harness.disconnect(HOST)
    const withdrawn = []
    for (let index = 0; index < 2; index += 1) withdrawn.push((await nextFrame(iterator, 'cancel')).value)
    assert.deepEqual(withdrawn.map((frame) => frame.type), ['cancel', 'cancel'])
    assert.deepEqual(withdrawn.map((frame) => frame.eventId).sort(),
      [namespaceId(HOST, 'rpc-1'), namespaceId(HOST, 'rpc-2')].sort())
    // A withdrawn card can no longer be decided: the Host is gone (and had the
    // decision been attempted while it was up, the card would be unbound).
    const late = await harness.gateway.dispatchRpc('$events/result',
      answer(namespaceId(HOST, 'rpc-1'), 'allowed-once'), undefined, {})
    assert.equal(late.ok, false)
    assert.equal(late.error.code, 'remote/host-offline')
    assert.equal(remote.calls.length, 0, 'nothing was sent to the offline Host')
  } finally {
    control.abort()
    await iterator.return()
  }
})

test('a Host that reports offline withdraws too (state, not only the host list)', async () => {
  const remote = createFakeRemote(HOST, 'Host B')
  const harness = createHarness({ remotes: [remote] })
  const { control, iterator } = await openEvents(harness)
  try {
    remote.card(approvalCard())
    await nextFrame(iterator, 'card')
    remote.setState('offline')
    const cancelled = (await nextFrame(iterator, 'cancel')).value
    assert.deepEqual(cancelled, { type: 'cancel', eventId: namespaceId(HOST, 'rpc-1') })
  } finally {
    control.abort()
    await iterator.return()
  }
})

test('cards buffered before the stream opened are seeded in, and a Host resolve withdraws', async () => {
  const remote = createFakeRemote(HOST, 'Host B')
  const buffered = [approvalCard('rpc-early')]
  const harness = createHarness({ remotes: [remote], pending: () => buffered })
  const { control, iterator } = await openEvents(harness)
  try {
    const seeded = (await nextFrame(iterator, 'seeded card')).value
    assert.equal(seeded.type, 'waterfall')
    assert.equal(seeded.eventId, namespaceId(HOST, 'rpc-early'))
    // The Host resolved it elsewhere (another device, the desktop): the card goes.
    remote.resolved({ kind: 'approval-resolved', rpcId: 'rpc-early', sessionId: 's1', approvalId: 'a1', outcome: 'rejected' })
    const cancelled = (await nextFrame(iterator, 'cancel')).value
    assert.deepEqual(cancelled, { type: 'cancel', eventId: namespaceId(HOST, 'rpc-early') })
  } finally {
    control.abort()
    await iterator.return()
  }
})

test('an ACTIVE remote question is answered through the question-answer frame, exactly once', async () => {
  // The gateway that minted the card owns `pendingQuestions[rpcId]` and settles the
  // Host's tool call. The companion frame is the ONLY active path; the bridge's
  // `userQuestions/answer` finds no open question (dsh-user-questions/index.ts:170).
  const remote = createFakeRemote(HOST, 'Host B', {
    requestReply: (frame) => ({ kind: 'question-response', rpcId: frame.rpcId, sessionId: frame.sessionId,
      action: 'answer', accepted: true }),
  })
  const harness = createHarness({ remotes: [remote] })
  const { control, iterator } = await openEvents(harness)
  try {
    const questions = [{ id: 'q1', header: 'Pick one', options: [{ label: 'A', description: 'a' }, { label: 'B', description: 'b' }], multiSelect: false }]
    remote.card({ kind: 'question-requested', rpcId: 'q-1', sessionId: 's1', callId: 'call-42', questions })
    const card = (await nextFrame(iterator, 'question card')).value
    assert.deepEqual(card, {
      type: 'waterfall',
      event: 'user-questions/request',
      eventId: namespaceId(HOST, 'q-1'),
      agentId: namespaceId(HOST, 's1'),
      // `wait.callId` is the ONLY field DSH consults to key a question card
      // (`dsh-client-ui-user-questions` client/index.ts: `request.wait?.callId`).
      // Without it the card is unnameable: DSH tears it down in the request's
      // `finally` rather than when the projection drops the answered call.
      request: { questions, wait: { callId: 'call-42' } },
    })

    const answers = [{ id: 'q1', selected: ['B'] }]
    // A stale submitter may carry a different sessionId; the frame uses the TRACKED
    // card's ids only — no value from the caller, and no guessed id.
    const result = await harness.gateway.dispatchRpc('$events/result',
      answer(namespaceId(HOST, 'q-1'), { answers }, { sessionId: 's-wrong' }), undefined, {})
    assert.equal(result.ok, true, JSON.stringify(result))
    assert.equal(remote.requests.length, 1, 'exactly one companion answer frame crossed the wire')
    assert.deepEqual(remote.requests[0].frame, {
      type: 'question-answer', rpcId: 'q-1', sessionId: 's1', answers,
    })
    assert.equal(remote.calls.length, 0, 'the CONTINUED-only bridge service was not called for an active question')
    // The receipt travels back namespaced, like every other remote answer.
    assert.deepEqual(result.value, { kind: 'question-response', rpcId: namespaceId(HOST, 'q-1'),
      sessionId: namespaceId(HOST, 's1'), action: 'answer', accepted: true })
    assert.deepEqual([...hostIdsIn(remote.requests[0].frame)], [], 'no namespaced id leaves this controller')
    // Accepted ⇒ the card is CLEARED on this controller: the same eventId no longer
    // binds, so a duplicate cannot reach the gateway a second time.
    const replay = await harness.gateway.dispatchRpc('$events/result',
      answer(namespaceId(HOST, 'q-1'), { answers }), undefined, {})
    assert.equal(replay.ok, false, 'an accepted card is dropped, not left answerable')
    assert.equal(replay.error.code, 'remote/approval-unbound')
    assert.equal(remote.requests.length, 1, 'the accepted answer crossed the wire exactly once')
  } finally {
    control.abort()
    await iterator.return()
  }
})

test('a refused question answer is a visible receipt and the card stays retryable', async () => {
  // A device without approval:respond (or a late duplicate) gets accepted:false.
  // It must NOT silently close the card, and NOT fall through to the CONTINUED
  // service — only "not-pending" permits that fallback.
  const remote = createFakeRemote(HOST, 'Host B', {
    requestReply: (frame) => ({ kind: 'question-response', rpcId: frame.rpcId, sessionId: frame.sessionId,
      action: 'answer', accepted: false, reason: 'not-authorized' }),
  })
  const harness = createHarness({ remotes: [remote] })
  const { control, iterator } = await openEvents(harness)
  try {
    const questions = [{ id: 'q1', header: 'Pick one', options: [{ label: 'A' }] }]
    const answers = [{ id: 'q1', selected: ['A'] }]
    remote.card({ kind: 'question-requested', rpcId: 'q-4', sessionId: 's1', callId: 'call-44', questions })
    await nextFrame(iterator, 'question card')
    const refused = await harness.gateway.dispatchRpc('$events/result',
      answer(namespaceId(HOST, 'q-4'), { answers }), undefined, {})
    assert.equal(refused.ok, true)
    assert.equal(refused.value.accepted, false)
    assert.equal(refused.value.reason, 'not-authorized')
    assert.equal(remote.calls.length, 0, 'a scope refusal must not reach the CONTINUED bridge service')
    assert.equal((await nextEvent(iterator, () => true, { ms: 150 })).frame, null,
      'a refusal emits no cancel/result frame onto the native stream')
    const retried = await harness.gateway.dispatchRpc('$events/result',
      answer(namespaceId(HOST, 'q-4'), { answers }), undefined, {})
    assert.equal(retried.ok, true, JSON.stringify(retried))
    assert.equal(retried.value.reason, 'not-authorized')
    assert.equal(remote.requests.length, 2, 'the refused card stayed tracked, so the retry reached the gateway')
  } finally {
    control.abort()
    await iterator.return()
  }
})

test('the gateway bad-response refusal (device custom-answer policy) stays visible', async () => {
  // The gateway's normalizeQuestionAnswers refuses a custom/empty device answer
  // (index.mjs:2525-2567). The router must surface that code, never weaken it.
  const remote = createFakeRemote(HOST, 'Host B', {
    requestReply: () => ({ kind: 'error', code: 'bad-response', message: 'selected values must match offered option labels',
      requestType: 'question-answer', sessionId: 's1' }),
  })
  const harness = createHarness({ remotes: [remote] })
  const { control, iterator } = await openEvents(harness)
  try {
    remote.card({ kind: 'question-requested', rpcId: 'q-custom', sessionId: 's1', callId: 'call-45',
      questions: [{ id: 'q1', header: 'Pick', options: [{ label: 'A' }] }] })
    await nextFrame(iterator, 'question card')
    const result = await harness.gateway.dispatchRpc('$events/result',
      answer(namespaceId(HOST, 'q-custom'), { answers: [{ id: 'q1', selected: [], custom: 'free text' }] }), undefined, {})
    assert.equal(result.ok, true)
    assert.equal(result.value.accepted, false)
    assert.equal(result.value.reason, 'bad-response', 'the custom-answer refusal is surfaced, not swallowed')
    assert.equal(remote.calls.length, 0, 'no CONTINUED fallback on a bad-response refusal')
    assert.equal(remote.requests.length, 1)
  } finally {
    control.abort()
    await iterator.return()
  }
})

test('only a not-pending receipt reaches the CONTINUED fallback; its refusals stay visible', async () => {
  const questions = [{ id: 'q1', header: 'Pick', options: [{ label: 'A' }, { label: 'B' }] }]
  const answers = [{ id: 'q1', selected: ['A'] }]
  // `userQuestions/answer` only finds a continued question; its two error codes and
  // a `false` all mean "nothing applied", so the card must survive each of them.
  for (const outcome of ['REPLY_QUEUED', 'BAD_ANSWER', 'false']) {
    const thrown = outcome === 'false' ? undefined
      : Object.assign(new Error(`the Host refused: ${outcome}`), { name: 'UserQuestionError', code: outcome })
    const remote = createFakeRemote(HOST, 'Host B', {
      requestReply: (frame) => ({ kind: 'question-response', rpcId: frame.rpcId, sessionId: frame.sessionId,
        action: 'answer', accepted: false, reason: 'not-pending' }),
      replies: { 'userQuestions/answer': outcome === 'false' ? false : thrown },
    })
    const harness = createHarness({ remotes: [remote] })
    const { control, iterator } = await openEvents(harness)
    try {
      remote.card({ kind: 'question-requested', rpcId: `q-${outcome}`, sessionId: 's1', callId: `call-${outcome}`, questions })
      await nextFrame(iterator, 'question card')
      const refused = await harness.gateway.dispatchRpc('$events/result',
        answer(namespaceId(HOST, `q-${outcome}`), { answers }), undefined, {})
      assert.equal(refused.ok, true, `${outcome} must be a receipt, not a transport failure: ${JSON.stringify(refused)}`)
      assert.equal(refused.value.accepted, false)
      assert.equal(refused.value.reason, outcome === 'false' ? 'not-continued' : outcome)
      assert.equal(remote.requests.length, 1, 'the gateway was asked once with the active frame')
      assert.equal(remote.calls.length, 1, 'the not-pending evidence opened the CONTINUED fallback')
      assert.equal(remote.calls[0].endpoint, 'userQuestions/answer')
      assert.deepEqual(remote.calls[0].args, { agentId: 's1', callId: `call-${outcome}`, answer: { answers } })
      // Not closed as answered, and still bindable: the next attempt reaches both.
      assert.equal((await nextEvent(iterator, () => true, { ms: 150 })).frame, null)
      await harness.gateway.dispatchRpc('$events/result',
        answer(namespaceId(HOST, `q-${outcome}`), { answers }), undefined, {})
      assert.equal(remote.requests.length, 2, `${outcome} left the card tracked so a retry still binds`)
    } finally {
      control.abort()
      await iterator.return()
    }
  }
})

test('a not-pending answer with no tool-call id is refused, not guessed', async () => {
  // The gateway's not-pending receipt is only EVIDENCE; without the card's callId
  // the CONTINUED service cannot be addressed, so the answer is refused visibly.
  const remote = createFakeRemote(HOST, 'Host B', {
    requestReply: (frame) => ({ kind: 'question-response', rpcId: frame.rpcId, sessionId: frame.sessionId,
      action: 'answer', accepted: false, reason: 'not-pending' }),
  })
  const harness = createHarness({ remotes: [remote] })
  const { control, iterator } = await openEvents(harness)
  try {
    remote.card({ kind: 'question-requested', rpcId: 'q-3', sessionId: 's1', questions: [{ id: 'q1', header: 'Pick' }] })
    const card = (await nextFrame(iterator, 'question card')).value
    assert.deepEqual(card.request, { questions: [{ id: 'q1', header: 'Pick' }] },
      'a card with no callId publishes no wait.callId rather than inventing one')
    const result = await harness.gateway.dispatchRpc('$events/result',
      answer(namespaceId(HOST, 'q-3'), { answers: [{ id: 'q1', selected: ['A'] }] }), undefined, {})
    assert.equal(result.ok, true, JSON.stringify(result))
    assert.equal(result.value.accepted, false)
    assert.equal(result.value.reason, 'unbound')
    assert.equal(remote.requests.length, 1)
    assert.equal(remote.calls.length, 0, 'nothing was sent to the CONTINUED service')
    assert.equal((await nextEvent(iterator, () => true, { ms: 150 })).frame, null,
      'no cancel reaches the native stream: the card is not closed as answered')
  } finally {
    control.abort()
    await iterator.return()
  }
})

test('an explicit question skip sends question-cancel for the tracked card', async () => {
  // The native waterfall rejects with ASK_CANCELLED when the user dismisses the
  // card (dsh-client-ui-user-questions slots.ts:110-114, 553-554). That must settle
  // the SAME pending card on the gateway — never become an answer.
  const remote = createFakeRemote(HOST, 'Host B', {
    requestReply: (frame) => ({ kind: 'question-response', rpcId: frame.rpcId, sessionId: frame.sessionId,
      action: 'cancel', accepted: true }),
  })
  const harness = createHarness({ remotes: [remote] })
  const { control, iterator } = await openEvents(harness)
  try {
    remote.card({ kind: 'question-requested', rpcId: 'q-cancel', sessionId: 's1', callId: 'call-46',
      questions: [{ id: 'q1', header: 'Pick' }] })
    await nextFrame(iterator, 'question card')
    const cancelled = await harness.gateway.dispatchRpc('$events/result', {
      args: { clientId: 'local-client', eventId: namespaceId(HOST, 'q-cancel'),
        outcome: { kind: 'rejected', error: { code: 'ASK_CANCELLED', message: 'the user cancelled ask_user_question' } } },
    }, undefined, {})
    assert.equal(cancelled.ok, true, JSON.stringify(cancelled))
    assert.deepEqual(cancelled.value, { kind: 'question-response', rpcId: namespaceId(HOST, 'q-cancel'),
      sessionId: namespaceId(HOST, 's1'), action: 'cancel', accepted: true })
    assert.equal(remote.requests.length, 1)
    assert.deepEqual(remote.requests[0].frame,
      { type: 'question-cancel', rpcId: 'q-cancel', sessionId: 's1' })
    assert.equal(remote.calls.length, 0)
    // A timeout/abort is already settled on the Host: it must NOT spend a cancel.
    const timedOut = await harness.gateway.dispatchRpc('$events/result', {
      args: { clientId: 'local-client', eventId: namespaceId(HOST, 'q-cancel'),
        outcome: { kind: 'rejected', error: { code: 'ASK_TIMED_OUT', message: 'timed out' } } },
    }, undefined, {})
    assert.equal(timedOut.ok, false, 'the cancelled card is no longer addressable')
    assert.equal(remote.requests.length, 1, 'no second cancel frame was sent')
  } finally {
    control.abort()
    await iterator.return()
  }
})

test('a card that claims another host namespace is refused, not injected', async () => {
  const hostA = createFakeRemote('hostA', 'Host A')
  const hostB = createFakeRemote(HOST, 'Host B')
  const harness = createHarness({ remotes: [hostA, hostB] })
  const { control, iterator } = await openEvents(harness)
  try {
    // A compromised B sends cards whose ids already name A's namespace. Trusting the
    // tag would put B's card into A's conversation, and answering it would route to
    // A — the wrong Host.
    hostB.card(approvalCard('h:hostA:rpc-1'))
    hostB.card({ ...approvalCard('rpc-2'), sessionId: 'h:hostA:s1' })
    hostB.card({ kind: 'question-requested', rpcId: 'h:hostA:q-1', sessionId: 's1', callId: 'call-1', questions: [] })
    // A clean card from the same Host still works: the refusal is per card.
    hostB.card(approvalCard('rpc-3'))
    const injected = (await nextFrame(iterator, 'only the clean card')).value
    assert.deepEqual(injected.eventId, namespaceId(HOST, 'rpc-3'))
    assert.equal(JSON.stringify(injected).includes('h:hostA:'), false)
    assert.equal(harness.logs.filter((line) => line.includes('remote/id-leak')).length, 3)

    // A decision aimed at A's namespace never binds B's card: nothing is sent, and A
    // is never asked about a card B forged.
    const wrongHost = await harness.gateway.dispatchRpc('$events/result',
      answer(namespaceId('hostA', 'rpc-3'), 'allowed-once'), undefined, {})
    assert.equal(wrongHost.ok, false)
    assert.equal(wrongHost.error.code, 'remote/approval-unbound')
    assert.equal(hostA.calls.length, 0)
    assert.equal(hostB.calls.length, 0, 'B card stays with B, undecided')
  } finally {
    control.abort()
    await iterator.return()
  }
})

test('a card whose ONLY hostile id is approvalId is refused, live and pre-buffered', async () => {
  const hostA = createFakeRemote('hostA', 'Host A')
  const hostB = createFakeRemote(HOST, 'Host B')
  // `approvalId` is copied verbatim into the card table (and into the plugin's
  // approval buffer), unlike rpcId/sessionId: it is validated as part of the WHOLE
  // card, so a tag it carries must refuse the card even when every other id is clean.
  const buffered = [{ ...approvalCard('rpc-early'), approvalId: 'h:hostA:early-approval' }]
  const harness = createHarness({ remotes: [hostA, hostB], pending: (hostId) => (hostId === HOST ? buffered : []) })
  const { control, iterator } = await openEvents(harness)
  try {
    hostB.card({ ...approvalCard('rpc-1'), approvalId: 'h:hostA:approval' })
    hostB.card({ ...approvalCard('rpc-2'), approvalId: 'a2', callId: 'h:hostA:call' })
    // A clean card from the same Host still works: the refusal is per card.
    hostB.card({ ...approvalCard('rpc-3'), approvalId: 'a3' })
    const seeded = (await nextFrame(iterator, 'only the clean cards')).value
    assert.deepEqual(seeded.eventId, namespaceId(HOST, 'rpc-3'),
      `hostile approvalId must refuse a card before it is stored (got ${JSON.stringify(seeded)})`)
    assert.equal(JSON.stringify(seeded).includes('h:hostA:'), false)
    // Live card, buffered-before-subscribe card, and the hostile callId: three refusals.
    assert.equal(harness.logs.filter((line) => line.includes('remote/id-leak')).length, 3)
    // A refused card is not addressable at all: no decision reaches either Host.
    const decide = await harness.gateway.dispatchRpc('$events/result',
      answer(namespaceId(HOST, 'rpc-1'), 'allowed-once'), undefined, {})
    assert.equal(decide.ok, false)
    assert.equal(decide.error.code, 'remote/approval-unbound')
    assert.equal(hostA.calls.length + hostB.calls.length, 0)
  } finally {
    control.abort()
    await iterator.return()
  }
})

test('a cancellation from one host never withdraws another host card', async () => {
  const hostA = createFakeRemote('hostA', 'Host A')
  const hostB = createFakeRemote(HOST, 'Host B')
  const harness = createHarness({ remotes: [hostA, hostB] })
  const { control, iterator } = await openEvents(harness)
  try {
    // The same raw rpcId on two hosts: two cards, two namespaces (a collision).
    hostA.card(approvalCard('rpc-1'))
    hostB.card(approvalCard('rpc-1'))
    const cards = [(await nextFrame(iterator, 'A card')).value, (await nextFrame(iterator, 'B card')).value]
    assert.deepEqual(cards.map((frame) => frame.eventId).sort(),
      [namespaceId('hostA', 'rpc-1'), namespaceId(HOST, 'rpc-1')].sort())

    // B resolves its own id: only B's card is withdrawn, and the cancel frame names
    // B's namespace — a cancellation can never target another host's event.
    hostB.resolved({ kind: 'approval-resolved', rpcId: 'rpc-1', sessionId: 's1', approvalId: 'a1', outcome: 'rejected' })
    const cancelled = (await nextFrame(iterator, 'cancel')).value
    assert.deepEqual(cancelled, { type: 'cancel', eventId: namespaceId(HOST, 'rpc-1') })
    assert.equal(hostA.calls.length + hostB.calls.length, 0, 'a resolve is not a decision')

    // A's card survived: A's own card is still decidable and goes to A only.
    hostA.card(approvalCard('rpc-2'))
    await nextFrame(iterator, 'A card 2')
    hostA.connection.call = async (endpoint, args) => {
      hostA.calls.push({ endpoint, args: clone(args) })
      return { accepted: true, outcome: 'allowed-once' }
    }
    const decided = await harness.gateway.dispatchRpc('$events/result',
      answer(namespaceId('hostA', 'rpc-2'), 'allowed-once'), undefined, {})
    assert.equal(decided.ok, true, JSON.stringify(decided))
    assert.equal(hostA.calls.length, 1)
    assert.equal(hostA.calls[0].endpoint, '$events/result')
    assert.equal(hostA.calls[0].args.eventId, 'rpc-2', 'A got its own raw id')
    assert.equal(hostB.calls.length, 0, 'B was never asked about A card')
  } finally {
    control.abort()
    await iterator.return()
  }
})

test('the Local $events frames pass through unchanged and unknown cards are ignored', async () => {
  const remote = createFakeRemote(HOST, 'Host B')
  const harness = createHarness({ remotes: [remote] })
  const { control, iterator } = await openEvents(harness)
  try {
    // A Host frame that is not a card (a status card, a resolve with no card) must
    // never be invented into the stream.
    remote.card({ kind: 'approval-resolved', rpcId: 'nobody', sessionId: 's1', approvalId: 'a9', outcome: 'rejected' })
    harness.localStreams[0].queue.push({ type: 'emit', event: 'api-session/status', args: ['s1', true] })
    const local = (await nextFrame(iterator, 'local emit')).value
    assert.deepEqual(local, { type: 'emit', event: 'api-session/status', args: ['s1', true] })
  } finally {
    control.abort()
    await iterator.return()
  }
})

// -- what a paired device may and may not receive over the REAL gateway -----
//
// The cases above use a stub remote, so the gateway's own authorization was only
// simulated. These two run the real `plugins/mobile-gateway` in-process (as
// test/e2e.test.mjs does) for the two interactions a device can meet on this
// channel:
//  - a QUESTION is the owner's alone: `question-answer`/`question-cancel` are
//    ADMIN_ONLY and the protocol gives a question no scope, so NO device
//    principal is pushed a card or a replay, whatever scopes its record holds
//    (the gateway logs `question card withheld: … reason=admin-only`). A paired
//    device's own path to the same question is the remote bridge's `$events`
//    stream plus `userQuestions/answer`, which is not this channel;
//  - an APPROVAL is the device's (`approval:respond`): its card still reaches the
//    device over the pinned WSS and the decision still applies on the Host.
// The two paths are asserted on separate witnesses, never through each other: the
// device by the frames on its own socket, the owner UI by the `$events` card the
// devices plugin merges in from the same Host push. Answering that UI card is
// covered by the stub-remote cases above (and by the gateway's own tests).

const delay = (ms) => new Promise((resolve) => setTimeout(resolve, ms))

/** The Host behind the real gateway: it can answer `userQuestions/answer`. */
function fakeHost() {
  const calls = []
  const gateway = {
    async invoke(request) {
      // 36d9: a device only receives cards for sessions the Host lists to it.
      if (request?.namespace === 'session' && request?.method === 'list') return { items: [{ sessionId: 's1' }] }
      return {}
    },
    async stream(request) {
      return (async function* () {
        yield { type: 'baseline', value: request?.namespace === 'workspace'
          ? { items: [], archivedSessionIds: [] } : { projections: {} } }
        while (!request?.signal?.aborted) await delay(10)
      })()
    },
    async dispatchRpc(endpoint, payload, signal, peer) {
      calls.push({ endpoint, args: clone(payload?.args), peer })
      // Not continuable: a question this Host would refuse to apply. What the case
      // below measures is that a device frame cannot reach this service at all.
      if (endpoint === 'userQuestions/answer') return { ok: true, value: false }
      if (endpoint === 'session/list') return { ok: true, value: { items: [{ sessionId: 's1' }] } }
      return { ok: true, value: null }
    },
    async openWireStream() {
      return { [Symbol.asyncIterator]: () => ({ next: async () => ({ done: true, value: undefined }),
        async return() { return { done: true, value: undefined } } }) }
    },
  }
  return { gateway, calls }
}

/** The real gateway over the pinned TLS listener, with a Host behind it. */
async function startRealGateway(t, makeHost = fakeHost) {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'dsh-008-question-'))
  const host = makeHost()
  const listeners = {}
  let management
  let upgrade
  let dispose = () => {}
  const server = http.createServer((req, res) => {
    if (management && (req.url === management.path || req.url.startsWith(`${management.path}/`))) {
      management.handler(req, res)
      return
    }
    res.writeHead(404).end()
  })
  server.on('upgrade', (req, socket, head) => { if (upgrade) upgrade.handler(req, socket, head); else socket.destroy() })
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve))
  const port = server.address().port
  const ctx = {
    webServer: {
      port,
      register(route) { management = route; return () => { management = undefined } },
      registerUpgrade(route) { upgrade = route; return () => { upgrade = undefined } },
    },
    connection: createTestConnection(),
    remoteAccess: createTestRemoteAccess(),
    typertGateway: host.gateway,
    agentDefaultModel: {},
    on(name, handler) { listeners[name] = handler; return () => { delete listeners[name] } },
    effect(fn) { dispose = fn() },
  }
  await gatewayPlugin.apply(ctx, {
    remoteControl: { enabled: true },
    gatewayMode: 'persistent',
    gatewayWaitTimeoutMs: 60_000,
    gatewayName: `spec008-q-${port}`,
    deviceFile: path.join(directory, 'devices.json'),
    pairingTtlMs: 60_000,
    lanEnabled: true,
    lanHost: '127.0.0.1',
    lanPort: 0,
    requireHostApproval: false,
    log: () => {},
  })
  const base = `http://127.0.0.1:${port}`
  const api = {
    base, listeners, calls: host.calls,
    post(route, body) { return requestJson(base, 'POST', `/mgw/${route}`, { body: body ?? {}, headers: { Origin: base } }) },
    async get(route) { return (await requestJson(base, 'GET', `/mgw/${route}`)).data },
  }
  for (let attempt = 0; attempt < 250; attempt += 1) {
    const status = await api.get('status')
    if (status.lan?.listening && status.lan.urls.length > 0) {
      api.lanUrl = status.lan.urls[0]
      api.pin = status.lan.certSha256
      t.after(async () => {
        dispose()
        await new Promise((resolve) => server.close(resolve))
        fs.rmSync(directory, { recursive: true, force: true })
      })
      return api
    }
    if (status.lan?.error) throw new Error(`gateway TLS listener failed: ${status.lan.error}`)
    await delay(20)
  }
  throw new Error('gateway TLS listener did not become ready')
}

/**
 * Pair a desktop device over the real gateway and connect it, exactly as the
 * plugin does (one-time code + pinned socket), then wait for the Host's session
 * list: the interaction gate only lets a card through for a session this device
 * was shown, and that refresh runs right after the plugin is applied.
 */
async function pairRealDevice(gateway, t, clientDeviceId, scopes) {
  const created = await gateway.post('pair', { kind: 'desktop', scopes, publicUrl: gateway.lanUrl })
  assert.equal(created.status, 201, JSON.stringify(created.data))
  const payload = created.data.payload
  const paired = await claimPairing({ url: gateway.lanUrl, payload, clientDeviceId, deviceName: 'e2e controller' })
  assert.equal(paired.device.kind, 'desktop')
  assert.deepEqual([...paired.device.scopes].sort(), [...scopes].sort())
  const connection = new RemoteConnection({
    remote: { id: HOST, publicUrl: gateway.lanUrl, certSha256: payload.certSha256, clientDeviceId },
    readToken: () => paired.token,
    requestTimeoutMs: 8000,
  })
  t.after(() => { try { connection.ws?.terminate() } catch { /* already gone */ } })
  await connection.connect()
  await delay(400)
  return { connection, device: paired.device }
}

/** The Host publishes the tool call that binds an approval's `argsHash`. */
function publishToolCall(gateway, callId, rawArguments) {
  gateway.listeners['session/event']({ id: 's1' }, { type: 'tool/call', seq: 1, time: 1,
    data: { turn: 1, step: 0, callId, name: 'bash', arguments: rawArguments } })
}

/**
 * Push one approval through the gateway's own `approval/request` listener. The
 * desktop `next` never settles: only this device can decide, so the promise the
 * listener returns is the Host's own outcome.
 */
function askApprovalOnHost(gateway, callId) {
  const controller = new AbortController()
  const pending = gateway.listeners['approval/request']({
    agent: { id: 's1' }, toolName: 'bash', callId, reason: 'needs a shell', signal: controller.signal,
  }, () => new Promise(() => {}))
  return { controller, pending }
}

/** Push one question through the gateway's own `user-questions/request` listener. */
function askOnHost(gateway, callId, questions) {
  const controller = new AbortController()
  const pending = gateway.listeners['user-questions/request']({
    agent: { id: 's1' }, questions, wait: { callId }, signal: controller.signal,
  }, () => new Promise(() => {}))
  return { controller, pending }
}

/**
 * Whether a frame arrived within `ms`. Never rejects: a frame that lands after the
 * bound would otherwise surface as an unhandled rejection from the losing branch.
 */
function arrivesWithin(iterator, ms) {
  let frame
  const watched = iterator.next().then((entry) => {
    if (!entry.done) frame = entry.value
    return frame !== undefined
  })
  return Promise.race([watched, delay(ms).then(() => false)]).then((arrived) => ({ arrived, frame }))
}

/**
 * The next `$events` frame `match` accepts, or `null` inside `ms`. Waits for THAT
 * frame instead of for the stream to fall quiet: a test of one card must not pass
 * (or fail) on how long an unrelated frame happens to take. Frames `skip` names are
 * dropped while waiting; anything else that is not the wanted card is returned
 * under `other`, so a call site can assert its absence.
 */
async function nextEvent(iterator, match, { skip = () => false, ms = 2000 } = {}) {
  const deadline = Date.now() + ms
  const others = []
  for (;;) {
    const remaining = deadline - Date.now()
    if (remaining <= 0) return { frame: null, other: others }
    const { arrived, frame } = await arrivesWithin(iterator, remaining)
    if (!arrived) return { frame: null, other: others }
    if (skip(frame)) continue
    if (match(frame)) return { frame, other: others }
    others.push(frame)
  }
}

// The gateway's audit trail is its own log (lib/logging.mjs: one line to stdout and
// one to a temp file). `apply()` takes no logger to inject, so the file is the only
// thing a test can read — and it is the line the Host actually recorded.
const GATEWAY_LOG = path.join(os.tmpdir(), 'mobile-gateway.log')

function gatewayLogSize() {
  try { return fs.statSync(GATEWAY_LOG).size } catch { return 0 }
}

/** The lines the gateway appended to its log since `offset`. */
function gatewayLogSince(offset) {
  try {
    const size = fs.statSync(GATEWAY_LOG).size
    if (size <= offset) return []
    const buffer = Buffer.alloc(size - offset)
    const fd = fs.openSync(GATEWAY_LOG, 'r')
    try { fs.readSync(fd, buffer, 0, buffer.length, offset) } finally { fs.closeSync(fd) }
    return buffer.toString('utf8').split('\n').filter((line) => line !== '')
  } catch { return [] }
}

test('real gateway: a question card reaches an approval:respond device and is answered once, over the bridge', async (t) => {
  const gateway = await startRealGateway(t)
  // Every scope a question could ask for, plus the one the bridge needs. Owner decision
  // 2026-11-11: `approval:respond` IS the gate — such a device receives the card.
  const paired = await pairRealDevice(gateway, t, 'deskq-real-0000-4000-8000-000000000q01',
    ['sessions:read', 'approval:respond', 'harness:remote'])
  const harness = createHarness({ remotes: [{ hostId: HOST, hostName: 'Host B', connection: paired.connection }] })
  const { control, iterator } = await openEvents(harness)
  // The device socket itself, read directly: the UI-facing `$events` check below
  // must not be the only witness of what crossed the wire.
  const wire = []
  paired.connection.ws.on('message', (data) => { try { wire.push(JSON.parse(data.toString())) } catch { /* ignore */ } })
  const logOffset = gatewayLogSize()
  const questions = [{ id: 'q1', header: 'Deploy target?',
    options: [{ label: 'staging-eu' }, { label: 'prod-us' }], multiSelect: false }]
  const question = askOnHost(gateway, 'call-77', questions)
  let settled = false
  void question.pending.then(() => { settled = true }, () => { settled = true })
  try {
    // (0) Wait for the OWNER UI card on its own witness (asserted in 2c below).
    // A remote session's question is merged into the client's `$events` stream by
    // the devices plugin from the same Host push the gateway sends to the device.
    const uiQuestion = await nextEvent(iterator, (frame) => frame.event === 'user-questions/request')
    // Bounded and total: every wire assertion below runs whether or not the card came.
    assert.ok(uiQuestion.frame,
      `the remote question reaches neither UI nor device (UI saw ${JSON.stringify(uiQuestion.other)})`)

    // (1) DEVICE path — ALLOWED (owner decision 2026-11-11): this device holds
    // approval:respond + sessions:read + harness:remote and session `s1` is in its
    // visible set, so the question card crosses its socket and carries the
    // tool-call id the Host's question service keys it by. Read directly from the
    // socket, so the UI-path assertion below is never the only witness.
    for (let attempt = 0; attempt < 100 && wire.filter((frame) => frame.kind === 'question-requested').length === 0; attempt += 1) {
      await delay(20)
    }
    const cards = wire.filter((frame) => frame.kind === 'question-requested')
    assert.equal(cards.length, 1, 'exactly one question card crosses the wire to this device')
    assert.equal(cards[0].sessionId, 's1')
    assert.equal(cards[0].callId, 'call-77', 'the card names the tool call the question is keyed by')
    assert.deepEqual(cards[0].questions, questions, 'the card carries the question payload')

    // (2) No withholding is logged for an authorized device, and no question text is
    // ever audited — the card is the only carrier, not the log.
    const logged = gatewayLogSince(logOffset)
    assert.ok(logged.some((line) => line.includes('question requested:') && line.includes('session=s1')),
      `the Host question was registered (${JSON.stringify(logged.slice(-6))})`)
    const withheld = logged.filter((line) => line.includes('question card withheld:')
      && line.includes(`device=${paired.device.id}`))
    assert.equal(withheld.length, 0, `an authorized device is not logged as withheld (${JSON.stringify(logged.slice(-6))})`)
    for (const secret of ['Deploy target?', 'staging-eu', 'prod-us']) {
      assert.equal(logged.some((line) => line.includes(secret)), false,
        `the audit carries no question text (${secret})`)
    }

    // (2b) The positive control on the same socket and session: an approval card
    // arrives too, so the question card is not a one-off of a broken socket.
    publishToolCall(gateway, 'call-88', '{"command":"ls"}')
    const control2 = askApprovalOnHost(gateway, 'call-88')
    let approvals = 0
    for (let attempt = 0; attempt < 100 && approvals === 0; attempt += 1) {
      approvals = wire.filter((frame) => frame.kind === 'approval-requested').length
      if (approvals === 0) await delay(20)
    }
    assert.equal(approvals, 1, 'an approval for the same session reaches this device')
    // The same Host card merged into the owner's stream: one card, two witnesses.
    const approvalCard = await nextEvent(iterator, (frame) => frame.event === 'approval/request')
    assert.ok(approvalCard.frame, 'the approval reachable on the device is also on the owner UI path')
    control2.controller.abort()
    await control2.pending.catch(() => undefined)

    // (2c) OWNER UI path — a remote Host question reaches the client's `$events`
    // stream with host-tagged ids AND the question payload, on its own witness.
    const card = uiQuestion.frame
    assert.equal(card.type, 'waterfall', JSON.stringify(uiQuestion.other))
    assert.equal(card.event, 'user-questions/request')
    assert.ok(card.eventId.startsWith(namespaceId(HOST, '')), `eventId must be host-tagged (${card.eventId})`)
    assert.equal(card.agentId, namespaceId(HOST, 's1'))
    // The card reaches the owner UI keyed by the Host's own tool-call id, in the one
    // field DSH reads (`wait.callId`). Without it the UI cannot bind the question to
    // its call, and its answer never lands.
    assert.deepEqual(card.request, { questions, wait: { callId: 'call-77' } })
    // Bindable: the card addresses the Host's own pending question, so answering
    // the eventId the UI shows cannot miss it.
    const pendingRequests = gatewayLogSince(logOffset).filter((line) => line.includes('question requested: rpcId='))
    assert.equal(pendingRequests.length, 1, JSON.stringify(pendingRequests))
    const rpcId = pendingRequests[0].match(/question requested: rpcId=(\S+)/)[1]
    assert.equal(card.eventId, namespaceId(HOST, rpcId), 'the card names the Host question it can be answered on')

    // (2d) The gateway's DEVICE answer policy is real, not a stub: a custom/empty
    // answer is refused with `bad-response` and does NOT consume the pending card
    // (plugins/mobile-gateway/lib/index.mjs:2525-2567, deviceLive at 2271-2276).
    // The router must surface that code, never relax it (see the stub case above).
    const customRefused = await paired.connection.request({
      type: 'question-answer', rpcId: cards[0].rpcId, sessionId: 's1',
      answers: [{ id: 'q1', selected: [], custom: 'free text' }],
    })
    assert.equal(customRefused.kind, 'error', JSON.stringify(customRefused))
    assert.equal(customRefused.code, 'bad-response')
    assert.equal(settled, false, 'the refused custom answer did not settle the Host question')

    // (3) The owner answers the NATIVE waterfall card. `$events/result` goes through
    // the router, which sends ONE `question-answer` frame to the gateway that owns
    // the pending question. The Host's own answer service is never called: no click
    // on the Host is needed. `ws.on('message')` only sees frames RECEIVED, so the
    // sent answer is witnessed by wrapping `request` (the router uses that API).
    const sentAnswers = []
    const originalRequest = paired.connection.request.bind(paired.connection)
    paired.connection.request = async (frame, options) => {
      if (frame?.type === 'question-answer' || frame?.type === 'question-cancel') sentAnswers.push(clone(frame))
      return originalRequest(frame, options)
    }
    const first = await harness.gateway.dispatchRpc('$events/result',
      answer(card.eventId, { answers: [{ id: 'q1', selected: ['staging-eu'] }] }), undefined, {})
    assert.equal(first.ok, true, JSON.stringify(first))
    assert.equal(first.value.accepted, true, 'the authorized device answer is accepted')
    assert.deepEqual(await question.pending, { answers: [{ id: 'q1', selected: ['staging-eu'] }] },
      'the Host question resolves with the device answer')
    assert.equal(settled, true)
    assert.equal(sentAnswers.length, 1, 'exactly one question-answer frame crossed the wire')
    assert.equal(sentAnswers[0].rpcId, cards[0].rpcId, 'the gateway minted rpcId is used verbatim')
    assert.equal(sentAnswers[0].sessionId, 's1', 'the card session is used, not a guessed one')
    assert.deepEqual(sentAnswers[0].answers, [{ id: 'q1', selected: ['staging-eu'] }])
    const receipts = wire.filter((frame) => frame.kind === 'question-response')
    assert.equal(receipts.length, 1, 'the gateway sent one correlated receipt')
    assert.equal(typeof receipts[0].requestId, 'string', 'the receipt echoes the answer requestId')
    // At most once: a duplicate native submit cannot reach the gateway a second time.
    const duplicate = await harness.gateway.dispatchRpc('$events/result',
      answer(card.eventId, { answers: [{ id: 'q1', selected: ['prod-us'] }] }), undefined, {})
    assert.equal(duplicate.ok, false)
    assert.equal(duplicate.error.code, 'remote/approval-unbound')
    assert.equal(sentAnswers.length, 1, 'the accepted card cannot be answered twice')
    assert.equal(gateway.calls.filter((call) => call.endpoint === 'userQuestions/answer').length, 0,
      'no Host click: the gateway settled its pending question in-process')
    // (3b) An UNKNOWN id is refused with the same shape, never guessed.
    const unknown = await paired.connection.request({
      type: 'question-answer', rpcId: 'q-not-a-card', sessionId: 's1',
      answers: [{ id: 'q1', selected: ['prod-us'] }],
    })
    assert.equal(unknown.accepted, false)
    assert.equal(unknown.reason, 'not-pending')
  } finally {
    question.controller.abort()
    await question.pending.catch(() => undefined)
    control.abort()
    await iterator.return()
    try { paired.connection.ws?.terminate() } catch { /* already gone */ }
  }
})

test('real gateway: a device paired WITHOUT approval:respond sees no question card on the wire', async (t) => {
  const gateway = await startRealGateway(t)
  // The NEGATIVE half of the owner decision: the gate is the scope, nothing else.
  const paired = await pairRealDevice(gateway, t, 'deskq-real-0000-4000-8000-000000000q03',
    ['sessions:read', 'harness:remote'])
  const harness = createHarness({ remotes: [{ hostId: HOST, hostName: 'Host B', connection: paired.connection }] })
  const { control, iterator } = await openEvents(harness)
  const wire = []
  paired.connection.ws.on('message', (data) => { try { wire.push(JSON.parse(data.toString())) } catch { /* ignore */ } })
  const logOffset = gatewayLogSize()
  const questions = [{ id: 'q1', header: 'Deploy target?',
    options: [{ label: 'staging-eu' }, { label: 'prod-us' }], multiSelect: false }]
  const question = askOnHost(gateway, 'call-79', questions)
  try {
    // The device cannot answer, so it cannot open `$events` either (that stream needs
    // approval:respond — T5d of the gateway's bridge suite): NOTHING reaches it, on
    // the interaction wire or through the owner UI merge, which is fed by the same
    // `$events` stream. Both witnesses are asserted, so a silent leak on either one
    // fails here.
    for (let attempt = 0; attempt < 100 && wire.filter((frame) => frame.kind === 'question-requested').length === 0; attempt += 1) {
      await delay(20)
    }
    await delay(200)
    assert.equal(wire.filter((frame) => frame.kind === 'question-requested').length, 0,
      'a device without approval:respond is sent no question card')
    const uiQuestion = await nextEvent(iterator, (frame) => frame.event === 'user-questions/request', { ms: 300 })
    assert.equal(uiQuestion.frame, null,
      `no question card reaches the merged UI stream either (UI saw ${JSON.stringify(uiQuestion.other)})`)
    // The withholding is audited with ids only, naming the scope gate — never the text.
    const logged = gatewayLogSince(logOffset)
    const withheld = logged.filter((line) => line.includes('question card withheld:')
      && line.includes(`device=${paired.device.id}`))
    assert.ok(withheld.length >= 1, `the withholding is logged (${JSON.stringify(logged.slice(-6))})`)
    for (const line of withheld) {
      assert.match(line, /question card withheld: device=\S+ session=s1 reason=missing-scope$/,
        'the audit names the scope gate: ' + line)
    }
    for (const secret of ['Deploy target?', 'staging-eu', 'prod-us']) {
      assert.equal(logged.some((line) => line.includes(secret)), false,
        `the audit carries no question text (${secret})`)
    }
  } finally {
    question.controller.abort()
    await question.pending.catch(() => undefined)
    control.abort()
    await iterator.return()
    try { paired.connection.ws?.terminate() } catch { /* already gone */ }
  }
})

test('real gateway: an approval card still reaches the device and is applied over $events/result, once', async (t) => {
  const gateway = await startRealGateway(t)
  const paired = await pairRealDevice(gateway, t, 'deskq-real-0000-4000-8000-000000000q02',
    ['sessions:read', 'approval:respond', 'harness:remote'])
  const harness = createHarness({ remotes: [{ hostId: HOST, hostName: 'Host B', connection: paired.connection }] })
  const { control, iterator } = await openEvents(harness)
  const wire = []
  paired.connection.ws.on('message', (data) => { try { wire.push(JSON.parse(data.toString())) } catch { /* ignore */ } })
  // Without the tool call there is no content binding: the request would be
  // desktop-only (`argsHash: null`) and never offered to a device.
  publishToolCall(gateway, 'call-88', '{"command":"ls"}')
  const approval = askApprovalOnHost(gateway, 'call-88')
  try {
    // The card the real gateway minted (its rpcId/approvalId are fresh UUIDs), so
    // the ids are checked as "this host's namespace", which is what the UI routes by.
    const card = (await nextFrame(iterator, 'approval card over the wire')).value
    assert.equal(card.type, 'waterfall')
    assert.equal(card.event, 'approval/request')
    assert.ok(card.eventId.startsWith(namespaceId(HOST, '')), `eventId must be namespaced (${card.eventId})`)
    assert.equal(card.agentId, namespaceId(HOST, 's1'))
    assert.equal(card.request.toolName, 'bash')
    assert.equal(card.request.callId, 'call-88')
    assert.equal(card.request.reason, 'needs a shell')
    assert.equal(card.request.argsPreview, '{"command":"ls"}')
    assert.equal(Object.hasOwn(card.request, 'agent'), false, 'the waterfall request carries no agent')
    assert.equal(Object.hasOwn(card.request, 'signal'), false, 'the waterfall request carries no signal')
    assert.equal(wire.filter((frame) => frame.kind === 'approval-requested').length, 1,
      'the card crossed the pinned WSS to the device')

    // The decision travels through the router's card binding and the bridge's
    // hash-bound `$events/result`, and applies on the Host (the Host's own promise
    // resolves with the outcome).
    const decided = await harness.gateway.dispatchRpc('$events/result',
      answer(card.eventId, 'allowed-once'), undefined, {})
    assert.equal(decided.ok, true, JSON.stringify(decided))
    assert.deepEqual(decided.value, { accepted: true, outcome: 'allowed-once' })
    assert.equal(await approval.pending, 'allowed-once', 'the Host applied the decision')
    assert.equal(wire.filter((frame) => frame.kind === 'remote-result').length, 1)

    // At most once: the card is no longer addressable, nothing crosses the wire
    // again, and the Host outcome cannot be restated.
    const repeat = await harness.gateway.dispatchRpc('$events/result',
      answer(card.eventId, 'rejected'), undefined, {})
    assert.equal(repeat.ok, false)
    assert.equal(repeat.error.code, 'remote/approval-unbound')
    assert.equal(wire.filter((frame) => frame.kind === 'remote-result').length, 1, 'nothing was sent twice')
    assert.equal(await approval.pending, 'allowed-once')
  } finally {
    approval.controller.abort()
    await approval.pending.catch(() => undefined)
    control.abort()
    await iterator.return()
    try { paired.connection.ws?.terminate() } catch { /* already gone */ }
  }
})

// -- remote prompt echo settlement through the REAL gateway -------------------
//
// DSH 0.2.2-rc.3's session.js settles an optimistic user bubble only when a
// durable `user/message` whose `source.rpcId` equals beginSubmission's `requestId`
// reaches the controller, and — when the admit receipt has `index === null` —
// only once the `inbox` projection watermark on `session/control` catches up
// (trap :855-863). The control stream is the ONLY source of that watermark for a
// remote session. Both ids and both streams cross this wrapper: a rename of
// `source.rpcId`, or a dropped projection frame, strands the bubble until a
// session switch disposes the admitted echo. These cases run the REAL
// plugins/mobile-gateway in-process; the Host behind it appends the durable
// message to its session journal on accepting the prompt and folds it into its
// inbox projection, so the settlement facts travel Host → gateway → router →
// controller. Nothing is injected into the controller's merged streams.

/**
 * A Host behind the real gateway that behaves like DSH 0.2.2-rc.3's session
 * controller when a prompt is admitted. Three durable events cross
 * `session/follow`; the two inbox splices each also emit an `inbox` projection
 * on `session/control`:
 *   1. followup/steer splices the user's message into the inbox (seq 7), receipt
 *      index is set, projection watermark 7; 2. the driver's claim() splices it
 *      out again (seq 8) with NO `outcome:'canceled'`, so the receipt becomes
 *      `{index:null, seq:8}` and the projection watermark reaches 8;
 *   3. the durable `user/message` (seq 9) admits the echo. Native rc.3 retires
 *      the bubble only when the inbox projection watermark reaches seq 8.
 * Two other queued turns are already in the Host's authoritative `inbox`
 * baseline/snapshot, so a claim must leave them in place: the router may not
 * synthesize an empty inbox just to advance the watermark. The wire `inbox` val
 * uses the JSON keys `'next-turn'`/`'next-step'` (dsh-api-session-controller
 * typert.host.js projection schema), not the TypeScript interface's camelCase.
 * The controller's merged streams must carry every event and projection, in
 * order, with the source rpcId intact.
 */
function createEchoHost({ withholdControl = false } = {}) {
  const calls = []
  /** @type {Map<string, ReturnType<typeof createQueue>>} */
  const streams = new Map()
  const queueFor = (endpoint) => {
    let queue = streams.get(endpoint)
    if (!queue) { queue = createQueue(); streams.set(endpoint, queue) }
    return queue
  }
  const BASE_SEQ = 5
  const SNAPSHOT_SEQ = 6
  const SPLICE_SEQ = 7
  const CLAIM_SEQ = SPLICE_SEQ + 1
  const MESSAGE_SEQ = CLAIM_SEQ + 1
  const queuedTurns = [
    { id: 'm-queued-a', content: [{ type: 'text', text: 'earlier A' }],
      source: { kind: 'user', rpcId: 'req-queued-a' } },
    { id: 'm-queued-b', content: [{ type: 'text', text: 'earlier B' }],
      source: { kind: 'user', rpcId: 'req-queued-b' } },
  ]
  const inboxMessage = (requestId) => ({ id: 'm-echo', content: [{ type: 'text', text: 'ping' }],
    source: { kind: 'user', rpcId: requestId } })
  const baselineInbox = { 'next-turn': queuedTurns.slice(), 'next-step': [] }
  const snapshotInbox = { 'next-turn': queuedTurns.slice(), 'next-step': [] }
  const survivingInbox = { 'next-turn': queuedTurns.slice(), 'next-step': [] }
  const projection = (seq, requestId) => ({ type: 'projection', sessionId: 's1', seq,
    changes: [{ key: 'inbox', val: { seq,
      'next-turn': seq === SPLICE_SEQ ? [inboxMessage(requestId), ...queuedTurns] : queuedTurns.slice(),
      'next-step': [],
    } }] })
  let controlReleased = false
  const releaseControl = (requestId) => {
    if (controlReleased) return
    controlReleased = true
    // Both splices' watermarks, in the Host's commit order. The claim watermark
    // (CLAIM_SEQ) is the one that retires an index===null admitted echo.
    queueFor('session/control').push(projection(SPLICE_SEQ, requestId))
    queueFor('session/control').push(projection(CLAIM_SEQ, requestId))
  }
  const gateway = {
    async invoke(request) {
      if (request?.namespace === 'session' && request?.method === 'list') return { items: [{ sessionId: 's1' }] }
      return {}
    },
    async stream(request) {
      return (async function* () {
        yield { type: 'baseline', value: request?.namespace === 'workspace'
          ? { items: [], archivedSessionIds: [] } : { projections: {} } }
        while (!request?.signal?.aborted) await delay(10)
      })()
    },
    async dispatchRpc(endpoint, payload, signal, peer) {
      calls.push({ endpoint, args: clone(payload?.args), peer })
      if (endpoint === 'session/list') return { ok: true, value: { items: [{ sessionId: 's1' }] } }
      if (endpoint === 'session/prompt') {
        const requestId = payload?.args?.requestId
        const message = inboxMessage(requestId)
        // (1) the followup/steer splice PUTS the message in the inbox; the
        // receipt's index is established from this event's seq.
        queueFor('session/follow').push({ type: 'event', event: {
          type: 'agent/inbox/spliced', seq: SPLICE_SEQ, time: 1,
          data: { target: 'next-turn', start: 0, removedCount: 0, inserted: [message] },
        } })
        // (2) driver claim() splices it OUT. No `outcome:'canceled'`: native
        // session.js sets the receipt to index=null at this seq, without
        // retiring the optimistic bubble.
        queueFor('session/follow').push({ type: 'event', event: {
          type: 'agent/inbox/spliced', seq: CLAIM_SEQ, time: 2,
          data: { target: 'next-turn', start: 0, removedCount: 1, inserted: [] },
        } })
        // (3) the durable user message carries the controller's requestId as
        // source.rpcId — the exact id rc.3 looks its optimistic bubble up by.
        queueFor('session/follow').push({ type: 'event', event: {
          type: 'user/message', seq: MESSAGE_SEQ, time: 3, data: message,
        } })
        // Without the control watermarks an admitted (index === null) echo stays held.
        if (!withholdControl) releaseControl(requestId)
        return { ok: true, value: { accepted: true } }
      }
      return { ok: true, value: null }
    },
    async openWireStream(endpoint, payload, uplink, peer, signal, control) {
      const queue = queueFor(endpoint)
      if (endpoint === 'session/follow') {
        queue.push({ type: 'snapshot', cursor: 0, header: { version: 4, id: 's1' },
          records: [], projections: { asOfSeq: SNAPSHOT_SEQ, values: { inbox: snapshotInbox } }, hasMore: false })
      } else if (endpoint === 'session/control') {
        queue.push({ type: 'baseline', value: { projections: {
          s1: { asOfSeq: BASE_SEQ, values: { inbox: baselineInbox } },
        } } })
      }
      return queue
    },
  }
  return { gateway, calls, releaseControl, queuedTurns, survivingInbox, SPLICE_SEQ, CLAIM_SEQ, MESSAGE_SEQ }
}

/** A controller-side router harness with a short merge-baseline wait. */
function createSessionHarness(remotes) {
  const localCalls = []
  const localStreams = []
  const logs = []
  const gateway = {
    async dispatchRpc(endpoint, payload, signal, peer) {
      localCalls.push({ endpoint, payload: clone(payload) })
      return { ok: true, value: { local: endpoint } }
    },
    async openWireStream(endpoint, payload, uplink, peer, signal, control, window) {
      const queue = createQueue()
      localStreams.push({ endpoint, payload: clone(payload), window, queue })
      if (endpoint === '$events') queue.push({ type: 'ready', clientId: 'local-client', host: { home: '/home/owner' } })
      if (endpoint === 'session/control') queue.push({ type: 'baseline', value: { projections: {} } })
      return queue
    },
  }
  const listeners = new Set()
  const connected = new Set(remotes.map((remote) => remote.hostId))
  const notify = () => { for (const listener of [...listeners]) listener() }
  const router = createHostRouter({
    gateway,
    dshVersion: PINNED_DSH_VERSION,
    mergeBaselineTimeoutMs: 80,
    hosts: () => remotes.filter((remote) => connected.has(remote.hostId))
      .map((remote) => ({ hostId: remote.hostId, hostName: remote.hostName, connection: remote.connection, online: true })),
    onHostsChanged: (listener) => { listeners.add(listener); return () => listeners.delete(listener) },
    approvals: { pending: () => [] },
    log: (line) => logs.push(line),
  })
  router.install()
  return { gateway, router, localCalls, localStreams, logs }
}

/** Drain an iterator continuously so a later frame is never lost to a timed-out next(). */
function drainFrames(iterator) {
  const frames = []
  const errors = []
  let running = true
  const done = (async () => {
    try {
      while (running) {
        const { value, done: ended } = await iterator.next()
        if (ended) break
        frames.push(value)
      }
    } catch (error) { errors.push(error) }
  })()
  return {
    frames, errors,
    async stop() { running = false; try { await iterator.return() } catch { /* gone */ } await done },
  }
}

/** Poll collected frames until `predicate` accepts one, or fail with a labelled deadline. */
async function waitForFrame(predicate, label, ms = 2000) {
  const deadline = Date.now() + ms
  for (;;) {
    const found = predicate()
    if (found) return found
    if (Date.now() >= deadline) throw new Error(`timed out waiting for ${label}`)
    await delay(10)
  }
}

async function openSessionStreams(harness, t) {
  const controlAbort = new AbortController()
  const followAbort = new AbortController()
  t.after(() => { controlAbort.abort(); followAbort.abort() })
  const controlSource = await harness.gateway.openWireStream('session/control', { args: {} },
    undefined, {}, controlAbort.signal, controlAbort, 64)
  const followSource = await harness.gateway.openWireStream('session/follow',
    { args: { request: { address: { kind: 'session', sessionId: namespaceId(HOST, 's1') } } } },
    undefined, {}, followAbort.signal, followAbort, 64)
  const control = drainFrames(controlSource[Symbol.asyncIterator]())
  const follow = drainFrames(followSource[Symbol.asyncIterator]())
  t.after(async () => { await control.stop(); await follow.stop() })
  return { control, follow }
}

test('real gateway: a remote prompt echo settles from follow + control without a session switch', async (t) => {
  const host = createEchoHost()
  const gateway = await startRealGateway(t, () => host)
  const paired = await pairRealDevice(gateway, t, 'desk-echo-real-0000-4000-800000000001',
    ['sessions:read', 'prompt:send', 'approval:respond', 'harness:remote'])
  const harness = createSessionHarness([{ hostId: HOST, hostName: 'Host B', connection: paired.connection }])
  const streams = await openSessionStreams(harness, t)
  const requestId = 'req-real-echo-1'
  try {
    const answer = await harness.gateway.dispatchRpc('session/prompt', { args: {
      sessionId: namespaceId(HOST, 's1'), requestId, mode: 'instant',
      content: [{ type: 'text', text: 'ping' }],
    } }, undefined, {})
    assert.equal(answer.ok, true, JSON.stringify(answer))
    const promptCall = host.calls.find((call) => call.endpoint === 'session/prompt')
    assert.ok(promptCall, 'the real gateway forwarded the prompt to the Host')
    assert.equal(promptCall.args.requestId, requestId,
      'the router did not rename the controller-minted requestId')

    // All three durable events arrive on the controller's merged follow, in the
    // Host's commit order, with the SAME rpcId the native controller looks its
    // optimistic bubble up by.
    await waitForFrame(() => streams.follow.frames.filter((frame) => frame?.event?.type === 'agent/inbox/spliced').length >= 2,
      'both agent/inbox/spliced events on session/follow')
    await waitForFrame(() => streams.follow.frames.some((frame) => frame?.event?.type === 'user/message'),
      'durable user/message on session/follow')
    const followEvents = streams.follow.frames.filter((frame) => frame?.event?.type === 'agent/inbox/spliced'
      || frame?.event?.type === 'user/message')
    assert.deepEqual(followEvents.map((frame) => [frame.event.type, frame.event.seq]), [
      ['agent/inbox/spliced', host.SPLICE_SEQ],
      ['agent/inbox/spliced', host.CLAIM_SEQ],
      ['user/message', host.MESSAGE_SEQ],
    ], 'the follow events arrive in Host commit order with distinct seqs')
    const [insert, claim, echo] = followEvents
    assert.equal(insert.event.data.inserted?.[0]?.source?.rpcId, requestId)
    assert.equal(claim.event.data.removedCount, 1, 'the claim splice removes the inbox row')
    assert.equal(Object.hasOwn(claim.event.data, 'outcome'), false, 'the claim splice carries NO canceled outcome')
    assert.equal(echo.event.data.source.kind, 'user')
    assert.equal(echo.event.data.source.rpcId, requestId,
      'source.rpcId is the exact requestId, not a host-tagged id')
    assert.ok(!echo.event.data.source.rpcId.startsWith('h:'), 'the source rpcId is never namespaced')

    // Both inbox projection watermarks arrive on the controller's merged control
    // stream for the NAMESPACED session — the only source of seqOf('inbox')
    // remote. The claim's watermark (seq 8) is what retires an index===null echo.
    // The router also publishes a reconstructed fallback (the Host's real
    // projection can be withheld); it carries only the installed wire keys, no
    // Host `val.seq`, so the real Host frames stay separately identifiable.
    const inboxFrames = () => streams.control.frames.filter((frame) => frame?.type === 'projection'
      && frame.sessionId === namespaceId(HOST, 's1')
      && frame.changes?.some((change) => change.key === 'inbox'))
    const valOf = (frame) => frame.changes.find((change) => change.key === 'inbox').val
    const inboxOf = (frame) => {
      const value = { ...valOf(frame) }
      delete value.seq
      return value
    }
    const real = () => inboxFrames().filter((frame) => Object.hasOwn(valOf(frame), 'seq'))
    // A late control baseline is re-sent as a router projection at its own cut
    // (seq 5) and also lacks `val.seq`; the synthetic claim is keyed to seq 8.
    const fallback = () => inboxFrames().filter((frame) => frame.seq === host.CLAIM_SEQ
      && !Object.hasOwn(valOf(frame), 'seq'))
    await waitForFrame(() => real().length >= 2, 'both real inbox projections on session/control')
    await waitForFrame(() => fallback().length >= 1, 'the router claim fallback on session/control')
    const projections = real()
    assert.deepEqual(projections.map((frame) => [frame.seq, valOf(frame).seq]),
      [[host.SPLICE_SEQ, host.SPLICE_SEQ], [host.CLAIM_SEQ, host.CLAIM_SEQ]],
    'both Host watermarks reach the controller, in order, at their splice seqs')
    assert.equal(inboxOf(projections[0])['next-turn']?.[0]?.source?.rpcId,
      requestId, 'the first inbox projection carries the queued message')
    assert.deepEqual(inboxOf(projections[0])['next-turn']?.map((message) => message.id),
      ['m-echo', ...host.queuedTurns.map((message) => message.id)],
      'the insert splice leaves both earlier queued turns behind it')
    assert.deepEqual(inboxOf(projections[1]), host.survivingInbox,
      'the claim projection preserves the other queued turns, not an empty inbox')
    assert.deepEqual(fallback().map((frame) => [frame.seq, valOf(frame)]),
      [[host.CLAIM_SEQ, host.survivingInbox]],
    'the fallback publishes the full surviving inbox at the claim watermark')

    // Every settlement fact is on the LIVE streams: no session switch, no
    // dispose/reopen, no handmade frame injected into the controller.
    assert.equal(streams.follow.errors.length, 0, JSON.stringify(streams.follow.errors))
    assert.equal(streams.control.errors.length, 0, JSON.stringify(streams.control.errors))
    assert.ok(harness.logs.every((line) => !line.includes('remote/id-leak')),
      `no ingress refusal of the echo (${JSON.stringify(harness.logs.slice(-6))})`)
  } finally {
    try { paired.connection.ws?.terminate() } catch { /* already gone */ }
  }
})

test('real gateway: a withheld Host control stream is repaired by the router inbox fallback', async (t) => {
  const host = createEchoHost({ withholdControl: true })
  const gateway = await startRealGateway(t, () => host)
  const paired = await pairRealDevice(gateway, t, 'desk-echo-real-0000-4000-800000000002',
    ['sessions:read', 'prompt:send', 'approval:respond', 'harness:remote'])
  const harness = createSessionHarness([{ hostId: HOST, hostName: 'Host B', connection: paired.connection }])
  const streams = await openSessionStreams(harness, t)
  const requestId = 'req-real-echo-held'
  try {
    const answer = await harness.gateway.dispatchRpc('session/prompt', { args: {
      sessionId: namespaceId(HOST, 's1'), requestId, mode: 'instant',
      content: [{ type: 'text', text: 'ping' }],
    } }, undefined, {})
    assert.equal(answer.ok, true, JSON.stringify(answer))

    // All three durable events are on follow (so the optimistic bubble exists),
    // but the Host sends NO control projections: the claim splice left the receipt
    // at index===null, and rc.3's trap holds the admitted echo until seq 8
    // reaches seqOf('inbox'). The router must publish that watermark from the
    // durable claim splice on the SAME live streams — no session switch.
    await waitForFrame(() => streams.follow.frames.filter((frame) => frame?.event?.type === 'agent/inbox/spliced').length >= 2,
      'both splices on session/follow (held case)')
    await waitForFrame(() => streams.follow.frames.some((frame) => frame?.event?.type === 'user/message'
      && frame.event.data?.source?.rpcId === requestId), 'durable user/message on session/follow (held case)')
    assert.deepEqual(streams.follow.frames.filter((frame) => frame?.event?.type === 'agent/inbox/spliced'
      || frame?.event?.type === 'user/message').map((frame) => frame.event.seq),
    [host.SPLICE_SEQ, host.CLAIM_SEQ, host.MESSAGE_SEQ], 'held echo still has the full ordered sequence')
    const inboxFrames = () => streams.control.frames.filter((frame) => frame?.type === 'projection'
      && frame.sessionId === namespaceId(HOST, 's1')
      && frame.changes?.some((change) => change.key === 'inbox'))
    const valOf = (frame) => frame.changes.find((change) => change.key === 'inbox').val
    const inboxOf = (frame) => {
      const value = { ...valOf(frame) }
      delete value.seq
      return value
    }
    // A late control baseline is re-sent at its own seq 5 without `val.seq`;
    // the synthetic claim is the router projection keyed to seq 8.
    const fallback = () => inboxFrames().filter((frame) => frame.seq === host.CLAIM_SEQ
      && !Object.hasOwn(valOf(frame), 'seq'))
    await waitForFrame(() => fallback().length >= 1,
      'router fallback watermark while Host control is withheld')
    assert.deepEqual(fallback().map((frame) => [frame.seq, valOf(frame)]),
    [[host.CLAIM_SEQ, host.survivingInbox]],
    'the withheld claim is reconstructed with the other queued turns intact')
    assert.equal(inboxFrames().filter((frame) => Object.hasOwn(valOf(frame), 'seq')).length, 0,
      'the Host withheld its own projection; only router-derived frames are present')

    // Releasing the Host's inbox projections still reaches the controller on the
    // SAME live streams. The native store drops seq <= row.seq, so the fallback
    // at seq 8 cannot be regressed by the duplicate that arrives later.
    host.releaseControl(requestId)
    await waitForFrame(() => inboxFrames().filter((frame) => Object.hasOwn(valOf(frame), 'seq')).length >= 2,
    'both Host inbox projections after release')
    const projections = inboxFrames().filter((frame) => Object.hasOwn(valOf(frame), 'seq'))
    assert.deepEqual(projections.map((frame) => valOf(frame).seq),
      [host.SPLICE_SEQ, host.CLAIM_SEQ], 'both Host watermarks arrive in order, the claim one last')
    assert.deepEqual(inboxOf(projections[1]), host.survivingInbox,
      'the real claim projection matches the reconstructed surviving inbox')
    assert.equal(fallback().length, 1, 'the replayed claim is not synthesized twice')
    assert.equal(streams.control.errors.length, 0, JSON.stringify(streams.control.errors))
    assert.equal(streams.follow.errors.length, 0, JSON.stringify(streams.follow.errors))
  } finally {
    try { paired.connection.ws?.terminate() } catch { /* already gone */ }
  }
})
