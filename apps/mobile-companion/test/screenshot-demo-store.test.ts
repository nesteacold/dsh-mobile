// Spec 032 — demo mode must not touch the device: zero secure-store calls on EVERY path.
//
// Why this file exists: the first review found that the demo gate could still reach the REAL wipe
// path (`deleteCredentialInstance` → `forgetHost`, which reads the keychain entry back and deletes
// it) on a revoke/forget/failed-pair cleanup, and the real host-list write on a pairing.
//
// METHOD: `expo-secure-store` is replaced for THIS FILE ONLY by a counting stub (the hook below is
// registered before `src/app-state.ts` is loaded in `before()`), so every
// `getItemAsync`/`setItemAsync`/`deleteItemAsync` call is counted. `src/platform/secure-store.ts`
// reaches the keychain ONLY through those three calls, so the counters are the evidence for the
// credential and the host list.
//
// ONE KNOWN, NON-CREDENTIAL CALL: the install id (`src/platform/install-id.ts`,
// `dsh-companion.install-id`) is a random UUID that identifies this install to a Host — not a
// credential, cached for the process, and what the pairing/`connect` send as `X-DSH-Device-ID`
// (contract §3.2). Assertions allow at most that one get + one set, and never a delete.
//
// The pairing frames come from the IN-PROCESS fixture (`test/support/fake-gateway.ts`, a real TLS +
// WSS server on an ephemeral 127.0.0.1 port) through the ordinary Node pinned transport, so a demo
// pairing / revoke / forget is a real protocol run. The build's native module is this file's
// double (compile-time simulator constant + the native `pinned-ws` surface) whose `connect`
// delegates to `NodePinnedTransport` — the run exercises the real
// `src/platform/pinned-transport.demo.ts` and the real native-transport adapter, with real TLS.

import assert from 'node:assert/strict';
import { registerHooks } from 'node:module';
import { before, beforeEach, describe, it } from 'node:test';

import { encodePairingPayload, type PairingPayload } from '../src/core';
import type { PinnedWsAdapter } from '../modules/pinned-ws';
import { FakeGateway } from './support/fake-gateway';
import { NodePinnedTransport } from './support/node-pinned-transport';
import { waitFor } from './support/wait';
import { resetAppState } from './support/stubs/react-native.stub';

// ---------------------------------------------------------------------------
// Counting secure store (the shared stub's surface plus counters and a seeder)
// ---------------------------------------------------------------------------

const STORE_SOURCE = `
const store = new Map();
const counts = { get: 0, set: 0, remove: 0 };
export async function getItemAsync(key) {
  counts.get += 1;
  return store.get(key) ?? null;
}
export async function setItemAsync(key, value) {
  counts.set += 1;
  store.set(key, value);
}
export async function deleteItemAsync(key) {
  counts.remove += 1;
  store.delete(key);
}
export async function isAvailableAsync() { return true; }
export const WHEN_UNLOCKED_THIS_DEVICE_ONLY = 'WHEN_UNLOCKED_THIS_DEVICE_ONLY';
export const AFTER_FIRST_UNLOCK = 'AFTER_FIRST_UNLOCK';
export const WHEN_UNLOCKED = 'WHEN_UNLOCKED';
export function __counts() { return { ...counts }; }
export function __reset() { store.clear(); counts.get = 0; counts.set = 0; counts.remove = 0; }
export function __seed(entries) { for (const [key, value] of entries) store.set(key, value); }
export function __entries() { return [...store.entries()]; }
`;

const STORE_URL = `data:text/javascript;base64,${Buffer.from(STORE_SOURCE, 'utf8').toString('base64')}`;

registerHooks({
  resolve(specifier, _context, nextResolve) {
    if (specifier === 'expo-secure-store') return { url: STORE_URL, shortCircuit: true };
    return nextResolve(specifier, _context);
  },
});

interface CountingStore {
  __counts(): { get: number; set: number; remove: number };
  __reset(): void;
  __seed(entries: Array<[string, string]>): void;
  __entries(): Array<[string, string]>;
}

let store: CountingStore;
let AppController: typeof import('../src/app-state').AppController;
let createDemoTransport: typeof import('../src/platform/pinned-transport.demo').createDemoTransport;
let installId: typeof import('../src/platform/install-id');

before(async () => {
  store = (await import('expo-secure-store')) as unknown as CountingStore;
  createDemoTransport = (await import('../src/platform/pinned-transport.demo')).createDemoTransport;
  installId = await import('../src/platform/install-id');
  ({ AppController } = await import('../src/app-state'));
});

type Controller = InstanceType<typeof AppController>;

