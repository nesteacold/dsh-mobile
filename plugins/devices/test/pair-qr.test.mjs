import { test } from 'node:test'
import assert from 'node:assert/strict'
import {
  advertisedPairAddress, normalizePwaOrigin, pairQrPayload, parseSelfDnsName, qrSvg, resolvePwaOrigin,
} from '../lib/pair-qr.mjs'

test('PWA origin: config wins, https only, else MagicDNS:30443, else null', () => {
  assert.equal(normalizePwaOrigin('http://x.example:1'), null)
  assert.equal(normalizePwaOrigin('https://u:p@x.example'), null)
  assert.equal(resolvePwaOrigin({ pwaUrl: 'https://pwa.example:8443/app?x=1', dnsName: 'n.t.ts.net' }), 'https://pwa.example:8443')
  assert.equal(resolvePwaOrigin({ dnsName: 'node.tail.ts.net' }), 'https://node.tail.ts.net:30443')
  assert.equal(resolvePwaOrigin({ dnsName: '100.64.0.1' }), null)
  assert.equal(resolvePwaOrigin({}), null)
})

test('advertised address: config, else serve origin when loopback-bound, else null', () => {
  assert.equal(advertisedPairAddress({ advertisedAddress: 'h.example:9', pwaOrigin: 'https://n.ts.net:30443', lanHost: '127.0.0.1' }), 'h.example:9')
  assert.equal(advertisedPairAddress({ pwaOrigin: 'https://n.ts.net:30443', lanHost: '127.0.0.1' }), 'n.ts.net:30443')
  assert.equal(advertisedPairAddress({ pwaOrigin: 'https://n.ts.net', lanHost: '::1' }), 'n.ts.net:30443')
  assert.equal(advertisedPairAddress({ pwaOrigin: 'https://n.ts.net:30443', lanHost: '100.64.0.2' }), null)
  assert.equal(advertisedPairAddress({ pwaOrigin: null, lanHost: '127.0.0.1' }), null)
})

test('QR payload: OTP only in the fragment, never the query', () => {
  const link = pairQrPayload({ pwaOrigin: 'https://n.ts.net:30443', address: 'n.ts.net:30443', otp: '1234 5678' })
  assert.equal(link, 'https://n.ts.net:30443/pair#a=n.ts.net%3A30443&c=12345678')
  const url = new URL(link)
  assert.equal(url.search, '')
  assert.equal(url.pathname, '/pair')
  assert.equal(pairQrPayload({ pwaOrigin: null, address: 'h:1', otp: '12345678' }), 'h:1\n12345678')
  assert.throws(() => pairQrPayload({ pwaOrigin: null, address: 'h:1', otp: '123' }), /8 digits/)
})

test('qrSvg renders a local SVG with finder patterns', () => {
  const svg = qrSvg('https://n.ts.net:30443/pair#a=n.ts.net%3A30443&c=12345678')
  assert.match(svg, /^<svg xmlns="http:\/\/www.w3.org\/2000\/svg"/)
  assert.match(svg, /<path d="M4 4h1v1h-1z/) // top-left finder corner after the quiet zone
  assert.doesNotMatch(svg, /https?:\/\/(?!www\.w3\.org)/) // no external reference
})

test('parseSelfDnsName', () => {
  assert.equal(parseSelfDnsName('{"Self":{"DNSName":"Node.Tail.ts.net."}}'), 'node.tail.ts.net')
  assert.equal(parseSelfDnsName('{"Self":{"DNSName":"100.1.2.3"}}'), null)
  assert.equal(parseSelfDnsName('nope'), null)
})
