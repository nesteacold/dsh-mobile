/**
 * Spec 021 (contract revision 14): the web passkey unlock — the store, the lock state, the
 * challenges, the approvals and the rate limits.
 *
 * The gateway side of the WebAuthn decisions lives in `./webauthn.mjs`; this module owns
 * everything that changes: one record per paired web device
 * (`{credentialId, publicKey (COSE), signCount, createdAt}`) in an owner-only JSON file next to
 * the device store, a per-socket lock state, one single-use challenge per socket, the pending
 * re-registration approvals and the failed-operation windows.
 *
 * Rules it enforces (contract §14):
 *  - a socket starts LOCKED; only a successful `passkey-assert` on it unlocks it;
 *  - a challenge is 32 random bytes, single use, valid 60 s, and bound to the socket that asked
 *    for it — another socket's challenge never matches;
 *  - 15 min without a frame re-locks a socket (a tab reload always re-asserts anyway);
 *  - a registration for a device that already has a passkey is refused until the owner
 *    approves on the Host (`POST /mgw/pending/:id/approve|reject`, a `passkey` pending record);
 *  - 5 failures per device in 10 min and 30 globally per hour lock the affected devices out;
 *  - revoking the device deletes its record.
 *
 * NOTHING here logs or returns a credential id, a public key, a challenge, clientDataJSON or a
 * signature: log lines carry an event name and, at most, the throw-side error code the wire
 * already shows.
 */
import crypto from 'node:crypto'
import fs from 'node:fs'
import path from 'node:path'
// The vendored contract copy, never the bare package specifier: an installed tarball has no
// `node_modules/@dsh-ext/mobile-protocol` (see `scripts/sync-mobile-protocol.mjs`), and a bare
// import here failed `npm run test:package` for exactly that reason.
import {
  PASSKEY_ALREADY_REGISTERED,
  PASSKEY_ASSERT_OPTIONS_TYPE,
  PASSKEY_CHALLENGE_EXPIRED,
  PASSKEY_CHALLENGE_TTL_MS,
  PASSKEY_NOT_REGISTERED,
  PASSKEY_RATE_LIMITED,
  PASSKEY_REGISTER_OPTIONS_TYPE,
  PASSKEY_VERIFICATION_FAILED,
  PASSKEY_RATE_LIMITS,
  WEB_UNLOCK_IDLE_MS,
} from './vendor/mobile-protocol.mjs'
import { assertOwnerOnly, ensureOwnerOnlyDirectory, restrictToOwnerSync, writeSecretFile } from './secure-file.mjs'
import { encodeBase64url, originHostname, PasskeyVerificationError, verifyAssertion, verifyRegistration } from './webauthn.mjs'

/** File name of the passkey store, next to the device store (never a secret of its own). */
export const PASSKEY_STORE_FILE = 'mobile-gateway-passkeys.json'
const STORE_VERSION = 1
/** The approval window of a re-registration request: the same five minutes pairing uses. */
export const PASSKEY_APPROVAL_TTL_MS = 5 * 60_000
/** Bound of the pending-approval list (one per web device in practice). */
const PASSKEY_APPROVAL_LIMIT = 32
/** Bounded challenge map: expired entries are swept on every use. */
const CHALLENGE_LIMIT = 256
const CREDENTIAL_ID_PATTERN = /^[A-Za-z0-9_-]{16,1024}$/
const PUBLIC_KEY_PATTERN = /^[A-Za-z0-9_-]{1,3072}$/

/** Wire codes (contract §6). */
export const PASSKEY_CODES = Object.freeze({
  notRegistered: PASSKEY_NOT_REGISTERED,
  alreadyRegistered: PASSKEY_ALREADY_REGISTERED,
  challengeExpired: PASSKEY_CHALLENGE_EXPIRED,
  verificationFailed: PASSKEY_VERIFICATION_FAILED,
  rateLimited: PASSKEY_RATE_LIMITED,
  badRequest: 'bad-request',
})

/** Fixed sentences: a refusal says which code, never which check failed. */
const FIXED_MESSAGES = Object.freeze({
  [PASSKEY_CODES.notRegistered]: 'this device has no passkey; register one first',
  [PASSKEY_CODES.alreadyRegistered]: 'this device already has a passkey; replacing it needs the owner\'s approval on the computer',
  [PASSKEY_CODES.challengeExpired]: 'no live passkey challenge for this connection; request a new one',
  [PASSKEY_CODES.verificationFailed]: 'the passkey could not be verified',
  [PASSKEY_CODES.rateLimited]: 'too many failed passkey attempts; try again later',
  [PASSKEY_CODES.badRequest]: 'the passkey frame is malformed',
})

