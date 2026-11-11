# Spec 011 P2 — companion-safe contract proposal

**Slices covered (spec.md §P2 order 1–3)**: ① `workspaces` + workspace identity on session rows · ② `session-create` ·
③ `models` / `select-model` + `agent-presets` (with the per-session mode picker as an optional ③d).

**Status**: proposal for the lead's contract revision + a reviewer pass. **No code changed by this document** — it is
read-only analysis; `specs/011-companion-ui-redesign/p2-contract-proposal.md` is the only file written.

**Method and labels.** Every claim is labelled:

- **(a)** measured/executed in this session (files inspected, hashes/JSON parsed, commands run);
- **(b)** read from source at the cited `file:line`;
- **(c)** inferred from (a)/(b), not directly observed.

**There are no (a) claims about runtime frames**: nothing here was executed against a live DSH Host or a real phone. Line
numbers were verified against the working tree on 2026-11-10; `plugins/devices/lib/client.js` is edited concurrently by
another session, so its numbers move — re-verify before coding.

Paths: upstream clone = `_upstream/Clarklevis1995__dsh-mobile` (commit `3ec49d6`, read-only); ours = `plugins/…`,
`packages/…` under `dsh-ext/`.

---

## 0. Alignment — two specs landed while this analysis ran

Two lead-owned specs appeared after this task was issued and they already take the decisions this proposal was chartered to
recommend. This document is therefore written **to align with them, not to compete**:

- `specs/011-mobile-session-authoring/spec.md` (Draft, lead, 2026-11-10) — one new scope **`sessions:author`**, gating
  `workspaces`, `session-create`, `models`, `select-model` (FR-001/FR-002); resource rules (FR-005); hard refusals kept
  (FR-004); single-deny-layer amendment for the five Host endpoints only (FR-008).
- `specs/012-remote-parity-blocklist/spec.md` (Draft, lead, 2026-11-10) — `DESKTOP_ONLY_SCOPES` becomes empty, device
  *kind* is not policy, the carve-out blocklist is the only scope-independent refusal; `session/create` no longer needs
  `workspace:manage` (FR-006); `select-model` is governed by `sessions:author`, not `settings:write` (FR-007); and a
  **new-grant default of "every grantable scope ticked"** (FR-008).

What this proposal adds on top of those two specs — because neither covers it:

1. **The client-side wire evidence** (what the Clarklevis client actually sends/expects, `file:line` on the upstream clone),
   which the coder needs to keep the wire byte-compatible.
2. **Per-op response projections** for a phone (what to strip: `failures`, `trust`, foreign session ids, non-string
   timestamps) — neither spec says.
3. **`agent-presets` and the per-session mode picker are not in 011's four types** (§4.3c/③d, §5.2) — an uncovered P2 item.
4. **A cross-spec conflict on the default grant** (011 FR-001/FR-006 say `sessions:author` is never defaulted; 012 FR-008
   says a new grant ticks every grantable scope) — §5.3, blocking, with the implementation surface named.
5. **Implementation corrections** grounded in our code that 011's wording would otherwise miss (§6): the Host endpoint is
   `workspace/follow`, not `workspace/list`; the positive device endpoint table has **no** workspace entry today; the
   client discards a `select-model` reply whose `selected` differs from what it asked.

**Numbering note (lead's call):** two different specs are numbered 011 (`011-companion-ui-redesign`,
`011-mobile-session-authoring`). Referred to here by folder name to avoid ambiguity.

---

## 0.1 Summary

| # | Operation | Clarklevis client needs it for | Our gateway today (device token) | Gate under the lead specs | Risk if a phone is stolen |
|---|---|---|---|---|---|
| ① | `workspaces` | workspace grouping + switcher (auto-sent after `hello`) | `op/forbidden` (`lib/allowlist.mjs:84`, fence `lib/index.mjs:4992`) | `sessions:author` (011 FR-002) | low — view; host paths + titles |
| ② | `session-create` | "new session" home action | `op/forbidden` (`lib/allowlist.mjs:92`, fence `4994`) | `sessions:author` | **medium-high** — new capability: start work with tools |
| ③a | `models` | composer model picker | `op/forbidden` (`lib/allowlist.mjs:99`) | `sessions:author` | low — view; provider inventory |
| ③b | `select-model` | model/effort switch | `op/forbidden` (`lib/allowlist.mjs:99`) | `sessions:author` (011 FR-002, 012 FR-007) | low-medium — cost/quality of the next turn |
| ③c | `agent-presets` | composer mode roster | `op/forbidden` (`lib/allowlist.mjs:82`) | **not covered by 011** → propose `sessions:read` (read-only) | low — view; workflow names |
| ③d | `select-agent-preset` *(optional)* | mode switch before the first turn | `op/forbidden` (`lib/allowlist.mjs:82`) | **not covered** → propose `sessions:author` or a deferred slice | medium — changes the agent's tool surface |

---

## 1. Rules the revision must preserve

1. **Wire compatibility is non-negotiable.** The app *is* the Clarklevis client, so keep its `type`/`kind`/field names and
   only add projections. Renaming `workspaces.items`, `select-model.selected`, … breaks the port silently.
