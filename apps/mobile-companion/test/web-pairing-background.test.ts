// A PWA that goes hidden while the Host is deciding MUST keep its one-time pairing socket.
//
// Measured 2026-11-16: entering the OTP raised `pairing pending`, then switching to the DSH
// Devices window (the user pressed × on the OTP dialog) produced
// `pending pairing dropped: client disconnected` 1.6 s later. RN-web maps visibilitychange to
// AppState 'background', the root layout locked the controller, and `lock()` closed `this.client`
// — which `newClient()` had set to the pairing socket. The × button itself is display-only.
// This test drives the real controller through that sequence and approves afterwards.

import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import { encodePairingPayload, type PairingPayload } from '../src/core';
import type { PinnedTransport } from '../src/platform';
import { AppController } from '../src/app-state';
import { mayLockOnBackground } from '../src/ui/background-lock';
import { ScriptedTransport } from './support/scripted-transport';
import { waitFor } from './support/wait';

const PIN = 'a'.repeat(64);
const INSTALL_ID = '3f2a1c9e-0b7d-4f6a-9c1e-8d5b2a7f4c63';
const GATEWAY_ID = '0f8fad5b-d9cb-469f-a165-70867728950e';
const CHALLENGE = { kind: 'pairing-challenge', serverNonce: 's'.repeat(32), certSha256: PIN, otpRequired: false };
const HELLO = {
  kind: 'hello', protocol: 1, companionProtocol: 1, minClientVersion: 1, capabilities: [],
  authenticated: true, device: { id: INSTALL_ID, name: 'PWA test' }, gatewayId: GATEWAY_ID,
};

function payload(): string {
  const data: PairingPayload = {
    version: 3, publicUrl: 'wss://127.0.0.1:14144/ws/mobile', pairingCode: 'Q'.repeat(43),
    expiresAt: Date.now() + 240_000, certSha256: PIN, gatewayId: GATEWAY_ID, gatewayName: 'my-pc',
    endpoints: ['wss://127.0.0.1:14144/ws/mobile'],
  };
  return encodePairingPayload(data);
}

function harness() {
  const transports: ScriptedTransport[] = [];
  const controller = new AppController({
    locale: () => 'en',
    transport: () => {
      const transport = new ScriptedTransport();
      transports.push(transport);
      return transport as unknown as PinnedTransport;
    },
  });
  return { controller, transports };
}

/** Drive the socket to the Host's approval wait, then report the pending frame. */
async function reachPending(controller: AppController, transports: ScriptedTransport[]) {
  const pairing = controller.pair(payload());
  await waitFor(() => transports.length > 0, { label: 'pairing socket allocated' });
  const socket = transports[0];
  assert.ok(socket !== undefined);
  socket.fireOpen();
  socket.deliver(CHALLENGE);
  socket.deliver({ kind: 'pairing-pending', verificationCode: '482 913', requestId: 'r-1', expiresAt: Date.now() + 300_000 });
  await waitFor(() => controller.snapshot().pairingPending !== null, { label: 'approval code published' });
  return { pairing, socket };
}

async function approve(socket: ScriptedTransport, pairing: Promise<{ ok: boolean }>) {
  socket.deliver({ kind: 'paired', token: 'tok-approved', device: { id: INSTALL_ID, name: 'PWA test' } });
  socket.deliver(HELLO);
  const requestId = socket.lastRequestId('client-hello');
  socket.deliver({ kind: 'client-hello', requestId, accepted: true });
  return pairing;
}

describe('web background during a pairing approval wait', () => {
  it('keeps the pending socket alive, and still completes when the Host approves', async () => {
    const { controller, transports } = harness();
    await controller.start();
    try {
      const { pairing, socket } = await reachPending(controller, transports);
      // This is exactly what the layout's AppState 'background' handler now does on web.
      const locked = mayLockOnBackground({
        platform: 'web',
        pairingPending: controller.snapshot().pairingPending,
      });
      if (locked) controller.lock();
      assert.equal(locked, false, 'no lock before `paired` on web: keep the socket');
      assert.equal(socket.isOpen(), true, 'the one-time socket must stay open');
      assert.ok(controller.snapshot().pairingPending !== null, 'the Host still sees a pending request');

      const result = await approve(socket, pairing);
      assert.equal(result.ok, true, 'the PWA receives `paired` after approval');
      assert.equal(controller.snapshot().pairingPending, null);
    } finally {
      controller.stop();
    }
  });

  it('native still locks on background during the same wait', async () => {
    const { controller, transports } = harness();
    await controller.start();
    try {
      const { pairing, socket } = await reachPending(controller, transports);
      const locked = mayLockOnBackground({
        platform: 'ios',
        pairingPending: controller.snapshot().pairingPending,
      });
      if (locked) controller.lock();
      assert.equal(locked, true, 'A020/M5: native backgrounding still locks');
      assert.equal(socket.isOpen(), false, 'the credential boundary closes the socket on native');
      pairing.catch(() => undefined);
    } finally {
      controller.stop();
    }
  });

  it('spec 045: never locks on web, even after pairing (a credential now exists)', async () => {
    const { controller, transports } = harness();
    await controller.start();
    try {
      const { pairing, socket } = await reachPending(controller, transports);
      await approve(socket, pairing);
      const locked = mayLockOnBackground({
        platform: 'web',
        pairingPending: controller.snapshot().pairingPending,
      });
      if (locked) controller.lock();
      assert.equal(locked, false, 'spec 045: the PWA keeps its socket after pairing');
    } finally {
      controller.stop();
    }
  });

  it('clears the approval-pending flag synchronously on `paired`, even while the page is hidden', async () => {
    const { controller, transports } = harness();
    await controller.start();
    try {
      const { pairing, socket } = await reachPending(controller, transports);
      // The page went hidden while the Host was deciding: the web exception keeps the socket.
      const locked = mayLockOnBackground({
        platform: 'web',
        pairingPending: controller.snapshot().pairingPending,
      });
      if (locked) controller.lock();
      assert.equal(locked, false, 'pre-credential: no lock while hidden');
      // The Host approves while the page is STILL hidden. The credential has arrived, so the
      // pending flag must be cleared in this same turn — no second AppState event may be needed
      // for the next background transition to lock again.
      socket.deliver({ kind: 'paired', token: 'tok-approved', device: { id: INSTALL_ID, name: 'PWA test' } });
      assert.equal(controller.snapshot().pairingPending, null, 'pending cleared on `paired`, not after persistence');
      socket.deliver(HELLO);
      const requestId = socket.lastRequestId('client-hello');
      socket.deliver({ kind: 'client-hello', requestId, accepted: true });
      const result = await pairing;
      assert.equal(result.ok, true);
    } finally {
      controller.stop();
    }
  });
});
