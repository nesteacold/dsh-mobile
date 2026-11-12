// Spec 021 (contract revision 14) — the web passkey unlock, UNIT level.
//
// The gateway-side WebAuthn rules (`lib/webauthn.mjs`) and the state that changes
// (`lib/passkey.mjs`: store, challenges, lock state, approvals, rate limits) are checked here
// with REAL P-256 / RSA keys generated per run, real signatures and real CBOR documents, so a
// broken check shows up as an accepted forgery or a refused genuine proof rather than as an
// opinion. The wire-level adversarial list (replayed challenge, wrong origin, locked requests,
// revocation …) lives in `test/passkey-adversarial.test.mjs`, which drives the assembled gateway
// over its real TLS listener.
import assert from 'node:assert/strict'
import crypto from 'node:crypto'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { test } from 'node:test'

import * as contract from '@dsh-ext/mobile-protocol'
import {
  coseToKeyObject,
  decodeBase64url,
  decodeCbor,
  encodeBase64url,
  originHostname,
  PasskeyVerificationError,
  verifyAssertion,
  verifyRegistration,
} from '../lib/webauthn.mjs'
import {
  createPasskeyLock,
  createPasskeyService,
  loadPasskeyStore,
  PASSKEY_APPROVAL_TTL_MS,
  PASSKEY_CODES,
  PASSKEY_FIXED_MESSAGES,
  PasskeyRefusal,
  PASSKEY_STORE_FILE,
} from '../lib/passkey.mjs'
import { setOwnerOnlyProbeOverride } from '../lib/secure-file.mjs'

const ORIGIN = 'https://host.example.test:18443'
const RP_ID = 'host.example.test'
/** The 16-byte AAGUID every authenticator sends in attested credential data (zero = "none"). */
const AAGUID = Buffer.alloc(16, 0)
const delay = (ms) => new Promise((resolve) => setTimeout(resolve, ms))

// ---------------------------------------------------------------------------
// A minimal CBOR writer (test side): maps with text/integer keys, byte strings, integers,
// booleans and arrays — exactly what the gateway's decoder accepts.
// ---------------------------------------------------------------------------

function cborHead(major, length) {
  if (length < 24) return Buffer.from([(major << 5) | length])
  if (length < 0x100) return Buffer.from([(major << 5) | 24, length])
  if (length < 0x10000) {
    const head = Buffer.from([(major << 5) | 25, 0, 0])
    head.writeUInt16BE(length, 1)
    return head
  }
  const head = Buffer.from([(major << 5) | 26, 0, 0, 0, 0])
  head.writeUInt32BE(length, 1)
  return head
}

function cbor(value) {
  if (Number.isSafeInteger(value)) return value >= 0 ? cborHead(0, value) : cborHead(1, -1 - value)
  if (value === true) return Buffer.from([0xf5])
  if (value === false) return Buffer.from([0xf4])
  if (Buffer.isBuffer(value)) return Buffer.concat([cborHead(2, value.length), value])
  if (typeof value === 'string') {
    const bytes = Buffer.from(value, 'utf8')
    return Buffer.concat([cborHead(3, bytes.length), bytes])
  }
  if (Array.isArray(value)) return Buffer.concat([cborHead(4, value.length), ...value.map(cbor)])
  const entries = [...value].map(([key, entry]) => Buffer.concat([cbor(key), cbor(entry)]))
  return Buffer.concat([cborHead(5, entries.length), ...entries])
}

// ---------------------------------------------------------------------------
// Authenticators (real keys, real signatures)
// ---------------------------------------------------------------------------

/** A genuine ES256 authenticator: P-256 key, COSE public key, signatures over the real input. */
function es256Authenticator(signCount = 1) {
  const { privateKey, publicKey } = crypto.generateKeyPairSync('ec', { namedCurve: 'P-256' })
  const jwk = publicKey.export({ format: 'jwk' })
  const cose = cbor(new Map([
    [1, 2], [3, -7], [-1, 1],
    [-2, Buffer.from(jwk.x, 'base64url')], [-3, Buffer.from(jwk.y, 'base64url')],
  ]))
  return authenticatorWith(privateKey, cose, signCount)
}

/** A genuine RS256 authenticator: a 2048-bit RSA key. */
function rs256Authenticator(signCount = 1) {
  const { privateKey, publicKey } = crypto.generateKeyPairSync('rsa', { modulusLength: 2048 })
  const jwk = publicKey.export({ format: 'jwk' })
  const cose = cbor(new Map([[1, 3], [3, -257], [-1, Buffer.from(jwk.n, 'base64url')], [-2, Buffer.from(jwk.e, 'base64url')]]))
  return authenticatorWith(privateKey, cose, signCount)
}

