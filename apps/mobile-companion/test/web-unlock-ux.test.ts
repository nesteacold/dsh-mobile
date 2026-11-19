// Spec 037 — web unlock UX: prefetched options, immediate feedback, bounded ceremonies.
//
// Everything here is BEHAVIOURAL: a fake clock, a fake `navigator.credentials.get` and a fake client
// whose frames are recorded. No source regex. The assertions are about which frames were sent, when,
// which challenge the native sheet received, and whether a late result can unlock anything.

import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import {
  LOCK_COPY,
  PASSKEY_DISMISSED,
  PASSKEY_TIMEOUT,
  WEBAUTHN_APP_TIMEOUT_MS,
  lockReasonFor,
  preparedOptionsFresh,
  unlockCopyKey,
} from '../src/core/web-lock';
import {
  createWebPasskeyUnlock,
  type PasskeyUnlockDeps,
} from '../src/platform/passkey.web';
import { CoreError } from '../src/core/errors';
import { decodeBase64Url, encodeBase64Url } from '../src/core/base64url';
import { t } from '../i18n';

// ---------------------------------------------------------------------------
// Fixtures
// ---------------------------------------------------------------------------

const CHALLENGE_A = encodeBase64Url(new Uint8Array(32).fill(7));
const CHALLENGE_B = encodeBase64Url(new Uint8Array(32).fill(9));
const CREDENTIAL_ID = encodeBase64Url(new Uint8Array(16).fill(3));

function optionsAnswer(challenge: string): Record<string, unknown> {
  return {
    kind: 'passkey-assert-options',
    requestId: 'r-opt',
    challenge,
    rpId: 'host.example.ts.net',
    allowCredentials: [{ type: 'public-key', id: CREDENTIAL_ID }],
    timeout: 60_000,
  };
}

function fakeCredential(challenge: string) {
  const rawId = (decodeBase64Url(CREDENTIAL_ID) as Uint8Array).slice().buffer as ArrayBuffer;
  const clientDataJSON = new TextEncoder().encode(JSON.stringify({
    type: 'webauthn.get',
    challenge,
    origin: 'https://host.example.ts.net:18443',
  })).buffer as ArrayBuffer;
  return {
    id: CREDENTIAL_ID,
    rawId,
    type: 'public-key',
    response: {
      clientDataJSON,
      authenticatorData: new Uint8Array([1, 2, 3, 4]).buffer,
      signature: new Uint8Array([0x30, 0x44]).buffer,
      userHandle: null,
    },
  };
}

/** A scripted client: every frame is recorded; options answers come from the provided queue. */
function scriptedClient(options: Array<Record<string, unknown> | Error>) {
  const sent: Array<{ type: string; params: Record<string, unknown> }> = [];
  const queue = [...options];
  const client = {
    state: 'ready',
    passkeyRequest: async (type: string, params: Record<string, unknown> = {}) => {
      sent.push({ type, params });
      if (type === 'passkey-assert-options') {
        const next = queue.shift();
        if (next instanceof Error) throw next;
        if (next === undefined) throw new CoreError({ code: 'client/timeout', message: 'no options answer' });
        return next;
      }
      if (type === 'passkey-assert') return { kind: 'passkey-assert', unlocked: true };
      throw new CoreError({ code: 'client/bad-message', message: `unexpected ${type}` });
    },
    request: async () => ({ kind: 'ok' }),
    on: () => () => undefined,
  };
  return { client: client as never, sent };
}

/** Manual clock: `advance` fires timers in due order, so a 25 s deadline is instant. */
function fakeClock(start = 1_000_000) {
  let now = start;
  let sequence = 0;
  const timers = new Map<number, { at: number; fn: () => void }>();
  const deps: PasskeyUnlockDeps = {
    now: () => now,
    setTimer: (fn, ms) => {
      const id = ++sequence;
      timers.set(id, { at: now + ms, fn });
      return id;
    },
    clearTimer: (handle) => { timers.delete(handle as number); },
    getCredential: async () => fakeCredential(CHALLENGE_A),
  };
  const advance = (ms: number) => {
    now += ms;
    for (const [id, timer] of [...timers].sort((a, b) => a[1].at - b[1].at)) {
      if (timer.at <= now) {
        timers.delete(id);
        timer.fn();
      }
    }
  };
  return { deps, advance, now: () => now };
}

/** A `get` promise the test resolves explicitly (a native sheet that stays open). */
function deferredCredential() {
  let resolve!: (value: unknown) => void;
  const promise = new Promise<unknown>((res) => { resolve = res; });
  return { promise, resolve };
}

