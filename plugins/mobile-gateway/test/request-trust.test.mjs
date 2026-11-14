// Split plan step 1 (2026-11-14): pins the CURRENT behaviour of the request-trust predicates moved
// out of lib/index.mjs. Expected values were derived from the function bodies, not changed by them.
import test from 'node:test'
import assert from 'node:assert/strict'
import * as trust from '../lib/request-trust.mjs'

const TOKEN = 'A'.repeat(43)
const req = (headers, remoteAddress = '127.0.0.1', url = '/') => ({ headers, socket: { remoteAddress }, url })
const base = { forwarded: false, loopbackAuthority: true, nonLocal: false, loopbackPeer: true, loopback: true, sameOrigin: true, credentialKind: null, queryCredentialParams: [] }

const cases = [
  ['plain loopback', req({ host: '127.0.0.1:8443' }), {}],
  ['localhost host', req({ host: 'localhost' }), {}],
  ['[::1] host + ::1 peer', req({ host: '[::1]:1' }, '::1'), {}],
  ['mapped v4 peer', req({ host: '127.0.0.1' }, '::ffff:127.0.0.1'), {}],
  ['x-forwarded-for', req({ host: '127.0.0.1', 'x-forwarded-for': '1.2.3.4' }), { forwarded: true, nonLocal: true, loopback: false }],
  ['tailscale-* prefix', req({ host: '127.0.0.1', 'Tailscale-User-Login': 'x' }), { forwarded: true, nonLocal: true, loopback: false }],
  ['forwarded header', req({ host: '127.0.0.1', forwarded: 'for=x' }), { forwarded: true, nonLocal: true, loopback: false }],
  ['tailnet host name', req({ host: 'box.tailnet.ts.net' }), { loopbackAuthority: false, nonLocal: true, loopback: false }],
  ['localhost. refused', req({ host: 'localhost.' }), { loopbackAuthority: false, nonLocal: true, loopback: false }],
  ['127.0.0.2 refused', req({ host: '127.0.0.2' }), { loopbackAuthority: false, nonLocal: true, loopback: false }],
  ['missing host', req({}), { loopbackAuthority: false, nonLocal: true, loopback: false }],
  ['lan peer', req({ host: '127.0.0.1' }, '192.168.1.5'), { loopbackPeer: false, loopback: false }],
  ['cgnat peer', req({ host: '127.0.0.1' }, '100.64.0.1'), { loopbackPeer: false, loopback: false }],
  ['same origin', req({ host: '127.0.0.1:1', origin: 'http://127.0.0.1:1' }), {}],
  ['cross origin', req({ host: '127.0.0.1:1', origin: 'http://evil.example' }), { sameOrigin: false }],
  ['bearer token', req({ host: '127.0.0.1', authorization: `Bearer ${TOKEN}` }), { credentialKind: 'token' }],
  ['pair subprotocol', req({ host: '127.0.0.1', 'sec-websocket-protocol': 'x, dsh-pair.123456' }), { credentialKind: 'pairing' }],
  ['query credentials', req({ host: '127.0.0.1' }, '127.0.0.1', '/ws?token=a&code=&pairingCode=b'), { queryCredentialParams: ['pairingCode', 'token'] }],
]

test('classifyRequest table (18 cases)', () => {
  assert.equal(cases.length, 18)
  for (const [name, r, diff] of cases) assert.deepEqual(trust.classifyRequest(r), { ...base, ...diff }, name)
})

test('originAllowed and assertTrustedLocalAuthority pinned', () => {
  assert.equal(trust.originAllowed(req({}), []), true)
  assert.equal(trust.originAllowed(req({ origin: 'https://a' }), ['https://a']), true)
  assert.equal(trust.originAllowed(req({ origin: 'https://b' }), ['https://a']), false)
  assert.doesNotThrow(() => trust.assertTrustedLocalAuthority(req({ host: 'localhost:1', origin: 'http://localhost:1' })))
  assert.throws(() => trust.assertTrustedLocalAuthority(req({ host: '127.0.0.1', 'x-real-ip': '1' })), (e) => e.status === 403 && /proxy/.test(e.message))
  assert.throws(() => trust.assertTrustedLocalAuthority(req({ host: 'evil' })), (e) => e.status === 403 && e.code === 'forbidden')
  assert.throws(() => trust.assertTrustedLocalAuthority(req({ host: '127.0.0.1:1', origin: 'http://127.0.0.1:2' })), (e) => e.status === 403)
})

test('export list snapshot', () => {
  assert.deepEqual(Object.keys(trust).sort(), [
    'FORWARDING_HEADER_NAMES', 'FORWARDING_HEADER_PREFIXES', 'QUERY_CREDENTIAL_PARAMS', 'TRUSTED_LOCAL_AUTHORITY',
    'addressesLoopbackAuthority', 'assertTrustedLocalAuthority', 'classifyRequest', 'extractCredential',
    'isForwardedRequest', 'isLoopback', 'isLoopbackPeer', 'isNonLocalRequest', 'isSameOrigin', 'originAllowed',
    'parseProtocols', 'queryCredentialParams',
  ])
})
