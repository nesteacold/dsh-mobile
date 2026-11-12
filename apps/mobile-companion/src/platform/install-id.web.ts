// Web install id (spec 020) — the `*.web.ts` sibling of `install-id.ts`.
//
// The native build keeps this UUID in SecureStore. On web `expo-secure-store` is an empty stub
// (`ExpoSecureStore.web.js` = `export default {}`), so calling it throws. The install id is NOT a
// credential (contract §3.2: it only lets the Host reuse the trusted-device record), so plain
// `localStorage` is the right home here: it must not sit behind the credential encryption, and it
// must survive a reload. Losing it just makes the Host record a new device.

const KEY = 'dsh-companion.install-id';

let cached: string | null = null;

function readRaw(): string | null {
  try {
    return localStorage.getItem(KEY);
  } catch {
    // Storage can be denied (private mode / blocked cookies): treat as absent, never throw.
    return null;
  }
}

function writeRaw(value: string): void {
  try {
    localStorage.setItem(KEY, value);
  } catch {
    // Persisting is best effort; a session that cannot store it still pairs (new device next time).
  }
}

function randomUuid(): string {
  // `crypto.randomUUID` needs a secure context (https / localhost) — which a PWA already is.
  if (typeof crypto !== 'undefined' && typeof crypto.randomUUID === 'function') return crypto.randomUUID();
  // Fallback: random v4-shaped UUID from getRandomValues (never Math.random).
  const bytes = crypto.getRandomValues(new Uint8Array(16));
  bytes[6] = ((bytes[6] ?? 0) & 0x0f) | 0x40;
  bytes[8] = ((bytes[8] ?? 0) & 0x3f) | 0x80;
  const hex = [...bytes].map((byte) => byte.toString(16).padStart(2, '0')).join('');
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20)}`;
}

/** The installation UUID, creating it on first use. */
export async function getInstallId(): Promise<string> {
  if (cached !== null) return cached;
  const stored = readRaw();
  if (stored !== null && /^[0-9a-f-]{36}$/i.test(stored)) {
    cached = stored;
    return stored;
  }
  const created = randomUuid();
  writeRaw(created);
  cached = created;
  return created;
}

/** Test / diagnostics only: forget the in-memory copy (the store keeps the value). */
export function clearInstallIdCache(): void {
  cached = null;
}
