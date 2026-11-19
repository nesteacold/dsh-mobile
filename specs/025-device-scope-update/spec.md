# 025 — Owner-side scope update for a paired device

> Policy precedence (spec 045, owner-directed): legacy `web:unlock` scope descriptions below do not re-enable a passkey gate on browser/PWA sockets. Scope edits remain Host-authorized and kind-filtered. Native offers from spec 050 explicitly omit the PWA-only scope; no existing grant is widened automatically.

Packages: `plugins/mobile-gateway` (route), `plugins/devices` (Devices page UI). Reviewer mandatory.

## Problem
Scopes are fixed at pairing. A record paired before spec 013 lacks `attachments:write`; the only
remedy is to re-pair.

## Requirements
- R1. `POST /mgw/devices/:id/scopes` body `{ add?: string[], remove?: string[] }` on the management
  listener only. Guards, in order: not proxied / loopback authority (`isNonLocalRequest`),
  `assertTrustedLocalAuthority`, same-origin, JSON body. Never reachable from a device socket.
- R2. Only scope names known to the contract are accepted; unknown → 400. Scopes not valid for the
  record's `kind` (per existing scope/kind rules) → 400. `web:unlock` cannot be added or removed
  here (passkey flow owns it), with one exception (amendment A1 below): it may be **removed**
  from a `kind: desktop` record.
- R3. The change is persisted atomically with the device record; the credential is unchanged.
  Live sockets of that device: on `remove`, close with the contract's revoke/re-auth close code so
  the next connection carries the new scopes; on `add`, same (simplest correct behaviour).
- R4. Audit line without secrets: device id, added/removed scope names.
- R5. Devices page: per-device "Permissions" editor listing scopes with checkboxes, explicit
  confirm; shows a hint on devices missing `attachments:write`. vi + en.
- R6. No contract (wire) change: this is an owner-side HTTP route, not a device frame.

## Acceptance
- Proxied / non-loopback / foreign-origin requests → 403, record unchanged.
- Unknown scope, wrong-kind scope, `web:unlock` → 400, except removing `web:unlock` from a
  `kind: desktop` record (A1), which succeeds.
- Add `attachments:write` to an old desktop record → an upload that was refused now succeeds after
  reconnect (gateway test), record persisted across plugin restart.
- Remove a scope → live socket closed; reconnect lacks the scope.
- Gates of both packages green.

## Amendment A1 — desktop records holding `web:unlock` (2026-11-15)

Measured on the owner's Host 2026-11-14: a `kind: desktop` OTP offer built from the "full" preset
granted `web:unlock`; a socket holding it is locked until a passkey is registered, which a desktop
never does, so every remote-bridge frame from that desktop was refused `auth/locked`
(`reason=unregistered`) and the remote sidebar stayed empty. The contract now declares
`MOBILE_ONLY_SCOPES = ['web:unlock']` and `scopesForKind(kind)` (additive). Approved by the lead as
part of the owner's request to fix this bug:

- A desktop offer, approval or scope update can never **grant** `web:unlock`.
- The passkey lock is armed by what the record's kind may hold: a `kind: desktop` record is never
  locked by `web:unlock`; every other kind (mobile, missing → mobile, web/PWA) keeps the lock until a
  passkey assertion, unchanged. Unknown explicit kinds are rejected at load.
- Load migration: the registry drops `web:unlock` from `kind: desktop` records, logs device id,
  kind and the dropped scope (no secrets), and persists atomically. This is an authorization-policy
  repair, not a revocation: the credential and its generation are unchanged.
- R2 exception: the owner may **remove** (never add) `web:unlock` from a `kind: desktop` record
  through this route.
