/**
 * C6 — a session whose origin cannot be determined is treated as remote, so browser
 * tools need the `browser:control` scope. This pins the in-plugin hook and the exact
 * gateway-side contract the rest of the product has to satisfy.
 */
import test from 'node:test'
import assert from 'node:assert/strict'
import { createHost } from './harness.mjs'
import { BROWSER_CONTROL_SCOPE, REMOTE_SESSION_SERVICE, remoteScopeOf } from '../lib/remote-scope.js'

const exec = { name: 'internal_browser_snapshot', agent: { session: {} }, callId: 'call-1' }

test('with no signal at all the session is treated as remote', () => {
  const scope = remoteScopeOf({})
  assert.equal(scope.driven, 'unknown')
  assert.equal(scope.allowed, false)
  assert.match(scope.reason, /treated as remote/)
  assert.match(scope.reason, /browser:control/)
  assert.match(scope.reason, /grantedScopes/)
})

test('the local owner can declare its sessions local through grantedScopes', () => {
  const scope = remoteScopeOf({ grantedScopes: [BROWSER_CONTROL_SCOPE] })
  assert.equal(scope.allowed, true)
  assert.equal(scope.reason, null)
})

test('a swapped or throwing gateway policy never becomes permission', () => {
  const throwing = remoteScopeOf({
    get: (key) => (key === REMOTE_SESSION_SERVICE ? { describe: () => { throw new Error('boom') } } : undefined),
    agent: { session: {} },
  })
  assert.equal(throwing.allowed, false)

  const garbage = remoteScopeOf({
    get: (key) => (key === REMOTE_SESSION_SERVICE ? { describe: () => ({ driven: 'maybe' }) } : undefined),
    agent: { session: {} },
  })
  assert.equal(garbage.allowed, false)
})

test('the gateway contract decides local and remote sessions', () => {
  const describe = (answer) => ({
    get: (key) => (key === REMOTE_SESSION_SERVICE ? { describe: () => answer } : undefined),
    agent: { session: { id: 's1' } },
  })

  assert.deepEqual(
    (({ driven, allowed }) => ({ driven, allowed }))(remoteScopeOf(describe({ driven: 'local' }))),
    { driven: 'local', allowed: true },
  )

  const remoteNoScope = remoteScopeOf(describe({ driven: 'remote', scopes: [] }))
  assert.equal(remoteNoScope.allowed, false)
  assert.match(remoteNoScope.reason, /driven by a remote device/)

  const remoteWithScope = remoteScopeOf(describe({ driven: 'remote', scopes: [BROWSER_CONTROL_SCOPE] }))
  assert.equal(remoteWithScope.allowed, true)
})

test('M1: a remote-driven session is decided by the gateway scopes alone', async () => {
  // grantedScopes is the local owner's statement about unknown-origin sessions; it must
  // never widen what a paired device the gateway reports as remote may do.
  const remote = remoteScopeOf({
    get: (key) => (key === REMOTE_SESSION_SERVICE ? { describe: () => ({ driven: 'remote', scopes: [] }) } : undefined),
    agent: { session: { id: 's1' } },
    grantedScopes: [BROWSER_CONTROL_SCOPE],
  })
  assert.equal(remote.driven, 'remote')
  assert.equal(remote.allowed, false)
  assert.match(remote.reason, /driven by a remote device/)

  // The same through a mounted plugin: the tool refuses even with the local grant set.
  const host = createHost({
    config: { grantedScopes: [BROWSER_CONTROL_SCOPE] },
    remoteSessionScope: { describe: () => ({ driven: 'remote', scopes: [] }) },
  })
  await assert.rejects(
    () => host.tools.get('internal_browser_snapshot').execute({}, exec),
    /driven by a remote device/,
  )

  // The gateway's own grant is the one that opens it — and a grant without a mounted
  // `remoteBrowser` service is refused, never driven on this Host's sidebar tab (M1).
  const allowed = createHost({
    config: { grantedScopes: [] },
    remoteSessionScope: { describe: () => ({ driven: 'remote', scopes: [BROWSER_CONTROL_SCOPE] }) },
  })
  await assert.rejects(
    () => allowed.tools.get('internal_browser_snapshot').execute({}, exec),
    /no "remoteBrowser" service/,
  )
})

test('without the scope the tools refuse with the precise reason and nothing runs', async () => {
  const host = createHost({ config: { grantedScopes: [] } })
  await assert.rejects(
    () => host.tools.get('internal_browser_snapshot').execute({}, exec),
    (error) => {
      assert.match(error.message, /the origin of this session cannot be determined/)
      assert.match(error.message, /grantedScopes/)
      return true
    },
  )
})

test('a local session reported by the gateway needs no scope', async () => {
  const host = createHost({
    config: { grantedScopes: [] },
    remoteSessionScope: { describe: () => ({ driven: 'local' }) },
  })
  // The gate passes; the call then stops at the missing window, which proves the C6
  // check did not refuse it.
  await assert.rejects(
    () => host.tools.get('internal_browser_snapshot').execute({}, exec),
    /app window has not connected/,
  )
})

test('a remote session with the scope passes and without it refuses', async () => {
  const granted = createHost({
    config: { grantedScopes: [] },
    remoteSessionScope: { describe: () => ({ driven: 'remote', scopes: ['browser:control'] }) },
  })
  // The scope opens the session, but this Host mounts no `remoteBrowser` service: the call
  // is refused rather than driven on the local sidebar tab (spec 016 M1).
  await assert.rejects(
    () => granted.tools.get('internal_browser_snapshot').execute({}, exec),
    (error) => {
      assert.match(error.message, /no "remoteBrowser" service/)
      assert.match(error.message, /mobile-gateway/)
      assert.equal(error.code, 'browser/unusable')
      return true
    },
  )

  const denied = createHost({
    config: { grantedScopes: [] },
    remoteSessionScope: { describe: () => ({ driven: 'remote', scopes: [] }) },
  })
  await assert.rejects(
    () => denied.tools.get('internal_browser_snapshot').execute({}, exec),
    /driven by a remote device/,
  )
})
