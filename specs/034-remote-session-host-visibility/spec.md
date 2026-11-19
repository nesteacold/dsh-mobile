# 034 — Remote-created session visible in the Host's own sidebar

Status: draft (owner agreed to spec 2026-11-15). Packages: `plugins/devices` (primary), possibly
`plugins/mobile-gateway` (`remote-bridge.mjs`). Phase 0 is investigation only; no code before the
cause is measured.

## Problem (reported 2026-11-15)

A session created from a remote client, seen locally as
`h:0f0eca3e-d956-493c-8ec8-115faa4e5dbb:session-c16ec33c-e1c6-4c4e-b0c8-e41752c8fef0`, does not
appear in the chat list of the Host that owns it (`0f0eca3e-…`). The device holds full scopes
(owner statement), so scope gating is not the cause.

## Hypotheses (not yet measured)

- H1 (c, most likely). The session was created without a `workspaceId`. With `workspace:manage` the
  remote bridge accepts `session/create` with only `cwd` (`plugins/mobile-gateway/lib/remote-bridge.mjs`
  444-496, (b)). The Host then has the session in `session/list` but in no `workspace.sessionIds`
  (the only session→workspace relation, `plugins/mobile-gateway/lib/index.mjs` 1228-1233, (b)), and
  the workspace-grouped sidebar may not render it.
- H2 (c). The session is a subagent child (`origin:'subagent'`) and hidden as a root row by design.
- H3 (c). The Host UI missed the add event; a reload shows it.

## Phase 0 — measure (beastcore/scout, read-only)

1. On the Host: is `session-c16ec33c-…` in owner `session/list`? its `origin`, `parentSessionId`, `cwd`.
2. Is it in any workspace's `sessionIds` (owner `workspace/list`)?
3. Does it show after a Host UI reload? Is it reachable by direct URL?
4. Read the exact `session/create` args `plugins/devices` forwards for a new remote session
   (composer "new chat" in a remote workspace) — is `workspaceId` present and un-namespaced?
5. Read installed DSH 0.2.2-rc.3 sidebar code: does it list sessions outside any workspace?
Record each answer labelled (a)/(b)/(c) in this file before Phase 1.

## Phase 0 findings (beastcore, 2026-11-15, read-only)

- Item 4 (b): `plugins/devices` forwards `session/create` as `{workspaceId:<Host id, h:-prefix
  stripped>, sessionId?, agentPreset?}` (`host-router.mjs` 99, 681, 1561-1573, 1617-1632, 1718-1720);
  DSH UI `createNamed` always sends `workspaceId`. Companion sends `session-create {workspaceId}`
  (`app-state.ts` 3725; gateway `query-handlers.mjs` 457-471, 1160-1188).
- Item 5 (b), installed DSH 0.2.2-rc.3: `SessionController.create` attaches when `workspaceId` is
  given (`dsh-api-session-controller/lib/index.js` 724-756); cwd-only is not attached (only the
  one-time `bootstrap()` groups by path). The sidebar shows unattached sessions under "Ungrouped"
  (`groupByWorkspace`, `UngroupedProjectRow`). `sessionVisible` hides `origin==='subagent'`,
  archived (default filter), and **blank sessions that are not the current one**.
- Verdict: H1 refuted for the known create paths and for the standard sidebar (b). New lead:
- H4 (b→c, most likely). The session has no prompt yet, so it is `blank` and hidden on every window
  except the one that has it open. Check: has `session-c16ec33c-…` received any message?
- Still unmeasured (a): Host-side items 1-3.
- Owner 2026-11-15: session has messages and shows on the remote client → H4 ruled out.
- Round 2 (beastcore, b): `blank` is cleared only by `turn/start` in the session log, regardless
  of peer (`dsh-api-session-controller/lib/types/list.js:29`); `api-session/*` events are emitted
  globally and filtered only on the way OUT to non-owner peers (`dsh-api-remotes/.../remote-events.js`
  11-23), so the Host's own UI receives them; `origin` type is only `'subagent'`; no plugin passes a
  hiding flag. `session/create` with a `sessionId` matching a reusable blank session returns that
  session (`index.js:738`). Remaining causes (c): stale Host UI state (fixed by reload), collapsed
  workspace group, archive filter, sidebar search, or the two sides showing different session ids.
- Decisive check (a) pending: Host `session/list` row for `session-c16ec33c-…` and `workspace/list`.

## Requirements (apply only if H1 is confirmed)

- R1. A session created on a remote Host through `plugins/devices` (or the companion app) is attached
  to a Host workspace, so it appears in the Host's own sidebar under that workspace.
- R2. When the client creates inside a remote workspace, the forwarded `session/create` carries that
  workspace's Host-side id (namespace `h:<hostId>:` stripped). No new path or wildcard grant.
- R3. When no workspace is given (cwd-only create, `workspace:manage` devices), the Host's own
  default rule applies; if DSH leaves the session unattached, attach it to the workspace whose path
  equals `cwd` when exactly one exists, else leave it and surface nothing silently wrong.
- R4. Local sessions and DSH behaviour unchanged; no DSH core patch; no weakening of authorization
  (`checkArgumentsWithHost` still fails closed).
- R5. Contract-first: if the companion wire `session-create` changes, edit `packages/mobile-protocol`
  first and sync the gateway's vendored copy.

## Verification

- Unit: `plugins/devices` test that remote `session/create` forwards the stripped `workspaceId`;
  gateway test for R3 attach rule.
- Live: create a chat from the remote client, confirm it appears in the Host sidebar under the
  workspace without reload; record time and evidence here.
- Gates: `plugins/devices` `npm test`; `plugins/mobile-gateway` `npm test`, `npm run check:protocol`;
  reviewer pass (touches the remote bridge).

## Out of scope

Pagination of the merged list; model picker issues (tracked separately).
