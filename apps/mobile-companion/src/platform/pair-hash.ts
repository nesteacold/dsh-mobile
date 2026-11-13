// Native `consumePairHash`: no page, no fragment. The PWA reads `/pair#a=…&c=…` in the `.web.ts`
// sibling; on a phone the pairing-code link arrives only through the QR scanner, where the pair
// panel recognizes it and explains that a phone pairs by QR (an 8-digit code carries no pin).

import type { PairLink } from '../core/pair-link';

export function consumePairHash(): PairLink | null {
  return null;
}