/** Drain nested promise chains (an assert crosses several awaits). */
async function flush(): Promise<void> {
  await new Promise<void>((resolve) => setImmediate(resolve));
  await new Promise<void>((resolve) => setImmediate(resolve));
}

// ---------------------------------------------------------------------------
// 1. Prefetch once, then a prepared tap has NO options round-trip before the sheet
// ---------------------------------------------------------------------------

describe('spec 037: prefetched assertion options', () => {
  it('prefetches once, then a tap opens the sheet from the prepared request and sends exactly one assertion', async () => {
    const clock = fakeClock();
    const unlock = createWebPasskeyUnlock(clock.deps);
    const { client, sent } = scriptedClient([optionsAnswer(CHALLENGE_A), optionsAnswer(CHALLENGE_A)]);
    const prompts: string[] = [];

    unlock.prefetch(client);
    unlock.prefetch(client); // a second prefetch must not ask again
    await flush();
    assert.deepEqual(sent.map((f) => f.type), ['passkey-assert-options'], 'options fetched once');

    await unlock.assert(client, { onPrompt: () => prompts.push('prompt') });
    assert.deepEqual(sent.map((f) => f.type), ['passkey-assert-options', 'passkey-assert'], 'no second options frame before the assertion');
    assert.deepEqual(prompts, ['prompt']);
    // The prepared request was consumed: a later tap starts a fresh options request.
    await unlock.assert(client);
    assert.deepEqual(sent.map((f) => f.type), ['passkey-assert-options', 'passkey-assert', 'passkey-assert-options', 'passkey-assert']);
  });

  it('a tap during a pending refresh never uses the old challenge — even when the Host replaces it', async () => {
    const clock = fakeClock();
    const unlock = createWebPasskeyUnlock(clock.deps);
    let resolveOptions!: (answer: Record<string, unknown>) => void;
    const optionsGate = new Promise<Record<string, unknown>>((res) => { resolveOptions = res; });
    const sent: string[] = [];
    const client = {
      state: 'ready',
      passkeyRequest: async (type: string, _params?: Record<string, unknown>) => {
        sent.push(type);
        if (type === 'passkey-assert-options') return optionsGate;
        return { kind: 'passkey-assert', unlocked: true };
      },
      request: async () => ({ kind: 'ok' }),
      on: () => () => undefined,
    } as never;
    const sheets: string[] = [];
    const deps: PasskeyUnlockDeps = {
      ...clock.deps,
      getCredential: async (request) => {
        sheets.push(encodeBase64Url(request.challenge));
        return fakeCredential(encodeBase64Url(request.challenge));
      },
    };
    const racing = createWebPasskeyUnlock(deps);

    racing.prefetch(client); // Host is about to replace the challenge
    await Promise.resolve();
    const tap = racing.assert(client);
    await Promise.resolve();
    resolveOptions(optionsAnswer(CHALLENGE_B)); // the NEW challenge answers late
    await tap;

    assert.deepEqual(sent, ['passkey-assert-options', 'passkey-assert'], 'only one options request, reused by the tap');
    assert.deepEqual(sheets, [CHALLENGE_B], 'the sheet used the fresh challenge, never the stale cached one');
  });

  it('refuses a prepared request at the age boundary and fetches fresh options', async () => {
    const clock = fakeClock();
    const unlock = createWebPasskeyUnlock(clock.deps);
    const { client, sent } = scriptedClient([optionsAnswer(CHALLENGE_A), optionsAnswer(CHALLENGE_B)]);

    unlock.prefetch(client);
    await flush();
    // sentAt=1000000, TTL=60000. Remaining at +30000 is exactly the minimum (25s + 5s).
    assert.equal(preparedOptionsFresh(1_000_000, 1_030_000), true);
    assert.equal(preparedOptionsFresh(1_000_000, 1_030_001), false, 'one ms past the boundary is stale');

    clock.advance(30_001);
    await unlock.assert(client);
    assert.deepEqual(sent.map((f) => f.type), ['passkey-assert-options', 'passkey-assert-options', 'passkey-assert'], 'a stale cache triggers a fresh options request');
  });
});

// ---------------------------------------------------------------------------
// 2. A never-settling native sheet: definite timeout, no assertion, retryable
// ---------------------------------------------------------------------------

