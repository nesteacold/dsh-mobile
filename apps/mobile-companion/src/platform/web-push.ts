// Spec 026 — Web Push, NATIVE: a deliberate no-op. Web push is a PWA feature (R7: native apps are
// unchanged; they keep their own notification path). Metro picks `web-push.web.ts` on web, so shared
// code calls these unconditionally and a native build draws no toggle (`isWebPushSupported` false).

import type { WebPushOutcome, WebPushSend } from '../core/web-push';

export function isWebPushSupported(): boolean {
  return false;
}

export async function isWebPushSubscribed(): Promise<boolean> {
  return false;
}

export async function enableWebPush(_vapidPublicKey: string, _send: WebPushSend): Promise<WebPushOutcome> {
  return 'unsupported';
}

/** Wipe paths (forget / revoked): nothing to drop natively. Never sends frames. */
export async function dropLocalWebPush(): Promise<void> {
  return;
}

export async function disableWebPush(_send: WebPushSend): Promise<WebPushOutcome> {
  return 'unsupported';
}
