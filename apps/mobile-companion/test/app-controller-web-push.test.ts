// Controller-level smoke tests for the Spec 026 web-push surface, pinned BEFORE the AppController
// split (docs/arch-notes/split-plan-20261114.md, "Before step 3"). They exercise only the public
// facade (`webPush`, `webPushSend`, `forget`) plus the private `onRevoked` wipe path, so the split
// must keep each one reachable from `AppController`.
//
// `../src/platform/web-push` is replaced for this file only by a data-URL module that counts
// `dropLocalWebPush()` calls on `globalThis`, which makes the wipe path observable without
// touching src/.

import assert from 'node:assert/strict';
import { registerHooks } from 'node:module';
import { before, beforeEach, describe, it } from 'node:test';

import { resetAppState } from './support/stubs/react-native.stub';

const COUNTER = '__dshTestDropLocalWebPushCalls';
const WEB_PUSH_SOURCE = `
export function isWebPushSupported() { return false; }
export async function isWebPushSubscribed() { return false; }
export async function enableWebPush() { return 'unsupported'; }
export async function disableWebPush() { return 'unsupported'; }
export async function dropLocalWebPush() { globalThis.${COUNTER} = (globalThis.${COUNTER} ?? 0) + 1; }
`;
const WEB_PUSH_URL = `data:text/javascript;base64,${Buffer.from(WEB_PUSH_SOURCE, 'utf8').toString('base64')}`;

registerHooks({
  resolve(specifier, context, nextResolve) {
    if (/(^|\/)platform\/web-push$/.test(specifier) && (context.parentURL ?? '').includes('app-state')) {
      return { url: WEB_PUSH_URL, shortCircuit: true };
    }
    return nextResolve(specifier, context);
  },
});

let AppController: typeof import('../src/app-state').AppController;
type Controller = InstanceType<typeof AppController>;

before(async () => {
  ({ AppController } = await import('../src/app-state'));
});

const drops = (): number => ((globalThis as Record<string, unknown>)[COUNTER] as number | undefined) ?? 0;

interface Sent { type: string; params: Record<string, unknown> }

function fakeClient(state: string, webPush: unknown, sent: Sent[] = []): unknown {
  return {
    state,
    webPush,
    hello: null,
    close: () => {},
    stop: () => {},
    on: () => () => {},
    off: () => {},
    webPushRequest: async (type: string, params: Record<string, unknown>) => {
      sent.push({ type, params });
      return { ok: true };
    },
  };
}

function controllerWith(client: unknown, webLocked = false): Controller {
  const controller = new AppController({ locale: () => 'en' });
  // Test-only reach-in (listed in the split plan's private-access inventory).
  (controller as unknown as { client: unknown }).client = client;
  (controller as unknown as { webLocked: boolean }).webLocked = webLocked;
  return controller;
}

const OFFER = { enabled: true, vapidPublicKey: 'BTestKey' };

describe('AppController web push (Spec 026, controller level)', () => {
  beforeEach(() => resetAppState('active'));

  it('webPush reflects hello.webPush of a ready, unlocked socket', () => {
    const c = controllerWith(fakeClient('ready', OFFER));
    try {
      assert.deepEqual(c.webPush, OFFER);
    } finally {
      c.stop();
    }
    const off = controllerWith(fakeClient('ready', { enabled: false, vapidPublicKey: 'BTestKey' }));
    try {
      assert.deepEqual(off.webPush, { enabled: false, vapidPublicKey: 'BTestKey' });
    } finally {
      off.stop();
    }
  });

  it('webPush is null with no client, a non-ready socket, a locked socket, or no offer', () => {
    const none = new AppController({ locale: () => 'en' });
    const cases: Controller[] = [
      none,
      controllerWith(fakeClient('connecting', OFFER)),
      controllerWith(fakeClient('ready', OFFER), true),
      controllerWith(fakeClient('ready', null)),
    ];
    try {
      for (const c of cases) assert.equal(c.webPush, null);
    } finally {
      for (const c of cases) c.stop();
    }
  });

  it('webPushSend forwards only while ready + unlocked', async () => {
    const sent: Sent[] = [];
    const c = controllerWith(fakeClient('ready', OFFER, sent));
    try {
      assert.deepEqual(await c.webPushSend('push-subscribe', { endpoint: 'https://e' }), { ok: true });
      await c.webPushSend('push-unsubscribe', {});
      assert.deepEqual(sent.map((s) => s.type), ['push-subscribe', 'push-unsubscribe']);
    } finally {
      c.stop();
    }
  });

  it('webPushSend refuses with client/disconnected when not ready, locked, or without a client', async () => {
    const sent: Sent[] = [];
    const cases: Controller[] = [
      new AppController({ locale: () => 'en' }),
      controllerWith(fakeClient('connecting', OFFER, sent)),
      controllerWith(fakeClient('ready', OFFER, sent), true),
    ];
    try {
      for (const c of cases) {
        await assert.rejects(c.webPushSend('push-subscribe', {}), (e: { code?: string }) => e.code === 'client/disconnected');
      }
      assert.equal(sent.length, 0, 'nothing reached the socket');
    } finally {
      for (const c of cases) c.stop();
    }
  });

  it('webPushSend only sends the push frames it is given (type passes through verbatim)', async () => {
    const sent: Sent[] = [];
    const c = controllerWith(fakeClient('ready', OFFER, sent));
    try {
      await c.webPushSend('push-unsubscribe', { endpoint: 'x' });
      assert.deepEqual(sent, [{ type: 'push-unsubscribe', params: { endpoint: 'x' } }]);
    } finally {
      c.stop();
    }
  });

  it('forget() drops the local web-push subscription', async () => {
    const c = new AppController({ locale: () => 'en' });
    const before = drops();
    try {
      await c.forget();
      assert.equal(drops(), before + 1);
    } finally {
      c.stop();
    }
  });

  it('a revocation drops the local web-push subscription', async () => {
    const c = new AppController({ locale: () => 'en' });
    const before = drops();
    try {
      await (c as unknown as { onRevoked(client: unknown): Promise<void> }).onRevoked(null);
      assert.equal(drops(), before + 1);
    } finally {
      c.stop();
    }
  });
});
