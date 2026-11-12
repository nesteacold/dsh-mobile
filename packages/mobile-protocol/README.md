# @dsh-ext/mobile-protocol

Versioned contract between the mobile companion app (spec 002) and the hardened gateway
(`plugins/mobile-gateway`, spec 001): protocol constants, the `companion-v1` operation allowlist,
response kinds, error codes, close codes, approval outcomes and frame shapes. Both sides import this
package so they cannot drift apart silently; the normative definition is
[`contracts/mobile-protocol-v1.md`](../../specs/001-gateway-hardening/contracts/mobile-protocol-v1.md)
(**revision 2**: client frames use `type` + `requestId`, server frames use `kind` and echo
`requestId`; **revision 3** adds device `kind`/`scopes` and `auth/forbidden-scope`,
`specs/005-remote-desktop-client/spec.md`; **revisions 4–5** add the spec 008 remote bridge and its
scopes, additive; **revision 7** adds the spec 011 `sessions:author` scope and the four
session-authoring ops, additive; **revision 8** adds the spec 013 `attachments:write` scope and the
`remote-upload-*` frames; **revisions 9–10** add workspace identity on session rows and the spec 016
Phase 3 host-driven browser (`browser-agent:1`, `browser-command`/`browser-result`/`browser-cancel`),
additive; **revision 11** adds the `session-rename` and `session-archive` ops on the same
`sessions:author` scope; **revision 12** adds the spec 018 `stats:read`/`schedule:read` and spec 020
`web:unlock` scopes, with `auth/locked` and the close code `4412`; **revision 13** adds the spec 019
`permission:lower` scope and its two frames; **revision 14** replaces the spec 020 DeepSeek-account
attestation with the spec 021 web PASSKEY unlock — the `passkey-*` frames on the same `web:unlock`
scope, `hello.webLock`, the `passkey/…` error codes; `account-attestation` is withdrawn), and a
breaking change requires a new major version of this package.

- Runtime: `src/index.mjs` — pure ESM, no dependencies, frozen constant tables.
- Types: `index.d.ts` — TypeScript declarations for the same surface (`main` + `types` in
  `package.json`), consumed by `apps/mobile-companion` through `file:../../packages/mobile-protocol`.

## Exports

