// What a pasted pairing string IS, before anything parses it as a pairing payload.
//
// A user with an 8-digit code on their computer pastes it into the "QR or code" field, because that
// field says "Or paste the code shown on your computer". Parsed as a payload it fails, and the
// generic "pairing failed" copy sent them back to the computer for a new code that would have failed
// the same way. So the submit path asks this first: an 8-digit code belongs to the code tab.
//
// Pure and ui-adjacent: the rule is `normalizeOtp` itself (the same spacing/format rules the code
// tab applies), so the two fields can never disagree about what a code is.

import { normalizeOtp } from '../core/pairing-otp';

export type PastedPairing =
  /** `otp` is already normalized to 8 digits — the code tab's own field format. */
  | { kind: 'code'; otp: string }
  /** Carries anything else: a long pairing string, a link, or text that is simply not a code. */
  | { kind: 'payload' };

export function classifyPastedPairing(raw: string): PastedPairing {
  // Classified on the text AS PASTED: `trim()` would make a non-breaking space (which the code tab
  // refuses, and a phone's paste can carry) look like ordinary padding, and the user would then have
  // a code tab holding digits that `normalizeOtp` rejects.
  const normalized = normalizeOtp(raw);
  return normalized.ok ? { kind: 'code', otp: normalized.otp } : { kind: 'payload' };
}