2. **Additive revision 7.** New `OPS`/`OP_RESPONSES`/`SCOPE_BY_TYPE`/`SCOPES` entries; no change to existing ops. Contract
   source `packages/mobile-protocol/src/index.mjs` (`OPS:85-100`, `OP_RESPONSES:103-118`, `SCOPES:135-155`,
   `DESKTOP_ONLY_SCOPES:161-169`, `DESKTOP_DEFAULT_SCOPES:177`, `SCOPE_PRESETS:184-191`, `SCOPE_BY_TYPE:198-216`,
   `CAPABILITIES:264`, `ERROR_CODES:283-294`); contract doc
   `specs/001-gateway-hardening/contracts/mobile-protocol-v1.md` (at revision 6).
3. **Scope-gated and fail-closed.** `scopeDenial()` refuses any companion type without a `SCOPE_BY_TYPE` entry
   (`lib/allowlist.mjs:174-189`, `auth/forbidden-scope`), so a type added to `OPS` but not `SCOPE_BY_TYPE` stays refused.
4. **Serve through the device's own non-owner Peer**: `const queryApi = adminCaller ? api : connApi` (`lib/index.mjs:4985`).
   The new ops must take this path and must **not** be added to the admin branch at `lib/index.mjs:4991-5011`.
5. **Visibility filter.** No payload may carry an id the device cannot address. `session/list` and `session/search` already
   filter per item (`lib/companion-access.mjs:81-82`, `itemFilter:true`); the new projections must be consistent with it.
6. **Advertise capabilities.** `hello.capabilities` is `COMPANION_CAPABILITIES` (`lib/index.mjs:4427-4441`, `:4435`) ←
   contract `CAPABILITIES` (`packages/mobile-protocol/src/index.mjs:264`). The client refuses to offer "new session" unless
   `'session-create'` is present (`AndroidSharedStateHolder.kt:1095-1098`).

---

## 2. Slice ① — `workspaces` (+ workspace identity on session rows)

### 2.1 What the client sends and expects (b)

- **Sends `{"type":"workspaces"}` automatically right after `hello`** (`GatewayRuntime.kt:1424-1435`, line 1429), and again
  on product-snapshot refresh (`GatewayRuntimeIntegrationTest.kt:1268-1279`).
- **Expects** `{"kind":"workspaces","items":[GatewayWorkspace…],"archivedSessionIds":[…]?}`
  (`SharedMobileStore.kt:343-357`; fixture `GatewayProtocolFixtures.kt:37`).
- `GatewayWorkspace` = `{workspaceId, path, title, sessionIds, createdAt, updatedAt}`, **all non-nullable `String`**
  (`GatewayDtos.kt:433-441`).
- `archivedSessionIds` optional, drives the client's archive filter (`SharedMobileStore.kt:348-354`, applied `:612`); a
  missing field is tolerated (`?.let`).
- **Workspace identity on session rows is derived, not carried**: the client maps `sessionId → workspaceId` from
  `workspaces.items[].sessionIds` (`ui/WorkspaceSessionSections.kt:79`) and groups the list per workspace
  (`ui/ConversationSidebar.kt:70`). Session rows carry `cwd` (`GatewayDtos.kt:471-484`, field `:479`).
- `path` is consumed by the **directory browser** (`ui/WorkspaceDirectoryUi.kt:131,241,248,357-366`); the workspace chip
  shows only `title`.

### 2.2 What our gateway does today (b)

- Admin-only: `'workspaces'` (`lib/allowlist.mjs:84`) + admin fence (`lib/index.mjs:4992`); a device token falls through to
  `op/forbidden` (`lib/index.mjs:5012-5014`) — a normal in-band error frame, not a close.
- Handler `lib/index.mjs:1650-1652` → `proxyQuery(api,'workspaces',api.workspace.list)` → `{kind:'workspaces', …value}`
  (`proxyQuery` at `lib/index.mjs:782-796`).
- Host side: `workspace.list` is the **first frame of the `workspace/follow` baseline** (`lib/dsh-host-adapter.mjs:379-384`).
  `firstStreamFrame` aborts its own stream in `finally` (`lib/dsh-host-adapter.mjs:54-78`), so the one-shot does not leak an
  open Host stream — relevant once a device peer calls it.
- The positive device endpoint table has **no** `workspace/follow` entry (`lib/companion-access.mjs:79-91`), and the deny
  layer only lists `workspace/create|archiveSession|rename` (`lib/allowlist.mjs:110-120`, `:114`) — so today the device is
  refused by the positive table, not by the deny list. **Both files must change** (§6.1).
- Already exposed today: `sessions` items are forwarded with only `projections` rewritten (`lib/index.mjs:1658-1665`), so
  **`cwd` (a host-absolute path) already reaches a paired device**; the plugin reads `item.cwd` from that list
  (`lib/index.mjs:878-887`).

### 2.3 Proposed companion shape

Request (unchanged upstream form): `{"type":"workspaces"}` — no params, control lane.

Response — same `kind`, filtered projection:

```json
{ "kind": "workspaces", "requestId": "<echoed only if the client sent one>",
  "items": [ { "workspaceId": "w1", "path": "/Users/me/proj", "title": "proj",
               "sessionIds": ["s1","s2"], "createdAt": "2026-11-01T10:00:00.000Z",
               "updatedAt": "2026-11-02T08:30:00.000Z" } ],
  "archivedSessionIds": ["s3"] }
```

