import { test } from 'node:test'
import assert from 'node:assert/strict'
import {
  advertisedPairAddress, firstDirectAddress, normalizePwaOrigin, pairQrPayload, parseSelfDnsName, qrSvg, resolvePwaOrigin,
} from '../lib/pair-qr.mjs'

test('PWA origin: config wins, https only, else MagicDNS:30443, else null', () => {
  assert.equal(normalizePwaOrigin('http://x.example:1'), null)
  assert.equal(normalizePwaOrigin('https://u:p@x.example'), null)
  assert.equal(resolvePwaOrigin({ pwaUrl: 'https://pwa.example:8443/app?x=1', dnsName: 'n.t.ts.net' }), 'https://pwa.example:8443')
  assert.equal(resolvePwaOrigin({ dnsName: 'node.tail.ts.net' }), 'https://node.tail.ts.net:30443')
  assert.equal(resolvePwaOrigin({ dnsName: '100.64.0.1' }), null)
  assert.equal(resolvePwaOrigin({}), null)
})

// The PWA/serve origin is never a direct address: its TLS leaf is the proxy's, so a
// native/Desktop client that pins the listener's cert would fail with pin-mismatch.
test('advertised address: configured direct address only; the PWA origin is never one', () => {
  assert.equal(advertisedPairAddress({ advertisedAddress: 'h.example:9' }), 'h.example:9')
  assert.equal(advertisedPairAddress({}), null)
  assert.equal(advertisedPairAddress({ advertisedAddress: '' }), null)
  assert.equal(advertisedPairAddress(), null)
})

// A pinning client can dial only a non-loopback, non-serve-port listener. The server applies
// this to the candidates the client posts, so no card can advertise an undialable address.
test('first direct address: loopback, serve port, credentials and plain schemes are refused', () => {
  assert.equal(firstDirectAddress(['127.0.0.1:30081']), null)
  assert.equal(firstDirectAddress(['n.ts.net:30443']), null)
  assert.equal(firstDirectAddress(['wss://100.64.0.2:30081/ws/mobile']), '100.64.0.2:30081')
  assert.equal(firstDirectAddress(['https://u:p@100.64.0.2:30081/']), null)
  assert.equal(firstDirectAddress(['http://100.64.0.2:30081']), null)
  assert.equal(firstDirectAddress(['localhost:30081', '100.64.0.2:30081']), '100.64.0.2:30081')
  assert.equal(firstDirectAddress([]), null)
  assert.equal(firstDirectAddress([undefined, null, 42]), null)
})

// Reviewer bypasses: the URL parser canonicalises these before the host check, so none can
// be passed off as a remote listener. `::ffff:127.0.0.1:30081` is an invalid URL and is
// skipped by the parser; its bracketed URL form is canonicalised and refused as mapped loopback.
test('first direct address: non-canonical loopback and unspecified spellings are refused', () => {
  for (const bypass of ['localhost.:30081', '::ffff:127.0.0.1:30081', '0x7f000001:30081',
    '2130706433:30081', '0.0.0.0:30081', 'wss://[::ffff:127.0.0.1]:30081/x', 'wss://[::]:30081/x', 'wss://[::1]:30081/x']) {
    assert.equal(firstDirectAddress([bypass]), null, `${bypass} is not a direct address`)
  }
  assert.equal(firstDirectAddress(['wss://[::ffff:127.255.0.1]:30081/x']), null,
    'a mapped 127/8 address canonicalises to ::ffff:7fff:1 but stays loopback')
  assert.equal(firstDirectAddress(['::ffff:127.0.0.1:30081']), null,
    'a dotted mapped loopback is refused too')
  assert.equal(firstDirectAddress(['wss://[fd7a:115c:a1e0::1]:30081/ws/mobile']), '[fd7a:115c:a1e0::1]:30081',
    'a real IPv6 tailnet listener is accepted with its bracketed host:port shape')
  // URL parser lowercases hosts: an uppercase DNS name is emitted lowercase (stable identity).
  assert.equal(firstDirectAddress(['WSS://N.TS.NET:30081/ws/mobile']), 'n.ts.net:30081')
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
