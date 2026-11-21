// Spec 062 — keep-awake gate and adapters.

import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { describe, it } from 'node:test';
import { fileURLToPath } from 'node:url';

import { shouldKeepAwake } from '../src/core/keep-awake';
import { createKeepAwakeAdapter, KEEP_AWAKE_TAG } from '../src/platform/keep-awake';
import { createWebKeepAwakeAdapter } from '../src/platform/keep-awake.web';
import {
  DEFAULT_KEEP_AWAKE,
  loadKeepAwakePreference,
  normalizeKeepAwake,
  saveKeepAwakePreference,
  subscribeKeepAwakePreference,
} from '../src/ui/keep-awake-preference';
import {
  KEEP_AWAKE_KEY as WEB_KEEP_AWAKE_KEY,
  loadKeepAwakePreference as loadWebKeepAwakePreference,
  saveKeepAwakePreference as saveWebKeepAwakePreference,
  subscribeKeepAwakePreference as subscribeWebKeepAwakePreference,
} from '../src/ui/keep-awake-preference.web';
import { resetSecureStore, secureStoreEntries } from './support/stubs/expo-secure-store.stub';

const LAYOUT_SOURCE = readFileSync(fileURLToPath(new URL('../app/_layout.tsx', import.meta.url)), 'utf8');

const base = () => ({
  enabled: true,
  gateUnlocked: true,
  foreground: true,
  connection: 'ready',
  sessions: [{ state: 'running' }],
});

describe('shouldKeepAwake', () => {
  it('holds only for a live, unlocked, foreground app with a running session', () => {
    assert.equal(shouldKeepAwake(base()), true);
  });

  it('refuses every stale or unsafe condition', () => {
    const cases = [
      { ...base(), enabled: false },
      { ...base(), gateUnlocked: false },
      { ...base(), foreground: false },
      { ...base(), connection: 'connecting' },
      { ...base(), connection: 'idle' },
      { ...base(), sessions: [{ state: 'idle' }] },
      { ...base(), sessions: [] },
    ];
    for (const input of cases) assert.equal(shouldKeepAwake(input), false, JSON.stringify(input));
  });

  it('does not treat a needs-decision badge as running', () => {
    assert.equal(shouldKeepAwake({ ...base(), sessions: [{ state: 'idle' }] }), false);
  });
});

describe('keep-awake preference', () => {
  it('normalizes stored values and defaults safely', () => {
    for (const value of [true, 'true', 'TRUE', '1', 'on']) assert.equal(normalizeKeepAwake(value), true);
    for (const value of [false, 'false', 'FALSE', '0', 'off']) assert.equal(normalizeKeepAwake(value), false);
    for (const value of [undefined, null, '', 'maybe', 1, {}, []]) {
      assert.equal(normalizeKeepAwake(value), DEFAULT_KEEP_AWAKE, String(value));
    }
  });

  it('persists and restores through the native store', async () => {
    resetSecureStore();
    await saveKeepAwakePreference(false);
    assert.deepEqual(secureStoreEntries().find(([key]) => key === 'ui.keepAwakeWhileRunning'), ['ui.keepAwakeWhileRunning', 'false']);
    assert.equal(await loadKeepAwakePreference(), false);
    await saveKeepAwakePreference(true);
    assert.equal(await loadKeepAwakePreference(), true);
  });

  it('notifies mounted consumers immediately on save, native and web', async () => {
    resetSecureStore();
    const native: boolean[] = [];
    const offNative = subscribeKeepAwakePreference((on) => native.push(on));
    await saveKeepAwakePreference(false);
    assert.deepEqual(native, [false]);
    offNative();
    await saveKeepAwakePreference(true);
    assert.deepEqual(native, [false], 'unsubscribed listener must not be called');

    const web: boolean[] = [];
    const offWeb = subscribeWebKeepAwakePreference((on) => web.push(on));
    await saveWebKeepAwakePreference(false);
    assert.deepEqual(web, [false]);
    offWeb();
  });

  it('web store persists to localStorage and falls back safely when it throws', async () => {
    const original = Object.getOwnPropertyDescriptor(globalThis, 'localStorage');
    const values = new Map<string, string>();
    Object.defineProperty(globalThis, 'localStorage', {
      configurable: true,
      value: {
        getItem: (key: string) => values.get(key) ?? null,
        setItem: (key: string, value: string) => { values.set(key, value); },
      },
    });
    try {
      await saveWebKeepAwakePreference(false);
      assert.equal(values.get(WEB_KEEP_AWAKE_KEY), 'false');
      assert.equal(await loadWebKeepAwakePreference(), false);
    } finally {
      if (original) Object.defineProperty(globalThis, 'localStorage', original);
      else delete (globalThis as Record<string, unknown>).localStorage;
    }

    Object.defineProperty(globalThis, 'localStorage', {
      configurable: true,
      value: {
        getItem() { throw new Error('blocked'); },
        setItem() { throw new Error('blocked'); },
      },
    });
    try {
      assert.equal(await loadWebKeepAwakePreference(), DEFAULT_KEEP_AWAKE);
      await saveWebKeepAwakePreference(false); // must not throw
    } finally {
      if (original) Object.defineProperty(globalThis, 'localStorage', original);
      else delete (globalThis as Record<string, unknown>).localStorage;
    }
  });

  it('the root bridge subscribes to live preference changes and waits for the stored value', () => {
    assert.match(LAYOUT_SOURCE, /subscribeKeepAwakePreference/);
    assert.match(LAYOUT_SOURCE, /useState<boolean \| null>\(null\)/);
    assert.match(LAYOUT_SOURCE, /if \(enabled === null\) return/);
  });
});

