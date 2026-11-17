// Spec 038 R4-R7 — standalone offline prompt outbox (lib/prompt-outbox.mjs).
//
// Runs with `node --test test/prompt-outbox.test.mjs` from plugins/devices.
// Everything is file-backed: no DSH runtime, no gateway and no Host are needed.
// `limits.now` is a clock seam so TTL/backoff never depend on wall time.
import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { test } from 'node:test'

import {
  createPromptOutbox, promptItemKey, DEFAULT_LIMITS, PROMPT_STATUSES,
  OUTBOX_FILE,
} from '../lib/prompt-outbox.mjs'

const HOST = 'hostB-uuid-1234'
const HOST2 = 'hostC-uuid-5678'
const SESSION = 's-abc'
const SESSION2 = 's-def'
const SECRET = 'the prompt body must never appear in a status or a log'
const clock = (start = 1_800_000_000_000) => {
  let current = start
  return { now: () => current, advance: (ms) => { current += ms } }
}

function tempDir() {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'dsh-devices-outbox-'))
}
const cleanup = (dir) => fs.rmSync(dir, { recursive: true, force: true })
const prompt = (requestId, text = SECRET, extra = {}) => ({
  hostId: HOST, sessionId: SESSION, requestId, text, ...extra,
})
const stored = (dir) => JSON.parse(fs.readFileSync(path.join(dir, OUTBOX_FILE), 'utf8'))

// -- persistence / replay ---------------------------------------------------

test('enqueue persists, reloads and replays with the original requestId and text', () => {
  const dir = tempDir()
  try {
    const first = createPromptOutbox({ dir })
    const receipt = first.enqueue(prompt('req-1'))
    assert.equal(receipt.status, 'queued')
    assert.equal(receipt.duplicate, false)
    assert.equal(receipt.persisted, true)
    assert.equal(receipt.key, promptItemKey(HOST, SESSION, 'req-1'))
    assert.match(receipt.key, /^po-[0-9a-f]{32}$/)
    assert.equal('text' in receipt, false, 'the receipt is status-only')

    // A second instance is a fresh module instance over the same plugin dir.
    const reloaded = createPromptOutbox({ dir })
    const listed = reloaded.list(HOST, SESSION)
    assert.equal(listed.count, 1)
    assert.equal(listed.items[0].key, receipt.key)
    assert.equal('text' in listed.items[0], false, 'a list descriptor carries no body')
    const claimed = reloaded.claimNext(HOST, SESSION)
    assert.equal(claimed.replay.requestId, 'req-1')
    assert.equal(claimed.replay.hostId, HOST)
    assert.equal(claimed.replay.sessionId, SESSION)
    assert.equal(claimed.replay.text, SECRET)
    assert.deepEqual(Object.keys(claimed.replay).sort(), ['hostId', 'requestId', 'sessionId', 'text'])
    assert.equal(claimed.status, 'sending')
    assert.equal(claimed.attempts, 1)

    // Only the plugin-owned JSON file is written; no temp file survives the rename.
    assert.deepEqual(fs.readdirSync(dir).sort(), [OUTBOX_FILE])
  } finally { cleanup(dir) }
})

test('FIFO per session: ordering is stable within a session and independent across sessions', () => {
  const dir = tempDir()
  try {
    const time = clock()
    const outbox = createPromptOutbox({ dir, limits: { now: time.now } })
    for (const id of ['a1', 'a2', 'a3']) outbox.enqueue(prompt(id))
    outbox.enqueue({ ...prompt('b1'), sessionId: SESSION2 })
    outbox.enqueue({ ...prompt('c1'), hostId: HOST2, sessionId: SESSION })

    assert.deepEqual(outbox.list().items.map((item) => item.requestId), ['a1', 'a2', 'a3', 'b1', 'c1'])
    assert.deepEqual(outbox.list(HOST, SESSION).items.map((item) => item.requestId), ['a1', 'a2', 'a3'])
    assert.deepEqual(outbox.list(HOST, SESSION2).items.map((item) => item.requestId), ['b1'])
    assert.deepEqual(outbox.list(HOST2, SESSION).items.map((item) => item.requestId), ['c1'])

    for (const expected of ['a1', 'a2', 'a3']) {
      const claimed = outbox.claimNext(HOST, SESSION)
      assert.equal(claimed.replay.requestId, expected)
      outbox.mark(HOST, SESSION, expected, 'acked')
    }
    assert.equal(outbox.claimNext(HOST, SESSION), null)
    assert.equal(outbox.claimNext(HOST, SESSION2).replay.requestId, 'b1')
    assert.equal(outbox.claimNext(HOST2, SESSION).replay.requestId, 'c1')
  } finally { cleanup(dir) }
})

