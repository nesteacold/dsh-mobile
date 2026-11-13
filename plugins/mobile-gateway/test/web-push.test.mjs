// Spec 026 — Web Push, UNIT level: the VAPID identity, the RFC 8291 body, the store and the
// service.
//
// Everything cryptographic here is REAL: a fresh P-256 key per run, real ECDH, real HKDF, real
// AES-128-GCM, real ES256 signatures. The decryption helper is the RECEIVER side of RFC 8291
// (`decryptPayload`), so "the body decrypts with the subscription keys" is proven by deriving the
// key from those keys, not by trusting the sender's own bookkeeping. The RFC 8291 Appendix A
// vector is pinned as well, so a drift in the derivation itself would fail even if both halves of
// this file agreed with each other.
//
// The wire-level behaviour (frames, `hello.webPush`, the owner switch, a local fake push service,
// delivery removal on 410) lives in `test/web-push-gateway.test.mjs`.
import assert from 'node:assert/strict'
import crypto from 'node:crypto'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { test } from 'node:test'

import * as contract from '@dsh-ext/mobile-protocol'
import {
  CONTENT_ENCODING,
  deriveKeyMaterial,
  decryptPayload,
  encryptPayload,
  hkdfExpand,
  hkdfExtract,
  publicKeyFromPoint,
  RECORD_SIZE,
  uncompressedPoint,
} from '../lib/web-push/encrypt.mjs'
import {
  createWebPushService,
  webPushPayload,
} from '../lib/web-push/service.mjs'
import { createWebPushSender, WEB_PUSH_MAX_PAYLOAD_BYTES } from '../lib/web-push/sender.mjs'
import {
  createWebPushStore,
  loadOrCreateVapidKeys,
  loadWebPushSubscriptions,
  WEB_PUSH_KEY_FILE,
  WEB_PUSH_SUBSCRIPTION_FILE,
} from '../lib/web-push/store.mjs'
import {
  derToJoseSignature,
  exportPublicKey,
  generateVapidKeys,
  publicKeyOf,
  VAPID_SUBJECT,
  vapidAuthorization,
  verifyVapidToken,
} from '../lib/web-push/vapid.mjs'
import { setOwnerOnlyProbeOverride } from '../lib/secure-file.mjs'

const tempDirs = []
function tempDir() {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'dsh-web-push-'))
  tempDirs.push(directory)
  return directory
}
process.on('exit', () => {
  for (const directory of tempDirs) fs.rmSync(directory, { recursive: true, force: true })
})

/**
 * One browser subscription: a REAL P-256 key pair (the private half stays here, as a browser's
 * would) plus its 16-byte auth secret. `keys` is what the device sends in `push-subscribe`.
 */
function subscription(endpoint = 'https://abc123.push.services.mozilla.com/wpush/v2/gAAAA') {
  const { privateKey, publicKey } = crypto.generateKeyPairSync('ec', { namedCurve: 'P-256' })
  return {
    endpoint,
    privateKey,
    keys: {
      p256dh: uncompressedPoint(publicKey).toString('base64url'),
      auth: crypto.randomBytes(16).toString('base64url'),
    },
  }
}

/** Decrypt a delivered body exactly as the subscription's browser would. */
function readBody(body, sub) {
  return JSON.parse(decryptPayload({ body, privateKey: sub.privateKey, auth: sub.keys.auth }).toString('utf8'))
}

// ===========================================================================
// RFC 8291 — the body
// ===========================================================================

test('a push body decrypts with the subscription keys and carries ids only', () => {
  const sub = subscription()
  const payload = { v: 1, kind: 'approval', sessionId: 'sess-1', requestId: 'req-1' }
  const body = encryptPayload({ payload: JSON.stringify(payload), p256dh: sub.keys.p256dh, auth: sub.keys.auth })
  assert.deepEqual(readBody(body, sub), payload)

  // The wire layout RFC 8291 pins: salt(16) | rs(4) | idlen(1) | keyid(65) | ciphertext+tag.
  assert.equal(body.readUInt32BE(16), RECORD_SIZE)
  assert.equal(body[20], 65, 'keyid is the sender ephemeral public key')
  assert.equal(body[21], 0x04, 'the keyid is an uncompressed point')
  assert.ok(body.length > 21 + 65 + 16)
})

