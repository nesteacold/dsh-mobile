// Spec 036 — behavioural tests for the Host-authoritative web unlock session.
// Everything here drives the real passkey service / lock layer with real WebAuthn signatures
// and an owner-only JSON store; no source regex, no /mgw call, no Host restart process.
import assert from 'node:assert/strict'
import crypto from 'node:crypto'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { test } from 'node:test'

import * as contract from '@dsh-ext/mobile-protocol'
import { loadPasskeyStore, createPasskeyService, createPasskeyLock, PASSKEY_STORE_FILE } from '../lib/passkey.mjs'
import { encodeBase64url } from '../lib/webauthn.mjs'
import { setOwnerOnlyProbeOverride } from '../lib/secure-file.mjs'

const ORIGIN = 'https://pwa.example.test:18443'
const RP_ID = 'pwa.example.test'
const DEVICE = { id: 'web-device-1', name: 'PWA', kind: 'mobile', scopes: ['sessions:read', 'web:unlock'] }

function cborHead(major, length) {
  if (length < 24) return Buffer.from([(major << 5) | length])
  if (length < 0x100) return Buffer.from([(major << 5) | 24, length])
  const head = Buffer.from([0, 0, 0])
  head[0] = (major << 5) | 25
  head.writeUInt16BE(length, 1)
  return head
}
function cbor(value) {
  if (Number.isSafeInteger(value)) return value >= 0 ? cborHead(0, value) : cborHead(1, -1 - value)
  if (Buffer.isBuffer(value)) return Buffer.concat([cborHead(2, value.length), value])
  if (typeof value === 'string') {
    const bytes = Buffer.from(value, 'utf8')
    return Buffer.concat([cborHead(3, bytes.length), bytes])
  }
  if (Array.isArray(value)) return Buffer.concat([cborHead(4, value.length), ...value.map(cbor)])
  const entries = [...value].map(([k, v]) => Buffer.concat([cbor(k), cbor(v)]))
  return Buffer.concat([cborHead(5, entries.length), ...entries])
}
const uint32 = (value) => { const b = Buffer.alloc(4); b.writeUInt32BE(value >>> 0); return b }

function authenticator() {
  const { privateKey, publicKey } = crypto.generateKeyPairSync('ec', { namedCurve: 'P-256' })
  const jwk = publicKey.export({ format: 'jwk' })
  const credentialId = crypto.randomBytes(32)
  const cose = cbor(new Map([[1, 2], [3, -7], [-1, 1],
    [-2, Buffer.from(jwk.x, 'base64url')], [-3, Buffer.from(jwk.y, 'base64url')]]))
  let counter = 1
  const clientData = (challenge, type) => Buffer.from(JSON.stringify({ type, challenge, origin: ORIGIN, crossOrigin: false }))
  return {
    registration(challenge) {
      const idLength = Buffer.alloc(2)
      idLength.writeUInt16BE(credentialId.length)
      const authData = Buffer.concat([
        crypto.createHash('sha256').update(RP_ID).digest(), Buffer.from([0x45]), uint32(counter),
        Buffer.alloc(16), idLength, credentialId, cose,
      ])
      return {
        id: encodeBase64url(credentialId), rawId: encodeBase64url(credentialId),
        clientDataJSON: encodeBase64url(clientData(challenge, 'webauthn.create')),
        attestationObject: encodeBase64url(cbor(new Map([
          ['fmt', 'none'], ['attStmt', new Map()], ['authData', authData], ['type', 'public-key'],
        ]))),
      }
    },
    assertion(challenge, { badSignature = false, counter: fixed = null } = {}) {
      if (fixed === null) counter += 1
      const data = clientData(challenge, 'webauthn.get')
      const authData = Buffer.concat([
        crypto.createHash('sha256').update(RP_ID).digest(), Buffer.from([0x05]), uint32(fixed ?? counter),
      ])
      const digest = crypto.createHash('sha256').update(data).digest()
      const signature = crypto.sign('sha256', Buffer.concat([authData, digest]), privateKey)
      return {
        id: encodeBase64url(credentialId), rawId: encodeBase64url(credentialId),
        clientDataJSON: encodeBase64url(data), authenticatorData: encodeBase64url(authData),
        signature: encodeBase64url(badSignature ? Buffer.concat([signature.subarray(0, 8), Buffer.from([0])]) : signature),
      }
    },
  }
}

