// Web passkey unlock (spec 021, contract revision 14) — the client-side policy and frame codec.
//
// The browser proves possession of a WebAuthn passkey bound to its paired device. The HOST decides
// everything that matters (challenge, origin, rpIdHash, signature, signCount — contract §14.1); this
// app's job is only:
//   * turn the Host's options frames into what `navigator.credentials.*` accepts,
//   * turn the credential the authenticator produced back into the contracted frame,
//   * say honestly WHY the gate is locked (a fixed copy key per reason, never the Host's message),
//   * never send anything the Host did not just ask for.
//
// Pure and React/RN-free (`npm run check:core`): the DOM calls live in `src/platform`.
//
// Two facts shape the code below:
//   1. WebAuthn's dictionary members are `BufferSource`; the contract carries unpadded base64url
//      STRINGS. Passing the string straight through is a TypeError in every browser, so every
//      binary member is decoded here and a member that is not base64url is a refusal, not a guess.
//   2. `credential.id` is the base64url of `rawId`. The Host matches the stored credential by
//      `rawId`, so both are sent and both must describe the same credential; a mismatch is refused.

import type { WebLockReason, WebLockState } from '@dsh-ext/mobile-protocol';

import { CoreError } from './errors';
import { decodeBase64Url, encodeBase64Url } from './base64url';

/** `hello.webLock` states (contract §14.2). A device without `web:unlock` never receives one. */
export type { WebLockReason, WebLockState };

/**
 * The gate keys. One per locked state and per refusal the user can act on. Declared as a frozen
 * object whose values are the `MessageKey` literals, so the gate's `tr(...)` needs no cast.
 */
export interface LockCopyKeys {
  locked: 'unlock.passkeyLocked';
  unregistered: 'unlock.passkeyRegister';
  'rate-limited': 'unlock.passkeyRateLimited';
  'challenge-expired': 'unlock.passkeyExpired';
  'verification-failed': 'unlock.passkeyFailed';
  'not-registered': 'unlock.passkeyNotRegistered';
  'already-registered': 'unlock.passkeyApproval';
  'not-supported': 'unlock.passkeyUnsupported';
  'host-version': 'unlock.passkeyHostVersion';
}

/** One copy key the gate can show (a narrowed `MessageKey` of the i18n table). */
export type LockCopyKey = LockCopyKeys[keyof LockCopyKeys];

/**
 * Reason -> gate copy. The copy is chosen from the reason alone: the Host's `message` is fixed
 * internal text while locked and is never shown (contract §14.4).
 */
export const LOCK_COPY: Readonly<LockCopyKeys> = Object.freeze({
  locked: 'unlock.passkeyLocked',
  unregistered: 'unlock.passkeyRegister',
  'rate-limited': 'unlock.passkeyRateLimited',
  'challenge-expired': 'unlock.passkeyExpired',
  'verification-failed': 'unlock.passkeyFailed',
  'not-registered': 'unlock.passkeyNotRegistered',
  'already-registered': 'unlock.passkeyApproval',
  'not-supported': 'unlock.passkeyUnsupported',
  'host-version': 'unlock.passkeyHostVersion',
});

/** What the gate is waiting for: a new passkey, an assertion, or the owner's approval on the Host. */
export type LockAction = 'register' | 'unlock' | 'approve';

/**
 * The copy key one snapshot state should show, or `null` when the gate shows no message.
 *
 * `error` is a LOCAL failure (a refused prompt, a refused frame, no WebAuthn): it replaces the
 * state's own sentence until the next attempt. Without one, the state's sentence is the story.
 * Pure, so `test/web-unlock-e2e.test.ts` can assert the sentence a user would actually read.
 */
export function unlockCopyKey(state: { state: WebLockState; error: LockReason | null }): LockCopyKey | null {
  // An `unlocked` device shows nothing: there is no sentence for "it worked".
  if (state.error === null && state.state === 'unlocked') return null;
  return LOCK_COPY[(state.error ?? state.state) as keyof LockCopyKeys];
}

/** The action offered in a given locked state (contract §14.1/§14.3). */
export function lockAction(state: WebLockState | LockFailureReason): LockAction {
  if (state === 'unregistered' || state === 'not-registered') return 'register';
  if (state === 'already-registered') return 'approve';
  return 'unlock';
}

