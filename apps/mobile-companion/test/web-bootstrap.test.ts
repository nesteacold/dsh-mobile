// Spec 021 — the FIRST-RUN web bootstrap (pairing → passkey → unlocked), with no prior unlock.
//
// This is the sequence the root layout drives on a browser, and the one that deadlocked: the web
// gate asked `authenticate()` for a passkey before any paired socket existed (so it could only
// answer `locked`), and the passkey screen was drawn only in the already-unlocked branch (so it was
// never reached). These cases assert the controller half of the fix, in order, without an unlock:
//
//   pair → register → assert → unlocked        (a fresh install gets in)
//   the owner's approval `reject`               (stays locked, never reported as success)
//
// The browser steps are INJECTED (`ControllerOptions.passkey`), exactly like `transport`: Node has no
// WebAuthn, and the real ceremony is covered in `test/web-unlock*.test.ts` against a fake browser.

import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import { AppController } from '../src/app-state';
import { CoreError, encodePairingPayload, type PairingPayload } from '../src/core';
import { NodePinnedTransport } from './support/node-pinned-transport';
import { FakeGateway } from './support/fake-gateway';
import { waitFor } from './support/wait';
import { resetSecureStore } from './support/stubs/expo-secure-store.stub';

const NOW = Date.now();
const nodeTransport = () => new NodePinnedTransport({ handshakeTimeoutMs: 4_000 });

function pairingPayload(gateway: FakeGateway, code: string): string {
  const payload: PairingPayload = {
    version: 3,
    publicUrl: gateway.endpoint,
    pairingCode: code,
    expiresAt: NOW + 240_000,
    certSha256: gateway.certSha256,
    gatewayId: '0f8fad5b-d9cb-469f-a165-70867728950e',
    gatewayName: 'my-pc',
    endpoints: [gateway.endpoint],
  };
  return encodePairingPayload(payload);
}

function pairCode(letter: string): string {
  const canonical = ['A', 'E', 'I', 'M', 'Q', 'U', 'Y', 'c', 'g', 'k', 'o', 's', 'w', '0', '4', '8'];
  const index = Math.abs(letter.charCodeAt(0) - 'A'.charCodeAt(0)) % canonical.length;
  return 'A'.repeat(42) + (canonical[index] as string);
}

/** The injected browser steps: record each call, and refuse with `codes[step]` when one is set. */
function fakePasskey(codes: { register?: string; assert?: string } = {}) {
  const calls: string[] = [];
  const steps = {
    register: async () => {
      calls.push('register');
      if (codes.register !== undefined) throw new CoreError({ code: codes.register, message: codes.register });
      return { ok: true as const };
    },
    assert: async () => {
      calls.push('assert');
      if (codes.assert !== undefined) throw new CoreError({ code: codes.assert, message: codes.assert });
      return { ok: true as const };
    },
    lock: async () => undefined,
  };
  return { calls, steps };
}

