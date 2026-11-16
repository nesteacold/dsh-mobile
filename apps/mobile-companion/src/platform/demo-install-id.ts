// Spec 032 — the demo mode's install id: in memory, never the device's keychain.
//
// WHY THIS EXISTS: the install id (`src/platform/install-id.ts`) is read from and written to
// expo-secure-store on first use. An unsigned Release build on an iOS simulator has no Keychain
// entitlement, so that read throws (errSecMissingEntitlement) and — before this module existed —
// `AppController.pair()` turned the plain Error into `client/bad-message` before any socket. The
// demo mode promises that NO path touches the secure store (spec 032, amended 2026-11-16), so it
// takes its install id from here instead: one random UUID v4 per demo controller, kept in memory
// only and dies with it.
//
// The id is not a credential (contract §3.2: it only lets a Host reuse the trusted-device record),
// and the fixture mints a fresh device for every demo pairing anyway, so a per-run value is the
// honest one: nothing stable about a screenshot run should survive the process.
//
// `expo-crypto` is the same source the real install id uses (`Crypto.randomUUID()`), so this adds
// no dependency and keeps the id the 36-char UUID v4 shape the core and the gateway expect.

import * as Crypto from 'expo-crypto';

/** The install id of ONE demo controller — random, in memory, never persisted. */
export function createDemoInstallId(): string {
  return Crypto.randomUUID();
}