const randomBase64url = (bytes) => crypto.randomBytes(bytes).toString('base64url')
const sha256Hex = (text) => crypto.createHash('sha256').update(String(text), 'utf8').digest('hex')

/** A refusal the caller turns into an error frame. `code` is the only detail beyond the message. */
export class PasskeyRefusal extends Error {
  constructor(code) {
    super(FIXED_MESSAGES[code] ?? FIXED_MESSAGES[PASSKEY_CODES.verificationFailed])
    this.name = 'PasskeyRefusal'
    this.code = code
  }
}

const refuse = (code) => { throw new PasskeyRefusal(code) }

/**
 * Load the passkey store, creating the owner-only directory when needed.
 *
 * A corrupt or unreadable store is NOT fatal: every device then counts as unregistered (a
 * registration replaces the record — one approval when one existed — and an assertion says
 * `passkey/not-registered`), so the owner can always recover by registering again instead of
 * the gateway refusing to start.
 *
 * @param {string} file store path
 * @returns {{ records: Map<string, {credentialId: string, publicKey: string, signCount: number, createdAt: number}>, problem?: string }}
 */
export function loadPasskeyStore(file) {
  /** Hash of the device id → record. The id itself is never stored. */
  const records = new Map()
  try {
    ensureOwnerOnlyDirectory(path.dirname(file))
    if (!fs.existsSync(file)) return { records }
    // A pre-existing explicit grant survives the write-time restriction, so the store that
    // is read is checked like a served secret.
    assertOwnerOnly(file)
    const parsed = JSON.parse(fs.readFileSync(file, 'utf8'))
    if (!parsed || !Array.isArray(parsed.records)) return { records, problem: 'store has an unexpected shape' }
    for (const row of parsed.records) {
      if (!row || typeof row !== 'object') continue
      const { deviceHash, credentialId, publicKey, signCount, createdAt } = row
      if (typeof deviceHash !== 'string' || !/^[a-f0-9]{64}$/.test(deviceHash)) continue
      if (typeof credentialId !== 'string' || !CREDENTIAL_ID_PATTERN.test(credentialId)) continue
      if (typeof publicKey !== 'string' || !PUBLIC_KEY_PATTERN.test(publicKey)) continue
      records.set(deviceHash, {
        credentialId,
        publicKey,
        signCount: Number.isSafeInteger(signCount) && signCount >= 0 ? signCount : 0,
        createdAt: Number.isFinite(createdAt) ? createdAt : Date.now(),
      })
    }
    return { records }
  } catch (error) {
    // Only the error class is reported: a message can quote a path.
    return { records: new Map(), problem: error && error.code ? String(error.code) : 'unreadable' }
  }
}

/**
 * The passkey service of one gateway process.
 *
 * @param {object} options
 * @param {Map<string, object>} options.records the loaded store
 * @param {string} options.file store path (written on every change)
 * @param {() => Array<{id: string, name: string}>} options.listDevices live devices (records of
 *   revoked devices are dropped on the next change)
 * @param {(deviceId: string) => void} options.onPasskeyChanged called after the stored record of
 *   `deviceId` changed under it (a replacement closes that device's other sockets)
 * @param {() => void} [options.onApprovalSettled] called after an approval is decided
 * @param {(line: string) => void} [options.log]
 * @param {() => number} [options.now]
 */
