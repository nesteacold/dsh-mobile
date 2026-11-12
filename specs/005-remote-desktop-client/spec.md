# Feature 005 — Remote desktop client (Qoder-style)

Status: Draft (lead, 2026-11-09). Touches: `plugins/mobile-gateway`, `packages/mobile-protocol`,
new `apps/desktop-companion` (Phase 2).
Decision: owner chose "new spec on the existing gateway" (keeps Option A; no new base repo).
Grounding: beastcore R&D 2026-11-09 (facts (a) cite `plugins/mobile-gateway/lib/index.mjs`, `devices.js`, `tls.mjs`).

## Goal
Another computer controls this DSH Host the way the phone does: pair once, see sessions, send prompts,
approve tool calls. The Host keeps its device list and can revoke a device. The Host stays on 127.0.0.1
unless `lanEnabled` + TLS + per-device auth + `remoteControl.enabled` all hold, as it does today.

## User stories
- US1 (P1): On the Host's loopback admin page I issue a pairing offer for a **desktop** device with chosen
  scopes. I get a copy-paste pairing string (no camera on desktop) as well as a QR.
- US2 (P1): The paired desktop sees sessions, sends prompts and answers approvals only within its scopes.
  A message outside its scopes is refused with `auth/forbidden-scope`. Nothing runs.
- US3 (P1): The device list shows `kind` + `scopes`; revoke closes the desktop's sockets at once.
- US4 (P2): Desktop client app (Tauri) pins the gateway cert SHA-256 like the phone does and keeps the token in the OS keychain.

## Functional requirements
- FR1 Device record gains `kind: 'mobile'|'desktop'` and `scopes: Scope[]`. Records already stored load as
  `mobile` with every scope, so existing phones keep working.
- FR2 Scopes: `sessions:read`, `prompt:send`, `approval:respond`, `files:read`, `files:write`,
  `settings:write`. The gateway maps each inbound `msg.type` to one scope. A `msg.type` with no mapping is
  refused (fail closed).
- FR3 A pairing offer carries `kind` + `scopes`, which the device record keeps. Desktop offers default to
  `sessions:read, prompt:send, approval:respond`. Pairing string = the QR payload encoded as base64url.
  It carries the same single-use code with the same TTL, and the same `certSha256` binding.
- FR4 The `hello` reply and `GET /mgw/devices` include `kind` + `scopes`.
- FR5 WS upgrade Origin check: a request with no Origin header is allowed (native client). A request
  whose Origin is not in the `allowedOrigins` config (default empty) is answered 403 before the upgrade.
- FR6 `mobile-protocol`: add `DeviceKind`, `Scope`, `SCOPES`, error `auth/forbidden-scope`. Bump the
  contract revision and update the d.ts files.
- FR7 No browser client in this spec. A browser cannot pin the cert, and serving a web UI widens the
  listener's attack surface. Revisit only with an owner-approved internal CA.

## Non-goals
Internet relay or accounts (the ds-harness-remote model); P2P/iroh; a gateway-served web UI; changes to DSH core.

## Acceptance tests (gateway)
T1 Scope allowed vs refused for each mapped type. T2 An unmapped type is refused. T3 A legacy record migrates to
mobile with every scope. T4 A foreign Origin gets 403 on upgrade, a missing Origin is allowed. T5 Revoking a desktop
closes its socket. T6 Approval replay works for a device holding `approval:respond`. T7 A pairing string
round-trips to the QR payload; an expired or used code fails. Every existing test still passes.

## Security
The reviewer must review FR1–FR5 before merge (CLAUDE.md: auth/pairing/network code).
