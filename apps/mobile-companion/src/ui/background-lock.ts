// Spec 045 — the PWA has no lock gate at all. A browser page going to the background must never
// call controller.lock(): that would close the paired socket and drop the session list/approval
// stream (measured 2026-11-16 for a pending pairing; the owner decision removes the web gate
// entirely, so the same applies to an established pairing). Native keeps locking in full.

export interface BackgroundLockDeps {
  platform: string;
  pairingPending: { verificationCode: string; expiresAt: number } | null;
}

/** Whether calling controller.lock() is safe on this background transition. */
export function mayLockOnBackground({ platform }: BackgroundLockDeps): boolean {
  return platform !== 'web';
}

/**
 * The mirror effect may only reopen the visual gate on a page that is actually in the foreground.
 * `snapshot.unlocked` can stay true from a session opened before a re-pair, so it alone cannot
 * decide this (measured in review: hidden + re-pair pending left the gate reopening itself).
 */
export function mayMirrorUnlocked({ isWeb, unlocked, foreground, gateUnlocked }: {
  isWeb: boolean; unlocked: boolean; foreground: boolean; gateUnlocked: boolean;
}): boolean {
  return isWeb && unlocked && !gateUnlocked && foreground;
}