export function createPasskeyService(options) {
  const { records, file, listDevices, onPasskeyChanged, onApprovalSettled, log } = options
  const now = options.now ?? (() => Date.now())
  const deviceHash = (deviceId) => sha256Hex(deviceId)

  const save = () => {
    const list = []
    for (const [hash, record] of records) list.push({ deviceHash: hash, ...record })
    fs.mkdirSync(path.dirname(file), { recursive: true })
    const target = `${file}.${process.pid}.tmp`
    writeSecretFile(target, JSON.stringify({ version: STORE_VERSION, records: list }, null, 2))
    fs.renameSync(target, file)
    restrictToOwnerSync(file, 'file')
  }

  // Pending re-registration approvals, by id. Not persisted: an approval that outlives the
  // gateway is not needed (the client simply asks again).
  const approvals = new Map()
  // Approvals already GRANTED to a socket (its state key → `{ deviceId, expiresAt }`). A grant
  // outlives the decision so the socket can finish the ceremony it asked for; it is spent by the
  // replacement registration, and it never applies to another socket of the same device.
  const grants = new Map()
  // Per-socket challenges, by socket id: { challenge, expiresAt }.
  const challenges = new Map()
  // Rate-limit windows: device id → [timestamps], and one global list.
  const deviceFailures = new Map()
  let globalFailures = []

  const prune = () => {
    const at = now()
    for (const [socketId, entry] of challenges) if (entry.expiresAt <= at) challenges.delete(socketId)
    for (const [id, entry] of approvals) if (entry.expiresAt <= at) {
      approvals.delete(id)
      onApprovalSettled?.()
    }
    for (const [key, grant] of grants) if (grant.expiresAt <= at) grants.delete(key)
    for (const [deviceId, list] of deviceFailures) {
      const kept = list.filter((time) => at - time < PASSKEY_RATE_LIMITS.perDeviceWindowMs)
      if (kept.length === 0) deviceFailures.delete(deviceId)
      else deviceFailures.set(deviceId, kept)
    }
    globalFailures = globalFailures.filter((time) => at - time < PASSKEY_RATE_LIMITS.globalWindowMs)
  }

  const recordFor = (deviceId) => records.get(deviceHash(deviceId))

  /** Whether this device is locked out right now (its own window or the global one). */
  const isRateLimited = (deviceId) => {
    prune()
    if (globalFailures.length >= PASSKEY_RATE_LIMITS.global) return true
    const list = deviceFailures.get(deviceId)
    return list !== undefined && list.length >= PASSKEY_RATE_LIMITS.perDevice
  }

  /** Count one FAILED operation. A refusal that costs nothing (expired challenge) never lands. */
  const noteFailure = (deviceId) => {
    const at = now()
    const list = deviceFailures.get(deviceId) ?? []
    list.push(at)
    deviceFailures.set(deviceId, list)
    globalFailures.push(at)
    prune()
  }

  /**
   * The site this socket speaks for: the EXACT `Origin` it presented, and that origin must be
   * one of the gateway's `allowedOrigins`. Fail closed — no origin, a foreign one or one that
   * is not a plain `scheme://host[:port]` is refused before any challenge exists.
   */
  const siteFor = (socket) => {
    const origin = typeof socket.origin === 'string' ? socket.origin : ''
    if (origin === '') refuse(PASSKEY_CODES.verificationFailed)
    if (!options.allowedOrigins.includes(origin)) refuse(PASSKEY_CODES.verificationFailed)
    const host = originHostname(origin)
    if (host === undefined) refuse(PASSKEY_CODES.verificationFailed)
    return { origin, rpId: host }
  }

  /**
   * The state key of the socket asking. It is the caller's own handle (the gateway passes the
   * per-socket passkey record it created on connect, as `socket.passkeySlot`), so two sockets of
   * the same device never share a challenge: a challenge is bound to the SOCKET, never to the
   * device.
   */
  const keyOf = (socket) => {
    const key = socket !== null && typeof socket === 'object' ? socket.passkeySlot?.stateKey : undefined
    if (typeof key !== 'string' || key === '') refuse(PASSKEY_CODES.verificationFailed)
    return key
  }

  const issueChallenge = (socket) => {
    prune()
    const key = keyOf(socket)
    const entry = { challenge: randomBase64url(32), expiresAt: now() + PASSKEY_CHALLENGE_TTL_MS }
    challenges.set(key, entry)
    if (challenges.size > CHALLENGE_LIMIT) {
      // Drop the oldest-issued entry, never the one just issued.
      for (const candidate of challenges.keys()) {
        if (candidate === key) continue
        challenges.delete(candidate)
        if (challenges.size <= CHALLENGE_LIMIT) break
      }
    }
    return entry.challenge
  }

  /** The socket's live challenge, consumed by the call that verifies against it. */
  const takeChallenge = (socket) => {
    prune()
    const key = keyOf(socket)
    const entry = challenges.get(key)
    if (entry === undefined) refuse(PASSKEY_CODES.challengeExpired)
    challenges.delete(key)
    return entry.challenge
  }

  const pendingForDevice = (deviceId) => {
    prune()
    for (const approval of approvals.values()) if (approval.deviceId === deviceId) return approval
    return undefined
  }

  /** The live replacement grant of THIS socket for THIS device, or `undefined`. */
  const grantForSocket = (socket, deviceId) => {
    prune()
    const key = keyOf(socket)
    const grant = grants.get(key)
    return grant !== undefined && grant.deviceId === deviceId ? grant : undefined
  }

  const registrationOptions = (socket, device, site) => {
    if (isRateLimited(device.id)) refuse(PASSKEY_CODES.rateLimited)
    const stored = recordFor(device.id)
    // A fresh challenge every time an option is issued: an old answer can no longer verify.
    const challenge = issueChallenge(socket)
    return {
      kind: PASSKEY_REGISTER_OPTIONS_TYPE,
      challenge,
      rp: { id: site.rpId, name: options.gatewayName },
      user: {
        // Scope-visible but stable per device: the authenticator stores it as the account hint.
        id: Buffer.from(`device:${device.id}`, 'utf8').toString('base64url'),
        name: device.name,
        displayName: device.name,
      },
      pubKeyCredParams: [{ type: 'public-key', alg: -7 }, { type: 'public-key', alg: -257 }],
      excludeCredentials: stored === undefined
        ? []
        : [{ type: 'public-key', id: stored.credentialId }],
      timeout: PASSKEY_CHALLENGE_TTL_MS,
    }
  }

  const assertionOptions = (socket, device, site) => {
    // A locked-out device gets no options and no challenge: the refusal happens before any work.
    if (isRateLimited(device.id)) refuse(PASSKEY_CODES.rateLimited)
    const stored = recordFor(device.id)
    if (stored === undefined) refuse(PASSKEY_CODES.notRegistered)
    const challenge = issueChallenge(socket)
    return {
      kind: PASSKEY_ASSERT_OPTIONS_TYPE,
      challenge,
      rpId: site.rpId,
      allowCredentials: [{ type: 'public-key', id: stored.credentialId }],
      timeout: PASSKEY_CHALLENGE_TTL_MS,
    }
  }

  const requireAttestationShape = (attestation) => {
    if (attestation === null || typeof attestation !== 'object') refuse(PASSKEY_CODES.badRequest)
    for (const field of ['id', 'rawId', 'clientDataJSON', 'attestationObject']) {
      if (typeof attestation[field] !== 'string' || attestation[field] === '') refuse(PASSKEY_CODES.badRequest)
    }
    return attestation
  }

  const requireAssertionShape = (assertion) => {
    if (assertion === null || typeof assertion !== 'object') refuse(PASSKEY_CODES.badRequest)
    for (const field of ['id', 'rawId', 'clientDataJSON', 'authenticatorData', 'signature']) {
      if (typeof assertion[field] !== 'string' || assertion[field] === '') refuse(PASSKEY_CODES.badRequest)
    }
    return assertion
  }

  /** A verification error → its wire code; anything else propagates as a programming error. */
  const verify = (run) => {
    try {
      return run()
    } catch (error) {
      if (error instanceof PasskeyVerificationError) refuse(PASSKEY_CODES.verificationFailed)
      throw error
    }
  }

  const hasRecord = (deviceId) => recordFor(deviceId) !== undefined

  return {
    /** Whether this device has a stored passkey (the lock layer reads it on every frame). */
    hasPasskey: hasRecord,

    /**
     * Whether THIS device is locked out by the failure budget right now (§14.5): its own
     * per-device window or the global hour. The request-path lock gate reads this so an
     * otherwise-unlocked socket over its budget is still refused `auth/locked` with
     * `reason: "rate-limited"` — the contract's own wording for the request path.
     */
    rateLimited(deviceId) {
      return isRateLimited(deviceId)
    },

    /**
     * `passkey-register-options` → options. Requires `web:unlock` (checked by the caller) and
     * the socket's site to be an allowed origin. Rates and approvals gate nothing here: only a
     * FAILED registration counts, and the options are cheap and single-use.
     */
    registrationOptions,

    /**
     * `passkey-register` → `{ ok: true }` once the record is stored.
     *
     * Order: rate limit → convergence approval → challenge → attestation shape → verification
     * (fmt none, challenge, origin, rpIdHash, UP+UV, ES256/RS256, credential id) → store.
     * A device that already has a passkey needs the owner's `approve` first; the asking socket
     * then gets `passkey-approval` and may re-register within the approval window.
     */
    register(socket, device, site, attestation) {
      if (isRateLimited(device.id)) refuse(PASSKEY_CODES.rateLimited)
      const stored = recordFor(device.id)
      // Approval is a ceremony with the SOCKET that asked: this socket alone may replace the
      // key once the owner approved, and an old approval is never spent on a stranger's
      // registration.
      const grant = grantForSocket(socket, device.id)
      if (stored !== undefined && grant === undefined) {
        if (pendingForDevice(device.id) === undefined) {
          prune()
          const approval = {
            id: crypto.randomUUID(),
            stateKey: keyOf(socket),
            deviceId: device.id,
            deviceName: device.name,
            // Eight characters the owner compares with what the device shows (§14.3).
            verificationCode: randomBase64url(16).slice(0, 8).toUpperCase(),
            expiresAt: now() + PASSKEY_APPROVAL_TTL_MS,
            createdAt: now(),
          }
          approvals.set(approval.id, approval)
          while (approvals.size > PASSKEY_APPROVAL_LIMIT) approvals.delete(approvals.keys().next().value)
          onApprovalSettled?.()
          log?.(`passkey re-registration requested: device=${device.id} approval=${approval.id}`)
        }
        refuse(PASSKEY_CODES.alreadyRegistered)
      }
      const shape = requireAttestationShape(attestation)
      const challenge = takeChallenge(socket)
      let result
      try {
        result = verify(() => verifyRegistration({ attestation: shape, challenge, origin: site.origin, rpId: site.rpId }))
      } catch (error) {
        if (error instanceof PasskeyRefusal) noteFailure(device.id)
        throw error
      }
      records.set(deviceHash(device.id), {
        credentialId: result.credentialId,
        publicKey: result.publicKey,
        signCount: result.signCount,
        createdAt: now(),
      })
      if (grant !== undefined) grants.delete(keyOf(socket)) // a grant is spent by its ceremony
      save()
      log?.(`passkey registered: device=${device.id}`)
      // A replacement invalidates the device's other sockets (they re-assert on a new passkey).
      if (stored !== undefined) onPasskeyChanged?.(device.id)
      return { ok: true }
    },

    /** `passkey-assert-options` → options (allowCredentials is this device's own credential). */
    assertionOptions,

    /**
     * `passkey-assert` → `{ unlocked: true }` and THIS socket is unlocked.
     *
     * Order: rate limit → record present → challenge → assertion shape → verification (type,
     * challenge, origin, rpIdHash, UP+UV, signature, signCount). The sign count is stored only
     * after a successful verification.
     */
    assert(socket, device, site, assertion) {
      if (isRateLimited(device.id)) refuse(PASSKEY_CODES.rateLimited)
      const stored = recordFor(device.id)
      if (stored === undefined) refuse(PASSKEY_CODES.notRegistered)
      const shape = requireAssertionShape(assertion)
      const challenge = takeChallenge(socket)
      let result
      try {
        result = verify(() => verifyAssertion({ assertion: shape, stored, challenge, origin: site.origin, rpId: site.rpId }))
      } catch (error) {
        if (error instanceof PasskeyRefusal) noteFailure(device.id)
        throw error
      }
      if (result.signCount !== stored.signCount) {
        stored.signCount = result.signCount
        save()
      }
      log?.(`passkey asserted: device=${device.id}`)
      return { unlocked: true }
    },

    /** The socket's site (origin + rpId), or a refusal. */
    siteFor,

    /** Explicit lock (`passkey-lock`), or a socket closing: its live challenge goes with it. */
    forgetSocket(socket) {
      challenges.delete(keyOf(socket))
    },

    /** Revocation (or a re-pair that drops the grant): the device's record goes. */
    revoke(deviceId) {
      const had = recordFor(deviceId) !== undefined
      records.delete(deviceHash(deviceId))
      deviceFailures.delete(deviceId)
      for (const [id, approval] of approvals) {
        if (approval.deviceId !== deviceId) continue
        approvals.delete(id)
        onApprovalSettled?.()
      }
      for (const [key, grant] of grants) if (grant.deviceId === deviceId) grants.delete(key)
      if (had) {
        save()
        log?.(`passkey revoked: device=${deviceId}`)
      }
      return had
    },

    /** Drop records of devices that no longer exist (cheap housekeeping on every change). */
    pruneDevices() {
      const live = new Set(listDevices().map((device) => deviceHash(device.id)))
      let changed = false
      for (const hash of [...records.keys()]) {
        if (live.has(hash)) continue
        records.delete(hash)
        changed = true
      }
      if (changed) save()
    },

    /** The pending re-registration approvals (owner-facing list; the token never leaves). */
    pendingApprovals() {
      prune()
      return [...approvals.values()].map(({ id, deviceId, deviceName, verificationCode, expiresAt, createdAt }) => ({
        id, deviceId, deviceName, verificationCode, expiresAt, createdAt, kind: 'passkey',
      }))
    },

    /**
     * Resolve one approval (`POST /mgw/pending/:id/approve|reject`). `undefined` when it is not
     * pending (decided, expired or unknown).
     *
     * An approval is granted to the SOCKET that asked (its state key), never to the device: the
     * gateway delivers `passkey-approval` only there, and only that socket may replace the key.
     * An `approve` leaves a grant on that socket for the approval window; a `reject` leaves none.
     */
    decideApproval(id, action) {
      prune()
      const approval = approvals.get(id)
      if (approval === undefined) return undefined
      approvals.delete(id)
      if (action === 'approve') {
        grants.set(approval.stateKey, { deviceId: approval.deviceId, expiresAt: approval.expiresAt })
      }
      onApprovalSettled?.()
      log?.(`passkey approval ${action}: device=${approval.deviceId} approval=${approval.id}`)
      return {
        approvalId: approval.id,
        deviceId: approval.deviceId,
        stateKey: approval.stateKey,
        action: action === 'approve' ? 'approve' : 'reject',
        verificationCode: approval.verificationCode,
      }
    },
  }
}

