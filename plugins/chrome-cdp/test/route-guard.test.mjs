/**
 * R12 — the four sidebar relay routes now live on DSH's owner-authenticated `/api` fetch
 * registry. The core owns principal + Host/Origin trust; this plugin still repeats the owner
 * check, requires a JSON POST and the per-start secret, and never caches an answer.
 */

process.env.DSH_CHROME_CDP_ARM_FAKES = '1'

import test from 'node:test'

import assert from 'node:assert/strict'
import { secretMatches, __internals } from '../lib/index.js'
import { relayHost, relaysOf, callRelay } from './relay-route.test.mjs'

const ROUTES = ['tabs', 'shot', 'input', 'nav']

const ownerRow = (host) => {
  const table = []
  for (const handler of host.injections) handler(table, { principal: { kind: 'owner' } })
  return table.find((entry) => entry.kind === 'global')
}

test('R12: four POST relay routes join the secret route on the /api fetch registry', () => {
  const host = relayHost()
  assert.equal(__internals.BRIDGE_PREFIX, '/api/dsh-chrome-cdp')
  assert.deepEqual([...host.registrations.keys()].sort(), [
    ...ROUTES.map((route) => `${__internals.BRIDGE_PREFIX}/${route}`),
    __internals.SECRET_ROUTE,
  ].sort())
  for (const route of relaysOf(host.registrations)) {
    assert.deepEqual(route.methods, ['POST'])
    assert.equal(route.requestBody, 'buffered')
    assert.equal(typeof route.fetch, 'function')
  }
  assert.deepEqual(host.registrations.get(__internals.SECRET_ROUTE).methods, ['GET'], 'the fallback stays a GET')
  assert.ok([...host.registrations.keys()].every((path) => path.startsWith('/api/')), 'no exact webServer mount survives')
})

test('R12: the secret is minted per start and delivered as an owner-only startup row', () => {
  const first = relayHost()
  const second = relayHost()
  assert.equal(typeof first.secret, 'string')
  assert.ok(first.secret.length >= 32, 'the secret must be long enough to be unguessable')
  assert.notEqual(first.secret, second.secret, 'a new start mints a new secret')

  const row = ownerRow(first)
  assert.equal(row.name, __internals.GLOBAL_KEY)
  assert.equal(row.name, '__DSH_CHROME_CDP__')
  assert.equal(row.value.secret, first.secret)
  assert.equal(row.value.dsh, __internals.DSH_VERSION)
})

test('R12: a render that is not provably the owner never receives the secret', () => {
  const host = relayHost()
  for (const peer of [null, {}, { principal: undefined }, { principal: {} }, { principal: { kind: 'owner-ish' } }, { principal: { kind: 'share-viewer' } }]) {
    const table = []
    for (const handler of host.injections) handler(table, peer)
    assert.deepEqual(table, [], `peer ${JSON.stringify(peer)} must not receive the secret`)
  }
  assert.equal(ownerRow(host).value.secret, host.secret)
})

test('R12: every relay refuses a missing, wrong or non-owner request with 403 JSON', async () => {
  const host = relayHost()
  for (const route of relaysOf(host.registrations)) {
    const none = await callRelay(route, {})
    assert.equal(none.status, 403, route.path)
    assert.deepEqual(none.body, { ok: false, error: 'forbidden' }, route.path)
    for (const candidate of ['', 'wrong', host.secret.slice(0, -1), `${host.secret}x`]) {
      const refused = await callRelay(route, { secret: candidate })
      assert.equal(refused.status, 403, `${route.path} with ${JSON.stringify(candidate)}`)
      assert.deepEqual(refused.body, { ok: false, error: 'forbidden' })
    }
    const stranger = await callRelay(route, { secret: host.secret, peer: { principal: { kind: 'share-viewer' } } })
    assert.equal(stranger.status, 403, `${route.path} must repeat the owner check`)
    assert.deepEqual(stranger.body, { ok: false, error: 'forbidden' })
  }
})

test('R12: non-POST and non-JSON requests are refused before any work runs', async () => {
  const host = relayHost()
  const attempts = [
    { label: 'GET', options: { method: 'GET', secret: host.secret } },
    { label: 'form post', options: { secret: host.secret, headers: { 'content-type': 'application/x-www-form-urlencoded' } } },
    { label: 'no content type', options: { secret: host.secret, headers: { 'content-type': '' } } },
  ]
  for (const { label, options } of attempts) {
    const result = await callRelay(relaysOf(host.registrations)[0], options)
    assert.equal(result.status, 403, `${label} must be refused`)
    assert.deepEqual(result.body, { ok: false, error: 'forbidden' })
  }
})

test('R12: malformed and oversized JSON bodies are refused with 400', async () => {
  const host = relayHost()
  const route = relaysOf(host.registrations)[1]
  const malformed = await callRelay(route, { secret: host.secret, rawBody: 'not json at all' })
  assert.equal(malformed.status, 400)
  assert.deepEqual(malformed.body, { ok: false, error: 'bad-request' })
  const oversized = await callRelay(route, { secret: host.secret, rawBody: 'x'.repeat(__internals.MAX_BRIDGE_BODY + 1) })
  assert.equal(oversized.status, 400)
  assert.deepEqual(oversized.body, { ok: false, error: 'bad-request' })
})

test('R12: a successful work answer is {ok:true,value} with no-store; work errors stay 200', async () => {
  const state = { cdp: { listTargets: async () => [{ id: 'T1' }] }, endpoint: { url: 'http://127.0.0.1:40222' } }
  const routes = __internals.createBridgeRoutes(state, 'secret')
  const request = () => new Request(`http://127.0.0.1:3080${__internals.BRIDGE_PREFIX}/tabs`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', [__internals.SECRET_HEADER]: 'secret' },
    body: '{}',
  })
  const ok = await routes.tabs(request(), { principal: { kind: 'owner' } })
  assert.equal(ok.status, 200)
  assert.equal(ok.headers.get('cache-control'), 'no-store')
  assert.deepEqual(await ok.json(), { ok: true, value: { tabs: [{ id: 'T1' }], host: __internals.executionHost(), endpoint: 'http://127.0.0.1:40222' } })

  const broken = __internals.createBridgeRoutes({ cdp: { listTargets: async () => { throw new Error('chrome said no') } } }, 'secret')
  const failed = await broken.tabs(request(), { principal: { kind: 'owner' } })
  assert.equal(failed.status, 200)
  assert.deepEqual(await failed.json(), { ok: false, error: 'chrome said no' })
})

test('the secret comparison is exact and refuses every non-string candidate', () => {
  assert.equal(secretMatches('abc', 'abc'), true)
  assert.equal(secretMatches('abc', 'abd'), false)
  assert.equal(secretMatches('abc', 'abcd'), false)
  assert.equal(secretMatches('abc', undefined), false)
  assert.equal(secretMatches('abc', ['abc']), false, 'an array header value is not the secret')
  assert.equal(secretMatches('long-secret-value', 'long-secret-value'), true)
})
