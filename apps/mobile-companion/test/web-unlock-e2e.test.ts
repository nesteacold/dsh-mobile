// END-TO-END web passkey unlock: from "the Host said locked" to "the sentence the user reads".
//
// Each case goes through the REAL chain — `src/core/web-lock.ts` (the policy) → the i18n table →
// `t('vi'|'en', key)` — because a right reason mapped to a wrong key passes a reason-only test and
// still shows the wrong sentence. That defect class has hit this app before (authoring, history
// cursor, account lock), so the copy is asserted as literal text in both locales.
//
// The Host is faked only where the wire would be: `hello.webLock`, the passkey frames and their
// refusals. The policy, the copy and the frame encoding are the real ones.

import assert from 'node:assert/strict';
import { afterEach, describe, it } from 'node:test';

import { PASSKEY_CLIENT_TYPES } from '@dsh-ext/mobile-protocol';

import { t } from '../i18n';
import { CoreError } from '../src/core/errors';
import { lockAction, lockReasonFor, unlockCopyKey, type LockReason } from '../src/core/web-lock';
import { authenticate, unlockCapability } from '../src/platform/passkey.web';

/** The sentences the user reads, verbatim (spec 021 requirement 1–3). */
const EN: Record<string, string> = {
  'unlock.passkeyLocked': 'This device is locked. Use its passkey to continue.',
  'unlock.passkeyRegister': 'Create a passkey for this browser to unlock this device.',
  'unlock.passkeyRateLimited': 'Too many passkey attempts. Wait a few minutes, then try again.',
  'unlock.passkeyExpired': 'The passkey request expired. Try again.',
  'unlock.passkeyFailed': 'That passkey did not verify. Try again.',
  'unlock.passkeyNotRegistered': 'This device has no passkey yet. Create one to continue.',
  'unlock.passkeyApproval': 'A passkey already exists. Ask the owner to approve replacing it on the computer, then create it again.',
  'unlock.passkeyUnsupported': 'This browser cannot use a passkey. Open the page in a recent browser over https.',
  'unlock.passkeyHostVersion': 'Your computer does not support passkey unlock yet. Update it, then try again.',
};

const VI: Record<string, string> = {
  'unlock.passkeyLocked': 'Thiết bị này đang khoá. Dùng passkey của nó để tiếp tục.',
  'unlock.passkeyRegister': 'Tạo passkey cho trình duyệt này để mở khoá thiết bị.',
  'unlock.passkeyRateLimited': 'Đã thử passkey quá nhiều lần. Chờ vài phút rồi thử lại.',
  'unlock.passkeyExpired': 'Yêu cầu passkey đã hết hạn. Vui lòng thử lại.',
  'unlock.passkeyFailed': 'Passkey đó không xác minh được. Vui lòng thử lại.',
  'unlock.passkeyNotRegistered': 'Thiết bị này chưa có passkey. Hãy tạo một cái để tiếp tục.',
  'unlock.passkeyApproval': 'Đã có passkey. Hãy nhờ chủ máy duyệt thay thế trên máy tính rồi tạo lại.',
  'unlock.passkeyUnsupported': 'Trình duyệt này không dùng được passkey. Mở trang bằng trình duyệt mới qua https.',
  'unlock.passkeyHostVersion': 'Máy tính chưa hỗ trợ mở khoá bằng passkey. Hãy cập nhật rồi thử lại.',
};

/** Install a fake browser + a fake ready client that answers `answers` in order. */
function withBrowser(answers: Array<Record<string, unknown> | Error>) {
  const navigatorObject = globalThis.navigator as unknown as { credentials?: unknown };
  const previousCredentials = navigatorObject.credentials;
  const previousWindow = (globalThis as { window?: unknown }).window;
  navigatorObject.credentials = {
    create: async () => fakeCredential('create'),
    get: async () => fakeCredential('get'),
  };
  (globalThis as { window?: unknown }).window = { isSecureContext: true };
  const client = {
    state: 'ready',
    passkeyRequest: async () => {
      const next = answers.shift();
      if (next === undefined) throw new CoreError({ code: 'client/timeout', message: 'no answer scripted' });
      if (next instanceof Error) throw next;
      return next;
    },
  } as never;
  return {
    client,
    restore: () => {
      navigatorObject.credentials = previousCredentials;
      (globalThis as { window?: unknown }).window = previousWindow;
    },
  };
}

const OPTIONS = {
  kind: 'passkey-assert-options',
  requestId: 'r-1',
  challenge: 'BwcHBwcHBwcHBwcHBwcHBwcHBwcHBwcHBwcHBwcHBwc',
  rpId: 'host.example.ts.net',
  allowCredentials: [],
  timeout: 60_000,
};

function fakeCredential(kind: 'create' | 'get') {
  const rawId = new Uint8Array(16).fill(3).buffer;
  const id = 'AwMDAwMDAwMDAwMDAwMDAw';
  const response = kind === 'create'
    ? { clientDataJSON: new Uint8Array([1]).buffer, attestationObject: new Uint8Array([2]).buffer }
    : {
        clientDataJSON: new Uint8Array([1]).buffer,
        authenticatorData: new Uint8Array([2]).buffer,
        signature: new Uint8Array([3]).buffer,
        userHandle: null,
      };
  return { id, rawId, type: 'public-key', response };
}

