// Offline prompt outbox for remote sessions (spec 038 R4-R7).
//
// Standalone module: it owns ONE JSON file inside a plugin-owned directory and
// never reads or writes a DSH file, state or projection. The router keeps the
// originating `session/prompt` pending while an item is here; reconnect replay
// takes the item from claimNext() with its ORIGINAL requestId, which is what the
// Host's prompt admission de-duplicates on.
//
// Boundaries, both by construction:
//  - Only plain text is accepted. No attachment, file receipt, binary part or
//    `mode:'steer'` can enter the store, so a replay can never carry a file.
//  - Item keys are SHA-256 of (host, session, request) under a fixed scope, not
//    an id used as an object key or file name: no prototype pollution, no ADS,
//    no traversal, and no raw id in a log line. The `log` callback receives only
//    fixed status codes — never an id, a requestId, a reason text or a prompt.
//
// The text necessarily lives in the JSON file (replay needs it) but is returned
// only by claimNext(), the replay entry point. Every other result and every log
// line is a status-only view.
import crypto from 'node:crypto'
import fs from 'node:fs'
import path from 'node:path'

import { SECRET_FILE_MODE, ensureOwnerOnlyDirectory, restrictToOwnerSync } from './secure-file.mjs'

/** Storage format. A mismatched version is treated as unreadable, never migrated blindly. */
export const OUTBOX_VERSION = 1
/** The only file this module writes, always inside the directory the caller passes. */
export const OUTBOX_FILE = 'prompt-outbox.json'

export const DEFAULT_LIMITS = Object.freeze({
  maxItems: 100,
  maxItemBytes: 256 * 1024,
  ttlMs: 7 * 24 * 60 * 60 * 1000,
  maxTerminal: 100,
  backoffBaseMs: 1000,
  maxBackoffMs: 60 * 1000,
})

export const PROMPT_STATUSES = Object.freeze(['queued', 'sending', 'sent', 'acked', 'failed', 'cancelled'])

/** Refusal codes are stable so the caller can surface a visible reason. */
export const REFUSAL_CODES = Object.freeze([
  'bad-input', 'attachment-bearing', 'unsupported-field', 'bad-target', 'bad-request-id',
  'non-text-payload', 'empty-text', 'steer-not-queueable', 'unsupported-mode',
  'bad-created-at', 'expired', 'outbox-full', 'item-too-large', 'outbox-bytes-full',
  'already-settled', 'persist-failed', 'unsupported-wire',
])

const KEY_SCOPE = 'dsh-devices/prompt-outbox/v1'
const KEY_PREFIX = 'po-'
const KEY_RE = /^po-[0-9a-f]{32}$/
// Remote codes are namespaced (`auth/forbidden-scope`), so `/` and `:` are part
// of a reason code; it is a JSON value, never a file name.
const REASON_RE = /^[A-Za-z][A-Za-z0-9._/:-]{0,63}$/
// Same identifier alphabet as the session cache: an id is a token, not a path.
const ID_RE = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,255}$/

const ALLOWED_FIELDS = new Set(['hostId', 'sessionId', 'requestId', 'text', 'createdAt', 'mode', 'wire'])
// Modes that can be replayed faithfully. `text`/`plain` are the outbox's own wire
// markers; `instant` is DSH's native composer mode and is kept verbatim on replay.
const ALLOWED_MODES = new Set(['text', 'plain', 'instant'])
const WIRE_FORMS = new Set(['text', 'content'])
// Any of these on the input means the caller tried to hand us a file or a
// receipt; the generic `unsupported-field` guard below catches the rest.
const ATTACHMENT_FIELDS = new Set([
  'attachments', 'attachment', 'files', 'file', 'fileIds', 'fileId', 'fileReceipts', 'fileReceipt',
  'receipts', 'receipt', 'uploads', 'upload', 'blobs', 'blob', 'images', 'image', 'media',
  'parts', 'content', 'contents', 'binary', 'bytes', 'path', 'uri', 'url', 'dataUrl',
])
const PERMANENT_CODES = new Set([
  'permanent', 'permanent-refusal', 'permanent-rejection', 'invalid-request',
  'forbidden', 'rejected', 'unauthorized', 'auth/forbidden-scope', 'auth/unauthorized',
  'auth/locked', 'remote/forbidden-scope', 'scope-denied', 'permission-denied',
])

const idPattern = (value) => typeof value === 'string' && ID_RE.test(value)

