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
// ONE KNOWN, NON-CREDENTIAL CALL — GONE (spec 032 amendment 2026-11-16): the install id
// (`src/platform/install-id.ts`, `dsh-companion.install-id`) used to be read from (and, on first
// use, written to) the keychain even in demo mode. It is not a credential, but an unsigned Release
// build on an iOS simulator has no Keychain entitlement, so that read THREW and demo `pair()` failed
// as `client/bad-message` before any socket. Demo mode now takes a per-controller in-memory id
// (`src/platform/demo-install-id.ts`), so the allowed counts are ZERO reads, ZERO writes and ZERO
// deletes on every path. The last cases prove the mode against a store that throws on every call.
//
// The pairing frames come from the IN-PROCESS fixture (`test/support/fake-gateway.ts`, a real TLS +
// WSS server on an ephemeral 127.0.0.1 port) through the ordinary Node pinned transport, so a demo
// pairing / revoke / forget is a real protocol run. The build's native module is this file's
// double (compile-time simulator constant + the native `pinned-ws` surface) whose `connect`
// delegates to `NodePinnedTransport` — the run exercises the real
// `src/platform/pinned-transport.demo.ts` and the real native-transport adapter, with real TLS.

import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { registerHooks } from 'node:module';
import { before, beforeEach, describe, it } from 'node:test';
import { fileURLToPath } from 'node:url';

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
// Every call rejects while this is on: the Keychain of an unsigned simulator Release build.
let throwing = false;
let throwAttempts = 0;
function guard() {
  if (!throwing) return;
  throwAttempts += 1;
  throw new Error('keystore unavailable: errSecMissingEntitlement');
}
export async function getItemAsync(key) {
  counts.get += 1;
  guard();
  return store.get(key) ?? null;
}
export async function setItemAsync(key, value) {
  counts.set += 1;
  guard();
  store.set(key, value);
}
export async function deleteItemAsync(key) {
  counts.remove += 1;
  guard();
  store.delete(key);
}
export async function isAvailableAsync() { guard(); return true; }
export const WHEN_UNLOCKED_THIS_DEVICE_ONLY = 'WHEN_UNLOCKED_THIS_DEVICE_ONLY';
export const AFTER_FIRST_UNLOCK = 'AFTER_FIRST_UNLOCK';
export const WHEN_UNLOCKED = 'WHEN_UNLOCKED';
export function __counts() { return { ...counts }; }
export function __reset() {
  store.clear();
  counts.get = 0; counts.set = 0; counts.remove = 0;
  throwing = false; throwAttempts = 0;
}
export function __seed(entries) { for (const [key, value] of entries) store.set(key, value); }
export function __entries() { return [...store.entries()]; }
export function __failAll() { throwing = true; }
export function __failAttempts() { return throwAttempts; }
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
  /** Every call rejects from now on (an unsigned simulator Release build's keychain). */
  __failAll(): void;
  /** How many calls were rejected because the whole store was throwing. */
  __failAttempts(): number;
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

