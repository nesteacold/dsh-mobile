// Owner report 2026-11-17: after a successful PWA unlock, EVERY conversation opens empty and a
// reload does not help. Source trace: `openSession()` clears history and calls `loadSession()`, but
// `loadSession()` returns silently when the client is not `ready`. When a later connection becomes
// ready, `resync()` must reload the history for the still-open session. This behavioural test pins
// that sequence with the real controller + fake gateway (no source regex).

import assert from 'node:assert/strict';
import { afterEach, beforeEach, describe, it } from 'node:test';

import { AppController } from '../src/app-state';
import { encodePairingPayload, type PairingPayload } from '../src/core';
import { resetAppState } from './support/stubs/react-native.stub';
import { resetLocalAuthentication } from './support/stubs/expo-local-authentication.stub';
import { resetNotifications } from './support/stubs/expo-notifications.stub';
import { resetSecureStore } from './support/stubs/expo-secure-store.stub';
import { FakeGateway } from './support/fake-gateway';
import { NodePinnedTransport } from './support/node-pinned-transport';
import { waitFor } from './support/wait';

const NOW = Date.now();
const SESSION = 's-running';
const CODE = 'A'.repeat(43);

function pairingPayload(gateway: FakeGateway): string {
  const payload: PairingPayload = {
    version: 3,
    publicUrl: gateway.endpoint,
    pairingCode: CODE,
    expiresAt: NOW + 240_000,
    certSha256: gateway.certSha256,
    gatewayId: '0f8fad5b-d9cb-469f-a165-70867728950e',
    gatewayName: 'my-pc',
    endpoints: [gateway.endpoint],
  };
  return encodePairingPayload(payload);
}

describe('history loads for a session opened before the socket is ready', () => {
  let gateway: FakeGateway;
  let controller: AppController;

  beforeEach(async () => {
    resetSecureStore();
    resetAppState('active');
    resetLocalAuthentication();
    resetNotifications(true);
    gateway = await FakeGateway.create({ deviceScopes: ['sessions:read'] });
    gateway.addPairingCode(CODE);
    controller = new AppController({
      locale: () => 'en',
      transport: () => new NodePinnedTransport({ handshakeTimeoutMs: 4_000 }),
    });
    await controller.start();
    const paired = await controller.pair(pairingPayload(gateway));
    assert.equal(paired.ok, true, JSON.stringify(paired));
  });

  afterEach(async () => {
    controller.stop();
    await gateway.close();
  });

  it('shows messages after the later connection becomes ready', async () => {
    // Open the conversation while there is no ready client. Today `loadSession()` silently returns.
    controller.openSession(SESSION);
    assert.equal(controller.snapshot().history.length, 0, 'history starts empty');
    assert.notEqual(controller.snapshot().connection, 'ready', 'the regression needs a not-ready socket');

    await controller.unlock();
    await waitFor(() => controller.snapshot().connection === 'ready', { label: 'socket ready after unlock' });
    await waitFor(() => controller.snapshot().history.length > 0, { label: 'history replayed after ready' });

    assert.equal(controller.snapshot().openSessionId, SESSION);
    assert.deepEqual(controller.snapshot().history.map((row) => row.id), [
      `${SESSION}-m1`, `${SESSION}-m2`,
    ]);
  });
});