Coder rules:

1. `path`/`title`: as the Host returns them — **agreed with 011 FR-003** ("names/paths as the Host already returns them"),
   and no worse than the `cwd` a device already sees on every session row (§2.2).
2. `sessionIds`: filter to the sessions the device may **address** (same predicate as the `session/list` item filter,
   `lib/companion-access.mjs:81-82`). This is the one place where "as the Host returns them" is not safe — see reviewer Q2.
3. `archivedSessionIds`: same intersection; **omit the field entirely** when the Host does not supply it — never invent ids.
4. `createdAt`/`updatedAt` must be **strings**: the client's DTO is a non-nullable `String` (`GatewayDtos.kt:439-440`), so if
   the Host baseline carries numbers the gateway must serialize ISO-8601 and use `""` when unknown
   (c: kotlinx rejects `null`/number for a non-null `String`; **measure**, §10 M1).
5. Echo `requestId` when present; the client correlates by `kind`, so it is additive-safe.

**Gate: `sessions:author`** (011 FR-002). Note the consequence: the workspace *view* is tied to the authoring permission, so
a device that may only read sessions still gets `op/forbidden` for `workspaces` and its switcher stays empty (011 FR-002
chose this; reviewer Q1 asks whether that is intended).

**Not in this slice**: `workspace-create`, `directories`, `directory-create` (`lib/allowlist.mjs:84`) stay refused — they are
on 012's carve-out list (rule 2) / spec P2 item 6.

### 2.4 Risk for a stolen phone

**Low.** Read-only. Leaks: host directory layout (`path`, plus the already-exposed `cwd`), workspace and session titles.
No capability gain: a workspace id alone creates nothing (until ②); session ids the device cannot address are stripped
(rule 2). Residual: workspace titles can be sensitive ("taxes-2025").

### 2.5 Reviewer questions

- **Q1**: `sessions:author` also unlocks the workspace *view*; a read-only device gets no grouping at all. Intended?
  (alternative: gate `workspaces` on `sessions:read`, which 011 FR-002 does not propose)
- **Q2**: 011 FR-003 says paths/names "as the Host already returns them" — does that extend to `sessionIds` of sessions the
  device cannot address? (recommend: no, filter; §2.3 rule 2)
- **Q3**: does rc.1's `workspace/follow` baseline carry `archivedSessionIds`, and what JSON type are `createdAt`/`updatedAt`?
  (§10 M1)
- **Q4**: show workspaces with zero addressable sessions, or omit them? (recommend show — an inconsistent switcher reveals
  that something is hidden)

---

## 3. Slice ② — `session-create`

### 3.1 What the client sends and expects (b)

- **Capability gate first**: the client refuses with "update and restart Mobile Gateway" unless `"session-create"` is in
  `hello.capabilities` (`AndroidSharedStateHolder.kt:1095-1098`). ⇒ contract `CAPABILITIES` must gain it (§5.1).
- Sends `{"type":"session-create","requestId":"<uuid>","workspaceId":"w1"?}`; `workspaceId` omitted in default-workspace
  mode (`GatewayProtocol.kt:208-216`; `AndroidSharedStateHolder.kt:1102-1108`). It never sends `cwd` on this path.
- Expects `{"kind":"session-created","requestId":"<uuid>","sessionId":"…"}`; anything else fails and shows `frame.message`
  (`AndroidSharedStateHolder.kt:1117-1122`). 15 s timeout (`:1112`), **no auto-retry** (their doc `PROTOCOL.md:1366`).
- On success it selects the session, re-requests `sessions` and the session controls (`:1131-1135`).

### 3.2 What our gateway does today (b)

- Admin-only: `'session-create'` (`lib/allowlist.mjs:92`), fence (`lib/index.mjs:4994`), deny layer `session/create`
  (`lib/allowlist.mjs:116`).
- Handler `lib/index.mjs:1634-1649`: requires non-empty `requestId`; optional `agentPreset`; **`workspaceId` wins over
  `cwd`**; Host `session/create` (`lib/dsh-host-adapter.mjs:327`); frame echoed with `requestId`, errors tagged
  `requestType:'session-create'`.
- Documented behaviour/capability meaning: `PROTOCOL.md:1358-1366`.

### 3.3 Proposed companion shape

```json
→ { "type": "session-create", "requestId": "<1..64 chars [A-Za-z0-9._-]>", "workspaceId": "w1" }
← { "kind": "session-created", "requestId": "…", "sessionId": "s9" }
← { "kind": "error", "code": "bad-request", "requestType": "session-create", "requestId": "…", "message": "…" }
```

Coder rules:

1. `workspaceId` must be one of the Host's workspaces **and** one the device may address — 011 FR-005/012 FR-006's existence
   rule, plus the visibility predicate (§1.5). Unknown/foreign → refusal before the Host call, echoing `requestId`.
