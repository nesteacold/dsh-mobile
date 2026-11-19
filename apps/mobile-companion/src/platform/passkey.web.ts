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

import { PASSKEY_ASSERT_OPTIONS_TYPE, PASSKEY_ASSERT_TYPE, PASSKEY_REGISTER_OPTIONS_TYPE, PASSKEY_REGISTER_TYPE } from '@dsh-ext/mobile-protocol';

import { CoreError } from '../core/errors';
import type { CompanionClient } from '../core/client';
import {
  PASSKEY_DISMISSED,
  PASSKEY_LOCK_TYPE,
  PASSKEY_NOT_ALLOWED,
  PASSKEY_TIMEOUT,
  WEBAUTHN_APP_TIMEOUT_MS,
  assertionFrom,
  assertionRequestFrom,
  attestationFrom,
  errorCodeOf,
  lockReasonFor,
  preparedOptionsFresh,
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
  return new CoreError({
    code: PASSKEY_NOT_ALLOWED,
    message: 'The browser could not use a passkey here',
    cause: error,
  });
}

/**
 * A `NotAllowedError` (or a null credential) is AMBIGUOUS: a user cancel, a browser timeout and a
 * lost user activation all look identical. Spec 037 gives it its own neutral code/copy instead of
 * blaming the Host, and the copy always names the next action (tap Unlock again).
 */
function dismissed(cause?: unknown): CoreError {
  return new CoreError({
    code: PASSKEY_DISMISSED,
    message: 'The passkey prompt was dismissed or timed out — tap Unlock to try again',
    cause,
  });
}

function bufferSource(bytes: Uint8Array): BufferSource {
  return bytes as unknown as BufferSource;
}

/**
 * `navigator.credentials.create` for the decoded options. The RP id is the page's hostname and the
 * challenge binds the credential to the socket; nothing else about the request is App-side policy.
 */
export async function createPasskey(request: PasskeyRegistrationRequest, signal?: AbortSignal): Promise<PasskeyAttestation> {
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
      // `signal` belongs to CredentialCreationOptions, beside `publicKey` — never inside it.
      ...(signal === undefined ? {} : { signal }),
    } as CredentialCreationOptions);
    // A null credential means no passkey was made (the prompt was dismissed): never "success".
    if (credential === null) throw declined(undefined);
    return attestationFrom(credential);
  } catch (error) {
    if (error instanceof CoreError) throw error;
    throw declined(error);
  }
}

/** `navigator.credentials.get` for the decoded options (low-level; no app deadline). */
export async function getPasskeyAssertion(request: PasskeyAssertionRequest, signal?: AbortSignal): Promise<PasskeyAssertion> {
  try {
    const credential = await navigator.credentials.get({
      publicKey: {
        challenge: bufferSource(request.challenge),
        rpId: request.rpId,
        allowCredentials: request.allowCredentials.map((entry) => ({ type: entry.type, id: bufferSource(entry.id) })),
        userVerification: 'required',
        timeout: request.timeout,
      },
      // `signal` is a member of CredentialRequestOptions (next to `publicKey`), NOT of the
      // WebAuthn public-key dictionary. Putting it inside `publicKey` is silently ignored.
      ...(signal === undefined ? {} : { signal }),
    } as CredentialRequestOptions);
    if (credential === null) throw dismissed(undefined);
    return assertionFrom(credential);
  } catch (error) {
    if (error instanceof CoreError) throw error;
    if (typeof error === 'object' && error !== null && (error as { name?: unknown }).name === 'NotAllowedError') throw dismissed(error);
    throw declined(error);
  }
}

// ---------------------------------------------------------------------------
// Spec 037 — prefetched assertion options + one-shot, deadline-bounded ceremony
// ---------------------------------------------------------------------------

/** A decoded `passkey-assert-options` answer, bound to the socket and the attempt that asked for it. */
export interface PreparedAssertionOptions {
  client: CompanionClient;
  request: PasskeyAssertionRequest;
  /** WHEN THE OPTIONS REQUEST WAS SENT — the Host TTL starts here, not at response arrival. */
  sentAt: number;
  attempt: number;
}

/** The browser/platform deps of the ceremony, injectable so timing/races are testable without a 25 s wait. */
export interface PasskeyUnlockDeps {
  now: () => number;
  setTimer: (fn: () => void, ms: number) => unknown;
  clearTimer: (handle: unknown) => void;
  getCredential: (request: PasskeyAssertionRequest, signal?: AbortSignal) => Promise<unknown>;
}