/** The device was not touched: no secure-store call at all, and the seeded real pairing survives. */
function assertUntouched(label: string): void {
  const counts = store.__counts();
  assert.ok(
    counts.remove === 0,
    `${label}: no secure-store delete was attempted (${JSON.stringify(counts)})`,
  );
  // Spec 032 amendment: demo mode has its own in-memory install id, so not even a read.
  assert.ok(
    counts.get === 0 && counts.set === 0,
    `${label}: demo mode made zero secure-store reads/writes (${JSON.stringify(counts)})`,
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

  // The simulator Release build this mode exists for: the Keychain answers every call with
  // errSecMissingEntitlement. Before the amendment that read happened in `pair()` and turned into
  // `client/bad-message` before any socket; the demo run must be unaffected.
  it('a Keychain that THROWS on every call still pairs, connects and reconnects', async () => {
    const code = pairCode('Q');
    const gateway = await FakeGateway.create({ pairingCodes: [code] });
    store.__failAll();
    const controller = demoController();
    try {
      await controller.start();
      assertUntouched('start, store throwing');
      await controller.unlock();
      const result = await controller.pair(pairingPayload(gateway, code));
      assert.equal(result.ok, true, `demo pair failed: ${result.ok ? '' : result.code}`);
      await waitFor(() => controller.snapshot().connection === 'ready', { label: 'demo socket ready' });
      assertUntouched('pair + connect, store throwing');
      gateway.dropAllConnections();
      await waitFor(() => controller.snapshot().connection !== 'ready', { label: 'drop noticed' });
      await controller.unlock();
      assertUntouched('reconnect, store throwing');
      // The store was never asked, so it never even had the chance to throw.
      assert.equal(store.__failAttempts(), 0, 'no secure-store call reached the throwing store');
    } finally {
      controller.stop();
      await gateway.close();
    }
  });

  // The other direction, unchanged by this amendment except for the CODE: outside demo mode the
  // install id still comes from the store, and a store failure there is typed
  // `client/store-unavailable` (spec 032 acceptance), not the generic `client/bad-message`.
  it('outside demo mode an unusable store during pair is client/store-unavailable', async () => {
    const code = pairCode('U');
    const gateway = await FakeGateway.create({ pairingCodes: [code] });
    const transport = demoTransportFactoryFactory();
    const controller = new AppController({ locale: () => 'en', transport, pairAckTimeoutMs: 20_000 });
    try {
      await controller.start();
      await controller.unlock();
      // The primed read is cached on success; clear it so pair()'s own read hits the store.
      installId.clearInstallIdCache();
      store.__failAll();
      const result = await controller.pair(pairingPayload(gateway, code));
      assert.equal(result.ok, false);
      if (!result.ok) assert.equal(result.code, 'client/store-unavailable');
      // Nothing reached the fixture: the failure is local, before any socket.
      assert.equal(gateway.connectionAttempts, 0);
    } finally {
      controller.stop();
      await gateway.close();
    }
  });
});

// ---------------------------------------------------------------------------
// Source guard: the demo path cannot reach `getInstallId` at all
// ---------------------------------------------------------------------------

describe('spec 032 source guard: demo mode never calls getInstallId', () => {
  const SRC = readFileSync(fileURLToPath(new URL('../src/app-state.ts', import.meta.url)), 'utf8');
  /** Comments talk about `getInstallId` on purpose; only CODE counts. */
  const CODE = SRC.replace(/\/\*[\s\S]*?\*\//g, '').replace(/\/\/.*$/gm, '');
  /** The body of one method (from its declaration to the next blank-line-then-method boundary). */
  function methodBody(name: string): string {
    const start = CODE.indexOf(name);
    assert.ok(start >= 0, `${name} must exist in app-state.ts`);
    return CODE.slice(start, start + 20_000);
  }

  it('pair() reads the install id through the demo id first, and getInstallId only as the fallback', () => {
    const body = methodBody('  async pair(');
    const line = 'const installId = this.demoInstallId ?? (await getInstallId());';
    assert.ok(body.includes(line), 'pair() must short-circuit the demo install id before getInstallId()');
    // A bare `await getInstallId()` (the pre-amendment call) would bypass the demo id entirely.
    assert.equal(/=\s*await getInstallId\(\)/.test(body), false, 'pair() must not await getInstallId() unconditionally');
  });

  it('primeInstallId() returns before getInstallId() when the demo id exists', () => {
    const start = CODE.indexOf('private primeInstallId(): void {');
    assert.ok(start >= 0, 'primeInstallId must exist');
    const body = CODE.slice(start, CODE.indexOf('private async', start) > 0 ? CODE.indexOf('private async', start) : start + 2_000);
    const demoGuard = body.indexOf('if (this.demoInstallId !== null) return;');
    const read = body.indexOf('getInstallId()');
    assert.ok(demoGuard >= 0, 'primeInstallId must skip the keychain in demo mode');
    assert.ok(demoGuard < read, 'the demo guard runs BEFORE getInstallId()');
  });

  it('the demo install id is created in the constructor and is in memory only', () => {
    assert.ok(CODE.includes('this.demoInstallId = createDemoInstallId();'), 'the constructor must create the demo id');
    assert.ok(CODE.includes('this.installId = this.demoInstallId;'), 'the outbox source must see it immediately');
    const DEMO_ID = readFileSync(fileURLToPath(new URL('../src/platform/demo-install-id.ts', import.meta.url)), 'utf8');
    // The file's header names the secure store on purpose; only its CODE may not reach it.
    const DEMO_ID_CODE = DEMO_ID.replace(/\/\*[\s\S]*?\*\//g, '').replace(/\/\/.*$/gm, '');
    assert.equal(
      /expo-secure-store|SecureStore/.test(DEMO_ID_CODE),
      false,
      'the demo install id must not import the secure store',
    );
  });
});
