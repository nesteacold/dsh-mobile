# Audit Clarklevis1995 dsh-mobile + mobile-gateway (2026-11-08)

- Auditor: beastcore (`cc/claude-opus-5-5`), read-only, clone --depth 1 in %TEMP% (deleted). No build/run.
- App `Clarklevis1995/dsh-mobile` @ `3ec49d69f65c873db113ac8fc061df2c74154b29`
- Gateway `Clarklevis1995/dsh-plugin-mobile-gateway` v0.12.0 @ `74ac444c7ff0ef396cd3680e8f49b178e1b32928`
- Labels: (a) measured, (b) read from source, (c) inferred. Auditor did not read constitution/spec;
  constitution mapping below is by lead.

## Verdict: ĐẠT CÓ ĐIỀU KIỆN (pass with conditions)

## Passes
- Gateway is a proper Cordis plugin (`webServer.register` + Host Remote Gateway invoke); no core patch,
  no direct session-file reads (index.mjs:2802; dsh-host-adapter.mjs:96) (b).
- Pairing: 32-byte code stored hashed, TTL 5 min, single use (devices.js:14,122-145) (b).
- Token per device, 32 bytes, stored as SHA hash, `timingSafeEqual` (devices.js:24,146,163,177) (b).
- Revoke isolates one device and closes its WS/RTC (devices.js:214-221; index.mjs:3013-3022) (b).
- Pair/revoke admin API loopback-only + cross-origin block (index.mjs:2807,2811) (b).
- iOS Keychain `AfterFirstUnlockThisDeviceOnly`; Android AES-GCM key in AndroidKeyStore, data in noBackup (b).
- `gatewayEnabled` default false (index.mjs:234) (b). WebRTC off by default, `ws-only` mode (b).
- Approval from phone works, idempotent (`not-pending` on repeat) (index.mjs:2763-2790) (b).
- No analytics/crash SDKs; no remote push server (Live Activity local only) (b, negative).
- MIT license both; tests present (not run); README targets DSH 0.2.2-rc.1 (matches our pin).

## Failures vs constitution
| ID | Severity | Finding | Constitution |
|---|---|---|---|
| C1 | Critical | LAN listener `0.0.0.0:3081` plain `ws://`, bearer token in clear (index.mjs:271,2155,3347) | III |
| C2 | Critical | API surface too wide: pluginManager install/remove/setVersionExemption, settings.mutate, workspace, schedule (dsh-host-adapter.mjs:210-408) | III, V |
| M1 | Major | No cert pinning; iOS `NSAllowsArbitraryLoads`, Android `usesCleartextTraffic` | III |
| M2 | Major | Approval frame has no content hash (only toolName/callId/reason) | IV |
| M3 | Major | `/mgw/auth` can turn `requireAuth` off (index.mjs:2961) | III |
| M4 | Major | No `engines.dsh`; patch overrides `session-query-sqlite` config row | V |
| M5 | Major | P2P mode defaults STUN to Cloudflare (IP exposure) | — |
| — | Minor | pairingCode via query string; app self-update hits api.github.com + download.whaleness.cc; no CI tests; open issues #27 heartbeat, #43 0.2.2-rc.1 attachments | — |

## Premise correction
iOS client is **native Swift** (213 .swift files), KMP covers Android + shared only (411 .kt).
"Switch stack to KMP" therefore means two UI codebases (SwiftUI iOS + Kotlin Android), not one.

## Required before any device build if forked
1. wss only + fingerprint pin delivered via QR; LAN bind 127.0.0.1 by default (Tailscale/Tunnel for remote).
2. Allowlist narrow `/api/mobile/v1`: sessions list/read/prompt/cancel + approvals; drop pluginManager/settings/schedule/workspace.
3. Hard-lock `requireAuth`, remove the toggle route.
4. Approval bound to sha256(canonical tool args), verified by gateway.
5. Gate on `remoteControl.enabled`; add `engines.dsh: 0.2.2-rc.1`; make sqlite override optional.
6. Remove author update/privacy endpoints, new bundle ids, ATS/network_security_config defaults.

## Open
WebRTC fallback/TURN logic; Android Kotlin log grep; `fallbackApproval` behaviour without client;
app↔gateway protocol pinning (`question-approval-v2` only); real IP-leak measurement.