function fixture(t, options = {}) {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'dsh-session-gw-'))
  setOwnerOnlyProbeOverride(() => null)
  t.after(() => { setOwnerOnlyProbeOverride(undefined); fs.rmSync(directory, { recursive: true, force: true }) })
  const file = path.join(directory, PASSKEY_STORE_FILE)
  let clock = 1_000_000
  let originPolicy = () => true
  const devices = [DEVICE]
  const state = {
    records: loadPasskeyStore(file).records,
    file,
    devices,
    logLines: [],
    now: () => clock,
    advance: (ms) => { clock += ms },
    setOriginPolicy: (fn) => { originPolicy = fn },
    instantiate(records = state.records) {
      return createPasskeyService({
        records, file, listDevices: () => devices.map((d) => ({ id: d.id, name: d.name })),
        allowedOrigins: [ORIGIN], originPolicy: (socket, origin) => originPolicy(socket, origin),
        mayHoldUnlock: (device) => device?.kind !== 'desktop' && (device?.scopes ?? []).includes('web:unlock'),
        authorizationLive: (device, socket) => socket.authorizationLive !== false && socket.generation === (state.generation ?? 1),
        onPasskeyChanged: () => {},
        ...(options.grantRefreshDebounceMs ? { grantRefreshDebounceMs: options.grantRefreshDebounceMs } : {}),
        log: (line) => state.logLines.push(line),
        now: () => clock,
      })
    },
    generation: 1,
  }
  state.service = state.instantiate()
  state.lock = createPasskeyLock({ hasPasskey: (id) => state.service.hasPasskey(id), now: () => clock })
  state.socket = (origin = ORIGIN, optIn = true, generation = 1) => {
    const slot = state.lock.newSocket()
    state.service.bindSocket(slot, DEVICE.id)
    const socket = { passkeySlot: slot, origin, generation, authorizationLive: true,
      webUnlockSessionOptIn: optIn }
    if (optIn) state.service.markSocketOptIn(socket)
    return socket
  }
  state.register = (socket, auth, service = state.service) => {
    const options = service.registrationOptions(socket, DEVICE, service.siteFor(socket))
    assert.equal(service.register(socket, DEVICE, service.siteFor(socket), auth.registration(options.challenge)).ok, true)
  }
  state.unlock = (socket, auth, service = state.service) => {
    const options = service.assertionOptions(socket, DEVICE, service.siteFor(socket))
    const reply = service.assert(socket, DEVICE, service.siteFor(socket), auth.assertion(options.challenge))
    assert.equal(reply.unlocked, true)
    return reply
  }
  return state
}

const storedGrant = (file) => JSON.parse(fs.readFileSync(file, 'utf8')).records[0].unlockGrant ?? null

// ---------------------------------------------------------------------------

test('S-1 grant survives reconnect AND a Host restart; a non-capable client still starts locked', (t) => {
  const state = fixture(t)
  const auth = authenticator()
  const first = state.socket()
  state.register(first, auth)
  state.unlock(first, auth)
  assert.ok(storedGrant(state.file), 'a successful opted-in assertion persists a grant')

  // Reconnect: a new socket has a fresh slot but the same device credential.
  const second = state.socket()
  assert.equal(state.service.effectiveGrant(DEVICE, second), true)
  assert.equal(state.lock.state(second.passkeySlot, DEVICE.id, true), 'unlocked')

  // Host restart: a NEW service over the SAME persisted store, with in-memory epochs reset.
  const restarted = state.instantiate(loadPasskeyStore(state.file).records)
  const afterRestart = state.socket()
  state.service = restarted
  assert.equal(restarted.effectiveGrant(DEVICE, afterRestart), true)
  assert.equal(state.lock.state(afterRestart.passkeySlot, DEVICE.id, restarted.effectiveGrant(DEVICE, afterRestart)), 'unlocked')

  // A device that never advertised the capability has no grant at all after its assertion.
  const legacy = fixture(t)
  const legacyAuth = authenticator()
  const legacySocket = legacy.socket(ORIGIN, false)
  legacy.register(legacySocket, legacyAuth)
  legacy.unlock(legacySocket, legacyAuth)
  assert.equal(storedGrant(legacy.file), null, 'a non-capable assertion creates no grant')
  const legacyReconnect = legacy.socket(ORIGIN, false)
  assert.equal(legacy.service.effectiveGrant(DEVICE, legacyReconnect), false)
  assert.equal(legacy.lock.state(legacyReconnect.passkeySlot, DEVICE.id, false), 'locked')

  // Same device, two sockets after a service reload: ONLY the socket that advertised the
  // capability sees the persisted grant (reviewer: no device-wide opt-in).
  const mixed = state.instantiate(loadPasskeyStore(state.file).records)
  state.service = mixed
  const a = state.socket(ORIGIN, true)
  const b = state.socket(ORIGIN, false)
  assert.equal(mixed.effectiveGrant(DEVICE, a), true)
  assert.equal(mixed.effectiveGrant(DEVICE, b), false)
  assert.equal(mixed.hasPasskey(DEVICE.id), true)
})

