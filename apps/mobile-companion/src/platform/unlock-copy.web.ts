// Which copy the unlock gate shows when it cannot verify the user — WEB.
//
// The native message ("Set up a screen lock (passcode, PIN or biometrics)…") is a PHONE instruction:
// a browser user has no screen lock to enable. The web gate opens by proving a passkey (spec 021),
// so its own sentence is "this browser cannot use a passkey — use a current browser over https".

export type UnlockUnavailableKey = 'unlock.unavailable' | 'unlock.passkeyUnsupported';

/** Web: there is nothing in the browser to "set up" — it needs WebAuthn in a secure context. */
export function unlockUnavailableKey(): UnlockUnavailableKey {
  return 'unlock.passkeyUnsupported';
}
