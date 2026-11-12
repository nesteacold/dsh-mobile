# Contract — `@dsh-ext/mobile-protocol` v1

Shared by `plugins/mobile-gateway` and `apps/mobile-companion`. Breaking change = v2.

**Revision 2 (2026-11-09, lead)**: aligned with the upstream gateway wire format
(`plugins/mobile-gateway/PROTOCOL.md`) instead of inventing a new envelope — client frames use `type`,
server frames use `kind`. Revision 1 op names (`sessions.list`, …) are withdrawn; v1 is unreleased, so
this is not a breaking change for any shipped client.

**Revision 3 (spec 005, remote desktop client)**: additive, so the wire protocol stays v1. Device `hello`,
`paired` and `device-info` carry `kind` (`mobile`|`desktop`) and `scopes`; a pairing offer carries both;
a type a device's scopes do not cover is answered `auth/forbidden-scope` in band. A record written before
this revision loads as a mobile device with every scope. See
`specs/005-remote-desktop-client/spec.md` FR1–FR6; the six scopes are `sessions:read`, `prompt:send`,
`approval:respond`, `files:read`, `files:write`, `settings:write`.

## 1. Framing

- Transport: one WebSocket over TLS (`wss://`) to the gateway's TLS listener; certificate pinned by
  `certSha256` from the QR. Subprotocol always includes `dsh-mobile-v1`.
- Client → server: `{ "type": "<op>", "requestId": "<client id>", ...params }`. `requestId` is required on
  every request from a companion client (≤ 64 chars, `[A-Za-z0-9._-]`).
- Server → client: `{ "kind": "<kind>", ...data }`. Every response or error caused by a request **echoes
  that request's `requestId`**. Server pushes (`event`, `approval-requested`, …) carry no `requestId`.
  The echo requirement applies to **valid** `requestId` values only: a missing or malformed id is refused
  without echoing the supplied value.
- Error frame: `{ "kind": "error", "code": "<code>", "requestType": "<op>", "requestId": "...", "message"?: "..." }`.

## 2. Pairing QR payload (version 3)

QR/manual text = **unpadded base64url** of UTF-8 JSON (same encoding as upstream v2):

```json
{ "version": 3, "publicUrl": "wss://192.168.1.10:3443/ws/mobile",
  "pairingCode": "<base64url 256-bit>", "expiresAt": 1787112000000,
  "certSha256": "<64 lowercase hex>", "gatewayId": "<uuid v4>", "gatewayName": "my-pc",
  "endpoints": ["wss://192.168.1.10:3443/ws/mobile"] }
```

- `publicUrl` and every `endpoints[]` entry MUST be `wss://`. `expiresAt` is epoch milliseconds, ≤ 5 min ahead.
- Client MUST reject `version !== 3`, non-wss URLs, or a malformed `certSha256`.

## 3. Connection and authentication

1. Client opens WSS and verifies the leaf certificate SHA-256 equals `certSha256` **before sending anything**.
2. First pairing: subprotocols `dsh-mobile-v1, dsh-pair.<pairingCode>`; header `X-DSH-Device-ID:
   <install-scoped UUID>` (fallback subprotocol `dsh-device.<id>`). Pairing code in the URL query is rejected.
3. Server sends once: `{ "kind": "paired", "token": "<device token>", "device": { "id", "name", "createdAt" } }`.
   Client stores the token in the secure store immediately; it is never sent again.
   **Rev 6 correction:** this frame does NOT arrive immediately on a first pairing. It is sent only after
   the pairing-proof exchange and after the Host user approves on the desktop — see §3.8. A client that
   waits for `paired` without answering the challenge will be closed with `4408 pairing/timeout`.
4. Later connections: header `Authorization: Bearer <token>` (fallback subprotocol `dsh-auth.<token>`).
   Token in the URL query is rejected.
5. Server sends `hello`:
```json
{ "kind": "hello", "protocol": 3, "companionProtocol": 1, "minClientVersion": 1,
  "capabilities": ["sessions-read", "prompt", "cancel", "approval-v1"],
  "authenticated": true, "device": { "id": "...", "name": "..." },
  "gatewayId": "...", "dshVersion": "0.2.2-rc.1", "certSha256": "<hex>" }
```
   `capabilities` on the companion channel are exactly the package `CAPABILITIES` the gateway supports;
   `push-v1` is added only when remote push is configured; `session-rename` and `session-archive` are
   added only when the device holds `sessions:author` (revision 11); `permission-lower` is added only
   when the device holds `permission:lower` (revision 13). Revision 14 adds `webLock` **only** when the
   device holds `web:unlock`: `"unregistered"` (no passkey on this device yet), `"locked"` (a passkey
   exists, this socket has not asserted yet) or `"unlocked"` (§14).
6. Client sends `{ "type": "client-hello", "requestId": "...", "companionProtocol": 1, "appVersion": "x.y.z", "platform": "ios|android" }`.
   Server answers `{ "kind": "client-hello", "requestId": "...", "accepted": true }` or an error
   `protocol/unsupported` (with `minClientVersion`) and closes.

