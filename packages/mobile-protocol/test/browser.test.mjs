// Spec 016 Phase 3 (revision 10) — the first host-initiated request/response on the link.
//
// These frames are the only place where the HOST is the requester, so the validators are
// the wall: an unvalidated `browser-command` would reach a client that then drives a real
// browser, and an unvalidated `browser-result` would feed a tool result back into a turn.
// Every reject path is asserted here, plus the limits the contract pins.
import assert from 'node:assert/strict'
import { test } from 'node:test'

import {
  BROWSER_AGENT_CAPABILITY,
  BROWSER_CLIENT_TYPES,
  BROWSER_COMMAND_ID,
  BROWSER_CONTROL_SCOPE,
  BROWSER_DEADLINE_DEFAULT_MS,
  BROWSER_DEADLINE_MAX_MS,
  BROWSER_ERROR_CODES,
  BROWSER_FRAME_MAX_BYTES,
  BROWSER_HOST_KINDS,
  BROWSER_OPS,
  BROWSER_SCREENSHOT_MAX_BYTES,
  BROWSER_TEXT_MAX_BYTES,
  CAPABILITIES,
  OPTIONAL_CAPABILITIES,
  OPS,
  SCOPE_BY_TYPE,
  SCOPES,
  browserFrameBytes,
  truncateBrowserText,
  validateBrowserCancel,
  validateBrowserCommand,
  validateBrowserResult,
} from '../src/index.mjs'

const command = (overrides = {}) => ({
  kind: 'browser-command',
  commandId: 'cmd-1',
  sessionId: 'sess-1',
  op: 'screenshot',
  args: {},
  ...overrides,
})

// ---------------------------------------------------------------------------
// Surface
// ---------------------------------------------------------------------------

test('revision 10 tables are frozen and unique', () => {
  for (const table of [BROWSER_OPS, BROWSER_HOST_KINDS, BROWSER_CLIENT_TYPES, BROWSER_ERROR_CODES]) {
    assert.equal(Object.isFrozen(table), true)
    assert.equal(new Set(table).size, table.length)
  }
  assert.deepEqual([...BROWSER_HOST_KINDS], ['browser-command', 'browser-cancel'])
  // Both directions carry a cancel; only the client answers, only the host commands.
  assert.deepEqual([...BROWSER_CLIENT_TYPES], ['browser-result', 'browser-cancel'])
  assert.deepEqual([...BROWSER_OPS].sort(),
    ['click', 'close', 'html', 'navigate', 'open', 'press', 'screenshot', 'scroll', 'snapshot', 'tabs', 'text', 'type'])
})

test('revision 10 is additive: no §4 op, no SCOPE_BY_TYPE gate', () => {
  for (const type of [...BROWSER_CLIENT_TYPES, ...BROWSER_HOST_KINDS]) {
    assert.equal(OPS.includes(type), false, `${type} must not join the companion-v1 allowlist`)
    assert.equal(SCOPE_BY_TYPE[type], undefined, `${type} must not be gated by a blanket type gate`)
    assert.equal(Object.values(SCOPE_BY_TYPE).includes('browser:control'), false)
  }
  assert.equal(BROWSER_CONTROL_SCOPE, 'browser:control')
  assert.ok(SCOPES.includes(BROWSER_CONTROL_SCOPE), 'the scope itself already exists (spec 014 C6)')
})

test('the capability is optional, never a required one', () => {
  assert.equal(BROWSER_AGENT_CAPABILITY, 'browser-agent:1')
  assert.ok(OPTIONAL_CAPABILITIES.includes(BROWSER_AGENT_CAPABILITY))
  assert.equal(CAPABILITIES.includes(BROWSER_AGENT_CAPABILITY), false)
})

test('the contract limits are the ones the spec pins', () => {
  assert.equal(BROWSER_FRAME_MAX_BYTES, 1024 * 1024)
  assert.equal(BROWSER_DEADLINE_DEFAULT_MS, 30_000)
  assert.equal(BROWSER_DEADLINE_MAX_MS, 120_000)
  assert.equal(BROWSER_SCREENSHOT_MAX_BYTES, 768 * 1024)
  assert.equal(BROWSER_TEXT_MAX_BYTES, 256 * 1024)
  assert.match(BROWSER_COMMAND_ID.source, /A-Za-z0-9\._-/)
})

