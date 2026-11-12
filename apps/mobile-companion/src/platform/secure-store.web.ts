// Web implementation of the credential store (spec 020, requirement 3) — the `*.web.ts`
// sibling Metro picks for the `web` platform instead of `secure-store.ts`.
//
// WHY A SEPARATE IMPLEMENTATION: `expo-secure-store` ships an EMPTY web build
// (`node_modules/expo-secure-store/build/ExpoSecureStore.web.js` is literally
// `export default {}`), so on web every `SecureStore.*Async` call is `undefined` and the whole
// credential path throws. There is no Keychain/Keystore in a browser, so this file provides the
// equivalent surface over **IndexedDB with a non-extractable WebCrypto AES-GCM key**.
//
// SECURITY POSTURE — DELIBERATELY WEAKER THAN KEYCHAIN/KEYSTORE (reviewer: required reading):
//   * The AES-GCM key is generated `extractable: false` and stored as a `CryptoKey` in IndexedDB
//     (CryptoKey is structured-cloneable; the browser keeps the raw bytes out of JS for good).
//     This stops JS from EXPORTING the key. It does NOT stop anyone who can read the browser
//     profile / the disk: the key sits in the same IndexedDB as the ciphertext, so an attacker
//     with profile access (or a malicious extension with that access) can decrypt the token.
//     Treat the browser profile as the security boundary, not this key.
//   * What this does NOT give you: no OS-level per-app isolation, no hardware backing, no binding
//     to device unlock, and no protection against script running in this same origin (XSS in the
//     PWA origin can drive the key through its legitimate API). A native install keeps Keychain
//     /Keystore; web is the weaker platform and the UI must not pretend otherwise.
//   * Neither the token nor the host list is ever written to `localStorage`/`sessionStorage`.
//   * Tokens are stored ONLY as AES-GCM ciphertext: { iv, ciphertext }. The host list is not a
//     secret (no token in it, same as native) and is stored as JSON.
//
// API parity with `secure-store.ts` is the contract: the rest of the app (and `forgetHost`'s
// "record first, then credential" ordering + `store/cleanup-failed` semantics) must not know
// which platform it is on.

import { CoreError, type PairedHost } from '../core';

/** Attempts at deleting one credential before the wipe is reported as failed (native parity). */
export const TOKEN_DELETE_ATTEMPTS = 3;

/** Pause between delete attempts (ms). Total worst case: 2 × 75 ms before the failure. */
const TOKEN_DELETE_RETRY_MS = 75;

/** Fixed, secret-free outcome code for a wipe that did not complete (native parity). */
export const CREDENTIAL_CLEANUP_FAILED = 'store/cleanup-failed';

const TOKEN_PREFIX = 'dsh-companion.token.';
const HOSTS_KEY = 'dsh-companion.hosts';

const DB_NAME = 'dsh-companion';
const DB_STORE = 'kv';
/** IndexedDB key of the AES-GCM key that wraps every stored token. */
const KEY_ENTRY = 'dsh-companion.web.key';
const GCM_IV_BYTES = 12;

export function tokenKey(gatewayId: string): string {
  return `${TOKEN_PREFIX}${gatewayId}`;
}

// ---------------------------------------------------------------------------
// IndexedDB plumbing (one database, one object store, string keys)
// ---------------------------------------------------------------------------

let dbPromise: Promise<IDBDatabase> | null = null;

function openDatabase(): Promise<IDBDatabase> {
  if (dbPromise !== null) return dbPromise;
  dbPromise = new Promise<IDBDatabase>((resolve, reject) => {
    // `indexedDB` can be missing in a private-mode browser or a non-DOM runtime; fail with a
    // typed, actionable error instead of a bare TypeError deep inside the credential path.
    if (typeof indexedDB === 'undefined' || indexedDB === null) {
      reject(new CoreError({ code: 'client/store-unavailable', message: 'This browser has no IndexedDB, so the credential cannot be stored' }));
      return;
    }
    const request = indexedDB.open(DB_NAME, 1);
    request.onupgradeneeded = () => {
      const database = request.result;
      if (!database.objectStoreNames.contains(DB_STORE)) database.createObjectStore(DB_STORE);
    };
    request.onsuccess = () => resolve(request.result);
    request.onerror = () => reject(new CoreError({ code: 'client/store-unavailable', message: 'The browser blocked the credential database' }));
  });
  // A failed open must not be cached forever: the next call may succeed (e.g. after the user
  // leaves private mode). The rejection itself is still delivered to the caller.
  dbPromise.catch(() => {
    dbPromise = null;
  });
  return dbPromise;
}

