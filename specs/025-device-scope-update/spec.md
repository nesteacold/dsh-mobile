# 025 — Owner-side scope update for a paired device

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
  here (passkey flow owns it).
- R3. The change is persisted atomically with the device record; the credential is unchanged.
  Live sockets of that device: on `remove`, close with the contract's revoke/re-auth close code so
  the next connection carries the new scopes; on `add`, same (simplest correct behaviour).
- R4. Audit line without secrets: device id, added/removed scope names.
- R5. Devices page: per-device "Permissions" editor listing scopes with checkboxes, explicit
  confirm; shows a hint on devices missing `attachments:write`. vi + en.
- R6. No contract (wire) change: this is an owner-side HTTP route, not a device frame.

## Acceptance
- Proxied / non-loopback / foreign-origin requests → 403, record unchanged.
- Unknown scope, wrong-kind scope, `web:unlock` → 400.
- Add `attachments:write` to an old desktop record → an upload that was refused now succeeds after
  reconnect (gateway test), record persisted across plugin restart.
- Remove a scope → live socket closed; reconnect lacks the scope.
- Gates of both packages green.
