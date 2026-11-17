// Spec 038 R4-R6 and review findings 3-8 — router-level offline prompt queue.
// Fake rc.1 carrier + stub remote; the outbox and retention are real files in a temp dir.
import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { test } from 'node:test'

import { PINNED_DSH_VERSION, createHostRouter } from '../lib/host-router.mjs'
import { createPromptOutbox } from '../lib/prompt-outbox.mjs'
import { createRetentionStore } from '../lib/session-cache.mjs'

const tempDir = () => fs.mkdtempSync(path.join(os.tmpdir(), 'dsh-devices-replay-'))
const cleanup = (dir) => fs.rmSync(dir, { recursive: true, force: true })
const delay = (ms) => new Promise((resolve) => setTimeout(resolve, ms))
const promptArgs = (requestId, extra = {}) => ({ sessionId: 'h:hostB:s1', requestId, ...extra })

function harness({ dir = tempDir(), outbox, call, online = false } = {}) {
  const gateway = {
    async dispatchRpc(endpoint, payload, signal, peer) { // eslint-disable-line no-unused-vars
      return { ok: true, value: {} }
    },
    async openWireStream(endpoint, payload, uplink, peer, signal, control, window) { // eslint-disable-line no-unused-vars
      const stream = {
        async *[Symbol.asyncIterator]() { /* no stream needed here */ },
      }
      return stream
    },
  }
  const calls = []
  const connection = {
    state: 'online',
    async call(endpoint, args, options) {
      calls.push({ endpoint, args, signal: options?.signal })
      if (call) return call(endpoint, args, options)
      return { accepted: true }
    },
    async openStream() { throw new Error('not used') },
  }
  const listeners = new Set()
  const connected = new Set(online ? ['hostB'] : [])
  const notify = () => { for (const listener of [...listeners]) listener() }
  const store = outbox ?? createPromptOutbox({ dir })
  const router = createHostRouter({
    gateway, dshVersion: PINNED_DSH_VERSION, outbox: store,
    retention: createRetentionStore({ dir }), mergeBaselineTimeoutMs: 20,
    hosts: () => (connected.has('hostB') ? [{ hostId: 'hostB', hostName: 'Host B', connection, online: true }] : []),
    knownHosts: () => [{ hostId: 'hostB', hostName: 'Host B' }],
    onHostsChanged: (listener) => { listeners.add(listener); return () => listeners.delete(listener) },
  })
  router.install()
  return {
    dir, router, store, calls,
    send: (args, signal) => gateway.dispatchRpc('session/prompt', { args }, signal, {}),
    connect() { connected.add('hostB'); notify() },
    disconnect() { connected.delete('hostB'); notify() },
    close() { router.uninstall() },
  }
}

async function settled(promise, label, ms = 1500) {
  return Promise.race([
    promise,
    delay(ms).then(() => { throw new Error(`timed out waiting for ${label}`) }),
  ])
}

async function stillPending(promise, label) {
  const result = await Promise.race([promise.then((value) => ({ done: true, value })), delay(40).then(() => ({ done: false }))])
  assert.equal(result.done, false, `${label} must stay pending while queued`)
}

async function until(fn, label, tries = 80) {
  for (let attempt = 0; attempt < tries; attempt += 1) {
    if (await fn()) return
    await delay(10)
  }
  throw new Error(`timed out waiting for ${label}`)
}

