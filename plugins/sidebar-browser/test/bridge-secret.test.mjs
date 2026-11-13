/**
 * C1 — the bridge routes require the per-host-start secret, and that secret reaches the
 * page only through the host's own startup row for the owner's Peer.
 */
import test from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { createHost, callRoute, runTool, FULL_HOOKS } from './harness.mjs'
import { __internals } from '../lib/index.js'

const host = () => createHost()

test('the secret is minted per host start and delivered as an owner-only startup row', () => {
  const first = host()
  const second = host()
  const secret = first.bridgeSecret()
  assert.equal(typeof secret, 'string')
  assert.ok(secret.length >= 32, 'secret must be long enough to be unguessable')
  assert.notEqual(secret, second.bridgeSecret(), 'a new host start must mint a new secret')

  const row = first.collectInjections().find((entry) => entry.kind === 'global')
  assert.equal(row.name, __internals.GLOBAL_KEY)
  assert.equal(row.value.secret, secret)
  // The row carries the supported range, which must be the manifest's own engines.dsh (no second copy).
  assert.equal(row.value.dsh, JSON.parse(readFileSync(new URL('../package.json', import.meta.url), 'utf8')).engines.dsh)
})

test('a page rendered for a non-owner Peer never receives the secret', () => {
  const app = host()
  const rows = app.collectInjections({ principal: { kind: 'liveshare-viewer' } })
  assert.deepEqual(rows, [])
})

test('M4: a render that cannot be proven the owner\'s never receives the secret', () => {
  const app = host()
  // Fail closed: only an explicit owner principal gets the row. A missing Peer, a Peer
  // without a principal, or a principal of an unknown shape is not the owner.
  for (const peer of [null, {}, { principal: undefined }, { principal: {} }, { principal: { kind: 'owner-ish' } }, { principal: { kind: 'viewer' } }]) {
    assert.deepEqual(
      app.collectInjections(peer),
      [],
      `peer ${JSON.stringify(peer)} must not receive the bridge secret`,
    )
  }
  assert.equal(app.collectInjections({ principal: { kind: 'owner' } }).length, 1)
  assert.equal(app.collectInjections().length, 1, 'the harness default Peer is the owner')
})

test('poll and reply reject a request with no secret (403)', async () => {
  const app = host()
  for (const handler of [app.poll, app.reply]) {
    const result = await callRoute(handler, { body: {}, secret: undefined })
    assert.equal(result.status, 403)
    assert.deepEqual(result.body, { ok: false, error: 'forbidden' })
  }
})

test('poll and reply reject a wrong or truncated secret (403)', async () => {
  const app = host()
  const secret = app.bridgeSecret()
  for (const candidate of ['', 'wrong', secret.slice(0, -1), `${secret}x`, secret.toUpperCase()]) {
    for (const handler of [app.poll, app.reply]) {
      const result = await callRoute(handler, { body: {}, secret: candidate })
      assert.equal(result.status, 403, `candidate ${JSON.stringify(candidate)} must be refused`)
    }
  }
})

test('the right secret completes a full poll/reply round trip', async () => {
  const app = host()
  const text = await runTool(app, 'internal_browser_tabs', {}, {
    respond: async (op) => {
      assert.equal(op, 'tabs')
      return [{ url: 'https://example.com/', title: 'Example', visible: true }]
    },
  })
  assert.match(text, /1 browser tab\(s\)/)
})

test('non-POST, non-JSON, cross-origin and network peers are refused', async () => {
  const app = host()
  const secret = app.bridgeSecret()
  const attempts = [
    { label: 'GET', options: { method: 'GET', secret } },
    { label: 'form post', options: { secret, headers: { 'content-type': 'application/x-www-form-urlencoded' } } },
    { label: 'cross-origin', options: { secret, headers: { origin: 'https://evil.example' } } },
    { label: 'network peer', options: { secret, remoteAddress: '10.0.0.7' } },
  ]
  for (const { label, options } of attempts) {
    const result = await callRoute(app.poll, { body: {}, ...options })
    assert.equal(result.status, 403, `${label} must be refused`)
  }
  // The same-origin form the app window actually sends is admitted.
  const ok = await callRoute(app.poll, {
    body: { hooks: FULL_HOOKS, waitMs: 25 },
    secret,
    headers: { origin: 'http://127.0.0.1:3080' },
  })
  assert.equal(ok.status, 200)
})