/** A tap may tell the controller when the native sheet is actually opening (preparing -> prompting). */
export interface PasskeyAssertHooks {
  onPrompt?: () => void;
}

export interface WebPasskeyUnlock {
  /** Start (or reuse) the single serialized options request for this socket; never throws. */
  prefetch(client: CompanionClient): void;
  /** The in-flight options promise, when one is pending for this socket. */
  pendingOptions(client: CompanionClient): Promise<PreparedAssertionOptions | null> | null;
  /** Consume a still-fresh prepared request; clears the cache immediately. */
  takePrepared(client: CompanionClient): PreparedAssertionOptions | null;
  /** Drop cache + in-flight response + in-flight ceremony. Late results become no-ops. */
  invalidate(): void;
  /** One unlock ceremony: prepared fast path or fallback, with a 25 s app deadline. */
  assert(client: CompanionClient, hooks?: PasskeyAssertHooks): Promise<{ ok: true }>;
}

function defaultGetCredential(request: PasskeyAssertionRequest, signal?: AbortSignal): Promise<unknown> {
  return navigator.credentials.get({
    publicKey: {
      challenge: bufferSource(request.challenge),
      rpId: request.rpId,
      allowCredentials: request.allowCredentials.map((entry) => ({ type: entry.type, id: bufferSource(entry.id) })),
      userVerification: 'required',
      timeout: request.timeout,
    },
    // CredentialRequestOptions.signal, not PublicKeyCredentialRequestOptions.signal.
    ...(signal === undefined ? {} : { signal }),
  } as CredentialRequestOptions) as Promise<unknown>;
}

/**
 * Build an isolated prefetch/ceremony engine. The app uses one module-level instance; tests build
 * their own with a fake clock and a controllable `getCredential` so a never-settling native sheet,
 * a late resolution and a refresh race are all observable without real time or a real browser.
 */
