# Agent preset survey (spec 018 — "per-session agent preset")

Author: beastcore, 2026-11-12. Read-only. Labels: (a) measured runtime, (b) read from source, (c) inferred.
No runtime measurement was done; everything below is (b) or (c).
Paths: `UP` = `_upstream/dsh-rc1-extract/dsh/node_modules/@deepseek-ai`, `GW` = `dsh-ext/plugins/mobile-gateway`.

## 1. What an agent preset is

- (b) A preset is a named **plugin composition** (child entry list YAML, `!!js` allowed) mounted in an isolated
  scope; an Agent is bound to one preset generation. `UP/dsh-agent-preset-registry/lib/index.js:511-537`
  (`activate` → `mountPreset(context, id, plugins)`), `:625-647` (`readDocument` dumps the plugin list).
- (b) Declared by the `dsh-agent-preset` plugin via `agentPresets.register(config)`
  (`UP/dsh-agent-preset/lib/index.js:10,25`). Config: `default`, volatile `selectedDefault`
  (`registry/lib/index.js:445-448,471-473`).
- (b) Per-session state is the `agentPreset` projection, init from header, updated by event
  `agent-preset/selected` (`registry/lib/index.js:48-55`, `:466-468`).
- (b) Selecting fires `tools/change` (`:750-758`) → **a preset changes the tool/plugin set the agent runs**.
  It is not a permission preset (separate service `permissionPresets`, separate projection `permissions`;
  see `SessionProjectionMap` in `UP/dsh-api-session-controller/lib/typert.host.js:3712`).

## 2. Remote endpoints

| Endpoint | Shape | Source |
|---|---|---|
| `agentPresets/list` | `{presets:[{id,name?,description?,order?,broken?,isDefault}]}` | (b) `registry/lib/index.js:601-607`; `typert.remote-client.js:41` |
| `agentPresets/read` | `(agentPreset)` → `{agentPreset, content(YAML), name?, description?}` | (b) `:625-647`; `typert:57` |
| `agentPresets/select` | `(agent, agentPreset)` → committed id | (b) `:766-777`; `typert:90` |
| `session/create` | `{workspaceId?, cwd?, sessionId?, agentPreset?}` → `{sessionId, agentPreset?}` | (b) `typert.host.js:2000,2015,3596-3600` |
| session list/projection | `agentPreset: string\|null` | (b) `typert.host.js:96,3712` |

## 3. Can it change after creation?

- (b) Yes, **only while blank**: `select` throws `agent-preset/locked` once `openTurnStartSeq!==null || lastTurn>0`
  (`registry/lib/index.js:768-772`); selections serialized per agent (`switches`, `:767`).
- (b) `session/create` reusing a blank `sessionId` re-applies the requested preset (or default) and logs
  `agent-preset/selected` (`UP/dsh-api-session-controller/README.md:48`; `lib/index.js:364-401`).
- (b) After first turn: immutable. No "change" endpoint for started sessions exists.

## 4. What the gateway already maps

- (b) Frames `agent-presets`, `session-agent-preset`, `select-agent-preset`, `set-default target=agent-preset`
  exist (inherited from Clarklevis, `GW/PROTOCOL.md:1106-1161`); adapter `GW/lib/dsh-host-adapter.mjs:279-285`
  (state + `locked`), `:544-558` (list/select via `agentPresets/select`).
- (b) All four frames are in `ADMIN_ONLY_TYPES` (`GW/lib/allowlist.mjs:89-90`) → never served to a device token.
  `agentPresets/select` is in `COMPANION_DENIED_HOST_ENDPOINTS` (`allowlist.mjs:127`) — second layer.
- (b) `session-create` with `agentPreset` (or `cwd`) without `workspace:manage` → `remote/argument-denied`
  (`GW/lib/index.mjs:2425-2436`; test `GW/test/device-authoring.test.mjs:417-426`). Same rule in the 008 bridge
  (`GW/lib/remote-bridge.mjs:445-455`); bridge allows `agentPresets/list|read` read-only (`:68`) and gates
  `agentPresets/select` behind `settings:write` (`:154,462-463`).
- (b) Gateway forwards `agent-preset/selected` events and `session-agent-preset-updated {agentPreset|locked}`
  (`GW/lib/index.mjs:498,6663`).
- (b) Contract: `packages/mobile-protocol/index.d.ts:284` has optional `agentPreset` on session-create only;
  no catalog/select frames in the companion vocabulary.
- (b) Clarklevis reference **app** is not under `_upstream` (glob found nothing); only its gateway behavior
  survives in `PROTOCOL.md` §agent-preset and `GW/docs/session-agent-preset-app-integration.md`.

## 5. Security implications

- (b→c) A preset = arbitrary plugin composition incl. `!!js` entries → it can **add tools** (shell, network,
  file, delegation) the default preset lacks. Choosing a preset is a capability widening on the tool axis, even
  though permission/sandbox mode is unchanged. (c) Whether any shipped preset has looser tool defaults than the
  default preset is not measured — depends on the user's declared roster.
- (b) Sandbox/approval are governed by the permission projection, not the preset; approvals still flow through
  `argsHash` regardless of preset. (c) A preset could however ship a plugin with its own auto-approve behavior
  (cf. `auto` permission = danger-full-access, `GW/lib/permission-lower.mjs:157-158`); unverified per preset.
- (b) `readDocument` returns full YAML incl. `!!js` — may leak host paths/config; do not forward to phones.
- (b) `set-default` is global and volatile settings write — out of companion scope.
- (b) `broken` diagnostic strings may contain host paths (`:532-535,549-559`) — redact or drop.

## 6. Proposed minimal safe design (for lead decision)

Tiers, smallest first:
1. **View-only (recommended v1)**: expose the session's current `agentPreset` + `locked` read-only (already in
   session list `agentPreset`, `PROTOCOL.md:692`). No new scope. Show `name` from `agent-presets` list only if a
   sanitized list frame (id, name, description, isDefault; drop `broken` text → boolean) is added under a read scope.
2. **Choose-at-create**: allow `agentPreset` on `session-create` for devices holding a new never-default scope
   (e.g. `agent-preset:select`) instead of `workspace:manage`; gateway checks: id ∈ fresh `agentPresets/list`
   (no cache), not `broken`, optional owner allowlist of preset ids per device; audit line (device, session, preset).
3. **Change while blank**: `select-agent-preset` under the same scope; gateway pre-checks `session-agent-preset`
   `locked===false`, relies on Host `agent-preset/locked` as authority, maps errors to normal receipts.
   Never allow `set-default`, `agentPresets/read`.
- Keep both layers (router allowlist + adapter denied endpoints) in step; host-side lock is the final guard.
- Do not let a phone widen tools silently: (c) owner-curated per-device allowlist of preset ids is the
  narrowest API; default empty.

## 7. Proposed source-of-truth paragraph

> Agent preset (DSH rc.1) = per-session plugin/tool composition, selectable only before the first turn
> (`agent-preset/locked` after). Independent of permission presets. Companion: view-only by default;
> any selection needs a dedicated never-default scope, a fresh-roster check and audit; `set-default` and
> `agentPresets/read` stay desktop-only.

## 8. Uncertain

- (c) Actual tool differences between presets in the owner's profile — not measured.
- (c) Whether `agentPresets/select` Remote signature takes `agentId` == sessionId in all cases (adapter assumes so,
  `dsh-host-adapter.mjs:555`).
- (c) `modeSelectionEnabled` semantics in rc.1 (`PROTOCOL.md:1120`) not re-verified.