// ---------------------------------------------------------------------------
// validateBrowserCommand
// ---------------------------------------------------------------------------

test('a well-formed command validates and defaults args/deadline', () => {
  const verdict = validateBrowserCommand(command({ args: undefined }))
  assert.equal(verdict.ok, true)
  assert.deepEqual(verdict.value, { commandId: 'cmd-1', sessionId: 'sess-1', op: 'screenshot', args: {}, deadlineMs: 30_000 })
  // A blank session id is trimmed, not accepted with whitespace.
  assert.equal(validateBrowserCommand(command({ sessionId: '  sess-1  ' })).value.sessionId, 'sess-1')
})

test('a deadline above the maximum is clamped, not refused', () => {
  assert.equal(validateBrowserCommand(command({ deadlineMs: 10_000_000 })).value.deadlineMs, BROWSER_DEADLINE_MAX_MS)
  assert.equal(validateBrowserCommand(command({ deadlineMs: 5_000 })).value.deadlineMs, 5_000)
})

test('a malformed command is refused with bad-request and never throws', () => {
  const badRequests = [
    null, undefined, 42, 'browser-command', [], new Map(),
    command({ kind: 'browser-result' }),
    { ...command(), kind: undefined },
    command({ commandId: '' }),
    command({ commandId: 'has space' }),
    command({ commandId: 'x'.repeat(65) }),
    command({ commandId: 7 }),
    command({ sessionId: '' }),
    command({ sessionId: '   ' }),
    command({ sessionId: 'x'.repeat(129) }),
    command({ sessionId: 12 }),
    command({ op: 'eval' }), // not a client-side op: never forwarded
    command({ op: 'navigate; rm -rf /' }),
    command({ op: undefined }),
    command({ args: [] }),
    command({ args: 'text' }),
    command({ deadlineMs: 0 }),
    command({ deadlineMs: -1 }),
    command({ deadlineMs: 1.5 }),
    command({ deadlineMs: '30000' }),
  ]
  for (const frame of badRequests) {
    const verdict = validateBrowserCommand(frame)
    assert.equal(verdict.ok, false, `must refuse ${JSON.stringify(frame)}`)
    assert.equal(verdict.code, 'bad-request', `must refuse ${JSON.stringify(frame)} as bad-request`)
    assert.equal(typeof verdict.message, 'string')
  }
})

test('an oversized command is refused with its own code, before a device sees it', () => {
  const verdict = validateBrowserCommand(command({ args: { text: 'x'.repeat(BROWSER_FRAME_MAX_BYTES) } }))
  assert.equal(verdict.ok, false)
  assert.equal(verdict.code, 'browser/frame-too-large')
})

// ---------------------------------------------------------------------------
// validateBrowserResult
// ---------------------------------------------------------------------------

test('a result validates in both shapes', () => {
  const ok = validateBrowserResult({ type: 'browser-result', commandId: 'cmd-1', ok: true, result: { text: 'hi' } })
  assert.deepEqual(ok, { ok: true, value: { commandId: 'cmd-1', ok: true, result: { text: 'hi' } } })
  const failed = validateBrowserResult({ type: 'browser-result', commandId: 'cmd-1', ok: false,
    error: { code: 'browser/denied', message: 'consent is off' } })
  assert.deepEqual(failed, { ok: true, value: { commandId: 'cmd-1', ok: false, error: { code: 'browser/denied', message: 'consent is off' } } })
  // A known code is not the only acceptable one — a client names its own reason.
  assert.equal(validateBrowserResult({ type: 'browser-result', commandId: 'c', ok: false,
    error: { code: 'browser/not-found' } }).value.error.code, 'browser/not-found')
})

