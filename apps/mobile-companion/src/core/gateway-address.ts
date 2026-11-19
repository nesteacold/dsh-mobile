// The gateway address the WEB (PWA) build uses when the page is served from the same
// tailnet-only HTTPS origin that also routes the gateway WebSocket (spec 020 §Port, owner
// decision 2026-11-13).
//
// WHY THIS EXISTS: a pairing QR carries the address the Host advertises, which is the gateway's
// own `wss://<tailnet ip>:30081` listener — self-signed on purpose, so the browser refuses it
// before a single frame moves (the native app pins it; a browser cannot pin and will not trust
// it). When the page itself is served over the tailnet certificate at
// `https://<tailnet-host>:<port>`, the same proxy (`tailscale serve`) already routes
// `/ws/mobile` to that listener, so the honest address is the page's OWN origin:
// `wss://<location.host>/ws/mobile`. Same hostname ⇒ same certificate ⇒ the browser trusts it,
// and the gateway sees one clearly-proxied request instead of a remote tailnet peer.
//
// Pure: no react-native/expo/Node imports, and no global reads — the caller passes the location.
// That keeps it unit-testable in Node and inert on native (where there is no location at all).

import type { PairingPayload } from './protocol';

/** The gateway's WebSocket path, and the path `tailscale serve` routes to it. */
export const GATEWAY_WS_PATH = '/ws/mobile';

/** The parts of `window.location` this module reads. */
export interface WebLocation {
  /** `'https:'` on the tailnet origin; anything else is not a proxy target. */
  protocol: string;
  /** `host` — hostname AND port, exactly as the browser writes it. */
  host: string;
}

/**
 * The same-origin gateway URL, or `null` when this page is not served from a tailnet HTTPS
 * origin.
 *
 * The `*.ts.net` test is not decoration: the web transport refuses every other hostname
 * (`isTailnetUrl` in `src/platform/pinned-transport.web.ts`), and a proxy that is not Tailscale
 * presents a certificate nothing pins. Requiring the suffix here means the address this function
 * proposes is always one the transport will accept — never a URL the app then rejects.
 */
export function sameOriginGatewayUrl(location: WebLocation | null | undefined): string | null {
  if (location === null || location === undefined) return null;
  if (location.protocol !== 'https:') return null;
  const host = typeof location.host === 'string' ? location.host.trim() : '';
  if (host === '') return null;
  // `host` may carry a port; the hostname part is what must be a tailnet name.
  const hostname = host.replace(/:\d+$/, '').toLowerCase();
  if (hostname === 'ts.net' || !hostname.endsWith('.ts.net')) return null;
  return `wss://${host}${GATEWAY_WS_PATH}`;
}

/** Why the page's own origin is not a gateway target (spec 031 §8's unsupported-host guidance). */
export type WebOriginRefusal = 'insecure' | 'not-tailnet';

/**
 * The address a one-time-code pairing dials, and the OTP form's state for this platform.
 *
 * Spec 031 §8: the browser shows its current origin and never accepts an address override it would
 * then ignore. On a supported origin there is no typed address at all — `sameOrigin` is the only
 * one used, whatever a link or a scan carried. On an unsupported origin the flow is refused (`null`)
 * with the reason, so the screen can say why instead of pretending a code could pair.
 */
export type OtpAddressPlan =
  | { kind: 'unsupported'; reason: WebOriginRefusal }
  // Not a page: the form is typeable, but a phone cannot prove a code (no certificate in it).
  | { kind: 'native' }
  // A page whose origin is the gateway's: fixed address, no typed field.
  | { kind: 'same-origin'; url: string; origin: string };

export function planOtpAddress(location: WebLocation | null | undefined): OtpAddressPlan {
  if (location === null || location === undefined) return { kind: 'native' };
  const url = sameOriginGatewayUrl(location);
  if (url === null) {
    return { kind: 'unsupported', reason: location.protocol !== 'https:' ? 'insecure' : 'not-tailnet' };
  }
  // The origin the page was served from, exactly as the browser writes it (`location.host`).
  return { kind: 'same-origin', url, origin: `https://${location.host.trim()}` };
}