function runTransaction<T>(mode: IDBTransactionMode, operation: (store: IDBObjectStore) => IDBRequest<unknown>): Promise<T> {
  return openDatabase().then(
    (database) =>
      new Promise<T>((resolve, reject) => {
        const transaction = database.transaction(DB_STORE, mode);
        let result: unknown;
        const request = operation(transaction.objectStore(DB_STORE));
        request.onsuccess = () => {
          result = request.result;
        };
        request.onerror = () => {
          reject(new CoreError({ code: 'client/store-unavailable', message: 'The browser refused the credential operation' }));
        };
        // Resolve on the TRANSACTION, not on the request: for `readwrite` the request's success
        // only means the operation was queued, and `complete` is the point of durability. A
        // transaction that errors or aborts after the request succeeded must still reject.
        transaction.oncomplete = () => {
          resolve(result as T);
        };
        transaction.onerror = () => {
          reject(new CoreError({ code: 'client/store-unavailable', message: 'The credential transaction failed' }));
        };
        transaction.onabort = () => {
          reject(new CoreError({ code: 'client/store-unavailable', message: 'The credential operation was aborted' }));
        };
      }),
  );
}

/** Read one raw entry; `undefined` when absent. Errors propagate (a caller that must not trust
 *  an unreadable store — `deleteToken`'s verification — needs them). */
function readEntry<T>(key: string): Promise<T | undefined> {
  return runTransaction<T | undefined>('readonly', (store) => store.get(key) as unknown as IDBRequest<unknown>);
}

function writeEntry(key: string, value: unknown): Promise<unknown> {
  return runTransaction<unknown>('readwrite', (store) => store.put(value, key) as unknown as IDBRequest<unknown>);
}

function deleteEntry(key: string): Promise<unknown> {
  return runTransaction<unknown>('readwrite', (store) => store.delete(key) as unknown as IDBRequest<unknown>);
}

/**
 * WebCrypto in the DOM lib wants a view over a plain `ArrayBuffer`, while `Uint8Array` is typed
 * over `ArrayBufferLike` (which includes `SharedArrayBuffer`). The bytes here are always a fresh
 * ArrayBuffer from `crypto.getRandomValues` / `subtle.encrypt`, so this narrowing is sound.
 */
function bufferSource(bytes: Uint8Array): BufferSource {
  return bytes as unknown as BufferSource;
}

// ---------------------------------------------------------------------------
// Non-extractable AES-GCM key
// ---------------------------------------------------------------------------

interface StoredCiphertext {
  iv: Uint8Array;
  ciphertext: Uint8Array;
}

/** The stored key, or `null` when none exists yet — never creates one (read paths must not). */
async function existingWrappingKey(): Promise<CryptoKey | null> {
  const stored = await readEntry<CryptoKey>(KEY_ENTRY);
  return stored === undefined || stored === null ? null : stored;
}

/**
 * Shared in-flight generation, so two concurrent callers (a pair racing a reconnect) cannot each
 * mint a key and end up with one of them unable to decrypt the ciphertext the other wrote.
 * Cleared on rejection, exactly like `dbPromise`, so a transient failure is retryable.
 */
let keyPromise: Promise<CryptoKey> | null = null;

/**
 * The wrapping key: created once, stored as a non-extractable `CryptoKey`, reused afterwards.
 *
 * `extractable: false` is the whole point — the browser refuses `crypto.subtle.exportKey` on it,
 * so script in the page can encrypt/decrypt but cannot lift the key material out as JS bytes.
 * (It does not protect against profile/disk access; see the header.)
 */
