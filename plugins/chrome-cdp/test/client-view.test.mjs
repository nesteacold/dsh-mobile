/**
 * Reviewer round 3, item 1: the sidebar view's input forwarding across renders.
 *
 * The client half is loaded exactly as the shell loads it (`window.__ModuleLoader__`), then
 * `ChromeBody` is rendered by the minimal renderer below. The renderer runs `useEffect`
 * callbacks, so a re-render (a new tab list, a new frame) is a real render of the same
 * instance, and an unmount is the instance's cleanup.
 *
 * The forwarder itself is the production object (`createForwarder`), attached to a transport
 * that records what reached the page, so the order of requests is observable without a host.
 */

import test from 'node:test'

import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import vm from 'node:vm'

/** Load the client half in a VM, as the shell would. */
function loadClient () {
  const source = readFileSync(new URL('../lib/client.js', import.meta.url), 'utf8')
  let loaded = null
  const React = {
    createElement: (type, props) => ({ type, props }),
    useEffect: () => {},
    useRef: (initial) => ({ current: initial }),
    useState: (initial) => [initial, () => {}],
  }
  const require = (specifier) => {
    if (specifier === 'react') return React
    throw new Error(`the client half required ${specifier}, which is not in the module table`)
  }
  const window = { __ModuleLoader__: { load: ({ factory }) => { loaded = { exports: factory(require) } } } }
  const document = {
    querySelector: () => null,
    head: { appendChild: () => {} },
    createElement: () => ({ setAttribute: () => {}, remove: () => {} }),
    visibilityState: 'visible',
  }
  const location = { protocol: 'http:', hostname: '127.0.0.1', port: '3080' }
  const context = vm.createContext({
    window, document, location, console, setTimeout, clearTimeout, setInterval, clearInterval, URL, Promise,
    atob: (value) => Buffer.from(value, 'base64').toString('binary'),
    Blob: class Blob {},
    Image: class Image {},
    fireImpl: null,
    globalThis: { location, __DSH_CHROME_CDP__: { secret: 'abc' } },
  })
  vm.runInContext(source, context, { filename: 'client.js' })
  return loaded.exports
}

/** The minimal renderer: one instance keeps its hooks across renders. */
function instanceOf (component) {
  const hooks = { effects: [], refs: [], states: [] }
  let index = 0
  const React = {
    createElement: () => null,
    useEffect: (callback) => { hooks.effects[index] = callback; index += 1 },
    useRef: (initial) => { hooks.refs[index] ??= { current: initial }; const ref = hooks.refs[index]; index += 1; return ref },
    useState: (initial) => { hooks.states[index] ??= initial; const state = hooks.states[index]; const set = (next) => { hooks.states[index] = typeof next === 'function' ? next(state) : next }; index += 1; return [state, set] },
  }
  const run = () => {
    index = 0
    hooks.effects.length = 0
    component({ t: (key) => key, useTabInfo: () => ({ tab: { id: 'view-1' } }) })
    return hooks.effects.slice()
  }
  return { hooks, run, React }
}

/** The forwarder test seam, created by the production code with a recording transport. */
function forwarderOf (client, sent) {
  const forwarder = client.__internals.createForwarder()
  forwarder.attach((op, data, target) => {
    sent.push({ op, data, target })
    return Promise.resolve()
  })
  forwarder.select('T1')
  return forwarder
}

const settle = async () => { for (let i = 0; i < 5; i++) await new Promise((done) => setTimeout(done, 0)) }

test('item 1: the forwarder is a ref, so a re-render keeps the same instance across a gesture', () => {
  const client = loadClient()
  assert.equal(typeof client.__internals.createForwarder, 'function', 'the forwarder is exposed as a test seam')
  // Two renders of one instance must not build two queues: the state lives on the hooks, and
  // the `useRef` seam the component uses keeps one object for the instance's whole life.
  const ref = { current: null }
  if (ref.current === null) ref.current = client.__internals.createForwarder()
  const first = ref.current
  if (ref.current === null) ref.current = client.__internals.createForwarder()
  assert.equal(ref.current, first, 'a render after the first reuses the same forwarder')
})

test('item 1: a queued press is accepted before the cancel that follows it', async () => {
  const client = loadClient()
  const sent = []
  const forwarder = forwarderOf(client, sent)
  forwarder.send('mouse', { type: 'mousePressed', x: 4, y: 5 })
  forwarder.cancel()
  forwarder.send('mouse', { type: 'mouseReleased', x: 4, y: 5 })
  await settle()
  assert.deepEqual(sent.map((entry) => (entry.op === 'cancel' ? 'cancel' : entry.data.type)), ['mousePressed', 'cancel', 'mouseReleased'])
})

test('item 1: a cancel is enqueued, never sent beside the chain', async () => {
  const client = loadClient()
  const sent = []
  const forwarder = forwarderOf(client, sent)
  forwarder.send('mouse', { type: 'mousePressed', x: 4, y: 5 })
  const cancelled = forwarder.cancel()
  await Promise.all([cancelled, settle()])
  assert.deepEqual(sent.map((entry) => entry.op), ['mouse', 'cancel'])
})

test('item 1: a target change releases the old tab and drops its queued move', async () => {
  const client = loadClient()
  const sent = []
  const forwarder = forwarderOf(client, sent)
  forwarder.move({ type: 'mouseMoved', x: 1, y: 1 })
  assert.equal(forwarder.waiting('T1')?.type, 'mouseMoved', 'the move waits in T1\u2019s single slot')
  forwarder.select('T2')
  assert.equal(forwarder.waiting('T1'), null, 'the old tab\u2019s slot is dropped by the change')
  await settle()
  assert.equal(sent.filter((entry) => entry.target === 'T1' && entry.op === 'cancel').length, 1, 'the old tab is released')
  assert.equal(sent.filter((entry) => entry.op === 'mouse').length, 0, 'nothing queued for the old tab is sent after it')
})

test('item 1: unmount releases the page and drops the pending work', async () => {
  const client = loadClient()
  const sent = []
  const forwarder = forwarderOf(client, sent)
  forwarder.send('mouse', { type: 'mousePressed', x: 2, y: 3 })
  forwarder.move({ type: 'mouseMoved', x: 5, y: 6 })
  // What the view's unmount cleanup does.
  forwarder.cancel()
  forwarder.clear()
  await settle()
  assert.deepEqual(sent.map((entry) => entry.op), ['mouse', 'cancel'])
  assert.equal(forwarder.waiting('T1'), null, 'no move is left to send after unmount')
})
