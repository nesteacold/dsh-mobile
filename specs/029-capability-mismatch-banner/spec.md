# 029 — Capability / version mismatch banner

Package: `apps/mobile-companion` (+ read-only use of `packages/mobile-protocol`).
Constitution: "a capability/version mismatch is surfaced to the user, never silent."

## Behaviour
- On `hello`, compare the gateway's protocol revision and advertised capabilities with what the app
  requires/knows (constants exported from `packages/mobile-protocol`).
- Major protocol mismatch: blocking banner "This app and the computer's gateway are incompatible
  (app vX, gateway vY). Update the older one." No session actions are sent.
- Gateway newer minor / unknown capabilities: non-blocking info banner, dismissible per gateway
  revision.
- Gateway older / missing a capability a feature needs (e.g. web push, passkey, attachments):
  that feature's UI is hidden or disabled with a short reason; a single banner lists missing ones.
- Strings vi/en. Pure decision logic in `src/core/` with unit tests; UI in the home/settings screens.

## Contract gap (lead, 2026-11-14)
The contract advertises a capability only for web push. `passkey` and `attachments` have no
capability flag, so per-feature gating for them waits on a protocol minor revision that adds
`OPTIONAL_CAPABILITIES` entries for both (follow-up spec).

## Tests
Unit: equal, newer minor, older minor missing capability, major mismatch both directions, malformed hello.
E2E flow structural check updated if a hook id is added.