export function createWebPasskeyUnlock(overrides: Partial<PasskeyUnlockDeps> = {}): WebPasskeyUnlock {
  const deps: PasskeyUnlockDeps = {
    now: overrides.now ?? (() => Date.now()),
    setTimer: overrides.setTimer ?? ((fn, ms) => setTimeout(fn, ms)),
    clearTimer: overrides.clearTimer ?? ((handle) => clearTimeout(handle as ReturnType<typeof setTimeout>)),
    getCredential: overrides.getCredential ?? defaultGetCredential,
  };

  let preparedAttempt = 0;
  let prepared: PreparedAssertionOptions | null = null;
  type OptionsInFlight = {
    client: CompanionClient;
    attempt: number;
    promise: Promise<PreparedAssertionOptions | null>;
  };
  /**
   * Per-socket options requests still RUNNING. An entry stays here until its promise settles —
   * invalidation marks an entry obsolete by bumping `preparedAttempt`, it does NOT delete it.
   * That way a new request on the SAME socket waits for the old one instead of running in parallel
   * (different sockets may run independently: the contract serializes per socket).
   */
  const optionsInFlight: OptionsInFlight[] = [];
  const readInFlight = (client?: CompanionClient): OptionsInFlight | null =>
    optionsInFlight.find((entry) => client === undefined || entry.client === client) ?? null;
  /** Bumped by every ceremony start AND by every external invalidation. */
  let ceremony = 0;
  /** Spec 037 §1: no options refresh while a ceremony is running, even if prefetch is called again. */
  let ceremonyActive = false;

  const current = (id: number): boolean => id === ceremony;

  const freshPrepared = (client: CompanionClient): PreparedAssertionOptions | null => {
    if (prepared === null || prepared.client !== client || prepared.attempt !== preparedAttempt) return null;
    if (!preparedOptionsFresh(prepared.sentAt, deps.now())) {
      prepared = null;
      return null;
    }
    return prepared;
  };

  /**
   * Serialize options requests. The cached request is invalidated BEFORE the frame is sent: the Host
   * replaces its challenge as soon as it handles the request, even if the answer is still in flight.
   * A late answer is accepted only when client + attempt still match the one that is in flight.
   */
  function startOptions(client: CompanionClient): Promise<PreparedAssertionOptions | null> {
    // Serialize PER SOCKET, including an obsolete request still on the wire. A new request for this
    // client must not go out until the previous one has settled (review 037 fix #2).
    const existing = readInFlight(client);
    if (existing !== null) return existing.promise;
    prepared = null;
    const attempt = ++preparedAttempt;
    const sentAt = deps.now();
    const promise = (async (): Promise<PreparedAssertionOptions | null> => {
      try {
        const answer = await client.passkeyRequest(PASSKEY_ASSERT_OPTIONS_TYPE);
        const inFlight = readInFlight(client);
        // `preparedAttempt` is the generation: invalidate() bumps it without clearing `inFlight`,
        // so a late answer whose attempt is no longer current is discarded here.
        if (inFlight === null || inFlight.attempt !== attempt || attempt !== preparedAttempt) return null;
        const value: PreparedAssertionOptions = { client, request: assertionRequestFrom(answer), sentAt, attempt };
        prepared = value;
        return value;
      } catch (error) {
        // The fallback unlock path must surface the Host's refusal code (e.g. `passkey/not-registered`).
        // Only `prefetch()` swallows it (best effort), by attaching its own catch to this promise.
        throw error;
      } finally {
        const index = optionsInFlight.findIndex((entry) => entry.attempt === attempt && entry.client === client);
        if (index >= 0) optionsInFlight.splice(index, 1);
      }
    })();
    optionsInFlight.push({ client, attempt, promise });
    return promise;
  }

  function pendingOptions(client: CompanionClient): Promise<PreparedAssertionOptions | null> | null {
    return readInFlight(client)?.promise ?? null;
  }

  function takePrepared(client: CompanionClient): PreparedAssertionOptions | null {
    const value = freshPrepared(client);
    if (value === null) return null;
    prepared = null;                                    // the tap CONSUMES the cache immediately
    return value;
  }

  async function getAssertionWithTimeout(
    request: PasskeyAssertionRequest,
    id: number,
  ): Promise<PasskeyAssertion> {
    const controller = typeof AbortController === 'function' ? new AbortController() : null;
    let timer: unknown = null;
    try {
      const credential = await Promise.race([
        deps.getCredential(request, controller?.signal),
        new Promise<never>((_resolve, reject) => {
          timer = deps.setTimer(() => {
            // Best effort: not every WebAuthn implementation can close a native sheet. The
            // generation check below is the authority that discards a late result.
            controller?.abort();
            reject(new CoreError({ code: PASSKEY_TIMEOUT, message: 'The passkey check timed out — tap Unlock to try again' }));
          }, WEBAUTHN_APP_TIMEOUT_MS);
        }),
      ]);
      if (!current(id)) throw new CoreError({ code: 'client/bad-state', message: 'The unlock attempt was superseded' });
      if (credential === null) throw dismissed(undefined);
      return assertionFrom(credential);
    } catch (error) {
      if (error instanceof CoreError) throw error;
      if (typeof error === 'object' && error !== null && (error as { name?: unknown }).name === 'NotAllowedError') {
        throw dismissed(error);
      }
      throw declined(error);
    } finally {
      if (timer !== null) deps.clearTimer(timer);
    }
  }

  return {
    prefetch(client) {
      if (ceremonyActive) return;                    // refresh only while idle (spec 037 §1)
      if (readInFlight(client) !== null) return;     // one request per socket, serialized
      if (freshPrepared(client) !== null) return;    // already prepared: fetch once
      // Best effort: a refused/expired options request leaves no cache and must not become an
      // unhandled rejection. The promise ITSELF still rejects, so a tap reusing it sees the code.
      void startOptions(client).catch(() => undefined);
    },
    pendingOptions,
    takePrepared,
    invalidate() {
      ceremony += 1;                                  // a late WebAuthn result becomes a no-op
      preparedAttempt += 1;                           // a late options answer becomes a no-op
      prepared = null;
      // The in-flight options request(s) stay TRACKED until they settle; bumping `preparedAttempt`
      // marks their answers obsolete. Clearing the tracking here would allow two parallel options
      // requests on the same socket when a retry follows an invalidation (review 037 fix #2).
      ceremonyActive = false;
    },
    async assert(client, hooks) {
      // Every tap is its own ceremony. A retry while an older native sheet is still open gets a NEW
      // id; the older promise's late resolution can never send an assertion or open the gate.
      const id = ++ceremony;
      ceremonyActive = true;
      try {
        let options = takePrepared(client);
        if (options === null) {
          // No prepared request (or it expired): reuse the single pending refresh when safe,
          // otherwise wait for a fresh one. A tap during a pending refresh NEVER uses old cache.
          const waited = await (pendingOptions(client) ?? startOptions(client));
          if (!current(id) || (waited !== null && waited.client !== client)) {
            throw new CoreError({ code: 'client/bad-state', message: 'The unlock attempt was superseded' });
          }
          // `waited === null` means its answer was obsolete (invalidated while on the wire): fall
          // through to the cache check and fetch a fresh request below.
          // Review 037 fix #1: never use the awaited result directly. Go back through the cache,
          // which re-checks freshness (challenge budget) AND consumes it, so a retry cannot reuse
          // a challenge that was already spent. A late/obsolete answer leaves no cache here.
          options = takePrepared(client);
          if (options === null || !current(id)) {
            // Invalidated or too little challenge life left: fetch ONE fresh request sequentially
            // (the old one has settled by now) before opening the native sheet.
            const fresh = await startOptions(client);
            if (!current(id) || fresh === null || fresh.client !== client) {
              throw new CoreError({ code: 'client/bad-state', message: 'The unlock attempt was superseded' });
            }
            options = takePrepared(client);
          }
          if (options === null || !current(id)) {
            throw new CoreError({ code: 'client/bad-state', message: 'The unlock attempt was superseded' });
          }
        }
        hooks?.onPrompt?.();
        const assertion = await getAssertionWithTimeout(options.request, id);
        if (!current(id)) throw new CoreError({ code: 'client/bad-state', message: 'The unlock attempt was superseded' });
        const answer = await client.passkeyRequest(PASSKEY_ASSERT_TYPE, { assertion });
        if (!current(id)) throw new CoreError({ code: 'client/bad-state', message: 'The unlock attempt was superseded' });
        if (answer.unlocked !== true) {
          throw new CoreError({ code: 'client/bad-message', message: 'The computer did not unlock this device' });
        }
        return { ok: true };
      } finally {
        // Only the CURRENT ceremony may release the "busy" flag. A superseded retry's `finally`
        // must not mark a newer, still-running ceremony as idle.
        if (current(id)) ceremonyActive = false;
      }
    },
  };
}

