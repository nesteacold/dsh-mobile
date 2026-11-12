// Web (PWA) passkey unlock — the `*.web.ts` sibling of `biometrics.ts` (spec 021, revision 14).
//
// THE LOCK IS THE HOST'S, NOT THIS FILE'S: every new connection from a `web:unlock` device starts
// locked, and only the Host's `passkey-assert` verification opens it (contract §14.1/§14.2). What
// this module does is the browser half:
//   * REGISTER a passkey right after pairing: `passkey-register-options` -> `navigator.credentials
//     .create` -> `passkey-register` (a device that already has one is refused
//     `passkey/already-registered` and the owner has to approve the replacement on the Host);
//   * UNLOCK: `passkey-assert-options` -> `navigator.credentials.get` -> `passkey-assert`;
//   * RE-LOCK on request: `passkey-lock`, so closing this tab is not the only way to end a session.
//
// The wire conversion lives in `src/core/web-lock.ts` (pure, tested): WebAuthn wants `BufferSource`
// members where the contract carries base64url strings, and that translation is the one place a
// mistake would silently break every browser.
//
// FAIL CLOSED: a browser without a usable WebAuthn, a declined prompt, a malformed answer or a
// transport drop all leave the socket locked. This file never says "unlocked" on its own — it
// reports what the Host answered.
//
// Contract detail worth knowing when reading the approval path: `passkey-approval` carries no
// `requestId`, so a pending `passkey-register` cannot be waiting on the wire while it arrives. The
// register call therefore returns as soon as the Host refuses `already-registered`, and the approval
// decision is reported through `watchPasskeyApproval`; on `approve` the caller registers again
// (a fresh options challenge, per §14.3).

import { PASSKEY_REGISTER_TYPE } from '@dsh-ext/mobile-protocol';

import { CoreError } from '../core/errors';
import type { CompanionClient } from '../core/client';
import {
  PASSKEY_LOCK_TYPE,
  PASSKEY_NOT_ALLOWED,
  assertionFrom,
  assertionRequestFrom,
  attestationFrom,
  errorCodeOf,
  lockReasonFor,
  registrationRequestFrom,
  type LockReason,
  type PasskeyAssertion,
  type PasskeyAttestation,
  type PasskeyAssertionRequest,
  type PasskeyRegistrationRequest,
} from '../core/web-lock';
import type { UnlockCapability, UnlockResult } from './biometrics';

/** The PWA's own re-lock frame (contract §14.2); see `src/core/web-lock.ts#PASSKEY_LOCK_TYPE`. */
export { PASSKEY_LOCK_TYPE };

/** What `passkey-approval` reports (contract §14.3). */
export type PasskeyApproval = { approvalId: string; action: 'approve' | 'reject'; verificationCode?: string };

/**
 * WebAuthn is reachable only in a secure context and only when the page's public key exists.
 * `unavailable` keeps the gate shut with its own sentence (`unlock.passkeyUnsupported`).
 */
function webauthnAvailable(): boolean {
  try {
    return typeof navigator !== 'undefined'
      && navigator.credentials !== undefined
      && typeof navigator.credentials.create === 'function'
      && typeof navigator.credentials.get === 'function'
      && typeof window !== 'undefined'
      && window.isSecureContext === true;
  } catch {
    return false;
  }
}

/** Map a browser/authenticator refusal into the app's own typed code (`client/passkey-not-allowed`). */
function declined(error: unknown): CoreError {
  const name = typeof error === 'object' && error !== null ? (error as { name?: unknown }).name : null;
  return new CoreError({
    code: PASSKEY_NOT_ALLOWED,
    message: name === 'NotAllowedError'
      ? 'The passkey prompt was dismissed or timed out'
      : 'The browser could not use a passkey here',
    cause: error,
  });
}

function bufferSource(bytes: Uint8Array): BufferSource {
  return bytes as unknown as BufferSource;
}

/**
 * `navigator.credentials.create` for the decoded options. The RP id is the page's hostname and the
 * challenge binds the credential to the socket; nothing else about the request is App-side policy.
 */
export async function createPasskey(request: PasskeyRegistrationRequest): Promise<PasskeyAttestation> {
  try {
    const credential = await navigator.credentials.create({
      publicKey: {
        challenge: bufferSource(request.challenge),
        rp: { id: request.rp.id, name: request.rp.name },
        user: {
          id: bufferSource(request.user.id),
          name: request.user.name,
          displayName: request.user.displayName,
        },
        pubKeyCredParams: request.pubKeyCredParams.map((entry) => ({ type: entry.type, alg: entry.alg })),
        excludeCredentials: request.excludeCredentials.map((entry) => ({ type: entry.type, id: bufferSource(entry.id) })),
        authenticatorSelection: {
          // Contract §14 "Requirements" 1: a resident (discoverable) passkey is preferred, and user
          // verification is REQUIRED — the Host rejects an assertion without the UV flag.
          residentKey: 'preferred',
          userVerification: 'required',
        },
        attestation: 'none',
        timeout: request.timeout,
      },
    });
    // A null credential means no passkey was made (the prompt was dismissed): never "success".
    if (credential === null) throw declined(undefined);
    return attestationFrom(credential);
  } catch (error) {
    if (error instanceof CoreError) throw error;
    throw declined(error);
  }
}