| Export | Contract § |
|---|---|
| `PROTOCOL_SUBPROTOCOL` (`dsh-mobile-v1`), `SUBPROTOCOL_PREFIXES`, `DEVICE_ID_HEADER`, `pairingSubprotocols()`, `authSubprotocols()`, `deviceSubprotocol()` | §1, §3 |
| `COMPANION_PROTOCOL_VERSION` (1), `MIN_CLIENT_VERSION` (1), `CLOSE_CODES` (4004/4003/4401/4412) | §3 |
| `PAIRING_QR_VERSION` (3) | §2 |
| `OPS` (the §4 `type` column, in table order, then the four spec 011 authoring ops and revision 11's `session-rename`/`session-archive`), `OP_RESPONSES` (§4 response `kind` column, plus the authoring kinds) | §4 |
| `CAPABILITIES`, `OPTIONAL_CAPABILITIES` (`push-v1`), `SESSION_EDIT_CAPABILITY_SCOPE` | §3.5 |
| `ERROR_CODES` (code → upgrade HTTP status, `null` where the table shows `—`), `PASSTHROUGH_ERROR_CODES` | §6 |
| `APPROVAL_OUTCOMES_CLIENT`, `APPROVAL_OUTCOMES_FINAL`, `RECEIPT_REASONS` | §5 |
| `SERVER_PUSH_KINDS`, `PING_INTERVAL_MS` (25 s) | §1, §4, §5 |
| `PAIRING_PROOF_TYPE`, `PAIRING_NONCE`, `PAIRING_CLOSE_CODES` (4403/4408/4410), `createClientNonce()` | §3.8 |
| `DEVICE_KINDS`, `SCOPES`, `DESKTOP_DEFAULT_SCOPES`, `NEVER_DEFAULT_SCOPES`, `SCOPE_BY_TYPE`, `auth/forbidden-scope` | spec 005 FR2/FR3/FR6 |
| `harness:remote` (scope), `REMOTE_CLIENT_TYPES`, `REMOTE_SERVER_KINDS`, `REMOTE_STREAM_DEFAULT_CREDIT`, `REMOTE_BINARY_CHUNK_BYTES` | spec 008 (revision 4, additive; remote-bridge channel, not §4 ops) |
| `commands:execute`, `workspace:manage`, `credentials:write`, `plugins:manage`, `schedule:write`, `terminal` (scopes), `DESKTOP_ONLY_SCOPES`, `SCOPE_PRESETS` (`standard`, `full`) | spec 008 "full control" (revision 5, additive) |
| `sessions:author` (scope), `AUTHORING_CLIENT_TYPES`, `AUTHORING_SCOPE` | spec 011 (revision 7, additive; `workspaces`, `session-create`, `models`, `select-model`) |
| `attachments:write` (scope), `REMOTE_UPLOAD_CLIENT_TYPES`, `REMOTE_UPLOAD_RESULT_KIND`, `REMOTE_UPLOAD_MAX_CHUNK_BYTES`, `ATTACHMENTS_WRITE_SCOPE` | spec 013 (revision 8, additive; `remote-upload-*`, not §4 ops) |
| `browser-agent:1` (capability), `browser:control` (scope), `BROWSER_AGENT_CAPABILITY`, `BROWSER_CONTROL_SCOPE`, `BROWSER_OPS`, `BROWSER_HOST_KINDS`, `BROWSER_CLIENT_TYPES`, `BROWSER_FRAME_MAX_BYTES`, `BROWSER_DEADLINE_DEFAULT_MS`, `BROWSER_DEADLINE_MAX_MS`, `BROWSER_SCREENSHOT_MAX_BYTES`, `BROWSER_TEXT_MAX_BYTES`, `BROWSER_COMMAND_ID`, `BROWSER_ERROR_CODES`, `browserFrameBytes()`, `validateBrowserCommand()`, `validateBrowserResult()`, `validateBrowserCancel()`, `truncateBrowserText()` | spec 016 Phase 3 (revision 10, additive; host-initiated `browser-*` frames, not §4 ops) |
| `session-rename`/`session-archive` (ops), `session-renamed`/`session-archived` (kinds) | revision 11, additive; `sessions:author` |
| `stats:read` (scope), `STATS_READ_CLIENT_TYPES`, `STATS_READ_SCOPE`, `TEAM_READ_CLIENT_TYPES`, `TEAM_READ_SCOPE` | spec 018 (revision 12; metric frames behind `stats:read`, team/subagent reads behind `sessions:read`) |
| `schedule:read` (scope), `SCHEDULE_READ_CLIENT_TYPES`, `SCHEDULE_READ_SCOPE` | spec 018 item 3 (revision 12, additive) |
| `web:unlock` (scope), `PASSKEY_CLIENT_TYPES`, `PASSKEY_REGISTER_OPTIONS_TYPE`, `PASSKEY_REGISTER_TYPE`, `PASSKEY_ASSERT_OPTIONS_TYPE`, `PASSKEY_ASSERT_TYPE`, `WEB_UNLOCK_SCOPE`, `WEB_UNLOCK_EXEMPT_TYPES`, `WEB_LOCK_ERROR`, `WEB_LOCK_STATES`, `PASSKEY_CHALLENGE_TTL_MS`, `PASSKEY_RATE_LIMITS`, `WEB_UNLOCK_IDLE_MS`, `PASSKEY_ERROR_CODES`, `PASSKEY_APPROVAL_KIND`, `PASSKEY_APPROVAL_ACTIONS` | spec 021 (revision 14; `passkey-*` frames, not §4 ops; replaces spec 020's `account-attestation`) |
| `permission:lower` (scope), `PERMISSION_LOWER_CLIENT_TYPES`, `PERMISSION_LOWER_TYPES`, `PERMISSION_LOWER_SCOPE`, `PERMISSION_LOWER_REASONS`, `PERMISSION_LOWER_MESSAGES` | spec 019 (revision 13, additive) |
| `auth/locked` (error, `null` status), `CLOSE_CODES.locked` (4412), the five `passkey/…` codes | §6, §3 (revision 14) |
| `QUESTION_RESPONSE_TYPES`, `QUESTION_RESPONSE_SCOPE`, `QUESTION_CUSTOM_MAX_LENGTH` (2000) | spec 018 item 4; `approval:respond`, no new scope |

The spec 008 scopes (`harness:remote` and the six above) are **desktop-only and explicit-only**: none
is in `DESKTOP_DEFAULT_SCOPES`, and a `mobile` or pre-005 record never holds one.
`SCOPE_PRESETS.standard` = `sessions:read`, `prompt:send`, `approval:respond`, `files:read`,
`harness:remote`; `SCOPE_PRESETS.full` = every desktop scope.

`sessions:author` (spec 011) is **explicit-only** like the spec 008 scopes (never in
`DESKTOP_DEFAULT_SCOPES`) but deliberately **not desktop-only**: a `mobile` device may hold it,
and it is what gates the four authoring ops plus revision 11's `session-rename`/`session-archive`.
`SCOPE_PRESETS.full` lists every scope; `NEVER_DEFAULT_SCOPES` names the ones no kind-independent
default may contain (`sessions:author`, `attachments:write`, `browser:control`, `stats:read`,
`schedule:read`, `web:unlock`).

The revision 12 scopes (`stats:read`, `schedule:read`, `web:unlock`) are **explicit-only and
never-default**, like `sessions:author`; the team/subagent read frames ride `sessions:read` and the
question frames ride `approval:respond`, so they add no scope.

Revision 14 keeps the scope name `web:unlock` and narrows what it gates: a device holding it starts
LOCKED on every connection and may only send `client-hello`, `ping` and the four `passkey-*` frames
until a `passkey-assert` verifies on that socket; `hello.webLock` says `unregistered`, `locked` or
`unlocked`. Registration is refused `passkey/already-registered` once the device has a passkey:
replacing it needs the owner's approval on the Host.

## Tests

`npm test` (`node --test`) parses the contract document — the §4 table (escaped `\|` unions
included), the §6 table, the §2/§3/§5 examples and prose — and asserts the exports are exactly what
it says. It fails on any drift, so edit the contract first and this package second.