test('offline prompts stay pending and replay once, FIFO, with original ids and wire form', async () => {
  const h = harness()
  try {
    const text = h.send(promptArgs('req-1', { text: 'plain one' }))
    const content = h.send(promptArgs('req-2', { content: [{ type: 'text', text: 'content two' }] }))
    const instant = h.send(promptArgs('req-3', { mode: 'instant', content: [{ type: 'text', text: 'instant three' }] }))
    await stillPending(text, 'first prompt')
    assert.equal(h.calls.length, 0, 'no remote call while offline')
    assert.equal(h.router.status().disconnected[0].queuedPrompts, 3)

    h.connect()
    assert.deepEqual((await settled(text, 'text replay')).value, { accepted: true })
    assert.equal((await settled(content, 'content replay')).ok, true)
    assert.equal((await settled(instant, 'instant replay')).ok, true)
    await until(() => h.calls.length === 3, 'all three replays')
    assert.deepEqual(h.calls.map((call) => call.args), [
      { sessionId: 's1', requestId: 'req-1', text: 'plain one' },
      { sessionId: 's1', requestId: 'req-2', content: [{ type: 'text', text: 'content two' }] },
      { sessionId: 's1', requestId: 'req-3', mode: 'instant', content: [{ type: 'text', text: 'instant three' }] },
    ], 'the original requestId, text slot and native mode all survive the queue')
    assert.equal(h.store.list().count, 0)
  } finally { h.close(); cleanup(h.dir) }
})

test('forget cancels every stored item for the host and aborts in-flight replay', async () => {
  let releaseFirst
  const h = harness({ call: (endpoint, args, options) => new Promise((resolve, reject) => {
    releaseFirst = () => resolve({ accepted: true })
    options?.signal?.addEventListener('abort', () => reject(Object.assign(new Error('aborted'), { code: 'cancelled' })), { once: true })
  }) })
  try {
    const first = h.send(promptArgs('req-a', { text: 'a' }))
    h.send(promptArgs('req-b', { text: 'b' }))
    h.connect()
    await until(() => h.calls.length === 1, 'the first replay to start')
    h.router.forgetHost('hostB')
    const result = await settled(first, 'cancelled by forget')
    assert.equal(result.ok, false)
    assert.equal(result.error.code, 'remote/host-gone')
    assert.equal(h.store.list().count, 0, 'both stored items are gone, not just the live one')
    await delay(60)
    assert.equal(h.calls.length, 1, 'the in-flight replay was aborted, so the second item never sent')
    releaseFirst?.()
  } finally { h.close(); cleanup(h.dir) }
})

test('a permanent host refusal settles the native call with the real reason', async () => {
  const h = harness({ call: () => { throw Object.assign(new Error('scope refused'), { code: 'auth/forbidden-scope' }) } })
  try {
    const pending = h.send(promptArgs('denied', { text: 'no' }))
    h.connect()
    const answer = await settled(pending, 'permanent refusal')
    assert.equal(answer.ok, false)
    assert.equal(answer.error.code, 'auth/forbidden-scope')
    assert.equal(answer.error.message, 'scope refused')
    assert.equal(h.store.list().items[0].status, 'failed')
    assert.equal(h.store.list().items[0].reason.code, 'auth/forbidden-scope')
    h.disconnect(); h.connect()
    await delay(60)
    assert.equal(h.calls.length, 1, 'a terminal refusal is never replayed')
  } finally { h.close(); cleanup(h.dir) }
})

test('TTL expiry settles the pending native call with a visible expiry reason', async () => {
  const dir = tempDir()
  const store = createPromptOutbox({ dir, limits: { ttlMs: 1500 } })
  const h = harness({ dir, outbox: store })
  try {
    const pending = h.send(promptArgs('expires', { text: 'wait' }))
    await stillPending(pending, 'the expiring prompt')
    const answer = await settled(pending, 'expiry', 3000)
    assert.equal(answer.ok, false)
    assert.equal(answer.error.code, 'remote/prompt-expired')
    assert.equal(store.list().count, 0)
    h.connect()
    await delay(60)
    assert.equal(h.calls.length, 0, 'an expired item is never replayed')
  } finally { h.close(); cleanup(dir) }
})

test('a storage write failure rejects the native call instead of holding it pending', async () => {
  const parent = tempDir()
  try {
    const blocker = path.join(parent, 'not-a-directory')
    fs.writeFileSync(blocker, 'file')
    const store = createPromptOutbox({ dir: blocker })
    const h = harness({ dir: parent, outbox: store })
    try {
      const answer = await settled(h.send(promptArgs('persist', { text: 'x' })), 'persist refusal')
      assert.equal(answer.ok, false)
      assert.equal(answer.error.code, 'remote/persist-failed')
      assert.equal(h.router.status().disconnected[0].queuedPrompts, 0)
      h.connect()
      await delay(60)
      assert.equal(h.calls.length, 0)
    } finally { h.close() }
  } finally { cleanup(parent) }
})