function wrappingKey(): Promise<CryptoKey> {
  if (keyPromise !== null) return keyPromise;
  keyPromise = (async () => {
    const existing = await existingWrappingKey();
    if (existing !== null) return existing;
    if (typeof crypto === 'undefined' || crypto === null || crypto.subtle === undefined) {
      throw new CoreError({ code: 'client/store-unavailable', message: 'This browser has no WebCrypto, so the credential cannot be encrypted' });
    }
    const created = await crypto.subtle.generateKey(
      { name: 'AES-GCM', length: 256 },
      false, // non-extractable: the key can never be exported to JS
      ['encrypt', 'decrypt'],
    );
    await writeEntry(KEY_ENTRY, created);
    return created;
  })();
  keyPromise.catch(() => {
    keyPromise = null;
  });
  return keyPromise;
}

/**
 * Best-effort: ask the browser to keep this origin's storage out of eviction (spec 020 §3).
 * Called after a token is written (i.e. after pairing), never on a read path, never fatal.
 */
function requestPersistentStorage(): void {
  try {
    const storage = navigator?.storage as StorageManager | undefined;
    // `persist()` may reject (permission policy) or be absent: either way it must not affect
    // pairing — the credential is already written and readable.
    void storage?.persist?.().catch(() => undefined);
  } catch {
    // No navigator (tests) or a hostile getter: persistence is an optimisation, not a gate.
  }
}

// ---------------------------------------------------------------------------
// Credentials (contract §3.3 / FR-003): token in, token out, wipe
// ---------------------------------------------------------------------------

/** Store the token the `paired` frame delivered. Call immediately (it is sent only once). */
export async function saveToken(gatewayId: string, token: string): Promise<void> {
  const key = await wrappingKey();
  const iv = crypto.getRandomValues(new Uint8Array(GCM_IV_BYTES));
  const ciphertext = new Uint8Array(
    await crypto.subtle.encrypt({ name: 'AES-GCM', iv: bufferSource(iv) }, key, new TextEncoder().encode(token)),
  );
  await writeEntry(tokenKey(gatewayId), { iv, ciphertext } satisfies StoredCiphertext);
  // After a successful pairing write, ask for durable storage (best effort, never fatal).
  requestPersistentStorage();
}

export async function readToken(gatewayId: string): Promise<string | null> {
  try {
    const stored = await readEntry<StoredCiphertext>(tokenKey(gatewayId));
    if (stored === undefined || stored === null) return null;
    // Lookup only: a read of a missing token must never create the wrapping key.
    const key = await existingWrappingKey();
    if (key === null) return null;
    const plaintext = await crypto.subtle.decrypt(
      { name: 'AES-GCM', iv: bufferSource(stored.iv) },
      key,
      bufferSource(stored.ciphertext),
    );
    return new TextDecoder().decode(plaintext);
  } catch {
    // Mirrors native: a corrupted / unreadable entry is treated as "not paired"; re-pair is safe.
    return null;
  }
}

/** True when a credential exists for this host (used by the lock screen). */
export async function hasToken(gatewayId: string): Promise<boolean> {
  return (await readToken(gatewayId)) !== null;
}

function pause(ms: number): Promise<void> {
  return new Promise((resolve) => {
    setTimeout(resolve, ms);
  });
}

/**
 * TEST-ONLY: forget the module-level caches (database connection, in-flight key promise).
 *
 * It cannot weaken storage in any way — the IndexedDB contents and the stored `CryptoKey` are
 * untouched; it only lets a test observe the caching behaviour (key race, missing-IndexedDB)
 * without cross-test state. Never called by app code.
 */
export function __resetWebStoreForTests(): void {
  dbPromise = null;
  keyPromise = null;
}

/**
 * Wipe this host's credential — the same contract as the native store: a deletion failure MUST
 * reach the caller, and a wipe is only "done" when a verification read proves the entry is gone.
 *
 * A verify read that throws proves nothing, so it counts as a FAILED attempt (it is exactly the
 * case where the credential cannot be shown to be gone) and is retried like any other failure.
 */
export async function deleteToken(gatewayId: string): Promise<void> {
  const key = tokenKey(gatewayId);
  for (let attempt = 1; attempt <= TOKEN_DELETE_ATTEMPTS; attempt += 1) {
    let deleted = false;
    try {
      await deleteEntry(key);
      deleted = true;
    } catch {
      // falls through to the retry (or the failure once the attempts are used up)
    }
    if (deleted) {
      try {
        // Read the store directly: `readToken` maps errors to "absent" and would hide this case.
        if ((await readEntry<StoredCiphertext>(key)) === undefined) return;
      } catch {
        // The verify read failed: the wipe is unproven, so retry rather than claim success.
      }
    }
    if (attempt < TOKEN_DELETE_ATTEMPTS) await pause(TOKEN_DELETE_RETRY_MS);
  }
  throw new CoreError({
    code: CREDENTIAL_CLEANUP_FAILED,
    message: 'The stored credential could not be deleted from this device',
  });
}

