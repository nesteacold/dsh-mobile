# Tasks 005

## Phase 1: gateway + protocol (coder)
- [x] D001 mobile-protocol: DeviceKind, Scope, SCOPES, `auth/forbidden-scope`, revision bump, d.ts (FR6)
- [x] D002 devices.js: kind/scopes on the record + migration of legacy records (FR1, T3)
- [x] D003 index.mjs: msg.type→scope map, fail-closed dispatcher check (FR2, T1 T2 T6)
- [x] D004 pairing offer kind/scopes + pairing string; hello and /mgw/devices expose them (FR3 FR4, T7)
- [x] D005 Origin allowlist on WS upgrade (FR5, T4); revoke test for desktop (T5)
- [x] D006 reviewer: PASS on 2026-11-09 after 2 FAIL rounds (empty-scope widening, re-pair widening, missing-record fail-open, delayed-activation race; all fixed, T8/T9 added). Open items: RTC delayed activation and Windows ACL are verified only by source reasoning. Scope map decision: read ops→sessions:read, message/session-cancel→prompt:send, approval-response→approval:respond, device-forget exempt.
- (was) D006 reviewer: security review of D002–D005

## Phase 2: apps/desktop-companion
Lead decision 2026-11-09: no Rust toolchain on this machine (cargo/rustc are absent; Node 24 is present), so Tauri is dropped.
The desktop client is a **Node CLI + local bridge** running on the *controlling* computer:
- It holds the pinned WSS connection to the Host: the `certSha256` from the pairing string is checked in `checkServerIdentity`, so a mismatch sends 0 bytes.
- It stores the device token in a per-user file: 0600 permissions, and on Windows an ACL restricted to the current user. DPAPI comes later.
- It serves a minimal UI on **127.0.0.1 of the controlling machine only**, guarded by a random per-launch bearer and an Origin check. A browser therefore never talks to the Host directly, and the pinning is kept.
- No Node runs on a phone, so this does not conflict with the hard boundaries.
- [ ] D010 `apps/desktop-companion` (`@dsh-ext/desktop-companion`, private, zero runtime deps beyond `ws` if the gateway already uses it): `pair <pairingString>`, `status`, `serve`, `forget`.
- [ ] D011 Pinned transport + hello/kind/scopes display; reconnect; close 4401 → token wiped.
- [ ] D012 Local UI: sessions list, history, send prompt, pending approvals allow-once/reject (argsHash echo); scope-aware buttons.
- [ ] D013 Tests: pin mismatch sends nothing; local UI rejects missing bearer and foreign Origin; it binds 127.0.0.1 only; token file perms; end-to-end against a gateway started in-process (pair → sessions → approval).
- [ ] D014 reviewer security review; README usage (`dsh-ext/apps/desktop-companion/README.md`).
