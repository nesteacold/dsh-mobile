/**
 * R12 client fallback — the injected global stays primary; only a missing one asks the
 * owner-authenticated route, once, in memory. A failed attempt keeps the bridge closed and
 * is never retried on every post. R14 still refuses a remote window.
 */

import test from 'node:test'

import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import vm from 'node:vm'

/** Load the client half exactly as the shell does, with a fake fetch and document. */
function loadClient ({
  injected,
  baseURI = 'http://127.0.0.1:3080/',
  hostname = '127.0.0.1',
  protocol = 'http:',
  fetchImpl = () => { throw new Error('no fetch was provided') },
  react,
} = {}) {
  const source = readFileSync(new URL('../lib/client.js', import.meta.url), 'utf8')
  let loaded = null
  const React = react ?? {
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
  const location = { protocol, hostname, port: '3080' }
  const document = {
    baseURI,
    visibilityState: 'visible',
    querySelector: () => null,
    head: { appendChild: () => {} },
    createElement: () => ({ setAttribute: () => {}, remove: () => {} }),
  }
  const context = vm.createContext({
    window, document, location, console, setTimeout, clearTimeout, setInterval, clearInterval,
    URL, Promise, AbortController, fetch: fetchImpl,
    atob: (value) => Buffer.from(value, 'base64').toString('binary'),
    Blob: class Blob {},
    Image: class Image {},
    globalThis: { location, __DSH_CHROME_CDP__: injected },
  })
  vm.runInContext(source, context, { filename: 'client.js' })
  assert.notEqual(loaded, null, 'the client half registered through window.__ModuleLoader__')
  return loaded.exports.__internals
}

/** A fake host answer for one bridge POST. */
const okPost = { ok: true, json: async () => ({ ok: true, value: { tabs: [] } }) }

test('R12: the injected global stays primary and asks no secret route', async () => {
  const calls = []
  const client = loadClient({
    injected: { secret: 'global-secret' },
    fetchImpl: async (url, init) => { calls.push({ url, init }); return okPost },
  })
  assert.equal(await client.resolveBridgeSecret(), 'global-secret')
  await client.post('tabs', {})
  assert.equal(calls.length, 1, 'only the relay POST happened')
  assert.equal(calls[0].url, 'http://127.0.0.1:3080/api/dsh-chrome-cdp/tabs')
  assert.equal(calls[0].init.headers[client.SECRET_HEADER], 'global-secret')
})

test('R12: relay URLs are relative to document.baseURI, never an absolute root path', async () => {
  const calls = []
  const client = loadClient({
    injected: { secret: 'global-secret' },
    baseURI: 'http://127.0.0.1:3080/app/',
    fetchImpl: async (url, init) => { calls.push(String(url)); return okPost },
  })
  assert.equal(client.PREFIX, 'api/dsh-chrome-cdp')
  assert.equal(client.PREFIX.startsWith('/'), false, 'the prefix is relative like the secret fallback')
  await client.post('tabs', {})
  assert.deepEqual(calls, ['http://127.0.0.1:3080/app/api/dsh-chrome-cdp/tabs'])
})

test('R12: no global but a valid owner response yields a secret used by bridge posts', async () => {
  const calls = []
  const fetchImpl = async (url, init) => {
    calls.push({ url: String(url), init })
    if (url === 'http://127.0.0.1:3080/api/dsh-chrome-cdp/bridge-secret') {
      return { ok: true, json: async () => ({ secret: 'fallback-secret', dsh: '>=0.2.2-rc.3 <0.3.0-0' }) }
    }
    return okPost
  }
  const client = loadClient({ fetchImpl })
  assert.equal(await client.resolveBridgeSecret(), 'fallback-secret')
  assert.equal(await client.resolveBridgeSecret(), 'fallback-secret', 'a second resolve reuses the cached value')
  await client.post('shot', { targetId: 'T1' })
  const secretCalls = calls.filter((call) => call.url.endsWith('/api/dsh-chrome-cdp/bridge-secret'))
  assert.equal(secretCalls.length, 1, 'the owner route is asked once per window, not once per post')
  assert.equal(secretCalls[0].init.credentials, 'same-origin')
  assert.equal(secretCalls[0].init.cache, 'no-store')
  assert.ok(secretCalls[0].init.signal, 'the secret fetch has the same abort discipline as post')
  const relay = calls.filter((call) => call.url === 'http://127.0.0.1:3080/api/dsh-chrome-cdp/shot')
  assert.equal(relay.length, 1)
  assert.equal(relay[0].init.headers[client.SECRET_HEADER], 'fallback-secret')
  assert.equal(client.bridgeSecret(), null, 'the secret is never exposed as the page global')
  assert.equal(client.cachedSecret(), 'fallback-secret')
})

test('R12: malformed or failed answers leave the bridge closed', async () => {
  const bodies = [
    { ok: true, json: async () => ({ secret: '', dsh: 'x' }) },
    { ok: true, json: async () => ({ secret: 'abc' }) },
    { ok: true, json: async () => ({ secret: 'abc', dsh: 1 }) },
    { ok: false, status: 403, json: async () => ({ error: 'forbidden' }) },
  ]
  for (const answer of bodies) {
    let count = 0
    const client = loadClient({
      fetchImpl: async () => { count += 1; return answer },
    })
    assert.equal(await client.resolveBridgeSecret(), null)
    await assert.rejects(client.post('tabs', {}), /no-bridge-secret/)
    assert.equal(await client.resolveBridgeSecret(), null)
    assert.equal(count, 1, 'a failure is cached too; posts never retry the owner route')
  }
  let count = 0
  const client = loadClient({
    fetchImpl: async () => { count += 1; throw new Error('offline') },
  })
  assert.equal(await client.resolveBridgeSecret(), null)
  await assert.rejects(client.post('tabs', {}), /no-bridge-secret/)
  assert.equal(count, 1, 'a thrown fetch is not retried on every post')
})

/** A minimal renderer whose hooks survive re-renders, so the view's own gate can be tested. */
function statefulRenderer () {
  const states = []
  const refs = []
  let index = 0
  let effects = []
  const React = {
    createElement: (type, props, ...children) => ({ type, props, children }),
    useEffect: (callback) => { effects.push(callback); index += 1 },
    useRef: (initial) => { refs[index] ??= { current: initial }; const ref = refs[index]; index += 1; return ref },
    useState: (initial) => {
      states[index] ??= initial
      const at = index
      const set = (next) => { states[at] = typeof next === 'function' ? next(states[at]) : next }
      index += 1
      return [states[at], set]
    },
  }
  const render = (component, props) => {
    index = 0
    effects = []
    const tree = component(props)
    return { tree, effects: effects.slice() }
  }
  return { React, render }
}

/** The types and text a rendered view contains. */
const contents = (node, found = { types: [], text: [] }) => {
  if (node === null || typeof node !== 'object') {
    if (typeof node === 'string') found.text.push(node)
    return found
  }
  found.types.push(node.type)
  for (const child of node.children ?? []) contents(child, found)
  for (const child of Object.values(node.props ?? {})) {
    if (typeof child === 'string') found.text.push(child)
  }
  return found
}

const settle = async () => { for (let i = 0; i < 5; i++) await new Promise((done) => setTimeout(done, 0)) }

test('R12: the view opens after a successful fallback and stays closed after a failed one', async () => {
  const props = { t: (key) => `${key}!`, useTabInfo: () => ({ tab: { id: 'T1' } }) }
  const succeed = statefulRenderer()
  const good = loadClient({
    react: succeed.React,
    fetchImpl: async () => ({ ok: true, json: async () => ({ secret: 'fallback-secret', dsh: 'x' }) }),
  })
  const first = succeed.render(good.ChromeBody, props)
  assert.equal(contents(first.tree).text.includes('view.noSecret!'), true, 'the view starts closed')
  const stop = first.effects[0]() // the secret effect only: no tab-list interval is started
  await settle()
  const opened = succeed.render(good.ChromeBody, props)
  assert.equal(contents(opened.tree).types.includes('canvas'), true, 'the view opens once the owner route answered')
  assert.equal(contents(opened.tree).text.includes('view.noSecret!'), false)
  if (typeof stop === 'function') stop()

  const fail = statefulRenderer()
  const bad = loadClient({ react: fail.React, fetchImpl: async () => { throw new Error('offline') } })
  const closed = fail.render(bad.ChromeBody, props)
  const stopClosed = closed.effects[0]()
  await settle()
  const stillClosed = fail.render(bad.ChromeBody, props)
  assert.equal(contents(stillClosed.tree).text.includes('view.noSecret!'), true, 'a failed fetch leaves the notice in place')
  assert.equal(contents(stillClosed.tree).types.includes('canvas'), false)
  if (typeof stopClosed === 'function') stopClosed()
})

test('R14: a remote window never asks for the secret, even without a global', async () => {
  let count = 0
  const client = loadClient({
    hostname: 'host.example.ts.net',
    protocol: 'https:',
    fetchImpl: async () => { count += 1; return { ok: true, json: async () => ({ secret: 'nope', dsh: 'x' }) } },
  })
  assert.equal(await client.resolveBridgeSecret(), null)
  await assert.rejects(client.post('tabs', {}), /no-bridge-secret/)
  assert.equal(count, 0, 'a remote viewer stays blocked without touching the owner route')
})
