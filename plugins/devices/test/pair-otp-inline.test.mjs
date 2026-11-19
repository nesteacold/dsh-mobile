// Spec 054, Devices half: the pairing pin travels to the native link fragment, the generated
// offer is inline (no dialog), and the native target makes an OTP offer with native scopes.
import assert from 'node:assert/strict'
import { test } from 'node:test'

import { pairQrPayload } from '../lib/pair-qr.mjs'
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

test('no code, pin or proof is logged by the Devices plugin', () => {
  const route = readFileSync(path.join(ROOT, 'lib', 'index.mjs'), 'utf8')
  assert.equal(/log\([^)]*\botp\b/.test(route), false, 'no otp in a log call')
  assert.equal(/log\([^)]*certSha256/.test(route), false, 'no pin in a log call')
  assert.ok(route.includes('const pin = typeof body?.pin'), 'the route accepts the pin')
})
