// dropLocalWebPush: wipe paths drop the browser subscription locally, never send, swallow errors.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';

const g = globalThis as Record<string, unknown>;

function install(opts: { sub: { unsubscribe: () => Promise<boolean> } | null; getSubThrows?: boolean; regThrows?: boolean }) {
  const calls: string[] = [];
  Object.defineProperty(g, 'navigator', {
    configurable: true,
    value: {
      serviceWorker: {
        getRegistration: async () => {
          calls.push('getRegistration');
          if (opts.regThrows) throw new Error('boom');
          return {
            pushManager: {
              getSubscription: async () => {
                calls.push('getSubscription');
                if (opts.getSubThrows) throw new Error('boom');
                return opts.sub;
              },
            },
          };
        },
      },
    },
  });
  g.window = { PushManager: {}, Notification: {} };
  return calls;
}

import * as web from '../src/platform/web-push.web';
import * as native from '../src/platform/web-push';

test('web: unsubscribes an existing subscription', async () => {
  let unsubscribed = 0;
  const calls = install({ sub: { unsubscribe: async () => { unsubscribed++; return true; } } });
  await web.dropLocalWebPush();
  assert.equal(unsubscribed, 1);
  assert.deepEqual(calls, ['getRegistration', 'getSubscription']);
});

test('web: no subscription is a no-op', async () => {
  install({ sub: null });
  await web.dropLocalWebPush();
});

test('web: swallows errors from every step', async () => {
  install({ sub: null, regThrows: true });
  await web.dropLocalWebPush();
  install({ sub: null, getSubThrows: true });
  await web.dropLocalWebPush();
  install({ sub: { unsubscribe: async () => { throw new Error('boom'); } } });
  await web.dropLocalWebPush();
});

test('native: no-op', async () => {
  assert.equal(await native.dropLocalWebPush(), undefined);
});

test('drop never takes a send callback; both wipe paths call it after clearNotifications', () => {
  assert.equal(web.dropLocalWebPush.length, 0);
  const src = readFileSync('src/app-state.ts', 'utf8');
  const hits = src.match(/await clearNotifications\(\);\s*\} catch \{[^}]*\}\s*await dropLocalWebPush\(\);/g) ?? [];
  assert.equal(hits.length, 2);
});
