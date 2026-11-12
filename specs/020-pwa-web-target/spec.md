# Spec 020 — PWA web target for mobile-companion (owner-approved 2026-11-11)

Goal: one RN-Expo codebase runs on Android, iOS and Web (installable PWA). Web avoids store review.

## Owner decisions
- Transport: HTTPS/WSS with a trusted Tailscale certificate (`*.ts.net`), tailnet-only. Not exposed publicly.
- Push: simple Web Push (ids/short text only, per constitution). iOS needs 16.4+ and Add-to-Home-Screen.
- Project rules apply: no WebView wrapping of apps/web/dist; native targets unchanged; contract-first.

## Requirements
1. `npx expo export --platform web` builds; app shell, list, conversation, Markdown, settings work in Chrome + Safari.
2. Platform shims (`*.web.ts`) for: secure storage, FlashList (if broken), file picker, share, haptics. Native code paths unchanged.
3. Token storage on web: IndexedDB with a non-extractable WebCrypto AES-GCM key; documented weaker than Keystore. REVIEWER MANDATORY.
4. Manifest + service worker (offline shell only; never caches API/WS traffic or tokens).
5. Pairing on web via the same QR/code flow (manual code entry if no camera).
6. Gateway: serve over Tailscale cert (`tailscale cert`), origin allowlist for the PWA origin; Web Push endpoint registration under a new never-default scope `push:web`. Adversarial tests. REVIEWER MANDATORY.
7. Gates: existing app/gateway gates stay green + web build + Playwright/screenshot evidence (a).

## Out of scope
Public internet exposure; store-like distribution; full offline mode.
## Web unlock (owner 2026-11-11: "unlock requires successful DeepSeek account sign-in")
PWA unlock = Host-attested DeepSeek sign-in. DeepSeek exposes no public OAuth/OIDC (API key only, checked 2026-11-11). Gateway reads `account/getState` (owner-only; plugin access to be measured) and exposes only a boolean plus an optional HMAC fingerprint of the account id (pinned at pairing; mismatch => lock); it re-locks on `deepseek-account/signed-out` / `session-expired` and refuses device RPCs server-side while locked. The app never handles DeepSeek passwords, tokens, API keys, or the raw userId. Fallback if plugins cannot call account/*: Host-side confirmation challenge in the desktop UI. REVIEWER MANDATORY.
## Port (owner 2026-11-11)
Tailscale port 443 is already used by Tàng Thư Các. The DSH PWA and its gateway WSS must use a different HTTPS port on the same `*.ts.net` name (proposal: 8443 via `tailscale serve --https=8443`; gateway WSS keeps its own port). CSP/transport must allow explicit ports: `connect-src 'self' wss://*.ts.net:*`; PWA origin includes the port, so the gateway Origin allowlist must match `https://<host>.ts.net:8443` exactly. Never take over 443.
## Web unlock — measured 2026-11-11 (packaging, read-only)
- (b) Plugin (owner peer) may call `account/getState` -> `{status:'signed-out'|'credential-stored', links, attempt}` and `account/getProfile` -> `{status:'ready'|'failed', value:{id,name,contact,avatarUrl?}}` (dsh-api-remote-access/lib/index.js:224-226). Device peers are denied by default; never grant `account/*` to devices.
- (b) Events `deepseek-account/session-expired` and `deepseek-account/signed-out` are emitted via ctx.emit and subscribable with ctx.on; `account/watchExpiry` is a stream.
- Design: unlocked iff getState.status==='credential-stored' AND getProfile.status==='ready'; fingerprint = HMAC(gateway secret, profile.id) pinned at pairing; re-lock on events. Host-side challenge fallback dropped. Scope for the device op: new never-default `web:unlock` (desktop issues; web PWA only).