2. **`cwd`**: 011 FR-005 / 012 FR-006 say a `cwd` outside a known workspace needs `workspace:manage` and is otherwise
   refused. Implement exactly that — but note the residual risk stated in §3.4: with 012 FR-001 (empty
   `DESKTOP_ONLY_SCOPES`) a phone *can* hold `workspace:manage`, and then `cwd` becomes an arbitrary-host-directory choice.
   Recommend keeping the admin path's `cwd` support untouched (`lib/index.mjs:1644-1645`) and treating the companion `cwd`
   rule as **default-deny unless the path resolves inside a workspace the device can address**.
3. **Drop `agentPreset` for the companion variant.** The client sets the preset through the mode picker after creation
   (`AndroidSharedStateHolder.kt:1135`); accepting it here would let a phone bypass ③d's gate. The admin path keeps it
   (`lib/index.mjs:1639-1641`).
4. Reuse the existing per-op `requestId` fence (contract §4): unique in flight, 1..64, `[A-Za-z0-9._-]`.
5. **Rate cap** (defence in depth, not in 011): e.g. ≤ 6 sessions per device per 10 min → `bad-request`. Documented in
   `PROTOCOL.md` so clients do not misread it as a transport failure.

**Gate: `sessions:author`** (011 FR-002). With 012 FR-007 this is also the gate for `select-model`, so one permission covers
the whole composer/home surface the Clarklevis port needs — consistent with the owner's "grants, narrowed by hand" stance.

### 3.4 Risk for a stolen phone

**Medium-high — the only slice that adds a capability rather than a view.** `sessions:author` + `prompt:send` lets an
attacker start an agent (with tool execution) in any workspace it can address, repeatedly. Without it a leaked token can
only continue work the owner already started. Mitigations: explicit grant with a risk hint (011 FR-006), visibility
predicate on `workspaceId`, `cwd` default-deny (§3.3 rule 2), per-device rate cap, and existing revocation (close 4401 +
credential wipe) unchanged.

### 3.5 Reviewer questions

- **Q5**: companion `cwd` — is "requires `workspace:manage`" (011 FR-005) acceptable now that 012 FR-001 lets a phone hold
  that scope? (recommend: additionally require the path to resolve inside an addressable workspace)
- **Q6**: keep `agentPreset` on `session-create` for companions, or force the explicit mode-picker op? (recommend force)
- **Q7**: rate-cap value + error code (`bad-request` vs a new `session/create-limited`; recommend reusing `bad-request` to
  avoid a contract error-code addition).
- **Q8**: auto-archive sessions a device created but never prompted, after N hours? (nice-to-have; rows already carry
  `blank`, `GatewayDtos.kt:476`)

---

## 4. Slice ③ — `models` / `select-model` / `agent-presets`

### 4.1 What the client sends and expects (b)

| op | request | response it decodes |
|---|---|---|
| `models` | `{"type":"models","sessionId":"s1"?}` — `sessionControl(type, sessionId)` → `{type, sessionId}` (`GatewayProtocol.kt:232-237`; target `SharedSessionControlStore.kt:134-136`) | `{current?, routable, groups:[{id,name,models:[{id,name,reasoning:{efforts[{id,name}],defaultEffort?}}]}]}` (`SharedSessionControlStore.kt:225-236`; DTOs `GatewayDtos.kt:509-514`). **`failures` is ignored.** |
| `select-model` | `{"type":"select-model","sessionId","provider","model","reasoningEffort"?}` (`GatewayProtocol.kt:366-381`) | `{selected:{provider,model,reasoningEffort?}}` **which must equal the request**, else the client discards the update (`SharedSessionControlStore.kt:238-246`) |
| `agent-presets` | `{"type":"agent-presets"}` via `simple()` (`SharedSessionAgentPresetStore.kt:67`) | `{presets:[{id,name?,description?,isDefault,broken?,brokenReason?}], agentPresetDefault?}` (`GatewayDtos.kt:517-526`; `SharedMobileStore.kt:365-369`); fixtures also show `authorable`/`hasDocument` (`GatewayProtocolFixtures.kt:43`), ignored unless the preset editor is ported |
| ③d `session-agent-preset` / `select-agent-preset` *(optional)* | `{sessionId, requestId}` / `{sessionId, agentPreset, requestId}` (`GatewayProtocol.kt:188-203`) | `{sessionId, agentPreset, locked?, requestId}`; errors `agent-preset/locked`, `agent-preset/unavailable` (`PROTOCOL.md:1127-1146`) |

The composer's picker targets a **session**; the client tolerates a missing `sessionId` echo in the `models` response and
binds it to the active request (`SharedSessionControlStore.kt:228-236`, comments `:484-487`).

### 4.2 What our gateway does today (b)

- Admin-only: `'agent-presets','select-agent-preset','session-agent-preset'` (`lib/allowlist.mjs:82`),
  `'models','select-model'` (`lib/allowlist.mjs:99`); fence `lib/index.mjs:4995-4998`; deny layer `session/selectModel`,
  `agentPresets/select` (`lib/allowlist.mjs:115-116`).
- Handlers: `models` `lib/index.mjs:1854-1862` (per-session `sessions.models`, else global `llm.models`); `select-model`
  `:1959-1970` (validates provider+model, optional `reasoningEffort`, Host `session/selectModel`,
  `lib/dsh-host-adapter.mjs:362`); `agent-presets` `:2095-2097` (Host `agentPresets/list`,
  `lib/dsh-host-adapter.mjs:454-455`); `session/select-agent-preset` `:1623-1633` (adapter `:456-470`, incl. `locked` and
  per-session serialization).
