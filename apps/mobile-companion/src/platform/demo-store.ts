// Spec 032 — the demo mode's OWN host/credential lifecycle: an in-memory store, never the device's.
//
// WHY THIS EXISTS (a reviewer reads this file second): in screenshot mode the controller must
// produce the same user-visible states — paired, revoked, forgotten, failed pair — WITHOUT
// touching anything real. The device's secure store holds the keychain credential of every real
// pairing and the host list beside it; a demo revoke or forget that ran the real wipe path would
// read, verify and DELETE that entry (`forgetHost` → `deleteToken` reads the key back) and rewrite
// `dsh-companion.hosts`. The first review found exactly that: `deleteCredentialInstance` still
// reached `forgetHost` for a revoked or forgotten demo pairing.
//
// THE RULE, in one sentence: in demo mode EVERY host-list read/write and EVERY credential
// read/write/delete goes through this object, which lives in memory only and dies with the
// process. `src/app-state.ts` never calls `readHosts`/`saveHost`/`forgetHost`/`readToken`/`saveToken`
// while `this.screenshotMode !== null`; it holds a `DemoStore` instead.
//
// The credential is still the fixture's own token and still kept in memory only: `saveToken`
// records it here, and `hasToken` is its only read (the real transport never needs one after a
// `paired` frame because the controller presents the stored demo token). There is no keychain,
// no file and no network here.

import { PAIRED_HOST_SCHEMA_VERSION, type PairedHost } from '../core';

/** The demo store the controller uses in screenshot mode (one per controller instance). */
export interface DemoStore {
  /** The in-memory host list (a copy: a caller can never mutate the store's array). */
  hosts(): PairedHost[];
  /** Replace the list after a pairing/removal (the demo equivalent of `writeHosts`). */
  saveHost(host: PairedHost): PairedHost[];
  /** Drop this host and its credential (the demo equivalent of `forgetHost`). */
  forgetHost(gatewayId: string): PairedHost[];
  /** Remember the fixture's token for this gateway (never the secure store). */
  saveToken(gatewayId: string, token: string): void;
  /** True while a credential exists for this host in memory. */
  hasToken(gatewayId: string): boolean;
  /** The demo credential for this gateway, in memory (presenting it is the controller's job). */
  token(gatewayId: string): string | null;
  /** Drop every credential (a lock/stop boundary), leaving host records as the caller left them. */
  dropCredentials(): void;
}

/** The fields a demo host record may carry: the app's own record type, re-checked on the way in. */
function isUsableRecord(entry: unknown): entry is PairedHost {
  return typeof entry === 'object'
    && entry !== null
    && typeof (entry as PairedHost).gatewayId === 'string'
    && (entry as PairedHost).schemaVersion === PAIRED_HOST_SCHEMA_VERSION;
}

/**
 * Empty, or seeded with the records a previous demo pairing wrote (the caller passes its own list;
 * nothing is read from the device). Records that are not a `PairedHost` are dropped, exactly like
 * `readHosts` drops malformed entries.
 */
export function createDemoStore(seed: readonly PairedHost[] = []): DemoStore {
  let hosts: PairedHost[] = seed.filter(isUsableRecord).map((entry) => ({ ...entry }));
  const tokens = new Map<string, string>();

  return {
    hosts: () => hosts.slice(),
    saveHost: (host) => {
      hosts = [host, ...hosts.filter((entry) => entry.gatewayId !== host.gatewayId)];
      return hosts.slice();
    },
    forgetHost: (gatewayId) => {
      hosts = hosts.filter((entry) => entry.gatewayId !== gatewayId);
      tokens.delete(gatewayId);
      return hosts.slice();
    },
    saveToken: (gatewayId, token) => {
      tokens.set(gatewayId, token);
    },
    hasToken: (gatewayId) => tokens.has(gatewayId),
    token: (gatewayId) => tokens.get(gatewayId) ?? null,
    dropCredentials: () => {
      tokens.clear();
    },
  };
}

/**
 * Spec 032 — the demo-mode credential the controller presents when it has not yet received the
 * fixture's per-run token from a `paired` frame (a reconnect before the fixture is re-paired). It
 * is a fixed, public fixture value (`e2e/harness/gateway.mjs` accepts nothing else) and is NOT a
 * secret of any real Host.
 */
export const DEMO_GATEWAY_TOKEN = 'e2e-fixture-token';