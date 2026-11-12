// Spec 021 (contract revision 14) — the controller's web passkey lock.
//
// What is asserted here is the WIRING, because the security decision is the Host's (it verifies the
// challenge, origin, signature and sign counter) and the browser half is covered against a fake
// WebAuthn in `test/web-unlock*.test.ts`:
//
//   * a `hello.webLock` of `locked` keeps the session list unrequested (a locked socket may only use
//     hello/ping and the passkey frames — a resync would be refused `auth/locked`);
//   * `unregistered` asks for a passkey, `already-registered` waits for the owner;
//   * "Lock now" sends `passkey-lock` and closes the socket;
//   * a native device (no `webLock`) is completely unaffected.
//
// The browser steps are INJECTED (`ControllerOptions.passkey`), exactly like `transport`: Node has no
// WebAuthn at all, so a real module call here would be testing the absence of a browser.

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

/** The injected browser steps: record the call and refuse with `codes[step]` when one is set. */
function fakePasskey(codes: { register?: string; assert?: string; lock?: string } = {}) {
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
    lock: async () => {
      calls.push('lock');
      if (codes.lock !== undefined) throw new CoreError({ code: codes.lock, message: codes.lock });
      return undefined;
    },
  };
  return { calls, steps };
}

describe('web passkey lock (spec 021)', () => {
  it('a locked web socket requests NO session list, and the snapshot carries the lock', async () => {
    resetSecureStore();
    const code = pairCode('L');
    const gateway = await FakeGateway.create({
      pairingCodes: [code],
      deviceScopes: ['sessions:read', 'web:unlock'],
      webLock: 'locked',
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
      // The one-time pairing socket is `web:unlock` too, so it starts locked; the pairing still
      // succeeds on the accepted client-hello and THAT socket is kept for the passkey frames.
      const paired = await controller.pair(pairingPayload(gateway, code));
      assert.equal(paired.ok, true, JSON.stringify(paired));
      // A020: the credential is read only after the platform gate opens. The Host's passkey lock is a
      // SECOND layer on that socket — opening the gate does not unlock it.
      await controller.unlock();
      await waitFor(() => controller.snapshot().connection === 'ready', { label: 'web socket ready' });

      const lock = controller.snapshot().webLock;
      assert.notEqual(lock, null, 'a web:unlock device reports a lock');
      assert.notEqual(lock?.state, 'unlocked');
      // A locked socket may only use hello/ping and the passkey frames: nothing may be resynced.
      assert.equal(gateway.requestCount('sessions'), 0, 'no session list was requested while locked');
      assert.deepEqual(controller.snapshot().sessions, []);
    } finally {
      controller.stop();
      await gateway.close();
    }
  });

  it('register, then assert clears the lock; "Lock now" calls the lock step and closes the socket', async () => {
    resetSecureStore();
    const code = pairCode('N');
    const gateway = await FakeGateway.create({
      pairingCodes: [code],
      deviceScopes: ['sessions:read', 'web:unlock'],
      webLock: 'locked',
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
      await controller.unlock();
      await waitFor(() => controller.snapshot().connection === 'ready', { label: 'web socket ready' });

      await controller.registerWebPasskey();
      assert.deepEqual(passkey.calls, ['register']);
      assert.equal(controller.snapshot().webLock?.error, null);

      // The assertion is the only thing that unlocks (the Host decides; the fake says "accepted").
      await controller.unlockWithPasskey();
      assert.deepEqual(passkey.calls, ['register', 'assert']);
      assert.equal(controller.snapshot().webLock?.state, 'unlocked');

      await controller.lockWebDevice();
      assert.deepEqual(passkey.calls, ['register', 'assert', 'lock']);
      await waitFor(() => controller.snapshot().connection !== 'ready', { label: 'locked socket closed' });
      assert.notEqual(controller.snapshot().webLock?.state, 'unlocked', 'the gate is locked again');
    } finally {
      controller.stop();
      await gateway.close();
    }
  });

  it('a refused assertion keeps the gate locked and names the reason (never a success)', async () => {
    resetSecureStore();
    const code = pairCode('R');
    const gateway = await FakeGateway.create({
      pairingCodes: [code],
      deviceScopes: ['sessions:read', 'web:unlock'],
      webLock: 'locked',
    });
    const passkey = fakePasskey({ assert: 'passkey/verification-failed', register: 'passkey/already-registered' });
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
      await waitFor(() => controller.snapshot().connection === 'ready', { label: 'web socket ready' });

      await controller.unlockWithPasskey();
      assert.equal(controller.snapshot().webLock?.state, 'locked');
      assert.equal(controller.snapshot().webLock?.error, 'verification-failed');

      await controller.registerWebPasskey();
      assert.equal(controller.snapshot().webLock?.error, 'already-registered');
    } finally {
      controller.stop();
      await gateway.close();
    }
  });

  it('a native pairing (no web:unlock) never reports a web lock and DOES resync', async () => {
    resetSecureStore();
    const code = pairCode('T');
    const gateway = await FakeGateway.create({ pairingCodes: [code], deviceScopes: ['sessions:read'] });
    const controller = new AppController({
      locale: () => 'en',
      transport: nodeTransport,
      pairAckTimeoutMs: 600,
      passkey: fakePasskey().steps,
    });
    try {
      await controller.start();
      await controller.pair(pairingPayload(gateway, code));
      // The platform gate opening is what connects the bearer socket (A020); the Host's passkey lock
      // is a SEPARATE layer on top of it, which is the distinction this suite is about.
      await controller.unlock();
      await waitFor(() => controller.snapshot().connection === 'ready', { label: 'socket ready' });
      assert.equal(controller.snapshot().webLock, null, 'native is never locked');
      await waitFor(() => gateway.requestCount('sessions') > 0, { label: 'native resync ran' });
    } finally {
      controller.stop();
      await gateway.close();
    }
  });
});