test('a fresh ephemeral key and salt per message: two sends of the same payload differ', () => {
  const sub = subscription()
  const options = { payload: JSON.stringify({ v: 1, kind: 'question', sessionId: 's' }), p256dh: sub.keys.p256dh, auth: sub.keys.auth }
  const first = encryptPayload(options)
  const second = encryptPayload(options)
  assert.notDeepEqual(first.subarray(0, 16), second.subarray(0, 16), 'the salt must be fresh')
  assert.notDeepEqual(first.subarray(21, 86), second.subarray(21, 86), 'the ephemeral key must be fresh')
  // Both still decrypt to the same plaintext, so freshness did not break the record.
  assert.deepEqual(readBody(first, sub), readBody(second, sub))
})

test('the wrong subscription keys cannot read a body (the auth secret binds it)', () => {
  const sub = subscription()
  const other = subscription()
  const body = encryptPayload({
    payload: JSON.stringify({ v: 1, kind: 'approval', sessionId: 's' }), p256dh: sub.keys.p256dh, auth: sub.keys.auth,
  })
  // Right private key, wrong auth secret: the key material differs, so authentication fails.
  assert.throws(() => decryptPayload({ body, privateKey: sub.privateKey, auth: other.keys.auth }))
  // Wrong private key entirely.
  assert.throws(() => decryptPayload({ body, privateKey: other.privateKey, auth: sub.keys.auth }))
})

test('RFC 8291 Appendix A: the derivation reproduces the published CEK and nonce', () => {
  // Appendix A's receiver key pair, auth secret, salt and sender ephemeral public key.
  const uaPublic = Buffer.from('BCVxsr7N_eNgVRqvHtD0zTZsEc6-VV-JvLexhqUzORcxaOzi6-AYWXvTBHm4bjyPjs7Vd8pZGH6SRpkNtoIAiw4', 'base64url')
  const asPublic = Buffer.from('BP4z9KsN6nGRTbVYI_c7VJSPQTBtkgcy27mlmlMoZIIgDll6e3vCYLocInmYWAmS6TlzAC8wEqKK6PBru3jl7A8', 'base64url')
  const uaPrivate = crypto.createPrivateKey({
    format: 'jwk',
    key: {
      kty: 'EC', crv: 'P-256',
      d: 'q1dXpw3UpT5VOmu_cf_v6ih07Aems3njxI-JWgLcM94',
      x: uaPublic.subarray(1, 33).toString('base64url'),
      y: uaPublic.subarray(33, 65).toString('base64url'),
    },
  })
  const salt = Buffer.from('DGv6ra1nlYgDCS1FRnbzlw', 'base64url')
  const auth = 'BTBZMqHH6r4Tts7J_aSIgg' // gitleaks:allow — public RFC 8291 Appendix A test vector
  const ecdhSecret = crypto.diffieHellman({ privateKey: uaPrivate, publicKey: publicKeyFromPoint(asPublic) })
  const { cek, nonce } = deriveKeyMaterial({ salt, authSecret: Buffer.from(auth, 'base64url'), receiverPoint: uaPublic, senderPoint: asPublic, ecdhSecret })
  assert.equal(cek.toString('base64url'), 'oIhVW04MRdy2XN9CiKLxTg', 'CEK must match RFC 8291 Appendix A')
  assert.equal(nonce.toString('base64url'), '4h_95klXJ5E_qnoN', 'nonce must match RFC 8291 Appendix A')
  // ...and the RFC's own published body decrypts to its own plaintext.
  const body = Buffer.from('DGv6ra1nlYgDCS1FRnbzlwAAEABBBP4z9KsN6nGRTbVYI_c7VJSPQTBtkgcy27mlmlMoZIIgDll6e3vCYLocInmYWAmS6TlzAC8wEqKK6PBru3jl7A_yl95bQpu6cVPTpK4Mqgkf1CXztLVBSt2Ks3oZwbuwXPXLWyouBWLVWGNWQexSgSxsj_Qulcy4a-fN', 'base64url')
  assert.equal(decryptPayload({ body, privateKey: uaPrivate, auth }).toString('utf8'), 'When I grow up, I want to be a watermelon')
})