- Host return shapes: `models` = `{current, routable, groups, failures}` assembled in `lib/dsh-host-adapter.mjs:364-377`
  (`failures` straight from the Host catalog); `select-model` = `{selected}` (`PROTOCOL.md:1080-1082`); `agent-presets` =
  `{presets, modeSelectionEnabled?}` (`lib/index.mjs:2107,2111`).

### 4.3 Proposed companion shape

**(a) `models`** — both variants allowed (011 FR-003 explicitly permits the global catalog without a session):

```json
→ { "type": "models", "sessionId": "s1" }            (or { "type": "models" } for the global catalog)
← { "kind": "models", "requestId": "…", "sessionId": "s1",
    "current": { "provider": "deepseek", "model": "deepseek-chat", "reasoningEffort": "high" },
    "routable": true,
    "groups": [ { "id": "deepseek", "name": "DeepSeek", "models": [
      { "id": "deepseek-chat", "name": "DeepSeek Chat",
        "reasoning": { "efforts": [ { "id": "low", "name": "Low" } ], "defaultEffort": "low" } } ] } ] }
```

- **Drop `failures`** from both variants: Host provider diagnostics (adapter `:375`), possibly error text with
  URLs/quotas, and the client never reads it (`SharedMobileStore.kt:384-395`).
- With a `sessionId`, that session must be addressable (else `session-not-found`), matching `session/prompt`'s rule
  (011 FR-005).
- Keep provider/model `id`+`name`, `reasoning.efforts`/`defaultEffort`, `routable`, `current`.

**(b) `select-model`**

```json
→ { "type": "select-model", "sessionId": "s1", "provider": "deepseek", "model": "deepseek-chat",
    "reasoningEffort": "high" }
← { "kind": "select-model", "requestId": "…",
    "selected": { "provider": "deepseek", "model": "deepseek-chat", "reasoningEffort": "high" } }
```

- Validate `sessionId` addressability, and validate `provider`/`model`/`reasoningEffort` against the catalog the device was
  just served — fail **before** the Host call, and guarantee the echo the client compares (`SharedSessionControlStore.kt:243-245`)
  is exactly the request (011 FR-005: "must not widen the model surface").
- `default-model` / `save-default-model` / `set-default` are **not** in this slice and stay refused (012 FR-007 keeps
  `settings:write` for Host defaults).

**(c) `agent-presets`** — *not covered by 011's four types; this is the gap this proposal fills*

```json
→ { "type": "agent-presets" }
← { "kind": "agent-presets", "requestId": "…",
    "presets": [ { "id": "standard", "name": "Standard", "description": "…", "isDefault": true } ],
    "agentPresetDefault": "standard" }
```

- **Drop `trust`**: declared in the client DTO (`GatewayDtos.kt:520`) but read **nowhere** in their sources — verified by a
  recursive sweep of all 74 `shared/src/commonMain/**.kt` files, where `trust` occurs only on that declaration line. It is
  owner-side trust metadata; the field is optional, so dropping it cannot break the client.
- Keep `broken` + `brokenReason` (the client disables broken presets, `PROTOCOL.md:1135`), but **truncate `brokenReason`**
  (~256 code points): on rc.1 it can embed plugin/file names from the host.
- `modeSelectionEnabled`: optional global flag; the picker ignores it. Omit or pass through — no security content.
- **Proposed gate**: `sessions:read` (read-only roster; the composer renders it next to a session it can already read). If
  the lead prefers one permission for the whole composer, put it under `sessions:author` — but then a read-only device
  loses the mode chip, which is the current P2 item-3 intent. Reviewer Q9 / owner D2.

**(d) optional: the mode picker** (`session-agent-preset` read + `select-agent-preset` write) — ship only if the owner wants
the composer's *mode* control in this revision (owner D3). Gate: read under the same scope as 4.3c, write under
`sessions:author`; require an addressable, unlocked session, and preserve `agent-preset/locked`
(`PROTOCOL.md:1142-1146`) and the adapter's serialization rule (`lib/dsh-host-adapter.mjs:456-470`). Rationale to include
it: an agent preset chooses the system prompt/tool set, so it is closer to a privilege change than a preference — if it is
deferred, say so in the contract so clients do not offer the control.

### 4.4 Risk for a stolen phone

- `models` / `agent-presets`: **low** — metadata. Leaks the provider/model inventory (which AI accounts the Host has) and the
  owner's workflow names via preset names. 011 FR-003 accepts the global model inventory deliberately.
- `select-model`: **low-medium** — cost/quality switch for one session; no code execution; no host-wide default change.
- `select-agent-preset` (③d): **medium** — changes the agent's tool surface for the next turn.

### 4.5 Reviewer questions

- **Q9**: where do `agent-presets` (and ③d) belong — `sessions:read` / `sessions:author` / a new `agent-presets:read`?
  (recommend `sessions:read` for the roster, `sessions:author` for the mode switch)
