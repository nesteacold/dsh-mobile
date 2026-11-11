# Feature 012 — Remote parity, with an owner-carved blocklist

Status: Draft (lead, 2026-11-10). Owner decision 2026-11-10, verbatim intent: "Phải mở hết cho tôi
để remote như ngồi trên máy thật, nếu có chặn thì tôi sẽ chọn trên Permission để chặn" + an explicit
list that must stay blocked. Reviewer pass mandatory; this is the widest exposure change in the repo.

## The rule this feature encodes

1. **Default is capability, not prohibition.** If a capability can be exercised from another machine,
   there must be a permission for it. The gateway must not keep a capability out of reach because of
   a policy guess: the owner narrows access in Permissions, per device.
2. **One carve-out is hard.** The families the owner named stay refused for **every** device, in every
   scope combination, at the gateway, not only in the UI: creating/renaming/archiving a workspace,
   forking/renaming a session, queue control, session attachments, slash commands, `settings/*`,
   the plugin family, the schedule family. A device cannot buy them with any scope; a future contract
   version must not be able to add them by accident.
3. **Device kind is not a policy.** A `mobile` phone and a `desktop` client may hold the same scopes,
   including `harness:remote`, `terminal`, `files:write`, `credentials:write`. What a device may do
   is decided by the scopes the owner granted, never by its self-declared kind.
4. **Narrowing is always available.** Every grantable scope keeps its own switch in Approve / Edit
   permissions, with its risk hint, and the approval dialog may narrow but never widen.

## Changes

**FR-001 — Drop the desktop-only restriction.** `DESKTOP_ONLY_SCOPES` becomes empty (kept exported so
callers and tests do not break) and `DESKTOP_DEFAULT_SCOPES` stays the three read/prompt/approve
scopes: still no scope is granted implicitly, including to a `desktop`.

**FR-002 — The blocklist becomes the only hard refusal, and it is scope-independent.**
`COMPANION_DENIED_HOST_ENDPOINTS` + `ADMIN_ONLY_TYPES` are reorganised so the carve-out list in rule 2
is refused for a device token regardless of scopes, while everything else is refused only when the
device lacks the scope that governs it. Concretely: `workspace/create`, `workspace/rename`,
`workspace/archiveSession`, `session/fork`, `session/rename`, `session/archive`,
`session/updateQueue`, `session/attachment`, `session/canOpenWorkspacePath`, `commands/*`,
`settings/*`, `permissions/*`, `permissionPresets/*`, plugin management, schedules, goals: still denied
always. Their families remain absent from the mobile message map too.

**FR-003 — Everything else is reachable.** With the matching scope, a device of any kind may: read
sessions and history, send prompts, cancel, answer approvals and questions, read and write files,
run a terminal, set or remove provider credentials, use the remote bridge (`harness:remote`) with its
per-endpoint scopes, and — via feature 011 — list workspaces, list models, create a session and select
a model. `session/create` keeps its argument rule: the workspace must exist on that Host.

**FR-004 — The UI must show the whole truth.** The Devices page scope list mirrors the contract
(a new scope must appear in `ALL_SCOPES`, EN and VI labels, risk hint, presets). For the carve-out
families the page states plainly, once, that they cannot be granted to any device — the owner must not
be left hunting a switch that does not exist.

**FR-005 — No silent privilege for a device that already exists.** A record keeps exactly the scopes
written on it: an existing `desktop` with `harness:remote` does not thereby gain `terminal` or
`credentials:write`. The wide default of FR-008 applies to a NEW grant, where the owner is looking at
the list and can untick before approving.

**FR-006 — `session/create` stops needing `workspace:manage`.** The remote bridge currently refuses it
unless the device holds `workspace:manage` (`lib/remote-bridge.mjs:347-401`). That scope governs
workspace *mutations*, which rule 2 keeps blocked, so requiring it would make feature 011's "create a
session in an existing workspace" impossible for a phone. The rule becomes: the `workspaceId` must be
one of this Host's workspaces (unchanged existence check); no `workspace:manage` requirement; a `cwd`
outside any known workspace is still refused.

**FR-007 — `session/selectModel` belongs to the session, not to Host settings.** The bridge gates it on
`settings:write` (`lib/remote-bridge.mjs:110`), but `settings/*` is on the carve-out list, so that gate
would make model selection unreachable. Selecting a model for a session is a session action: it is
governed by `sessions:author` (feature 011) for every device kind, and `settings:write` keeps governing
what it names — Host settings, defaults and agent presets.

**FR-008 — The default grant follows the owner's sentence: everything grantable, narrowed by hand.**
A pairing offer (desktop approval and the OTP/phone path alike) starts with **every grantable scope
ticked**, so "remote like sitting at the machine" is what you get if you change nothing; the owner
unticks what a device must not have. Carve-out families are never in the list, so they can never be
granted by a default. `SCOPE_PRESETS.full` therefore equals the grantable set and `standard` stays
available for a narrower start. This is a deliberate reversal of today's "three scopes only" default
and must be stated in the approval dialog, in the Devices page and in the gateway PROTOCOL.md.

## Tests

- Contract: `DESKTOP_ONLY_SCOPES` empty; the default grant is every grantable scope and contains no
  carve-out family; every grantable scope is in `SCOPE_PRESETS.full`; `SCOPE_BY_TYPE` unchanged except
  feature 011's four types.
- Gateway, the point of the feature: a `mobile` device holding the same granted scopes as a `desktop`
  behaves identically for every allowed capability; and for **each** carve-out family, a device holding
  *every* grantable scope is still refused with the same code as today (one test per family, so a
  future change that opens one is caught by name).
- The refusal must happen before the Host call: assert on the fake adapter's call log.
- Log scan: no token, header, pairing code or credential value appears in any new log line.

## Out of scope

- Any new capability not already implemented by the Host (this feature changes who may reach what,
  not what exists).
- The phone/desktop frontend screens (separate change, feature 011's UI follow-up).
- Making the carve-out families configurable: the owner asked for them to stay blocked, so they are
  a constant with a test, not a setting.