/** Stable, opaque and collision-free across (host, session, request) triples. */
export const promptItemKey = (hostId, sessionId, requestId) => KEY_PREFIX + crypto.createHash('sha256')
  .update(KEY_SCOPE, 'utf8').update('\0', 'utf8')
  .update(hostId, 'utf8').update('\0', 'utf8')
  .update(sessionId, 'utf8').update('\0', 'utf8')
  .update(requestId, 'utf8').digest('hex').slice(0, 32)

const byteLength = (value) => Buffer.byteLength(JSON.stringify(value), 'utf8')

const reasonCode = (detail) => {
  const raw = typeof detail === 'string' ? detail
    : detail && typeof detail === 'object' && !Array.isArray(detail) ? detail.code : undefined
  return typeof raw === 'string' && REASON_RE.test(raw) ? raw : 'unspecified'
}

/** A refusal the Host produced is final; only transport failures may be retried. */
const permanentCode = (code) => PERMANENT_CODES.has(code)
  || code.startsWith('auth/') || /forbidden|denied|scope|invalid-request|reject/i.test(code)

const normalizeFailure = (reason) => {
  if (typeof reason === 'string') {
    return { code: reasonCode(reason), permanent: permanentCode(reasonCode(reason)) }
  }
  if (reason && typeof reason === 'object' && !Array.isArray(reason)) {
    const code = reasonCode(reason.code ?? reason)
    return { code, permanent: reason.permanent === true || permanentCode(code) }
  }
  return { code: 'unspecified', permanent: false }
}

const positiveInt = (value, fallback, max = Number.MAX_SAFE_INTEGER) =>
  Number.isSafeInteger(value) && value > 0 && value <= max ? value : fallback

const normalizeLimits = (input = {}) => {
  const source = input && typeof input === 'object' && !Array.isArray(input) ? input : {}
  const maxItems = positiveInt(source.maxItems, DEFAULT_LIMITS.maxItems)
  const maxItemBytes = positiveInt(source.maxItemBytes, DEFAULT_LIMITS.maxItemBytes)
  const ttlMs = positiveInt(source.ttlMs, DEFAULT_LIMITS.ttlMs)
  const maxTerminal = positiveInt(source.maxTerminal, DEFAULT_LIMITS.maxTerminal)
  const backoffBaseMs = positiveInt(source.backoffBaseMs, DEFAULT_LIMITS.backoffBaseMs)
  const maxBackoffMs = positiveInt(source.maxBackoffMs, DEFAULT_LIMITS.maxBackoffMs)
  return {
    maxItems, maxItemBytes, ttlMs, maxTerminal, backoffBaseMs, maxBackoffMs,
    maxTotalBytes: positiveInt(source.maxTotalBytes, maxItems * maxItemBytes),
    now: typeof source.now === 'function' ? source.now : () => Date.now(),
  }
}

/**
 * @param {object} options
 * @param {string} options.dir plugin-owned storage directory (never a DSH path)
 * @param {object} [options.limits] bounds and an optional `now()` clock seam
 * @param {(line: string) => void} [options.log] receives fixed codes only
 */