test('duplicate (host, session, requestId) is idempotent and never creates a second item', () => {
  const dir = tempDir()
  try {
    const outbox = createPromptOutbox({ dir })
    const first = outbox.enqueue(prompt('dup'))
    const second = outbox.enqueue(prompt('dup'))
    assert.equal(second.key, first.key)
    assert.equal(second.duplicate, true)
    assert.equal(second.status, 'queued')
    assert.equal(outbox.list().count, 1, 'one durable item')
    assert.equal(stored(dir).items.length, 1)

    // After the original was settled, the same request cannot be queued or replayed again.
    outbox.mark(HOST, SESSION, 'dup', 'acked')
    const again = outbox.enqueue(prompt('dup'))
    assert.equal(again.status, 'refused')
    assert.equal(again.reason, 'already-settled')
    assert.equal(outbox.list().count, 0)
    assert.equal(outbox.claimNext(HOST, SESSION), null)
  } finally { cleanup(dir) }
})

// -- bounds -----------------------------------------------------------------

test('TTL expiry is refused at enqueue, pruned on reload and excluded from list', () => {
  const dir = tempDir()
  try {
    const time = clock()
    const outbox = createPromptOutbox({ dir, limits: { now: time.now, ttlMs: 1000 } })
    const expired = outbox.enqueue({ ...prompt('old'), createdAt: time.now() - 5000 })
    assert.equal(expired.status, 'refused')
    assert.equal(expired.reason, 'expired')
    outbox.enqueue(prompt('fresh'))
    assert.equal(outbox.list().count, 1)

    time.advance(5000)
    const later = createPromptOutbox({ dir, limits: { now: time.now, ttlMs: 1000 } })
    assert.equal(later.list().count, 0, 'expired items are discarded, not replayed')
    assert.equal(later.claimNext(HOST, SESSION), null)
    assert.equal(stored(dir).items.length, 0)
    assert.equal(later.enqueue(prompt('new')).status, 'queued', 'expired items free the cap')
  } finally { cleanup(dir) }
})

test('item count, per-item bytes and total bytes are capped visibly', () => {
  const dir = tempDir()
  try {
    const small = createPromptOutbox({ dir, limits: { maxItems: 2, maxItemBytes: 4096, maxTotalBytes: 6000 } })
    assert.equal(small.enqueue(prompt('one')).status, 'queued')
    assert.equal(small.enqueue(prompt('two')).status, 'queued')
    const full = small.enqueue(prompt('three'))
    assert.equal(full.status, 'refused')
    assert.equal(full.reason, 'outbox-full')
    assert.equal(small.list().count, 2, 'nothing is silently evicted')

    const tiny = tempDir()
    try {
      const sized = createPromptOutbox({ dir: tiny, limits: { maxItemBytes: 120 } })
      const refusal = sized.enqueue(prompt('big', 'x'.repeat(1000)))
      assert.equal(refusal.status, 'refused')
      assert.equal(refusal.reason, 'item-too-large')
      assert.equal(sized.list().count, 0)
      assert.equal(fs.existsSync(path.join(tiny, OUTBOX_FILE)), false, 'a refusal does not write')
    } finally { cleanup(tiny) }
  } finally { cleanup(dir) }
})

// -- claim / release / statuses ---------------------------------------------

test('claim, transient release and exponential backoff preserve the original item', () => {
  const dir = tempDir()
  try {
    const time = clock()
    const outbox = createPromptOutbox({ dir, limits: { now: time.now, backoffBaseMs: 1000, maxBackoffMs: 5000 } })
    outbox.enqueue(prompt('retry'))
    const claimed = outbox.claimNext(HOST, SESSION)
    assert.equal(claimed.replay.requestId, 'retry')
    assert.equal(claimed.attempts, 1)
    assert.equal(outbox.list().items[0].status, 'sending')

    const first = outbox.releaseOnFailure(claimed, { code: 'transport-reset' })
    assert.deepEqual([first.status, first.backoffMs, first.nextAt], ['queued', 1000, time.now() + 1000])
    assert.equal(outbox.claimNext(HOST, SESSION), null, 'backoff blocks an immediate replay')

    time.advance(1000)
    const second = outbox.claimNext(HOST, SESSION)
    assert.equal(second.replay.requestId, 'retry')
    assert.equal(second.attempts, 2, 'the attempt count follows the item')
    const backoff = outbox.releaseOnFailure(second, { code: 'transport-reset' })
    assert.equal(backoff.backoffMs, 2000, 'exponential, capped by maxBackoffMs')
    time.advance(10_000)
    const third = outbox.claimNext(HOST, SESSION)
    const thirdRelease = outbox.releaseOnFailure(third, { code: 'transport-reset' })
    assert.equal(thirdRelease.backoffMs, 4000, '1000 * 2^2')
    time.advance(10_000)
    const capped = outbox.claimNext(HOST, SESSION)
    const cappedRelease = outbox.releaseOnFailure(capped, { code: 'transport-reset' })
    assert.equal(cappedRelease.backoffMs, 5000, 'the cap wins on the fourth attempt')
    assert.equal(outbox.list().count, 1)
  } finally { cleanup(dir) }
})