/**
 * Refusals with their own copy. The first seven are states/`auth/locked` reasons or fixed protocol
 * error codes; the last two are local: `not-supported` (the browser has no usable WebAuthn here),
 * `host-version` (the Host asked but does not speak revision 14 yet).
 */
export type LockFailureReason =
  | 'locked'
  | 'unregistered'
  | 'rate-limited'
  | 'challenge-expired'
  | 'verification-failed'
  | 'not-registered'
  | 'already-registered'
  | 'not-supported'
  | 'host-version';

/** The gate's reason vocabulary: every locked state plus every local failure. */
export type LockReason = WebLockState | LockFailureReason;

/** Code the app answers with when the browser/authenticator declined (never sent to the Host). */
export const PASSKEY_NOT_ALLOWED = 'client/passkey-not-allowed';

/**
 * The PWA's own "lock now" frame (contract §14.2: `{type:"passkey-lock"}` -> `{kind:"passkey-lock",
 * locked:true}`). `packages/mobile-protocol` revision 14 does not export a constant for it yet, so
 * the name is kept here, beside the code that sends it, and the gateway spells the same literal.
 */
export const PASSKEY_LOCK_TYPE = 'passkey-lock';

/** The `code` of a thrown value (a `CoreError` from the client always carries one). */
export function errorCodeOf(error: unknown): string | null {
  if (typeof error !== 'object' || error === null) return null;
  const code = (error as { code?: unknown }).code;
  return typeof code === 'string' ? code : null;
}

/**
 * Why the gate is locked, from a failed step and the reason the Host is known to be locked with.
 *
 * Kept pure so every mapping is testable: a passkey refusal keeps its own copy; a step the browser
 * or the authenticator declined (`client/passkey-not-allowed`, a `DOMException`, a timeout) is the
 * ordinary lock, because the socket has not asserted anything; anything else — a transport drop,
 * an unrelated refusal — is the generic lock, never a guess about the cause.
 */
export function lockReasonFor(error: unknown): LockReason {
  const code = errorCodeOf(error);
  if (code === 'auth/locked') {
    // The Host's request-path refusal (contract §14.2): its `reason` is the whole story.
    const reason = (error as { reason?: unknown }).reason;
    if (reason === 'unregistered' || reason === 'locked' || reason === 'rate-limited') return reason;
    return 'locked';
  }
  switch (code) {
    case 'passkey/not-registered':
      return 'not-registered';
    case 'passkey/already-registered':
      return 'already-registered';
    case 'passkey/challenge-expired':
      return 'challenge-expired';
    case 'passkey/verification-failed':
      return 'verification-failed';
    case 'passkey/rate-limited':
      return 'rate-limited';
    case 'client/passkey-not-allowed':
    case 'client/timeout':
    case 'client/disconnected':
      return 'locked';
    case 'op/forbidden':
    case 'auth/forbidden-scope':
      // The device may not use the passkey frames at all: that is not a lock this screen can open.
      return 'locked';
    default:
      return 'locked';
  }
}

// ---------------------------------------------------------------------------
// Frames: Host options -> WebAuthn requests
// ---------------------------------------------------------------------------

/** Every binary member `navigator.credentials.create` needs, already decoded. */
export interface PasskeyRegistrationRequest {
  /** The raw challenge bytes, echoed back by the authenticator as-is. */
  challenge: Uint8Array;
  rp: { id: string; name: string };
  user: { id: Uint8Array; name: string; displayName: string };
  pubKeyCredParams: Array<{ type: 'public-key'; alg: number }>;
  excludeCredentials: Array<{ type: 'public-key'; id: Uint8Array }>;
  timeout: number;
}

/** Every binary member `navigator.credentials.get` needs, already decoded. */
export interface PasskeyAssertionRequest {
  challenge: Uint8Array;
  rpId: string;
  allowCredentials: Array<{ type: 'public-key'; id: Uint8Array }>;
  timeout: number;
}

function invalid(message: string): CoreError {
  return new CoreError({ code: 'client/bad-message', message });
}

function binaryField(value: unknown, field: string): Uint8Array {
  const bytes = typeof value === 'string' ? decodeBase64Url(value) : null;
  if (bytes === null || bytes.length === 0) throw invalid(`${field} must be a non-empty base64url string`);
  return bytes;
}