test('S-2 authorized activity slides the 24h window; expiry on an old socket closes the data gate', (t) => {
  const state = fixture(t)
  const auth = authenticator()
  const socket = state.socket()
  state.register(socket, auth)
  state.unlock(socket, auth)
  const original = storedGrant(state.file).expiresAt
  state.advance(contract.WEB_UNLOCK_SESSION_TTL_MS - 1000)
  assert.equal(state.service.effectiveGrant(DEVICE, socket), true, 'just before expiry the grant is live')
  assert.equal(state.service.noteActivity(DEVICE, socket), true)
  assert.ok(storedGrant(state.file), 'the store still holds the last persisted grant')
  state.advance(1000)
  assert.equal(state.service.effectiveGrant(DEVICE, socket), true, 'the slid grant outlived the old expiry')
  assert.equal(storedGrant(state.file).expiresAt, original, 'the refresh is debounced, not written per frame')
  // The grant is live again after another authorized frame, then expires without one.
  assert.equal(state.service.noteActivity(DEVICE, socket), true)
  state.advance(contract.WEB_UNLOCK_SESSION_TTL_MS)
  assert.equal(state.service.effectiveGrant(DEVICE, socket), false)
  assert.equal(storedGrant(state.file), null, 'expiry is cleared and persisted immediately')
  assert.equal(state.lock.state(socket.passkeySlot, DEVICE.id, false), 'locked')
})

test('S-3 two sockets: explicit Lock on A clears the grant and locks B; a pending refresh cannot resurrect it', (t) => {
  const state = fixture(t)
  const auth = authenticator()
  const a = state.socket()
  const b = state.socket()
  state.register(a, auth)
  state.unlock(a, auth)
  assert.equal(state.service.effectiveGrant(DEVICE, b), true, 'B reads through the device grant')
  state.service.noteActivity(DEVICE, b)
  state.service.invalidate(DEVICE.id, 'passkey-lock')
  state.lock.lock(a.passkeySlot)
  state.lock.lock(b.passkeySlot)
  assert.equal(storedGrant(state.file), null)
  assert.equal(state.service.effectiveGrant(DEVICE, a), false)
  assert.equal(state.service.effectiveGrant(DEVICE, b), false)
  assert.equal(state.lock.state(a.passkeySlot, DEVICE.id, false), 'locked')
  assert.equal(state.lock.state(b.passkeySlot, DEVICE.id, false), 'locked')
  // Even after time passes, a cancelled refresh timer cannot write the old grant back.
  state.advance(120_000)
  assert.equal(storedGrant(state.file), null)
})

test('S-4 a challenge finished after Lock/revoke cannot create a grant; a used challenge stays single-use', (t) => {
  const state = fixture(t)
  const auth = authenticator()
  const socket = state.socket()
  state.register(socket, auth)
  const options = state.service.assertionOptions(socket, DEVICE, state.service.siteFor(socket))
  const answer = auth.assertion(options.challenge)
  state.service.invalidate(DEVICE.id, 'passkey-lock')
  assert.throws(() => state.service.assert(socket, DEVICE, state.service.siteFor(socket), answer),
    (error) => error.code === 'passkey/challenge-expired')
  assert.equal(storedGrant(state.file), null)

  // A fresh ceremony succeeds once; replaying the same answer fails with challenge-expired.
  const fresh = state.service.assertionOptions(socket, DEVICE, state.service.siteFor(socket))
  const genuine = auth.assertion(fresh.challenge)
  assert.equal(state.service.assert(socket, DEVICE, state.service.siteFor(socket), genuine).unlocked, true)
  assert.ok(storedGrant(state.file))
  assert.throws(() => state.service.assert(socket, DEVICE, state.service.siteFor(socket), genuine),
    (error) => error.code === 'passkey/challenge-expired')
})

test('S-5 scope remove→re-add, generation change and origin-policy remove→restore all invalidate', (t) => {
  const state = fixture(t)
  const auth = authenticator()
  const socket = state.socket()
  state.register(socket, auth)
  state.unlock(socket, auth)
  assert.equal(state.service.effectiveGrant(DEVICE, socket), true)

  // Scope remove, then re-add: the generation/epoch changed, so the old grant stays gone.
  DEVICE.scopes = ['sessions:read']
  state.service.invalidate(DEVICE.id, 'scope-changed')
  assert.equal(state.service.effectiveGrant(DEVICE, socket), false)
  DEVICE.scopes = ['sessions:read', 'web:unlock']
  assert.equal(state.service.effectiveGrant(DEVICE, socket), false, 're-adding the scope does not restore the grant')
  assert.equal(storedGrant(state.file), null)

  // A fresh grant, then a credential generation change on the same socket.
  state.service.invalidate(DEVICE.id, 'test-reset')
  const fresh = state.socket()
  state.unlock(fresh, auth)
  assert.equal(state.service.effectiveGrant(DEVICE, fresh), true)
  fresh.generation = 2
  assert.equal(state.service.effectiveGrant(DEVICE, fresh), false, 'a re-paired credential cannot use the old grant')

  // Origin policy: refused while removed; after restore the explicit invalidation still holds.
  state.service.invalidate(DEVICE.id, 'test-reset-3')
  const originSocket = state.socket()
  state.unlock(originSocket, auth)
  state.setOriginPolicy(() => false)
  assert.equal(state.service.effectiveGrant(DEVICE, originSocket), false)
  state.service.invalidateOrigin(ORIGIN, 'origin-policy-changed')
  state.setOriginPolicy(() => true)
  assert.equal(state.service.effectiveGrant(DEVICE, originSocket), false)
  assert.equal(storedGrant(state.file), null)
})