test('HKDF is RFC 5869 SHA-256 (extract then expand, 1..32 bytes)', () => {
  // RFC 5869 §A.1's IKM/salt/info with SHA-256.
  const ikm = Buffer.alloc(22, 0x0b)
  const salt = Buffer.from('000102030405060708090a0b0c', 'hex')
  const prk = hkdfExtract(salt, ikm)
  assert.equal(prk.toString('hex'), '077709362c2e32df0ddc3f0dc47bba6390b6c73bb50f9c3122ec844ad7c2b3e5')
  const okm = hkdfExpand(prk, Buffer.from('f0f1f2f3f4f5f6f7f8f9', 'hex'), 32)
  assert.equal(okm.toString('hex'), '3cb25f25faacd57a90434f64d0362f2a2d2d0a90cf1a5a4c5db02d56ecc4c5bf')
  assert.throws(() => hkdfExpand(prk, 'x', 0))
  assert.throws(() => hkdfExpand(prk, 'x', 33))
})

test('the content coding is the RFC 8188 one, and a truncated or altered body is refused', () => {
  assert.equal(CONTENT_ENCODING, 'aes128gcm')
  const sub = subscription()
  const body = encryptPayload({
    payload: JSON.stringify({ v: 1, kind: 'approval', sessionId: 's' }), p256dh: sub.keys.p256dh, auth: sub.keys.auth,
  })
  // A flipped ciphertext byte fails GCM authentication instead of decrypting to garbage.
  const tampered = Buffer.from(body)
  tampered[tampered.length - 20] ^= 0xff
  assert.throws(() => decryptPayload({ body: tampered, privateKey: sub.privateKey, auth: sub.keys.auth }))
  assert.throws(() => decryptPayload({ body: body.subarray(0, 40), privateKey: sub.privateKey, auth: sub.keys.auth }))
  // A subscription that is not a 65-byte point / 16-byte secret is refused before encrypting.
  assert.throws(() => encryptPayload({ payload: 'x', p256dh: 'AAAA', auth: sub.keys.auth }))
  assert.throws(() => encryptPayload({ payload: 'x', p256dh: sub.keys.p256dh, auth: 'AAAA' }))
})

// ===========================================================================
// RFC 8292 — VAPID
// ===========================================================================

test('the VAPID public key is a 65-byte uncompressed P-256 point and the pair agrees', () => {
  const keys = generateVapidKeys()
  const point = Buffer.from(keys.publicKey, 'base64url')
  assert.equal(point.length, 65)
  assert.equal(point[0], 0x04)
  // The advertised key really is the stored private key's public half.
  assert.equal(publicKeyOf(keys.privateKeyPem), keys.publicKey)
  // The private PEM never appears inside the public value.
  assert.equal(keys.publicKey.includes('PRIVATE'), false)
})

test('a VAPID JWT verifies with the public key, and only with it', () => {
  const keys = generateVapidKeys()
  const now = 1_700_000_000
  const authorization = vapidAuthorization({
    privateKeyPem: keys.privateKeyPem, publicKey: keys.publicKey, audience: 'https://fcm.googleapis.com', now,
  })
  // RFC 8292 §3: the header is `Authorization: vapid t=<jwt>, k=<public key>`.
  assert.match(authorization, /^vapid t=[^,]+\.([^,]+), k=/)
  assert.ok(authorization.endsWith(`k=${keys.publicKey}`))
  const token = authorization.match(/^vapid t=([^,]+), k=/)[1]

  const verified = verifyVapidToken(token, keys.publicKey)
  assert.equal(verified.ok, true, JSON.stringify(verified))
  assert.equal(verified.header.alg, 'ES256')
  assert.equal(verified.header.typ, 'JWT')
  // `aud` is the endpoint ORIGIN, never the full URL (RFC 8292 §2).
  assert.equal(verified.claims.aud, 'https://fcm.googleapis.com')
  assert.equal(verified.claims.exp, now + 12 * 60 * 60)
  assert.equal(verified.claims.sub, VAPID_SUBJECT)
  assert.match(verified.claims.sub, /^mailto:/)

  // Every way a push service could be fooled is refused.
  const other = generateVapidKeys()
  assert.equal(verifyVapidToken(token, other.publicKey).reason, 'bad-signature')
  const [header, claims, signature] = token.split('.')
  const forgedClaims = Buffer.from(JSON.stringify({ ...verified.claims, aud: 'https://evil.example' }), 'utf8').toString('base64url')
  assert.equal(verifyVapidToken(`${header}.${forgedClaims}.${signature}`, keys.publicKey).reason, 'bad-signature')
  const noneHeader = Buffer.from(JSON.stringify({ typ: 'JWT', alg: 'none' }), 'utf8').toString('base64url')
  assert.equal(verifyVapidToken(`${noneHeader}.${claims}.`, keys.publicKey).reason, 'unsupported-alg')
  assert.equal(verifyVapidToken('not-a-jwt', keys.publicKey).ok, false)
  assert.equal(verifyVapidToken(undefined, keys.publicKey).ok, false)
  // A truncated signature (not 64 bytes of r||s) cannot be a P-256 JWS.
  assert.equal(verifyVapidToken(`${header}.${claims}.${signature.slice(0, 40)}`, keys.publicKey).reason, 'bad-signature-length')
})

