// Passkey unlock — NATIVE: never locked, never touched.
//
// Contract revision 14 (§14, "A device without `web:unlock` — every native iOS/Android device — is
// unaffected: it never receives `hello.webLock` and never sees a lock"). Native unlocks with the OS
// biometric/passcode (`biometrics.ts`), so every step here is a deliberate no-op and native
// behaviour is exactly what it was before spec 021.
//
// The real implementation is `passkey.web.ts`, which Metro picks on the `web` platform: "web only"
// is decided by the bundler, not by a `Platform.OS` branch in `src/app-state.ts`. The signatures are
// identical so shared code calls them unconditionally.

import type { CompanionClient } from '../core/client';

/** A native app never creates a passkey. Never throws (it would only hide a caller's bug). */
export async function registerPasskey(_client: CompanionClient): Promise<{ ok: true }> {
  throw new Error('passkey unlock is a web (PWA) feature');
}

export async function assertPasskey(_client: CompanionClient): Promise<{ ok: true }> {
  throw new Error('passkey unlock is a web (PWA) feature');
}

export async function lockPasskeySocket(_client: CompanionClient): Promise<void> {
  // nothing to lock: a native device is never locked by a Host
}

/** Nothing to watch: a native socket never receives `passkey-approval` (the owner decides nothing). */
export function watchPasskeyApproval(
  _client: CompanionClient,
  _onApproval: (approval: { approvalId: string; action: 'approve' | 'reject'; verificationCode?: string }) => void,
): () => void {
  return () => undefined;
}
