// Native (iOS/Android) `readWebLocation`: there is no page and no origin, so there is never a
// same-origin gateway address to derive. Metro picks the `.web.ts` sibling on the web platform,
// which reads the real `window.location`.
//
// Returning `null` is what keeps the native path byte-for-byte what it was: `pair()` then connects
// to the QR's `publicUrl` — the pinned, self-signed listener — and nothing in this file can widen
// where a phone dials.

import type { WebLocation } from '../core/gateway-address';

export function readWebLocation(): WebLocation | null {
  return null;
}