test('an ES256 JWT signature is the raw r||s form, never the DER sequence crypto.sign returns', () => {
  // DER -> JOSE is where a naive implementation silently produces a token no push service accepts.
  // Exercise many keys so both coordinates hit the high-bit case that needs an extra 0x00.
  for (let round = 0; round < 64; round += 1) {
    const keys = generateVapidKeys()
    const token = vapidAuthorization({ privateKeyPem: keys.privateKeyPem, publicKey: keys.publicKey, audience: 'https://x' })
      .match(/^vapid t=([^,]+), k=/)[1]
    const signature = Buffer.from(token.split('.')[2], 'base64url')
    assert.equal(signature.length, 64, 'a JWS ES256 signature is exactly 64 bytes')
    assert.equal(verifyVapidToken(token, keys.publicKey).ok, true, `round ${round} must verify`)
  }
  // A hand-built DER sequence with a leading zero padding (high bit set) converts to 32+32 bytes.
  const der = Buffer.concat([
    Buffer.from([0x30, 0x45, 0x02, 0x21, 0x00]), Buffer.alloc(32, 0xff),
    Buffer.from([0x02, 0x20]), Buffer.alloc(32, 0x01),
  ])
  const jose = derToJoseSignature(der)
  assert.equal(jose.length, 64)
  assert.equal(jose[0], 0xff, 'the DER sign byte is stripped, not kept')
  assert.throws(() => derToJoseSignature(Buffer.from([0x30, 0x01, 0x00])))
})

// ===========================================================================
// The store — keys on disk, subscriptions, the hourly budget
// ===========================================================================

test('the VAPID pair is generated once and kept in an owner-only file, never logged', (t) => {
  setOwnerOnlyProbeOverride(() => null)
  t.after(() => setOwnerOnlyProbeOverride(undefined))
  const directory = tempDir()
  const lines = []
  const first = loadOrCreateVapidKeys(directory, (line) => lines.push(line))
  assert.equal(first.regenerated, true, 'the first load generates the pair')
  assert.equal(fs.existsSync(path.join(directory, WEB_PUSH_KEY_FILE)), true)
  // Nothing about the private key may reach a log line.
  for (const line of lines) assert.equal(/PRIVATE|privateKeyPem/.test(line), false, line)

  const second = loadOrCreateVapidKeys(directory, (line) => lines.push(line))
  assert.equal(second.regenerated, false, 'a second load reuses the stored pair')
  assert.equal(second.vapid.publicKey, first.vapid.publicKey)
  assert.equal(publicKeyOf(second.vapid.privateKeyPem), second.vapid.publicKey)

  // A corrupt file regenerates rather than stopping the gateway, and says so.
  fs.writeFileSync(path.join(directory, WEB_PUSH_KEY_FILE), '{"version":1}')
  const third = loadOrCreateVapidKeys(directory, (line) => lines.push(line))
  assert.equal(third.regenerated, true)
  assert.notEqual(third.vapid.publicKey, first.vapid.publicKey)
  assert.ok(lines.some((line) => line.includes('generating a new VAPID key pair')))

  // A public/private mismatch is caught instead of shipping a key that decrypts nothing.
  const mismatched = generateVapidKeys()
  fs.writeFileSync(path.join(directory, WEB_PUSH_KEY_FILE),
    JSON.stringify({ version: 1, privateKeyPem: mismatched.privateKeyPem, publicKey: first.vapid.publicKey }))
  const fourth = loadOrCreateVapidKeys(directory, (line) => lines.push(line))
  assert.equal(fourth.regenerated, true)
  assert.equal(publicKeyOf(fourth.vapid.privateKeyPem), fourth.vapid.publicKey, 'the regenerated pair must agree')
})