function authenticatorWith(privateKey, cose, signCount) {
  const credentialId = crypto.randomBytes(32)
  const sign = (data) => crypto.sign('sha256', data, privateKey)
  return {
    credentialId,
    cose,
    sign,
    algorithm: cose[0] === 0x02 ? 'ec' : 'rsa',
    /** An `attestationObject` (fmt none) for the current credential. */
    attestationObject({ rpId = RP_ID, flags = 0x45, challenge, origin = ORIGIN, type = 'webauthn.create', counter = signCount } = {}) {
      const idLength = Buffer.from([0, 0])
      idLength.writeUInt16BE(credentialId.length, 0)
      // authData = rpIdHash(32) + flags(1) + signCount(4) + AAGUID(16) + credentialIdLength(2)
      //            + credentialId + COSE key (WebAuthn §6.5.2: the AAGUID is part of the layout,
      // so a fixture without it is not what any browser sends — and not what the gateway reads).
      const full = Buffer.concat([
        crypto.createHash('sha256').update(rpId, 'utf8').digest(),
        Buffer.from([flags]),
        uint32(counter),
        AAGUID,
        idLength,
        credentialId,
        cose,
      ])
      return cbor(new Map([
        ['fmt', 'none'],
        ['attStmt', new Map()],
        ['authData', full],
        ['type', 'public-key'],
      ]))
    },
    clientData(challenge, { origin = ORIGIN, type = 'webauthn.create' } = {}) {
      return Buffer.from(JSON.stringify({ type, challenge, origin, crossOrigin: false }), 'utf8')
    },
    /** A full registration payload the gateway should accept. */
    registration(challenge, options = {}) {
      return {
        id: encodeBase64url(credentialId),
        rawId: encodeBase64url(credentialId),
        clientDataJSON: encodeBase64url(this.clientData(challenge, options)),
        attestationObject: encodeBase64url(this.attestationObject({ ...options, challenge })),
      }
    },
    /** A full assertion payload signed over `authData || SHA-256(clientDataJSON)`. */
    assertion(challenge, { origin = ORIGIN, type = 'webauthn.get', rpId = RP_ID, flags = 0x05, counter = signCount + 1, credentialId: id = credentialId, signWith = null } = {}) {
      const clientDataJSON = this.clientData(challenge, { origin, type })
      const authData = Buffer.concat([
        crypto.createHash('sha256').update(rpId, 'utf8').digest(),
        Buffer.from([flags]),
        uint32(counter),
      ])
      const digest = crypto.createHash('sha256').update(clientDataJSON).digest()
      const signature = signWith === null ? this.sign(Buffer.concat([authData, digest])) : signWith(Buffer.concat([authData, digest]))
      return {
        id: encodeBase64url(id),
        rawId: encodeBase64url(id),
        clientDataJSON: encodeBase64url(clientDataJSON),
        authenticatorData: encodeBase64url(authData),
        signature: encodeBase64url(signature),
      }
    },
  }
}

function uint32(value) {
  const bytes = Buffer.from([0, 0, 0, 0])
  bytes.writeUInt32BE(value >>> 0, 0)
  return bytes
}

/** What `verifyRegistration` stores for one authenticated registration. */
function storedFrom(authenticator, challenge, options = {}) {
  const stored = verifyRegistration({ attestation: authenticator.registration(challenge, options), challenge, origin: ORIGIN, rpId: RP_ID })
  return { credentialId: stored.credentialId, publicKey: stored.publicKey, signCount: stored.signCount }
}

/** Assert a verification refuses, and that it refuses with the wire code, never a detail. */
function refuses(run) {
  assert.throws(run, (error) => {
    assert.ok(error instanceof PasskeyVerificationError, `expected a verification error, got ${error?.name}: ${error?.message}`)
    assert.equal(error.code, 'passkey/verification-failed')
    assert.equal(error.message.includes('challenge'), false, 'the message names no check')
    return true
  })
}

// ---------------------------------------------------------------------------
// (1) Registration
// ---------------------------------------------------------------------------

test('P1 ES256 registration verifies, stores the credential id and the COSE key', () => {
  const authenticator = es256Authenticator(3)
  const challenge = 'chal-register-es256'
  const stored = verifyRegistration({
    attestation: authenticator.registration(challenge),
    challenge,
    origin: ORIGIN,
    rpId: RP_ID,
  })
  assert.equal(stored.credentialId, encodeBase64url(authenticator.credentialId))
  assert.equal(decodeBase64url(stored.publicKey).equals(authenticator.cose), true, 'the stored key is the attested COSE key')
  assert.equal(stored.signCount, 3)
})

test('P2 RS256 registration verifies too (the second contracted algorithm)', () => {
  const authenticator = rs256Authenticator(2)
  const challenge = 'chal-register-rs256'
  const stored = verifyRegistration({ attestation: authenticator.registration(challenge), challenge, origin: ORIGIN, rpId: RP_ID })
  assert.equal(stored.credentialId, encodeBase64url(authenticator.credentialId))
  assert.equal(coseToKeyObject(stored.publicKey).algorithm, -257)
})

test('P3 registration refuses UP=0, UV=0 and a wrong rpIdHash', () => {
  const authenticator = es256Authenticator(1)
  const challenge = 'chal-flags'
  refuses(() => verifyRegistration({ attestation: authenticator.registration(challenge, { flags: 0x41 }), challenge, origin: ORIGIN, rpId: RP_ID }))
  refuses(() => verifyRegistration({ attestation: authenticator.registration(challenge, { flags: 0x01 }), challenge, origin: ORIGIN, rpId: RP_ID }))
  refuses(() => verifyRegistration({ attestation: authenticator.registration(challenge, { flags: 0x00 }), challenge, origin: ORIGIN, rpId: RP_ID }))
  refuses(() => verifyRegistration({ attestation: authenticator.registration(challenge, { rpId: 'evil.example.test' }), challenge, origin: ORIGIN, rpId: RP_ID }))
})

test('P4 registration refuses a wrong challenge, a wrong origin, and a `get` ceremony (replay/composition)', () => {
  const authenticator = es256Authenticator(1)
  const challenge = 'chal-compose'
  refuses(() => verifyRegistration({ attestation: authenticator.registration('chal-other'), challenge, origin: ORIGIN, rpId: RP_ID }))
  refuses(() => verifyRegistration({ attestation: authenticator.registration(challenge, { origin: 'https://evil.example.test' }), challenge, origin: ORIGIN, rpId: RP_ID }))
  refuses(() => verifyRegistration({ attestation: authenticator.registration(challenge, { type: 'webauthn.get' }), challenge, origin: ORIGIN, rpId: RP_ID }))
  // A suffix of the challenge is not the challenge.
  refuses(() => verifyRegistration({ attestation: authenticator.registration(challenge.slice(0, -1)), challenge, origin: ORIGIN, rpId: RP_ID }))
})

