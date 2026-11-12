# 019 — Permission control: view + lower-only (owner-approved for Wave 3)

Source facts: `docs/arch-notes/agent-permission-lower-survey.md` (all (b), read from rc.1 source).

## Decision (lead)

- **View**: the current preset name is already in `session/list` rows as
  `projections.values.permissions.currentValue` (may be `kind:'cached'`). The app shows it; no new op,
  scope `sessions:read`.
- **Lower**: new op `permission-lower {sessionId, preset}` under a NEW never-default scope
  `permission:lower` (in the `full` preset only). Never reuse `commands:execute`; the app never sends a
  command string.

## Gateway rules (fail closed)

1. Session must be visible to the device (session resource, same rule as `session/prompt`).
2. Use the in-process cordis service `permissionPresets` (`current`, `resolve`, `set`), not
   `commands/execute`. If the service is absent or its shape differs: refuse `unavailable`.
3. In ONE synchronous block: `cur = current(session)`; `from = resolve(cur)`; `to = resolve(preset)`;
   compare; `set(session, preset)`. No `await` between read and write.
4. Order: sandbox `read-only` < `workspace-write` < `danger-full-access`; approval `ask` < `never`.
   Accept only if `to` is no looser on BOTH axes and stricter on at least one. Otherwise
   `accepted:false, reason:'not-stricter'`.
5. Refuse `custom-current` when current is `custom`, `auto`, unknown, or unresolvable; refuse
   `bad-request` when target is `custom`/`auto`/unknown.
6. Re-read after write; if it is not `preset`, reply `reason:'raced'` (no retry).
7. Write an audit log line (device id, session id, from, to); no command strings.
8. Errors to devices use fixed per-code messages, never Host text.
9. `hello.capabilities` lists `permission-lower` only for devices holding `permission:lower`.

## App

Session header chip shows the current preset. Tap ⇒ sheet listing only presets the app can see as
stricter (from the catalog the gateway returns with the op's `permission-options` read, filtered by the
gateway, which sends each option's `{sandbox, approval}` pair). Looser options are not shown. Confirm
dialog. Chip hidden without the capability or without a `permissions` projection.

Read op: `permission-options {sessionId}` (scope `permission:lower`) ⇒ current preset plus the list of
strictly-stricter presets with their pairs, computed by the gateway.

## Required tests

Lower accepted; equal refused; looser refused; mixed axes refused; custom/auto current refused; unknown
target refused; session not visible refused; no scope refused; capability gating; Host text not leaked;
service missing ⇒ unavailable. Negative control for each check. Reviewer mandatory.

## Residual risk

Host has no compare-and-set; atomicity relies on `current`+`set` being synchronous in one JS turn
(inferred). Internal service is unversioned: a DSH bump needs a re-check (pinned 0.2.2-rc.1).