describe('web passkey unlock end to end: reason -> gate copy -> the sentence on screen', () => {
  afterEach(() => {
    // Every case restores its own browser through the returned `restore`; nothing global to undo.
  });

  it('every reason the gate can hold has copy in BOTH locales (nothing falls back to a raw key)', () => {
    const reasons: LockReason[] = [
      'locked',
      'unregistered',
      'rate-limited',
      'challenge-expired',
      'verification-failed',
      'not-registered',
      'already-registered',
      'not-supported',
      'host-version',
    ];
    for (const reason of reasons) {
      // `state` is the Host's own three-value vocabulary; a refusal is reported through `error`.
      const state = reason === 'unregistered' || reason === 'locked' ? reason : 'locked';
      const key = unlockCopyKey({ state, error: reason });
      assert.notEqual(key, null, reason);
      assert.equal(t('en', key as never), EN[key as string], `en ${key}`);
      assert.equal(t('vi', key as never), VI[key as string], `vi ${key}`);
      // The two locales must differ: an untranslated copy is the defect this asserts against.
      assert.notEqual(EN[key as string], VI[key as string], `vi ${key} is translated`);
      // And it must not leak the Host's own wording or a raw contract code.
      assert.doesNotMatch(t('en', key as never), /auth\/locked|passkey\/|DeepSeek/);
    }
  });

  it('a locked device with no passkey asks to CREATE one; one with a passkey asks to unlock', () => {
    assert.equal(lockAction('unregistered'), 'register');
    assert.equal(lockAction('locked'), 'unlock');
    assert.equal(lockAction('already-registered'), 'approve');
    assert.equal(t('en', 'unlock.passkeyRegister'), EN['unlock.passkeyRegister']);
  });

  it('no copy of the passkey flow mentions DeepSeek or a signed-in computer', () => {
    for (const [key, value] of Object.entries(EN)) {
      assert.doesNotMatch(value, /DeepSeek|signed in/, key);
      assert.equal(t('en', key as never), value, key);
    }
    for (const [key, value] of Object.entries(VI)) {
      assert.doesNotMatch(value, /DeepSeek|đăng nhập/, key);
      assert.equal(t('vi', key as never), value, key);
    }
  });

  it('the passkey frames are exactly the four the contract lists', () => {
    assert.deepEqual([...PASSKEY_CLIENT_TYPES], [
      'passkey-register-options',
      'passkey-register',
      'passkey-assert-options',
      'passkey-assert',
    ]);
  });

  it('a successful assertion opens the gate (the happy path the fakes must not hide)', async () => {
    const browser = withBrowser([OPTIONS, { kind: 'passkey-assert', unlocked: true }]);
    try {
      assert.equal(await unlockCapability(), 'passcode');
      assert.deepEqual(await authenticate('Unlock', browser.client), { ok: true, capability: 'passcode' });
    } finally {
      browser.restore();
    }
  });

  it('a Host refusal maps to its OWN sentence, not the generic failure', async () => {
    const cases: Array<[string, keyof typeof EN]> = [
      ['passkey/not-registered', 'unlock.passkeyNotRegistered'],
      ['passkey/verification-failed', 'unlock.passkeyFailed'],
      ['passkey/challenge-expired', 'unlock.passkeyExpired'],
      ['passkey/rate-limited', 'unlock.passkeyRateLimited'],
    ];
    for (const [code, key] of cases) {
      const browser = withBrowser([new CoreError({ code: code as never, message: code })]);
      try {
        const result = await authenticate('Unlock', browser.client);
        assert.equal(result.ok, false, code);
        const shown = unlockCopyKey({ state: 'locked', error: result.reason as LockReason });
        assert.equal(shown, key, code);
        assert.equal(t('en', shown as never), EN[key], code);
      } finally {
        browser.restore();
      }
    }
  });

  it('a device with no socket shows the lock sentence and reads no credential', async () => {
    const browser = withBrowser([]);
    try {
      const result = await authenticate('Unlock', null);
      assert.equal(result.ok, false);
      assert.equal(result.reason, 'locked');
      assert.equal(t('en', unlockCopyKey({ state: 'locked', error: 'locked' }) as never), EN['unlock.passkeyLocked']);
    } finally {
      browser.restore();
    }
  });

  it('a browser without WebAuthn reports `unavailable` and says so (never a looping prompt)', async () => {
    const navigatorObject = globalThis.navigator as unknown as { credentials?: unknown };
    const previous = navigatorObject.credentials;
    navigatorObject.credentials = undefined;
    try {
      assert.equal(await unlockCapability(), 'unavailable');
      const result = await authenticate('Unlock', null);
      assert.equal(result.ok, false);
      assert.equal(result.capability, 'unavailable');
      assert.equal(lockReasonFor(new CoreError({ code: 'client/passkey-not-allowed', message: '' })), 'locked');
      assert.equal(t('en', 'unlock.passkeyUnsupported'), EN['unlock.passkeyUnsupported']);
    } finally {
      navigatorObject.credentials = previous;
    }
  });

  it('the old DeepSeek-account path is gone from the copy table', () => {
    // Spec 021 requirement 7: `readAccountAttestation`, account pinning and the signed-out
    // `unlock-unavailable` decision were REMOVED. Their sentences must not survive as dead copy.
    for (const key of ['unlock.signedOut', 'unlock.accountChanged', 'unlock.needsAttestation', 'unlock.unlockUnavailable', 'unlock.unavailableWeb']) {
      assert.equal(t('en', key as never), undefined, `${key} is no longer a message key`);
      assert.equal(t('vi', key as never), undefined, `${key} is no longer a message key`);
    }
  });
});