test('S-6 rate limit suspends the grant without erasing other authorization state', (t) => {
  const state = fixture(t)
  const auth = authenticator()
  const socket = state.socket()
  state.register(socket, auth)
  state.unlock(socket, auth)
  assert.equal(state.service.effectiveGrant(DEVICE, socket), true)
  for (let i = 0; i < contract.PASSKEY_RATE_LIMITS.perDevice; i += 1) {
    const options = state.service.assertionOptions(socket, DEVICE, state.service.siteFor(socket))
    assert.throws(() => state.service.assert(socket, DEVICE, state.service.siteFor(socket),
      auth.assertion(options.challenge, { badSignature: true })), (error) => error.code === 'passkey/verification-failed')
  }
  assert.equal(state.service.rateLimited(DEVICE.id), true)
  assert.equal(state.service.effectiveGrant(DEVICE, socket), false)
  assert.equal(state.service.noteActivity(DEVICE, socket), false, 'a rate-limited socket cannot slide the grant')
  assert.ok(storedGrant(state.file), 'a rate limit suspends, it does not clear, the grant')
  state.advance(contract.PASSKEY_RATE_LIMITS.perDeviceWindowMs)
  assert.equal(state.service.rateLimited(DEVICE.id), false)
  assert.equal(state.service.effectiveGrant(DEVICE, socket), true)
})

test('S-8 gateway-disabled permanently invalidates the grant: enable + reconnect still needs an assertion', (t) => {
  const state = fixture(t)
  const auth = authenticator()
  const socket = state.socket()
  state.register(socket, auth)
  state.unlock(socket, auth)
  assert.ok(storedGrant(state.file))
  state.service.invalidateAll('gateway-disabled')
  assert.equal(storedGrant(state.file), null)
  const afterEnable = state.socket()
  assert.equal(state.service.effectiveGrant(DEVICE, afterEnable), false, 'a disable→enable cycle is not a suspension')
  assert.equal(state.lock.state(afterEnable.passkeySlot, DEVICE.id, false), 'locked')
})

test('S-9 the debounced flush writes only the CURRENT record; a stale timer cannot resurrect a cleared grant', async (t) => {
  const state = fixture(t, { grantRefreshDebounceMs: 20 })
  const auth = authenticator()
  const socket = state.socket()
  state.register(socket, auth)
  state.unlock(socket, auth)
  const before = storedGrant(state.file).expiresAt
  state.advance(60_000)
  assert.equal(state.service.noteActivity(DEVICE, socket), true)
  await new Promise((resolve) => setTimeout(resolve, 60))
  assert.ok(storedGrant(state.file).expiresAt > before, 'the current record was persisted after the debounce')

  // Schedule a second refresh, then invalidate: the timer must re-check epoch AND record
  // identity and find no grant, leaving the cleared state on disk.
  state.advance(60_000)
  assert.equal(state.service.noteActivity(DEVICE, socket), true)
  state.service.invalidate(DEVICE.id, 'passkey-lock')
  assert.equal(storedGrant(state.file), null)
  await new Promise((resolve) => setTimeout(resolve, 60))
  assert.equal(storedGrant(state.file), null, 'the stale flush did not write the captured grant')
})

test('S-7 logs carry codes only: no origin, challenge, signature or grant appears', (t) => {
  const state = fixture(t)
  const auth = authenticator()
  const socket = state.socket()
  state.register(socket, auth)
  state.unlock(socket, auth)
  state.service.invalidate(DEVICE.id, 'passkey-lock')
  for (const line of state.logLines) {
    assert.equal(line.includes(ORIGIN), false, `log line leaked the origin: ${line}`)
    assert.equal(line.includes('unlockGrant'), false)
    assert.equal(line.includes('challenge'), false)
    assert.equal(line.includes('signature'), false)
  }
})
