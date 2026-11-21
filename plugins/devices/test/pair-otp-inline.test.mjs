// Spec 054, Devices half: the pairing pin travels to the native link fragment, the generated
// offer is inline (no dialog), and the native target makes an OTP offer with native scopes.
import assert from 'node:assert/strict'
import { test } from 'node:test'

import { advertisedPairAddress, firstDirectAddress, pairQrPayload } from '../lib/pair-qr.mjs'
import { mountPlugin } from './helpers.mjs'
import { readFileSync } from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
const CLIENT = readFileSync(path.join(ROOT, 'lib', 'client.js'), 'utf8')
const PIN = 'a'.repeat(64)
const OTP = '12345678'
const ORIGIN = 'https://n.ts.net:30443'

test('pairQrPayload: pin only in the fragment, as 64 lowercase hex', () => {
  const withPin = pairQrPayload({ pwaOrigin: ORIGIN, address: 'n.ts.net:30443', otp: OTP, pin: PIN })
  assert.equal(withPin, `${ORIGIN}/pair#a=n.ts.net%3A30443&c=${OTP}&p=${PIN}`)
  const url = new URL(withPin)
  assert.equal(url.search, '', 'no pin in the query')
  assert.equal(url.hash.includes(`p=${PIN}`), true)
  const without = pairQrPayload({ pwaOrigin: ORIGIN, address: 'n.ts.net:30443', otp: OTP })
  assert.equal(without, `${ORIGIN}/pair#a=n.ts.net%3A30443&c=${OTP}`)
  assert.equal(without.includes('p='), false)
  assert.equal(pairQrPayload({ pwaOrigin: ORIGIN, address: 'h:1', otp: OTP, pin: PIN.toUpperCase().replace('A', 'G') }).includes('p='), false, 'a bad pin is dropped')
  assert.equal(pairQrPayload({ pwaOrigin: ORIGIN, address: 'h:1', otp: OTP, pin: 'abcd' }).includes('p='), false, 'a short pin is dropped')
  assert.throws(() => pairQrPayload({ pwaOrigin: null, address: 'h:1', otp: '123' }), /8 digits/)
})

