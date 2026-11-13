// OTP pairing (contract revision 5, §3.8) — the client half of the code the Host shows in
// "Generate pairing code" (`POST /mgw/pair {mode:'otp'}`).
//
// The Host side is `plugins/mobile-gateway/lib/pairing-requests.mjs`: an 8-digit single-use code
// (10 min), and a proof the client must compute as
//
//   otpProof = HMAC-SHA256(key = otp, certSha256 || clientNonce || serverNonce)   (hex)
//
// where `certSha256`/`serverNonce` come from the `pairing-challenge` and `clientNonce` is ours.
// The code itself is NEVER sent: only this proof is, and it is bound to the TLS leaf this phone
// pinned, so a replay on another connection (fresh nonces) and a relay under another certificate
// (different pin ⇒ the Host's own verification fails) both fail.
//
// Pure: no react-native/expo/Node imports, and no I/O. The caller supplies the typed code; it is
// never stored, logged or echoed — `normalizeOtp` returns a value or a typed reason, and this
// module has no sink of any kind.
//
// Why the proof is computed here and not by `expo-crypto`: that package offers SHA-256 only (no
// HMAC) and asynchronously, while the proof must be written synchronously in the same turn the
// challenge arrives. `./hmac` implements the two published primitives and its output is pinned
// against `node:crypto` and the RFC 4231 vectors.

import { hmacSha256Hex, sha256Hex } from './hmac';

/** Digits in a Host pairing code (`OTP_DIGITS` in `pairing-requests.mjs`). */
export const OTP_DIGITS = 8;

/**
 * Subprotocol that selects the OTP flow on the gateway (`PAIR_OTP_PROTOCOL` in
 * `plugins/mobile-gateway/lib/index.mjs:268`). Without it the upgrade is treated as a
 * long-pairing-string claim, which is a different flow with a different secret.
 */
export const OTP_SUBPROTOCOL = 'dsh-pair-otp.v1';

/** Max characters a typed code may contain before normalization (8 digits plus spaces/dashes). */
const OTP_INPUT_MAX_LENGTH = 32;

export type OtpRejectReason =
  /** Nothing typed. */
  | 'otp/empty'
  /** Not 8 digits once spaces and dashes are removed (too short, too long, letters, symbols). */
  | 'otp/bad-length';

/**
 * Normalize a typed code to exactly 8 ASCII digits, or report why it cannot be one.
 *
 * Tolerant of the two forms a user actually types: `"04291375"` as shown, and the grouped
 * `"0429 1375"` / `"0429-1375"` the Host dialog displays. Everything else — letters, a partial
 * code, digits pasted with a stray character — is refused BEFORE any socket exists, so a typo
 * never costs one of the Host's three proof attempts.
 *
 * Returns a discriminated result instead of throwing: the pair screen maps the reason to copy,
 * and nothing here can reach a log with the value in it.
 */
export function normalizeOtp(input: string): { ok: true; otp: string } | { ok: false; reason: OtpRejectReason } {
  if (typeof input !== 'string') return { ok: false, reason: 'otp/empty' };
  // A code is short; anything longer is not one (and is not worth scanning further).
  if (input.length > OTP_INPUT_MAX_LENGTH) return { ok: false, reason: 'otp/bad-length' };
  // Only spaces and dashes are separators. Deliberately NOT `\s`: a newline or a non-breaking
  // space in the pasted text would otherwise be silently accepted as grouping.
  const digits = input.replace(/[ -]/g, '');
  if (digits === '') return { ok: false, reason: 'otp/empty' };
  if (digits.length !== OTP_DIGITS || !/^[0-9]+$/.test(digits)) return { ok: false, reason: 'otp/bad-length' };
  return { ok: true, otp: digits };
}

/**
 * The `otpProof` of a `pairing-proof` frame, as 64 lowercase hex characters.
 *
 * Byte-for-byte what the Host recomputes (`otpProof()` in `pairing-requests.mjs`). All four
 * inputs are ASCII by construction (8 digits, a 64-hex pin, base64url nonces), so concatenating
 * the UTF-8 encodings is exactly the Host's `update(cert).update(client).update(server)` chain.
 *
 * Throws only for an argument that is not a string — a caller bug, never user input: the code is
 * normalized first, and a non-string means the pair flow was wired wrong.
 */
export function otpProof(otp: string, certSha256: string, clientNonce: string, serverNonce: string): string {
  for (const value of [otp, certSha256, clientNonce, serverNonce]) {
    if (typeof value !== 'string') throw new TypeError('otpProof expects four strings');
  }
  return hmacSha256Hex(otp, `${certSha256}${clientNonce}${serverNonce}`);
}

/**
 * The 6-digit code BOTH screens show once the proof is accepted (`verificationCode` in
 * `pairing-requests.mjs`), so the phone user can see that the desktop is the same connection.
 *
 * Derived from the TLS pin and both nonces — NOT from the OTP — so a man in the middle
 * terminating TLS with its own certificate necessarily shows a different code on each leg. The
 * Host sends this value in `pairing-pending`; the client recomputes it so the comparison is a
 * real check rather than displaying whatever arrived.
 *
 * `SHA-256(certSha256 || clientNonce || serverNonce || 'dsh-verify') mod 10^6`, zero-padded.
 */
export function verificationCode(certSha256: string, clientNonce: string, serverNonce: string): string {
  const digestHex = sha256Hex(`${certSha256}${clientNonce}${serverNonce}dsh-verify`);
  // The full 256-bit value mod 10^6, as the spec words it (BigInt, no truncation bias beyond mod).
  return (BigInt(`0x${digestHex}`) % 1_000_000n).toString().padStart(6, '0');
}