const GATEWAY_A = '0f8fad5b-d9cb-469f-a165-70867728950e';
const NOW = Date.now();
const TOKEN_PREFIX = 'dsh-companion.token.';
const HOSTS_KEY = 'dsh-companion.hosts';
const REAL_TOKEN = 'real-device-token';
const REAL_HOSTS = JSON.stringify([{ schemaVersion: 1, gatewayId: GATEWAY_A, publicUrl: 'wss://100.64.0.9:3443' }]);

/**
 * The native `pinned-ws` double for this file. The real adapter (`PinnedTransport`) registers its
 * four listeners BEFORE it calls `connect`, and the native module tags every event with its socket
 * `id`; this double mirrors that: `addListener` parks the listener with a pending id that the
 * next `connect(id, …)` claims, and each socket fans its Node transport's events out.
 */
function makeNativeModule(): PinnedWsAdapter {
  const sockets = new Map<string, { node: NodePinnedTransport; listeners: Map<string, Set<(event: unknown) => void>> }>();
  const pending: Array<{ name: string; listener: (event: unknown) => void }> = [];
  const emit = (id: string, name: string, body: Record<string, unknown>): void => {
    for (const listener of sockets.get(id)?.listeners.get(name) ?? []) listener({ id, ...body });
  };
  return {
    constants: () => ({ simulator: true }),
    async connect(id: string, url: string, options: Record<string, unknown>) {
      const node = new NodePinnedTransport({ handshakeTimeoutMs: 4_000 });
      const listeners = new Map<string, Set<(event: unknown) => void>>();
      for (const entry of pending.splice(0)) {
        if (!listeners.has(entry.name)) listeners.set(entry.name, new Set());
        listeners.get(entry.name)!.add(entry.listener);
      }
      sockets.set(id, { node, listeners });
      node.on((event) => {
        if (event.type === 'open') emit(id, 'onOpen', {});
        else if (event.type === 'message') emit(id, 'onMessage', { data: event.data });
        else if (event.type === 'close') emit(id, 'onClose', { code: event.code, reason: event.reason });
        else if (event.type === 'error') emit(id, 'onError', { code: event.code, message: event.message });
      });
      node.connect(url, options as never);
    },
    async send(id: string, text: string): Promise<boolean> {
      return sockets.get(id)?.node.send(text) ?? false;
    },
    async close(id: string, code: number, reason: string): Promise<void> {
      sockets.get(id)?.node.close(code, reason);
      sockets.delete(id);
    },
    addListener(name: string, listener: (event: unknown) => void) {
      pending.push({ name, listener });
      return {
        remove: () => {
          for (const socket of sockets.values()) socket.listeners.get(name)?.delete(listener);
          const index = pending.findIndex((entry) => entry.listener === listener && entry.name === name);
          if (index >= 0) pending.splice(index, 1);
        },
      };
    },
  } as unknown as PinnedWsAdapter;
}

/** The mode's transport, exactly as `app/_layout.tsx` mounts it (one native module per controller). */
function demoTransportFactoryFactory(): typeof createDemoTransport {
  // `isSimulator` mirrors the compile-time fact the layout hands over; the transport never uses it
  // as a trust switch (spec 032 review #2), so both values behave identically here.
  const module = makeNativeModule();
  return (options) => createDemoTransport({ ...options, module, isSimulator: true });
}

/** The demo-aware controller on the in-memory demo store (exactly what `_layout` builds). */
function demoController(): Controller {
  const transport = demoTransportFactoryFactory();
  return new AppController({
    locale: () => 'en',
    transport,
    screenshotMode: { enabled: true, transport },
    pairAckTimeoutMs: 20_000,
  });
}

function pairingPayload(gateway: FakeGateway, code: string): string {
  const payload: PairingPayload = {
    version: 3,
    publicUrl: gateway.endpoint,
    pairingCode: code,
    expiresAt: NOW + 240_000,
    certSha256: gateway.certSha256,
    gatewayId: GATEWAY_A,
    gatewayName: 'demo-fixture',
    endpoints: [gateway.endpoint],
  };
  return encodePairingPayload(payload);
}

function pairCode(letter: string): string {
  const canonical = ['A', 'E', 'I', 'M', 'Q', 'U', 'Y', 'c', 'g', 'k', 'o', 's', 'w', '0', '4', '8'];
  const index = Math.abs(letter.charCodeAt(0) - 'A'.charCodeAt(0)) % canonical.length;
  return 'A'.repeat(42) + (canonical[index] as string);
}