test('statuses and terminal outcomes: sent/acked/cancelled remove; failed keeps a code and no body', () => {
  const dir = tempDir()
  try {
    const outbox = createPromptOutbox({ dir })
    outbox.enqueue(prompt('s1'))
    assert.deepEqual(PROMPT_STATUSES, ['queued', 'sending', 'sent', 'acked', 'failed', 'cancelled'])
    assert.equal(outbox.mark(HOST, SESSION, 's1', 'sending').ok, true)
    assert.equal(outbox.list().items[0].attempts, 1)
    assert.equal(outbox.mark(HOST, SESSION, 's1', 'queued').ok, true)
    assert.equal(outbox.mark(HOST, SESSION, 's1', 'sent').ok, true)
    assert.equal(outbox.list().count, 0)
    assert.equal(stored(dir).tombstones.length, 1)

    outbox.enqueue(prompt('s2'))
    assert.equal(outbox.mark(HOST, SESSION, 's2', 'cancelled').ok, true)
    outbox.enqueue(prompt('s3'))
    assert.equal(outbox.mark(HOST, SESSION, 's3', 'acked').ok, true)
    assert.equal(outbox.list().count, 0)
    assert.equal(stored(dir).tombstones.length, 3)

    outbox.enqueue(prompt('s4'))
    const terminal = outbox.mark(HOST, SESSION, 's4', 'failed', { code: 'permanent-refusal' })
    assert.equal(terminal.ok, true)
    const item = outbox.list().items[0]
    assert.equal(item.status, 'failed')
    assert.equal(item.reason.code, 'permanent-refusal')
    assert.equal('text' in item, false)
    assert.equal('text' in stored(dir).items[0], false, 'the durable record has no body')
    assert.equal(outbox.claimNext(HOST, SESSION), null, 'a failed item is never replayed')

    assert.equal(outbox.mark(HOST, SESSION, 's4', 'nonsense').reason, 'bad-status')
    assert.equal(outbox.mark(HOST, SESSION, 'missing', 'acked').reason, 'not-found')

    const bounded = tempDir()
    try {
      const capped = createPromptOutbox({ dir: bounded, limits: { maxTerminal: 2 } })
      for (const id of ['t1', 't2', 't3']) {
        capped.enqueue(prompt(id))
        capped.mark(HOST, SESSION, id, 'acked')
      }
      assert.equal(stored(bounded).tombstones.length, 2, 'tombstones are bounded')
    } finally { cleanup(bounded) }
  } finally { cleanup(dir) }
})

test('releaseOnFailure with a permanent refusal is terminal and drops the body', () => {
  const dir = tempDir()
  try {
    const outbox = createPromptOutbox({ dir })
    outbox.enqueue(prompt('perm'))
    const claimed = outbox.claimNext(HOST, SESSION)
    const released = outbox.releaseOnFailure(claimed, { code: 'invalid-request', permanent: true })
    assert.equal(released.status, 'failed')
    assert.equal(released.reason, 'invalid-request')
    assert.equal(outbox.list().items[0].reason.code, 'invalid-request')
    assert.equal('text' in stored(dir).items[0], false)
    assert.equal(outbox.claimNext(HOST, SESSION), null)
    assert.equal(outbox.releaseOnFailure(claimed, { code: 'transport-reset' }).reason, 'not-claimed')
  } finally { cleanup(dir) }
})

// -- eligibility ------------------------------------------------------------