- **Q10**: confirm the global `models` variant is really wanted on a phone (011 FR-003 says yes; it reveals the whole
  provider inventory — accepted risk or an oversight?).
- **Q11**: `brokenReason` — truncated text or a fixed generic string (leaks plugin/file names)?
- **Q12**: must `select-model` keep the echo-equality contract (`selected` == request) as a *tested* requirement? (recommend
  yes; the client silently drops a mismatched reply)

---

## 5. Scope model

### 5.1 What the lead specs already fix (do not re-litigate)

- **One new scope `sessions:author`** (011 FR-001): added to `SCOPES`; **not** in `DESKTOP_ONLY_SCOPES` (and 012 FR-001
  empties that list entirely); **not** in `DESKTOP_DEFAULT_SCOPES`; `full` preset only; EN label *"Create sessions and
  choose a model"*, VI *"Tạo phiên và chọn model"*; risk hint like other write scopes.
- **`SCOPE_BY_TYPE`** gains exactly the four types → `sessions:author`: `workspaces`, `session-create`, `models`,
  `select-model` (011 FR-002). `OPS`/`OP_RESPONSES` gain the same four (+ upstream response kinds `workspaces`,
  `session-created`, `models`, `select-model`).
- **Hard refusals stay** (011 FR-004 / 012 rule 2): workspace mutations, session fork/rename/archive/queue/attachment,
  `commands/*`, `settings/*`, plugin and schedule families.
- **Deny-layer amendment is narrow** (011 FR-008): `COMPANION_DENIED_HOST_ENDPOINTS` may stop denying only the endpoints
  those ops need, and only for a device that actually holds `sessions:author`.
- **Bridge alignment** (012 FR-006/FR-007): `session/create` no longer requires `workspace:manage`; `select-model` is a
  session action governed by `sessions:author`, not by `settings:write` — this matches §4.3(b) and the existing
  `risk.settings:write` label, which today claims models and would otherwise become false
  (`plugins/devices/lib/client.js:107`).

**Missing from both specs**: a contract `CAPABILITIES` entry for `session-create`. Without it the Clarklevis client never
sends the frame (§3.1). Recommend `CAPABILITIES += 'session-create'` (additive; old clients ignore unknown strings, c).

### 5.2 The uncovered P2 item

| op | proposed gate | why |
|---|---|---|
| `agent-presets` (read) | `sessions:read` | read-only roster; no capability gain |
| `session-agent-preset` (read, ③d) | `sessions:read` | reads the current mode/locked flag |
| `select-agent-preset` (write, ③d) | `sessions:author` | changes the agent's tool/behaviour set for the next turn — same family as "choose a model" |

If the owner prefers a single composer permission, all four live under `sessions:author` and P2 item 3's read-only mode chip
becomes authoring-only. Either way it must be stated, because the client will send `agent-presets` on its own
(`SharedSessionAgentPresetStore.kt:67`) and would otherwise receive `auth/forbidden-scope` for the whole mode picker.

### 5.3 ⚠ Blocking conflict between the two lead specs — the new-grant default

- **011 FR-001/FR-006**: `sessions:author` is **not** defaulted — "Records and OTP flows that never mention it leave the
  device without it — no default, no implicit grant."
- **012 FR-008**: a pairing offer (desktop approval **and** the OTP/phone path) "starts with **every grantable scope
  ticked**", and "`SCOPE_PRESETS.full` therefore equals the grantable set".

Those cannot both hold once `sessions:author` is in `SCOPES`. The implementation surface where they collide is already
identified:

- gateway pairing-request default: `offerScopes = scopes ?? (kind === 'desktop' ? [...DESKTOP_DEFAULT_SCOPES] : SCOPES.filter((scope) => scope !== REMOTE_SCOPE))` (`lib/index.mjs:4233-4234`);
- devices default grant: `defaultScopes(kind)` → `kind === 'desktop' ? [...DESKTOP_DEFAULT_SCOPES] : [...ALL_SCOPES]` with
  `ALL_SCOPES = CONTRACT_SCOPES − EXPLICIT_ONLY_SCOPES` (`lib/devices.js:42-49,61-71`);
- the devices OTP offer is literally `kind:'desktop', scopes:[...ALL_SCOPES]` (`plugins/devices/lib/client.js:1297`), and
  Approve only narrows to the offered subset (`lib/index.mjs:4330-4338`).

With 012's `DESKTOP_ONLY_SCOPES` emptied, those defaults expand to nearly every scope: the gateway's **mobile** path already
lists everything except `harness:remote` (so `sessions:author` lands there with no edit), and devices' mobile default becomes
all of `SCOPES` once `EXPLICIT_ONLY_SCOPES` is empty. Either way `sessions:author` arrives granted without anyone choosing
it — the opposite of 011 FR-006.

**Q13** (blocking): which rule wins for a *new* grant — 012 FR-008's "every grantable scope ticked" (so `sessions:author`
arrives ticked, and 011 FR-001/FR-006 must be amended and the dialog must say so), or 011's "no default" (so the tick-all
rule needs an explicit never-default set, option B below)? Options:

- **(A) 012 wins.** `sessions:author` is ticked on new grants; 011 FR-001/FR-006 must be amended, and the approval dialog
  must say so in words (012 FR-008 already requires that statement). Simple, matches the owner's quoted intent.
