// Spec 026 (contract §15) — the pure part of web push: frame building and outcome mapping.
// The browser part (permission, PushManager) lives in `src/platform/web-push.web.ts`.

import {
  WEB_PUSH_SUBSCRIBE_TYPE,
  WEB_PUSH_UNSUBSCRIBE_TYPE,
  isWebPushEndpointAllowed,
} from '@dsh-ext/mobile-protocol';

export type WebPushOutcome = 'enabled' | 'disabled' | 'forbidden' | 'denied' | 'unsupported' | 'error';

/** The JSON shape of `PushSubscription.toJSON()` this module reads (nothing else is sent). */
export interface PushSubscriptionJson {
  endpoint?: unknown;
  keys?: { p256dh?: unknown; auth?: unknown } | null;
}

export type WebPushSend = (
  type: typeof WEB_PUSH_SUBSCRIBE_TYPE | typeof WEB_PUSH_UNSUBSCRIBE_TYPE,
  params: Record<string, unknown>,
) => Promise<Record<string, unknown>>;

/** Params of `push-subscribe`, or null when the subscription is unusable / off the allowlist. */
export function pushSubscribeParams(sub: PushSubscriptionJson): { endpoint: string; keys: { p256dh: string; auth: string } } | null {
  const endpoint = sub.endpoint;
  const p256dh = sub.keys?.p256dh;
  const auth = sub.keys?.auth;
  if (typeof endpoint !== 'string' || !isWebPushEndpointAllowed(endpoint)) return null;
  if (typeof p256dh !== 'string' || typeof auth !== 'string') return null;
  return { endpoint, keys: { p256dh, auth } };
}

/** Params of `push-unsubscribe` (an omitted endpoint drops every subscription of this device). */
export function pushUnsubscribeParams(endpoint: string | null): Record<string, unknown> {
  return endpoint !== null && isWebPushEndpointAllowed(endpoint) ? { endpoint } : {};
}

/** Map a refusal to an outcome: `op/forbidden` means the owner has web push disabled. */
export function webPushErrorOutcome(error: unknown): WebPushOutcome {
  const code = (error as { code?: unknown } | null)?.code;
  return code === 'op/forbidden' || code === 'auth/forbidden-scope' ? 'forbidden' : 'error';
}

/** Unpadded base64url → bytes (the VAPID public key for `applicationServerKey`). */
export function base64UrlToBytes(value: string): Uint8Array<ArrayBuffer> {
  const b64 = value.replace(/-/g, '+').replace(/_/g, '/');
  const padded = b64 + '='.repeat((4 - (b64.length % 4)) % 4);
  const binary = atob(padded);
  const out = new Uint8Array(new ArrayBuffer(binary.length));
  for (let i = 0; i < binary.length; i += 1) out[i] = binary.charCodeAt(i);
  return out;
}
