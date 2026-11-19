# Spec 048 — Make the Android portrait hardware feature optional

**Package**: `apps/mobile-companion` (Expo config + Android manifest) · **Status**: owner-reported Play issue 2026-11-19 · **Owner message**: "Lỗi" with the Play Console screenshot.

## Problem (observed in Play Console, release `4 (0.1.0)`)

Google Play reported:

> Required hardware feature declarations are restricting your app's availability.
> `android.hardware.screen.portrait` affects Phone, Tablet, Desktop, and Android XR users.
> To expand your app's availability, mark non-essential hardware features as optional in your app's manifest.

Cause (b, read from source): `apps/mobile-companion/app.json:6` declares `"orientation": "portrait"`,
which Expo translates into a required `android.hardware.screen.portrait` manifest feature. The app is a
phone companion; the orientation lock itself is intentional, but the hardware-feature requirement is
not essential for installation.

## Scope

- Keep `"orientation": "portrait"` in `app.json` — no UX change, no landscape support work.
- Add a small Expo config plugin under `apps/mobile-companion/plugins/` that uses
  `withAndroidManifest` to set `<uses-feature android:name="android.hardware.screen.portrait" android:required="false" />`
  (creating the node if Expo did not emit one). Follow the style/licence header of
  `plugins/withAndroidReleaseSigning.js`; register it in `app.json` `expo.plugins`.
- Bump `android.versionCode` from **4** to **5** in `app.json` (Play has consumed 2 and 3 by failed
  uploads; the current draft uses 4, so a fresh AAB needs 5). Do not change `version` or iOS settings.
- Add a source-based unit test asserting the plugin sets `android:required="false"` for the exact
  feature name and preserves other manifest entries. Use the existing test style; no renderer.
- No gateway/protocol/contract/pairing/TLS/auth changes. No new dependencies.

## Gates

From `apps/mobile-companion`: `npm run typecheck`, `npm run check:core`, `node e2e/check-flows.mjs`,
the full unit suite, and `EAS_BUILD_PROFILE=production npx expo config --type prebuild --json` with
assertions `versionCode=5`, `screenshotMode=false`, and the new plugin registered. Repo root:
`node tools/verify-publish.mjs`, `node tools/scan-pii.mjs`.

## Acceptance

- A signed AAB built from the committed tree shows, in its manifest,
  `uses-feature android:name="android.hardware.screen.portrait" android:required="false"` and
  `versionCode=5`.
- A fresh Play production draft with that AAB no longer shows the hardware-feature issue; if it still
  does, report exact wording rather than clicking "Proceed anyway" without an owner decision.
- Do not cancel/restart the existing in-review release #1 (owner decision 2026-11-18).

## Status
Spec written 2026-11-19. No code yet.
