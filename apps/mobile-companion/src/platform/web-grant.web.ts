// The pairing's `web:unlock` grant — WEB (spec 021, revision 14).
//
// The `paired` frame reports the scopes this install was granted, and `web:unlock` is the one that
// arms the Host-side lock. Recording it here is what lets the gate offer "create a passkey" even
// when the very first socket never got as far as `hello` (see `saveWebUnlockGrant` in
// `secure-store.web.ts`); the live `hello.webLock` always wins once it arrives.
//
// Best effort: a store failure must never fail the pairing it follows, so these never throw.

import { readWebUnlockGrant as readGrant, saveWebUnlockGrant as saveGrant } from './secure-store.web';

/** Remember whether this pairing carried `web:unlock`; resolves `false` on an unreadable store. */
export async function saveWebUnlockGrant(scopes: readonly string[]): Promise<boolean> {
  try {
    return await saveGrant(scopes);
  } catch {
    return false;
  }
}

/** Whether this install's pairing carried `web:unlock`. Never throws. */
export async function readWebUnlockGrant(): Promise<boolean> {
  try {
    return await readGrant();
  } catch {
    return false;
  }
}