- **(B) 011 wins via one constant.** Keep 012's "everything grantable is listed/ticked" but add an explicit
  **never-default** set (e.g. `NEVER_DEFAULT_SCOPES = ['sessions:author']`, or redefine `DESKTOP_DEFAULT_SCOPES` as the
  allow-list for defaults) consumed by both `lib/index.mjs:4233` and `lib/devices.js:69-71`, with a test that a default
  grant never contains a write scope.
- **(C) Split by path.** Desktop approval ticks all; the OTP/phone path ticks the three read/prompt/approve scopes.

Recommendation: **(B)** — smallest, testable in two places, keeps 012's spirit (owner sees and can untick everything) while
honouring 011's explicit "no default" for the one scope that can start agent work. Whichever is chosen, the two specs must
end up saying the same thing before the contract revision is written.

### 5.4 How a new scope reaches the owner (`@dsh-ext/devices`)

The device-scope editor is `ScopePicker` in `plugins/devices/lib/client.js` (verified now: `ALL_SCOPES:906-910`,
`SCOPE_PRESETS:911-915`, `RISKY_SCOPES:916-918`, `ScopePicker:924-941`; labels `scope.<name>` from `:61`, risk lines
`risk.<name>` from `:106`, EN and VI blocks). It renders one checkbox per `ALL_SCOPES` entry via `tr('scope.<scope>')`, dims
what the offer did not request, and prints `tr('risk.<scope>')` for risky scopes. The file states its own constraint
(`:896-903`): it is a plain script that **cannot import the contract**, so `ALL_SCOPES`/`SCOPE_PRESETS` mirror
`packages/mobile-protocol` and `plugins/devices/test/client.test.mjs` fails on drift.

So `sessions:author` reaches the owner only when, in one change: contract `SCOPES`/`SCOPE_BY_TYPE` (+ the default-rule
constant from §5.3) → gateway `hello.capabilities` (`lib/index.mjs:4427-4441`) and enforcement (`scopeDenial`,
`lib/allowlist.mjs:174-189`) → devices `ALL_SCOPES` + `scope.sessions:author` + `risk.sessions:author` **for every language
block** → drift test update. 012 FR-004 also requires the Devices page to state once that carve-out families cannot be
granted at all.

**Scopes are fixed at pairing**: the devices UI's "Edit permissions" generates a *new pairing code* and requires a re-pair
(`plugins/devices/lib/client.js`, `edit`/`editHelp` strings); the gateway refuses an approval wider than the offer and
narrows to it (`lib/index.mjs:4330-4338`). So `sessions:author` can never appear on an existing device silently.

---

## 6. Implementation corrections the coder will otherwise hit

### 6.1 `workspaces` needs an endpoint the device map does not have

011 FR-008 speaks of the "five Host endpoints". For the workspace half the endpoint is **`workspace/follow`**, not
`workspace/list`: `api.workspace.list` is implemented as the first frame of that stream (`lib/dsh-host-adapter.mjs:379-384`),
and `firstStreamFrame` aborts it in `finally` (`:54-78`) so the one-shot is safe. Consequences:

- `lib/companion-access.mjs` (`COMPANION_ENDPOINTS`, `:79-91`) must gain a `workspace/follow` entry (resource `global`,
  scope `sessions:author`) — it is absent today, and that table is a *positive* allow-list: without the entry the device is
  refused even after the deny list is amended.
- `lib/allowlist.mjs:110-120` lists only `workspace/create|archiveSession|rename`; nothing there blocks `workspace/follow`,
  so the deny list needs no change for this op (contrary to what "amend the deny list" might suggest).
- Because `workspace/follow` is a *stream* endpoint, the handler must keep taking only the opening baseline (as the adapter
  does) — do not expose the stream to a device in this slice.

### 6.2 `select-model` echo equality is a functional requirement, not a nicety

The client drops a `select-model` reply whose `selected` differs from the requested `{provider, model, reasoningEffort}`
(`SharedSessionControlStore.kt:238-246`). The gateway must echo the *request's* triple (normalized `reasoningEffort`: an
omitted effort must not come back as a Host default) or the picker silently reverts.

### 6.3 `models` `failures` and `agent-presets` `trust`

Strip both (§4.3a, §4.3c). They are not needed by any consumer in the client and carry Host-side operational detail.

### 6.4 Timestamps and other non-nullable DTO fields

`GatewayWorkspace.createdAt`/`updatedAt` are non-nullable `String` (`GatewayDtos.kt:439-440`): normalize to ISO-8601 or `""`
(§2.3 rule 4, measure §10 M1). Same discipline applies to any field a projection rewrites: match the client DTO's nullability
exactly.

### 6.5 Gate the router branch, not the admin branch

Add the companion dispatch next to the existing contract ops (`lib/index.mjs:4977-4990`) using
`adminCaller ? api : connApi`, **not** by relaxing the admin fence at `lib/index.mjs:4991-5011`.

---

## 7. Stolen/lost phone — summary

