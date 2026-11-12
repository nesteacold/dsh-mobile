import assert from 'node:assert/strict'
import { test } from 'node:test'
import { handleQuery } from '../lib/index.mjs'

// Spec 018 (view only): the device `sessions` reply carries the session's agent preset as a
// plain ID from projections.values.agentPreset; anything outside the ID charset is omitted.
const list = async items => handleQuery({ sessions: { list: async () => ({ items }) } }, null, null, { type: 'sessions' })

test('a valid preset ID reaches the device', async () => {
  const frame = await list([{ sessionId: 's1', projections: { asOfSeq: 4, values: {
    title: '排查网关', agentPreset: 'standard', todos: [{ content: 'x' }],
  } } }])
  assert.deepEqual(frame, {
    kind: 'sessions',
    items: [{ sessionId: 's1', projections: { asOfSeq: 4, values: { title: '排查网关', agentPreset: 'standard' } } }],
  })
})

test('a preset ID travels without a title', async () => {
  const frame = await list([{ sessionId: 's1', projections: { values: { agentPreset: 'team:build.v2' } } }])
  assert.deepEqual(frame.items[0].projections, { values: { agentPreset: 'team:build.v2' } })
})

test('non-ID values are omitted, never shown or coerced', async () => {
  for (const agentPreset of [null, undefined, 1, true, {}, [], '',
    'x'.repeat(65), 'C:\\x', '../a', '/etc', 'a/b', 'p q', 'standard\n']) {
    const frame = await list([{ sessionId: 's1', projections: { asOfSeq: 2, values: {
      title: 't', agentPreset, turnOutline: [],
    } } }])
    assert.deepEqual(frame.items[0].projections,
      { asOfSeq: 2, values: { title: 't' } }, `agentPreset ${JSON.stringify(agentPreset)} must be omitted`)
  }
})

test('the Host list record is not mutated', async () => {
  const source = { items: [{ sessionId: 's1', projections: { asOfSeq: 1, values: {
    title: 't', agentPreset: 'minimal', agentPresetRaw: 'yaml: x', broken: 'missing plugin',
  } } }] }
  const original = JSON.stringify(source)
  await list(source.items)
  assert.equal(JSON.stringify(source), original)
})
