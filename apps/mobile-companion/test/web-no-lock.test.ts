// Spec 045 — the PWA has no lock gate. Behavioural tests for the controller's web branch and
// source-level assertions for the layout (this Node suite has no React Native render harness).

import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { describe, it } from 'node:test';
import { fileURLToPath } from 'node:url';

import { AppController } from '../src/app-state';
import { CoreError, encodePairingPayload, type PairingPayload } from '../src/core';
import { FakeGateway } from './support/fake-gateway';
import { NodePinnedTransport } from './support/node-pinned-transport';
import { resetSecureStore } from './support/stubs/expo-secure-store.stub';
import { waitFor } from './support/wait';

const nodeTransport = () => new NodePinnedTransport({ handshakeTimeoutMs: 4_000 });
function pairCode(): string { return 'A'.repeat(42) + 'Q'; }
function payload(gateway: FakeGateway, code: string): string {
  const data: PairingPayload = {
    version: 3, publicUrl: gateway.endpoint, pairingCode: code, expiresAt: Date.now() + 240_000,
    certSha256: gateway.certSha256, gatewayId: '2b3c9d1e-4f5a-4b6c-8d7e-9f0a1b2c3d4e',
    gatewayName: 'my-pc', endpoints: [gateway.endpoint],
  };
  return encodePairingPayload(data);
}

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const LAYOUT = readFileSync(path.join(ROOT, 'app', '_layout.tsx'), 'utf8');
const SETTINGS = readFileSync(path.join(ROOT, 'app', 'settings.tsx'), 'utf8');
const I18N = readFileSync(path.join(ROOT, 'i18n', 'index.ts'), 'utf8');
/** Only the mounted component matters: legacy gate helpers remain in the file for wire compat. */
const ROOT_LAYOUT = LAYOUT.slice(
  LAYOUT.indexOf('export default function RootLayout()'),
  LAYOUT.indexOf('Spec 021 — the web bootstrap'),
);

type Reach = {
  host: unknown;
  webLockGranted: boolean;
  loadWebUnlockGrant(): Promise<void>;
  applyWebLock(client: unknown): void;
  recordError(error: unknown): void;
};

function webController(): AppController {
  return new AppController({
    locale: () => 'en',
    webMode: true,
    readWebUnlockGrant: async () => true,
  });
}

function reach(c: AppController): Reach {
  return c as unknown as Reach;
}

function legacyClient(): { webLock: string; state: string; close: () => void; device: { scopes: string[] } } {
  return { webLock: 'locked', state: 'ready', close: () => {}, device: { scopes: ['web:unlock'] } };
}

describe('spec 045: web controller never re-arms a lock', () => {
  it('a stored 24h grant does not lock the PWA or open a lock-only socket', async () => {
    const c = webController();
    try {
      reach(c).webLockGranted = true;
      reach(c).host = { gatewayId: 'g', publicUrl: 'https://g' };
      await reach(c).loadWebUnlockGrant();
      assert.equal(c.snapshot().webLock?.state, 'unlocked', 'stored grant is ignored by the web UI');
      assert.equal(await c.startWebLockSession(), null, 'no locked socket is opened');
    } finally {
      c.stop();
    }
  });

  it('a legacy hello.webLock:locked is an update notice only, not a gate or a disconnect', () => {
    const c = webController();
    const client = legacyClient();
    let closed = false;
    (client as { close: () => void }).close = () => { closed = true; };
    try {
      reach(c).webLockGranted = true;
      reach(c).host = { gatewayId: 'g', publicUrl: 'https://g' };
      reach(c).applyWebLock(client);
      const snap = c.snapshot();
      assert.equal(snap.webLock?.state, 'unlocked', 'web UI stays unlocked');
      assert.equal(snap.legacyWebLockGateway, true, 'old gateway is detected');
      assert.equal(closed, false, 'the socket is not disconnected');
      assert.equal((c as unknown as { client: unknown }).client === null, true, 'no gate socket was promoted');
    } finally {
      c.stop();
    }
  });

  it('auth/locked on an ordinary frame also raises the update notice', () => {
    const c = webController();
    try {
      reach(c).recordError(new CoreError({ code: 'auth/locked', message: 'old gateway' }));
      assert.equal(c.snapshot().legacyWebLockGateway, true);
    } finally {
      c.stop();
    }
  });

  it('native path is unchanged: a grant still locks and a hello is still authoritative', () => {
    const c = new AppController({ locale: () => 'en', webMode: false });
    try {
      reach(c).webLockGranted = true;
      reach(c).host = { gatewayId: 'g', publicUrl: 'https://g' };
      reach(c).applyWebLock(legacyClient());
      assert.equal(c.snapshot().webLock?.state, 'locked');
      c.lock();
      assert.equal(c.snapshot().webLock?.state, 'locked', 'native keeps the lock path');
      assert.equal(c.snapshot().legacyWebLockGateway, false, 'notice is web-only');
    } finally {
      c.stop();
    }
  });
});