// ---------------------------------------------------------------------------
// Web unlock (spec 021) — whether this install's pairing carried `web:unlock`
// ---------------------------------------------------------------------------

const WEB_UNLOCK_GRANT_KEY = 'dsh-companion.web.unlock-granted';

/**
 * Record the scopes the `paired` frame granted this install. Not a secret (it is a grant name, the
 * same value `hello.device.scopes` reports), so it is plain data like the host list.
 *
 * WHY IT IS STORED: the unlock gate never reads the credential before it opens (A020/M5), so a web
 * device whose very FIRST socket was closed by the Host before it could read `hello.webLock` would
 * never learn it must create a passkey — and the next page load could not find out either. The
 * `paired` frame is the one place that says so without a credential read.
 */
export async function saveWebUnlockGrant(scopes: readonly string[]): Promise<boolean> {
  const granted = scopes.includes('web:unlock');
  await writeEntry(WEB_UNLOCK_GRANT_KEY, granted ? 'granted' : 'not-granted');
  return granted;
}

/** True when this install's pairing carried `web:unlock` (false for every native pairing, and for
 *  an installation that never stored one). */
export async function readWebUnlockGrant(): Promise<boolean> {
  try {
    return (await readEntry<string>(WEB_UNLOCK_GRANT_KEY)) === 'granted';
  } catch {
    // An unreadable store proves nothing: the gate then relies on the live `hello.webLock`.
    return false;
  }
}

// ---------------------------------------------------------------------------
// Non-secret host records (native parity: plain data, never a token)
// ---------------------------------------------------------------------------

export async function readHosts(): Promise<PairedHost[]> {
  const raw = await readEntry<string>(HOSTS_KEY);
  if (raw === undefined || raw === null) return [];
  try {
    const parsed: unknown = JSON.parse(raw);
    if (!Array.isArray(parsed)) return [];
    return parsed.filter(
      (entry): entry is PairedHost =>
        typeof entry === 'object' && entry !== null && typeof (entry as PairedHost).gatewayId === 'string',
    );
  } catch {
    return [];
  }
}

export async function writeHosts(hosts: readonly PairedHost[]): Promise<void> {
  await writeEntry(HOSTS_KEY, JSON.stringify(hosts));
}

/** Upsert one host record (by gatewayId) and return the new list. */
export async function saveHost(host: PairedHost): Promise<PairedHost[]> {
  const hosts = (await readHosts()).filter((entry) => entry.gatewayId !== host.gatewayId);
  const next = [host, ...hosts];
  await writeHosts(next);
  return next;
}

/**
 * Remove a host record and its credential. The record goes first, so the browser stops looking
 * paired even when the credential delete fails; a failure still rejects, carrying the fixed
 * `store/cleanup-failed` code (the caller must not report a completed wipe).
 */
export async function forgetHost(gatewayId: string): Promise<PairedHost[]> {
  const hosts = (await readHosts()).filter((entry) => entry.gatewayId !== gatewayId);
  let recordError = false;
  try {
    await writeHosts(hosts);
  } catch {
    // Do not let a failed list write keep the credential: it is deleted below either way.
    recordError = true;
  }
  await deleteToken(gatewayId);
  try {
    // The pairing that carried `web:unlock` is being removed. The Host deletes the device's passkey
    // record with the device itself (revoke, contract §14.6); only the grant marker this install
    // kept for the never-opened case is dropped here.
    await deleteEntry(WEB_UNLOCK_GRANT_KEY);
  } catch {
    // An unreadable store must not turn a completed unpair into a failure; the marker is re-written
    // by the next pairing anyway.
  }
  if (recordError) {
    throw new CoreError({
      code: CREDENTIAL_CLEANUP_FAILED,
      message: 'The pairing record could not be removed from this device',
    });
  }
  return hosts;
}