describe('spec 037: bounded WebAuthn ceremony', () => {
  it('abandons a never-settling sheet after 25 s; a retry on the SAME engine is not corrupted by its late result', async () => {
    const clock = fakeClock();
    const firstSheet = deferredCredential();
    const secondSheet = deferredCredential();
    const aborted: boolean[] = [];
    const sheets: string[] = [];
    let getCount = 0;
    const deps: PasskeyUnlockDeps = {
      ...clock.deps,
      getCredential: (request, signal) => {
        getCount += 1;
        sheets.push(encodeBase64Url(request.challenge));
        signal?.addEventListener('abort', () => aborted.push(signal.aborted));
        return getCount === 1 ? firstSheet.promise : secondSheet.promise;
      },
    };
    // ONE engine for both attempts — the generation guard must work inside a single instance.
    const unlock = createWebPasskeyUnlock(deps);
    const { client, sent } = scriptedClient([optionsAnswer(CHALLENGE_A), optionsAnswer(CHALLENGE_B)]);

    const attempt = unlock.assert(client);
    let reason: string | null = null;
    attempt.catch((error: unknown) => { reason = lockReasonFor(error); });
    await flush();
    clock.advance(WEBAUTHN_APP_TIMEOUT_MS);
    await assert.rejects(attempt, (error: unknown) => {
      assert.equal((error as { code?: string }).code, PASSKEY_TIMEOUT);
      return true;
    });
    assert.equal(reason, 'passkey-timeout');
    assert.deepEqual(sent.map((f) => f.type), ['passkey-assert-options'], 'no assertion was sent on timeout');
    assert.deepEqual(aborted, [true], 'an AbortSignal was used and fired when the browser accepts it');

    // The first native sheet is STILL open. A retry on the same engine / same client starts a new
    // ceremony with its own options (review 037 fix #4: same engine, not a fresh one).
    const retry = unlock.assert(client);
    await flush();
    assert.deepEqual(sheets, [CHALLENGE_A, CHALLENGE_B], 'the retry fetched a fresh challenge');
    secondSheet.resolve(fakeCredential(CHALLENGE_B));
    assert.deepEqual(await retry, { ok: true });
    assert.deepEqual(sent.map((f) => f.type), ['passkey-assert-options', 'passkey-assert-options', 'passkey-assert']);

    // Now the OLD sheet finally answers: its generation is stale, so no second assertion is sent.
    firstSheet.resolve(fakeCredential(CHALLENGE_A));
    await flush();
    assert.deepEqual(sent.map((f) => f.type), ['passkey-assert-options', 'passkey-assert-options', 'passkey-assert'], 'late first result sent no assertion');
  });

  it('a retry after a fallback sends NEW options — it never reuses the challenge already spent', async () => {
    const clock = fakeClock();
    const sheets: string[] = [];
    const unlock = createWebPasskeyUnlock({
      ...clock.deps,
      getCredential: async (request) => {
        const challenge = encodeBase64Url(request.challenge);
        sheets.push(challenge);
        return fakeCredential(challenge);
      },
    });
    const { client, sent } = scriptedClient([optionsAnswer(CHALLENGE_A), optionsAnswer(CHALLENGE_B)]);

    assert.deepEqual(await unlock.assert(client), { ok: true }); // fallback: options A -> get -> assert
    assert.deepEqual(await unlock.assert(client), { ok: true }); // retry must NOT reuse A

    assert.deepEqual(sheets, [CHALLENGE_A, CHALLENGE_B], 'the second ceremony used a fresh challenge');
    assert.deepEqual(sent.map((f) => f.type), [
      'passkey-assert-options', 'passkey-assert', 'passkey-assert-options', 'passkey-assert',
    ], 'a retry after a fallback sends a new options frame before its assertion');
  });

  it('a NotAllowedError gets neutral copy, distinct from the definite app timeout', () => {
    assert.equal(lockReasonFor(new CoreError({ code: PASSKEY_TIMEOUT, message: '' })), 'passkey-timeout');
    assert.equal(lockReasonFor(new CoreError({ code: PASSKEY_DISMISSED, message: '' })), 'passkey-dismissed');
    assert.notEqual(LOCK_COPY['passkey-timeout'], LOCK_COPY['passkey-dismissed']);
    assert.equal(unlockCopyKey({ state: 'locked', error: 'passkey-timeout' }), 'unlock.passkeyTimeout');
    assert.equal(unlockCopyKey({ state: 'locked', error: 'passkey-dismissed' }), 'unlock.passkeyDismissed');
    assert.equal(t('en', 'unlock.passkeyTimeout'), 'The passkey check took too long. Tap Unlock to try again.');
    assert.equal(t('vi', 'unlock.unlocking'), 'Đang mở khoá…', 'Vietnamese busy copy exists');
  });
});

