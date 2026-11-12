// Web passkey unlock (spec 021, contract revision 14) — the client half, against a FAKE WebAuthn.
//
// Two layers are tested here:
//   1. `src/core/web-lock.ts` — the pure codec/policy: base64url <-> bytes, the Host's options ->
//      `navigator.credentials.*` requests, the authenticator's answer -> the contracted frame, and
//      the reason vocabulary the gate's copy is chosen from. No DOM, no clock.
//   2. `src/platform/passkey.web.ts` — the same steps driven through a fake `navigator.credentials`
//      and a fake ready client, so the FRAMES (types, params, in-flight order) are asserted as
//      literally as the wire allows.
//
// The Host is the only thing that decides whether an assertion unlocked anything (contract §14.1),
// so "unlocked" here always means "the fake Host said `{unlocked:true}`".

import assert from 'node:assert/strict';
import { afterEach, beforeEach, describe, it } from 'node:test';

import { decodeBase64Url, encodeBase64Url } from '../src/core/base64url';
import {
  assertionFrom,
  assertionRequestFrom,
  attestationFrom,
  lockAction,
  lockReasonFor,
  registrationRequestFrom,
  unlockCopyKey,
  LOCK_COPY,
} from '../src/core/web-lock';
import { CoreError } from '../src/core/errors';
import {
  assertPasskey,
  lockPasskeySocket,
  registerPasskey,
  unlockCapability,
  watchPasskeyApproval,
} from '../src/platform/passkey.web';

// ---------------------------------------------------------------------------
// Fixtures: the exact shapes contract §14.1 shows on the wire
// ---------------------------------------------------------------------------

/** 32 random bytes, base64url — what a challenge looks like. */
const CHALLENGE = encodeBase64Url(new Uint8Array(32).fill(7));
/** `base64url(32 bytes)` of the stored credential (a P-256 key id is opaque; its length is not). */
const CREDENTIAL_ID = encodeBase64Url(new Uint8Array(16).fill(3));

const REGISTER_OPTIONS = {
  kind: 'passkey-register-options',
  requestId: 'r-1',
  challenge: CHALLENGE,
  rp: { id: 'host.example.ts.net', name: 'DSH Companion' },
  user: { id: encodeBase64Url(new TextEncoder().encode('device:d1')), name: 'Pixel', displayName: 'Pixel' },
  pubKeyCredParams: [{ type: 'public-key', alg: -7 }, { type: 'public-key', alg: -257 }],
  excludeCredentials: [],
  timeout: 60_000,
};

const ASSERT_OPTIONS = {
  kind: 'passkey-assert-options',
  requestId: 'r-2',
  challenge: CHALLENGE,
  rpId: 'host.example.ts.net',
  allowCredentials: [{ type: 'public-key', id: CREDENTIAL_ID }],
  timeout: 60_000,
};

function bytes(value: string): ArrayBuffer {
  const decoded = decodeBase64Url(value);
  assert.notEqual(decoded, null, `fixture ${value} must be base64url`);
  return (decoded as Uint8Array).slice().buffer as ArrayBuffer;
}

/** A PublicKeyCredential the way the browser hands it over (rawId/clientData are ArrayBuffers). */
function fakeCredential(kind: 'create' | 'get') {
  const rawId = bytes(CREDENTIAL_ID);
  const clientDataJSON = new TextEncoder().encode(JSON.stringify({ type: kind === 'create' ? 'webauthn.create' : 'webauthn.get', challenge: CHALLENGE, origin: 'https://host.example.ts.net:18443' })).buffer as ArrayBuffer;
  if (kind === 'create') {
    return {
      id: CREDENTIAL_ID,
      rawId,
      type: 'public-key',
      response: { clientDataJSON, attestationObject: new Uint8Array([0xa3, 0x63, 0x66, 0x6d, 0x74]).buffer },
    };
  }
  return {
    id: CREDENTIAL_ID,
    rawId,
    type: 'public-key',
    response: {
      clientDataJSON,
      authenticatorData: new Uint8Array([0x01, 0x02, 0x03, 0x04]).buffer,
      signature: new Uint8Array([0x30, 0x44]).buffer,
      userHandle: null,
    },
  };
}