/** `navigator.credentials.get` for the decoded options. */
export async function getPasskeyAssertion(request: PasskeyAssertionRequest): Promise<PasskeyAssertion> {
  try {
    const credential = await navigator.credentials.get({
      publicKey: {
        challenge: bufferSource(request.challenge),
        rpId: request.rpId,
        allowCredentials: request.allowCredentials.map((entry) => ({ type: entry.type, id: bufferSource(entry.id) })),
        userVerification: 'required',
        timeout: request.timeout,
      },
    });
    if (credential === null) throw declined(undefined);
    return assertionFrom(credential);
  } catch (error) {
    if (error instanceof CoreError) throw error;
    throw declined(error);
  }
}

/**
 * Register this device's passkey. Resolves after the Host accepted it; throws `CoreError`s whose
 * `code` is the contract code (`passkey/already-registered` included).
 */
export async function registerPasskey(client: CompanionClient): Promise<{ ok: true }> {
  const options = await client.passkeyRequest('passkey-register-options');
  const request = registrationRequestFrom(options);
  const attestation = await createPasskey(request);
  const answer = await client.passkeyRequest(PASSKEY_REGISTER_TYPE, { attestation });
  if (answer.ok !== true) throw new CoreError({ code: 'client/bad-message', message: 'The computer did not confirm the passkey' });
  return { ok: true };
}

/** Assert the passkey on THIS socket: the Host's verification is what unlocks it (contract §14.1). */
export async function assertPasskey(client: CompanionClient): Promise<{ ok: true }> {
  const options = await client.passkeyRequest('passkey-assert-options');
  const request = assertionRequestFrom(options);
  const assertion = await getPasskeyAssertion(request);
  const answer = await client.passkeyRequest('passkey-assert', { assertion });
  if (answer.unlocked !== true) throw new CoreError({ code: 'client/bad-message', message: 'The computer did not unlock this device' });
  return { ok: true };
}

/**
 * Ask the Host to lock this socket again (contract §14.2). Accepted in any lock state, so a tab
 * that reloaded into a locked socket can still say so; a stale Host that does not know the frame
 * refuses it, and the caller treats that as "already locked" — the socket is locked either way.
 */
export async function lockPasskeySocket(client: CompanionClient): Promise<void> {
  try {
    await client.request(PASSKEY_LOCK_TYPE as never, {}, { allowNonOpType: true });
  } catch (error) {
    // A dropped socket is already a lock; anything else (e.g. `op/forbidden` from a Host that
    // predates revision 14) is reported, and the caller closes the socket regardless.
    if (errorCodeOf(error) === 'client/disconnected') return;
    throw error;
  }
}

/**
 * Report every `passkey-approval` push from `client` (contract §14.3). Returns the unsubscribe.
 * The listener must ignore every socket but the current one (the caller's job).
 */
export function watchPasskeyApproval(
  client: CompanionClient,
  onApproval: (approval: PasskeyApproval) => void,
): () => void {
  return client.on('passkeyApproval', onApproval);
}

// ---------------------------------------------------------------------------
// The gate's platform surface (`biometrics.web.ts` re-exports these two)
// ---------------------------------------------------------------------------

/** `passcode` == "a passkey can verify you here"; everything else keeps the gate shut. */
export async function unlockCapability(): Promise<UnlockCapability> {
  return webauthnAvailable() ? 'passcode' : 'unavailable';
}

/** Prompt copy is the app's own (`unlock.prompt`); WebAuthn has no configurable message. */
export async function biometricLabel(): Promise<string | null> {
  return null;
}

/**
 * One unlock attempt. `client` is the CURRENT socket (the controller's); without one there is
 * nothing to assert against and the result is the ordinary locked state.
 *
 * Every failure keeps the gate locked and names a reason the gate has copy for
 * (`LOCK_COPY` in `src/core/web-lock.ts`), never the Host's internal message.
 */
export async function authenticate(_promptMessage: string, client: CompanionClient | null): Promise<UnlockResult> {
  if (!webauthnAvailable()) return { ok: false, capability: 'unavailable', reason: 'not-supported' };
  if (client === null || client.state !== 'ready') return { ok: false, capability: 'passcode', reason: 'locked' };
  try {
    await assertPasskey(client);
    return { ok: true, capability: 'passcode' };
  } catch (error) {
    return { ok: false, capability: 'passcode', reason: lockReasonFor(error) };
  }
}
