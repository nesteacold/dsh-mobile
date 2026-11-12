// Which copy the unlock gate shows when it cannot verify the user — NATIVE.
//
// Native has a real OS unlock to offer, so its message is the "set up a screen lock" instruction
// (`unlock.unavailable`). The web build unlocks with a passkey and has its own sentence
// (`unlock.passkeyUnsupported`); the `*.web.ts` sibling returns that instead. Keeping the choice in
// a platform pair (rather than a `Platform.OS` branch in `app/_layout.tsx`) means the native copy
// and the native behaviour are literally unchanged.

export type UnlockUnavailableKey = 'unlock.unavailable' | 'unlock.passkeyUnsupported';

/** Native: the user can enable a device passcode/biometric, so point them at it. */
export function unlockUnavailableKey(): UnlockUnavailableKey {
  return 'unlock.unavailable';
}