test('attachments, file receipts, steer, non-string requestId and non-text payloads are refused', () => {
  const dir = tempDir()
  try {
    const outbox = createPromptOutbox({ dir })
    const cases = [
      [{ ...prompt('a'), attachments: [{ fileId: 'f1' }] }, 'attachment-bearing'],
      [{ ...prompt('b'), files: ['f1'] }, 'attachment-bearing'],
      [{ ...prompt('c'), fileReceipts: ['r1'] }, 'attachment-bearing'],
      [prompt('d', SECRET, { mode: 'steer' }), 'steer-not-queueable'],
      [{ ...prompt('e'), requestId: 123 }, 'bad-request-id'],
      [{ ...prompt('f'), text: ['not', 'text'] }, 'non-text-payload'],
      [{ ...prompt('g'), text: '' }, 'empty-text'],
      [{ ...prompt('h'), text: '   ' }, 'empty-text'],
      [{ ...prompt('i'), extra: 'x' }, 'unsupported-field'],
      [null, 'bad-input'],
    ]
    for (const [input, reason] of cases) {
      const result = outbox.enqueue(input)
      assert.equal(result.status, 'refused', `${reason}: ${JSON.stringify(result)}`)
      assert.equal(result.reason, reason)
    }
    assert.equal(outbox.list().count, 0, 'nothing eligible was queued')
    assert.equal(fs.existsSync(path.join(dir, OUTBOX_FILE)), false)
  } finally { cleanup(dir) }
})

// -- corruption / privacy ---------------------------------------------------

test('a corrupt file, invalid envelope or corrupt record is ignored safely', () => {
  const dir = tempDir()
  try {
    const file = path.join(dir, OUTBOX_FILE)
    fs.writeFileSync(file, '{not json at all')
    const broken = createPromptOutbox({ dir })
    assert.equal(broken.list().count, 0)
    assert.equal(broken.claimNext(HOST, SESSION), null)
    assert.equal(broken.enqueue(prompt('good')).status, 'queued', 'a later write replaces the garbage')
    assert.equal(createPromptOutbox({ dir }).list().count, 1)

    const mixed = tempDir()
    try {
      const mixedFile = path.join(mixed, OUTBOX_FILE)
      const valid = {
        key: promptItemKey(HOST, SESSION, 'ok'), hostId: HOST, sessionId: SESSION, requestId: 'ok',
        text: SECRET, mode: 'text', status: 'queued', sequence: 7, createdAt: 1, updatedAt: 1,
        attempts: 0, nextAt: 0, reason: null,
      }
      fs.writeFileSync(mixedFile, JSON.stringify({
        version: 1, nextSequence: 8,
        items: [null, 'junk', { ...valid, text: 5 }, { ...valid, requestId: 'bad-id', key: 'po-bad' }, valid],
        tombstones: [null, { key: valid.key, at: 1 }],
      }))
      const recovered = createPromptOutbox({ dir: mixed, limits: { now: () => 1 } })
      assert.equal(recovered.list().count, 1, 'only the well-formed record survives')
      assert.equal(recovered.claimNext(HOST, SESSION).replay.requestId, 'ok')
      assert.equal(stored(mixed).items.length, 1)
    } finally { cleanup(mixed) }
  } finally { cleanup(dir) }
})

test('no raw prompt or raw id in a log line or a status result; text only in replay', () => {
  const dir = tempDir()
  try {
    const time = clock()
    const logs = []
    const outbox = createPromptOutbox({
      dir, log: (line) => logs.push(line),
      limits: { now: time.now, ttlMs: 1000 },
    })
    const receipt = outbox.enqueue(prompt('private-req'))
    const listed = outbox.list(HOST, SESSION)
    const claimed = outbox.claimNext(HOST, SESSION)
    const released = outbox.releaseOnFailure(claimed, { code: 'transport-reset' })
    const marked = outbox.mark(HOST, SESSION, 'private-req', 'failed', { code: 'permanent-refusal' })

    for (const result of [receipt, listed, released, marked]) {
      const text = JSON.stringify(result)
      assert.equal(text.includes(SECRET), false, 'status results carry no prompt body')
    }
    assert.equal(JSON.stringify(listed.items[0]).includes('private-req'), true, 'ids are visible to the UI, not logged')

    // Force the module's own pruning path so at least one log line is emitted.
    time.advance(2000)
    outbox.list()
    assert.ok(logs.length > 0, 'the pruning path did log a fixed code')
    const logText = logs.join('\n')
    assert.equal(logText.includes(SECRET), false)
    assert.equal(logText.includes(HOST), false)
    assert.equal(logText.includes(SESSION), false)
    assert.equal(logText.includes('private-req'), false)
    assert.ok(logs.every((line) => line.startsWith('prompt-outbox: ')))
    // The deliberate exception is the replay input, which must contain the text.
    assert.equal(claimed.replay.text, SECRET)
    assert.equal('text' in claimed, true)
  } finally { cleanup(dir) }
})

