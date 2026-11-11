# Feature 011 — A paired device may create a session and pick a model

Status: Draft (lead, 2026-11-10). Owner decision 2026-11-10: "bổ sung frontend và API còn thiếu",
scope **both** phone and desktop, new permission **off by default**, granted per device.
Reviewer pass mandatory (this widens what a remote device may do on the Host).

## Why

The Clarklevis mobile UI (ported in another session, `_upstream/Clarklevis1995__dsh-mobile`) has a
workspace picker, a "create session" button and a mode/model selector. Our gateway refuses all three,
and that is **our** hardening, not an upstream gap:

- Upstream v0.12.0 (our fork base `74ac444`) implements the mobile message types `workspaces`,
  `session-create`, `workspace-create`, `models`, `select-model`
  (`_upstream/Clarklevis1995__dsh-plugin-mobile-gateway/lib/index.mjs:1549, 1533, 1740, 1753, 1858`).
- Our contract refuses them before the handler: `SCOPE_BY_TYPE` lists no such type, and an inbound
  type absent from that map cannot be scoped and stays refused (`packages/mobile-protocol/src/index.mjs:198-216`).
- Our phone allowlist maps exactly eight session methods and no `workspace/*`
  (`plugins/mobile-gateway/lib/companion-access.mjs`), and the second layer denies
  `workspace/create`, `session/create`, `session/fork`, `session/rename`, `session/selectModel`
  (`plugins/mobile-gateway/lib/allowlist.mjs:110-120`).
- The **desktop** path is already further along and is not the gap: the remote bridge implements
  `session/create` gated by `workspace:manage` (workspaceId must be an existing workspace of that
  Host) and `session/selectModel` gated by `settings:write`
  (`plugins/mobile-gateway/lib/remote-bridge.mjs:347-401, 110`). What it lacks is a UI for it.

Measured consequence for the owner: a phone paired with every scope still cannot show workspaces,
create a session or choose a model, so the ported UI cannot match the reference app.

## What (one new permission, four message types)

**FR-001 — New scope `sessions:author`.** Added to `SCOPES`; **not** in `DESKTOP_ONLY_SCOPES`
(deliberately allowed on a `mobile` device — this is the owner's decision and the first scope that
crosses that line); **not** in `DESKTOP_DEFAULT_SCOPES`; included in the `full` preset only.
Labels: EN `Create sessions and choose a model`, VI `Tạo phiên và chọn model`. It carries a risk
hint like the other write scopes.

**FR-002 — Scope the four message types.** `SCOPE_BY_TYPE` gains, all mapped to `sessions:author`:
`workspaces`, `session-create`, `models`, `select-model`.

**FR-003 — What the scope actually permits, and nothing more.** With `sessions:author` a device may:
- list this Host's workspaces (`workspace/list`, names/paths as the Host already returns them);
- list the model catalog (`llm/models` without a session, `session/models` with one);
- create a session;
- select the provider/model (and reasoning effort) for a session it can address.

**FR-004 — What stays refused for every device, whatever scopes it holds.** `workspace/create`,
`workspace/rename`, `workspace/archiveSession`, `session/fork`, `session/rename`,
`session/updateQueue`, `session/archive`, `session/attachment`, `session/canOpenWorkspacePath`,
`commands/*`, `settings/*`, plugin and schedule families. These are not part of this feature.

**FR-005 — Same argument rules the desktop bridge already enforces.** `session-create` may place the
session in a `workspaceId` that exists on this Host; a `cwd` outside a known workspace still needs
`workspace:manage`; a session id the device may not address is refused the same way `session/prompt`
is refused today. `select-model` must not widen the model surface beyond what the Host offers for
that session.

**FR-006 — The grant is explicit.** A pairing offer shows the scope with its risk hint; a `mobile`
offer may tick it; the approval dialog may narrow but never widen. Records and OTP flows that never
mention it leave the device without it — no default, no implicit grant from `harness:remote`.

**FR-007 — Docs.** `plugins/mobile-gateway/PROTOCOL.md` and the gateway READMEs list the new scope and
the four types with their meaning; the devices page's scope list mirrors the contract (existing
"the UI scope list mirrors the contract" test must keep passing).

**FR-008 — No relaxation elsewhere.** `ADMIN_ONLY_TYPES`, `COMPANION_DENIED_HOST_ENDPOINTS` and the
remote-bridge endpoint families keep their current meaning for everything outside FR-003. The second
deny layer may only stop denying the five Host endpoints in FR-003, and only for a device that
actually holds `sessions:author`.

## Tests this change must carry

- Contract: `SCOPES` contains `sessions:author`; it is not desktop-only, not a default, in `full`;
  `SCOPE_BY_TYPE` maps exactly the four types; the declaration file lists the new `Scope`.
- Gateway: a `mobile` device holding `sessions:author` can list workspaces, list models, create a
  session and select a model; a `mobile` device without it is refused (`forbidden`, no Host call
  attempted); a device with `harness:remote` alone is still refused; `workspace/create` and
  `session/rename` are refused even for a device holding `sessions:author`.
- Resource rules: `session-create` with a foreign `workspaceId` is refused; `select-model` for a
  session the device cannot address is refused.
- Negative/no-leak: the workspace list response carries no credentials; no token, header or pairing
  code appears in any new log line.

## Out of scope

- The phone/desktop **frontend** surfaces (workspace picker, new-session screen, model sheet). This
  spec lands the API and the permission; the UI follows in its own change.
- Workspace creation, renaming, archiving, session forking/renaming, queue control, attachments,
  slash commands.
- Any change to how the desktop remote bridge authorises its endpoints.