test('subscriptions are stored per device, replace by endpoint, and are bounded', () => {
  const directory = tempDir()
  const loaded = loadWebPushSubscriptions(directory)
  const store = createWebPushStore({ byDevice: loaded.byDevice, file: loaded.file })
  const first = subscription()
  assert.equal(store.subscribe('device-a', first), 1, 'one subscription')
  // The same endpoint again REPLACES instead of accumulating.
  assert.equal(store.subscribe('device-a', first), 1)
  const second = subscription('https://updates.push.services.mozilla.com/wpush/v2/xyz')
  assert.equal(store.subscribe('device-a', second), 2)
  // Another device is a separate set.
  assert.equal(store.subscribe('device-b', first), 1)
  assert.equal(store.subscriptionsFor('device-a').length, 2)
  assert.equal(store.subscriptionsFor('device-b').length, 1)
  assert.equal(store.subscriberCount(), 2)
  assert.equal(store.hasSubscribers(), true)

  // The store round-trips through its file, so a restart keeps a device subscribed.
  const reloaded = loadWebPushSubscriptions(directory)
  const restored = createWebPushStore({ byDevice: reloaded.byDevice, file: reloaded.file })
  assert.deepEqual(restored.subscriptionsFor('device-a').map((entry) => entry.endpoint).sort(),
    [first.endpoint, second.endpoint].sort())
  assert.equal(restored.subscriptionsFor('device-a')[0].keys.p256dh.length > 0, true)

  // Unsubscribe removes one, then all; unsubscribe is idempotent.
  assert.equal(restored.unsubscribe('device-a', first.endpoint), 1)
  assert.equal(restored.unsubscribe('device-a', first.endpoint), 0, 'unsubscribing twice is not an error')
  assert.equal(restored.unsubscribe('device-a'), 1, 'omitting the endpoint drops the rest')
  assert.deepEqual(restored.subscriptionsFor('device-a'), [])

  // A device cannot fill the store without bound.
  for (let index = 0; index < 20; index += 1) {
    restored.subscribe('device-c', subscription(`https://abc123.push.services.mozilla.com/wpush/v2/${index}`))
  }
  assert.ok(restored.subscriptionsFor('device-c').length <= 8, 'per-device subscription count is bounded')
  // Forgetting a device drops its subscriptions and its rate-limit window.
  assert.ok(restored.forgetDevice('device-c') > 0)
  assert.deepEqual(restored.subscriptionsFor('device-c'), [])
})

test('the hourly budget is 30 per device and a refused push costs nothing', () => {
  let now = 1_700_000_000_000
  const directory = tempDir()
  const loaded = loadWebPushSubscriptions(directory)
  const store = createWebPushStore({ byDevice: loaded.byDevice, file: loaded.file, now: () => now })
  for (let index = 0; index < contract.WEB_PUSH_RATE_LIMIT_PER_HOUR; index += 1) {
    assert.equal(store.withinRateLimit('device-a'), true, `push ${index + 1} must be allowed`)
    store.noteDelivery('device-a')
  }
  assert.equal(store.withinRateLimit('device-a'), false, 'the 31st push in the hour is refused')
  // Another device has its own window.
  assert.equal(store.withinRateLimit('device-b'), true)
  // The window rolls: an hour later the budget is back.
  now += 60 * 60_000 + 1
  assert.equal(store.withinRateLimit('device-a'), true)
})

test('the outbound queue collapses by sessionId', () => {
  const directory = tempDir()
  const loaded = loadWebPushSubscriptions(directory)
  const store = createWebPushStore({ byDevice: loaded.byDevice, file: loaded.file })
  const firstMessage = { sessionId: 's1' }
  const secondMessage = { sessionId: 's1' }
  store.enqueue('device-a', firstMessage)
  assert.equal(store.pendingCount('device-a'), 1)
  // A newer event for the SAME session replaces the older one.
  store.enqueue('device-a', secondMessage)
  assert.equal(store.pendingCount('device-a'), 1, 'one pending message per session')
  assert.equal(store.isCurrent('device-a', firstMessage), false, 'the older message is no longer current')
  assert.equal(store.isCurrent('device-a', secondMessage), true)
  // Settling the OLD one must not drop the newer.
  store.settle('device-a', firstMessage)
  assert.equal(store.pendingCount('device-a'), 1)
  store.settle('device-a', secondMessage)
  assert.equal(store.pendingCount('device-a'), 0)
  // A different session is a separate entry.
  store.enqueue('device-a', { sessionId: 's2' })
  store.enqueue('device-a', { sessionId: 's3' })
  assert.equal(store.pendingCount('device-a'), 2)
})