test('a malformed result is refused and never throws', () => {
  const bad = [
    null, 'result', 3, [],
    { type: 'browser-command', commandId: 'c', ok: true, result: {} },
    { type: 'browser-result', commandId: '', ok: true, result: {} },
    { type: 'browser-result', commandId: 'c', ok: true },
    { type: 'browser-result', commandId: 'c' },
    { type: 'browser-result', commandId: 'c', ok: 'yes', result: {} },
    { type: 'browser-result', commandId: 'c', ok: false },
    { type: 'browser-result', commandId: 'c', ok: false, error: 'denied' },
    { type: 'browser-result', commandId: 'c', ok: false, error: {} },
    { type: 'browser-result', commandId: 'c', ok: false, error: { code: 'Not A Code' } },
    { type: 'browser-result', commandId: 'c', ok: false, error: { code: '' } },
  ]
  for (const frame of bad) {
    const verdict = validateBrowserResult(frame)
    assert.equal(verdict.ok, false, `must refuse ${JSON.stringify(frame)}`)
    assert.equal(verdict.code, 'bad-request')
  }
})

test('an oversized result (e.g. an unshrunk screenshot) is refused', () => {
  const verdict = validateBrowserResult({ type: 'browser-result', commandId: 'c', ok: true,
    result: { screenshot: 'A'.repeat(BROWSER_FRAME_MAX_BYTES) } })
  assert.equal(verdict.ok, false)
  assert.equal(verdict.code, 'browser/frame-too-large')
})

// ---------------------------------------------------------------------------
// validateBrowserCancel
// ---------------------------------------------------------------------------

test('a cancel is accepted in both directions and normalised', () => {
  assert.deepEqual(validateBrowserCancel({ kind: 'browser-cancel', commandId: 'cmd-1' }),
    { ok: true, value: { commandId: 'cmd-1' } })
  assert.deepEqual(validateBrowserCancel({ type: 'browser-cancel', commandId: 'cmd-1' }),
    { ok: true, value: { commandId: 'cmd-1' } })
})

test('a malformed cancel is refused', () => {
  for (const frame of [null, 'cancel', {}, { kind: 'browser-command', commandId: 'c' },
    { kind: 'browser-cancel' }, { kind: 'browser-cancel', commandId: 'a b' }]) {
    const verdict = validateBrowserCancel(frame)
    assert.equal(verdict.ok, false, `must refuse ${JSON.stringify(frame)}`)
    assert.equal(verdict.code, 'bad-request')
  }
})

// ---------------------------------------------------------------------------
// Frame size and text truncation
// ---------------------------------------------------------------------------

test('browserFrameBytes counts UTF-8 bytes, and is Infinity when unserializable', () => {
  assert.equal(browserFrameBytes({ a: 1 }), 7)
  assert.equal(browserFrameBytes({ a: 'é' }), 10) // 8 ASCII bytes + 2 for é
  const cyclic = {}
  cyclic.self = cyclic
  assert.equal(browserFrameBytes(cyclic), Number.POSITIVE_INFINITY)
  assert.equal(browserFrameBytes(undefined), 0)
})

test('short text passes through untouched', () => {
  assert.deepEqual(truncateBrowserText('hello'), { text: 'hello', truncated: false, bytes: 5 })
  assert.deepEqual(truncateBrowserText(undefined), { text: '', truncated: false, bytes: 0 })
  assert.deepEqual(truncateBrowserText(12), { text: '12', truncated: false, bytes: 2 })
})

test('long text is cut at the byte limit and flagged', () => {
  const long = 'a'.repeat(BROWSER_TEXT_MAX_BYTES + 10)
  const cut = truncateBrowserText(long)
  assert.equal(cut.truncated, true)
  assert.equal(cut.text.length, BROWSER_TEXT_MAX_BYTES)
  assert.equal(cut.bytes, BROWSER_TEXT_MAX_BYTES)
  // Exactly at the limit is not truncation.
  assert.equal(truncateBrowserText('b'.repeat(BROWSER_TEXT_MAX_BYTES)).truncated, false)
})

test('truncation never splits a multi-byte code point', () => {
  // 'é' is two UTF-8 bytes: a 5-byte budget holds two of them, never half of a third.
  const cut = truncateBrowserText('éééé', 5)
  assert.equal(cut.text, 'éé')
  assert.equal(cut.bytes, 4)
  assert.equal(cut.truncated, true)
  // A code point that does not fit at all yields nothing rather than a broken char.
  assert.deepEqual(truncateBrowserText('é', 1), { text: '', truncated: true, bytes: 0 })
  // An astral character (4 bytes) is only kept whole: 4 + 'a' fits a 5-byte budget.
  assert.equal(truncateBrowserText('𝄞ab', 5).text, '𝄞a')
})
