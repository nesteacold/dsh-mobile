// Unpadded base64url <-> bytes (contract §14.1: "Every binary field is unpadded base64url").
//
// The WebAuthn options a Host sends (`challenge`, `allowCredentials[].id`, `excludeCredentials[].id`,
// `user.id`) arrive as base64url STRINGS, and `navigator.credentials.create/get` refuse a string
// where it expects a `BufferSource` (a DOMStringMap TypeError, not a silent miss). This module is
// what turns them back into bytes and what encodes the answer.
//
// Pure and dependency-free: `Buffer` and `atob` are both runtime-specific (the first is absent in
// every browser, the second in Node before v16 and in some RN builds), so the codec is here once
// instead of in a platform pair. `npm run check:core` keeps this file free of node/react-native
// imports like the rest of `src/core`.

const ALPHABET = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789-_'

/** The lookup index of each alphabet character; -1 marks anything else (padding, +, /, spaces). */
const INDEX = new Int16Array(128).fill(-1)
for (let index = 0; index < ALPHABET.length; index += 1) INDEX[ALPHABET.charCodeAt(index)] = index

/** Decode unpadded base64url bytes, or `null` when the value is not base64url at all. */
export function decodeBase64Url(value: string): Uint8Array | null {
  if (typeof value !== 'string' || value.length % 4 === 1) return null;
  let padding = 0;
  if (value.endsWith('==')) padding = 2;
  else if (value.endsWith('=')) padding = 1;
  const body = padding === 0 ? value : value.slice(0, value.length - padding);
  let bytes = 0;
  for (let index = 0; index < body.length; index += 1) {
    const code = body.charCodeAt(index);
    if (code >= 128 || symbolAt(code) === -1) return null;
    bytes += 1;
  }
  const wholeGroups = Math.floor(bytes / 4);
  const tail = bytes - wholeGroups * 4;
  if (tail === 1) return null; // a lone 6-bit group encodes no whole byte: never base64url
  const out = new Uint8Array(wholeGroups * 3 + (tail === 0 ? 0 : tail - 1));
  let at = 0;
  let group = 0;
  for (let index = 0; index < bytes; index += 1) {
    group = (group << 6) | symbolAt(body.charCodeAt(index));
    if (index % 4 === 3) {
      out[at] = (group >> 16) & 0xff;
      out[at + 1] = (group >> 8) & 0xff;
      out[at + 2] = group & 0xff;
      at += 3;
      group = 0;
    }
  }
  // `index` is the exclusive end of the tail here; the last group's low bits are zero-padding.
  if (tail === 2) {
    out[at] = (group >> 4) & 0xff;
  } else if (tail === 3) {
    out[at] = (group >> 10) & 0xff;
    out[at + 1] = (group >> 2) & 0xff;
  }
  return out;
}

/** The 6-bit value of one alphabet character (`number` avoids the noUncheckedIndexedAccess tangle). */
function symbolAt(charIndex: number): number {
  return INDEX[charIndex] as number;
}

/** Encode bytes as unpadded base64url. */
export function encodeBase64Url(bytes: ArrayBuffer | Uint8Array): string {
  const view = bytes instanceof Uint8Array ? bytes : new Uint8Array(bytes);
  let out = '';
  let index = 0;
  // A position lookup instead of `ALPHABET[n]`: it keeps the type a plain `string` under
  // `noUncheckedIndexedAccess` without a cast at every use.
  const symbol = (index: number): string => ALPHABET.charAt(index);
  for (; index + 3 <= view.length; index += 3) {
    const value = ((view[index] as number) << 16) | ((view[index + 1] as number) << 8) | (view[index + 2] as number);
    out += symbol((value >> 18) & 63) + symbol((value >> 12) & 63) + symbol((value >> 6) & 63) + symbol(value & 63);
  }
  const rest = view.length - index;
  if (rest === 2) {
    const value = ((view[index] as number) << 16) | ((view[index + 1] as number) << 8);
    out += symbol((value >> 18) & 63) + symbol((value >> 12) & 63) + symbol((value >> 6) & 63);
  } else if (rest === 1) {
    const value = (view[index] as number) << 16;
    out += symbol((value >> 18) & 63) + symbol((value >> 12) & 63);
  }
  return out;
}
