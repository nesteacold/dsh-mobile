// Spec 023 — pairing OTP isolation (decision 2026-11-13).
//
// Two mechanisms, tested at their own level:
//   - the per-source limiter: SOURCE_MAX_FAILURES (2) wrong proofs / 10 min, keyed per peer or one
//     shared `proxied` key;
//   - the per-offer counter of wrong proofs TESTED against that offer, from any source, which burns
//     it at OTP_MAX_FAILURES (3).
// 2 < 3 is the whole point: neither one peer nor the shared proxied bucket can burn the owner's code
// alone, and guessing per offer stays capped at 3 tested proofs. Injected clock throughout; no
// sockets here (the gateway-level counterpart is P16 in pairing-approval).
import assert from 'node:assert/strict'
import test from 'node:test'
import { createPairingRequests, otpProof, OTP_MAX_FAILURES } from '../lib/pairing-requests.mjs'
import {
  createSourceLimiter, pairingSourceKey, PROXIED_SOURCE_KEY, SOURCE_MAX_FAILURES, SOURCE_MAX_KEYS, SOURCE_WINDOW_MS,
  UNKNOWN_SOURCE_KEY,
} from '../lib/pairing-source-limiter.mjs'

const CERT = 'a'.repeat(64)
const CNONCE = 'c'.repeat(20)
const SNONCE = 's'.repeat(20)
const args = (proof, source) => ({ proof, certSha256: CERT, clientNonce: CNONCE, serverNonce: SNONCE, source })
const good = (otp) => otpProof(otp, CERT, CNONCE, SNONCE)
const BAD = '0'.repeat(64)
const offer = (requests) => requests.createOffer({ kind: 'desktop', scopes: ['sessions:read'] }).otp
const direct = (address) => pairingSourceKey({ proxied: false, peerAddress: address })
const proxied = (address) => pairingSourceKey({ proxied: true, peerAddress: address })

test('the per-source budget is below the per-offer burn ceiling (a source alone can never burn)', () => {
  assert.ok(SOURCE_MAX_FAILURES < OTP_MAX_FAILURES, `${SOURCE_MAX_FAILURES} < ${OTP_MAX_FAILURES}`)
})

test('one source is limited after 2 wrong proofs and cannot burn the offer alone', () => {
  const requests = createPairingRequests()
  offer(requests)
  for (let i = 0; i < SOURCE_MAX_FAILURES; i += 1) {
    const checked = requests.verifyProof(args(BAD, direct('10.0.0.1')))
    assert.equal(checked.ok, false)
    assert.deepEqual(checked.burned, [], 'one source spending its whole budget does not burn the offer')
  }
  const limited = requests.verifyProof(args(BAD, direct('10.0.0.1')))
  assert.deepEqual([limited.ok, limited.reason, limited.burned], [false, 'source-limited', []],
    'the third wrong proof from that source is refused untested')
  assert.equal(requests.offerCount(), 1, 'the offer is still live: a limited source burns nothing')
})

test('proxied peers share one key: together they cannot burn the offer alone', () => {
  const requests = createPairingRequests()
  offer(requests)
  // Different peers, one shared key — the peer address behind a proxy names the proxy, not the caller.
  for (let i = 0; i < SOURCE_MAX_FAILURES; i += 1) {
    assert.equal(proxied(`1.1.1.${i}`), PROXIED_SOURCE_KEY, 'every proxied peer maps to the one key')
    assert.deepEqual(requests.verifyProof(args(BAD, proxied(`1.1.1.${i}`))).burned, [], 'the shared bucket cannot burn it alone')
  }
  assert.equal(requests.verifyProof(args(BAD, proxied('1.1.1.9'))).reason, 'source-limited')
  assert.equal(requests.offerCount(), 1, 'the offer survived every proxied peer')
  // A DIRECT peer is a different source, so its first wrong proof is the third one tested.
  assert.equal(requests.verifyProof(args(BAD, direct('100.64.0.7'))).burned.length, 1, 'a second source completes the 3')
})