// ===========================================================================
// The payload allowlist and the owner switch
// ===========================================================================

test('webPushPayload emits exactly { v, kind, sessionId, requestId? }', () => {
  assert.deepEqual(webPushPayload({ kind: 'approval', sessionId: 's1', requestId: 'r1' }),
    { v: 1, kind: 'approval', sessionId: 's1', requestId: 'r1' })
  assert.deepEqual(webPushPayload({ kind: 'question', sessionId: 's1', requestId: 'r1' }),
    { v: 1, kind: 'question', sessionId: 's1', requestId: 'r1' })
  // `session-finished` never carries a request id, whatever the caller passes.
  assert.deepEqual(webPushPayload({ kind: 'session-finished', sessionId: 's1', requestId: 'r1' }),
    { v: 1, kind: 'session-finished', sessionId: 's1' })
  // Every field a payload could smuggle in is dropped: the builder copies names, it never spreads.
  const smuggled = webPushPayload({
    kind: 'approval', sessionId: 's1', requestId: 'r1',
    text: 'SECRET-PROMPT', toolName: 'bash', args: { path: '/etc/passwd' }, title: 'SECRET-TITLE', displayReason: { en: 'x' },
  })
  assert.deepEqual(Object.keys(smuggled).sort(), ['kind', 'requestId', 'sessionId', 'v'])
  const serialized = JSON.stringify(smuggled)
  for (const forbidden of ['SECRET-PROMPT', 'bash', '/etc/passwd', 'SECRET-TITLE']) {
    assert.equal(serialized.includes(forbidden), false, `${forbidden} must never enter a payload`)
  }
  // Unknown kinds and missing ids are not pushable at all.
  for (const event of [{ kind: 'approval' }, { kind: 'prompt', sessionId: 's1' }, { kind: 'approval', sessionId: '' },
    {}, null, 'approval']) {
    assert.equal(webPushPayload(event), undefined, JSON.stringify(event))
  }
})

/** A service over a fresh store, with a recording transport (no socket, no network). */
function serviceWith(options = {}) {
  const directory = tempDir()
  const loaded = loadWebPushSubscriptions(directory)
  const store = createWebPushStore({ byDevice: loaded.byDevice, file: loaded.file })
  const calls = []
  const vapid = generateVapidKeys()
  let enabled = options.enabled ?? true
  const service = createWebPushService({
    vapid,
    store,
    enabled: () => enabled,
    eventKinds: options.eventKinds,
    log: options.log,
    // The transport is the ONLY place a test replaces the network, and it records what would
    // have been sent so the assertions can inspect it exactly.
    transport: async (request) => {
      calls.push(request)
      return options.respond === undefined ? { status: 201 } : options.respond(request)
    },
  })
  return { service, store, calls, directory, setEnabled: (value) => { enabled = value }, vapid }
}

test('the owner switch OFF means zero outbound requests', async () => {
  const lines = []
  const { service, store, calls, setEnabled } = serviceWith({ enabled: false, log: (line) => lines.push(line) })
  const sub = subscription()
  store.subscribe('device-a', sub)
  assert.equal(service.enabled(), false)
  assert.equal(await service.notify({ kind: 'approval', sessionId: 's1', requestId: 'r1' }), 0)
  assert.equal(await service.notify({ kind: 'question', sessionId: 's1', requestId: 'r2' }), 0)
  assert.equal(await service.notify({ kind: 'session-finished', sessionId: 's1' }), 0)
  assert.deepEqual(calls, [], 'a disabled gateway must not send anything at all')
  // Nothing was even queued, so turning it on later sends nothing retroactively.
  assert.equal(store.pendingCount('device-a'), 0)

  // Enabled: the same event now goes out, which proves the guard was the switch and not a bug.
  setEnabled(true)
  assert.equal(await service.notify({ kind: 'approval', sessionId: 's1', requestId: 'r1' }), 1)
  assert.equal(calls.length, 1)
})

