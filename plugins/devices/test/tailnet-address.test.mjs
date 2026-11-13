import { test } from 'node:test'
import assert from 'node:assert/strict'
import { isPrivateAddress, otpDialUrl, PUBLIC_ADDRESS_ERROR, vetDialHost } from '../lib/remote-client.mjs'

const resolver = (table) => async (host) => {
  if (!(host in table)) throw Object.assign(new Error('ENOTFOUND'), { code: 'ENOTFOUND' })
  return table[host].map((address) => ({ address, family: address.includes(':') ? 6 : 4 }))
}

test('isPrivateAddress judges IPs only; a name is never private by itself', () => {
  assert.equal(isPrivateAddress('host.example.ts.net'), false)
  assert.equal(isPrivateAddress('fd7a:115c:a1e0::1'), true)
  assert.equal(isPrivateAddress('[fd7a:115c:a1e0::1]'), true)
  assert.equal(isPrivateAddress('100.64.0.1'), true)
  assert.equal(isPrivateAddress('example.com'), false)
  assert.match(PUBLIC_ADDRESS_ERROR, /allowPublicRemotes/)
})

test('vetDialHost: names are resolved and every address must be private', async () => {
  const lookup = resolver({
    'funnel.example.ts.net': ['203.0.113.9'],
    'node.example.ts.net': ['100.101.102.103', 'fd7a:115c:a1e0::5'],
    'mixed.example.ts.net': ['100.101.102.103', '8.8.8.8'],
  })
  await assert.rejects(vetDialHost('funnel.example.ts.net', { lookup }), /private-network/)
  assert.deepEqual(await vetDialHost('node.example.ts.net', { lookup }),
    { address: '100.101.102.103', servername: 'node.example.ts.net' })
  await assert.rejects(vetDialHost('mixed.example.ts.net', { lookup }), /private-network/)
  // Trailing-dot FQDN is the same name (and is what SNI gets, without the dot).
  assert.deepEqual(await vetDialHost('NODE.example.ts.net.', { lookup }),
    { address: '100.101.102.103', servername: 'node.example.ts.net' })
  await assert.rejects(vetDialHost('gone.example.ts.net', { lookup }), (error) => error.status === 403)
  await assert.rejects(vetDialHost('empty.test', { lookup: async () => [] }), /could not be resolved/)
  // allowPublicRemotes keeps working, still dialling a resolved IP.
  assert.equal((await vetDialHost('funnel.example.ts.net', { lookup, allowPublic: true })).address, '203.0.113.9')
  // Literals need no lookup.
  assert.equal((await vetDialHost('10.0.0.2', { lookup: () => { throw new Error('no') } })).address, '10.0.0.2')
  await assert.rejects(vetDialHost('8.8.8.8'), /private-network/)
})

test('otpDialUrl refuses a public-resolving *.ts.net name', async () => {
  const lookup = resolver({ 'funnel.example.ts.net': ['203.0.113.9'], 'node.example.ts.net': ['100.64.1.2'] })
  await assert.rejects(otpDialUrl('funnel.example.ts.net:443', { lookup }), /private-network/)
  assert.equal(await otpDialUrl('node.example.ts.net:3081', { lookup }), 'wss://node.example.ts.net:3081/ws/mobile')
})
