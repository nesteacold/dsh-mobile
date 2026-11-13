// Pairing-code link (Devices "Pairing code" dialog QR, plugins/devices/lib/pair-qr.mjs):
//
//   https://<pwa-origin>/pair#a=<address>&c=<8-digit code>
//
// The code travels in the FRAGMENT so it never reaches a server log or a Referer. This module only
// parses; the web adapter strips the fragment from the address bar, and the pair panel pre-fills
// its OTP form — the user still taps to confirm and the Host still approves.
//
// Pure: no react-native/expo/Node imports.

import { normalizeOtp } from './pairing-otp';

export interface PairLink {
  /** The Host address to dial (`host:port`), or '' when the link carries none. */
  address: string;
  /** The normalized 8-digit code. */
  otp: string;
}

const MAX_ADDRESS = 300;

/** Parse a fragment (`#a=…&c=…`, with or without the leading `#`). Null when it is not a pair link. */
export function parsePairHash(hash: string | null | undefined): PairLink | null {
  if (typeof hash !== 'string') return null;
  const raw = hash.startsWith('#') ? hash.slice(1) : hash;
  if (raw === '' || raw.length > 1024) return null;
  let params: URLSearchParams;
  try {
    params = new URLSearchParams(raw);
  } catch {
    return null;
  }
  const code = params.get('c');
  if (code === null) return null;
  const normalized = normalizeOtp(code);
  if (!normalized.ok) return null;
  const address = (params.get('a') ?? '').trim();
  if (address.length > MAX_ADDRESS || /[\s/?#@\\]/.test(address)) return null;
  return { address, otp: normalized.otp };
}

/**
 * Parse a full scanned URL of the pair-link form (`https://…/pair#a=…&c=…`). Null for anything
 * else — including the long pairing string, which stays on its own path.
 */
export function parsePairLinkUrl(text: string): PairLink | null {
  if (typeof text !== 'string') return null;
  const trimmed = text.trim();
  if (!/^https:\/\//i.test(trimmed)) return null;
  let url: URL;
  try {
    url = new URL(trimmed);
  } catch {
    return null;
  }
  if (url.pathname.replace(/\/+$/, '') !== '/pair') return null;
  return parsePairHash(url.hash);
}
