// Install-scoped device id (contract §3.2: `X-DSH-Device-ID: <install-scoped UUID>`).
//
// A random UUID v4 generated once per install and kept in SecureStore. It is NOT a credential:
// the host uses it only to reuse the trusted-device record when pairing again. Losing it (app
// reinstall, keychain wipe) just means the host records a new device.
//
// Spec 032: this is the NORMAL build's install id. The screenshot/demo mode never calls this
// function — it uses `demo-install-id.ts` (in memory, no keychain), because an unsigned simulator
// Release build cannot use the Keychain at all.

import * as Crypto from 'expo-crypto';
import * as SecureStore from 'expo-secure-store';

// The core is pure (no expo imports); `check:core` guards the direction, and this file is platform.
import { CoreError } from '../core/errors';

const KEY = 'dsh-companion.install-id';
const OPTIONS: SecureStore.SecureStoreOptions = {
  keychainAccessible: SecureStore.WHEN_UNLOCKED_THIS_DEVICE_ONLY,
};

let cached: string | null = null;

/** The installation UUID, creating it on first use. */
export async function getInstallId(): Promise<string> {
  if (cached !== null) return cached;
  let stored: string | null;
  try {
    stored = await SecureStore.getItemAsync(KEY, OPTIONS);
  } catch (error) {
    // A Keychain that cannot be used at all (an unsigned Release build on a simulator: no
    // entitlement, errSecMissingEntitlement) is not a bad frame: it is the platform's credential
    // store being unavailable, which `client/store-unavailable` already means. `pair()` surfaces
    // the code as such instead of the generic `client/bad-message` a plain Error became.
    throw new CoreError({
      code: 'client/store-unavailable',
      message: `Could not read the install id: ${error instanceof Error ? error.message : String(error)}`,
      retryable: false,
    });
  }
  if (stored !== null && /^[0-9a-f-]{36}$/i.test(stored)) {
    cached = stored;
    return stored;
  }
  const created = Crypto.randomUUID();
  try {
    await SecureStore.setItemAsync(KEY, created, OPTIONS);
  } catch (error) {
    // Same store, same answer: nothing about the id is stored, so the pairing cannot rely on it.
    throw new CoreError({
      code: 'client/store-unavailable',
      message: `Could not store the install id: ${error instanceof Error ? error.message : String(error)}`,
      retryable: false,
    });
  }
  cached = created;
  return created;
}

/** Test / diagnostics only: forget the in-memory copy (the store keeps the value). */
export function clearInstallIdCache(): void {
  cached = null;
}