HTTP upgrade failures: `401` missing/invalid/revoked credential or expired code; `403` remote control
disabled **or any plaintext (non-TLS) source that is not loopback**. Companion device credentials
(`Authorization: Bearer`, `dsh-auth.`, `dsh-pair.`) are accepted **only on the gateway's own TLS
listener**: on the shared plaintext web-server upgrade the same credential gets `401 auth/required`.
This is not negotiable — the pin is only enforced on the TLS listener, so a plaintext token would
bypass it. Close codes: `4004` gateway disabled (stop auto-reconnect), `4003` re-authenticate, `4401` revoked, `4412` locked (revision 14: this web device's passkey was replaced elsewhere, or its replacement was approved — re-assert; keep the credential, unlike `4401`).

### 3.7 Request framing rules (applies to every §4 operation)

- `requestId` is required for every client operation: a non-empty string of **1–64** characters from
  `[A-Za-z0-9._-]`. Anything else is refused `bad-request` before any Host work, and the refusal does
  not echo the out-of-bounds value.
- A `requestId` still in flight on the same socket is refused `bad-request` (no duplicate correlation
  and no second Host call). Ids are released when their request settles; a socket tracks at most 256.
- Before a `client-hello` has been accepted, only `client-hello` and `ping` run; every other operation
  is refused `bad-request` and no Host call is made. `client-hello` is exempt from device scope checks
  (negotiation must be possible) but grants nothing by itself.
- Push frames carry no `requestId` and are unaffected by these rules.
- At 256 tracked in-flight `requestId`s, further id-bearing requests receive `bad-request` until an
  outstanding request settles.
- Upgrade refusal checks have precedence: a non-loopback plaintext request that also carries query
  credentials may receive `401` rather than `403`. **No plaintext request authenticates a device
  credential.** Credential acceptance requires the gateway's own TLS listener, not merely an encrypted
  socket on a shared web server.


### 3.8 Pairing proof exchange (revision 6, additive — measured against the live gateway 2026-11-10)

A pairing connection (subprotocol `dsh-pair.<code>`, header `X-DSH-Device-ID`) is a **restricted state
machine, not a MobileConnection**. This section was missing from revisions 1–5 and its absence made the
companion unable to pair with the real Host: the client was closed with `op/forbidden` and then
`4408 pairing/timeout` while every fixture-based test passed.

Immediately after the WebSocket opens, the gateway sends exactly one challenge (it is NOT triggered by
any client frame):

```json
{ "kind": "pairing-challenge", "serverNonce": "<base64url, 24 random bytes>", "certSha256": "<64 lowercase hex>", "otpRequired": false }
```

`certSha256` is the pinned leaf the client just verified. `otpRequired` is `false` for the QR / long
pairing-string flow and `true` for an OTP flow.

Until this client has been admitted, the ONLY frame it may send is `pairing-proof`. Any other frame is
refused with `{ "kind": "error", "code": "op/forbidden", "requestType": "<type>", "message": "only the
pairing proof is accepted before the Host approves" }`; the third refusal closes the socket with **4403**
and reason `pairing/refused`.

The client MUST answer exactly once:

```json
{ "type": "pairing-proof", "clientNonce": "<16–64 chars of [A-Za-z0-9_-]>" }
```

- `clientNonce` is mandatory and MUST match `^[A-Za-z0-9_-]{16,64}$` (≥ 96 bits of randomness
  RECOMMENDED). A missing or ill-formed nonce closes the socket with **4403**, reason `pairing/bad-nonce`.
- When the challenge had `otpRequired: true`, `otpProof` is REQUIRED and carries the client's
  one-time-code proof; a wrong or expired proof closes with **4410**, reason `pairing/expired`.
- When `otpRequired` is `false` (long pairing string) the string is itself the secret: a well-formed
  proof reserves it and raises one pending request. `otpProof` MUST be absent.

After a valid proof the socket stays open while the **Host user approves on the desktop**:

```json
{ "kind": "pairing-pending", "verificationCode": "<short human code>", "requestId": "<id>", "expiresAt": 0 }
```

`verificationCode` MUST be shown to the user — they compare it with what the desktop displays. `expiresAt`
is epoch milliseconds; the pending window is **5 minutes**. While pending the client MUST NOT send any
frame and MUST NOT treat the pairing as failed or as successful: success is only `paired`. **Any client
handshake deadline that spans this window is a defect** — the approval wait must be governed by its own
deadline, not by the transport handshake timeout.

On approval the gateway sends `paired` and then `hello` exactly as §3.3 / §3.5, and the `client-hello`
exchange takes over. On refusal or expiry it sends `{ "kind": "pairing-rejected", "reason": "<reason>" }`
and closes.

Pairing close codes (additions to the §3 close-code list):

| Code | Reasons (examples) | Meaning | Client behaviour |
|---|---|---|---|
| 4403 | `pairing/refused`, `pairing/bad-nonce`, `pairing/busy`, `pairing/disabled` | The Host refused this pairing attempt | Show "rejected"; do not retry automatically |
| 4408 | `pairing/timeout` | No valid proof before the handshake deadline | Show "timed out"; retry with a fresh code |
| 4410 | `pairing/expired` | The one-time code or the pending request expired | Show "expired or already used"; a new code is required |

A bare `paired` frame is NOT part of the pairing connection and clients MUST NOT send it.

## 4. Operations (allowlist `companion-v1`)

The op identity is the `type` value. Anything else → error `op/forbidden`.

| `type` | Params | Response `kind` | Notes |
|---|---|---|---|
| `client-hello` | `companionProtocol`, `appVersion`, `platform` | `client-hello` | §3 |
| `ping` | — | `pong` | keep-alive, every 25 s |
| `sessions` | — | `sessions` `{items[]}` | upstream list projection (title in `projections.values.title`; spec 018: optional `projections.values.agentPreset`, a preset id matching `^[A-Za-z0-9._:-]{1,64}$`, omitted otherwise — view only) |
| `search` | `query` | `search` | |
| `history` | `sessionId`, `beforeSeq?`, `maxMessages?`, `maxBytes?` | `history` | upstream paging |
| `subscribe` | `sessionId` | `subscribed` | starts `event` pushes + replays pending approvals |
| `unsubscribe` | — | `unsubscribed` | |
| `message` | `sessionId`, `text`, `clientMsgId`, `mode?` (`queue`\|`steer`) | `sent` `{sessionId, clientMsgId}` | `sessionId` required (this op never creates a session; revision 7 adds `session-create` for that); idempotent by `clientMsgId` |
| `session-cancel` | `sessionId` | `session-cancelled` `{accepted}` | |
| `approval-response` | `rpcId`, `sessionId`, `approvalId`, `argsHash`, `outcome` | `approval-response` receipt | §5 |
| `device-info` | — | `device-info` `{id, name, createdAt}` | |
| `device-forget` | — | `device-forgotten` | revokes **this** device; server then closes `4401` |
| `push-register` | `platform` (`apns`\|`fcm`), `token` | `push-registered` | only if `push-v1` advertised |
| `push-remove` | — | `push-removed` | only if `push-v1` advertised |
| `workspaces` | — | `workspaces` | revision 7, scope `sessions:author`: this Host's workspace list. A device without `workspace:manage` receives a projected list: each item carries `workspaceId` and a `name` — the Host's `name`/`title`, else the last path segment; a workspace with no label at all is omitted — while the absolute `path`, member `sessionIds`, timestamps and the top-level `archivedSessionIds` are omitted. A device holding `workspace:manage` receives the full Host shape |
| `session-create` | `requestId`, `workspaceId?` \| `cwd?`, `title?` | `session-created` | revision 7, scope `sessions:author`; the workspace must exist on that Host. A device without `workspace:manage` MUST name a non-blank `workspaceId` and may not send `cwd` or `agentPreset` (any value, including `null`): refused `remote/argument-denied` with no Host call |
| `models` | `sessionId?` | `models` | revision 7, scope `sessions:author`: the catalog, or one session's models |
| `select-model` | `sessionId`, `provider`, `model`, `reasoningEffort?` | `select-model` | revision 7, scope `sessions:author`; session-scoped, never Host settings |
| `session-rename` | `sessionId`, `title` | `session-renamed` `{sessionId, title, seq}` | revision 11, scope `sessions:author`; session-scoped (the session must be visible to the device); `title` trimmed, non-empty, at most 200 code points, else `bad-request`. Decided on `{kind:'session', id}` |
| `session-archive` | `sessionId` | `session-archived` `{sessionId, archivedSessionIds}` | revision 11, scope `sessions:author`; session-scoped, a device may archive only a session it can see. Decided on `{kind:'session', id}` |

## 5. Approvals

Push:
```json
{ "kind": "approval-requested", "rpcId": "...", "sessionId": "...", "approvalId": "...",
  "toolName": "bash", "callId": "call-42", "reason": "...", "displayReason": { "en": "..." },
  "argsHash": "<64 hex> | null", "argsPreview": "<≤ 2 KB text>", "replay": true }
```
- `argsHash = sha256_hex(JCS({toolName, callId, arguments: JSON.parse(rawArguments)}))`.
  `null` when the gateway cannot bind content (no `callId`, no `tool/call` within 1 s, unparsable arguments):
  the client MUST NOT offer approve/reject; the desktop decides.
- Client deduplicates by `rpcId`.

Response: `{ "type": "approval-response", "requestId", "rpcId", "sessionId", "approvalId", "argsHash", "outcome": "allowed-once" | "rejected" }`.
`cancelled`/`unavailable` are host states and are never sent by the client.

Receipt: `{ "kind": "approval-response", "requestId", "rpcId", "sessionId", "approvalId", "outcome", "accepted": true }`
or `accepted: false` with `reason` ∈ `not-pending` (already decided / handed to desktop),
`hash-mismatch` (content changed — client reloads the card and asks the user to review again).

Final state push: `{ "kind": "approval-resolved", "rpcId", "sessionId", "approvalId", "outcome": "allowed-once" | "rejected" | "cancelled" | "unavailable" }`.

## 5a. Clarifications (rev 2.1, 2026-11-09 — from app integration)

- The client is **ready only after** `{kind:"client-hello", requestId, accepted:true}`; `hello` alone is not enough.
- Server negotiates back exactly `dsh-mobile-v1` as the subprotocol (never echoes `dsh-pair.`/`dsh-auth.`/`dsh-device.`).
- `paired` is sent only on pairing connections, never on Bearer connections.
- An approval refusal (`not-pending`, `hash-mismatch`) is a **normal receipt** with `requestId` and
  `accepted:false`, never an error frame.
- Error frame with `requestId` fails that request only; without `requestId` it fails all pending requests.
- When the owner switch is turned off, established sockets are closed with **4004** (in addition to new
  upgrades getting 403), so the client can show "turn on remote control".
- `argsPreview` is always a string.
- `history` reply: `{kind:"history", requestId, items[], hasMore}`; rows carry `seq`, `role`, `text`, `createdAt`.
- `sessions` rows carry `sessionId`, `updatedAt` (epoch ms), `running`, `projections.values.title`; the client
  derives running/idle/archived.

## 6. Error codes

| code | HTTP (upgrade) | Meaning |
|---|---|---|
| `auth/required` | 401 | missing credential |
| `auth/revoked` | 401 | device revoked (WS close `4401`) |
| `auth/forbidden-scope` | — | revision 3: this device's scopes do not cover the op |
| `remote/disabled` | 403 | owner switch off |
| `op/forbidden` | — | type not in `companion-v1` |
| `pairing/expired` | 401 | code expired or already used |
| `protocol/unsupported` | — | companion protocol version mismatch |
| `bad-request` | — | invalid params |
| `session-not-found` | — | host error passthrough |
| `auth/locked` | — | revision 14: a `web:unlock` device that has not passed a passkey assertion on this socket; `reason` one of `locked`, `unregistered`, `rate-limited` (§14.5) |
| `passkey/not-registered` | — | revision 14: `passkey-assert` on a device with no passkey (§14.4) |
| `passkey/already-registered` | — | revision 14: `passkey-register` when this device already has one — replacing it needs the owner's approval on the Host (§14.4) |
| `passkey/challenge-expired` | — | revision 14: no live challenge for this socket (expired, already used or never requested) |
| `passkey/verification-failed` | — | revision 14: the attestation/assertion did not verify; no detail beyond the code |
| `passkey/rate-limited` | — | revision 14: failed passkey operations exceeded §14.5's rate limits |

Other host error codes (e.g. `agent-busy`, `internal`) may be passed through unchanged; clients show a
generic error for codes they do not know.
## Revision 4 (spec 008 P1, additive)
Scope `harness:remote` (desktop-only, explicit). Client frames: `remote-call {requestId, endpoint, args}`, `remote-stream-open {streamId, endpoint, args}`, `remote-stream-cancel {streamId}`, `remote-stream-credit {streamId, n}`. Server frames: `remote-result {requestId, ok, value|error}`, `remote-frame {streamId, seq, value}`, `remote-stream-closed {streamId, error?}`. `/result` is never forwarded raw; it is bound to the pending approval's `argsHash` (mismatch: `accepted:false, reason:'hash-mismatch'`, stays pending).

`remote-call` requires a valid `requestId` (§3.7). `remote-stream-open`, `remote-stream-cancel` and
`remote-stream-credit` may omit `requestId`; when supplied it is validated. Id-bearing asynchronous
call/open requests share the socket's duplicate-in-flight and 256-id admission rules.

## Revision 5 (spec 008 P1b + full control, additive)
Pairing with Host approval, subprotocol `dsh-pair-otp.v1`: `pairing-challenge {serverNonce}`, then `pairing-proof {clientNonce, otpProof=HMAC-SHA256(otp, certSha256||clientNonce||serverNonce)}`, then `pairing-pending {verificationCode}` (6 digits; both sides display it), then on Host Approve the existing `paired` frame; on Reject `pairing-rejected`, close 4403. A wrong or expired code or a pending timeout closes 4410. The long pairing string also waits for approval when `requireHostApproval` is set (default true).
Desktop-only explicit scopes: `commands:execute`, `workspace:manage`, `credentials:write`, `plugins:manage`, `schedule:write`, `terminal`. Presets `standard` / `full`. Bridge limits default to 0, meaning unlimited (owner decision).

## Revision 7 (spec 011 session authoring, additive)

Four client ops join §4: `workspaces`, `session-create`, `models`, `select-model`, answered with
`workspaces`, `session-created`, `models` and `select-model`. They are gated by ONE new scope,
`sessions:author` — for both device kinds on purpose: a paired phone may start its own session, and
the owner decides per device. It is never a default and never implicit; `full` includes it.

What the scope permits is exactly: list this Host's workspaces, list the model catalog (or one
session's models), create a session, and pick the provider/model for a session the device may already
address. `session-create` places the session in a `workspaceId` that exists on that Host; a `cwd`
outside every known workspace still needs `workspace:manage`. `select-model` is session-scoped: it is
NOT `settings:write` and it cannot change Host defaults or agent presets.

**Workspace visibility is the Host's own per-item decision.** DSH's `workspace/follow` baseline
filters each item through `remoteAccess.allows({kind:'workspace', id})`, so a device sees a workspace
only where its policy binds that exact workspace id — a `global` action alone yields `items: []` with
no error, which is how "this computer has no workspaces" reached a phone on a Host with nine. The
gateway therefore registers one `workspace` binding per workspace id of the Host, whose only action is
`workspace/follow`, for a device that holds `sessions:author`, and registers none for a device that
does not. `name` is the Host's `name` or `title`; when both are empty the last path segment is used
(`…\DXVK_Project` → `DXVK_Project`), and a workspace with no label at all is omitted rather than shown
as a bare id. An absolute path, member session ids, timestamps and the archive list are never sent to a
device without `workspace:manage`.

Everything else stays refused for every device, whatever scopes it holds: creating, renaming or
archiving a workspace; forking a session (renaming and archiving a session join in revision 11);
queue control; attachments; slash
commands; `settings/*`; the plugin and schedule families. Feature 012 turns that list into the single
hard blocklist and makes every other capability grantable per device.

**Never-default is a named rule, not a comment.** Because `sessions:author` is mobile-grantable it
would otherwise fall into BOTH default computations (the gateway's pairing-offer default and the device
registry's default), handing a newly paired phone the right to start agent work without the owner
choosing it. The contract therefore exports
`NEVER_DEFAULT_SCOPES = Object.freeze(['sessions:author'])`, and both default sites must subtract that
set. A default grant never contains a member of it; an EXPLICIT `scopes` argument that names it keeps
it, and an explicit empty list stays empty (never "no choice, so take the default"). See
`plugins/mobile-gateway/test/session-authoring-defaults.test.mjs`.
**Sub-agent sessions (revision 7, measured on a live Host where 827 of 861 sessions were
sub-agents).** A `sessionId` on `models` may name a direct sub-agent. DSH itself refuses a root
address for a sub-agent header (`session/agent-busy`, "subagent Sessions require their durable
parent address"), so the gateway resolves the durable parent from the `session/list` rows its own
peer may already list and re-reads with `{kind:'subagent', parentSessionId, childSessionId,
mode:'unknown'}`. The reply is the SAME shape as for a root session and carries no parent field, so
a device learns no session it could not already list; a stale or wrong parent is refused by DSH
(`subagent/unauthorized`), and an unresolvable parent keeps `session/agent-busy` with no blind retry.

`select-model` cannot work on a sub-agent at all: DSH's request schema has no address parameter and
resolves a child outright. It therefore answers the STABLE code `subagent/model-inherited` (message:
the sub-agent inherits its parent's model, without naming the parent) instead of the misleading
`session/agent-busy`. Clients must render that as "this session follows its parent's model", never as
a failure to reach the computer.
**`session-create` is decided on the target Workspace as well as globally.** A Remote call resolves
one resource per registered resource *kind* and **every** one of them must be allowed
(`dsh-api-gateway` `callResources()`); the workspace controller registers a field kind on
`workspaceId`, so a `session-create` that names a workspace is decided on
`{kind:'workspace', id:<workspaceId>}` in addition to `global`. A device holding `sessions:author`
therefore carries **exactly two** actions on each per-workspace binding it is granted —
`workspace/follow` and `session/create` — and nothing else. A device without the scope holds no
workspace binding at all, so it can neither list nor create. Every workspace-independent authoring op
(`models`, `select-model`) is unaffected, and creating, renaming or archiving a **workspace** remains
refused for every device.



## Revision 8 (spec 013, additive)

Attaching files and images from the desktop client to a session on a **remote** Host. The bytes travel
over the existing pinned, per-device-authenticated WebSocket as chunked frames — no new listener, no
new port, no HTTP route. The Host stages them through its own upload service, so the result is exactly
what the native `POST /api/session/uploadFileBinary` route returns.

### 8.1 Scope

One new scope, `attachments:write`:

- It is **grantable to a `desktop` device** and is part of `DESKTOP_DEFAULT_SCOPES` — a desktop offer
  gets it unless the owner unticks it on the Devices page (spec 012: everything grantable is on by
  default). It is not in `DESKTOP_ONLY_SCOPES`, because that list means "explicit only".
- It is in `NEVER_DEFAULT_SCOPES`, so no **kind-independent** default acquires it: the mobile-offer
  default and the pre-005 migration (a record written before `kind`/`scopes` existed) never contain it.
  **Existing paired devices are not migrated to it**: a record keeps exactly the scopes it holds, and an
  owner grants the new one through the Devices page.
- It is in `SCOPE_PRESETS.full` (every contract scope) and not in `standard`.
- Frame types `remote-upload-open|-chunk|-finish|-cancel` are the only four types that map to it
  (`SCOPE_BY_TYPE`). A device without the scope is answered `auth/forbidden-scope` with
  `scope: "attachments:write"` before any Host work.

### 8.2 Frames

All four frames are **not** §4 operations: `OPS` is unchanged, and `op/forbidden` remains the answer for
any type outside the vocabulary. They require `client-hello` to have been accepted, and a `requestId`
of 1–64 characters from `[A-Za-z0-9._-]` (§3.7). Each frame is answered with exactly one
`remote-upload-result` that echoes its `requestId`:

```json
{ "kind": "remote-upload-result", "requestId": "...", "ok": true, "value": { } }
{ "kind": "remote-upload-result", "requestId": "...", "ok": false,
  "error": { "code": "file-upload-offset", "message": "...", "details": { } } }
```

`error.code` is the gateway's stable transfer code or the Host's own code, `error.message` is short
display text, and `error.details` is present only when the Host supplied details (for example
`{ "reason": "UNSUPPORTED_IMAGE_TYPE" }`). A failure never arrives as a `kind: "error"` frame: it is a
normal result with `ok: false`.

#### `remote-upload-open` → opened value

```json
{ "type": "remote-upload-open", "requestId": "...", "sessionId": "s-1", "kind": "file",
  "name": "report.pdf", "size": 123456, "sha256": "<64 lowercase hex>" }
{ "type": "remote-upload-open", "requestId": "...", "sessionId": "s-1", "kind": "image",
  "name": "photo.png", "mediaType": "image/png", "size": 2048, "sha256": "<64 lowercase hex>" }
```

- `sessionId` is the **untagged, remote-local** session id (never `h:<host>:<id>`): the id this Host
  listed to that device. `kind` is `file` or `image`. `name` is an optional display name (a leaf
  filename, 1–255 characters, no control characters, no `/` or `\`). `mediaType` is REQUIRED for
  `kind: "image"` and MUST be absent otherwise. `size` is the exact decoded byte count of the whole
  file, `sha256` its digest over the whole file (verified at `finish`).

```json
{ "kind": "remote-upload-result", "requestId": "...", "ok": true,
  "value": { "uploadId": "<uuid>", "sessionId": "s-1", "kind": "file", "name": "report.pdf",
             "size": 123456, "chunkBytes": 262144, "maxBytes": 536870912, "idleTimeoutMs": 120000 } }
```

`chunkBytes` is the effective chunk limit for this transfer (`min(256 KiB, the gateway's payload
budget)`); `maxBytes` is the configured `fileUploadMaxBytes` (512 MiB by default); `idleTimeoutMs` is
`fileUploadIdleMs` (2 minutes by default). `mediaType` is echoed for `kind: "image"`.

#### `remote-upload-chunk` → accepted value

```json
{ "type": "remote-upload-chunk", "requestId": "...", "uploadId": "<uuid>", "offset": 0, "data": "<base64>" }
{ "kind": "remote-upload-result", "requestId": "...", "ok": true,
  "value": { "uploadId": "<uuid>", "sessionId": "s-1", "nextOffset": 262144 } }
```

`data` MUST be **canonical** standard base64 of at most `chunkBytes` decoded bytes, and `offset` MUST
equal the bytes already accepted (`nextOffset`, starting at 0). Chunks are strictly sequential: the
client waits for `nextOffset` before sending the next one; there is no pipelining and no resumption
across connections.

#### `remote-upload-finish` → the Host's receipt

```json
{ "type": "remote-upload-finish", "requestId": "...", "uploadId": "<uuid>" }
{ "kind": "remote-upload-result", "requestId": "...", "ok": true,
  "value": { "receiptId": "<opaque>",
             "file": { "attachmentId": "sha256:...", "name": "report.pdf", "bytes": 123456 } } }
```

or, for `kind: "image"`:

```json
{ "kind": "remote-upload-result", "requestId": "...", "ok": true,
  "value": { "receiptId": "<opaque>",
             "image": { "attachmentId": "sha256:...", "mediaType": "image/png",
                        "bytes": 2048, "width": 640, "height": 480 } } }
```

`value` is the **remote Host's own upload result, passed through opaque** — the very object the native
`POST /api/session/uploadFileBinary` route answers with. The client MUST NOT rebuild it: it sends
`{ "type": "file" | "image", "receiptId": "..." }` in its next `message` and the Host resolves the
receipt for that session's agent. Repeating `finish` for the same `uploadId` on the same connection
returns the same receipt and stores nothing twice.

#### `remote-upload-cancel` → cancelled value

```json
{ "type": "remote-upload-cancel", "requestId": "...", "uploadId": "<uuid>" }
{ "kind": "remote-upload-result", "requestId": "...", "ok": true,
  "value": { "uploadId": "<uuid>", "sessionId": "s-1", "cancelled": true } }
```

Cancelling is idempotent only in the sense that a second `cancel` answers `file-upload-not-found`: the
partial spool is already gone. Closing the socket, revoking the device or an idle timeout frees the
partial data the same way; a cancelled or expired transfer never produces a receipt.

### 8.3 Mandatory checks

Each one is refused before the next step runs, and each has a named test in
`plugins/mobile-gateway/test/remote-upload.test.mjs`:

| # | Check | Refusal |
|---|---|---|
| 1 | `attachments:write` on a **live** credential (`scopeDenial`) | `auth/forbidden-scope` (`scope: "attachments:write"`) |
| 2 | the device kind is `desktop` | `auth/forbidden-scope` (`scope: "attachments:write"`) |
| 3 | the session is visible to this device (`sessions:read` + the Host's visible set) | `session-not-found` |
| 4 | `offset` equals the bytes already accepted (monotonic) | `file-upload-offset` |
| 5 | `data` is canonical base64 of at most `chunkBytes` decoded bytes | `file-upload-invalid-data` |
| 6 | the whole-file `sha256` matches at `finish` | `file-upload-checksum` |
| 7 | `size` ≤ `fileUploadMaxBytes` | `file-too-large` |
| 8 | a chunk never exceeds `size` | `file-upload-size` |
| 9 | at most `fileUploadMaxTransfers` (default 4) concurrent transfers **per device** | `file-upload-limit` |
| 10 | an idle transfer (no frame for `fileUploadIdleMs`) is expired and its spool deleted | `file-upload-not-found` afterwards |
| 11 | `kind: "image"`: `mediaType` is one the Host accepts (`ctx.attachments.imageLimits.mediaTypes`: `image/png`, `image/jpeg`, `image/webp`, `image/gif`) | `session/attachment-invalid` (`details.reason: "UNSUPPORTED_IMAGE_TYPE"`) |

The Host's own admission still runs on top: its attachment store enforces `maxImageBytes`,
`maxImagePixels` and `maxImageDimension` for images, its normalizer may re-encode an image (so the
receipt's `bytes`/`width`/`height` are the stored image, not the uploaded bytes), and a session that
disposed mid-transfer is refused `session/not-found`. Every Host failure reaches the client as
`ok: false` with the Host's `code` and `details`.

The generic RPC `fileUploads/upload` stays **denied** over the remote bridge (it is not on the
endpoint allowlist, so it answers `op/forbidden`), and so does every entry of the existing deny list.
`session/attachment` — the read used to render an image preview — stays on the allowlist under
`sessions:read` (revision 4) and needs no change for this revision.

### 8.4 Error codes

| code | Meaning | Client behaviour |
|---|---|---|
| `auth/forbidden-scope` | no `attachments:write`, or the device is not a `desktop` | hide the attach control |
| `session-not-found` | the session is not visible to this device | treat as a gone session |
| `bad-request` | malformed frame (missing/invalid `requestId`, `kind`, `name`, `size`, `sha256`, `offset`) | fix the request; never retry blindly |
| `file-upload-disabled` | the owner disabled uploads (`fileUploadsEnabled: false`) | show "attachments are off" |
| `file-upload-unavailable` | the Host's upload service is missing or not streaming | show "this Host cannot receive attachments" |
| `file-too-large` | `size` exceeds `fileUploadMaxBytes` | show the limit, refuse the file |
| `file-upload-limit` | too many concurrent transfers for this device | queue the transfer |
| `file-upload-not-found` | unknown, foreign, expired or cancelled `uploadId` | restart the transfer |
| `file-upload-offset` | `offset` is not the next expected byte | restart the transfer |
| `file-upload-invalid-data` | not canonical base64, or longer than `chunkBytes` | restart the transfer |
| `file-upload-size` | the chunk would exceed `size` | restart the transfer |
| `file-upload-incomplete` | `finish` before every declared byte arrived | keep sending, then finish again |
| `file-upload-checksum` | the bytes do not match the declared `sha256` | restart the transfer |
| `file-upload-busy` | another operation on the same transfer is running | wait and retry |
| `file-upload-timeout` | the Host's staging call timed out | show "the computer is slow", retry |
| `file-upload-cancelled` | cancelled by either side, or the socket closed | drop the transfer |
| `file-upload-failed`, `file-upload-invalid-response` | the Host could not stage the bytes, or its answer was not a receipt | show a generic error |
| `session/attachment-invalid` | the Host refused the image (`details.reason`) or the session disposed | show the reason, refuse the file |
| `gateway/internal` | unexpected Host failure | show a generic error |

Any code a client does not know gets the same generic "could not attach the file" treatment, exactly
as §5a says for unknown error codes.

## Revision 9 (companion parity with Clarklevis dsh-mobile, additive)

### 9.1 Workspace identity on session rows

Optional fields `workspaceId` (string, the id op `workspaces` returns) and `workspaceLabel` (string,
the same basename as that op's `name`) on: each item of op `sessions`, each `session-status` event, and
`session-created`. Rules:

- Source is the Host's own attach relation (`workspace.sessionIds`), resolved server-side; DSH session
  records carry no `workspaceId` (measured 2026-11-11). A sub-agent inherits its parent's workspace.
- A session the Host attributes to no workspace carries **neither** field (absent, never `null`).
- Only an id and a basename — never a path. Granted to every device that may already see the row
  (rows already carry `cwd`, so the basename discloses nothing new); independent of `sessions:author`.
  `workspaces.sessionIds` stays stripped for devices without `workspace:manage`.

### 9.2 History wire shape (correction of §4 / clarification §5a)

The `history` reply carries the Host's DSH events verbatim — `{kind:"history", events:[{type, seq,
time, data}]}` — and **not** `{seq, role, text, createdAt}` rows; `items`/`messages` are absent
(measured). Live pushes are `kind:"event"` frames reshaped by the gateway (`user/message`,
`assistant/message` with `text`), likewise without `role`. Clients derive the role from `type`:
`user/message` → user, `assistant/message` → assistant, `tool/call`/`tool/result` → tool; turn, step,
llm, title, job and other bookkeeping events are not rendered. Rows that already carry `role` keep the
old meaning.

## Revision 10 (spec 016 Phase 3 — the host drives a browser on the client, additive)

The first **host-initiated** request/response on the link: until now every request came from the
client. Additive — `OPS` (§4) does not change, no type gains a `SCOPE_BY_TYPE` entry, and the wire
protocol stays v1. Owner decision 2026-11-11 (spec 016 Phase 3, option 2): the browser a host drives
lives on the CLIENT, in the plugin's own tab with its own storage partition, driven over the pinned
link. Two keys are required, neither implies the other (§10.5).

### 10.1 Capability

`browser-agent:1` is an **optional** capability, never part of the required `CAPABILITIES`:

- the gateway adds it to `hello.capabilities` when its browser bridge is available;
- a client lists it in the optional `capabilities` array of `client-hello` when it can answer a
  `browser-command` (a client that omits the field is simply not a target). Unknown names in that
  array are ignored, so an older gateway and an older client keep working unchanged.

### 10.2 Frames

| direction | frame | shape |
|---|---|---|
| host → client | `browser-command` | `{ "kind": "browser-command", "commandId": "c1", "sessionId": "s1", "op": "screenshot", "args": {}, "deadlineMs": 30000 }` |
| client → host | `browser-result` | `{ "type": "browser-result", "commandId": "c1", "ok": true, "result": { … } }` or `{ "type": "browser-result", "commandId": "c1", "ok": false, "error": { "code": "browser/denied", "message": "…" } }` |
| host → client | `browser-cancel` | `{ "kind": "browser-cancel", "commandId": "c1" }` |
| client → host | `browser-cancel` | `{ "type": "browser-cancel", "commandId": "c1" }` |

- `commandId` is 1..64 characters of `[A-Za-z0-9._-]` — the same shape as a `requestId` — and it is
  the ONLY correlation key: these frames are not §4 operations, so the §1 `requestId` echo rule does
  not apply to them.
- `op` is exactly one of `navigate`, `click`, `type`, `press`, `scroll`, `open`, `close`, `snapshot`,
  `text`, `html`, `screenshot`, `tabs`. Any other value is refused `bad-request` before a device sees
  the frame; a client MUST NOT invent an op.
- `args` is an object (absent ⇒ `{}`). `sessionId` is the session whose agent asked, so the client can
  show which session is driving.
- Exactly one `browser-result` per `commandId`. A result whose id is unknown, already settled, or
  issued to a different device is ignored (never applied, never answered).
- `browser-cancel` may arrive from either side: the host abandons a command (deadline, abort, device
  revoked), or the client declines one it was given. A cancelled command gets no result.

### 10.3 Limits

| limit | value | enforced where |
|---|---|---|
| complete frame, serialized | ≤ 1048576 bytes (1 MiB), either direction | host before send (`browser/frame-too-large`), client before answering |
| deadline | default 30000 ms, maximum 120000 ms | host; a larger `deadlineMs` is clamped, not refused |
| screenshot | JPEG, ≤ 786432 decoded bytes (768 KiB) | client shrinks it; the host refuses an oversized frame |
| `text` / `html` | cut at 262144 bytes (256 KiB) | client cuts and sets `truncated: true`; the host cuts again rather than storing more |

### 10.4 Mandatory checks (host side, in this order, before a frame is sent)

1. the target device is paired and its credential is live (`browser/unknown-target` otherwise);
2. the device has a ready connection (`browser/offline`) — checked before the capability,
   because the capability is advertised on a live connection;
3. the device advertised `browser-agent:1` in its `client-hello` (`browser/not-supported`);
4. the device's live grant includes `browser:control` (`browser/forbidden-scope`);
5. no other command is in flight for that device (`browser/busy`) — one at a time per device;
6. the frame fits §10.3 (`browser/frame-too-large`);
7. the deadline starts when the frame is sent; on expiry the host sends `browser-cancel` and answers
   `browser/timeout`.

A revocation, or the removal of `browser:control`, takes effect **immediately**: an in-flight command
is cancelled (`browser/forbidden-scope` when the grant went away, `browser/offline` when the device's
connection closed) and its late result is ignored.

### 10.5 Error codes

| code | meaning | who sends it |
|---|---|---|
| `browser/not-supported` | the device never advertised `browser-agent:1`, or this host has no bridge | host |
| `browser/forbidden-scope` | no `browser:control` on the device, or the grant was removed mid-flight | host |
| `browser/offline` | the device is not connected | host |
| `browser/timeout` | the deadline expired; a `browser-cancel` was sent | host |
| `browser/cancelled` | either side cancelled | host |
| `browser/busy` | a command is already in flight for that device | host |
| `browser/unknown-target` | not a paired device id, or the credential is revoked | host |
| `browser/bad-request` | malformed frame (§10.2) | either side |
| `browser/frame-too-large` | over §10.3 | either side |
| `browser/denied` | the client's own consent setting is off for this host | client |
| `browser/not-found` | unknown tab/page id | client |

A client may return any `browser/…` code it needs; the host shows a generic error for a code it does
not know, as §5a says for unknown codes.

### 10.6 Target resolution and the `remoteSessionScope` service

A tool asks for a target: `auto` | `host` | `<deviceId>`. `auto` is the last device that **prompted**
this session ("driven") when it is connected, capable and granted — otherwise `host`, i.e. the local
owner's own browser. The gateway records the last prompt device per session from two places: the
remote-bridge `session/prompt` call it forwards, and a companion `message` op. A prompt the gateway did
not proxy is the local owner's (no device). A frame without a `sessionId` records nothing.

The gateway publishes that as two host services (spec 014 C6):

```js
ctx.provide('remoteSessionScope', {
  describe(session) { return { driven: 'remote', deviceId: 'dev-1', scopes: ['browser:control', …] } },
})
ctx.provide('remoteBrowser', {
  targets(sessionId),                       // [{ id: 'host' | deviceId, name, connected, capable, granted }]
  send(target, sessionId, op, args, signal) // → { ok: true, value } | { ok: false, error: { code, message } }
})
```

`driven: 'local'` means the local owner's session (no scope needed); anything undeterminable is
reported as remote, per C6.

**Two keys, never one:** the host needs the `browser:control` grant on the device AND the client needs
its own "allow the paired host to drive a browser on this machine" setting (off by default, per
host). Every result that carries page content is wrapped as untrusted page content on the host, and
the client keeps a visible "agent is driving" indicator plus a kill switch.

## Revision 11 (session rename/archive, additive)

Two client ops join §4: `session-rename` and `session-archive`, answered with `session-renamed` and
`session-archived`. Both use the existing never-default scope `sessions:author` (no new scope) and are
session-scoped: the gateway decides them on `{kind:'session', id}`, so a device can rename or archive only a
session it can see. `title` is trimmed and must be non-empty and at most 200 code points, else
`bad-request`. `hello.capabilities` lists `session-rename` and `session-archive` only for a device holding
`sessions:author`; the app shows its row menu only when they are listed. Archiving a session removes it from
the device's list; the conversation stays on the Host.

## Revision 12 (specs 018 and 020 scopes, additive)

Three scopes join the scope table, each never-default and present in the `full` preset:

| Scope | Owner | Grants |
|---|---|---|
| `stats:read` | spec 018 | session stats and context usage frames (`session-stats` and its metric types) |
| `schedule:read` | spec 018 | the three read-only scheduled-task frames; every schedule mutation stays refused |
| `web:unlock` | spec 020, narrowed by spec 021 (revision 14) | the passkey frames that unlock a web (PWA) client (§14) |

Agent-team and sub-agent read frames ride the existing `sessions:read` scope (no new scope). Question
answer and cancel frames ride `approval:respond`. A locked web client receives `auth/locked` (§6) and the
close code `4412` (§3); it keeps its credential, unlike `4401`.

## Revision 13 (spec 019 permission control, additive)

Scope `permission:lower` (spec 019) joins the scope table: never-default, mobile-grantable, present only in
the `full` preset. It gates two frames that are NOT §4 ops (like the revision 8 upload family):
`permission-options {sessionId}` (the current preset and the strictly stricter presets with their
`{sandbox, approval}` pairs) and `permission-lower {sessionId, preset}` (receipt `accepted` plus
`reason` one of `not-stricter`, `custom-current`, `raced`, `unavailable`). Both are session-scoped. The
gateway only ever lowers: sandbox `read-only` < `workspace-write` < `danger-full-access`, approval
`ask` < `never`; the target must be no looser on both axes and stricter on one. Viewing the current preset
needs only `sessions:read` (`permissions.currentValue` in the session row). `hello.capabilities` lists
`permission-lower` only for a device holding `permission:lower`. Design: specs/019-parity-wave3-high-risk-design/permission-lower.md.

`permission-options` and `permission-lower` are the two frames gated by `permission:lower`.

## Revision 14 (spec 021 web passkey unlock, additive)

The spec 020 DeepSeek-account unlock is **replaced**: the PWA proves possession of a WebAuthn
passkey bound to its paired device. Additive — `OPS` (§4) does not change, no type gains a new
scope, and the wire protocol stays v1. A device without `web:unlock` (every native iOS/Android
device) is unaffected: it never receives `hello.webLock` and never sees a lock.

### 14.1 Frames

All four are **not** §4 operations. They are gated by the existing `web:unlock` scope (§3 FR2),
require an accepted `client-hello`, and each is answered with exactly one frame echoing its
`requestId` (§1/§3.7). Every binary field is **unpadded base64url**.

```json
{ "type": "passkey-register-options", "requestId": "r-1" }
{ "kind": "passkey-register-options", "requestId": "r-1", "challenge": "<32 random bytes>",
  "rp": { "id": "<hostname>", "name": "<gateway name>" },
  "user": { "id": "<base64url>", "name": "<device name>", "displayName": "<device name>" },
  "pubKeyCredParams": [{ "type": "public-key", "alg": -7 }, { "type": "public-key", "alg": -257 }],
  "excludeCredentials": [{ "type": "public-key", "id": "<stored credential id>" }], "timeout": 60000 }
```

`rp.id` is the hostname of the socket's `Origin` (the page can only assert with that id), and that
origin MUST be one of the gateway's `allowedOrigins`. `excludeCredentials` lists the device's stored
credential (empty when it has none), so a browser whose passkey already exists refuses a silent
duplicate.

```json
{ "type": "passkey-register", "requestId": "r-1",
  "attestation": { "id": "<base64url>", "rawId": "<base64url>",
                   "clientDataJSON": "<base64url>", "attestationObject": "<base64url>" } }
{ "kind": "passkey-register", "requestId": "r-1", "ok": true }
```

Accepted: attestation format `none` only (no attestation trust is needed — the device is already
paired with a per-device credential); credential public key ES256 (P-256, COSE algorithm identifier
-7) or RS256 (COSE algorithm identifier -257); any other key is refused. The gateway stores
`{credentialId, publicKey (COSE), signCount, createdAt}` for that device, in its owner-only state.

```json
{ "type": "passkey-assert-options", "requestId": "r-2" }
{ "kind": "passkey-assert-options", "requestId": "r-2", "challenge": "<32 random bytes>",
  "rpId": "<hostname>", "allowCredentials": [{ "type": "public-key", "id": "<stored credential id>" }],
  "timeout": 60000 }
{ "type": "passkey-assert", "requestId": "r-2",
  "assertion": { "id": "<base64url>", "rawId": "<base64url>", "clientDataJSON": "<base64url>",
                 "authenticatorData": "<base64url>", "signature": "<base64url>", "userHandle": null } }
{ "kind": "passkey-assert", "requestId": "r-2", "unlocked": true }
```

A challenge is **32 random bytes, single use, bound to the socket that asked for it**, with a
**60 s** lifetime (the answer's `timeout` is that bound). `passkey-assert` verifies, in this order:
`type` = `webauthn.get`; `clientDataJSON.challenge` equals the socket's live challenge;
`origin` equals **exactly** the socket's `Origin` AND that origin is in `allowedOrigins`;
`rpIdHash` = SHA-256(`rp.id`); flags UP and UV; the signature over `authenticatorData ||
SHA-256(clientDataJSON)` with the stored key; and `signCount` monotonic when both the stored and the
presented counters are non-zero. Success unlocks **that socket** only.

### 14.2 Lock

Each new WS connection from a web device starts **locked**. While locked the gateway answers only
`client-hello`, `ping`, `device-forget` and the four passkey frames; **everything else** — §4 ops,
the remote bridge, uploads, the browser family — is refused `auth/locked` with `reason` `locked`,
`unregistered` or `rate-limited`, before any Host call, and nothing about sessions (titles, counts,
ids) reaches the device. A locked device receives only `hello`, `paired`, `client-hello`, `pong`,
`error`, `device-info` and `device-forgotten` server frames. The lock is server-side, not a UI
convention.

Re-lock: a successful assertion covers that socket until it sends nothing for **15 minutes**
(measured from its last frame), until the owner revokes the device, until its passkey is replaced,
or until the PWA locks it: `{ "type": "passkey-lock", "requestId": "r-3" }` →
`{ "kind": "passkey-lock", "requestId": "r-3", "locked": true }` (scope `web:unlock`; accepted in
any lock state, so a tab that reloaded into a locked socket can still say so). Socket close and a
tab reload always require a new assertion.

### 14.3 Re-registration needs the owner

A device with no passkey registers with the desktop's approval (pairing, revision 5). Adding or
**replacing** a passkey on a device that already has one is refused
`passkey/already-registered`; the gateway raises a pending request the owner approves on the Host
(the same pending list and routes as pairing under `POST /mgw/pending/:id/approve|reject`), and
sends `{ "kind": "passkey-approval", "approvalId": "<id>", "action": "approve" | "reject",
"verificationCode": "<8 chars>" }` to the asking device. On `approve` the device re-sends
`passkey-register` with a fresh `passkey-register-options` challenge within 5 minutes; the new
passkey replaces the old one only after a fresh `passkey-assert` on that device (the other sockets
of that device are closed with `4412`, so every tab shows its lock screen again). A `reject`
answers nothing on the register path, but the asking socket is locked again.

### 14.4 Error codes

`passkey/not-registered` (assert with no passkey), `passkey/already-registered` (needs approval),
`passkey/challenge-expired`, `passkey/verification-failed` (every other verification failure; never
a reason), `passkey/rate-limited`. A failure never reveals which check failed. No credential id,
public key, challenge, clientDataJSON or signature is ever logged, and the error carries no field
beyond `code`, `requestType`, `requestId` and a fixed `message`. A malformed frame is `bad-request`
(§3.7): `requestId` 1–64 chars, every `attestation`/`assertion` field a base64url string.

### 14.5 Rate limits

Failures only: **5 failed operations per device in 10 minutes** and **30 globally per hour** lock
the affected devices out (`passkey/rate-limited`, and `auth/locked` with `reason: "rate-limited"`
for the request path) until the window passes. Failures are logged as codes only.

### 14.6 Revocation

Revoking the device on the Host deletes its passkey record and closes its sockets with `4401` (the
credential is gone, as §3 says). Re-pairing the same installation with a new grant clears the old
records with them.
