/**
 * R12 fallback — the owner-authenticated secret route registered on `connection.fetch`.
 *
 * DSH Desktop caches `webserver/index-inject` at Host ready, so a plugin applied later gets
 * no global in an already-open window. The narrow `/api` route is the fallback; DSH admits
 * only owner principals to fetch routes, and the handler repeats that check (fail closed).
 * The four relay routes share the same registry, but are pinned in `route-guard.test.mjs`.
 */

process.env.DSH_CHROME_CDP_ARM_FAKES = '1'

import test from 'node:test'

import assert from 'node:assert/strict'
import { inject, __internals } from '../lib/index.js'
import { relayHost, relaysOf } from './relay-route.test.mjs'

test('R12: the host injects connection and registers the GET secret plus four POST relays', () => {
  assert.ok(inject.includes('connection'), 'connection must be injected so fetch.register exists')
  const host = relayHost()
  assert.equal(host.registrations.size, 5, 'one secret fallback and four relays, all on /api')
  const [route] = [host.registrations.get(__internals.SECRET_ROUTE)]
  assert.equal(route.path, '/api/dsh-chrome-cdp/bridge-secret')
  assert.equal(route.path, __internals.SECRET_ROUTE)
  assert.deepEqual(route.methods, ['GET'])
  assert.equal(route.requestBody, 'buffered')
  assert.equal(typeof route.fetch, 'function')
  for (const relay of relaysOf(host.registrations)) {
    assert.deepEqual(relay.methods, ['POST'])
    assert.equal(relay.requestBody, 'buffered')
    assert.equal(typeof relay.fetch, 'function')
  }
})

test('R12: an owner receives the same secret as the injected row, without caching', async () => {
  const host = relayHost()
  const route = host.registrations.get(__internals.SECRET_ROUTE)
  const request = new Request(`http://127.0.0.1:3080${route.path}`)
  const response = await route.fetch(request, { principal: { kind: 'owner' } })
  assert.equal(response.status, 200)
  assert.equal(response.headers.get('cache-control'), 'no-store')
  assert.match(response.headers.get('content-type'), /application\/json/)
  const body = await response.json()
  assert.equal(typeof body.secret, 'string')
  assert.ok(body.secret.length >= 32, 'the secret stays unguessable')
  assert.equal(body.dsh, __internals.DSH_VERSION)
  const primary = []
  for (const handler of host.injections) handler(primary, { principal: { kind: 'owner' } })
  const row = primary.find((entry) => entry.kind === 'global' && entry.name === __internals.GLOBAL_KEY)
  assert.equal(body.secret, row.value.secret, 'the fallback serves the same per-start secret as the global')
})

test('R12: a peer that is not provably the owner is refused', async () => {
  const host = relayHost()
  const route = host.registrations.get(__internals.SECRET_ROUTE)
  const request = new Request(`http://127.0.0.1:3080${route.path}`)
  for (const peer of [null, {}, { principal: {} }, { principal: { kind: 'owner-ish' } }, { principal: { kind: 'share-viewer' } }]) {
    const response = await route.fetch(request, peer)
    assert.equal(response.status, 403, JSON.stringify(peer))
    assert.equal(await response.text(), 'forbidden')
  }
})