test('a per-kind toggle keeps the other kinds off the wire', async () => {
  const { service, store, calls } = serviceWith({ eventKinds: { question: false, 'session-finished': false } })
  store.subscribe('device-a', subscription())
  assert.equal(await service.notify({ kind: 'question', sessionId: 's1', requestId: 'r1' }), 0)
  assert.equal(await service.notify({ kind: 'session-finished', sessionId: 's1' }), 0)
  assert.deepEqual(calls, [])
  assert.equal(await service.notify({ kind: 'approval', sessionId: 's1', requestId: 'r1' }), 1)
  assert.equal(calls.length, 1)
})

test('a delivered push carries TTL 600, aes128gcm, VAPID and the high urgency rule', async () => {
  const { service, store, calls, vapid } = serviceWith()
  const sub = subscription()
  store.subscribe('device-a', sub)

  await service.notify({ kind: 'approval', sessionId: 's1', requestId: 'r1' })
  assert.equal(calls.length, 1)
  const [approval] = calls
  assert.equal(approval.url, sub.endpoint)
  assert.equal(approval.headers.TTL, '600', 'spec 026 R5: TTL 600 s')
  assert.equal(approval.headers['Content-Encoding'], 'aes128gcm')
  assert.equal(approval.headers.Urgency, 'high', 'an approval wakes a sleeping device')
  // The VAPID header verifies with the Host's public key and names the endpoint ORIGIN.
  const token = approval.headers.Authorization.match(/^vapid t=([^,]+), k=(.+)$/)
  assert.ok(token, approval.headers.Authorization)
  assert.ok(token[2].endsWith(vapid.publicKey))
  const verified = verifyVapidToken(token[1], vapid.publicKey)
  assert.equal(verified.ok, true, JSON.stringify(verified))
  assert.equal(verified.claims.aud, new URL(sub.endpoint).origin)
  // The body decrypts with the SUBSCRIPTION's keys and holds the payload and nothing else.
  assert.deepEqual(readBody(approval.body, sub), { v: 1, kind: 'approval', sessionId: 's1', requestId: 'r1' })

  // The other two kinds are `normal` urgency and still decrypt with the subscription keys.
  await service.notify({ kind: 'question', sessionId: 's1', requestId: 'r2' })
  assert.equal(calls[1].headers.Urgency, 'normal')
  await service.notify({ kind: 'session-finished', sessionId: 's1' })
  assert.equal(calls[2].headers.Urgency, 'normal')
  assert.deepEqual(readBody(calls[2].body, sub), { v: 1, kind: 'session-finished', sessionId: 's1' })
  // Each message got its own salt and ephemeral key.
  assert.notDeepEqual(calls[0].body.subarray(0, 16), calls[1].body.subarray(0, 16))
})

test('a 410 (or 404) removes the subscription; other failures keep it', async () => {
  // 410 Gone: RFC 8030 §7.3 makes it permanent, so the record must go (spec 026 R2).
  const gone = serviceWith({ respond: () => ({ status: 410 }) })
  gone.store.subscribe('device-a', subscription())
  await gone.service.notify({ kind: 'approval', sessionId: 's1', requestId: 'r1' })
  assert.equal(gone.store.subscriptionsFor('device-a').length, 0, '410 must drop the subscription')
  // ...and the store file reflects it, so a restart does not resurrect it.
  const reloaded = loadWebPushSubscriptions(gone.directory)
  assert.equal(reloaded.byDevice.size, 0)

  const notFound = serviceWith({ respond: () => ({ status: 404 }) })
  notFound.store.subscribe('device-a', subscription())
  await notFound.service.notify({ kind: 'approval', sessionId: 's1', requestId: 'r1' })
  assert.equal(notFound.store.subscriptionsFor('device-a').length, 0, '404 must drop the subscription')

  // A transient failure (500, a timeout, a redirect) keeps it: the next event retries.
  for (const status of [500, 429, 302]) {
    const transient = serviceWith({ respond: () => ({ status }) })
    transient.store.subscribe('device-a', subscription())
    await transient.service.notify({ kind: 'approval', sessionId: 's1', requestId: 'r1' })
    assert.equal(transient.store.subscriptionsFor('device-a').length, 1, `status ${status} must keep the subscription`)
  }
})