export function createPromptOutbox({ dir, limits, log } = {}) {
  const root = typeof dir === 'string' && dir ? path.resolve(dir) : ''
  const bound = normalizeLimits(limits)
  const emit = typeof log === 'function' ? log : () => {}
  // Fixed strings only: an id, a requestId, a reason body or a prompt must never
  // reach a log sink. The caller may prefix/namespace these codes itself.
  const safeLog = (code) => { try { emit(`prompt-outbox: ${code}`) } catch { /* a failing log is not fatal */ } }
  const file = root ? path.join(root, OUTBOX_FILE) : ''
  let preparedRoot = false
  let dirtyOnLoad = false

  const nowOf = () => {
    const value = bound.now()
    return Number.isFinite(value) && value > 0 ? value : Date.now()
  }

  const accepted = (record) => record && typeof record === 'object' && !Array.isArray(record)
    && KEY_RE.test(record.key) && record.key === promptItemKey(record.hostId, record.sessionId, record.requestId)
    && idPattern(record.hostId) && idPattern(record.sessionId) && idPattern(record.requestId)
    && (typeof record.text === 'string' || record.status === 'failed')
    && ALLOWED_MODES.has(record.mode)
    && (record.wire === undefined || WIRE_FORMS.has(record.wire))
    && PROMPT_STATUSES.includes(record.status)
    && record.status !== 'sent' && record.status !== 'acked' && record.status !== 'cancelled'
    && Number.isSafeInteger(record.sequence) && record.sequence > 0
    && Number.isFinite(record.createdAt) && record.createdAt > 0
    && Number.isFinite(record.updatedAt) && record.updatedAt > 0
    && Number.isSafeInteger(record.attempts) && record.attempts >= 0
    && Number.isFinite(record.nextAt) && record.nextAt >= 0
    && (record.reason === null || (record.reason && typeof record.reason === 'object'
      && typeof record.reason.code === 'string' && REASON_RE.test(record.reason.code)))
    && byteLength(record) <= bound.maxItemBytes

  const liveRecord = (record, now) => accepted(record) && now - record.createdAt <= bound.ttlMs
  const liveTombstone = (tombstone, now) => tombstone && typeof tombstone === 'object'
    && KEY_RE.test(tombstone.key) && typeof tombstone.at === 'number'
    && now - tombstone.at <= bound.ttlMs

  const empty = () => ({ version: OUTBOX_VERSION, nextSequence: 1, items: [], tombstones: [] })

  const load = (now) => {
    if (!file) return empty()
    let parsed
    try {
      parsed = JSON.parse(fs.readFileSync(file, 'utf8'))
    } catch (error) {
      if (error?.code !== 'ENOENT') safeLog('load-unreadable')
      return empty()
    }
    if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed) || parsed.version !== OUTBOX_VERSION
      || !Array.isArray(parsed.items) || !Array.isArray(parsed.tombstones)) {
      safeLog('load-invalid')
      return empty()
    }
    const items = parsed.items.filter((record) => liveRecord(record, now))
    const tombstones = parsed.tombstones.filter((tombstone) => liveTombstone(tombstone, now)).slice(-bound.maxTerminal)
    const nextSequence = Number.isSafeInteger(parsed.nextSequence) && parsed.nextSequence > 0
      ? parsed.nextSequence
      : items.reduce((max, record) => Math.max(max, record.sequence + 1), 1)
    // A process that died mid-replay left an item `sending`. No caller from that
    // process is left to settle it, so it becomes replayable again with the SAME
    // requestId; the Host's own idempotency makes the retry safe.
    let recovered = false
    for (const record of items) {
      if (record.status !== 'sending') continue
      record.status = 'queued'
      record.nextAt = 0
      record.reason = null
      record.updatedAt = now
      recovered = true
    }
    if (recovered) safeLog('load-recovered-sending')
    if (recovered || items.length !== parsed.items.length || tombstones.length !== parsed.tombstones.length) {
      // A discarded record must also disappear from disk, not just from this
      // instance's memory: the next restart must not bring an expired item back.
      dirtyOnLoad = true
      safeLog('load-pruned')
    }
    return { version: OUTBOX_VERSION, nextSequence, items, tombstones }
  }

  let state = load(nowOf())

  const prepareRoot = () => {
    if (!root || preparedRoot) return Boolean(root)
    preparedRoot = ensureOwnerOnlyDirectory(root)
    return preparedRoot
  }

  // temp + rename: a crash mid-write leaves the previous complete file in place.
  const persist = () => {
    if (!file || !prepareRoot()) { safeLog('persist-unavailable'); return false }
    try {
      const temporary = `${file}.${process.pid}.${crypto.randomBytes(6).toString('hex')}.tmp`
      fs.writeFileSync(temporary, JSON.stringify(state), { mode: SECRET_FILE_MODE })
      restrictToOwnerSync(temporary, 'file')
      fs.renameSync(temporary, file)
      restrictToOwnerSync(file, 'file')
      return true
    } catch (error) {
      safeLog(`persist-failed-${error?.code ?? 'error'}`.replace(/[^A-Za-z0-9-]/g, '-'))
      return false
    }
  }

  if (dirtyOnLoad) { persist(); dirtyOnLoad = false }

  const sweep = (now) => {
    const keptItems = state.items.filter((record) => liveRecord(record, now))
    const keptTombstones = state.tombstones.filter((tombstone) => liveTombstone(tombstone, now)).slice(-bound.maxTerminal)
    if (keptItems.length === state.items.length && keptTombstones.length === state.tombstones.length) return
    state.items = keptItems
    state.tombstones = keptTombstones
    safeLog('expired-pruned')
    persist()
  }

  const view = (record) => {
    const result = {
      key: record.key, hostId: record.hostId, sessionId: record.sessionId, requestId: record.requestId,
      status: record.status, attempts: record.attempts, sequence: record.sequence,
      createdAt: record.createdAt, updatedAt: record.updatedAt, nextAt: record.nextAt,
      // Status-only routing metadata: enough to replay in the original wire form,
      // never the prompt body.
      mode: record.mode, wire: record.wire ?? 'text',
    }
    if (record.reason) result.reason = { code: record.reason.code, at: record.reason.at }
    return result
  }

  const totalBytes = () => state.items.reduce((sum, record) => sum + byteLength(record), 0)

  const addTombstone = (tombstone) => {
    state.tombstones.push(tombstone)
    if (state.tombstones.length > bound.maxTerminal) {
      state.tombstones.splice(0, state.tombstones.length - bound.maxTerminal)
    }
  }

  const refusal = (reason) => ({ status: 'refused', reason, key: null, persisted: true })

  const enqueue = (input) => {
    const now = nowOf()
    sweep(now)
    if (!input || typeof input !== 'object' || Array.isArray(input)) return refusal('bad-input')
    for (const field of Object.keys(input)) if (ATTACHMENT_FIELDS.has(field)) return refusal('attachment-bearing')
    for (const field of Object.keys(input)) if (!ALLOWED_FIELDS.has(field)) return refusal('unsupported-field')

    const { hostId, sessionId, requestId, text } = input
    if (!idPattern(hostId) || !idPattern(sessionId)) return refusal('bad-target')
    // A non-string requestId is refused outright: ids are opaque tokens, never coerced.
    if (typeof requestId !== 'string' || !idPattern(requestId)) return refusal('bad-request-id')
    if (typeof text !== 'string') return refusal('non-text-payload')
    if (text.trim() === '') return refusal('empty-text')
    if (input.mode === 'steer') return refusal('steer-not-queueable')
    const mode = input.mode === undefined ? 'text' : input.mode
    if (typeof mode !== 'string' || !ALLOWED_MODES.has(mode)) return refusal('unsupported-mode')
    const wire = input.wire === undefined ? 'text' : input.wire
    if (!WIRE_FORMS.has(wire)) return refusal('unsupported-wire')
    const createdAt = input.createdAt === undefined ? now : input.createdAt
    if (!Number.isFinite(createdAt) || createdAt <= 0) return refusal('bad-created-at')
    if (now - createdAt > bound.ttlMs) return refusal('expired')

    const key = promptItemKey(hostId, sessionId, requestId)
    const existing = state.items.find((record) => record.key === key)
    if (existing) {
      return { status: existing.status, key, duplicate: true, sequence: existing.sequence, createdAt: existing.createdAt, persisted: true }
    }
    if (state.tombstones.some((tombstone) => tombstone.key === key)) {
      return { status: 'refused', reason: 'already-settled', key, duplicate: true, persisted: true }
    }
    if (state.items.length >= bound.maxItems) return refusal('outbox-full')

    const record = {
      key, hostId, sessionId, requestId, text, mode, wire, status: 'queued',
      sequence: state.nextSequence, createdAt, updatedAt: now, attempts: 0, nextAt: 0, reason: null,
    }
    const bytes = byteLength(record)
    if (bytes > bound.maxItemBytes) return refusal('item-too-large')
    if (totalBytes() + bytes > bound.maxTotalBytes) return refusal('outbox-bytes-full')

    state.nextSequence += 1
    state.items.push(record)
    if (!persist()) {
      // A failed write must not leave a replayable in-memory phantom: the native
      // caller is rejected and no item survives to be replayed after a reload.
      state.items.pop()
      state.nextSequence -= 1
      return refusal('persist-failed')
    }
    return { status: 'queued', key, duplicate: false, sequence: record.sequence, createdAt: record.createdAt, persisted: true }
  }

  /**
   * Status-only descriptors, ordered FIFO by insertion sequence. `text` is not
   * included: this is the Devices page view, not the replay input.
   */
  const list = (hostId, sessionId) => {
    const now = nowOf()
    sweep(now)
    const items = state.items
      .filter((record) => hostId === undefined || record.hostId === hostId)
      .filter((record) => sessionId === undefined || record.sessionId === sessionId)
      .sort((a, b) => a.sequence - b.sequence)
      .map(view)
    return { count: items.length, queuedCount: items.filter((item) => item.status === 'queued').length, items }
  }

  const mark = (hostId, sessionId, requestId, status, detail) => {
    const now = nowOf()
    sweep(now)
    if (!PROMPT_STATUSES.includes(status)) return { ok: false, reason: 'bad-status', persisted: true }
    if (!idPattern(hostId) || !idPattern(sessionId) || typeof requestId !== 'string') {
      return { ok: false, reason: 'bad-target', persisted: true }
    }
    const key = promptItemKey(hostId, sessionId, requestId)
    const index = state.items.findIndex((record) => record.key === key)
    if (index < 0) {
      if (state.tombstones.some((tombstone) => tombstone.key === key)) {
        return { ok: true, status, key, duplicate: true, persisted: true }
      }
      return { ok: false, reason: 'not-found', persisted: true }
    }
    const record = state.items[index]
    if (status === 'queued') {
      record.status = 'queued'
      record.nextAt = 0
      record.reason = null
      record.updatedAt = now
    } else if (status === 'sending') {
      if (record.status !== 'sending') record.attempts += 1
      record.status = 'sending'
      record.updatedAt = now
    } else if (status === 'failed') {
      // Terminal: keep the reason CODE and drop the body, permanently.
      delete record.text
      record.status = 'failed'
      record.reason = { code: reasonCode(detail), at: now }
      record.nextAt = 0
      record.updatedAt = now
    } else {
      // sent / acked / cancelled are settled: remove the item and keep only a
      // bounded opaque tombstone so it can never be replayed or re-queued.
      state.items.splice(index, 1)
      addTombstone({ key, status, at: now })
    }
    return { ok: true, status, key, persisted: persist() }
  }

  /**
   * Claim the oldest UNSETTLED item of one session. A head item in backoff or in
   * flight blocks every later item: replay must never reorder a session's prompts.
   */
  const claimNext = (hostId, sessionId) => {
    const now = nowOf()
    sweep(now)
    if (!idPattern(hostId) || !idPattern(sessionId)) return null
    const record = state.items
      .filter((item) => item.hostId === hostId && item.sessionId === sessionId
        && (item.status === 'queued' || item.status === 'sending'))
      .sort((a, b) => a.sequence - b.sequence)[0]
    if (!record || record.status === 'sending' || record.nextAt > now) return null
    record.status = 'sending'
    record.attempts += 1
    record.updatedAt = now
    record.nextAt = 0
    const persisted = persist()
    // The ONLY result carrying a prompt body: the replay input. No attachments,
    // file receipts or extra fields are ever part of it.
    return {
      ...view(record),
      text: record.text,
      replay: { hostId: record.hostId, sessionId: record.sessionId, requestId: record.requestId, text: record.text },
      persisted,
    }
  }

  /** Transient failure: backoff and re-queue. Permanent failure: terminal, body dropped. */
  const releaseOnFailure = (item, reason) => {
    const now = nowOf()
    sweep(now)
    if (!item || typeof item !== 'object') return { ok: false, reason: 'bad-item', persisted: true }
    const key = typeof item.key === 'string' && KEY_RE.test(item.key) ? item.key
      : idPattern(item.hostId) && idPattern(item.sessionId) && typeof item.requestId === 'string'
        ? promptItemKey(item.hostId, item.sessionId, item.requestId) : null
    if (!key) return { ok: false, reason: 'bad-item', persisted: true }
    const record = state.items.find((entry) => entry.key === key)
    if (!record || record.status !== 'sending') return { ok: false, reason: 'not-claimed', persisted: true }
    const failure = normalizeFailure(reason)
    if (failure.permanent) {
      delete record.text
      record.status = 'failed'
      record.reason = { code: failure.code, at: now }
      record.nextAt = 0
      record.updatedAt = now
      return { ok: true, status: 'failed', key, reason: failure.code, persisted: persist() }
    }
    const backoffMs = Math.min(bound.maxBackoffMs, bound.backoffBaseMs * (2 ** Math.max(0, record.attempts - 1)))
    record.status = 'queued'
    record.nextAt = now + backoffMs
    record.updatedAt = now
    return { ok: true, status: 'queued', key, backoffMs, nextAt: record.nextAt, persisted: persist() }
  }

  /**
   * Forget/revoke: cancel EVERY stored item of one host, including ones with no
   * live waiter (a reload) and ones mid-flight. Tombstones keep them dead across
   * a restart; the returned keys let the router settle its native calls.
   */
  const cancelHost = (hostId) => {
    const now = nowOf()
    sweep(now)
    if (!idPattern(hostId)) return { count: 0, items: [], persisted: true }
    const doomed = state.items.filter((record) => record.hostId === hostId)
    const items = doomed.map((record) => ({ key: record.key, requestId: record.requestId, sessionId: record.sessionId }))
    if (doomed.length === 0) return { count: 0, items, persisted: true }
    state.items = state.items.filter((record) => record.hostId !== hostId)
    for (const record of doomed) addTombstone({ key: record.key, status: 'cancelled', at: now })
    return { count: doomed.length, items, persisted: persist() }
  }

  return {
    dir: root, file, limits: { ...bound },
    enqueue, list, mark, claimNext, releaseOnFailure, cancelHost,
  }
}

export default createPromptOutbox
