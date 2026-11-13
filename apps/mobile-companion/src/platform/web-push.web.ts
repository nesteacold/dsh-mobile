// Spec 026 — Web Push, WEB (PWA). Permission is requested only from `enableWebPush`, which the
// Settings toggle calls from its press handler (a user gesture, R6). Only the endpoint and the two
// subscription keys ever leave the page; the notification text lives in `public/sw.js`.

import {
  base64UrlToBytes,
  pushSubscribeParams,
  pushUnsubscribeParams,
  webPushErrorOutcome,
  type WebPushOutcome,
  type WebPushSend,
} from '../core/web-push';

export function isWebPushSupported(): boolean {
  return typeof navigator !== 'undefined' && 'serviceWorker' in navigator
    && typeof window !== 'undefined' && 'PushManager' in window && 'Notification' in window;
}

async function registration(): Promise<ServiceWorkerRegistration | null> {
  if (!isWebPushSupported()) return null;
  try {
    return (await navigator.serviceWorker.getRegistration()) ?? null;
  } catch {
    return null;
  }
}

export async function isWebPushSubscribed(): Promise<boolean> {
  const reg = await registration();
  if (reg === null) return false;
  try {
    return (await reg.pushManager.getSubscription()) !== null;
  } catch {
    return false;
  }
}

export async function enableWebPush(vapidPublicKey: string, send: WebPushSend): Promise<WebPushOutcome> {
  const reg = await registration();
  if (reg === null) return 'unsupported';
  const permission = await Notification.requestPermission();
  if (permission !== 'granted') return 'denied';
  let sub: PushSubscription;
  try {
    sub = (await reg.pushManager.getSubscription())
      ?? await reg.pushManager.subscribe({ userVisibleOnly: true, applicationServerKey: base64UrlToBytes(vapidPublicKey) });
  } catch {
    return 'error';
  }
  const params = pushSubscribeParams(sub.toJSON());
  if (params === null) {
    await sub.unsubscribe().catch(() => undefined);
    return 'error';
  }
  try {
    await send('push-subscribe', params);
    return 'enabled';
  } catch (error) {
    // The Host refused (e.g. owner disabled web push): do not keep a browser subscription it ignores.
    await sub.unsubscribe().catch(() => undefined);
    return webPushErrorOutcome(error);
  }
}

/**
 * Wipe paths (forget / revoked): drop the browser's push subscription locally so the endpoint is not
 * reused by a later pairing. Never sends a frame (the pairing is gone); every error is swallowed.
 */
export async function dropLocalWebPush(): Promise<void> {
  try {
    const reg = await registration();
    if (reg === null) return;
    const sub = await reg.pushManager.getSubscription();
    if (sub !== null) await sub.unsubscribe();
  } catch {
    // best effort
  }
}

export async function disableWebPush(send: WebPushSend): Promise<WebPushOutcome> {
  const reg = await registration();
  if (reg === null) return 'unsupported';
  const sub = await reg.pushManager.getSubscription().catch(() => null);
  let outcome: WebPushOutcome = 'disabled';
  try {
    await send('push-unsubscribe', pushUnsubscribeParams(sub?.endpoint ?? null));
  } catch (error) {
    // Still drop it locally: a disabled Host sends nothing anyway.
    outcome = webPushErrorOutcome(error) === 'forbidden' ? 'disabled' : 'error';
  }
  if (sub !== null) await sub.unsubscribe().catch(() => undefined);
  return outcome;
}