test('P5 registration refuses a mismatched rawId, `id` != `rawId`, and an AT-less authData', () => {
  const authenticator = es256Authenticator(1)
  const challenge = 'chal-rawid'
  const registration = authenticator.registration(challenge)
  refuses(() => verifyRegistration({ attestation: { ...registration, rawId: encodeBase64url(crypto.randomBytes(32)) }, challenge, origin: ORIGIN, rpId: RP_ID }))
  refuses(() => verifyRegistration({ attestation: { ...registration, id: `${registration.id}x` }, challenge, origin: ORIGIN, rpId: RP_ID }))
  // flags without AT (0x05 instead of 0x45): no attested credential data at all.
  refuses(() => verifyRegistration({ attestation: authenticator.registration(challenge, { flags: 0x05 }), challenge, origin: ORIGIN, rpId: RP_ID }))
})

test('P6 only attestation format `none` with an empty attStmt is accepted', () => {
  const authenticator = es256Authenticator(1)
  const challenge = 'chal-fmt'
  const good = authenticator.attestationObject({ challenge })
  const doc = decodeCbor(good)
  const packed = cbor(new Map([['fmt', 'packed'], ['attStmt', new Map()], ['authData', doc.get('authData')]]))
  refuses(() => verifyRegistration({ attestation: { ...authenticator.registration(challenge), attestationObject: encodeBase64url(packed) }, challenge, origin: ORIGIN, rpId: RP_ID }))
  const extra = cbor(new Map([['fmt', 'none'], ['attStmt', new Map([['x5c', [Buffer.from([1])]]])], ['authData', doc.get('authData')]]))
  refuses(() => verifyRegistration({ attestation: { ...authenticator.registration(challenge), attestationObject: encodeBase64url(extra) }, challenge, origin: ORIGIN, rpId: RP_ID }))
})

test('P7 unsupported or inconsistent COSE keys are refused (P-384, wrong alg, off-curve)', () => {
  const challenge = 'chal-cose'
  // P-384 key claiming ES256.
  const p384 = crypto.generateKeyPairSync('ec', { namedCurve: 'P-384' }).publicKey.export({ format: 'jwk' })
  const wrongCurve = cbor(new Map([[1, 2], [3, -7], [-1, 2], [-2, Buffer.from(p384.x, 'base64url')], [-3, Buffer.from(p384.y, 'base64url')]]))
  refuses(() => coseToKeyObject(encodeBase64url(wrongCurve)))
  // EC key claiming RS256.
  const ec = crypto.generateKeyPairSync('ec', { namedCurve: 'P-256' }).publicKey.export({ format: 'jwk' })
  const wrongAlg = cbor(new Map([[1, 2], [3, -257], [-1, 1], [-2, Buffer.from(ec.x, 'base64url')], [-3, Buffer.from(ec.y, 'base64url')]]))
  refuses(() => coseToKeyObject(encodeBase64url(wrongAlg)))
  // A point that is not on P-256 (x = y = 1).
  const offCurve = cbor(new Map([[1, 2], [3, -7], [-1, 1], [-2, Buffer.alloc(32, 1)], [-3, Buffer.alloc(32, 1)]]))
  refuses(() => coseToKeyObject(encodeBase64url(offCurve)))
  // An RSA key below 2048 bits.
  const smallRsa = crypto.generateKeyPairSync('rsa', { modulusLength: 1024 }).publicKey.export({ format: 'jwk' })
  const weak = cbor(new Map([[1, 3], [3, -257], [-1, Buffer.from(smallRsa.n, 'base64url')], [-2, Buffer.from(smallRsa.e, 'base64url')]]))
  refuses(() => coseToKeyObject(encodeBase64url(weak)))
})

test('P8 malformed CBOR, non-canonical base64url and a fenced garbage document are refusals, not crashes', () => {
  refuses(() => decodeBase64url('not base64url!'))
  refuses(() => decodeBase64url('abc=')) // padded
  refuses(() => decodeBase64url(''))
  refuses(() => decodeBase64url(42))
  refuses(() => decodeCbor(Buffer.from([0x81]))) // an array, not a map
  refuses(() => decodeCbor(Buffer.from([0xa0, 0x00]))) // trailing bytes after the document
  refuses(() => decodeCbor(Buffer.from([0xbf]))) // indefinite map
  refuses(() => decodeCbor(Buffer.from([])))
  const authenticator = es256Authenticator(1)
  refuses(() => verifyRegistration({
    attestation: { ...authenticator.registration('chal'), attestationObject: encodeBase64url(Buffer.from('garbage')) },
    challenge: 'chal', origin: ORIGIN, rpId: RP_ID,
  }))
  // A clientDataJSON that is not a JSON object.
  refuses(() => verifyRegistration({
    attestation: { ...authenticator.registration('chal'), clientDataJSON: encodeBase64url(Buffer.from('[]')) },
    challenge: 'chal', origin: ORIGIN, rpId: RP_ID,
  }))
})

test('P14 attested credential data is read at the standard layout: the 16-byte AAGUID comes first', () => {
  const authenticator = es256Authenticator(1)
  const challenge = 'chal-aaguid'
  // The genuine layout (AAGUID + length + id + key) verifies.
  assert.equal(verifyRegistration({ attestation: authenticator.registration(challenge), challenge, origin: ORIGIN, rpId: RP_ID })
    .credentialId, encodeBase64url(authenticator.credentialId))
  // A fixture WITHOUT the AAGUID is what the old code (and the old fixtures) assumed: it must now
  // be refused rather than silently read the AAGUID bytes as a length.
  const legacy = authenticator.attestationObject({ challenge })
  const doc = decodeCbor(legacy)
  const authData = doc.get('authData')
  const withoutAaguid = Buffer.concat([authData.subarray(0, 37), authData.subarray(37, 37 + 2), authData.subarray(37 + 16)])
  refuses(() => verifyRegistration({
    attestation: { ...authenticator.registration(challenge), attestationObject: encodeBase64url(cbor(new Map([
      ['fmt', 'none'], ['attStmt', new Map()], ['authData', withoutAaguid], ['type', 'public-key'],
    ]))) },
    challenge, origin: ORIGIN, rpId: RP_ID,
  }))
  // A truncated AAGUID (fewer than 18 bytes of attested credential data) is a refusal, not a crash.
  refuses(() => verifyRegistration({
    attestation: { ...authenticator.registration(challenge), attestationObject: encodeBase64url(cbor(new Map([
      ['fmt', 'none'], ['attStmt', new Map()], ['authData', authData.subarray(0, 45)], ['type', 'public-key'],
    ]))) },
    challenge, origin: ORIGIN, rpId: RP_ID,
  }))
})