| op | Δ capability | worst realistic outcome | mitigation |
|---|---|---|---|
| `workspaces` | none (view) | learns host layout + workspace/session titles | explicit grant; filtered `sessionIds` |
| `session-create` | **start work** | agent with tools in any addressable workspace; session spam | explicit grant (default conflict §5.3); `cwd` default-deny; addressable `workspaceId`; rate cap |
| `models` | none (view) | learns provider/model inventory | drop `failures`; global variant is an accepted risk (011 FR-003) |
| `select-model` | per-session model change | cost/quality change of the next turn | catalog-validated; addressable session |
| `agent-presets` | none (view) | learns workflow names; `brokenReason` may leak plugin/path names | drop `trust`; truncate reason |
| `select-agent-preset` (③d) | **agent tool surface change** | next turn runs a preset the owner did not choose | explicit grant; deferrable |

Revocation is unchanged: a lost phone is revoked by the owner (existing revoke/`device-forget` → close 4401 + credential
wipe) and every new op dies with the credential. Nothing here introduces a long-lived grant.

---

## 8. Consolidated reviewer questions

**Blocking**
1. The new-grant default conflict between 011 FR-001/FR-006 and 012 FR-008, and its two implementation sites (§5.3, Q13).
2. `workspace/follow` must be added to the *positive* device endpoint table, not only to the deny list (§6.1).
3. `CAPABILITIES` must gain `session-create`, or the ported app never sends the frame (§5.1).
4. Where `agent-presets`/`select-agent-preset` sit (§5.2, Q9).
5. Companion `cwd` rule now that a phone may hold `workspace:manage` (§3.5 Q5).

**Non-blocking**: Q1, Q2, Q3, Q4, Q7, Q8, Q10, Q11, Q12.

---

## 9. What must be measured before merge

Nothing below was measured in this session; contract §4 requires the doc and the code to stay in step, so a mismatch is a
contract bug, not a doc bug.

- **M1** live `workspace/follow` baseline on DSH 0.2.2-rc.1: `items`? `archivedSessionIds`? JSON type of
  `createdAt`/`updatedAt`? (admin route `{"type":"workspaces"}` over the owner loopback socket; adapter
  `lib/dsh-host-adapter.mjs:379-384`).
- **M2** live `session/create`: `sessionId` present; error shape for an unknown/foreign `workspaceId`.
- **M3** live per-session `models`: is `failures` populated? is `reasoning.defaultEffort` present? does `select-model` echo
  the exact `selected` triple?
- **M4** live `agentPresets/list` on rc.1: which of `name`, `description`, `broken`, `brokenReason`, `trust` are populated
  (the adapter forwards the Host object unchanged, `:454-455`).
- **M5** acceptance: the Clarklevis client (or the ported screens) against our gateway with `sessions:author` — workspace
  switcher renders, "new session" works, composer picker reads the catalog; and the *same* device without the scope gets a
  graceful `auth/forbidden-scope` instead of a broken screen.

---

## 10. Coder task list (dependency order, after the contract revision)

| # | Package | Change |
|---|---|---|
| T1 | `packages/mobile-protocol` | `sessions:author` in `SCOPES` (+ labels in the contract doc), `SCOPE_BY_TYPE` four types, `OPS`/`OP_RESPONSES`, `CAPABILITIES += session-create`, the default-rule constant from §5.3, `index.d.ts`, contract doc revision 7, contract tests (`test/contract.test.mjs` parses the doc) |
| T2 | `plugins/mobile-gateway` | move the four types out of `ADMIN_ONLY_TYPES`; `workspace/follow` + the endpoint scopes into `COMPANION_ENDPOINTS`; companion router branch on `connApi` (§6.5); projections (§2.3, §3.3, §4.3); `session-create` argument rules + rate cap; `select-model` echo equality; tests per op (positive, scope refusal, visibility, `cwd`, capability advertised, no-leak log scan) |
| T3 | `plugins/mobile-gateway` + `plugins/devices` | the new-grant default rule in both sites (§5.3 option chosen by the owner) + a test asserting a default grant never contains the write scope |
| T4 | `plugins/devices` | `ALL_SCOPES`, `scope.sessions:author` + `risk.sessions:author` in every language block, presets per 012 FR-008, devices-page carve-out statement (012 FR-004), drift test |
| T5 | `apps/mobile-companion` | the screens that consume these ops (P3; the wire ids are already the Clarklevis ones) |

Each slice is a network-exposure change → contract revision + gateway tests + **reviewer pass before merge** (repo rule).

---

## 11. Decisions still needed

- **D1** New-grant default: 012 FR-008 "everything ticked" (amend 011 FR-006) or a never-default set for `sessions:author`
  (§5.3 option B, recommended)? This is the only blocking conflict.
- **D2** `agent-presets` roster scope: `sessions:read` (recommended; keeps a read-only mode chip) or fold into
  `sessions:author`?
- **D3** Mode picker (③d, `select-agent-preset`) in this revision, or its own slice?
- **D4** Companion `cwd` on `session-create`: 011 FR-005 as written, or additionally constrained to an addressable workspace
  (§3.5 Q5, recommended)?
- **D5** Session-create rate cap value (recommended 6 per device per 10 min) and whether to reuse `bad-request`.

*Facts above are (b) read from source unless marked otherwise; (c) items are flagged inline as "measure". No file outside
this document was modified, and the git index was not touched.*
