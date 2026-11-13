# 026 — Web Push for the PWA (approval / question alerts)

Packages: `packages/mobile-protocol` (additive frames), `plugins/mobile-gateway`,
`apps/mobile-companion` (web target only). Reviewer mandatory (push + network egress).

## Constraints (constitution)
- Push payloads hold ids and short fixed text only — never prompt text, tool args, paths, tokens.
- Host executes; the service worker only shows a notification and opens/focuses the app.
- Off by default: the gateway makes no outbound request until the owner enables web push in the
  Devices page (it contacts browser push services — a new egress surface).

## Requirements
- R1. Gateway generates a VAPID P-256 key pair on first enable, stored with the same protected-file
  rules as other gateway secrets; private key never leaves the Host, never logged.
- R2. Contract (additive, capability `webPush`): `push-subscribe` { endpoint, keys: { p256dh, auth } },
  `push-unsubscribe`, replies; `hello` carries `webPush: { enabled, vapidPublicKey }` only for web
  devices and only when unlocked. Subscription is stored per device; removed on unsubscribe,
  device revoke/forget, or a 404/410 from the push service.
- R3. Endpoint allowlist: https only, host must match known push services
  (`fcm.googleapis.com`, `*.push.services.mozilla.com`, `*.notify.windows.com`,
  `*.push.apple.com`); anything else refused (SSRF guard). No redirects followed. Timeout 10 s.
- R4. Encryption per RFC 8291 (aes128gcm) + VAPID (RFC 8292) using `node:crypto` only — no new
  dependency unless the reviewer approves one.
- R5. Events: approval pending, question pending, session finished (owner-toggle per kind).
  Payload: `{ v:1, kind, sessionId, requestId? }`. TTL 600 s, urgency high for approvals.
  Rate limit: 30 pushes / hour / device, collapse by `sessionId`.
- R6. App (web): permission prompt only from a user gesture in Settings; `sw.js` handles `push`
  (fixed localized title/body by kind) and `notificationclick` (focus or open `/session/<id>`).
  Locked PWA: notification still shown (it carries no content); opening requires passkey unlock.
- R7. iOS: works only for a Home-Screen-installed PWA; Settings says so. Native apps unchanged.

## Acceptance
- Contract test covers the new frames/capability; vendored copy in sync.
- Gateway tests with a local fake push service: correct VAPID JWT + aes128gcm body decrypts with
  the subscription keys; payload contains only allowed fields; non-allowlisted endpoint refused;
  410 removes the subscription; disabled → zero outbound requests.
- App tests: subscribe/unsubscribe frames, SW push handler renders fixed text, click routes.
- All package gates green; PII scan clean.