/** The device was not touched: no credential/host-list call, and the seeded real pairing survives. */
function assertUntouched(label: string, allowed = { get: 1, set: 1 }): void {
  const counts = store.__counts();
  assert.ok(counts.remove === 0, `${label}: no secure-store delete was attempted (${JSON.stringify(counts)})`);
  assert.ok(
    counts.get <= allowed.get && counts.set <= allowed.set,
    `${label}: only the install id could have been read/written (${JSON.stringify(counts)})`,
  );
  assert.equal(
    store.__entries().find(([key]) => key === `${TOKEN_PREFIX}${GATEWAY_A}`)?.[1],
    REAL_TOKEN,
    `${label}: the real credential is still there`,
  );
  assert.equal(store.__entries().find(([key]) => key === HOSTS_KEY)?.[1], REAL_HOSTS, `${label}: the real host list is unchanged`);
}

describe('spec 032 demo mode: zero secure-store calls on every path', () => {
  beforeEach(() => {
    store.__reset();
    // A REAL pairing already on this device: nothing the demo run does may touch it.
    store.__seed([[`${TOKEN_PREFIX}${GATEWAY_A}`, REAL_TOKEN], [HOSTS_KEY, REAL_HOSTS]]);
    // The install id is cached per process: clear it so this case measures its OWN start.
    installId.clearInstallIdCache();
    resetAppState('active');
  });

  it('start + pair + connect + reconnect leave the device untouched', async () => {
    const code = pairCode('A');
    const gateway = await FakeGateway.create({ pairingCodes: [code] });
    const controller = demoController();
    try {
      await controller.start();
      assertUntouched('start');
      await controller.unlock();
      const result = await controller.pair(pairingPayload(gateway, code));
      assert.equal(result.ok, true, `demo pair failed: ${result.ok ? '' : result.code}`);
      await waitFor(() => controller.snapshot().connection === 'ready', { label: 'demo socket ready' });
      assertUntouched('pair + connect');
      gateway.dropAllConnections();
      await waitFor(() => controller.snapshot().connection !== 'ready', { label: 'drop noticed' });
      await controller.unlock();
      assertUntouched('reconnect');
    } finally {
      controller.stop();
      await gateway.close();
    }
  });

  it('revoke (4401) cleans up the DEMO pairing only — never the real credential', async () => {
    const code = pairCode('E');
    const gateway = await FakeGateway.create({ pairingCodes: [code] });
    const controller = demoController();
    try {
      await controller.start();
      await controller.unlock();
      const result = await controller.pair(pairingPayload(gateway, code));
      assert.equal(result.ok, true, `demo pair failed: ${result.ok ? '' : result.code}`);
      await waitFor(() => controller.snapshot().connection === 'ready', { label: 'demo socket ready' });
      gateway.closeAll(4401, 'revoked');
      await waitFor(() => controller.snapshot().banner === 'revoked', { label: 'revocation handled' });
      assert.equal(controller.snapshot().activeHost, null, 'the demo host is gone');
      assertUntouched('revoke');
    } finally {
      controller.stop();
      await gateway.close();
    }
  });

  it('forget() on a demo pairing never runs the real wipe', async () => {
    const code = pairCode('I');
    const gateway = await FakeGateway.create({ pairingCodes: [code] });
    const controller = demoController();
    try {
      await controller.start();
      await controller.unlock();
      const result = await controller.pair(pairingPayload(gateway, code));
      assert.equal(result.ok, true, `demo pair failed: ${result.ok ? '' : result.code}`);
      await controller.forget();
      assert.equal(controller.snapshot().activeHost, null);
      assertUntouched('forget');
    } finally {
      controller.stop();
      await gateway.close();
    }
  });

  it('a FAILED pair (no such pairing code) leaves no trace on the device', async () => {
    const code = pairCode('M');
    const gateway = await FakeGateway.create({ pairingCodes: [code] });
    const controller = demoController();
    try {
      await controller.start();
      await controller.unlock();
      const result = await controller.pair(pairingPayload(gateway, pairCode('Y')));
      assert.equal(result.ok, false, 'the fixture refuses an unknown code');
      assertUntouched('failed pair');
    } finally {
      controller.stop();
      await gateway.close();
    }
  });

  it('a demo pairing really opens the gate: the fixture token authenticates the demo socket', async () => {
    const code = pairCode('k');
    const gateway = await FakeGateway.create({ pairingCodes: [code] });
    const controller = demoController();
    try {
      await controller.start();
      await controller.unlock();
      const result = await controller.pair(pairingPayload(gateway, code));
      assert.equal(result.ok, true, `demo pair failed: ${result.ok ? '' : result.code}`);
      await waitFor(() => controller.snapshot().connection === 'ready', { label: 'demo socket ready' });
      assert.equal(controller.snapshot().activeHost?.gatewayId, GATEWAY_A);
      assertUntouched('the real store was not involved');
    } finally {
      controller.stop();
      await gateway.close();
    }
  });
});