test('strict FIFO: a backoff or in-flight head blocks later prompts of the session', () => {
  const dir = tempDir()
  try {
    const time = clock()
    const outbox = createPromptOutbox({ dir, limits: { now: time.now, backoffBaseMs: 1000 } })
    outbox.enqueue(prompt('head'))
    outbox.enqueue(prompt('tail'))
    const head = outbox.claimNext(HOST, SESSION)
    assert.equal(head.replay.requestId, 'head')
    assert.equal(outbox.claimNext(HOST, SESSION), null, 'a sending head is not overtaken')
    outbox.releaseOnFailure(head, { code: 'ECONNRESET' })
    assert.equal(outbox.claimNext(HOST, SESSION), null, 'a head in backoff still blocks the tail')
    time.advance(1000)
    assert.equal(outbox.claimNext(HOST, SESSION).replay.requestId, 'head')
    outbox.mark(HOST, SESSION, 'head', 'acked')
    assert.equal(outbox.claimNext(HOST, SESSION).replay.requestId, 'tail')
  } finally { cleanup(dir) }
})

test('a persisted sending item is recovered to queued on reload with the same requestId', () => {
  const dir = tempDir()
  try {
    const first = createPromptOutbox({ dir })
    first.enqueue(prompt('restart'))
    assert.equal(first.claimNext(HOST, SESSION).replay.requestId, 'restart')
    assert.equal(stored(dir).items[0].status, 'sending')

    const reloaded = createPromptOutbox({ dir })
    assert.equal(reloaded.list().items[0].status, 'queued', 'a dead process cannot leave an item stuck sending')
    const claimed = reloaded.claimNext(HOST, SESSION)
    assert.equal(claimed.replay.requestId, 'restart')
    assert.equal(claimed.attempts, 2, 'the attempt count follows the recovered item')
    assert.equal(stored(dir).items[0].status, 'sending')
  } finally { cleanup(dir) }
})

test('enqueue whose write failed is refused and rolled back (no replayable phantom)', () => {
  const parent = tempDir()
  try {
    const blocker = path.join(parent, 'a-file-not-a-directory')
    fs.writeFileSync(blocker, 'not a directory')
    const outbox = createPromptOutbox({ dir: blocker })
    const result = outbox.enqueue(prompt('no-disk'))
    assert.equal(result.status, 'refused')
    assert.equal(result.reason, 'persist-failed')
    assert.equal(outbox.list().count, 0)
    assert.equal(outbox.claimNext(HOST, SESSION), null)
  } finally { cleanup(parent) }
})

test('claim preserves the stored mode and wire form for faithful replay', () => {
  const dir = tempDir()
  try {
    const outbox = createPromptOutbox({ dir })
    assert.equal(outbox.enqueue({ ...prompt('mode'), mode: 'instant', wire: 'content' }).status, 'queued')
    const claimed = outbox.claimNext(HOST, SESSION)
    assert.equal(claimed.mode, 'instant')
    assert.equal(claimed.wire, 'content')
    assert.equal(stored(dir).items[0].wire, 'content')
  } finally { cleanup(dir) }
})

test('defaults and hash-derived keys are stable and scope-separated', () => {
  assert.equal(DEFAULT_LIMITS.maxItems, 100)
  assert.equal(DEFAULT_LIMITS.maxItemBytes, 256 * 1024)
  assert.equal(DEFAULT_LIMITS.ttlMs, 7 * 24 * 60 * 60 * 1000)
  const dir = tempDir()
  try {
    const outbox = createPromptOutbox({ dir })
    assert.equal(outbox.limits.maxItems, 100)
    assert.equal(outbox.limits.maxItemBytes, 262144)
    assert.equal(outbox.limits.ttlMs, 604800000)
    assert.equal(outbox.file, path.join(dir, OUTBOX_FILE))
    // A raw id is never used as a key or a file name.
    assert.equal(outbox.enqueue({ ...prompt('keyed'), hostId: 'a/b\\c:..' }).reason, 'bad-target')
  } finally { cleanup(dir) }
  assert.equal(promptItemKey(HOST, SESSION, 'r'), promptItemKey(HOST, SESSION, 'r'))
  assert.notEqual(promptItemKey(HOST, SESSION, 'r'), promptItemKey(HOST, SESSION, 'r2'))
  assert.notEqual(promptItemKey(HOST, SESSION, 'r'), promptItemKey(HOST, SESSION2, 'r'))
  assert.notEqual(promptItemKey(HOST, SESSION, 'r'), promptItemKey(HOST2, SESSION, 'r'))
  assert.equal(promptItemKey('a', 'b', 'c').startsWith('po-'), true)
  assert.match(promptItemKey('a', 'b', 'c'), /^po-[0-9a-f]{32}$/)
})
