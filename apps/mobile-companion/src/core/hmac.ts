// SHA-256 (FIPS 180-4) and HMAC-SHA256 (RFC 2104), in plain TypeScript.
//
// WHY THIS IS HERE: the OTP pairing proof is `HMAC-SHA256(key = one-time code, certSha256 ||
// clientNonce || serverNonce)` (contract revision 5, and `plugins/mobile-gateway/lib/
// pairing-requests.mjs` implements the Host side of exactly that). This build's only hash
// primitive is `expo-crypto`'s SHA-256 — no HMAC, and its digest API is asynchronous, while the
// proof must be written synchronously in the same turn the challenge arrives. `src/core` must
// also stay free of expo and of Node built-ins (`npm run check:core`), so the two primitives are
// implemented once here.
//
// Nothing below is bespoke cryptography: the constants, the compression function, the padding
// and the HMAC construction are the published ones, and `test/pairing-otp.test.ts` pins them
// against `node:crypto` and the RFC 4231 vectors — the same bytes the gateway computes.

/** SHA-256 round constants (FIPS 180-4 §4.2.2): first 32 bits of the fractional parts of the
 * cube roots of the first 64 primes. */
const K = new Uint32Array([
  0x428a2f98, 0x71374491, 0xb5c0fbcf, 0xe9b5dba5, 0x3956c25b, 0x59f111f1, 0x923f82a4, 0xab1c5ed5,
  0xd807aa98, 0x12835b01, 0x243185be, 0x550c7dc3, 0x72be5d74, 0x80deb1fe, 0x9bdc06a7, 0xc19bf174,
  0xe49b69c1, 0xefbe4786, 0x0fc19dc6, 0x240ca1cc, 0x2de92c6f, 0x4a7484aa, 0x5cb0a9dc, 0x76f988da,
  0x983e5152, 0xa831c66d, 0xb00327c8, 0xbf597fc7, 0xc6e00bf3, 0xd5a79147, 0x06ca6351, 0x14292967,
  0x27b70a85, 0x2e1b2138, 0x4d2c6dfc, 0x53380d13, 0x650a7354, 0x766a0abb, 0x81c2c92e, 0x92722c85,
  0xa2bfe8a1, 0xa81a664b, 0xc24b8b70, 0xc76c51a3, 0xd192e819, 0xd6990624, 0xf40e3585, 0x106aa070,
  0x19a4c116, 0x1e376c08, 0x2748774c, 0x34b0bcb5, 0x391c0cb3, 0x4ed8aa4a, 0x5b9cca4f, 0x682e6ff3,
  0x748f82ee, 0x78a5636f, 0x84c87814, 0x8cc70208, 0x90befffa, 0xa4506ceb, 0xbef9a3f7, 0xc67178f2,
]);

/** Initial hash value (FIPS 180-4 §5.3.3): fractional parts of the square roots of the first 8 primes. */
const H0 = new Uint32Array([
  0x6a09e667, 0xbb67ae85, 0x3c6ef372, 0xa54ff53a, 0x510e527f, 0x9b05688c, 0x1f83d9ab, 0x5be0cd19,
]);

/** One SHA-256/HMAC block, and one digest, in words. */
const BLOCK_BYTES = 64;
const DIGEST_BYTES = 32;

/** `value` rotated right by `bits` (FIPS 180-4 §3.2.3). */
function rotr(value: number, bits: number): number {
  return (value >>> bits) | (value << (32 - bits));
}

/** Typed-array read that stays `number` under `noUncheckedIndexedAccess` (same idiom as `base64url.ts`). */
function word(words: Uint32Array, index: number): number {
  return words[index] as number;
}

/**
 * UTF-8 bytes of a string (WHATWG Encoding). A lone surrogate encodes as U+FFFD rather than
 * throwing — this only ever sees ASCII (a code of digits, a hex fingerprint, a base64url nonce),
 * but a hand-typed value must never be able to break the proof computation.
 */
export function utf8Bytes(text: string): Uint8Array {
  const out: number[] = [];
  for (let index = 0; index < text.length; index += 1) {
    let code = text.charCodeAt(index);
    if (code >= 0xd800 && code <= 0xdbff && index + 1 < text.length) {
      const low = text.charCodeAt(index + 1);
      if (low >= 0xdc00 && low <= 0xdfff) {
        code = 0x10000 + ((code - 0xd800) << 10) + (low - 0xdc00);
        index += 1;
      } else {
        code = 0xfffd;
      }
    } else if (code >= 0xd800 && code <= 0xdfff) {
      code = 0xfffd;
    }
    if (code < 0x80) {
      out.push(code);
    } else if (code < 0x800) {
      out.push(0xc0 | (code >> 6), 0x80 | (code & 0x3f));
    } else if (code < 0x10000) {
      out.push(0xe0 | (code >> 12), 0x80 | ((code >> 6) & 0x3f), 0x80 | (code & 0x3f));
    } else {
      out.push(
        0xf0 | (code >> 18),
        0x80 | ((code >> 12) & 0x3f),
        0x80 | ((code >> 6) & 0x3f),
        0x80 | (code & 0x3f),
      );
    }
  }
  return Uint8Array.from(out);
}