/** What the fake browser is asked for, and what it answers (or throws). */
interface FakeWebAuthn {
  createCalls: Array<Record<string, unknown>>;
  getCalls: Array<Record<string, unknown>>;
  restores: Array<() => void>;
}

/**
 * Install a fake `navigator.credentials` + `window.isSecureContext`. `create`/`get` return the
 * credential above unless `answer` says otherwise (a `DOMException`-shaped rejection is how a
 * dismissed prompt arrives in every browser).
 */
function installWebAuthn(answer?: { create?: unknown; get?: unknown }): FakeWebAuthn {
  const calls: FakeWebAuthn = { createCalls: [], getCalls: [], restores: [] };
  const navigatorObject = globalThis.navigator as unknown as { credentials?: unknown };
  const previousCredentials = navigatorObject.credentials;
  const previousWindow = (globalThis as { window?: unknown }).window;
  navigatorObject.credentials = {
    create: async (options: Record<string, unknown>) => {
      calls.createCalls.push(options);
      if (answer?.create instanceof Error) throw answer.create;
      return answer?.create === undefined ? fakeCredential('create') : answer.create;
    },
    get: async (options: Record<string, unknown>) => {
      calls.getCalls.push(options);
      if (answer?.get instanceof Error) throw answer.get;
      return answer?.get === undefined ? fakeCredential('get') : answer.get;
    },
  };
  (globalThis as { window?: unknown }).window = { isSecureContext: true };
  calls.restores.push(() => {
    navigatorObject.credentials = previousCredentials;
    (globalThis as { window?: unknown }).window = previousWindow;
  });
  return calls;
}

/** A ready client: records every frame and answers from `answers` (in order). */
function fakeClient(answers: Array<Record<string, unknown> | Error>) {
  const sent: Array<{ type: string; params: Record<string, unknown> }> = [];
  const client = {
    state: 'ready',
    passkeyRequest: async (type: string, params: Record<string, unknown> = {}) => {
      sent.push({ type, params });
      const next = answers.shift();
      if (next === undefined) throw new CoreError({ code: 'client/timeout', message: 'no answer scripted' });
      if (next instanceof Error) throw next;
      return next;
    },
    request: async (type: string, params: Record<string, unknown> = {}) => {
      sent.push({ type, params });
      const next = answers.shift();
      if (next === undefined) return { kind: type };
      if (next instanceof Error) throw next;
      return next;
    },
    on: () => () => undefined,
  };
  return { client: client as never, sent };
}

// ---------------------------------------------------------------------------
// 1. The codec
// ---------------------------------------------------------------------------

describe('base64url codec', () => {
  it('round-trips every byte value and every length remainder', () => {
    for (let length = 0; length <= 8; length += 1) {
      const source = Uint8Array.from({ length }, (_, index) => (index * 37 + 11) & 0xff);
      const encoded = encodeBase64Url(source);
      assert.deepEqual(decodeBase64Url(encoded), source, `length ${length}`);
    }
  });

  it('is unpadded and url-safe (no +, / or =)', () => {
    const encoded = encodeBase64Url(new Uint8Array([0xfb, 0xff, 0xbf]));
    assert.doesNotMatch(encoded, /[+/=]/);
    // The same three bytes in the standard alphabet would be `+//`; the url alphabet shifts them.
    assert.equal(encoded, '-_-_');
    // Two bytes encode to three characters: no padding is ever emitted.
    assert.equal(encodeBase64Url(new Uint8Array([0xfb, 0xff])), '-_8');
  });

  it('refuses anything that is not base64url', () => {
    for (const bad of ['a', 'ab+c', 'ab/c', 'ab c', 'a=b', 'ä', 'ab===']) {
      assert.equal(decodeBase64Url(bad), null, bad);
    }
  });
});