test('a non-allowlisted endpoint is refused before a request exists', async () => {
  const { service, store, calls } = serviceWith()
  // A record written before this revision (or a hand-edited store) must not reach the network
  // either: the guard is on the delivery path, not only on the frame that stored it.
  store.subscribe('device-a', { endpoint: 'https://evil.example.com/push', keys: subscription().keys })
  assert.equal(await service.notify({ kind: 'approval', sessionId: 's1', requestId: 'r1' }), 1)
  assert.deepEqual(calls, [], 'no request may be made to a foreign host')
  // Every non-allowlisted shape is refused the same way.
  for (const endpoint of ['http://fcm.googleapis.com/fcm/send/x', 'https://fcm.googleapis.com:8443/x',
    'https://user:pw@fcm.googleapis.com/x', 'file:///etc/passwd', 'https://fcm.googleapis.com.evil.example/x']) {
    const refused = serviceWith()
    refused.store.subscribe('device-a', { endpoint, keys: subscription().keys })
    await refused.service.notify({ kind: 'approval', sessionId: 's1', requestId: 'r1' })
    assert.deepEqual(refused.calls, [], `${endpoint} must never be contacted`)
  }
})

test('the sender refuses an oversized payload instead of truncating it', async () => {
  const calls = []
  const vapid = generateVapidKeys()
  const sender = createWebPushSender({
    vapid,
    transport: async (request) => { calls.push(request); return { status: 201 } },
  })
  const sub = subscription()
  const oversized = { v: 1, kind: 'approval', sessionId: 's', padding: 'x'.repeat(WEB_PUSH_MAX_PAYLOAD_BYTES) }
  const outcome = await sender.send({ endpoint: sub.endpoint, keys: sub.keys, payload: oversized })
  assert.equal(outcome.ok, false)
  assert.equal(outcome.reason, 'payload-too-large')
  assert.deepEqual(calls, [])
  // A payload that fits still goes out.
  assert.equal((await sender.send({ endpoint: sub.endpoint, keys: sub.keys, payload: { v: 1, kind: 'approval', sessionId: 's' } })).ok, true)
  assert.equal(calls.length, 1)
})

test('a subscription whose keys cannot decrypt is dropped like a 410', async () => {
  const { service, store, calls } = serviceWith()
  // 65 bytes of zero is a syntactically valid length but not a point on the curve.
  store.subscribe('device-a', { endpoint: subscription().endpoint, keys: { p256dh: Buffer.alloc(65, 0).toString('base64url'), auth: crypto.randomBytes(16).toString('base64url') } })
  await service.notify({ kind: 'approval', sessionId: 's1', requestId: 'r1' })
  assert.deepEqual(calls, [], 'nothing is sent to a subscription that could never read it')
  assert.equal(store.subscriptionsFor('device-a').length, 0, 'an unusable record is removed')
})

test('pair, subscribe, revoke: the subscription is removed and nothing is sent', async () => {
  const { createRegistry } = await import('../lib/devices.js')
  const { service, store, calls, directory } = serviceWith()
  const registry = createRegistry(path.join(directory, 'devices.json'), { pairingTtlMs: 60_000 })
  const claimed = registry.claimPairing(registry.createPairing('Phone').code, 'aaaa0000-0000-4000-8000-000000000001', 'Phone')
  const deviceId = claimed.device.id
  store.subscribe(deviceId, subscription())
  assert.equal(store.subscriptionsFor(deviceId).length, 1)

  // The revoke route: registry.revoke + forgetWebPushDevice (store.forgetDevice).
  assert.equal(registry.revoke(deviceId), true)
  assert.equal(store.forgetDevice(deviceId), 1)
  assert.deepEqual(store.subscriptionsFor(deviceId), [])
  assert.equal(await service.notify({ kind: 'approval', sessionId: 's1', requestId: 'r1' }), 0)
  assert.deepEqual(calls, [], 'a revoked device receives no push')
  assert.equal(loadWebPushSubscriptions(directory).byDevice.size, 0, 'the file does not resurrect it')

  // Revoked while no store was loaded: the load-time prune against the live registry drops it.
  const second = registry.claimPairing(registry.createPairing('Phone 2').code, 'aaaa0000-0000-4000-8000-000000000002', 'Phone 2')
  store.subscribe(second.device.id, subscription())
  registry.revoke(second.device.id)
  const reloaded = loadWebPushSubscriptions(directory)
  const restored = createWebPushStore({ byDevice: reloaded.byDevice, file: reloaded.file })
  assert.equal(restored.pruneDevices(registry.list().map((device) => device.id)), true)
  assert.deepEqual(restored.subscriptionsFor(second.device.id), [])
  assert.equal(loadWebPushSubscriptions(directory).byDevice.size, 0)
})