describe('spec 045: web UI has no gate', () => {
  it('layout mounts neither WebBootstrap nor WebLockGate, and never opens a lock session', () => {
    assert.doesNotMatch(ROOT_LAYOUT, /<WebBootstrap\b/);
    assert.doesNotMatch(ROOT_LAYOUT, /<WebLockGate\b/);
    assert.doesNotMatch(ROOT_LAYOUT, /controller\.startWebLockSession\(\)/);
    assert.match(LAYOUT, /useState<GateStatus>\(\(\) => \(isWeb \? 'unlocked' : 'checking'\)\)/);
    assert.match(LAYOUT, /testID="legacy-web-lock-notice"/);
  });

  it('a background PWA does not lock and Settings has no Lock now row', () => {
    assert.doesNotMatch(SETTINGS, /settings-lock-now/);
    assert.doesNotMatch(SETTINGS, /lockWebDevice/);
    assert.match(LAYOUT, /if \(isWeb\) return;\n      \/\/ 'checking' is included/);
  });

  it('the update notice has copy in both locales', () => {
    for (const key of ['update.legacyWebLockTitle', 'update.legacyWebLockBody']) {
      const count = I18N.match(new RegExp(`'${key.replace('.', '\\.')}':`, 'g'))?.length ?? 0;
      assert.equal(count, 2, `${key} is in en and vi`);
    }
  });
});

describe('spec 045: web starts and stays connected', () => {
  it('constructor is unlocked and lock() cannot close the web gate or socket', () => {
    const c = webController();
    try {
      assert.equal(c.snapshot().unlocked, true, 'PWA is unlocked before any unlock() call');
      c.lock();
      assert.equal(c.snapshot().unlocked, true, 'a stray lock() leaves it unlocked');
    } finally {
      c.stop();
    }
  });

  it('fresh pairing goes straight to a live, resynced connection (no unlock step)', async () => {
    resetSecureStore();
    const code = pairCode();
    const gateway = await FakeGateway.create({ pairingCodes: [code], deviceScopes: ['sessions:read'] });
    const c = new AppController({ locale: () => 'en', webMode: true, transport: nodeTransport, pairAckTimeoutMs: 2_000 });
    try {
      await c.start();
      const result = await c.pair(payload(gateway, code));
      assert.equal(result.ok, true);
      await waitFor(() => c.snapshot().connection === 'ready', { label: 'pairing socket became the live socket' });
      const snap = c.snapshot();
      assert.equal(snap.unlocked, true, 'the PWA never waits for an unlock prompt');
      assert.equal(snap.pairingPending, null);
      assert.equal(snap.lastError, null, 'the live socket resynced without a refusal');
    } finally {
      c.stop();
      await gateway.close();
    }
  });

  it('cold start with a stored host connects, accepts hello and resyncs without unlock()', async () => {
    resetSecureStore();
    const code = pairCode();
    const gateway = await FakeGateway.create({ pairingCodes: [code], deviceScopes: ['sessions:read'] });
    const first = new AppController({ locale: () => 'en', webMode: true, transport: nodeTransport, pairAckTimeoutMs: 2_000 });
    try {
      await first.start();
      assert.equal((await first.pair(payload(gateway, code))).ok, true);
      await waitFor(() => first.snapshot().connection === 'ready', { label: 'first connection ready' });
    } finally {
      first.stop();
    }
    const reloaded = new AppController({ locale: () => 'en', webMode: true, transport: nodeTransport });
    try {
      assert.equal(reloaded.snapshot().unlocked, true, 'still unlocked before start()');
      await reloaded.start();
      await waitFor(() => reloaded.snapshot().connection === 'ready', { label: 'stored host reconnected at startup' });
      const snap = reloaded.snapshot();
      assert.equal(snap.unlocked, true);
      assert.notEqual(snap.activeHost, null);
      assert.equal(snap.lastError, null, 'resync succeeded on the accepted socket');
    } finally {
      reloaded.stop();
      await gateway.close();
    }
  });
});