/**
 * The per-socket unlock state the gateway reads on every frame (contract §14.2).
 *
 * `deviceId` is the socket's device; `stored` says whether that device has a passkey. A
 * socket is unlocked only after an assertion on IT, and only for `WEB_UNLOCK_IDLE_MS` after
 * its last frame — so a reconnect or a tab reload starts locked again.
 *
 * @param {object} options
 * @param {(deviceId: string) => boolean} options.hasPasskey
 * @param {number} [options.idleMs] the idle bound; `WEB_UNLOCK_IDLE_MS` in production. A test
 *   passing a shorter value is the only way to observe the 15-minute rule in real time.
 * @param {() => number} [options.now]
 */
export function createPasskeyLock(options) {
  const now = options.now ?? (() => Date.now())
  const idleMs = Number.isSafeInteger(options.idleMs) && options.idleMs > 0 ? options.idleMs : WEB_UNLOCK_IDLE_MS
  /** Whether the socket's unlock earned at `lastFrameAt` is still inside the idle bound. */
  const withinIdle = (slot, at) => typeof slot.lastFrameAt === 'number' && at - slot.lastFrameAt < idleMs
  return {
    /**
     * One lock record per socket, created when the device first connects.
     *
     * `stateKey` is the key the service binds challenges and approvals to (a per-socket random
     * string, never the device id); `approvalToken` is set only when the owner approved a
     * replacement for this socket.
     */
    newSocket() {
      return { stateKey: crypto.randomUUID(), approvalToken: null, unlocked: false, lastFrameAt: null }
    },

    /**
     * The lock a socket shows right now: `unregistered` (no passkey — register), `locked`
     * (never asserted here, or idle too long) or `unlocked`.
     */
    state(slot, deviceId) {
      if (!options.hasPasskey(deviceId)) return 'unregistered'
      if (slot.unlocked !== true) return 'locked'
      if (!withinIdle(slot, now())) {
        slot.unlocked = false
        return 'locked'
      }
      return 'unlocked'
    },

    /**
     * A frame arrived on this socket: the inactivity clock restarts (never unlocks by itself).
     *
     * The idle bound is applied FIRST: a frame that arrives after the bound must not refresh a
     * socket that has already idled out. Checking here (and not only in `state()`) means the
     * caller cannot extend an expired unlock by skipping the state read — an idle socket stays
     * locked until a NEW assertion, which sets `lastFrameAt` itself.
     */
    touch(slot) {
      if (slot.unlocked === true && !withinIdle(slot, now())) slot.unlocked = false
      slot.lastFrameAt = now()
    },

    /** A successful assertion on this socket. */
    unlock(slot) {
      slot.unlocked = true
      slot.lastFrameAt = now()
    },

    /** `passkey-lock` or a replacement: the socket shows its lock screen again. */
    lock(slot) {
      slot.unlocked = false
      slot.lastFrameAt = null
    },
  }
}

/** Shared strings the gateway answers with — exported so tests can pin them. */
export { FIXED_MESSAGES as PASSKEY_FIXED_MESSAGES }