/** The app's one engine (module memory only — never persisted, never shared between sockets). */
const defaultUnlock = createWebPasskeyUnlock();

/** Called by the controller when a web socket becomes ready and locked (spec 037 §1). */
export function prefetchAssertionOptions(client: CompanionClient): void {
  defaultUnlock.prefetch(client);
}

/** Called on socket change, lock, revoke, reauth, grant-unlock and app background (spec 037 §6). */
export function invalidateWebPasskey(): void {
  defaultUnlock.invalidate();
}

/** The exported test seam: an isolated engine with a fake clock / controllable native sheet. */
export { createWebPasskeyUnlock as createWebPasskeyUnlockForTest };

/**
 * Register this device's passkey. Resolves after the Host accepted it; throws `CoreError`s whose
 * `code` is the contract code (`passkey/already-registered` included).
 */
export async function registerPasskey(client: CompanionClient): Promise<{ ok: true }> {
  const options = await client.passkeyRequest(PASSKEY_REGISTER_OPTIONS_TYPE);
  const request = registrationRequestFrom(options);
  const attestation = await createPasskey(request);
  const answer = await client.passkeyRequest(PASSKEY_REGISTER_TYPE, { attestation });
  if (answer.ok !== true) throw new CoreError({ code: 'client/bad-message', message: 'The computer did not confirm the passkey' });
  return { ok: true };
}

/**
 * Assert the passkey on THIS socket: the Host's verification is what unlocks it (contract §14.1).
 *
 * Spec 037: consumes a prepared request when one is fresh (no WebSocket options round-trip before
 * the native sheet), otherwise reuses/awaits the single options refresh. The 25 s app deadline and
 * the ceremony generation guard live in `createWebPasskeyUnlock`; a late result never asserts.
 */
export async function assertPasskey(client: CompanionClient, hooks?: PasskeyAssertHooks): Promise<{ ok: true }> {
  return defaultUnlock.assert(client, hooks);
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
