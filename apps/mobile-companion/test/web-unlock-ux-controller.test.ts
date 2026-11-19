// Spec 037 — the CONTROLLER half: immediate pending state, duplicate-tap guard, prefetch trigger and
// invalidation on lock. Behavioural: real controller + FakeGateway + injected browser steps.

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

/** Injected steps with an assert the test can hold open, plus prefetch/invalidate spies. */
function steppedPasskey(holdAssert = false) {
  const calls = { assert: 0, prepare: 0, invalidate: 0, prompts: 0 };
  let release!: () => void;
  const gate = new Promise<void>((res) => { release = res; });
  const steps = {
    register: async () => ({ ok: true as const }),
    assert: async (_client?: unknown, hooks?: { onPrompt?: () => void }) => {
      calls.assert += 1;
      hooks?.onPrompt?.();
      calls.prompts += 1;
      if (holdAssert) await gate;
      return { ok: true as const };
    },
    lock: async () => undefined,
    prepare: () => { calls.prepare += 1; },
    invalidate: () => { calls.invalidate += 1; },
  };
  return { calls, steps, release: () => release() };
}

describe('spec 037: controller unlock UX', () => {
  it('a tap shows pending immediately, a duplicate tap is ignored, and pending clears in finally', async () => {
    resetSecureStore();
    const code = pairCode('X');
    const gateway = await FakeGateway.create({
      pairingCodes: [code],
      deviceScopes: ['sessions:read', 'web:unlock'],
      webLock: 'locked',
    });
    const passkey = steppedPasskey(true);
    const controller = new AppController({
      locale: () => 'en',
      transport: nodeTransport,
      pairAckTimeoutMs: 600,
      passkey: passkey.steps,
    });
    try {
      await controller.start();
      await controller.pair(pairingPayload(gateway, code));
      await controller.unlock();
      await waitFor(() => controller.snapshot().connection === 'ready', { label: 'socket ready' });

      const first = controller.unlockWithPasskey();
      assert.equal(controller.snapshot().webLock?.pending, true, 'pending is visible on the SAME tick as the tap');
      assert.equal(controller.snapshot().webLock?.phase, 'preparing');
      await controller.unlockWithPasskey(); // duplicate tap while pending
      await waitFor(() => passkey.calls.assert === 1, { label: 'the assertion started' });
      assert.equal(controller.snapshot().webLock?.phase, 'prompting', 'the native-sheet phase was reported');
      assert.equal(passkey.calls.assert, 1, 'duplicate tap did not open a second sheet');

      passkey.release();
      await first;
      assert.equal(controller.snapshot().webLock?.pending, false, 'pending cleared in finally');
      assert.equal(controller.snapshot().webLock?.phase, 'idle');
      assert.equal(controller.snapshot().unlocked, true, 'only the Host-confirmed assertion opened the gate');
    } finally {
      controller.stop();
      await gateway.close();
    }
  });

  it('a ready locked socket triggers prefetch, and lock tears down the prepared request', async () => {
    resetSecureStore();
    const code = pairCode('Y');
    const gateway = await FakeGateway.create({
      pairingCodes: [code],
      deviceScopes: ['sessions:read', 'web:unlock'],
      webLock: 'locked',
    });
    const passkey = steppedPasskey();
    const controller = new AppController({
      locale: () => 'en',
      transport: nodeTransport,
      pairAckTimeoutMs: 600,
      passkey: passkey.steps,
    });
    try {
      await controller.start();
      await controller.pair(pairingPayload(gateway, code));
      await controller.unlock();
      await waitFor(() => controller.snapshot().connection === 'ready', { label: 'socket ready' });
      assert.ok(passkey.calls.prepare >= 1, 'options were prefetched on the ready locked socket');

      const beforeLock = passkey.calls.invalidate;
      await controller.lockWebDevice();
      assert.ok(passkey.calls.invalidate > beforeLock, 'lock invalidated the prepared request / ceremony');
      assert.equal(controller.snapshot().webLock?.pending, false);

      // With the upgrade refused there is no ready socket: the step must report `locked`, never a
      // silent no-op (the gate then shows its unreachable sentence + forget/pair way out).
      gateway.refuseUpgrade(401);
      await controller.unlockWithPasskey();
      await waitFor(() => controller.snapshot().webLock?.error === 'locked', { label: 'a null socket has a reason' });
      assert.equal(controller.snapshot().webLock?.pending, false, 'pending cleared even with no socket');
    } finally {
      controller.stop();
      await gateway.close();
    }
  });

  it('an injected app-side timeout on a REAL locked socket shows a reason and clears pending', async () => {
    // Review 037 fix #4: exercise the step against a real host + ready socket — a controller with no
    // host never reaches `assert`, so it cannot prove the timeout path is wired to the gate.
    resetSecureStore();
    const code = pairCode('T');
    const gateway = await FakeGateway.create({
      pairingCodes: [code],
      deviceScopes: ['sessions:read', 'web:unlock'],
      webLock: 'locked',
    });
    const steps = {
      register: async () => ({ ok: true as const }),
      assert: async () => { throw new CoreError({ code: 'client/passkey-timeout', message: 'app deadline' }); },
      lock: async () => undefined,
    };
    const controller = new AppController({
      locale: () => 'en',
      transport: nodeTransport,
      pairAckTimeoutMs: 600,
      passkey: steps,
    });
    try {
      await controller.start();
      await controller.pair(pairingPayload(gateway, code));
      await controller.unlock();
      await waitFor(() => controller.snapshot().connection === 'ready', { label: 'socket ready' });

      await controller.unlockWithPasskey();
      await waitFor(() => controller.snapshot().webLock?.error === 'passkey-timeout', { label: 'the deadline reason is visible' });
      assert.equal(controller.snapshot().webLock?.pending, false, 'pending cleared after the timeout');
      assert.equal(controller.snapshot().webLock?.phase, 'idle');
      assert.equal(controller.snapshot().webLock?.state, 'locked', 'a timed-out ceremony never opens the WEB gate');

      // Retry is possible after the deadline; the gate is not stuck.
      await controller.unlockWithPasskey();
      assert.equal(controller.snapshot().webLock?.pending, false);
    } finally {
      controller.stop();
      await gateway.close();
    }
  });
});
