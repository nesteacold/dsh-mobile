// Web (PWA) half of the pairing-code link: `/pair#a=<address>&c=<code>` (src/core/pair-link.ts).
//
// The fragment is read ONCE and removed from the address bar at once with `history.replaceState`,
// so the code does not linger in history, a bookmark, a shared tab or a screenshot of the URL bar.
// Only a fragment that parses as a pair link is stripped; any other fragment is left alone.

import { parsePairHash, type PairLink } from '../core/pair-link';

interface PairHashWindow {
  location: { hash: string; pathname: string; search: string };
  history: { state: unknown; replaceState(data: unknown, unused: string, url?: string): void };
}

/** Testable core: consume a pair link from `win`'s fragment, stripping it. */
export function consumePairHashFrom(win: PairHashWindow | undefined | null): PairLink | null {
  if (!win || !win.location) return null;
  const link = parsePairHash(win.location.hash);
  if (link === null) return null;
  try {
    win.history.replaceState(win.history.state, '', `${win.location.pathname}${win.location.search}`);
  } catch {
    // A sandboxed frame may refuse; the link is still used, never logged.
  }
  return link;
}

// Consumed at module load (the root layout imports the pair panel at startup), so the fragment is
// gone from the address bar even when this device is already paired and the panel never mounts.
let pending: PairLink | null =
  typeof window === 'undefined' ? null : consumePairHashFrom(window as unknown as PairHashWindow);

export function consumePairHash(): PairLink | null {
  const link = pending ?? (typeof window === 'undefined' ? null : consumePairHashFrom(window as unknown as PairHashWindow));
  pending = null;
  return link;
}
