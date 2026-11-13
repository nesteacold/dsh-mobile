# 028 — One bundle per repo (`dsh-mobile`)

Owner decision 2026-11-13. Touches: repo root packaging, `plugins/*/package.json`, DSH profile.

## Goal
The Plugins page shows our products by repo name: `dsh-mobile`, `dsh-wiki`, `dsh-roles`.

## Design
- New root bundle package `@dsh-mobile/bundle` (display title "dsh-mobile") at
  `dsh-mobile/bundle/`, `dsh.bundle.patch` inserting the plugin rows for `devices`,
  `mobile-gateway`, `sidebar-browser` with the SAME plugin ids, names and config keys they have today,
  so stored config, paired devices and remotes are untouched. Each row stays individually
  toggleable (the gateway can be disabled alone).
- The three plugin packages stay separate packages inside the repo (no code merge); the bundle
  depends on them by `link:`/`file:` path. Their own `dsh.bundle` entries are removed or kept
  inert so DSH does not show them as separate bundles.
- Profile: back up, replace the three `@dsh-ext/*` bundle entries with the single bundle, keep
  `@local/dsh-roles` and `@dsh-ext/dsh-wiki`; remove `@local/dsh-wiki-live-trial` from the profile
  and keep `dsh-wiki/.local-trial` on disk as a backup until the owner deletes it. `check-profile.mjs` must agree.
- Self-update (spec 027) keeps working: it updates the repo checkout, which covers the bundle.

## Verification
Before switching, read DSH's bundle/profile loader (b) to confirm a bundle's patch may insert rows
whose packages are dependencies of the bundle, and that plugin config is keyed by plugin id, not by
bundle. Gates of all three plugins; reviewer pass (gateway exposure unchanged).
