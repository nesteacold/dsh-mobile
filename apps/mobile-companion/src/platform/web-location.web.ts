// Web (PWA) `readWebLocation`: the page's own origin, which is where the gateway WebSocket is
// routed (`/ws/mobile`) when the PWA is served from the tailnet HTTPS origin. See
// `src/core/gateway-address.ts` for why that origin, and not the QR's listener, is the address a
// browser must use.
//
// Only the two fields the derivation needs are returned: the full `Location` would spread the
// page's query string and history into app state that reaches logs and support screens.
//
// A non-browser host (a Node test importing this file by accident, or a prerender) gets `null`,
// never a throw.

import type { WebLocation } from '../core/gateway-address';

export function readWebLocation(): WebLocation | null {
  if (typeof window === 'undefined') return null;
  const location = window.location;
  if (location === undefined || location === null) return null;
  return { protocol: location.protocol, host: location.host };
}