test('an unsupported prompt is refused visibly and never enters the outbox', async () => {
  const h = harness()
  try {
    const steer = await h.send(promptArgs('steer', { mode: 'steer', text: 'x' }))
    assert.equal(steer.ok, false)
    assert.equal(steer.error.code, 'remote/steer-not-queueable')
    const attachment = await h.send(promptArgs('file', { text: 'x', attachments: [{ fileId: 'f1' }] }))
    assert.equal(attachment.ok, false)
    assert.equal(attachment.error.code, 'remote/attachment-bearing')
    assert.equal(h.store.list().count, 0)
  } finally { h.close(); cleanup(h.dir) }
})

test('ordinary teardown is not terminal: a new router replays the queued item once', async () => {
  const dir = tempDir()
  try {
    const store = createPromptOutbox({ dir })
    const first = harness({ dir, outbox: store })
    first.send(promptArgs('restart', { text: 'x' })) // abandoned caller, item stays queued
    first.close()
    assert.equal(store.list().count, 1, 'teardown leaves the eligible item for the next instance')
    assert.equal(store.list().items[0].requestId, 'restart')

    const second = harness({ dir, outbox: createPromptOutbox({ dir }) })
    try {
      second.connect()
      await until(() => second.calls.length === 1, 'the next instance to replay')
      assert.deepEqual(second.calls[0].args, { sessionId: 's1', requestId: 'restart', text: 'x' })
      await delay(80)
      assert.equal(second.calls.length, 1, 'replayed exactly once with the original requestId')
      assert.equal(second.store.list().count, 0, 'the replaying instance settled the item')
    } finally { second.close() }
  } finally { cleanup(dir) }
})

test('a caller abort settles terminally, removes the item and leaves nothing to replay', async () => {
  const h = harness()
  try {
    const control = new AbortController()
    const pending = h.send(promptArgs('aborted', { text: 'x' }), control.signal)
    control.abort()
    const answer = await settled(pending, 'abort settlement')
    assert.equal(answer.ok, false)
    assert.equal(answer.error.code, 'cancelled')
    assert.equal(h.store.list().count, 0, 'a settled call never leaves a replayable phantom')
    h.connect()
    await delay(60)
    assert.equal(h.calls.length, 0)
  } finally { h.close(); cleanup(h.dir) }
})

test('an online send joins the ordered lane when that session has a backoff head', async () => {
  const dir = tempDir()
  let attempts = 0
  const store = createPromptOutbox({ dir, limits: { backoffBaseMs: 2000, maxBackoffMs: 2000 } })
  const h = harness({
    dir, outbox: store,
    call: () => {
      attempts += 1
      if (attempts === 1) throw Object.assign(new Error('transport reset'), { code: 'ECONNRESET' })
      return { accepted: true }
    },
  })
  try {
    const head = h.send(promptArgs('head', { text: 'one' }))
    h.connect()
    await until(() => attempts === 1, 'the first attempt')
    await delay(30)
    assert.equal(store.list().items[0].status, 'queued', 'the head is waiting out its backoff')
    const next = h.send(promptArgs('second', { text: 'two' }))
    assert.equal(h.calls.length, 1, 'a new online send must not overtake the queued head')
    await until(() => h.calls.length === 3, 'both prompts to replay in order', 600)
    assert.deepEqual(h.calls.slice(1).map((call) => call.args.requestId), ['head', 'second'])
    assert.equal((await settled(head, 'head settle')).ok, true)
    assert.equal((await settled(next, 'second settle')).ok, true)
    assert.equal(store.list().count, 0)
  } finally { h.close(); cleanup(dir) }
})
