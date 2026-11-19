// Spec 042 CPU fix: the per-projection `projection forwarded` diagnostic must
// not run for an idle gateway (clients.size === 0) or for the high-frequency
// subagentTiming key. This is a static guard because driving the background
// control stream needs the full plugin harness; the assertions also pin that
// broadcastProjection and the baseline write stay outside the log guard.
import assert from 'node:assert/strict'
import fs from 'node:fs'
import { test } from 'node:test'

const source = fs.readFileSync(new URL('../lib/index.mjs', import.meta.url), 'utf8')

test('projection forwarded diagnostic is suppressed when idle or subagentTiming', () => {
  assert.match(source, /broadcastProjection\(sessionId, frame\.key, value, frame\.seq\)\s*\n\s*if\s*\(clients\.size\s*>\s*0\s*&&\s*frame\.key\s*!==\s*['"]subagentTiming['"]\)\s*\{/)
  assert.match(source, /if\s*\(clients\.size\s*>\s*0\s*&&\s*frame\.key\s*!==\s*['"]subagentTiming['"]\)\s*\{\s*log\(`projection forwarded: key=\$\{frame\.key\} session=\$\{sessionId\} seq=\$\{frame\.seq\}`\)/)
  assert.equal(source.includes('Object.defineProperty(sessionProjectionBaselines, sessionId,'), true)
})