/**
 * What one submit of the pair screen may do, decided BEFORE any controller or socket exists.
 *
 * Spec 031 §8: a page that is not the gateway's own tailnet HTTPS origin has no verified route, so
 * NEITHER form may dial from it — the 8-digit code or a QR/long string would just be a socket the
 * browser refuses (or worse, the self-signed listener the QR carries). `link` says the input was a
 * recognized `/pair#a=…&c=…` link: the web pairs with its code only, never its address, and a
 * phone explains it, because a code carries no certificate to pin. A phone's code or QR is refused
 * for that same reason (see `createPinnedTransport`); its QR / long string keeps its own pin.
 */
export function planPairSubmit(
  plan: OtpAddressPlan,
  onWeb: boolean,
  link: boolean,
): { kind: 'blocked'; reason: 'insecure' | 'not-tailnet' | 'otpNative' | 'otpLinkNative' } | { kind: 'otp'; url: string; origin: string } | { kind: 'qr' } {
  // A plan exists only for a page, so `unsupported` is a web page without a verified route.
  if (plan.kind === 'unsupported') return { kind: 'blocked', reason: plan.reason };
  // The browser pairs through the page's own origin: the code form, and a link that only fills it.
  if (onWeb) {
    if (plan.kind !== 'same-origin') return { kind: 'blocked', reason: 'otpNative' };
    return { kind: 'otp', url: plan.url, origin: plan.origin };
  }
  if (link) return { kind: 'blocked', reason: 'otpLinkNative' };
  return plan.kind === 'native' ? { kind: 'qr' } : { kind: 'blocked', reason: 'otpNative' };
}

/**
 * Spec 054 — the NATIVE one-time-code submit. The Host's pairing link carries `host:port` in `a`
 * and its certificate fingerprint in `p`; BOTH are required before any socket is opened. The pin is
 * never logged: only the wss URL and gateway name reach the controller.
 */
export function planNativeOtpSubmit(
  address: string,
  pin: string | undefined,
): { kind: 'otp'; url: string; origin: string; pin: string } | { kind: 'blocked'; reason: 'address-required' | 'pin-required' | 'bad-address' } {
  const host = typeof address === 'string' ? address.trim() : '';
  // No scheme/path/query/userinfo/backslash; an OPTIONAL port is the only decoration allowed.
  if (host === '' || /[\s/?#@\\]/.test(host)) return { kind: 'blocked', reason: 'bad-address' };
  const hostPart = host.replace(/:\d+$/, '');
  if (hostPart === '' || /[^A-Za-z0-9.-]/.test(hostPart)) return { kind: 'blocked', reason: 'bad-address' };
  const port = host.slice(hostPart.length);
  if (port !== '' && (!/^:\d+$/.test(port) || Number(port.slice(1)) > 65_535 || Number(port.slice(1)) < 1)) {
    return { kind: 'blocked', reason: 'bad-address' };
  }
  if (typeof pin !== 'string' || !/^[0-9a-f]{64}$/.test(pin)) return { kind: 'blocked', reason: 'pin-required' };
  return { kind: 'otp', url: `wss://${host}${GATEWAY_WS_PATH}`, origin: host, pin };
}

/**
 * Rewrite a pairing payload so the web build connects through the origin it was served from.
 *
 * `publicUrl` becomes the same-origin address (that is the one the app stores and reconnects to),
 * and it is placed FIRST in `endpoints` — the list is a preference order. Every other endpoint is
 * kept: they still describe the Host, and a native install reading the same payload needs the
 * pinned address. A payload for another tailnet, an `http://` page or the native platform is
 * returned untouched, so nothing about the existing behaviour moves.
 */
export function withSameOriginEndpoint<T extends Pick<PairingPayload, 'publicUrl' | 'endpoints'>>(
  payload: T,
  location: WebLocation | null | undefined,
): T {
  const sameOrigin = sameOriginGatewayUrl(location);
  if (sameOrigin === null || payload.publicUrl === sameOrigin) return payload;
  const endpoints = [sameOrigin, ...payload.endpoints.filter((endpoint) => endpoint !== sameOrigin)];
  return { ...payload, publicUrl: sameOrigin, endpoints };
}