test('3 tested wrong proofs from 2+ sources burn that offer only; a later offer is unaffected', () => {
  const requests = createPairingRequests()
  const first = offer(requests)
  for (let i = 0; i < SOURCE_MAX_FAILURES; i += 1) {
    assert.deepEqual(requests.verifyProof(args(BAD, direct('10.0.1.1'))).burned, [], 'source A alone stops at its budget')
  }
  // Created after A's budget is spent: it counts only the proofs tested after it existed.
  const late = offer(requests)
  const third = requests.verifyProof(args(BAD, direct('10.0.1.2')))
  assert.equal(third.burned.length, 1, 'the third tested proof burns the offer that saw all three')
  assert.equal(requests.offerCount(), 1, 'the later offer survives (one tested proof)')
  assert.equal(requests.verifyProof(args(good(late), direct('10.0.1.3'))).ok, true, 'and it still pairs')
  void first
})

test('a correct proof from a different unlimited source still pairs before any burn', () => {
  const requests = createPairingRequests()
  const otp = offer(requests)
  for (let i = 0; i < SOURCE_MAX_FAILURES; i += 1) requests.verifyProof(args(BAD, direct('10.0.2.1')))
  assert.equal(requests.offerCount(), 1, '2 tested proofs are below the ceiling: nothing burned')
  const paired = requests.verifyProof(args(good(otp), direct('10.0.2.2')))
  assert.equal(paired.ok, true, 'an unlimited source pairs with the same offer')
  assert.equal(requests.offerCount(), 0, 'the valid proof consumes the offer')
})

test('limited source with a correct proof is refused until the window passes (fake clock)', () => {
  let now = 1_000_000
  const requests = createPairingRequests({ now: () => now })
  const src = direct('10.0.5.1')
  const otp = offer(requests)
  for (let i = 0; i < SOURCE_MAX_FAILURES; i += 1) requests.verifyProof(args(BAD, src))
  now += SOURCE_WINDOW_MS - 1
  assert.equal(requests.verifyProof(args(good(otp), src)).reason, 'source-limited', 'still inside the window')
  now += 2
  // The offer may itself be past its 10-minute TTL by now; a fresh one proves the source is free.
  const next = offer(requests)
  assert.equal(requests.verifyProof(args(good(next), src)).ok, true, 'window passed: the source pairs again')
})

test('source key: proxied peers share one bucket, direct peers do not', () => {
  assert.equal(pairingSourceKey({ proxied: true, peerAddress: '127.0.0.1' }), PROXIED_SOURCE_KEY)
  assert.equal(pairingSourceKey({ proxied: true, peerAddress: '100.64.0.7' }), PROXIED_SOURCE_KEY)
  assert.notEqual(
    pairingSourceKey({ proxied: false, peerAddress: '100.64.0.7' }),
    pairingSourceKey({ proxied: false, peerAddress: '100.64.0.8' }),
  )
  assert.equal(
    pairingSourceKey({ proxied: false, peerAddress: '::ffff:100.64.0.7' }),
    pairingSourceKey({ proxied: false, peerAddress: '100.64.0.7' }),
    'an IPv4-mapped peer is the same source as its IPv4 form',
  )
  // The shared bucket really is shared: wrong proofs from "different" proxied peers limit them all.
  const limiter = createSourceLimiter()
  for (let i = 0; i < SOURCE_MAX_FAILURES; i += 1) limiter.recordFailure(proxied(`1.1.1.${i}`))
  assert.equal(limiter.isLimited(PROXIED_SOURCE_KEY), true)
  assert.equal(limiter.isLimited(direct('100.64.0.9')), false)
})