describe('native keep-awake adapter', () => {
  it('activates once and deactivates once for the same tag', async () => {
    const calls: string[] = [];
    const adapter = createKeepAwakeAdapter({
      activate: async (tag) => { calls.push(`activate:${tag}`); },
      deactivate: async (tag) => { calls.push(`deactivate:${tag}`); },
    });
    await adapter.activate();
    await adapter.activate();
    await adapter.deactivate();
    await adapter.deactivate();
    assert.deepEqual(calls, [`activate:${KEEP_AWAKE_TAG}`, `deactivate:${KEEP_AWAKE_TAG}`]);
  });

  it('does not keep an active claim after a failed deactivate', async () => {
    const calls: string[] = [];
    const adapter = createKeepAwakeAdapter({
      activate: async () => { calls.push('activate'); },
      deactivate: async () => { calls.push('deactivate'); throw new Error('AppContextLost'); },
    });
    await adapter.activate();
    await adapter.deactivate();
    await adapter.activate();
    assert.deepEqual(calls, ['activate', 'deactivate', 'deactivate', 'activate'], 'failed deactivate is cleared before the next activate');
  });

  it('does not keep an active claim after a failed activate', async () => {
    let attempts = 0;
    const adapter = createKeepAwakeAdapter({
      activate: async () => { attempts += 1; throw new Error('unsupported'); },
      deactivate: async () => {},
    });
    await adapter.activate();
    await adapter.activate();
    assert.equal(attempts, 2, 'a failed activation must be retryable on the next transition');
  });
});

describe('web keep-awake adapter', () => {
  it('requests, releases, and re-acquires on visibility without duplicate locks', async () => {
    const docListeners = new Map<string, Array<() => void>>();
    let requests = 0;
    let releases = 0;
    const wakeLock = {
      request: async () => {
        requests += 1;
        let released = false;
        return {
          get released() { return released; },
          release() { released = true; releases += 1; },
          addEventListener() {},
          removeEventListener() {},
        };
      },
    };
    const doc = {
      visibilityState: 'visible',
      addEventListener(type: string, listener: () => void) { docListeners.set(type, [...(docListeners.get(type) ?? []), listener]); },
      removeEventListener() {},
    };
    const adapter = createWebKeepAwakeAdapter({ wakeLock, doc, win: null });

    await adapter.activate();
    await adapter.activate();
    assert.equal(requests, 1);

    const fireVisibility = (): void => docListeners.get('visibilitychange')?.forEach((listener) => listener());
    const settle = (): Promise<void> => new Promise((resolve) => setImmediate(resolve));

    doc.visibilityState = 'hidden';
    fireVisibility();
    await settle();
    assert.equal(releases, 1);

    doc.visibilityState = 'visible';
    fireVisibility();
    await settle();
    assert.equal(requests, 2);

    await adapter.deactivate();
    assert.equal(releases, 2);
  });

  it('is a silent no-op when the browser has no wake lock', async () => {
    const adapter = createWebKeepAwakeAdapter({ wakeLock: null, doc: null, win: null });
    await adapter.activate();
    await adapter.deactivate();
  });

  it('releases on pagehide and stays released on a later visible event', async () => {
    let requests = 0;
    let releases = 0;
    const winListeners = new Map<string, Array<() => void>>();
    const docListeners = new Map<string, Array<() => void>>();
    const wakeLock = {
      request: async () => {
        requests += 1;
        let released = false;
        return {
          get released() { return released; },
          release() { released = true; releases += 1; },
          addEventListener() {},
          removeEventListener() {},
        };
      },
    };
    const adapter = createWebKeepAwakeAdapter({
      wakeLock,
      doc: {
        visibilityState: 'visible',
        addEventListener(type: string, l: () => void) { docListeners.set(type, [...(docListeners.get(type) ?? []), l]); },
        removeEventListener() {},
      },
      win: {
        addEventListener(type: string, l: () => void) { winListeners.set(type, [...(winListeners.get(type) ?? []), l]); },
        removeEventListener() {},
      },
    });
    await adapter.activate();
    winListeners.get('pagehide')?.forEach((l) => l());
    await new Promise((resolve) => setImmediate(resolve));
    assert.equal(releases, 1);
    docListeners.get('visibilitychange')?.forEach((l) => l());
    await new Promise((resolve) => setImmediate(resolve));
    assert.equal(requests, 1, 'pagehide permanently deactivates until the app asks again');
  });

  it('swallows a rejected request and releases a sentinel that resolves after deactivate', async () => {
    const rejected = createWebKeepAwakeAdapter({
      wakeLock: { request: async () => { throw new Error('denied'); } },
      doc: null,
      win: null,
    });
    await rejected.activate();
    await rejected.deactivate();

    let releases = 0;
    type LateSentinel = {
      released: boolean;
      release: () => void;
      addEventListener: () => void;
      removeEventListener: () => void;
    };
    const hooks: { resolve: ((sentinel: LateSentinel) => void) | null } = { resolve: null };
    const late = createWebKeepAwakeAdapter({
      wakeLock: { request: async () => new Promise<LateSentinel>((resolve) => { hooks.resolve = resolve; }) },
      doc: { visibilityState: 'visible', addEventListener() {}, removeEventListener() {} },
      win: null,
    });
    const activating = late.activate();
    await new Promise((resolve) => setImmediate(resolve)); // let the queued acquire call request()
    assert.ok(hooks.resolve, 'the deferred request must have started');
    const deactivating = late.deactivate();
    hooks.resolve({
      released: false,
      release() { releases += 1; },
      addEventListener() {},
      removeEventListener() {},
    });
    await Promise.all([activating, deactivating]);
    assert.equal(releases, 1, 'a late sentinel must be released, never retained');
  });
});