test('the generated offer is an inline card: no Dialog/backdrop', () => {
  assert.ok(CLIENT.includes("'data-testid': 'pair-offer'"), 'the card is rendered inline')
  assert.ok(CLIENT.includes('function PairOffer('), 'the component exists')
  assert.equal(/h\(Dialog, \{ title: tr\('otpTitle'\)/.test(CLIENT), false, 'the offer is not a dialog')
  assert.ok(CLIENT.includes('pairOfferPin'), 'pin copy exists')
  assert.ok(CLIENT.match(/pairOfferPin: '[^']+'/), 'en copy')
  assert.ok(CLIENT.match(/pairOfferPin: '[^']+'/g)?.length >= 2, 'vi copy too')
})

test('native target: OTP offer, kind mobile, native scopes, no web:unlock', () => {
  assert.ok(/const kind = otpTarget === 'desktop' \? 'desktop' : 'mobile'/.test(CLIENT))
  assert.ok(CLIENT.includes("scopes: otpTarget === 'native' ? nativeScopesFor() : gatewayScopesFor(kind)"))
  assert.ok(CLIENT.includes(".../mgw/pair") === false, 'the native path is not the removed string offer')
  assert.ok(CLIENT.includes("...(native && typeof offer.certSha256 === 'string'"), 'pin goes to /devices/pair-qr')
})

test('Amendment A: target-specific address is DISPLAY only (no wire/QR change)', () => {
  assert.ok(CLIENT.includes("target = 'native' })"), 'PairOffer accepts the selected target')
  assert.ok(CLIENT.includes('target: otpTarget,'), 'the call site passes the selected target')
  assert.ok(CLIENT.includes("target === 'pwa' && qr && qr.pwaOrigin"), 'PWA branch reads the served origin')
  assert.ok(CLIENT.includes('new URL(qr.pwaOrigin).host'), 'only the HOST of pwaOrigin is shown')
  assert.ok(CLIENT.includes("const noDirect = target !== 'pwa' && !direct"), 'a pinning client with no direct address says so')
  assert.ok(CLIENT.includes("webAddress ? [webAddress] : noDirect ? [] : (direct ? [direct] : addresses)"),
    'native/desktop never substitute the PWA origin or the loopback listener list')
  assert.ok(CLIENT.includes("tr(addressLabel)"), 'the label follows the selected target')
  assert.ok((CLIENT.match(/pairOfferWebAddress: ['"]/g) || []).length >= 2, 'web label in en and vi')
  assert.ok((CLIENT.match(/pairOfferDirectAddress: ['"]/g) || []).length >= 2, 'direct label in en and vi')
  assert.ok((CLIENT.match(/pairOfferNoDirectAddress: ['"]/g) || []).length >= 2, 'no-direct reason in en and vi')
  assert.ok((CLIENT.match(/pairOfferPwaNotDirect: ['"]/g) || []).length >= 2, 'PWA-not-direct reason in en and vi')
  // No wire change: the QR payload route and the pin branch are untouched by this display edit.
  const route = readFileSync(path.join(ROOT, 'lib', 'index.mjs'), 'utf8')
  assert.ok(route.includes('pairQrPayload({ pwaOrigin, address, otp, pin })'))
  assert.ok(route.includes('advertisedPairAddress({ advertisedAddress: options.advertisedAddress })'),
    'the configured address is the only override')
  assert.ok(route.includes('firstDirectAddress(['),
    'the handler filters the posted candidates before choosing a direct address')
  assert.equal(/advertisedPairAddress\(\{[^}]*pwaOrigin/.test(route), false,
    'the handler never falls back to the PWA origin as a direct address')
  assert.equal(/firstDirectAddress\(\[[^\n]*pwaOrigin/.test(route), false,
    'the direct candidates never include the PWA origin')
  assert.ok(CLIENT.includes("...(native && typeof offer.certSha256 === 'string'"))
})

// MINOR 4 / finding 3: drive the REAL route handler (test/helpers.mjs mountPlugin), not a
// source grep or a local mirror of the address expression. This is what production runs.
test('pair-qr route: the posted direct candidates are filtered; loopback and serve origins yield no address', async () => {
  const api = await mountPlugin({ tailscaleDnsName: async () => null, selfUpdate: false })
  try {
    const post = (body) => api.call('POST', '/devices/pair-qr', { body: { otp: OTP, ...body } })
    const tailnet = await post({ fallbackAddress: '127.0.0.1:30081',
      directAddresses: ['wss://100.64.0.2:30081/ws/mobile'] })
    assert.equal(tailnet.status, 200)
    assert.equal(tailnet.json.address, '100.64.0.2:30081',
      'a reachable tailnet listener posted by the page is the direct address')

    const loopback = await post({ fallbackAddress: '127.0.0.1:30081', directAddresses: ['localhost:30081'] })
    assert.equal(loopback.json.address, null, 'loopback candidates yield address:null')

    const serve = await post({ fallbackAddress: '127.0.0.1:30081', directAddresses: ['n.ts.net:30443'] })
    assert.equal(serve.json.address, null, 'the serve origin is never a direct address')

    // Config list remains the fallback for a Host whose page posts nothing.
    const viaConfig = await mountPlugin({ tailscaleDnsName: async () => null, selfUpdate: false,
      directAddresses: ['wss://100.64.0.9:30081/ws/mobile'] })
    try {
      const fromConfig = await viaConfig.call('POST', '/devices/pair-qr', { body: { otp: OTP, fallbackAddress: '127.0.0.1:30081' } })
      assert.equal(fromConfig.json.address, '100.64.0.9:30081')
    } finally { viaConfig.close() }
  } finally { api.close() }
})

test('no code, pin or proof is logged by the Devices plugin', () => {
  const route = readFileSync(path.join(ROOT, 'lib', 'index.mjs'), 'utf8')
  assert.equal(/log\([^)]*\botp\b/.test(route), false, 'no otp in a log call')
  assert.equal(/log\([^)]*certSha256/.test(route), false, 'no pin in a log call')
  assert.ok(route.includes('const pin = typeof body?.pin'), 'the route accepts the pin')
})