// ---------------------------------------------------------------------------
// 2. The Host's options -> what navigator.credentials needs
// ---------------------------------------------------------------------------

describe('registration options -> a WebAuthn create request', () => {
  it('decodes every binary member the contract sends as base64url', () => {
    const request = registrationRequestFrom(REGISTER_OPTIONS);
    assert.deepEqual(request.challenge, new Uint8Array(32).fill(7));
    assert.deepEqual(request.user.id, new TextEncoder().encode('device:d1'));
    assert.equal(request.rp.id, 'host.example.ts.net');
    assert.deepEqual(request.pubKeyCredParams, [{ type: 'public-key', alg: -7 }, { type: 'public-key', alg: -257 }]);
    assert.deepEqual(request.excludeCredentials, []);
    assert.equal(request.timeout, 60_000);
  });

  it('decodes excludeCredentials so an existing passkey cannot be silently duplicated', () => {
    const request = registrationRequestFrom({ ...REGISTER_OPTIONS, excludeCredentials: [{ type: 'public-key', id: CREDENTIAL_ID }] });
    assert.deepEqual(request.excludeCredentials, [{ type: 'public-key', id: decodeBase64Url(CREDENTIAL_ID) }]);
  });

  it('refuses a malformed answer instead of guessing (never creates a credential on garbage)', () => {
    const cases: Array<Record<string, unknown>> = [
      { ...REGISTER_OPTIONS, kind: 'passkey-assert-options' },
      { ...REGISTER_OPTIONS, challenge: '' },
      { ...REGISTER_OPTIONS, challenge: 'not base64url!' },
      { ...REGISTER_OPTIONS, rp: undefined },
      { ...REGISTER_OPTIONS, rp: { id: '' } },
      { ...REGISTER_OPTIONS, user: { id: REGISTER_OPTIONS.user.id } },
      { ...REGISTER_OPTIONS, pubKeyCredParams: [] },
      { ...REGISTER_OPTIONS, pubKeyCredParams: [{ type: 'public-key' }] },
      { ...REGISTER_OPTIONS, excludeCredentials: [{ type: 'totally-not-public-key', id: CREDENTIAL_ID }] },
    ];
    for (const answer of cases) {
      assert.throws(() => registrationRequestFrom(answer), (error: unknown) => {
        assert.equal((error as { code?: string }).code, 'client/bad-message', JSON.stringify(answer));
        return true;
      });
    }
  });

  it('clamps an absurd timeout instead of passing it to the authenticator', () => {
    assert.equal(registrationRequestFrom({ ...REGISTER_OPTIONS, timeout: 10_000_000 }).timeout, 600_000);
    assert.equal(registrationRequestFrom({ ...REGISTER_OPTIONS, timeout: 0 }).timeout, 60_000);
    assert.equal(registrationRequestFrom({ ...REGISTER_OPTIONS, timeout: 'soon' }).timeout, 60_000);
  });
});

describe('assert options -> a WebAuthn get request', () => {
  it('decodes the challenge, the rpId and allowCredentials', () => {
    const request = assertionRequestFrom(ASSERT_OPTIONS);
    assert.deepEqual(request.challenge, new Uint8Array(32).fill(7));
    assert.equal(request.rpId, 'host.example.ts.net');
    assert.deepEqual(request.allowCredentials, [{ type: 'public-key', id: decodeBase64Url(CREDENTIAL_ID) }]);
  });

  it('refuses an answer that is not the assert-options shape', () => {
    assert.throws(() => assertionRequestFrom({ ...ASSERT_OPTIONS, kind: 'passkey-register-options' }), /did not answer/);
    assert.throws(() => assertionRequestFrom({ ...ASSERT_OPTIONS, rpId: '' }), /rpId/);
    assert.throws(() => assertionRequestFrom({ ...ASSERT_OPTIONS, challenge: '%%%' }), /challenge/);
  });
});