test('a full limiter table refuses NEW sources instead of evicting an existing one', () => {
  const limiter = createSourceLimiter({ maxKeys: 4 })
  // Fill the table, with `proxied` among the four and already limited.
  for (let i = 0; i < SOURCE_MAX_FAILURES; i += 1) limiter.recordFailure(PROXIED_SOURCE_KEY)
  for (const key of ['k1', 'k2', 'k3']) limiter.recordFailure(key)
  assert.equal(limiter.size(), 4)
  assert.equal(limiter.isLimited(PROXIED_SOURCE_KEY), true, 'it really is limited before the flood')
  // A fifth key cannot be tracked, so it is refused as if it had spent its budget.
  assert.equal(limiter.isLimited('k4'), true, 'a new key on a full table is limited')
  limiter.recordFailure('k4')
  assert.equal(limiter.size(), 4, 'nothing was evicted to make room')
  assert.equal(limiter.isLimited(PROXIED_SOURCE_KEY), true, 'and the real bucket kept its state')
  assert.equal(limiter.isLimited('k1'), false, 'an existing unlimited key keeps its own state too')
})

test('the limiter table is not wedgeable: expired buckets are swept when a new key needs room', () => {
  let now = 1_000_000
  const limiter = createSourceLimiter({ maxKeys: 2, now: () => now })
  limiter.recordFailure('a')
  limiter.recordFailure('b')
  assert.equal(limiter.isLimited('c'), true, 'full of live buckets: a new key is refused')
  now += SOURCE_WINDOW_MS + 1
  assert.equal(limiter.isLimited('c'), false, 'the expired buckets were dropped, so c fits')
  limiter.recordFailure('c')
  assert.equal(limiter.size(), 1)
  assert.equal(limiter.isLimited('a'), false, 'a source that waited out the window is free again')
  assert.equal(SOURCE_MAX_KEYS, 1024)
})

test('a proof with no source is charged to the shared `unknown` bucket, not exempted', () => {
  const requests = createPairingRequests()
  offer(requests)
  const bad = (source) => args(BAD, source)
  // Three proofs without a source: the first two are tested, the third is refused untested — the
  // same budget a named source gets, shared by every anonymous caller.
  assert.deepEqual(requests.verifyProof({ ...bad(undefined) }).burned, [])
  assert.deepEqual(requests.verifyProof({ ...bad(undefined) }).burned, [])
  const limited = requests.verifyProof({ ...bad(undefined) })
  assert.deepEqual([limited.ok, limited.reason], [false, 'source-limited'])
  assert.equal(UNKNOWN_SOURCE_KEY, 'unknown')
  // It is one bucket, not a bypass: a named source still has its own untouched budget.
  assert.equal(requests.verifyProof(args(BAD, direct('10.0.7.1'))).reason, 'bad-proof')
  // And a correct proof with no source is refused once that bucket is spent.
  const requests2 = createPairingRequests()
  const otp = offer(requests2)
  for (let i = 0; i < SOURCE_MAX_FAILURES; i += 1) requests2.verifyProof(bad(undefined))
  assert.equal(requests2.verifyProof(args(good(otp), undefined)).reason, 'source-limited')
  assert.equal(requests2.offerCount(), 1, 'the offer is still there for a source that is not limited')
})

test('the limiter table is bounded (by SOURCE_MAX_KEYS) and cleared with the registry (plugin stop)', () => {
  const limiter = createSourceLimiter({ maxKeys: 4 })
  for (let i = 0; i < 6; i += 1) limiter.recordFailure(`k${i}`)
  assert.equal(limiter.size(), 4, 'the bound holds: the last two could not be tracked')
  assert.equal(limiter.isLimited('k0'), false, 'k0 is tracked and unlimited')
  assert.equal(limiter.isLimited('k5'), true, 'a key refused for room reads as limited')

  const requests = createPairingRequests()
  const otp = offer(requests)
  for (let i = 0; i < SOURCE_MAX_FAILURES; i += 1) requests.verifyProof(args(BAD, direct('10.0.6.1')))
  assert.equal(requests.verifyProof(args(good(otp), direct('10.0.6.1'))).reason, 'source-limited')
  requests.clear()
  const fresh = offer(requests)
  assert.equal(requests.verifyProof(args(good(fresh), direct('10.0.6.1'))).ok, true, 'clear() (plugin stop) resets the limiter')
})
