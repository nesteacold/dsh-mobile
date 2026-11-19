# 052 — Fix permission-options and agent-team reads over mobile gateway

Status: **proposed — reviewer required (permission scope / host service surface)**.

Measured 2026-11-19 via live PWA pair holding all relevant scopes (`permission:lower`, `sessions:read`,
etc.). Both buttons open their sheets, but the reads fail on the wire:

```text
{ kind:'error', code:'unavailable', requestType:'permission-options',
  message:'this computer cannot change the permission preset for a device' }
{ kind:'error', code:'internal', requestType:'agent-team',
  message:'invalid team projection' }
```

`subagents` succeeds on the same session. So this is NOT a UI dead-tap or scope gap; it is the gateway's
translation of two built-in DSH services.

## Design

1. `permission-options` / `permission-lower`
   - The DSH service is keyed by its actual device-side service name/API, not the old desktop-only
     wording. Trace the running DSH service registry/adapter and use the same route the desktop
     permission control uses, without changing the wire contract.
   - Keep strict scope `permission:lower`, strictly-stricter comparison, audit lines and refusal
     reasons. Do NOT widen to a general settings write.
2. `agent-team`
   - The DSH projection is `ready` but the gateway's validator rejects its shape as “invalid team
     projection”. Accept the actual DSH shape (members/tasks fields may be nested or differently
     named) by normalising at the gateway boundary to the contract's `{members[], tasks[]}`; never
     invent data or drop a `ready` projection into `unavailable`.
   - Keep `subagents` behaviour unchanged.

## Non-goals

- No contract change, no PWA UI change, no new scope, no native change.

## Acceptance

- Gateway tests for both reads against measured shapes; error paths still reject malformed/incomparable
  answers.
- `npm test`, `npm run check:protocol`, `npm run test:package` in `plugins/mobile-gateway`.
- Reviewer APPROVE before deploy.
- Live PWA after deploy: permission sheet lists strictly-stricter presets; team sheet shows members/tasks
  (or an honest `unavailable` only when the Host truly has no projection).