function credentialsList(value: unknown, field: string): Array<{ type: 'public-key'; id: Uint8Array }> {
  if (value === undefined) return [];
  if (!Array.isArray(value)) throw invalid(`${field} must be an array`);
  return value.map((entry, index) => {
    const record = entry as { type?: unknown; id?: unknown };
    // Only `public-key` is meaningful for this RP; a transport entry is not a credential.
    if (record?.type !== 'public-key') throw invalid(`${field}[${index}].type must be "public-key"`);
    return { type: 'public-key' as const, id: binaryField(record.id, `${field}[${index}].id`) };
  });
}

/** `timeout` the Host sent, clamped into what WebAuthn accepts (1..600000 ms). */
function timeoutOf(value: unknown): number {
  if (typeof value !== 'number' || !Number.isFinite(value) || value <= 0) return 60_000;
  return Math.min(Math.max(Math.round(value), 1), 600_000);
}

/**
 * Decode a `kind:"passkey-register-options"` answer into the request `navigator.credentials.create`
 * takes. Structural only: the Host does the security checks (§14.1) on the way back.
 */
export function registrationRequestFrom(answer: Record<string, unknown>): PasskeyRegistrationRequest {
  if (answer.kind !== 'passkey-register-options') throw invalid('the Host did not answer passkey-register-options');
  const challenge = binaryField(answer.challenge, 'challenge');
  const rp = answer.rp as { id?: unknown; name?: unknown } | undefined;
  if (typeof rp?.id !== 'string' || rp.id === '') throw invalid('rp.id must be a non-empty string');
  const user = answer.user as { id?: unknown; name?: unknown; displayName?: unknown } | undefined;
  if (typeof user?.name !== 'string' || user.name === '') throw invalid('user.name must be a non-empty string');
  const params = answer.pubKeyCredParams;
  const pubKeyCredParams: Array<{ type: 'public-key'; alg: number }> = [];
  if (Array.isArray(params)) {
    for (const entry of params) {
      const record = entry as { type?: unknown; alg?: unknown };
      if (record?.type === 'public-key' && typeof record.alg === 'number' && Number.isInteger(record.alg)) {
        pubKeyCredParams.push({ type: 'public-key', alg: record.alg });
      }
    }
  }
  if (pubKeyCredParams.length === 0) throw invalid('pubKeyCredParams must name at least one public-key algorithm');
  return {
    challenge,
    rp: { id: rp.id, name: typeof rp.name === 'string' && rp.name !== '' ? rp.name : rp.id },
    user: {
      id: binaryField(user.id, 'user.id'),
      name: user.name,
      displayName: typeof user.displayName === 'string' && user.displayName !== '' ? user.displayName : user.name,
    },
    pubKeyCredParams,
    excludeCredentials: credentialsList(answer.excludeCredentials, 'excludeCredentials'),
    timeout: timeoutOf(answer.timeout),
  };
}

/**
 * Decode a `kind:"passkey-assert-options"` answer into the request `navigator.credentials.get` takes.
 * An empty `allowCredentials` is passed through unchanged: the authenticator is then free to pick any
 * resident credential, and the HOST still checks it against the stored one.
 */
export function assertionRequestFrom(answer: Record<string, unknown>): PasskeyAssertionRequest {
  if (answer.kind !== 'passkey-assert-options') throw invalid('the Host did not answer passkey-assert-options');
  const challenge = binaryField(answer.challenge, 'challenge');
  if (typeof answer.rpId !== 'string' || answer.rpId === '') throw invalid('rpId must be a non-empty string');
  return {
    challenge,
    rpId: answer.rpId,
    allowCredentials: credentialsList(answer.allowCredentials, 'allowCredentials'),
    timeout: timeoutOf(answer.timeout),
  };
}

// ---------------------------------------------------------------------------
// WebAuthn results -> the contracted frames
// ---------------------------------------------------------------------------

/**
 * `credential.id` and `rawId` must encode the same credential: the Host stores `rawId`, and `id` is
 * only a hint for the authenticator. One that disagrees with the other is refused here, so the Host
 * never has to trust a field it cannot cross-check.
 */