// ---------------------------------------------------------------------------
// (2) Assertion
// ---------------------------------------------------------------------------

test('P9 a genuine assertion verifies and the counter moves to the presented value', () => {
  const authenticator = es256Authenticator(4)
  const stored = storedFrom(authenticator, 'chal-reg')
  const result = verifyAssertion({ assertion: authenticator.assertion('chal-assert', { counter: 5 }), stored, challenge: 'chal-assert', origin: ORIGIN, rpId: RP_ID })
  assert.deepEqual(result, { signCount: 5 })
})

test('P10 a bad signature, a tampered authData and a foreign key are all refused', () => {
  const authenticator = es256Authenticator(4)
  const stored = storedFrom(authenticator, 'chal-reg')
  const challenge = 'chal-tamper'
  refuses(() => verifyAssertion({
    assertion: authenticator.assertion(challenge, { signWith: () => Buffer.alloc(64, 7) }), stored, challenge, origin: ORIGIN, rpId: RP_ID,
  }))
  const good = authenticator.assertion(challenge)
  const authData = decodeBase64url(good.authenticatorData)
  authData[32] ^= 0x01 // flip UP
  refuses(() => verifyAssertion({ assertion: { ...good, authenticatorData: encodeBase64url(authData) }, stored, challenge, origin: ORIGIN, rpId: RP_ID }))
  // Another key signing over the right input: the stored key is the authority.
  const other = es256Authenticator(4)
  refuses(() => verifyAssertion({
    assertion: other.assertion(challenge, { credentialId: authenticator.credentialId }), stored, challenge, origin: ORIGIN, rpId: RP_ID,
  }))
})

test('P11 wrong origin, wrong rpId, UV=0, `create` ceremony, another device\'s credential id — all refused', () => {
  const authenticator = es256Authenticator(4)
  const stored = storedFrom(authenticator, 'chal-reg')
  const challenge = 'chal-origin'
  const cases = [
    { origin: 'https://host.example.test' }, // different port: not the exact origin
    { origin: 'http://host.example.test:18443' }, // different scheme
    { origin: 'https://evil.example.test:18443' },
    { rpId: 'other.example.test' },
    { flags: 0x01 }, // UP only, no UV
    { flags: 0x04 }, // UV only, no UP
    { type: 'webauthn.create' },
  ]
  for (const options of cases) {
    refuses(() => verifyAssertion({ assertion: authenticator.assertion(challenge, options), stored, challenge, origin: ORIGIN, rpId: RP_ID }))
  }
  // Another device's credential id never matches this device's stored key.
  refuses(() => verifyAssertion({
    assertion: authenticator.assertion(challenge, { credentialId: crypto.randomBytes(32) }), stored, challenge, origin: ORIGIN, rpId: RP_ID,
  }))
  const foreign = es256Authenticator(4)
  refuses(() => verifyAssertion({ assertion: foreign.assertion(challenge), stored, challenge, origin: ORIGIN, rpId: RP_ID }))
})

test('P12 the sign counter is monotonic when both values are non-zero', () => {
  const authenticator = es256Authenticator(6)
  const stored = storedFrom(authenticator, 'chal-reg')
  const challenge = 'chal-counter'
  // A regression and an equal value are refused.
  refuses(() => verifyAssertion({ assertion: authenticator.assertion(challenge, { counter: 5 }), stored, challenge, origin: ORIGIN, rpId: RP_ID }))
  refuses(() => verifyAssertion({ assertion: authenticator.assertion(challenge, { counter: 6 }), stored, challenge, origin: ORIGIN, rpId: RP_ID }))
  assert.equal(verifyAssertion({ assertion: authenticator.assertion(challenge, { counter: 7 }), stored, challenge, origin: ORIGIN, rpId: RP_ID }).signCount, 7)
  // A presented 0 (an authenticator that does not count) is not a regression: nothing to compare.
  assert.equal(verifyAssertion({ assertion: authenticator.assertion(challenge, { counter: 0 }), stored, challenge, origin: ORIGIN, rpId: RP_ID }).signCount, stored.signCount)
  // A stored 0 has nothing to compare either, and keeps the previous value.
  assert.equal(verifyAssertion({ assertion: authenticator.assertion(challenge, { counter: 2 }), stored: { ...stored, signCount: 0 }, challenge, origin: ORIGIN, rpId: RP_ID }).signCount, 2)
})

test('P13 an assertion only ever means a `get`, and an unparsable origin hostname is refused', () => {
  assert.equal(originHostname(ORIGIN), RP_ID)
  assert.equal(originHostname('https://host.example.test:18443/ws/mobile'), undefined)
  assert.equal(originHostname('https://user:pass@host.example.test:18443'), undefined)
  assert.equal(originHostname('not a url'), undefined)
  assert.equal(originHostname(''), undefined)
  const authenticator = es256Authenticator(1)
  const stored = storedFrom(authenticator, 'chal-reg')
  const challenge = 'chal-get'
  refuses(() => verifyAssertion({ assertion: authenticator.assertion(challenge, { type: 'webauthn.create' }), stored, challenge, origin: ORIGIN, rpId: RP_ID }))
  // AT set on an assertion (an attested-credential blob smuggled into authData).
  refuses(() => verifyAssertion({ assertion: authenticator.assertion(challenge, { flags: 0x45 }), stored: stored, challenge, origin: ORIGIN, rpId: RP_ID }))
})