// ---------------------------------------------------------------------------
// 3. The authenticator's answer -> the contracted frame
// ---------------------------------------------------------------------------

describe('credential -> contracted frames', () => {
  it('encodes the attestation exactly as §14.1 needs it', () => {
    const attestation = attestationFrom(fakeCredential('create'));
    assert.equal(attestation.id, CREDENTIAL_ID);
    assert.equal(attestation.rawId, CREDENTIAL_ID);
    assert.equal(encodeBase64Url(bytes(CREDENTIAL_ID)), CREDENTIAL_ID);
    // Round-trips back to the same clientData the authenticator produced.
    assert.deepEqual(decodeBase64Url(attestation.clientDataJSON), new Uint8Array(fakeCredential('create').response.clientDataJSON));
    assert.notEqual(attestation.attestationObject, '');
  });

  it('encodes the assertion, with `userHandle: null` when the authenticator omits it', () => {
    const assertion = assertionFrom(fakeCredential('get'));
    assert.equal(assertion.id, CREDENTIAL_ID);
    assert.equal(assertion.userHandle, null);
    assert.deepEqual(decodeBase64Url(assertion.signature), new Uint8Array([0x30, 0x44]));
    assert.deepEqual(decodeBase64Url(assertion.authenticatorData), new Uint8Array([0x01, 0x02, 0x03, 0x04]));
  });

  it('refuses a credential whose `id` and `rawId` disagree (the Host matches on rawId)', () => {
    const credential = fakeCredential('get');
    assert.throws(() => assertionFrom({ ...credential, id: encodeBase64Url(new Uint8Array(16).fill(9)) }), /rawId/);
  });

  it('refuses an incomplete or non-binary answer', () => {
    const create = fakeCredential('create');
    const get = fakeCredential('get');
    const attestations: unknown[] = [
      null,
      {},
      { ...create, rawId: undefined },
      { ...create, rawId: new Uint8Array([1]).buffer },
      { ...create, response: { ...create.response, attestationObject: 'string-is-not-a-buffer' } },
    ];
    const assertions: unknown[] = [
      { ...get, response: { ...get.response, signature: undefined } },
      { ...get, response: { ...get.response, clientDataJSON: new ArrayBuffer(0) } },
    ];
    for (const candidate of attestations) {
      // Any throw is fine here: what must never happen is a frame built from a bad shape.
      assert.throws(() => attestationFrom(candidate), JSON.stringify(candidate));
    }
    for (const candidate of assertions) {
      assert.throws(() => assertionFrom(candidate), JSON.stringify(candidate));
    }
  });
});

// ---------------------------------------------------------------------------
// 4. The reason vocabulary the gate's copy comes from
// ---------------------------------------------------------------------------

describe('lock reasons and gate copy', () => {
  it('maps every passkey refusal to its own reason (never one generic failure)', () => {
    assert.equal(lockReasonFor(new CoreError({ code: 'passkey/not-registered', message: '' })), 'not-registered');
    assert.equal(lockReasonFor(new CoreError({ code: 'passkey/already-registered', message: '' })), 'already-registered');
    assert.equal(lockReasonFor(new CoreError({ code: 'passkey/challenge-expired', message: '' })), 'challenge-expired');
    assert.equal(lockReasonFor(new CoreError({ code: 'passkey/verification-failed', message: '' })), 'verification-failed');
    assert.equal(lockReasonFor(new CoreError({ code: 'passkey/rate-limited', message: '' })), 'rate-limited');
  });

  it('reads the auth/locked reason the Host carries, and stays generic for anything else', () => {
    for (const reason of ['locked', 'unregistered', 'rate-limited'] as const) {
      const error = Object.assign(new CoreError({ code: 'auth/locked', message: 'fixed internal text' }), { reason });
      assert.equal(lockReasonFor(error), reason);
    }
    assert.equal(lockReasonFor(new CoreError({ code: 'client/timeout', message: '' })), 'locked');
    assert.equal(lockReasonFor(new Error('boom')), 'locked');
    assert.equal(lockReasonFor(null), 'locked');
  });

  it('offers the action the reason implies', () => {
    assert.equal(lockAction('unregistered'), 'register');
    assert.equal(lockAction('not-registered'), 'register');
    assert.equal(lockAction('already-registered'), 'approve');
    assert.equal(lockAction('locked'), 'unlock');
    assert.equal(lockAction('rate-limited'), 'unlock');
  });

  it('gives every reason a distinct copy key, and shows none for an unlocked device', () => {
    const keys = new Set(Object.values(LOCK_COPY));
    assert.equal(keys.size, Object.keys(LOCK_COPY).length, 'no two reasons share a sentence');
    assert.equal(unlockCopyKey({ state: 'unlocked', error: null }), null);
    assert.equal(unlockCopyKey({ state: 'unregistered', error: null }), 'unlock.passkeyRegister');
    assert.equal(unlockCopyKey({ state: 'locked', error: 'rate-limited' }), 'unlock.passkeyRateLimited');
  });
});

