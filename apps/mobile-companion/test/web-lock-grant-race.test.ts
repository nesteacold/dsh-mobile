// Spec 036 — the stored web:unlock grant is a PRE-SOCKET HINT, never an override of a live hello.
//
// Regression: on reload the store read can resolve after the socket already reported
// `hello.webLock: 'unlocked'` (grant applied by the Host). The old code then set `webLocked = true`
// and the PWA showed the passkey gate over an unlocked session. This suite controls the store read
// with a deferred promise so the order is deterministic, without a real Host or real WebAuthn.

import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import { AppController } from '../src/app-state';
import { encodePairingPayload, type PairingPayload } from '../src/core';
import { NodePinnedTransport } from './support/node-pinned-transport';
import { FakeGateway } from './support/fake-gateway';
import { waitFor } from './support/wait';
import { resetSecureStore } from './support/stubs/expo-secure-store.stub';

const NOW = Date.now();
const nodeTransport = () => new NodePinnedTransport({ handshakeTimeoutMs: 4_000 });

/** A store read the test releases explicitly, so the hello-vs-store order is deterministic. */
function delayedGrant() {
  let release: () => void = () => {};
  const promise = new Promise<boolean>((resolve) => { release = () => resolve(true); });
  return { read: () => promise, release: () => release() };
}

function pairingPayload(gateway: InstanceType<typeof FakeGateway>, code: string): string {
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

const passkey = () => {
  const calls: string[] = [];
  return {
    calls,
    steps: {
      register: async () => { calls.push('register'); return { ok: true as const }; },
      assert: async () => { calls.push('assert'); return { ok: true as const }; },
      lock: async () => { calls.push('lock'); return undefined; },
    },
  };
};

describe('spec 036: stored grant vs live hello', () => {
  it('a late grant read cannot re-lock a gate the live hello already unlocked', async () => {
    resetSecureStore();
    const grant = delayedGrant();
    const code = pairCode('G');
    const gateway = await FakeGateway.create({
      pairingCodes: [code],
      deviceScopes: ['sessions:read', 'web:unlock'],
      webLock: 'unlocked',
    });
    const steps = passkey();
    const controller = new AppController({
      locale: () => 'en',
      transport: nodeTransport,
      pairAckTimeoutMs: 600,
      passkey: steps.steps,
      readWebUnlockGrant: grant.read,
    });
    try {
      // start() fires the (deferred) store read and does NOT await it.
      await controller.start();
      await controller.pair(pairingPayload(gateway, code));
      await controller.unlock();
      await waitFor(() => controller.snapshot().connection === 'ready', { label: 'web socket ready' });
      assert.equal(controller.snapshot().webLock?.state, 'unlocked');

      // The store answers only NOW: it must not touch the authoritative live state.
      grant.release();
      await waitFor(() => gateway.requestCount('sessions') > 0, { label: 'data path still open' });
      await new Promise((resolve) => setImmediate(resolve));
      assert.equal(controller.snapshot().webLock?.state, 'unlocked', 'late grant read did not re-lock');
      assert.deepEqual(steps.calls, [], 'no passkey prompt after the late read');
    } finally {
      controller.stop();
      await gateway.close();
    }
  });

  it('with no live hello the stored grant still puts a web install behind the gate', async () => {
    resetSecureStore();
    const grant = delayedGrant();
    const code = pairCode('H');
    const gateway = await FakeGateway.create({
      pairingCodes: [code],
      deviceScopes: ['sessions:read', 'web:unlock'],
      webLock: 'locked',
    });
    const controller = new AppController({
      locale: () => 'en',
      transport: nodeTransport,
      pairAckTimeoutMs: 600,
      passkey: passkey().steps,
      readWebUnlockGrant: grant.read,
    });
    try {
      await controller.start();
      // The grant read resolves before any hello: the hint must still put the gate up.
      grant.release();
      await new Promise((resolve) => setImmediate(resolve));
      await controller.pair(pairingPayload(gateway, code));
      await controller.unlock();
      await waitFor(() => controller.snapshot().connection === 'ready', { label: 'web socket ready' });
      assert.equal(controller.snapshot().webLock?.state, 'locked');
      assert.equal(gateway.requestCount('sessions'), 0, 'a locked socket still reads no data');
    } finally {
      controller.stop();
      await gateway.close();
    }
  });
});