/** SHA-256 of raw bytes (FIPS 180-4 §6.2). */
export function sha256(message: Uint8Array): Uint8Array {
  const state = new Uint32Array(H0);
  const schedule = new Uint32Array(64);
  // Message + 0x80 + zero padding + the 64-bit big-endian bit length, rounded up to a block.
  const bitLength = message.length * 8;
  const padded = new Uint8Array((((message.length + 9) + (BLOCK_BYTES - 1)) >> 6) << 6);
  padded.set(message);
  padded[message.length] = 0x80;
  const view = new DataView(padded.buffer, 0, padded.length);
  // JavaScript numbers hold the length exactly far beyond any real message (2^53 bits).
  view.setUint32(padded.length - 8, Math.floor(bitLength / 0x100000000));
  view.setUint32(padded.length - 4, bitLength % 0x100000000);

  for (let offset = 0; offset < padded.length; offset += BLOCK_BYTES) {
    for (let index = 0; index < 16; index += 1) {
      schedule[index] = view.getUint32(offset + index * 4);
    }
    for (let index = 16; index < 64; index += 1) {
      const w15 = word(schedule, index - 15);
      const w2 = word(schedule, index - 2);
      const s0 = rotr(w15, 7) ^ rotr(w15, 18) ^ (w15 >>> 3);
      const s1 = rotr(w2, 17) ^ rotr(w2, 19) ^ (w2 >>> 10);
      schedule[index] = (word(schedule, index - 16) + s0 + word(schedule, index - 7) + s1) >>> 0;
    }

    let a = word(state, 0);
    let b = word(state, 1);
    let c = word(state, 2);
    let d = word(state, 3);
    let e = word(state, 4);
    let f = word(state, 5);
    let g = word(state, 6);
    let h = word(state, 7);

    for (let index = 0; index < 64; index += 1) {
      const sigma1 = rotr(e, 6) ^ rotr(e, 11) ^ rotr(e, 25);
      const choose = (e & f) ^ (~e & g);
      const temp1 = (h + sigma1 + choose + word(K, index) + word(schedule, index)) >>> 0;
      const sigma0 = rotr(a, 2) ^ rotr(a, 13) ^ rotr(a, 22);
      const majority = (a & b) ^ (a & c) ^ (b & c);
      const temp2 = (sigma0 + majority) >>> 0;
      h = g;
      g = f;
      f = e;
      e = (d + temp1) >>> 0;
      d = c;
      c = b;
      b = a;
      a = (temp1 + temp2) >>> 0;
    }

    state[0] = (word(state, 0) + a) >>> 0;
    state[1] = (word(state, 1) + b) >>> 0;
    state[2] = (word(state, 2) + c) >>> 0;
    state[3] = (word(state, 3) + d) >>> 0;
    state[4] = (word(state, 4) + e) >>> 0;
    state[5] = (word(state, 5) + f) >>> 0;
    state[6] = (word(state, 6) + g) >>> 0;
    state[7] = (word(state, 7) + h) >>> 0;
  }

  const digest = new Uint8Array(DIGEST_BYTES);
  const out = new DataView(digest.buffer, 0, digest.length);
  for (let index = 0; index < 8; index += 1) out.setUint32(index * 4, word(state, index));
  return digest;
}

/** HMAC-SHA256 of raw bytes (RFC 2104 §2), with a raw-bytes key. */
export function hmacSha256(key: Uint8Array, message: Uint8Array): Uint8Array {
  // A key longer than a block is replaced by its own digest; shorter keys are zero-padded.
  const block = new Uint8Array(BLOCK_BYTES);
  block.set(key.length > BLOCK_BYTES ? sha256(key) : key);
  const inner = new Uint8Array(BLOCK_BYTES + message.length);
  const outer = new Uint8Array(BLOCK_BYTES + DIGEST_BYTES);
  for (let index = 0; index < BLOCK_BYTES; index += 1) {
    const byte = block[index] as number;
    inner[index] = byte ^ 0x36; // ipad
    outer[index] = byte ^ 0x5c; // opad
  }
  inner.set(message, BLOCK_BYTES);
  outer.set(sha256(inner), BLOCK_BYTES);
  return sha256(outer);
}

/** Lowercase hex of raw bytes. */
export function toHex(bytes: Uint8Array): string {
  let out = '';
  for (let index = 0; index < bytes.length; index += 1) {
    out += (bytes[index] as number).toString(16).padStart(2, '0');
  }
  return out;
}

/**
 * `HMAC-SHA256(key, message)` as 64 lowercase hex characters — exactly the shape the Host
 * compares (`crypto.createHmac('sha256', key).update(...).digest('hex')`).
 */
export function hmacSha256Hex(key: string, message: string): string {
  return toHex(hmacSha256(utf8Bytes(key), utf8Bytes(message)));
}

/** `SHA-256(message)` as 64 lowercase hex characters. */
export function sha256Hex(message: string): string {
  return toHex(sha256(utf8Bytes(message)));
}
