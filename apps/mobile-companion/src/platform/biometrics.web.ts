// Web unlock gate (spec 021, contract revision 14) — the `*.web.ts` sibling of `biometrics.ts`.
//
// The browser has no biometric, so a web device unlocks by PROVING it holds the passkey registered
// for its pairing: the Host sends a fresh challenge, the browser signs it, and the Host verifies it
// and unlocks that socket only. The whole browser half lives in `./passkey.web.ts`; native
// `biometrics.ts` (OS biometrics/passcode) is unchanged, and native devices never carry `web:unlock`.
//
// Mapping onto the gate's vocabulary:
//   asserted                                  -> ok
//   dismissed / wrong passkey / Host refusal   -> a `LockReason` the gate has copy for
//   no WebAuthn in this browser               -> 'unavailable' (its own sentence)

export { authenticate, biometricLabel, unlockCapability } from './passkey.web';
export {
  PASSKEY_LOCK_TYPE,
  assertPasskey,
  createPasskey,
  getPasskeyAssertion,
  lockPasskeySocket,
  registerPasskey,
  watchPasskeyApproval,
  type PasskeyApproval,
} from './passkey.web';