// ---------------------------------------------------------------------------
// (3) The stored record, the lock state, approvals and rate limits
// ---------------------------------------------------------------------------

function serviceFixture(t, options = {}) {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'dsh-passkey-'))
  // The store's owner-only check shells out to PowerShell on Windows; the fixture directory was
  // created by this process seconds ago, so the real probe would only cost seconds.
  setOwnerOnlyProbeOverride(() => null)
  t.after(() => setOwnerOnlyProbeOverride(undefined))
  t.after(() => fs.rmSync(directory, { recursive: true, force: true }))
  const file = path.join(directory, PASSKEY_STORE_FILE)
  const loaded = loadPasskeyStore(file)
  const devices = [
    { id: 'd-web-1', name: 'Web browser' },
    { id: 'd-web-2', name: 'Second browser' },
    ...Array.from({ length: 6 }, (_, index) => ({ id: `d-global-${index}`, name: `Global ${index}` })),
  ]
  const changed = []
  const settled = []
  const lines = []
  let clock = 1_000_000
  const service = createPasskeyService({
    records: loaded.records,
    file,
    listDevices: options.listDevices ?? (() => devices),
    allowedOrigins: [ORIGIN],
    gatewayName: 'Test Host',
    onPasskeyChanged: (deviceId) => changed.push(deviceId),
    onApprovalSettled: () => settled.push(true),
    log: (line) => lines.push(line),
    now: () => clock,
  })
  return {
    service,
    file,
    lines,
    changed,
    settled,
    devices,
    advance: (ms) => { clock += ms },
    now: () => clock,
  }
}

/**
 * A socket-shaped stand-in. The gateway hands the service a real connection whose per-socket
 * lock record sits on `passkeySlot` (`stateKey` + `approvalToken`), so a real socket and a
 * fixture differ only in the `origin` the request carried.
 */
function fakeSocket(origin = ORIGIN, slot = null) {
  return { origin, passkeySlot: slot ?? { stateKey: crypto.randomUUID(), approvalToken: null } }
}

test('S1 the passkey store is owner-only JSON with hashed device keys and nothing else', (t) => {
  const fixture = serviceFixture(t)
  const authenticator = es256Authenticator(1)
  const socket = fakeSocket()
  const device = { id: 'd-web-1', name: 'Web browser' }
  const options = fixture.service.registrationOptions(socket, device, fixture.service.siteFor(socket))
  assert.equal(options.kind, 'passkey-register-options')
  assert.equal(options.rp.id, RP_ID)
  assert.deepEqual(options.pubKeyCredParams, [{ type: 'public-key', alg: -7 }, { type: 'public-key', alg: -257 }])
  assert.deepEqual(options.excludeCredentials, [])
  assert.equal(options.timeout, contract.PASSKEY_CHALLENGE_TTL_MS)
  assert.equal(fixture.service.register(socket, device, fixture.service.siteFor(socket), authenticator.registration(options.challenge)).ok, true)
  const stored = JSON.parse(fs.readFileSync(fixture.file, 'utf8'))
  assert.deepEqual(Object.keys(stored.records[0]).sort(), ['createdAt', 'credentialId', 'deviceHash', 'publicKey', 'signCount'])
  assert.equal(stored.records[0].deviceHash.length, 64)
  assert.equal(JSON.stringify(stored).includes('d-web-1'), false, 'the raw device id is never in the file')
  assert.equal(fixture.service.hasPasskey('d-web-1'), true)
  assert.equal(fixture.service.hasPasskey('d-web-2'), false)
  // The log names the event and the device, never a credential id / key / challenge.
  for (const line of fixture.lines) {
    assert.equal(line.includes(stored.records[0].credentialId), false)
    assert.equal(line.includes(stored.records[0].publicKey), false)
    assert.equal(line.includes(authenticator.registration('x').attestationObject), false)
  }
})

test('S2 a challenge is single-use, 60 s, and bound to the socket that asked for it', (t) => {
  const fixture = serviceFixture(t)
  const authenticator = es256Authenticator(1)
  const device = { id: 'd-web-1', name: 'Web browser' }
  const socketA = fakeSocket()
  const socketB = fakeSocket()
  const optionsA = fixture.service.registrationOptions(socketA, device, fixture.service.siteFor(socketA))
  // B never asked: A's challenge is not B's to answer.
  assert.throws(() => fixture.service.register(socketB, device, fixture.service.siteFor(socketB), authenticator.registration(optionsA.challenge)), PasskeyRefusal)
  // A's first answer consumes the challenge: a replay of the same answer expires.
  assert.equal(fixture.service.register(socketA, device, fixture.service.siteFor(socketA), authenticator.registration(optionsA.challenge)).ok, true, 'A answers its own challenge')
  // A fresh socket replaying A's old registration is refused: it has no live challenge (the
  // challenge is bound to the socket that asked, not to the device).
  const again = fakeSocket()
  assert.throws(() => fixture.service.register(again, { id: 'd-web-2', name: 'x' }, fixture.service.siteFor(again), authenticator.registration(optionsA.challenge)),
    (error) => error instanceof PasskeyRefusal && error.code === PASSKEY_CODES.challengeExpired)

  // 60 s: an options answer issued then answered after the TTL is expired.
  const socketC = fakeSocket()
  const optionsC = fixture.service.registrationOptions(socketC, { id: 'd-web-2', name: 'y' }, fixture.service.siteFor(socketC))
  fixture.advance(contract.PASSKEY_CHALLENGE_TTL_MS)
  assert.throws(() => fixture.service.register(socketC, { id: 'd-web-2', name: 'y' }, fixture.service.siteFor(socketC), authenticator.registration(optionsC.challenge)),
    (error) => error instanceof PasskeyRefusal && error.code === PASSKEY_CODES.challengeExpired)
})

