// Spec 046 behavioural: three opaque browser connect failures stop the web loop with an honest
// "connection unavailable" state, without judging the credential or wiping it.

import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import { AppController } from '../src/app-state';
import { encodePairingPayload, type PairingPayload } from '../src/core';
import { FakeGateway } from './support/fake-gateway';
import { NodePinnedTransport } from './support/node-pinned-transport';
import { ScriptedTransport } from './support/scripted-transport';
import { resetSecureStore } from './support/stubs/expo-secure-store.stub';
import { waitFor } from './support/wait';

function pairCode(): string { return 'A'.repeat(42) + 'Q'; }
function payload(gateway: FakeGateway, code: string): string {
  const data: PairingPayload = {
    version: 3, publicUrl: gateway.endpoint, pairingCode: code, expiresAt: Date.now() + 240_000,
    certSha256: gateway.certSha256, gatewayId: '2b3c9d1e-4f5a-4b6c-8d7e-9f0a1b2c3d4e',
    gatewayName: 'my-pc', endpoints: [gateway.endpoint],
  };
  return encodePairingPayload(data);
}

interface Harness {
  controller: AppController;
  transports: ScriptedTransport[];
}

async function storedHostHarness(gateway: FakeGateway, code: string): Promise<Harness> {
  const first = new AppController({ locale: () => 'en', webMode: true, transport: () => new NodePinnedTransport({ handshakeTimeoutMs: 4_000 }) as never });
  try {
    await first.start();
    assert.equal((await first.pair(payload(gateway, code))).ok, true);
    await waitFor(() => first.snapshot().connection === 'ready', { label: 'stored pairing ready' });
  } finally {
    first.stop();
  }
  const transports: ScriptedTransport[] = [];
  const controller = new AppController({
    locale: () => 'en',
    webMode: true,
    transport: () => {
      const t = new ScriptedTransport();
      transports.push(t);
      return t as never;
    },
  });
  return { controller, transports };
}

async function failAttempt(transports: ScriptedTransport[], index: number): Promise<void> {
  await waitFor(() => transports.length > index, { label: `attempt ${index + 1} opened` });
  transports[index]?.close(1006, 'connect-failed');
}

describe('spec 046: web pre-open budget (behavioural)', () => {
  it('three opaque failures stop the loop; no fourth attempt, no session request, no wipe', async () => {
    resetSecureStore();
    const code = pairCode();
    const gateway = await FakeGateway.create({ pairingCodes: [code], deviceScopes: ['sessions:read'] });
    const { controller, transports } = await storedHostHarness(gateway, code);
    try {
      await controller.start();
      for (let i = 0; i < 3; i += 1) await failAttempt(transports, i);
      await waitFor(() => controller.snapshot().banner === 'connect-failed', { label: 'connection unavailable banner' });
      const snap = controller.snapshot();
      assert.equal(snap.credentialRejected, false, 'an opaque failure is NOT a credential verdict');
      assert.notEqual(snap.activeHost, null, 'the stored credential is kept');
      assert.equal(transports.length, 3, 'exactly three pre-open attempts');
      assert.equal(transports.some((t) => t.sentFrames().some((f) => f.type === 'sessions')), false, 'no resync over a dead socket');
      await new Promise((resolve) => setTimeout(resolve, 150));
      assert.equal(transports.length, 3, 'no fourth attempt after the cap');
    } finally {
      controller.stop();
      await gateway.close();
    }
  });

  it('Retry and foreground resume open a fresh budget', async () => {
    resetSecureStore();
    const code = pairCode();
    const gateway = await FakeGateway.create({ pairingCodes: [code], deviceScopes: ['sessions:read'] });
    const { controller, transports } = await storedHostHarness(gateway, code);
    try {
      await controller.start();
      for (let i = 0; i < 3; i += 1) await failAttempt(transports, i);
      await waitFor(() => controller.snapshot().banner === 'connect-failed', { label: 'capped' });
      await controller.retryConnection();
      await waitFor(() => transports.length === 4, { label: 'Retry opened a fresh budget' });
      assert.equal(controller.snapshot().banner, 'reconnecting');
      // Foreground resume is wired to the same fresh-budget path (asserted in the source test);
      // driving it here would race the stopped client's own close events.
    } finally {
      controller.stop();
      await gateway.close();
    }
  });

  it('one success before the cap disables it for later drops', async () => {
    resetSecureStore();
    const code = pairCode();
    const gateway = await FakeGateway.create({ pairingCodes: [code], deviceScopes: ['sessions:read'] });
    const { controller, transports } = await storedHostHarness(gateway, code);
    try {
      await controller.start();
      await failAttempt(transports, 0);
      await waitFor(() => transports.length === 2, { label: 'second attempt' });
      const live = transports[1];
      assert.ok(live !== undefined);
      live.fireOpen();
      live.deliver({ kind: 'hello', protocol: 1, companionProtocol: 1, minClientVersion: 1, capabilities: [], authenticated: true, device: { id: 'd', name: 'web' } });
      const requestId = live.lastRequestId('client-hello');
      live.deliver({ kind: 'client-hello', requestId, accepted: true });
      await waitFor(() => controller.snapshot().connection === 'ready', { label: 'live connection' });
      // A later drop uses ordinary backoff; the cap must not fire at three total historical failures.
      live.close(1006, 'transient');
      await waitFor(() => controller.snapshot().banner === 'reconnecting', { label: 'ordinary reconnect after a live session' });
      assert.notEqual(controller.snapshot().banner, 'connect-failed');
    } finally {
      controller.stop();
      await gateway.close();
    }
  });
});