describe('web first-run bootstrap (spec 021)', () => {
  it('pairs, registers and asserts WITHOUT a prior unlock, and only then reports unlocked', async () => {
    resetSecureStore();
    const code = pairCode('B');
    const gateway = await FakeGateway.create({
      pairingCodes: [code],
      deviceScopes: ['sessions:read', 'web:unlock'],
      webLock: 'unregistered',
    });
    const passkey = fakePasskey();
    const controller = new AppController({
      locale: () => 'en',
      transport: nodeTransport,
      pairAckTimeoutMs: 600,
      passkey: passkey.steps,
    });
    try {
      await controller.start();
      // The bootstrap's order: pair first. Nothing here opens the platform gate (that deadlocked).
      const paired = await controller.pair(pairingPayload(gateway, code));
      assert.equal(paired.ok, true, JSON.stringify(paired));
      assert.equal(controller.snapshot().unlocked, false, 'pairing alone never unlocks');
      assert.notEqual(controller.snapshot().activeHost, null, 'the host is known, so the lock screen can act');

      // The pairing socket is PROMOTED to the live one, so a passkey step has a socket to use.
      await waitFor(() => controller.snapshot().connection === 'ready', { label: 'promoted socket ready' });
      assert.equal(controller.passkeyConnection !== null, true, 'a passkey may be asserted on the paired socket');

      // One action: create the passkey, then assert it (a registration unlocks nothing).
      await controller.registerAndUnlockWebPasskey();
      assert.deepEqual(passkey.calls, ['register', 'assert'], 'register is followed by an assert');

      // `unlocked` is true only because the Host answered `passkey-assert`.
      assert.equal(controller.snapshot().unlocked, true);
      assert.equal(controller.snapshot().webLock?.state, 'unlocked');
      assert.equal(controller.snapshot().webLock?.error, null);
      // The verified socket is resynced in place (no second connection, no second prompt).
      await waitFor(() => gateway.requestCount('sessions') > 0, { label: 'resync after the assertion' });
    } finally {
      controller.stop();
      await gateway.close();
    }
  });

  it('a reloaded page asserts on a socket it opens itself, still with no prior unlock', async () => {
    resetSecureStore();
    const code = pairCode('K');
    const gateway = await FakeGateway.create({
      pairingCodes: [code],
      deviceScopes: ['sessions:read', 'web:unlock'],
      webLock: 'unregistered',
    });
    const passkey = fakePasskey();
    const controller = new AppController({
      locale: () => 'en',
      transport: nodeTransport,
      pairAckTimeoutMs: 600,
      passkey: passkey.steps,
    });
    try {
      await controller.start();
      await controller.pair(pairingPayload(gateway, code));
      await waitFor(() => controller.snapshot().connection === 'ready', { label: 'promoted socket ready' });
      await controller.registerAndUnlockWebPasskey();
      assert.equal(controller.snapshot().unlocked, true);

      // What a page reload does: the socket is gone and the gate is shut again.
      controller.lock();
      assert.equal(controller.snapshot().unlocked, false);
      assert.equal(controller.snapshot().connection, 'idle');
      passkey.calls.length = 0;

      // The assertion opens the locked socket it needs first, then unlocks on the Host's answer.
      await controller.unlockWithPasskey();
      assert.deepEqual(passkey.calls, ['assert']);
      assert.equal(controller.snapshot().unlocked, true);
    } finally {
      controller.stop();
      await gateway.close();
    }
  });

  it('a refused passkey never unlocks: the gate stays locked and names the reason', async () => {
    resetSecureStore();
    const code = pairCode('Z');
    const gateway = await FakeGateway.create({
      pairingCodes: [code],
      deviceScopes: ['sessions:read', 'web:unlock'],
      webLock: 'unregistered',
    });
    // The Host already stored a passkey for this device, so registering is refused and the owner has
    // to approve the replacement (§14.3): the whole one-step pairing bootstrap stops there.
    const passkey = fakePasskey({ register: 'passkey/already-registered' });
    const controller = new AppController({
      locale: () => 'en',
      transport: nodeTransport,
      pairAckTimeoutMs: 600,
      passkey: passkey.steps,
    });
    try {
      await controller.start();
      await controller.pair(pairingPayload(gateway, code));
      await waitFor(() => controller.snapshot().connection === 'ready', { label: 'promoted socket ready' });

      await controller.registerAndUnlockWebPasskey();
      // Refused at the registration: the assert must NOT have run, and nothing opened the gate.
      assert.deepEqual(passkey.calls, ['register']);
      assert.equal(controller.snapshot().unlocked, false, 'a refused passkey never unlocks');
      assert.equal(controller.snapshot().webLock?.error, 'already-registered');
      assert.notEqual(controller.snapshot().webLock?.state, 'unlocked');

      // A refused ASSERTION (the owner rejected the replacement, or the credential did not verify)
      // is not a success either, and it names its own reason.
      passkey.calls.length = 0;
      (passkey.steps as { assert: () => Promise<{ ok: true }> }).assert = async () => {
        passkey.calls.push('assert');
        throw new CoreError({ code: 'passkey/verification-failed', message: 'refused' });
      };
      await controller.unlockWithPasskey();
      assert.deepEqual(passkey.calls, ['assert']);
      assert.equal(controller.snapshot().unlocked, false);
      assert.equal(controller.snapshot().webLock?.error, 'verification-failed');
    } finally {
      controller.stop();
      await gateway.close();
    }
  });
});