test('S3 a foreign origin or an origin outside allowedOrigins never gets a challenge', (t) => {
  const fixture = serviceFixture(t)
  const device = { id: 'd-web-1', name: 'Web browser' }
  for (const origin of ['https://evil.example.test:18443', '', 'https://host.example.test:18443/path']) {
    const socket = fakeSocket(origin)
    assert.throws(() => fixture.service.siteFor(socket), (error) => error instanceof PasskeyRefusal && error.code === PASSKEY_CODES.verificationFailed)
  }
})

test('S4 re-registration needs the owner: refused `already-registered` until this socket is approved, then a fresh registration replaces the key', (t) => {
  const fixture = serviceFixture(t)
  const first = es256Authenticator(1)
  const second = es256Authenticator(1)
  const device = { id: 'd-web-1', name: 'Web browser' }
  const socket = fakeSocket()
  const options = fixture.service.registrationOptions(socket, device, fixture.service.siteFor(socket))
  fixture.service.register(socket, device, fixture.service.siteFor(socket), first.registration(options.challenge))

  const again = fixture.service.registrationOptions(socket, device, fixture.service.siteFor(socket))
  assert.deepEqual(again.excludeCredentials, [{ type: 'public-key', id: encodeBase64url(first.credentialId) }], 'the browser is offered the existing credential')
  assert.throws(() => fixture.service.register(socket, device, fixture.service.siteFor(socket), second.registration(again.challenge)),
    (error) => error instanceof PasskeyRefusal && error.code === PASSKEY_CODES.alreadyRegistered)
  const pending = fixture.service.pendingApprovals()
  assert.equal(pending.length, 1)
  assert.equal(pending[0].kind, 'passkey')
  assert.equal(pending[0].deviceId, 'd-web-1')
  assert.equal(pending[0].verificationCode.length, 8)
  // The owner-facing list carries no socket key and nothing to forge with.
  for (const field of ['key', 'stateKey', 'token']) assert.equal(Object.hasOwn(pending[0], field), false, field)

  // The requesting socket is told when the owner approves (the gateway sends `passkey-approval`).
  const decided = fixture.service.decideApproval(pending[0].id, 'approve')
  assert.equal(decided.action, 'approve')
  assert.equal(decided.stateKey, socket.passkeySlot.stateKey)

  // An approval is for the socket that asked: a second socket of the same device still needs its own.
  const stranger = fakeSocket()
  const strangerOptions = fixture.service.registrationOptions(stranger, device, fixture.service.siteFor(stranger))
  assert.throws(() => fixture.service.register(stranger, device, fixture.service.siteFor(stranger), second.registration(strangerOptions.challenge)),
    (error) => error instanceof PasskeyRefusal && error.code === PASSKEY_CODES.alreadyRegistered)

  const options3 = fixture.service.registrationOptions(socket, device, fixture.service.siteFor(socket))
  assert.equal(fixture.service.register(socket, device, fixture.service.siteFor(socket), second.registration(options3.challenge)).ok, true)
  assert.deepEqual(fixture.changed, ['d-web-1'], 'a replacement announces itself so the device\'s other sockets re-assert')
  // The stored key is the new one and the old key no longer verifies.
  const stored = JSON.parse(fs.readFileSync(fixture.file, 'utf8')).records[0]
  assert.equal(stored.credentialId, encodeBase64url(second.credentialId))
  const oldAssert = fixture.service.assertionOptions(fakeSocket(), device, fixture.service.siteFor(fakeSocket()))
  assert.throws(() => verifyAssertion({
    assertion: first.assertion(oldAssert.challenge, { credentialId: first.credentialId }),
    stored: { credentialId: stored.credentialId, publicKey: stored.publicKey, signCount: stored.signCount },
    challenge: oldAssert.challenge, origin: ORIGIN, rpId: RP_ID,
  }), PasskeyVerificationError)
})

test('S4b a rejected replacement leaves the old key in place', (t) => {
  const fixture = serviceFixture(t)
  const first = es256Authenticator(1)
  const device = { id: 'd-web-1', name: 'Web browser' }
  const socket = fakeSocket()
  const options = fixture.service.registrationOptions(socket, device, fixture.service.siteFor(socket))
  fixture.service.register(socket, device, fixture.service.siteFor(socket), first.registration(options.challenge))
  assert.throws(() => fixture.service.register(socket, device, fixture.service.siteFor(socket), first.registration(options.challenge)), PasskeyRefusal)
  const stillFirst = () => assert.throws(() => fixture.service.register(socket, device, fixture.service.siteFor(socket), first.registration(options.challenge)), PasskeyRefusal)
  stillFirst()
  assert.equal(fixture.service.pendingApprovals().length, 1)
  const decided = fixture.service.decideApproval(fixture.service.pendingApprovals()[0].id, 'reject')
  assert.equal(decided.action, 'reject')
  const stored = JSON.parse(fs.readFileSync(fixture.file, 'utf8')).records[0]
  assert.equal(stored.credentialId, encodeBase64url(first.credentialId), 'a rejected replacement never changes the stored key')
  // The device can still unlock with the old key.
  const socket2 = fakeSocket()
  const assertOptions = fixture.service.assertionOptions(socket2, device, fixture.service.siteFor(socket2))
  assert.equal(fixture.service.assert(socket2, device, fixture.service.siteFor(socket2), first.assertion(assertOptions.challenge, { counter: 2 })).unlocked, true)
})

test('S5 an approval expires after five minutes and cannot be used later', (t) => {
  const fixture = serviceFixture(t)
  const first = es256Authenticator(1)
  const device = { id: 'd-web-1', name: 'Web browser' }
  const socket = fakeSocket()
  const options = fixture.service.registrationOptions(socket, device, fixture.service.siteFor(socket))
  fixture.service.register(socket, device, fixture.service.siteFor(socket), first.registration(options.challenge))
  assert.throws(() => fixture.service.register(socket, device, fixture.service.siteFor(socket), first.registration(options.challenge)), PasskeyRefusal)
  assert.equal(fixture.service.pendingApprovals().length, 1)
  fixture.advance(PASSKEY_APPROVAL_TTL_MS + 1)
  assert.equal(fixture.service.pendingApprovals().length, 0)
  assert.equal(fixture.service.decideApproval('missing', 'approve'), undefined)
})