function credentialIdOf(credential: { id?: unknown; rawId?: unknown }): { id: string; rawId: string; raw: Uint8Array } {
  const raw = credential.rawId instanceof ArrayBuffer ? new Uint8Array(credential.rawId) : null;
  if (raw === null || raw.length === 0) throw invalid('the authenticator returned no rawId');
  const rawId = encodeBase64Url(raw);
  const id = typeof credential.id === 'string' && credential.id !== '' ? credential.id : rawId;
  const decoded = decodeBase64Url(id);
  if (decoded === null || !sameBytes(decoded, raw)) {
    throw invalid('credential.id does not describe the same credential as rawId');
  }
  return { id, rawId, raw };
}

function blobOf(value: unknown, field: string): Uint8Array {
  if (!(value instanceof ArrayBuffer)) throw invalid(`${field} must be an ArrayBuffer`);
  return new Uint8Array(value);
}

function sameBytes(left: Uint8Array, right: Uint8Array): boolean {
  if (left.length !== right.length) return false;
  for (let index = 0; index < left.length; index += 1) if (left[index] !== right[index]) return false;
  return true;
}

/** What the PWA sends in `passkey-register.attestation` (contract §14.1). */
export interface PasskeyAttestation {
  id: string;
  rawId: string;
  clientDataJSON: string;
  attestationObject: string;
}

/** What the PWA sends in `passkey-assert.assertion` (contract §14.1). */
export interface PasskeyAssertion {
  id: string;
  rawId: string;
  clientDataJSON: string;
  authenticatorData: string;
  signature: string;
  userHandle: string | null;
}

/** `PublicKeyCredential` -> the `attestation` object. Throws `client/bad-message` on a bad shape. */
export function attestationFrom(credential: unknown): PasskeyAttestation {
  const record = credential as {
    id?: unknown;
    rawId?: unknown;
    response?: { clientDataJSON?: unknown; attestationObject?: unknown };
  } | null;
  if (record === null || typeof record !== 'object') throw invalid('the authenticator returned no credential');
  // `rawId` is recomputed from the bytes, not copied from the authenticator's string, so the Host
  // always receives the canonical form of the credential id.
  const { id, rawId } = credentialIdOf(record);
  const response = record.response as { clientDataJSON?: unknown; attestationObject?: unknown } | undefined;
  const clientData = blobOf(response?.clientDataJSON, 'clientDataJSON');
  const attestationObject = blobOf(response?.attestationObject, 'attestationObject');
  if (clientData.length === 0 || attestationObject.length === 0) throw invalid('the attestation is empty');
  return {
    id,
    rawId,
    clientDataJSON: encodeBase64Url(clientData),
    attestationObject: encodeBase64Url(attestationObject),
  };
}

/** `PublicKeyCredential` -> the `assertion` object. Throws `client/bad-message` on a bad shape. */
export function assertionFrom(credential: unknown): PasskeyAssertion {
  const record = credential as {
    id?: unknown;
    rawId?: unknown;
    response?: {
      clientDataJSON?: unknown;
      authenticatorData?: unknown;
      signature?: unknown;
      userHandle?: unknown;
    };
  } | null;
  if (record === null || typeof record !== 'object') throw invalid('the authenticator returned no credential');
  const { id, rawId } = credentialIdOf(record);
  const response = record.response as {
    clientDataJSON?: unknown;
    authenticatorData?: unknown;
    signature?: unknown;
    userHandle?: unknown;
  } | undefined;
  const clientData = blobOf(response?.clientDataJSON, 'clientDataJSON');
  const authenticatorData = blobOf(response?.authenticatorData, 'authenticatorData');
  const signature = blobOf(response?.signature, 'signature');
  if (clientData.length === 0 || authenticatorData.length === 0 || signature.length === 0) {
    throw invalid('the assertion is empty');
  }
  const userHandle = response?.userHandle;
  return {
    id,
    rawId,
    clientDataJSON: encodeBase64Url(clientData),
    authenticatorData: encodeBase64Url(authenticatorData),
    signature: encodeBase64Url(signature),
    // Discoverable credentials may omit it; the contract allows `null` and only `null` in that case.
    userHandle: userHandle instanceof ArrayBuffer && userHandle.byteLength > 0 ? encodeBase64Url(userHandle) : null,
  };
}
