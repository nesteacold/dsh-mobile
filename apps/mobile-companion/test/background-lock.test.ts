// The measured 2026-11-16 pairing drop: on the web target, switching to the Devices page to
// approve a pairing backgrounds the PWA. AppState 'background' used to call controller.lock(),
// which closes the one-time pairing socket and makes the Host drop the pending request. While a
// pairing is waiting there is no credential to protect, so the SOCKET action is deferred — but
// the visual gate and unlock-attempt invalidation still apply (see web-pairing-background.test.ts).

import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import { mayLockOnBackground, mayMirrorUnlocked } from '../src/ui/background-lock';

const pending = { verificationCode: '123456', expiresAt: Date.now() + 60_000 };

describe('mayLockOnBackground (spec 045: PWA never locks)', () => {
  it('never locks a web page, pairing or not', () => {
    assert.equal(mayLockOnBackground({ platform: 'web', pairingPending: pending }), false);
    assert.equal(mayLockOnBackground({ platform: 'web', pairingPending: null }), false);
  });

  it('never defers the lock on native, even while pairing', () => {
    for (const platform of ['ios', 'android']) {
      assert.equal(mayLockOnBackground({ platform, pairingPending: pending }), true, platform);
    }
  });
});

describe('mayMirrorUnlocked (hidden page must not reopen its gate)', () => {
  const base = { isWeb: true, unlocked: true, gateUnlocked: false };
  it('a hidden page stays locked even though a pre-pair session left unlocked=true', () => {
    assert.equal(mayMirrorUnlocked({ ...base, foreground: false }), false);
  });
  it('the gate reopens only on the foreground page', () => {
    assert.equal(mayMirrorUnlocked({ ...base, foreground: true }), true);
  });
  it('no-ops when already unlocked or not web', () => {
    assert.equal(mayMirrorUnlocked({ ...base, foreground: true, gateUnlocked: true }), false);
    assert.equal(mayMirrorUnlocked({ ...base, foreground: true, isWeb: false }), false);
    assert.equal(mayMirrorUnlocked({ ...base, foreground: true, unlocked: false }), false);
  });
});