test('S6 five failed assertions in ten minutes lock the device out; another device is untouched', (t) => {
  const fixture = serviceFixture(t)
  const authenticator = es256Authenticator(2)
  const device = { id: 'd-web-1', name: 'Web browser' }
  const socket = fakeSocket()
  const options = fixture.service.registrationOptions(socket, device, fixture.service.siteFor(socket))
  fixture.service.register(socket, device, fixture.service.siteFor(socket), authenticator.registration(options.challenge))

  // Each failed attempt asks for a real challenge and answers it wrongly: a bad signature,
  // which is one counted failure per attempt.
  for (let round = 0; round < contract.PASSKEY_RATE_LIMITS.perDevice; round += 1) {
    const attempt = fakeSocket()
    const opts = fixture.service.assertionOptions(attempt, device, fixture.service.siteFor(attempt))
    assert.throws(() => fixture.service.assert(
      attempt, device, fixture.service.siteFor(attempt),
      authenticator.assertion(opts.challenge, { counter: 3, signWith: () => Buffer.alloc(64, 9) }),
    ), (error) => error instanceof PasskeyRefusal && error.code === PASSKEY_CODES.verificationFailed)
  }
  // The next attempt gets no options at all (nothing to answer), and an assertion without a
  // live challenge is refused too: the device is locked out before any verification.
  const attempt = fakeSocket()
  assert.throws(() => fixture.service.assertionOptions(attempt, device, fixture.service.siteFor(attempt)),
    (error) => error instanceof PasskeyRefusal && error.code === PASSKEY_CODES.rateLimited)
  assert.throws(() => fixture.service.assert(attempt, device, fixture.service.siteFor(attempt), authenticator.assertion('stale-challenge', { counter: 3 })),
    (error) => error instanceof PasskeyRefusal && error.code === PASSKEY_CODES.rateLimited)
  // Another device is not locked out by this device's failures.
  const other = { id: 'd-global-0', name: 'Global 0' }
  const otherSocket = fakeSocket()
  const otherAuth = es256Authenticator(1)
  const otherOptions = fixture.service.registrationOptions(otherSocket, other, fixture.service.siteFor(otherSocket))
  fixture.service.register(otherSocket, other, fixture.service.siteFor(otherSocket), otherAuth.registration(otherOptions.challenge))
  fixture.advance(contract.PASSKEY_RATE_LIMITS.perDeviceWindowMs)
  // After the window the device may assert again.
  const fresh = fixture.service.assertionOptions(socket, device, fixture.service.siteFor(socket))
  assert.equal(fixture.service.assert(socket, device, fixture.service.siteFor(socket), authenticator.assertion(fresh.challenge, { counter: 3 })).unlocked, true)
})

test('S7 thirty global failures in an hour lock every web device out, then the window passes', (t) => {
  const fixture = serviceFixture(t)
  // Ten distinct devices, three failed assertions each = 30. A single device would hit its own
  // limit at five, so the global window is what is being measured here.
  const authenticators = new Map()
  for (let index = 0; index < 10; index += 1) {
    const id = index < 6 ? `d-global-${index}` : `d-extra-${index}`
    fixture.devices.push({ id, name: id })
    const auth = es256Authenticator(1)
    authenticators.set(id, auth)
    const socket = fakeSocket()
    const options = fixture.service.registrationOptions(socket, { id, name: id }, fixture.service.siteFor(socket))
    fixture.service.register(socket, { id, name: id }, fixture.service.siteFor(socket), auth.registration(options.challenge))
  }
  let failures = 0
  for (let round = 0; round < 3; round += 1) {
    for (let index = 0; index < 10; index += 1) {
      const id = index < 6 ? `d-global-${index}` : `d-extra-${index}`
      const device = { id, name: id }
      const attempt = fakeSocket()
      const opts = fixture.service.assertionOptions(attempt, device, fixture.service.siteFor(attempt))
      assert.throws(() => fixture.service.assert(
        attempt, device, fixture.service.siteFor(attempt),
        authenticators.get(id).assertion(opts.challenge, { counter: 2, signWith: () => Buffer.alloc(64, 9) }),
      ), (error) => error instanceof PasskeyRefusal && error.code === PASSKEY_CODES.verificationFailed)
      failures += 1
    }
  }
  assert.equal(failures, contract.PASSKEY_RATE_LIMITS.global)
  // A device with budget left is now refused before any work happens.
  const first = { id: 'd-global-0', name: 'x' }
  const socket = fakeSocket()
  assert.throws(() => fixture.service.assertionOptions(socket, first, fixture.service.siteFor(socket)),
    (error) => error instanceof PasskeyRefusal && error.code === PASSKEY_CODES.rateLimited)
  // After an hour the window has passed and the device is usable again.
  fixture.advance(contract.PASSKEY_RATE_LIMITS.globalWindowMs)
  const after = fakeSocket()
  const opts = fixture.service.assertionOptions(after, first, fixture.service.siteFor(after))
  assert.equal(fixture.service.assert(after, first, fixture.service.siteFor(after), authenticators.get('d-global-0').assertion(opts.challenge, { counter: 2 })).unlocked, true)
})

