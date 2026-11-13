// Spec 026 — app half: subscribe/unsubscribe frame params, forbidden mapping, and the service
// worker's push / notificationclick handlers (fixed text, ids only, click routes to the session).

import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import vm from 'node:vm';
import { describe, it } from 'node:test';

import {
  base64UrlToBytes,
  pushSubscribeParams,
  pushUnsubscribeParams,
  webPushErrorOutcome,
} from '../src/core/web-push';
import { CompanionClient } from '../src/core/client';

const SW = readFileSync(path.resolve(import.meta.dirname, '..', 'public', 'sw.js'), 'utf8');
const FCM = 'https://fcm.googleapis.com/fcm/send/abc';

function loadWorker(language = 'en') {
  const listeners: Record<string, (event: any) => void> = {};
  const shown: Array<{ title: string; options: any }> = [];
  const opened: string[] = [];
  const navigated: string[] = [];
  const windows: any[] = [];
  const self: any = {
    location: { origin: 'https://pwa.example' },
    navigator: { language },
    addEventListener: (name: string, fn: (event: any) => void) => { listeners[name] = fn; },
    registration: { showNotification: async (title: string, options: any) => { shown.push({ title, options }); } },
    clients: {
      matchAll: async () => windows,
      openWindow: async (url: string) => { opened.push(url); },
    },
  };
  vm.runInNewContext(SW, { self, URL, caches: {}, fetch: () => Promise.reject(new Error('no')) });
  const fire = async (name: string, event: any) => {
    let pending: Promise<unknown> = Promise.resolve();
    listeners[name]!({ ...event, waitUntil: (p: Promise<unknown>) => { pending = p; } });
    await pending;
  };
  return { fire, shown, opened, navigated, windows };
}

const data = (value: unknown) => ({ json: () => value });

describe('web push frames (spec 026)', () => {
  it('push-subscribe carries only endpoint + keys, and refuses a non-allowlisted endpoint', () => {
    assert.deepEqual(pushSubscribeParams({ endpoint: FCM, keys: { p256dh: 'P', auth: 'A' } }),
      { endpoint: FCM, keys: { p256dh: 'P', auth: 'A' } });
    assert.equal(pushSubscribeParams({ endpoint: 'https://evil.example/x', keys: { p256dh: 'P', auth: 'A' } }), null);
    assert.equal(pushSubscribeParams({ endpoint: FCM, keys: null }), null);
  });

  it('push-unsubscribe names the endpoint or omits it', () => {
    assert.deepEqual(pushUnsubscribeParams(FCM), { endpoint: FCM });
    assert.deepEqual(pushUnsubscribeParams(null), {});
  });

  it('op/forbidden (owner disabled) maps to forbidden', () => {
    assert.equal(webPushErrorOutcome({ code: 'op/forbidden' }), 'forbidden');
    assert.equal(webPushErrorOutcome({ code: 'client/disconnected' }), 'error');
  });

  it('decodes the VAPID key', () => {
    assert.deepEqual([...base64UrlToBytes('AQID_-8')], [1, 2, 3, 255, 239]);
  });

  it('the client only sends the two web push frames through webPushRequest', async () => {
    const proto = CompanionClient.prototype as any;
    await assert.rejects(proto.webPushRequest.call({}, 'list-sessions', {}), { code: 'op/forbidden' });
  });
});

describe('service worker push handlers (spec 026 R6)', () => {
  it('shows fixed localized text and never payload content', async () => {
    const w = loadWorker('en');
    await w.fire('push', { data: data({ v: 1, kind: 'approval', sessionId: 's1', requestId: 'r1', prompt: 'SECRET' }) });
    assert.equal(w.shown.length, 1);
    assert.equal(w.shown[0]!.title, 'DSH: approval needed');
    assert.equal(JSON.stringify(w.shown[0]).includes('SECRET'), false);
    assert.equal(w.shown[0]!.options.data.url, '/session/s1');
    const vi = loadWorker('vi-VN');
    await vi.fire('push', { data: data({ v: 1, kind: 'question', sessionId: 's2' }) });
    assert.equal(vi.shown[0]!.title, 'DSH: có câu hỏi');
  });

  it('shows nothing for an unknown version, kind or malformed id', async () => {
    const w = loadWorker();
    await w.fire('push', { data: data({ v: 2, kind: 'approval', sessionId: 's1' }) });
    await w.fire('push', { data: data({ v: 1, kind: 'chat', sessionId: 's1' }) });
    await w.fire('push', { data: data({ v: 1, kind: 'approval', sessionId: '../x' }) });
    await w.fire('push', { data: null });
    assert.equal(w.shown.length, 0);
  });

  it('click opens /session/<id>, or focuses and navigates an open window', async () => {
    const w = loadWorker();
    let closed = false;
    await w.fire('notificationclick', { notification: { data: { url: '/session/s1' }, close: () => { closed = true; } } });
    assert.ok(closed);
    assert.deepEqual(w.opened, ['/session/s1']);
    const nav: string[] = [];
    let focused = false;
    w.windows.push({ url: 'https://pwa.example/', focus: async () => { focused = true; }, navigate: async (u: string) => { nav.push(u); } });
    await w.fire('notificationclick', { notification: { data: { url: '/session/s9' }, close: () => undefined } });
    assert.ok(focused);
    assert.deepEqual(nav, ['/session/s9']);
  });

  it('click with a foreign url falls back to the app root', async () => {
    const w = loadWorker();
    await w.fire('notificationclick', { notification: { data: { url: 'https://evil.example/' }, close: () => undefined } });
    assert.deepEqual(w.opened, ['/']);
  });
});
