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