test('S8 revocation deletes the record; the file keeps the other devices', (t) => {
  const fixture = serviceFixture(t)
  for (const id of ['d-web-1', 'd-web-2']) {
    const auth = es256Authenticator(1)
    const socket = fakeSocket()
    const device = { id, name: id }
    const options = fixture.service.registrationOptions(socket, device, fixture.service.siteFor(socket))
    fixture.service.register(socket, device, fixture.service.siteFor(socket), auth.registration(options.challenge))
  }
  assert.equal(fixture.service.revoke('d-web-1'), true)
  assert.equal(fixture.service.hasPasskey('d-web-1'), false)
  assert.equal(fixture.service.hasPasskey('d-web-2'), true)
  assert.equal(fixture.service.revoke('d-web-1'), false, 'a second revoke changes nothing')
  const stored = JSON.parse(fs.readFileSync(fixture.file, 'utf8')).records
  assert.equal(stored.length, 1)
  // Housekeeping drops a record whose device is gone (a re-pair with a narrowed grant).
  fixture.devices.splice(0, 2)
  fixture.service.pruneDevices()
  assert.equal(JSON.parse(fs.readFileSync(fixture.file, 'utf8')).records.length, 0)
})

test('S9 a corrupt store loads empty (recover by registering) and a wrong shape reports a problem', (t) => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'dsh-passkey-bad-'))
  setOwnerOnlyProbeOverride(() => null)
  t.after(() => setOwnerOnlyProbeOverride(undefined))
  t.after(() => fs.rmSync(directory, { recursive: true, force: true }))
  const file = path.join(directory, PASSKEY_STORE_FILE)
  fs.writeFileSync(file, '{ not json')
  const loaded = loadPasskeyStore(file)
  assert.equal(loaded.records.size, 0)
  assert.equal(typeof loaded.problem, 'string')
  // The fix: registering again (the service writes a fresh store).
  const service = createPasskeyService({
    records: loaded.records, file, listDevices: () => [], allowedOrigins: [ORIGIN], gatewayName: 'H', onPasskeyChanged: () => {},
  })
  assert.equal(service.hasPasskey('anything'), false)
})

test('S10 the lock layer: unregistered, locked, unlocked, 15-minute idle, explicit lock', (t) => {
  const fixture = serviceFixture(t)
  const lock = createPasskeyLock({ hasPasskey: (deviceId) => fixture.service.hasPasskey(deviceId), now: fixture.now })
  const slot = lock.newSocket()
  const deviceId = 'd-web-1'
  assert.equal(lock.state(slot, deviceId), 'unregistered')
  const auth = es256Authenticator(1)
  const socket = fakeSocket()
  const device = { id: deviceId, name: 'Web browser' }
  const options = fixture.service.registrationOptions(socket, device, fixture.service.siteFor(socket))
  fixture.service.register(socket, device, fixture.service.siteFor(socket), auth.registration(options.challenge))
  assert.equal(lock.state(slot, deviceId), 'locked')
  const assertOptions = fixture.service.assertionOptions(socket, device, fixture.service.siteFor(socket))
  fixture.service.assert(socket, device, fixture.service.siteFor(socket), auth.assertion(assertOptions.challenge, { counter: 2 }))
  lock.unlock(slot)
  assert.equal(lock.state(slot, deviceId), 'unlocked')
  // Idle: exactly 15 minutes after the last frame the socket is locked again.
  lock.touch(slot)
  fixture.advance(contract.WEB_UNLOCK_IDLE_MS - 1)
  assert.equal(lock.state(slot, deviceId), 'unlocked')
  fixture.advance(2)
  assert.equal(lock.state(slot, deviceId), 'locked')
  // Explicit lock (the PWA's "Lock"): locked until a new assertion, whatever the clock.
  lock.unlock(slot)
  lock.touch(slot)
  assert.equal(lock.state(slot, deviceId), 'unlocked')
  lock.lock(slot)
  assert.equal(lock.state(slot, deviceId), 'locked')
  // A second socket is locked until IT asserts (a tab reload re-asserts).
  assert.equal(lock.state(lock.newSocket(), deviceId), 'locked')
})

test('S10b `touch()` checks the idle expiry BEFORE refreshing, so traffic cannot revive an expired unlock', (t) => {
  const fixture = serviceFixture(t)
  const lock = createPasskeyLock({ hasPasskey: () => true, now: fixture.now })
  const slot = lock.newSocket()
  lock.unlock(slot)
  assert.equal(lock.state(slot, 'd-web-1'), 'unlocked')
  // Idle past the bound without reading the state (the gateway's `touch` runs first on a frame):
  // the frame must find the socket locked, not silently extend the unlock it just lost.
  fixture.advance(contract.WEB_UNLOCK_IDLE_MS)
  lock.touch(slot)
  assert.equal(lock.state(slot, 'd-web-1'), 'locked', 'a frame after the idle bound does not revive an unlock')
  // Within the bound the refresh does extend it: measured from the LAST frame.
  lock.unlock(slot)
  fixture.advance(contract.WEB_UNLOCK_IDLE_MS - 1)
  lock.touch(slot)
  fixture.advance(contract.WEB_UNLOCK_IDLE_MS - 1)
  assert.equal(lock.state(slot, 'd-web-1'), 'unlocked', 'active traffic keeps the unlock alive')
  // A locked socket is never un-locked by a frame, however recently it arrived.
  lock.lock(slot)
  lock.touch(slot)
  assert.equal(lock.state(slot, 'd-web-1'), 'locked')
})

test('S11 the fixed refusal messages carry no detail, and the codes are the contract codes', () => {
  for (const code of Object.values(PASSKEY_CODES).filter((value) => value.startsWith('passkey/'))) {
    assert.deepEqual([...contract.PASSKEY_ERROR_CODES].includes(code), true, `${code} must be a contract code`)
    const message = PASSKEY_FIXED_MESSAGES[code]
    assert.equal(typeof message, 'string')
    for (const leak of ['challenge=', 'origin', 'signCount', 'signature']) assert.equal(message.includes(leak), false, message)
  }
  assert.equal(PASSKEY_CODES.verificationFailed, 'passkey/verification-failed')
})

// A quiet delay helper kept for symmetry with the adversarial file import style.
void delay