// ---------------------------------------------------------------------------
// 5. The platform half over the fake browser
// ---------------------------------------------------------------------------

describe('registerPasskey / assertPasskey over a fake WebAuthn', () => {
  let fake: FakeWebAuthn | null = null;

  beforeEach(() => {
    fake = null;
  });

  afterEach(() => {
    for (const restore of fake?.restores ?? []) restore();
  });

  it('registers: options -> create -> the contracted passkey-register frame', async () => {
    fake = installWebAuthn();
    const { client, sent } = fakeClient([
      REGISTER_OPTIONS,
      { kind: 'passkey-register', requestId: 'r-1', ok: true },
    ]);
    assert.deepEqual(await registerPasskey(client), { ok: true });

    assert.deepEqual(sent.map((frame) => frame.type), ['passkey-register-options', 'passkey-register']);
    // The options frame carries no parameters: the Host owns the challenge.
    assert.deepEqual(sent[0]?.params, {});
    const attestation = sent[1]?.params.attestation as Record<string, unknown>;
    assert.deepEqual(Object.keys(attestation).sort(), ['attestationObject', 'clientDataJSON', 'id', 'rawId']);
    assert.equal(attestation.rawId, CREDENTIAL_ID);

    // What the authenticator was actually asked for: resident-key preferred, UV required.
    const publicKey = (fake.createCalls[0] as { publicKey: Record<string, unknown> }).publicKey;
    assert.deepEqual(publicKey.challenge?.constructor?.name, 'Uint8Array');
    assert.deepEqual((publicKey.authenticatorSelection as Record<string, unknown>).userVerification, 'required');
    assert.deepEqual((publicKey.authenticatorSelection as Record<string, unknown>).residentKey, 'preferred');
    assert.equal((publicKey.rp as Record<string, unknown>).id, 'host.example.ts.net');
  });

  it('asserts: options -> get -> the contracted passkey-assert frame', async () => {
    fake = installWebAuthn();
    const { client, sent } = fakeClient([
      ASSERT_OPTIONS,
      { kind: 'passkey-assert', requestId: 'r-2', unlocked: true },
    ]);
    assert.deepEqual(await assertPasskey(client), { ok: true });
    assert.deepEqual(sent.map((frame) => frame.type), ['passkey-assert-options', 'passkey-assert']);
    const publicKey = (fake.getCalls[0] as { publicKey: Record<string, unknown> }).publicKey;
    assert.equal(publicKey.rpId, 'host.example.ts.net');
    assert.equal(publicKey.userVerification, 'required');
    const assertion = sent[1]?.params.assertion as Record<string, unknown>;
    assert.deepEqual(Object.keys(assertion).sort(), ['authenticatorData', 'clientDataJSON', 'id', 'rawId', 'signature', 'userHandle']);
  });

  it('a DISMISSED prompt is not an unlock: no frame is sent and the reason is the ordinary lock', async () => {
    const dismissed = Object.assign(new Error('user dismissed'), { name: 'NotAllowedError' });
    fake = installWebAuthn({ get: dismissed });
    const { client, sent } = fakeClient([ASSERT_OPTIONS]);
    await assert.rejects(assertPasskey(client), (error: unknown) => {
      assert.equal((error as { code?: string }).code, 'client/passkey-not-allowed');
      assert.equal(lockReasonFor(error), 'locked');
      return true;
    });
    assert.deepEqual(sent.map((frame) => frame.type), ['passkey-assert-options'], 'a dismissed prompt never asserts');
  });

  it('a null credential (no passkey made) is refused, never treated as success', async () => {
    fake = installWebAuthn({ create: null });
    const { client } = fakeClient([REGISTER_OPTIONS]);
    await assert.rejects(registerPasskey(client), /dismissed|could not use a passkey/);
  });

  it('surfaces the Host refusal of a replacement request with its own code (needs approval)', async () => {
    fake = installWebAuthn();
    const { client } = fakeClient([
      REGISTER_OPTIONS,
      new CoreError({ code: 'passkey/already-registered', message: 'the owner must approve this' }),
    ]);
    await assert.rejects(registerPasskey(client), (error: unknown) => {
      assert.equal((error as { code?: string }).code, 'passkey/already-registered');
      assert.equal(lockReasonFor(error), 'already-registered');
      return true;
    });
  });

  it('a refusal of the register ANSWER is never read as success', async () => {
    fake = installWebAuthn();
    const { client } = fakeClient([REGISTER_OPTIONS, { kind: 'passkey-register', ok: false }]);
    await assert.rejects(registerPasskey(client), /did not confirm the passkey/);
    const second = fakeClient([ASSERT_OPTIONS, { kind: 'passkey-assert', unlocked: false, ok: true }]);
    await assert.rejects(assertPasskey(second.client), /did not unlock/);
  });

  it('reports the passkey-approval push through watchPasskeyApproval', () => {
    const seen: unknown[] = [];
    let handler: ((payload: unknown) => void) | null = null;
    const client = { on: (_event: string, next: (payload: unknown) => void) => { handler = next; return () => { handler = null; }; } };
    const off = watchPasskeyApproval(client as never, (approval) => seen.push(approval));
    assert.deepEqual(handler, null === handler ? handler : handler);
    (handler as unknown as (payload: unknown) => void)({ approvalId: 'a1', action: 'approve', verificationCode: 'ABCD2345' });
    assert.deepEqual(seen, [{ approvalId: 'a1', action: 'approve', verificationCode: 'ABCD2345' }]);
    off();
    assert.equal(handler, null);
  });

  it('locks: sends passkey-lock, and a dropped socket is already a lock', async () => {
    const { client, sent } = fakeClient([{ kind: 'passkey-lock', locked: true }]);
    await lockPasskeySocket(client);
    assert.deepEqual(sent, [{ type: 'passkey-lock', params: {} }]);

    const dropped = fakeClient([new CoreError({ code: 'client/disconnected', message: 'gone', retryable: true })]);
    await assert.doesNotReject(lockPasskeySocket(dropped.client));

    const refused = fakeClient([new CoreError({ code: 'op/forbidden', message: 'old host' })]);
    await assert.rejects(lockPasskeySocket(refused.client), /old host/);
  });
});

describe('the web gate capability', () => {
  it('is unavailable (locked) without WebAuthn, so the gate never claims it can verify', async () => {
    const navigatorObject = globalThis.navigator as unknown as { credentials?: unknown };
    const previous = navigatorObject.credentials;
    navigatorObject.credentials = undefined;
    try {
      assert.equal(await unlockCapability(), 'unavailable');
    } finally {
      navigatorObject.credentials = previous;
    }
  });

  it('is `passcode` when the browser can use a passkey', async () => {
    const fake = installWebAuthn();
    try {
      assert.equal(await unlockCapability(), 'passcode');
    } finally {
      for (const restore of fake.restores) restore();
    }
  });
});
