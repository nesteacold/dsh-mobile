import test from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import vm from 'node:vm'
import { percent, band, clickDecision, isBusy } from '../lib/logic.mjs'
import { buildClient } from '../scripts/build.mjs'

test('percent uses projected tokens, falls back, rounds and caps', () => {
  assert.equal(percent({ projectedTokens: 395, pressureTokens: 800, contextWindow: 1000 }), 40)
  assert.equal(percent({ projectedTokens: 0, pressureTokens: 800, contextWindow: 1000 }), 0)
  assert.equal(percent({ projectedTokens: null, pressureTokens: 700, contextWindow: 1000 }), 70)
  assert.equal(percent({ pressureTokens: 2000, contextWindow: 1000 }), 100)
  for (const p of [undefined, {}, { pressureTokens: 1 }, { contextWindow: 100 },
    { pressureTokens: 1, contextWindow: 0 }, { pressureTokens: NaN, contextWindow: 100 },
    { pressureTokens: -1, contextWindow: 100 }]) assert.equal(percent(p), null)
})

test('colour boundaries and click decisions', () => {
  for (const [value, expected] of [[0, 'neutral'], [39, 'neutral'], [40, 'orange'], [69, 'orange'], [70, 'red'], [100, 'red']]) {
    assert.equal(band(value), expected)
  }
  assert.equal(clickDecision('', false), 'submit')
  for (const draft of ['hello', ' ', '/compact']) assert.equal(clickDecision(draft, false), 'refuse')
  assert.equal(clickDecision('', true), 'disabled')
  assert.equal(clickDecision('hello', true), 'disabled')
  assert.equal(clickDecision(undefined, false), 'disabled')
})

test('only known idle status and empty plain input permit compaction', () => {
  const input = { phase: 'plain', attachmentIds: [] }
  assert.equal(isBusy({ running: false }, input), false)
  for (const status of [undefined, {}, { running: true }, { running: false, pendingInteraction: {} }]) {
    assert.equal(isBusy(status, input), true)
  }
  for (const other of [undefined, {}, { ...input, phase: 'sending' }, { ...input, attachmentIds: ['file'] }]) {
    assert.equal(isBusy({ running: false }, other), true)
  }
})

const client = readFileSync(new URL('../lib/client.js', import.meta.url), 'utf8')
test('shipped client matches source logic and locale JSON', () => assert.equal(client, buildClient()))

function harness({ draft = '', running = false, language = 'en', pressure = { pressureTokens: 400, contextWindow: 1000 } } = {}) {
  let plugin, Component
  const calls = [], notices = []
  const React = {
    createElement: (type, props, ...children) => ({ type, props, children }),
    useSyncExternalStore: (_subscribe, snapshot) => snapshot(),
    useState: () => [false, value => notices.push(value)], useEffect() {},
  }
  vm.runInNewContext(client, { window: { __ModuleLoader__: { load(bundle) {
    assert.equal(bundle.id, '@dsh-ext/compact-button')
    plugin = bundle.factory(name => { assert.equal(name, 'react'); return React })
  } } } })
  plugin.apply({
    locale: { subscribe: () => () => {}, getSnapshot: () => ({ active: language }) },
    slots: {
      inject(slot, callback) { assert.equal(slot, 'conversation.composer.dock'); callback() },
      register(options, component) {
        assert.equal(options.id, 'dsh-ext-compact-button'); assert.equal(options.order, 5)
        assert.equal(options.name, 'conversation.composer.dock'); Component = component
      },
    },
  })
  const props = {
    sessionId: 'h:remote:session', useProjection: key => { assert.equal(key, 'contextPressure'); return pressure },
    useInput: select => select({ draft, phase: 'plain', attachmentIds: [] }),
    useSessionStatus: select => select(new Map([['h:remote:session', { running }]])),
    inputActions: { setDraft: text => calls.push(['setDraft', text]), submit: () => calls.push(['submit']) },
  }
  return { render: () => Component(props), props, calls, notices }
}

test('dock component submits via supplied session composer in order', () => {
  const h = harness(), button = h.render().children[0]
  assert.equal(button.props.title, 'Context 40%, click to compact')
  assert.match(button.props.style.color, /orange/)
  assert.equal(button.props.disabled, false)
  button.props.onClick()
  assert.deepEqual(h.calls, [['setDraft', '/compact'], ['submit']])
})

test('component preserves drafts, disables busy or unavailable actions, hides absent pressure', () => {
  const draft = harness({ draft: 'keep me' })
  draft.render().children[0].props.onClick()
  assert.deepEqual(draft.calls, []); assert.deepEqual(draft.notices, [true])
  const busy = harness({ running: true }), button = busy.render().children[0]
  assert.equal(button.props.disabled, true); button.props.onClick(); assert.deepEqual(busy.calls, [])
  const missing = harness(); missing.props.inputActions = undefined
  assert.equal(missing.render().children[0].props.disabled, true)
  assert.equal(harness({ pressure: null }).render(), null)
  assert.match(harness({ language: 'vi-VN' }).render().children[0].props.title, /Ngữ cảnh 40%/)
})
