// Web credential store (spec 020 §3) — reviewer-requested coverage.
//
// The store is `src/platform/secure-store.web.ts`: IndexedDB holds the token as AES-GCM
// ciphertext under a NON-EXTRACTABLE WebCrypto key. These tests pin the four properties the
// review asked for: a fresh IV per write, exactly one wrapping key under a concurrent race,
// wipe-parity with the native store (an unprovable verification read is a FAILED wipe), and the
// honest failure when the browser has no IndexedDB at all.
//
// `fake-indexeddb` provides the IndexedDB implementation; Node's own WebCrypto is the crypto.

import 'fake-indexeddb/auto';
import assert from 'node:assert/strict';
import { afterEach, beforeEach, describe, it } from 'node:test';

import {
  CREDENTIAL_CLEANUP_FAILED,
  TOKEN_DELETE_ATTEMPTS,
  __resetWebStoreForTests,
  deleteToken,
  readToken,
  saveToken,
  tokenKey,
} from '../src/platform/secure-store.web';

const GATEWAY_ID = 'gw-web-1';
const KEY_ENTRY = 'dsh-companion.web.key';
const DB_NAME = 'dsh-companion';
const DB_STORE = 'kv';

interface StoredCiphertext {
  iv: Uint8Array;
  ciphertext: Uint8Array;
}

/** Read one raw IndexedDB entry by key (the store keeps its raw shape private on purpose). */
function rawEntry<T>(key: string): Promise<T | undefined> {
  return new Promise<T | undefined>((resolve, reject) => {
    const open = indexedDB.open(DB_NAME, 1);
    open.onsuccess = () => {
      const database = open.result;
      const transaction = database.transaction(DB_STORE, 'readonly');
      const request = transaction.objectStore(DB_STORE).get(key);
      request.onsuccess = () => resolve(request.result as T | undefined);
      request.onerror = () => reject(request.error);
    };
    open.onerror = () => reject(open.error);
  });
}

/** Delete one raw IndexedDB entry (test setup: force a fresh key). */
function deleteRawEntry(key: string): Promise<void> {
  return new Promise<void>((resolve, reject) => {
    const open = indexedDB.open(DB_NAME, 1);
    open.onsuccess = () => {
      const database = open.result;
      const transaction = database.transaction(DB_STORE, 'readwrite');
      transaction.objectStore(DB_STORE).delete(key);
      transaction.oncomplete = () => resolve();
      transaction.onerror = () => reject(transaction.error);
    };
    open.onerror = () => reject(open.error);
  });
}

function bytesEqual(left: Uint8Array, right: Uint8Array): boolean {
  return left.length === right.length && left.every((byte, index) => byte === right[index]);
}

describe('web credential store (IndexedDB + non-extractable AES-GCM)', () => {
  const realIndexedDB = globalThis.indexedDB;

  beforeEach(() => {
    // Module-level caches (database promise, key promise) are per process; reset them per test.
    __resetWebStoreForTests();
  });

  afterEach(() => {
    __resetWebStoreForTests();
    globalThis.indexedDB = realIndexedDB;
  });

  it('uses a fresh random IV for every write of the same token', async () => {
    await saveToken(GATEWAY_ID, 'tok-web-secret');
    const first = await rawEntry<StoredCiphertext>(tokenKey(GATEWAY_ID));
    assert.ok(first !== undefined, 'the token entry was written');

    await saveToken(GATEWAY_ID, 'tok-web-secret');
    const second = await rawEntry<StoredCiphertext>(tokenKey(GATEWAY_ID));
    assert.ok(second !== undefined);

    assert.equal(first.iv.length, 12, 'AES-GCM nonce is 12 bytes');
    assert.equal(bytesEqual(first.iv, second.iv), false, 'the IV must never repeat for a new write');
    assert.equal(bytesEqual(first.ciphertext, second.ciphertext), false, 'equal plaintext must not give equal ciphertext');
    // …and both ciphertexts still decrypt: same key, different IVs.
    assert.equal(await readToken(GATEWAY_ID), 'tok-web-secret');
  });

  it('creates exactly one wrapping key under concurrent writes (no key race)', async () => {
    // Start from "no key yet" (the DB is shared across this file): otherwise the key created by an
    // earlier test would be reused and the race below would prove nothing.
    await deleteRawEntry(KEY_ENTRY);
    __resetWebStoreForTests();
    const subtle = crypto.subtle;
    const originalGenerateKey = subtle.generateKey.bind(subtle);
    let generated = 0;
    (subtle as unknown as { generateKey: typeof subtle.generateKey }).generateKey = ((
      ...args: Parameters<typeof originalGenerateKey>
    ) => {
      generated += 1;
      return originalGenerateKey(...args);
    }) as typeof subtle.generateKey;
    try {
      // Two pairing attempts racing (the real reason the key is cached): they must share one key.
      await Promise.all([
        saveToken(GATEWAY_ID, 'tok-race-a'),
        saveToken('gw-web-2', 'tok-race-b'),
        saveToken('gw-web-3', 'tok-race-c'),
      ]);
    } finally {
      (subtle as unknown as { generateKey: typeof subtle.generateKey }).generateKey = originalGenerateKey;
    }

    assert.equal(generated, 1, 'the wrapping key is generated once, not once per concurrent caller');
    assert.ok((await rawEntry<CryptoKey>(KEY_ENTRY)) !== undefined, 'the key is stored');
    assert.equal(await readToken(GATEWAY_ID), 'tok-race-a');
    assert.equal(await readToken('gw-web-2'), 'tok-race-b');
    assert.equal(await readToken('gw-web-3'), 'tok-race-c');
  });

  it('treats a throwing verification read as a failed wipe, like the native store', async () => {
    await saveToken(GATEWAY_ID, 'tok-wipe');
    const prototype = IDBObjectStore.prototype;
    const originalGet = prototype.get;
    let verifyReads = 0;
    // Every verification read throws: the wipe can never be proven, so it must be reported as a
    // failure rather than as a completed wipe (the native `deleteToken` contract).
    prototype.get = function failingGet(...args: Parameters<typeof originalGet>) {
      verifyReads += 1;
      throw new Error('keystore unavailable: could not read the entry');
    } as typeof originalGet;
    try {
      await assert.rejects(deleteToken(GATEWAY_ID), (error: unknown) => {
        assert.ok(error instanceof Error);
        assert.equal((error as { code?: string }).code, CREDENTIAL_CLEANUP_FAILED);
        return true;
      });
    } finally {
      prototype.get = originalGet;
    }
    assert.equal(verifyReads, TOKEN_DELETE_ATTEMPTS, 'the unproven wipe is retried, then reported');
  });

  it('reports store-unavailable when the browser has no IndexedDB', async () => {
    // Simulate a browser without IndexedDB (private mode / non-DOM runtime). The store must fail
    // with its typed code, not a raw TypeError, and must not pretend the token was saved.
    __resetWebStoreForTests();
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    delete (globalThis as any).indexedDB;
    try {
      await assert.rejects(saveToken(GATEWAY_ID, 'tok-no-db'), (error: unknown) => {
        assert.equal((error as { code?: string }).code, 'client/store-unavailable');
        return true;
      });
    } finally {
      globalThis.indexedDB = realIndexedDB;
    }
  });
});