// ---------------------------------------------------------------------------
// 3. Invalidation makes a prepared challenge and an in-flight ceremony no-ops
// ---------------------------------------------------------------------------

describe('spec 037: invalidation', () => {
  it('a prepared request is dropped on invalidate, so the next assert fetches fresh options', async () => {
    const clock = fakeClock();
    const unlock = createWebPasskeyUnlock(clock.deps);
    const { client, sent } = scriptedClient([
      optionsAnswer(CHALLENGE_A),
      optionsAnswer(CHALLENGE_B),
      optionsAnswer(CHALLENGE_A),
      optionsAnswer(CHALLENGE_B),
    ]);

    unlock.prefetch(client);
    await flush();
    assert.notEqual(unlock.takePrepared(client), null, 'the prefetch produced a prepared request');
    // Repopulate, then invalidate: the cached request must be dropped, not used by the tap.
    unlock.prefetch(client);
    await flush();
    assert.notEqual(unlock.takePrepared(client), null);
    unlock.prefetch(client);
    await flush();

    unlock.invalidate();
    assert.equal(unlock.takePrepared(client), null, 'invalidate cleared the cache');
    await unlock.assert(client);
    assert.deepEqual(sent.map((f) => f.type), [
      'passkey-assert-options', 'passkey-assert-options', 'passkey-assert-options', 'passkey-assert-options', 'passkey-assert',
    ], 'fresh options after invalidation');
  });

  it('an in-flight ceremony answering after invalidate sends no assertion', async () => {
    const clock = fakeClock();
    const sheet = deferredCredential();
    const unlock = createWebPasskeyUnlock({ ...clock.deps, getCredential: () => sheet.promise });
    const { client, sent } = scriptedClient([optionsAnswer(CHALLENGE_A)]);

    const attempt = unlock.assert(client);
    let settled = false;
    void attempt.then(() => { settled = true; }, () => { settled = true; });
    await flush();
    unlock.invalidate();
    sheet.resolve(fakeCredential(CHALLENGE_A));
    await flush();
    assert.equal(settled, true);
    assert.deepEqual(sent.map((f) => f.type), ['passkey-assert-options'], 'a stale ceremony never sent passkey-assert');
  });

  it('invalidate while options are pending keeps the retry serialized on the SAME socket', async () => {
    const clock = fakeClock();
    let answerFirst!: (answer: Record<string, unknown>) => void;
    const firstOptions = new Promise<Record<string, unknown>>((res) => { answerFirst = res; });
    const sent: string[] = [];
    const queued: Array<Promise<Record<string, unknown>> | Record<string, unknown>> = [
      firstOptions,
      optionsAnswer(CHALLENGE_B),
    ];
    const client = {
      state: 'ready',
      passkeyRequest: async (type: string, _params?: Record<string, unknown>) => {
        sent.push(type);
        if (type === 'passkey-assert-options') {
          const next = queued.shift();
          return next instanceof Promise ? next : (next as Record<string, unknown>);
        }
        return { kind: 'passkey-assert', unlocked: true };
      },
      request: async () => ({ kind: 'ok' }),
      on: () => () => undefined,
    } as never;
    const sheets: string[] = [];
    const unlock = createWebPasskeyUnlock({
      ...clock.deps,
      getCredential: async (request) => {
        const challenge = encodeBase64Url(request.challenge);
        sheets.push(challenge);
        return fakeCredential(challenge);
      },
    });

    unlock.prefetch(client); // options A is on the wire, not answered yet
    await flush();
    unlock.invalidate();     // A is now obsolete, but MUST stay tracked until it settles
    const attempt = unlock.assert(client);
    await flush();
    assert.deepEqual(sent, ['passkey-assert-options'], 'no second options request while A is still running');

    answerFirst(optionsAnswer(CHALLENGE_A)); // the obsolete answer arrives
    assert.deepEqual(await attempt, { ok: true });
    assert.deepEqual(sent, [
      'passkey-assert-options', 'passkey-assert-options', 'passkey-assert',
    ], 'the fresh options request went out ONLY after the old one settled');
    assert.deepEqual(sheets, [CHALLENGE_B], 'the sheet used the fresh challenge, never the obsolete A');
  });
});
