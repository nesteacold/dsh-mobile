/**
 * `@dsh-ext/mobile-protocol` — the shared wire contract for the DeepSeek
 * Harness mobile companion (protocol v1, contract revision 2).
 *
 * Source of truth: `specs/001-gateway-hardening/contracts/mobile-protocol-v1.md`
 * (revision 2 — aligned with the upstream gateway wire format: client frames use
 * `type`, server frames use `kind`, every answer echoes `requestId`) and
 * `specs/005-remote-desktop-client/spec.md` (revision 3 — device `kind`/`scopes`
 * and `auth/forbidden-scope`; additive, so the wire protocol stays v1) and
 * `specs/008-devices-page/plan.md` (revision 4 — scope `harness:remote` and the
 * remote-bridge frames; additive, the wire protocol stays v1; revision 5 adds the
 * full-control scopes and `SCOPE_PRESETS`) and
 * `specs/011-mobile-session-authoring/spec.md` (revision 7 — scope
 * `sessions:author` and the four session-authoring ops it gates; additive, the
 * wire protocol stays v1) and `specs/013-remote-attachments/spec.md` (revision 8 —
 * scope `attachments:write` and the four `remote-upload-*` frames it gates;
 * additive, the wire protocol stays v1) and `specs/014-sidebar-browser/spec.md`
 * * `specs/014-sidebar-browser/spec.md`
 * (C6 — scope `browser:control` for the side-panel browser; additive, the wire
 * protocol stays v1) and `specs/016-start-page-per-machine/spec.md` Phase 3
 * (revision 10 — the first host-initiated request/response on the link:
 * `browser-command`/`browser-result`/`browser-cancel`, the `browser-agent:1`
 * capability and their limits; additive, the wire protocol stays v1) and
 * `specs/019-parity-wave3-high-risk-design/permission-lower.md` (scope
 * `permission:lower`, the `permission-options`/`permission-lower` frames and the
 * `permission-lower` capability; additive, the wire protocol stays v1).
 * `test/contract.test.mjs` parses that document and fails when a constant here
 * drifts from it. Breaking change ⇒ v2, never an edit in place.
 *
 * Pure ESM, no dependencies: importable by the Host plugin (`plugins/mobile-gateway`)
 * and by the companion app (`apps/mobile-companion`) unchanged.
 * TypeScript consumer types live in `index.d.ts` beside this file.
 */

// ---------------------------------------------------------------------------
// §1 Framing / §3 Connection
// ---------------------------------------------------------------------------

/** WebSocket subprotocol every companion connection offers first (contract §1, §3). */
export const PROTOCOL_SUBPROTOCOL = 'dsh-mobile-v1'

/**
 * Companion protocol revision carried in `hello.companionProtocol` and
 * `client-hello.companionProtocol` (contract §3.5–6).
 */
export const COMPANION_PROTOCOL_VERSION = 1

/**
 * Oldest companion client version a host accepts (contract §3.5 `minClientVersion`,
 * §3.6 `protocol/unsupported`).
 */
export const MIN_CLIENT_VERSION = 1

/**
 * Pairing QR payload `version` (contract §2). The QR text is unpadded base64url of the
 * UTF-8 JSON payload, not the JSON itself.
 */
export const PAIRING_QR_VERSION = 3

/**
 * Subprotocol prefixes used instead of headers where a client cannot set them
 * (contract §3.2, §3.4). The server only ever negotiates back `dsh-mobile-v1`.
 */
export const SUBPROTOCOL_PREFIXES = Object.freeze({
  pair: 'dsh-pair.',
  auth: 'dsh-auth.',
  device: 'dsh-device.',
})

/** Header carrying the install-scoped device UUID during pairing (contract §3.2). */
export const DEVICE_ID_HEADER = 'X-DSH-Device-ID'

/** Subprotocols offered for first pairing: `dsh-mobile-v1, dsh-pair.<code>` (contract §3.2). */
export function pairingSubprotocols(pairingCode) {
  return [PROTOCOL_SUBPROTOCOL, `${SUBPROTOCOL_PREFIXES.pair}${pairingCode}`]
}

/**
 * Subprotocols offered for an authenticated connection. The bearer token normally travels in
 * `Authorization`; `dsh-auth.<token>` is the fallback for clients without headers (§3.4).
 */
export function authSubprotocols(token) {
  return token === undefined ? [PROTOCOL_SUBPROTOCOL] : [PROTOCOL_SUBPROTOCOL, `${SUBPROTOCOL_PREFIXES.auth}${token}`]
}

/** `dsh-device.<installUuid>` fallback for the `X-DSH-Device-ID` header (contract §3.2). */
export function deviceSubprotocol(installUuid) {
  return `${SUBPROTOCOL_PREFIXES.device}${installUuid}`
}

// ---------------------------------------------------------------------------
// §4 Operations (allowlist `companion-v1`)
// ---------------------------------------------------------------------------

/**
 * The `companion-v1` operation allowlist: the contract §4 `type` column in table order,
 * including the spec 011 session-authoring ops (revision 7) and the revision 11
 * session rename/archive ops. The op identity is the client frame's `type`; anything
 * else is answered with `op/forbidden`.
 */
export const OPS = Object.freeze([
  'client-hello',
  'ping',
  'sessions',
  'search',
  'history',
  'subscribe',
  'unsubscribe',
  'message',
  'session-cancel',
  'approval-response',
  'device-info',
  'device-forget',
  'push-register',
  'push-remove',
  // Spec 011 session authoring: list this Host's workspaces, list the model catalog,
  // create a session and pick its provider/model. They are gated by `sessions:author`
  // (see `SCOPE_BY_TYPE`) and answered with their own `kind` (`OP_RESPONSES`).
  'workspaces',
  'session-create',
  'models',
  'select-model',
  // Revision 11: rename and archive ONE session the device already sees. Same
  // never-default `sessions:author` scope; no new scope.
  'session-rename',
  'session-archive',
])

/** Server → client response `kind` per operation (contract §4 "Response `kind`" column). */
export const OP_RESPONSES = Object.freeze({
  'client-hello': 'client-hello',
  ping: 'pong',
  sessions: 'sessions',
  search: 'search',
  history: 'history',
  subscribe: 'subscribed',
  unsubscribe: 'unsubscribed',
  message: 'sent',
  'session-cancel': 'session-cancelled',
  'approval-response': 'approval-response',
  'device-info': 'device-info',
  'device-forget': 'device-forgotten',
  'push-register': 'push-registered',
  'push-remove': 'push-removed',
  // Spec 011: upstream gateway kinds (`lib/index.mjs`): `workspaces` → `workspace.list`,
  // `session-create` → `sessions.create` answered as `session-created`, `models` → the
  // model catalog, `select-model` → `sessions.selectModel`.
  workspaces: 'workspaces',
  'session-create': 'session-created',
  models: 'models',
  'select-model': 'select-model',
  // Revision 11: answered by the same upstream kinds the loopback admin client uses.
  'session-rename': 'session-renamed',
  'session-archive': 'session-archived',
})

/** Server → client push frames that carry no `requestId` (contract §1, §5). */
export const SERVER_PUSH_KINDS = Object.freeze([
  'approval-requested',
  'approval-resolved',
  'event',
])

// ---------------------------------------------------------------------------
// §3.2 / §4 Device kinds and scopes (spec 005, FR2)
// ---------------------------------------------------------------------------

/** What paired a device is: the companion phone or the desktop client (spec 005, FR1). */
export const DEVICE_KINDS = Object.freeze(['mobile', 'desktop'])

/** Scopes a pairing offer may grant; a device keeps the ones it was paired with. */
export const SCOPES = Object.freeze([
  'sessions:read',
  'prompt:send',
  'approval:respond',
  'files:read',
  'files:write',
  'settings:write',
  // Spec 018 (revision 10): read-only session metrics. Mobile-holdable, and never a
  // default: a device must be paired with it explicitly.
  'stats:read',
  // Spec 020 (revision 10), narrowed by spec 021 (revision 14): the PWA's passkey unlock
  // (the `passkey-*` frames). Mobile-holdable (the web PWA is a mobile-kind device) and
  // never a default. A device holding it starts LOCKED on every new connection.
  'web:unlock',
  // Spec 008: the remote-bridge channel (desktop → DSH wire calls on this Host).
  // Never a default and never granted to a `mobile` device: the owner has to pick
  // it explicitly when pairing a `desktop`.
  'harness:remote',
  // Spec 008 "full control" (revision 5, additive). Each one opens a capability
  // family of the remote bridge. Like `harness:remote` they are desktop-only and
  // explicit-only: never in a default, never on a `mobile` or legacy record.
  'commands:execute',
  'workspace:manage',
  'credentials:write',
  'plugins:manage',
  'schedule:write',
  // Spec 018 item 3 (revision 12): reading the schedule list and each task's next run. A NEW
  // scope, unlike item 2: measured 2026-11-11, NO schedule data travels in `projection-baseline`
  // or in any broadcast frame (the baseline carries goal/todos/turnOutline/agentTeam/…
  // and nothing about schedules), so this really is visibility a device did not have.
  'schedule:read',
  'terminal',
  // Spec 011 (revision 7): list this Host's workspaces, list the model catalog,
  // create a session and pick its provider/model. Deliberately NOT desktop-only —
  // the owner decided a `mobile` offer may tick it, the first scope to cross that
  // line. It stays explicit-only: never a default, never implicit.
  'sessions:author',
  // Spec 013 (revision 8): send attachment bytes into a session on this Host
  // (`remote-upload-*` frames). It belongs to the DESKTOP default set, like every
  // other desktop grant the owner may untick — and it is never part of a
  // kind-independent default, so no existing or newly paired `mobile` device
  // receives it without the owner choosing it on the Devices page.
  'attachments:write',
  // Spec 014 C6 (owner decision 2026-11-11): drive the Host's built-in side-panel
  // Browser from a device (`plugins/sidebar-browser`). Grantable like any other
  // scope — no hard block — and it belongs to the DESKTOP default set, while the
  // kind-independent defaults never acquire it. Enforcement lands with
  // plugins/sidebar-browser (`remoteSessionScope` service); the gateway's remote
  // bridge does not forward a `browser/*` endpoint, so nothing is gated here yet.
  'browser:control',
  // Spec 019 Wave 3: read this Host's permission presets and switch ONE session to a
  // STRICTLY STRICTER preset (`permission-options` / `permission-lower`). It never
  // widens: the gateway refuses an equal or looser target, and it writes through the
  // in-process `permissionPresets` service, never a command string. Explicit-only and
  // never a default; `full` includes it.
  'permission:lower',
])

/**
 * Scopes that exist only for a `desktop` device and must be chosen by the owner
 * (spec 008): the remote bridge itself plus the full-control families.
 * `sessions:author` (spec 011) is deliberately absent: a `mobile` device may hold it.
 */
export const DESKTOP_ONLY_SCOPES = Object.freeze([
  'harness:remote',
  'commands:execute',
  'workspace:manage',
  'credentials:write',
  'plugins:manage',
  'schedule:write',
  'terminal',
])

/**
 * Scopes a desktop offer gets unless the owner picks some (spec 005, FR3): see
 * sessions, prompt, answer approvals — plus, since spec 013, attach files and
 * images to a session (`attachments:write`) and, since spec 014 C6, drive the
 * Host's side-panel browser (`browser:control`). `harness:remote` and the
 * full-control scopes are deliberately absent (spec 008): they must be chosen.
 * `sessions:author` (spec 011) is absent for the same reason: creating sessions
 * and choosing models is an explicit grant.
 */
export const DESKTOP_DEFAULT_SCOPES = Object.freeze([
  'sessions:read', 'prompt:send', 'approval:respond', 'attachments:write', 'browser:control',
])

/**
 * Scopes no *kind-independent* default may contain (spec 011 FR-006, extended by
 * spec 013).
 *
 * The two defaults that must not hand out a capability the owner did not ask for
 * are the ones that do not know the device kind: the gateway's mobile-offer
 * default ("every scope except the bridge") and the device registry's mobile
 * default, which is also the grant a record written before spec 005 migrates to.
 * Both sites read this one list: `plugins/mobile-gateway/lib/index.mjs` (the
 * pairing-request offer default) and `plugins/mobile-gateway/lib/devices.js`
 * (`defaultScopes`).
 *
 * `sessions:author` is grantable to a `mobile` device on purpose, so it is NOT in
 * DESKTOP_ONLY_SCOPES — and that is exactly why those two computations would
 * otherwise hand it out: creating sessions and choosing models starts agent work
 * on the owner's machine, so it must be a deliberate tick, never a default.
 * `attachments:write` (spec 013) IS in DESKTOP_DEFAULT_SCOPES, which is the
 * desktop default in its own right; it is listed here so the kind-independent
 * defaults never acquire it either, which is what keeps a migration quiet.
 * `browser:control` (spec 014 C6) is listed for exactly the same reason.
 *
 * This narrows *defaults* only. An explicit scope list — an owner's tick, an OTP
 * offer that names it, `SCOPE_PRESETS.full` — is taken literally and still grants it.
 */
export const NEVER_DEFAULT_SCOPES = Object.freeze(['sessions:author', 'attachments:write', 'browser:control', 'stats:read', 'schedule:read', 'web:unlock', 'permission:lower'])

/**
 * Pairing presets for the Devices UI (spec 008). `standard` is the default at
 * Approve; `full` ticks every contract scope ("full control"), including the
 * spec 011 author scope and the spec 013 attachment scope. A preset is only a
 * list the owner may edit: the grant is still the explicit scope list.
 */
export const SCOPE_PRESETS = Object.freeze({
  standard: Object.freeze(['sessions:read', 'prompt:send', 'approval:respond', 'files:read', 'harness:remote']),
  full: Object.freeze([
    'sessions:read', 'prompt:send', 'approval:respond', 'files:read', 'files:write', 'settings:write',
    'harness:remote', 'commands:execute', 'workspace:manage', 'credentials:write', 'plugins:manage',
    'schedule:read', 'schedule:write', 'terminal', 'sessions:author', 'attachments:write', 'browser:control', 'stats:read', 'web:unlock',
    // Spec 019 Wave 3: lower-only permission control ("full control" includes it; the
    // Devices page lists it as its own tick).
    'permission:lower',
  ]),
})

/**
 * Scope of each inbound `msg.type` the desktop client may send. Deliberately
 * narrower than `OPS`: operations that are not listed here (device management,
 * push) cannot be scoped and stay refused for a scoped caller. The four spec 011
 * authoring types are listed here and in `OPS` (revision 7): a type absent from
 * this map is refused, so they have to be mapped to be reachable at all.
 */
export const SCOPE_BY_TYPE = Object.freeze({
  'client-hello': 'sessions:read',
  ping: 'sessions:read',
  sessions: 'sessions:read',
  search: 'sessions:read',
  history: 'sessions:read',
  subscribe: 'sessions:read',
  unsubscribe: 'sessions:read',
  'device-info': 'sessions:read',
  message: 'prompt:send',
  'session-cancel': 'prompt:send',
  'approval-response': 'approval:respond',
  // Spec 008 remote-bridge: the type needs `harness:remote`; the bridge then
  // checks the endpoint's own scope (sessions:read, prompt:send, ...) on top.
  'remote-call': 'harness:remote',
  'remote-stream-open': 'harness:remote',
  'remote-stream-cancel': 'harness:remote',
  'remote-stream-credit': 'harness:remote',
  // Spec 011: exactly four authoring types, all behind `sessions:author` (and
  // nothing else maps to it). They list workspaces, list models, create a
  // session and pick its model — never a workspace/session mutation.
  workspaces: 'sessions:author',
  'session-create': 'sessions:author',
  models: 'sessions:author',
  'select-model': 'sessions:author',
  // Revision 11: renaming and archiving one session the device may see. Same
  // never-default scope, and the session itself is the resource DSH decides on.
  'session-rename': 'sessions:author',
  'session-archive': 'sessions:author',
  // Spec 013 (revision 8): the four attachment-transfer frames, all behind
  // `attachments:write`. The gateway additionally requires a `desktop` device and
  // a session that device may see; the scope alone is never enough.
  'remote-upload-open': 'attachments:write',
  'remote-upload-chunk': 'attachments:write',
  'remote-upload-finish': 'attachments:write',
  'remote-upload-cancel': 'attachments:write',
  // Spec 018 (revision 10): the two read-only session metric frames, both behind
  // `stats:read`. The scope gate checks EXACTLY `stats:read` and nothing else: it does
  // not require `sessions:read`, and it does not decide which sessions are visible.
  // Visibility is the HOST's: the gateway reads each session's own snapshot through the
  // requesting device's non-owner peer, so DSH's per-item `allows({kind:'session', id})`
  // answers, and a session that device may not address is refused there
  // (`remote-access/denied`). The frames never write.
  'session-stats': 'stats:read',
  'context-usage': 'stats:read',
  // Spec 021 (revision 14): the four passkey frames are the only types that map to
  // `web:unlock` (the spec 020 `account-attestation` is withdrawn). All four are answered
  // in band; the assert family is the unlock itself.
  'passkey-register-options': 'web:unlock',
  'passkey-register': 'web:unlock',
  'passkey-assert-options': 'web:unlock',
  'passkey-assert': 'web:unlock',
  // Spec 018 item 4 (revision 13): answering a question is the SAME interaction as an approval
  // card — same session, same `rpcId` life cycle, same card, same answer path — so it rides the
  // existing `approval:respond` scope instead of a new one. No new scope, no migration.
  'question-answer': 'approval:respond',
  'question-cancel': 'approval:respond',
  // Spec 018 item 2 (revision 11): the agent-team and subagent-catalog reads are READ-ON-DEMAND
  // of data `sessions:read` ALREADY grants: the same projections travel in
  // `projection-baseline` and the `agent-team-updated` / `subagents-updated` frames to every
  // device that holds `sessions:read` (measured 2026-11-11: 31/52 sessions carried `agentTeam`).
  // They are mapped to that scope instead of a new one precisely so the device surface is not
  // widened by pairing, and so the two frames cannot drift from the baseline shape.
  'agent-team': 'sessions:read',
  // Spec 018 item 3: the read-only schedule frames. `schedule-catalog` lists WHAT CAN BE
  // scheduled (no user data), `schedule-list` and `schedule-view` return the owner's tasks and
  // their next run, so all three sit behind the explicit-only read scope.
  'schedule-catalog': 'schedule:read',
  'schedule-list': 'schedule:read',
  'schedule-view': 'schedule:read',
  'subagents': 'sessions:read',
  // Spec 019 Wave 3: the two permission frames are the only types that map to
  // `permission:lower`. The scope gate reads this map, so a lost entry is a refusal,
  // never an implicit grant.
  'permission-options': 'permission:lower',
  'permission-lower': 'permission:lower',
})

// ---------------------------------------------------------------------------
// Spec 013 — attachment upload over the pinned link (revision 8, additive)
// ---------------------------------------------------------------------------

/**
 * Client → server attachment frames (spec 013, revision 8). They are NOT
 * contract §4 operations (`OPS` is unchanged): only a `desktop` device holding
 * `attachments:write` can send them, and every frame is answered with
 * {@link REMOTE_UPLOAD_RESULT_KIND} echoing its `requestId`.
 *
 *   remote-upload-open   { type, requestId, sessionId, kind: 'file'|'image',
 *                          name?, mediaType?, size, sha256 }
 *                        → { ok: true, value: { uploadId, sessionId, kind, name?, mediaType?,
 *                                              size, chunkBytes, maxBytes, idleTimeoutMs } }
 *   remote-upload-chunk  { type, requestId, uploadId, offset, data }
 *                        → { ok: true, value: { uploadId, sessionId, nextOffset } }
 *   remote-upload-finish { type, requestId, uploadId }
 *                        → { ok: true, value: { receiptId, file | image } }   (the Host's own receipt)
 *   remote-upload-cancel { type, requestId, uploadId }
 *                        → { ok: true, value: { uploadId, sessionId, cancelled: true } }
 *
 * `data` is CANONICAL base64 (the standard alphabet, padded, exactly as
 * `Buffer#toString('base64')` produces it) and `offset` counts decoded bytes: it
 * must equal the bytes already accepted. `sha256` is 64 lowercase hex digits and
 * is verified against the whole file at `finish`.
 */
export const REMOTE_UPLOAD_CLIENT_TYPES = Object.freeze([
  'remote-upload-open',
  'remote-upload-chunk',
  'remote-upload-finish',
  'remote-upload-cancel',
])

/** Server → client answer to every `remote-upload-*` frame (revision 8). */
export const REMOTE_UPLOAD_RESULT_KIND = 'remote-upload-result'

/**
 * Largest chunk (decoded bytes) one `remote-upload-chunk` frame may carry. The
 * gateway lowers it further when its own WS payload budget is smaller, and tells
 * the client the effective value in the `open` answer (`chunkBytes`).
 */
export const REMOTE_UPLOAD_MAX_CHUNK_BYTES = 256 * 1024

/** Scope every `remote-upload-*` frame requires, and nothing else requires it (spec 013, R1). */
export const ATTACHMENTS_WRITE_SCOPE = SCOPE_BY_TYPE['remote-upload-open']

// ---------------------------------------------------------------------------
// Spec 016 Phase 3 — the host drives a browser on the paired client (revision 10)
//
// The first HOST-initiated request/response on the link: the host sends a
// `browser-command`, the client answers with exactly one `browser-result`, and
// either side may send `browser-cancel` for a command it no longer wants. The
// frames are additive: they are NOT contract §4 operations (`OPS` is unchanged)
// and they carry no `SCOPE_BY_TYPE` entry — the scope is enforced per command by
// the gateway service that owns the command id, never by a blanket type gate.
// ---------------------------------------------------------------------------

/**
 * Capability the gateway advertises in `hello` when its browser bridge is
 * available, and the one a client lists in its optional `client-hello`
 * `capabilities` array when it can honour `browser-command`.
 */
export const BROWSER_AGENT_CAPABILITY = 'browser-agent:1'

/** Scope a device needs before the host may send it a `browser-command` (spec 014 C6). */
export const BROWSER_CONTROL_SCOPE = 'browser:control'

/**
 * Every `op` a `browser-command` may carry. The client implements exactly these;
 * an op outside this list is refused `bad-request` before it reaches a device.
 */
export const BROWSER_OPS = Object.freeze([
  // Page control (mutating).
  'navigate', 'click', 'type', 'press', 'scroll', 'open', 'close',
  // Reads. `snapshot` is the accessibility/DOM outline, `text` the visible text.
  'snapshot', 'text', 'html', 'screenshot', 'tabs',
])

/** Server → client frames of this revision (they use `kind`, like every server frame). */
export const BROWSER_HOST_KINDS = Object.freeze(['browser-command', 'browser-cancel'])

/** Client → server frames of this revision (they use `type`, like every client frame). */
export const BROWSER_CLIENT_TYPES = Object.freeze(['browser-result', 'browser-cancel'])

/** Largest complete frame, serialized, either direction. */
export const BROWSER_FRAME_MAX_BYTES = 1024 * 1024

/** Deadline applied to a `browser-command` when it omits `deadlineMs`. */
export const BROWSER_DEADLINE_DEFAULT_MS = 30_000

/** Largest deadline a `browser-command` may ask for. */
export const BROWSER_DEADLINE_MAX_MS = 120_000

/** Largest decoded `result.screenshot` (JPEG bytes, before base64). */
export const BROWSER_SCREENSHOT_MAX_BYTES = 768 * 1024

/** Largest `result.text` / `result.html` the host keeps; longer text is cut and flagged. */
export const BROWSER_TEXT_MAX_BYTES = 256 * 1024

/** A `commandId`, and the `requestId` shape it reuses: 1..64 of `[A-Za-z0-9._-]`. */
export const BROWSER_COMMAND_ID = /^[A-Za-z0-9._-]{1,64}$/

/**
 * Codes both sides use in `error.code` of a `browser-result`. A client may also
 * return its own `browser/…` code (e.g. `browser/denied` when its consent is
 * off, `browser/not-found` for an unknown tab); the host shows a generic error
 * for any code it does not know, exactly as §5a says for unknown codes.
 */
export const BROWSER_ERROR_CODES = Object.freeze([
  'browser/not-supported',
  'browser/forbidden-scope',
  'browser/offline',
  'browser/timeout',
  'browser/cancelled',
  'browser/busy',
  'browser/bad-request',
  'browser/frame-too-large',
  'browser/unknown-target',
])

const BROWSER_ERROR_SHAPE = /^[a-z][a-z0-9]*(?:[/-][a-z0-9]+)*$/

const isRecord = (value) => typeof value === 'object' && value !== null && !Array.isArray(value)

/** UTF-8 byte count of a frame's JSON form (`Infinity` when it cannot be serialized). */
export function browserFrameBytes(frame) {
  try {
    const text = JSON.stringify(frame)
    return text === undefined ? 0 : new TextEncoder().encode(text).length
  } catch {
    return Number.POSITIVE_INFINITY
  }
}

const badRequest = (message) => ({ ok: false, code: 'bad-request', message })

/** Shared shape checks: the id, the session, and the frame's own size bound. */
function commonCommandChecks(commandId) {
  if (typeof commandId !== 'string' || !BROWSER_COMMAND_ID.test(commandId)) {
    return badRequest('commandId must be 1..64 characters of [A-Za-z0-9._-]')
  }
  return undefined
}

/**
 * Validate one host → client `browser-command`.
 *
 * Returns `{ ok: true, value }` with `args` defaulted to `{}` and `deadlineMs`
 * clamped to `1..BROWSER_DEADLINE_MAX_MS` (default `BROWSER_DEADLINE_DEFAULT_MS`),
 * or `{ ok: false, code: 'bad-request', message }`. Never throws.
 *
 * @param {unknown} frame
 */
export function validateBrowserCommand(frame) {
  if (!isRecord(frame)) return badRequest('a browser-command must be an object')
  if (frame.kind !== 'browser-command') return badRequest('kind must be "browser-command"')
  const idProblem = commonCommandChecks(frame.commandId)
  if (idProblem) return idProblem
  const sessionId = typeof frame.sessionId === 'string' ? frame.sessionId.trim() : ''
  if (sessionId === '' || sessionId.length > 128) return badRequest('sessionId must be a non-empty string of at most 128 characters')
  if (typeof frame.op !== 'string' || !BROWSER_OPS.includes(frame.op)) return badRequest('op is not a browser operation')
  const args = frame.args === undefined ? {} : frame.args
  if (!isRecord(args)) return badRequest('args must be an object')
  let deadlineMs = BROWSER_DEADLINE_DEFAULT_MS
  if (frame.deadlineMs !== undefined) {
    if (!Number.isSafeInteger(frame.deadlineMs) || frame.deadlineMs < 1) return badRequest('deadlineMs must be a positive integer')
    deadlineMs = Math.min(frame.deadlineMs, BROWSER_DEADLINE_MAX_MS)
  }
  if (browserFrameBytes(frame) > BROWSER_FRAME_MAX_BYTES) {
    return { ok: false, code: 'browser/frame-too-large', message: `a frame may not exceed ${BROWSER_FRAME_MAX_BYTES} bytes` }
  }
  return { ok: true, value: { commandId: frame.commandId, sessionId, op: frame.op, args, deadlineMs } }
}

/**
 * Validate one client → host `browser-result`: `{ type, commandId, ok, result|error }`.
 * Structural checks and the frame bound only; oversized `text`/`html` is the
 * gateway's business (it truncates it, see {@link truncateBrowserText}).
 *
 * @param {unknown} frame
 */
export function validateBrowserResult(frame) {
  if (!isRecord(frame)) return badRequest('a browser-result must be an object')
  if (frame.type !== 'browser-result') return badRequest('type must be "browser-result"')
  const idProblem = commonCommandChecks(frame.commandId)
  if (idProblem) return idProblem
  if (frame.ok === true) {
    if (frame.result === undefined) return badRequest('a successful browser-result must carry result')
  } else if (frame.ok === false) {
    if (!isRecord(frame.error)) return badRequest('a failed browser-result must carry error { code, message }')
    if (typeof frame.error.code !== 'string' || !BROWSER_ERROR_SHAPE.test(frame.error.code)) {
      return badRequest('error.code must look like "browser/name"')
    }
  } else {
    return badRequest('ok must be true or false')
  }
  if (browserFrameBytes(frame) > BROWSER_FRAME_MAX_BYTES) {
    return { ok: false, code: 'browser/frame-too-large', message: `a frame may not exceed ${BROWSER_FRAME_MAX_BYTES} bytes` }
  }
  return {
    ok: true,
    value: frame.ok === true
      ? { commandId: frame.commandId, ok: true, result: frame.result }
      : { commandId: frame.commandId, ok: false, error: { code: frame.error.code, message: String(frame.error.message ?? '') } },
  }
}

/**
 * Validate one `browser-cancel`, in either direction: the host sends
 * `{ kind: 'browser-cancel', commandId }`, a client `{ type: 'browser-cancel',
 * commandId }`. Either envelope is accepted and normalised to `{ commandId }`.
 *
 * @param {unknown} frame
 */
export function validateBrowserCancel(frame) {
  if (!isRecord(frame)) return badRequest('a browser-cancel must be an object')
  if (frame.kind !== 'browser-cancel' && frame.type !== 'browser-cancel') {
    return badRequest('browser-cancel needs kind (host) or type (client) "browser-cancel"')
  }
  const idProblem = commonCommandChecks(frame.commandId)
  if (idProblem) return idProblem
  return { ok: true, value: { commandId: frame.commandId } }
}

/**
 * Cut a text result to `maxBytes` of UTF-8 without splitting a code point.
 *
 * @param {unknown} text
 * @param {number} [maxBytes]
 * @returns {{ text: string, truncated: boolean, bytes: number }}
 */
export function truncateBrowserText(text, maxBytes = BROWSER_TEXT_MAX_BYTES) {
  const value = typeof text === 'string' ? text : String(text ?? '')
  const encoder = new TextEncoder()
  const limit = Number.isSafeInteger(maxBytes) && maxBytes > 0 ? maxBytes : BROWSER_TEXT_MAX_BYTES
  const whole = encoder.encode(value)
  if (whole.length <= limit) return { text: value, truncated: false, bytes: whole.length }
  // A byte prefix can end mid-code-point. `fatal` turns that into a throw, so
  // stepping back at most three bytes finds the last complete character; the
  // decode itself is linear, unlike trimming the string one char at a time.
  const decoder = new TextDecoder('utf-8', { fatal: true })
  for (let end = limit; end > limit - 4 && end > 0; end -= 1) {
    try {
      return { text: decoder.decode(whole.subarray(0, end)), truncated: true, bytes: end }
    } catch { /* partial sequence: drop one more byte */ }
  }
  return { text: '', truncated: true, bytes: 0 }
}

// ---------------------------------------------------------------------------
// Spec 011 — session authoring (revision 7, additive)
// ---------------------------------------------------------------------------

/**
 * Client → server authoring frames, the last four entries of `OPS` (spec 011,
 * revision 7, additive). They are reached only by a device holding `sessions:author`
 * and are answered with their own `kind` — the kinds the upstream gateway uses.
 *
 *   workspaces     { type, requestId }                                  → workspaces     { items }
 *   session-create { type, requestId, workspaceId?, cwd?, agentPreset? } → session-created { sessionId }
 *   models         { type, requestId, sessionId? }                       → models         { current, groups, ... }
 *   select-model   { type, requestId, sessionId, provider, model, reasoningEffort? }
 *                                                                        → select-model
 *
 * Revision 11 (additive, same scope): two more entries, both decided on the session
 * the device already sees.
 *   session-rename  { type, requestId, sessionId, title }  → session-renamed  { sessionId, title, seq }
 *   session-archive { type, requestId, sessionId }         → session-archived { sessionId, archivedSessionIds }
 */
export const AUTHORING_CLIENT_TYPES = Object.freeze([
  'workspaces',
  'session-create',
  'models',
  'select-model',
  'session-rename',
  'session-archive',
])

/**
 * Spec 018 (revision 10): the read-only session-metric frames, served only to a
 * device that holds {@link STATS_READ_SCOPE}. They are NOT contract §4 operations
 * (`OPS` is unchanged) and they never mutate anything: each one reads projections
 * the Host already keeps for the session (`sessionStats`, `tokenUsage`,
 * `contextPressure`) through that session's own snapshot, so the per-item rule is
 * the ordinary "the device may see this session".
 */
export const STATS_READ_CLIENT_TYPES = Object.freeze([
  'session-stats',
  'context-usage',
])

/** The scope that lifts the spec 018 metric frames. */
export const STATS_READ_SCOPE = SCOPE_BY_TYPE['session-stats']

/**
 * Spec 018 item 2 (revision 11): the read-only agent-team and subagent-catalog frames. They are
 * NOT contract §4 operations (`OPS` is unchanged) and never mutate anything. They are also NOT
 * a new capability: each one returns one projection the Host already keeps for the session, the
 * same value the recipient already receives in `projection-baseline`, so they need no scope of
 * their own — {@link TEAM_READ_SCOPE} is `sessions:read`, and the per-item rule stays the Host's
 * own "may this device see this session".
 */
export const TEAM_READ_CLIENT_TYPES = Object.freeze([
  'agent-team',
  'subagents',
])

/** The scope that lifts the spec 018 team frames: the ordinary session read scope. */
export const TEAM_READ_SCOPE = SCOPE_BY_TYPE['agent-team']

/**
 * Spec 018 item 3 (revision 12): the READ-ONLY schedule frames — the `schedule:write` family
 * minus every mutation. These are the only schedule types a device may issue without the write
 * scope; `schedule-history` and `schedule-run` are NOT here (history is per-task activity and
 * `run` executes, so both stay admin-only for now).
 */
export const SCHEDULE_READ_CLIENT_TYPES = Object.freeze([
  'schedule-catalog',
  'schedule-list',
  'schedule-view',
])

/** The scope that lifts the spec 018 schedule read frames: explicit-only, never a default. */
export const SCHEDULE_READ_SCOPE = SCOPE_BY_TYPE['schedule-list']

/**
 * Spec 018 item 4 (revision 13): answering or declining a question the Host asked in a session.
 * These are the companion's ONLY two question frames; they are not contract §4 operations
 * (`OPS` is unchanged), and they are lifted by {@link QUESTION_RESPONSE_SCOPE} — the approval
 * scope, not a new one. Answering is at-most-once (`accepted:false, reason:'not-pending'`).
 */
export const QUESTION_RESPONSE_TYPES = Object.freeze([
  'question-answer',
  'question-cancel',
])

/** The scope that lifts the question frames: the ordinary approval scope. */
export const QUESTION_RESPONSE_SCOPE = SCOPE_BY_TYPE['question-answer']

/** Contracts §5: a `custom` free-text answer may not exceed this many characters. */
export const QUESTION_CUSTOM_MAX_LENGTH = 2000


/**
 * Spec 021 (revision 14): the web (PWA) unlock is a WebAuthn PASSKEY bound to the paired
 * device. The spec 020 DeepSeek-account attestation (`account-attestation`) is withdrawn
 * entirely: the gateway no longer reads `account/*` for any unlock decision.
 *
 * Four client frames, NOT contract §4 operations (`OPS` is unchanged), all behind the one
 * existing scope {@link WEB_UNLOCK_SCOPE}. Every binary field is unpadded base64url.
 *
 *   passkey-register-options { type, requestId }
 *     -> { kind: 'passkey-register-options', requestId,
 *          challenge, rp: { id, name }, user: { id, name, displayName },
 *          pubKeyCredParams: [{ type: 'public-key', alg: -7 }, { type: 'public-key', alg: -257 }],
 *          excludeCredentials: [{ type: 'public-key', id }], timeout }
 *   passkey-register { type, requestId,
 *                      attestation: { id, rawId, clientDataJSON, attestationObject } }
 *     -> { kind: 'passkey-register', requestId, ok: true }
 *       | error `passkey/already-registered` (needs Host approval, re-sent after approval)
 *       | error `passkey/challenge-expired` | `passkey/verification-failed` | `passkey/rate-limited`
 *   passkey-assert-options { type, requestId }
 *     -> { kind: 'passkey-assert-options', requestId, challenge, rpId, allowCredentials, timeout }
 *   passkey-assert { type, requestId,
 *                    assertion: { id, rawId, clientDataJSON, authenticatorData, signature, userHandle } }
 *     -> { kind: 'passkey-assert', requestId, unlocked: true }
 *       | error `passkey/not-registered` | `passkey/challenge-expired` | `passkey/verification-failed`
 *       | `passkey/rate-limited`
 *
 * A device holding {@link WEB_UNLOCK_SCOPE} starts LOCKED on every new connection: it is
 * answered {@link WEB_LOCK_ERROR} for every frame outside {@link WEB_UNLOCK_EXEMPT_TYPES}
 * (hello and ping are channel-neutral and always run), until a successful
 * `passkey-assert` on that socket. `hello` tells it why in `webLock`.
 */
export const PASSKEY_REGISTER_OPTIONS_TYPE = 'passkey-register-options'
export const PASSKEY_REGISTER_TYPE = 'passkey-register'
export const PASSKEY_ASSERT_OPTIONS_TYPE = 'passkey-assert-options'
export const PASSKEY_ASSERT_TYPE = 'passkey-assert'

/** The four spec 021 client frames, in the order the PWA uses them. */
export const PASSKEY_CLIENT_TYPES = Object.freeze([
  PASSKEY_REGISTER_OPTIONS_TYPE,
  PASSKEY_REGISTER_TYPE,
  PASSKEY_ASSERT_OPTIONS_TYPE,
  PASSKEY_ASSERT_TYPE,
])

/** The scope that gates the passkey frames and arms the server-side lock (spec 020's name). */
export const WEB_UNLOCK_SCOPE = 'web:unlock'

/**
 * Ops a locked web device may still send. `client-hello` and `ping` are channel-neutral at
 * the gateway (they always run), and `device-forget` is scope-exempt, so only the passkey
 * frames need to be listed here.
 */
export const WEB_UNLOCK_EXEMPT_TYPES = Object.freeze([...PASSKEY_CLIENT_TYPES])

/** The in-band refusal of a locked device (contract §6). WS close `4412` stays reserved for re-auth. */
export const WEB_LOCK_ERROR = 'auth/locked'

/**
 * `hello.webLock` for a web device: `unregistered` (no passkey on this device — register),
 * `locked` (a passkey exists, this socket has not asserted yet), `unlocked` (this socket
 * asserted). Absent from `hello` for every device without {@link WEB_UNLOCK_SCOPE}.
 */
export const WEB_LOCK_STATES = Object.freeze(['unregistered', 'locked', 'unlocked'])

/**
 * Challenge lifetime: one challenge, one use, bound to the socket that asked for it. The
 * client's `timeout` is clamped to this value.
 */
export const PASSKEY_CHALLENGE_TTL_MS = 60_000

/**
 * Rate limits over FAILED passkey operations (assertions and registrations, never refusals
 * that cost nothing): `perDevice` failures in a 10-minute window lock that device out, and
 * `global` failures in a one-hour window lock every web device out.
 */
export const PASSKEY_RATE_LIMITS = Object.freeze({ perDevice: 5, perDeviceWindowMs: 10 * 60_000, global: 30, globalWindowMs: 60 * 60_000 })

/**
 * Inactivity bound of an unlock: a socket that sends nothing for this long is locked again
 * on its next frame. A new connection always starts locked, so a tab reload re-asserts.
 */
export const WEB_UNLOCK_IDLE_MS = 15 * 60_000

/**
 * Error codes of the passkey frames (contract §6). `passkey/already-registered` means the
 * device already has a passkey: replacing it needs the owner's approval on the Host, and the
 * client re-sends `passkey-register` once `passkey-approval` reports the approval.
 */
export const PASSKEY_ERROR_CODES = Object.freeze([
  'passkey/not-registered',
  'passkey/already-registered',
  'passkey/challenge-expired',
  'passkey/verification-failed',
  'passkey/rate-limited',
])

/** Server frame announcing that the owner approved replacing this device's passkey. */
export const PASSKEY_APPROVAL_KIND = 'passkey-approval'

/** Approvals a desktop client may decide for a web device's passkey. */
export const PASSKEY_APPROVAL_ACTIONS = Object.freeze(['approve', 'reject'])

/** Scope every authoring type requires, and nothing else requires it (spec 011, FR-002). */
export const AUTHORING_SCOPE = SCOPE_BY_TYPE['session-create']

// ---------------------------------------------------------------------------
// Spec 008 — remote-bridge channel (revision 4, additive)
// ---------------------------------------------------------------------------

/**
 * Client → server remote-bridge frames (spec 008 P1). They carry a DSH Gateway
 * `endpoint` (`namespace/method`, or `$events`, `$events/result`) and its `args`
 * object. They are NOT contract §4 operations (`OPS` is unchanged): only a
 * `desktop` device holding `harness:remote` can send them, and each endpoint is
 * checked against the Host allowlist (`lib/remote-bridge.mjs`).
 *
 *   remote-call          { type, requestId, endpoint, args }            → remote-result
 *   remote-stream-open   { type, requestId?, streamId, endpoint, args } → remote-frame* … remote-stream-closed
 *   remote-stream-cancel { type, streamId }
 *   remote-stream-credit { type, streamId, n }   grant the host `n` more frames
 */
export const REMOTE_CLIENT_TYPES = Object.freeze([
  'remote-call',
  'remote-stream-open',
  'remote-stream-cancel',
  'remote-stream-credit',
])

/**
 * Server → client remote-bridge frames (they use `kind`, like every server frame):
 *   remote-result         { kind, requestId, ok: true, value } | { kind, requestId, ok: false, error }
 *   remote-frame          { kind, streamId, seq, value }
 *   remote-stream-closed  { kind, streamId, error? }
 */
export const REMOTE_SERVER_KINDS = Object.freeze([
  'remote-result',
  'remote-frame',
  'remote-stream-closed',
])

/** Credit a stream starts with before the client grants more (spec 008, backpressure). */
export const REMOTE_STREAM_DEFAULT_CREDIT = 64

/** Largest binary chunk (bytes, before base64) the bridge puts into one frame. */
export const REMOTE_BINARY_CHUNK_BYTES = 256 * 1024

// ---------------------------------------------------------------------------
// Spec 019 Wave 3 — permission control, view + lower-only (additive)
//
// Two client frames, NOT contract §4 operations (`OPS` is unchanged), both lifted
// by the one new never-default scope `permission:lower`:
//
//   permission-options { type, requestId, sessionId }
//     → { kind: 'permission-options', requestId, sessionId, currentValue,
//         options: [{ preset, sandbox, approval }] }
//   permission-lower   { type, requestId, sessionId, preset }
//     → { kind: 'permission-lower', requestId, sessionId, preset, currentValue,
//         accepted: true }
//       | { kind: 'permission-lower', requestId, sessionId, currentValue,
//           accepted: false, reason }
//
// The gateway computes both lists itself, from the in-process `permissionPresets`
// service: only presets that are STRICTLY stricter than the current one on at least
// one axis and looser on neither are offered, and `permission-lower` refuses every
// other target. When the service is missing or its shape differs, both frames are
// refused `unavailable` (fail closed).
// ---------------------------------------------------------------------------

/** The two spec 019 client frames. */
export const PERMISSION_LOWER_CLIENT_TYPES = Object.freeze(Object.keys(SCOPE_BY_TYPE).filter((type) => SCOPE_BY_TYPE[type] === 'permission:lower'))

/**
 * Alias so the contract test can treat the spec 019 frames like the other
 * "listed but not §4" families instead of restating the names.
 */
export const PERMISSION_LOWER_TYPES = PERMISSION_LOWER_CLIENT_TYPES

/** The scope that lifts them; never a default, present in `SCOPE_PRESETS.full`. */
export const PERMISSION_LOWER_SCOPE = 'permission:lower'

/** Capability the gateway advertises in `hello` for a device holding that scope. */
export const PERMISSION_LOWER_CAPABILITY = 'permission-lower'

/**
 * The sandbox axis, strictest first: an index LOWERS as the mode widens. This is DSH's
 * own escalation ladder (`read-only → workspace-write → danger-full-access`).
 */
export const SANDBOX_MODE_ORDER = Object.freeze(['read-only', 'workspace-write', 'danger-full-access'])

/**
 * The approval axis, strictest first. `ask` prompts the owner and `never` never does, so
 * `ask` is the stricter of the two; DSH's `APPROVAL_POLICIES` admits exactly these.
 */
export const APPROVAL_POLICY_ORDER = Object.freeze(['ask', 'never'])

/**
 * Current values that are never comparable: `custom` matches no configured preset and
 * `auto` is the experimental per-call reviewer (a `danger-full-access` sandbox). Either
 * one makes `permission-lower` refuse `custom-current`.
 */
export const PERMISSION_INCOMPARABLE_CURRENTS = Object.freeze(['custom', 'auto'])

/**
 * `reason` of a `permission-lower` receipt with `accepted: false`. Unlike the §5
 * approval receipt (a normal refusal with no error frame), a permission write refusal
 * is an ERROR frame carrying one of these codes plus a fixed sentence per code.
 *
 *   not-stricter    the target is equal to or looser than the current preset
 *   custom-current  the current preset is `custom`/`auto`/unknown, or the target is
 *   raced           the re-read after the write no longer resolves to the target
 *   unavailable     this Host has no usable `permissionPresets` service
 */
export const PERMISSION_LOWER_REASONS = Object.freeze(['not-stricter', 'custom-current', 'raced', 'unavailable'])

/**
 * The fixed sentence a DEVICE gets for each refusal code — never the Host's own text.
 * `null` = `permission:lower` is not a scope this device holds (answered with
 * `auth/forbidden-scope` by the ordinary scope gate).
 */
export const PERMISSION_LOWER_MESSAGES = Object.freeze({
  'not-stricter': 'the requested preset is not stricter than the current one',
  'custom-current': 'the current or requested preset cannot be compared to a preset',
  raced: 'the preset changed before the switch could be confirmed',
  unavailable: 'this computer cannot change the permission preset for a device',
})

// ---------------------------------------------------------------------------
// §3.5 / §6 Capabilities, close codes, errors
// ---------------------------------------------------------------------------

/** Capabilities a host advertises in `hello` for companion protocol v1 (contract §3.5). */
export const CAPABILITIES = Object.freeze(['sessions-read', 'prompt', 'cancel', 'approval-v1'])

/** Extra capabilities a host MAY advertise on top of `CAPABILITIES`. */
export const OPTIONAL_CAPABILITIES = Object.freeze([
  'push-v1',
  // Spec 016 Phase 3 (revision 10): the host will send `browser-command` frames.
  // A client that can honour them lists the same name in `client-hello.capabilities`.
  'browser-agent:1',
  // Revision 11: the two ops that rename/archive ONE session the device already sees.
  // Advertised PER DEVICE and only for a device holding `sessions:author`; the app
  // shows its row menu only when they are listed (see SESSION_EDIT_CAPABILITY_SCOPE).
  'session-rename',
  'session-archive',
  // Spec 019 Wave 3: the app may show its permission chip. Advertised PER DEVICE and
  // only for a device holding `permission:lower` (see SESSION_EDIT_CAPABILITY_SCOPE).
  'permission-lower',
])

/**
 * Revision 11 (contract §3.5): `session-rename` / `session-archive` are advertised only
 * for a device holding `sessions:author`. Spec 019 adds `permission-lower`, advertised
 * only for a device holding `permission:lower`. Every other optional capability above
 * is advertised on its own condition, so this map names exactly the scope-gated ones.
 * The gateway reads it instead of restating the rule: a capability the list does not
 * name and that is not `CAPABILITIES`/`push-v1` is not advertised at all (fail closed).
 */
export const SESSION_EDIT_CAPABILITY_SCOPE = Object.freeze({
  'session-rename': AUTHORING_SCOPE,
  'session-archive': AUTHORING_SCOPE,
  // Spec 019 Wave 3: the app shows its permission chip only when this is listed.
  'permission-lower': PERMISSION_LOWER_SCOPE,
})

/**
 * WebSocket close codes (contract §3). `4004` = gateway disabled, stop auto-reconnect;
 * `4003` = re-authenticate; `4401` = device revoked, wipe the stored credential;
 * `4412` = web unlock locked (spec 020): keep the credential, re-attest later.
 */
export const CLOSE_CODES = Object.freeze({
  gatewayDisabled: 4004,
  reauth: 4003,
  revoked: 4401,
  // Spec 021 (revision 14): a web device whose passkey was replaced elsewhere, or whose
  // replacement was approved, is closed with this code so it re-asserts. Deliberately
  // NOT 4401: nothing was revoked, the credential must be KEPT, and the lock is in band
  // (`auth/locked`) for an ordinary locked socket. Distinct from the pairing codes
  // 4403 / 4408 / 4410, which only occur before a credential exists.
  locked: 4412,
})

/**
 * Error code → HTTP status on the WebSocket upgrade, `null` where the contract shows `—`
 * (in-band error frames only). See contract §6.
 */
export const ERROR_CODES = Object.freeze({
  'auth/required': 401,
  'auth/revoked': 401,
  // In-band only (spec 005): the device may connect, its scopes just forbid this op.
  'auth/forbidden-scope': null,
  'remote/disabled': 403,
  'op/forbidden': null,
  'pairing/expired': 401,
  'protocol/unsupported': null,
  'bad-request': null,
  'session-not-found': null,
  // Spec 021 (revision 14): a web:unlock device whose socket has not passed a passkey
  // assertion is refused every op except the passkey frames. `reason` is `locked`,
  // `unregistered` or `rate-limited`.
  'auth/locked': null,
  // Spec 021: every passkey frame's refusal is in band and carries no detail beyond the code.
  'passkey/not-registered': null,
  'passkey/already-registered': null,
  'passkey/challenge-expired': null,
  'passkey/verification-failed': null,
  'passkey/rate-limited': null,
})

/**
 * Host error codes the contract allows to pass through unchanged (contract §6 postscript).
 * Clients show a generic error for any code they do not know.
 */
export const PASSTHROUGH_ERROR_CODES = Object.freeze(['agent-busy', 'internal'])

// ---------------------------------------------------------------------------
// §3.8 Pairing proof exchange (revision 6, additive — contract §3.8)
//
// A pairing connection is a restricted state machine: the gateway sends one
// `pairing-challenge` as soon as the socket opens, accepts exactly one
// `pairing-proof` in reply, and refuses every other frame with `op/forbidden`
// (the third refusal closes with `rejected`). After a valid proof the request
// waits for the Host user's approval (`pairing-pending`, 5 minutes) before the
// `paired`/`hello` frames finally arrive. Nothing else is accepted meanwhile.
// ---------------------------------------------------------------------------

/** `type` of the single client frame a pairing socket may send before approval. */
export const PAIRING_PROOF_TYPE = 'pairing-proof'

/**
 * Format every `clientNonce` MUST match (contract §3.8): 16–64 characters of
 * unpadded base64url, i.e. ≥ 96 bits of nonce. Stateless (no `g`/`y` flag).
 */
export const PAIRING_NONCE = /^[A-Za-z0-9_-]{16,64}$/

/**
 * Close codes of a pairing connection (contract §3.8). Deliberately separate from
 * {@link CLOSE_CODES}: those are the authenticated-connection codes, and the
 * contract pins their exact set.
 * `rejected` 4403 = refused (bad nonce, busy, disabled, too many refusals);
 * `timeout` 4408 = no proof before the handshake deadline;
 * `expired` 4410 = the code or the pending request expired.
 */
export const PAIRING_CLOSE_CODES = Object.freeze({
  rejected: 4403,
  timeout: 4408,
  expired: 4410,
})

/** Unpadded base64url alphabet (RFC 4648 §5), as the wire format uses it. */
const BASE64URL_ALPHABET = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789-_'

/** Bytes in a generated nonce: 24 ⇒ exactly 32 base64url chars (a multiple of 3). */
const CLIENT_NONCE_BYTES = 24

/**
 * Secure random bytes, or a throw — never a weak fallback.
 *
 * The package is dependency-free and runs on the Host (Node) and in the app (Hermes),
 * so the only portable source is Web Crypto's `getRandomValues`. A platform whose
 * global crypto is missing (an older Hermes has none) MUST inject its own generator;
 * silently using `Math.random` for a pairing nonce would make it predictable.
 */
function defaultRandomBytes(size) {
  const webcrypto = globalThis.crypto
  if (webcrypto === undefined || webcrypto === null || typeof webcrypto.getRandomValues !== 'function') {
    throw new Error('createClientNonce: no secure random source in this runtime; pass a randomBytes function')
  }
  return webcrypto.getRandomValues(new Uint8Array(size))
}

/**
 * Build a `clientNonce` for a `pairing-proof` frame (contract §3.8).
 *
 * Returns 32 chars of unpadded base64url — inside {@link PAIRING_NONCE}'s 16–64 range
 * with 192 bits of entropy. `randomBytes(n)` defaults to Web Crypto and may be injected
 * (e.g. the app's `expo-crypto`); it MUST return cryptographically secure bytes.
 *
 * @param {(size: number) => Uint8Array|ArrayLike<number>} [randomBytes]
 * @returns {string}
 */
export function createClientNonce(randomBytes = defaultRandomBytes) {
  const bytes = randomBytes(CLIENT_NONCE_BYTES)
  if (bytes === undefined || bytes === null || bytes.length !== CLIENT_NONCE_BYTES) {
    throw new Error(`createClientNonce: randomBytes must return ${CLIENT_NONCE_BYTES} bytes`)
  }
  let nonce = ''
  for (let index = 0; index < CLIENT_NONCE_BYTES; index += 3) {
    const chunk = ((bytes[index] & 0xff) << 16) | ((bytes[index + 1] & 0xff) << 8) | (bytes[index + 2] & 0xff)
    nonce += BASE64URL_ALPHABET[(chunk >>> 18) & 0x3f]
      + BASE64URL_ALPHABET[(chunk >>> 12) & 0x3f]
      + BASE64URL_ALPHABET[(chunk >>> 6) & 0x3f]
      + BASE64URL_ALPHABET[chunk & 0x3f]
  }
  // Cheap invariant: the generator's output is always acceptable to the gateway.
  if (!PAIRING_NONCE.test(nonce)) throw new Error('createClientNonce: generated an unusable nonce')
  return nonce
}

// ---------------------------------------------------------------------------
// §5 Approvals
// ---------------------------------------------------------------------------

/** Outcomes a companion client may send; `cancelled`/`unavailable` are host-only states. */
export const APPROVAL_OUTCOMES_CLIENT = Object.freeze(['allowed-once', 'rejected'])

/** Every outcome found in an `approval-resolved` push, client-sent ones first. */
export const APPROVAL_OUTCOMES_FINAL = Object.freeze(['allowed-once', 'rejected', 'cancelled', 'unavailable'])

/**
 * `reason` values of a receipt with `accepted: false` (contract §5):
 * `not-pending` = already decided / handed to the desktop;
 * `hash-mismatch` = the content changed, the client must reload the card and re-review.
 */
export const RECEIPT_REASONS = Object.freeze(['not-pending', 'hash-mismatch'])

/** Keep-alive interval for `{ "type": "ping" }` (contract §4). */
export const PING_INTERVAL_MS = 25_000

// ---------------------------------------------------------------------------
// Types (JSDoc; mirrored for TypeScript consumers in `index.d.ts`)
// ---------------------------------------------------------------------------

/**
 * `device` object as sent in `paired`, `hello`, and `device-info` (contract §3.3, §3.5, §4).
 * @typedef {Object} DeviceInfo
 * @property {string} id Server-side device id.
 * @property {string} name Display name (client-supplied on pairing).
 * @property {number|string} [createdAt] Epoch milliseconds (upstream) — treat as opaque.
 * @property {DeviceKind} [kind] Absent on a gateway that predates scopes.
 * @property {Scope[]} [scopes] Same: any type of a gateway without scopes is allowed.
 */

/**
 * Client → server request frame (contract §1). `requestId` is required, ≤ 64 chars of
 * `[A-Za-z0-9._-]`; every answer echoes it.
 * @typedef {Object} ClientRequestFrame
 * @property {string} type One of {@link OPS}.
 * @property {string} requestId
 */

/** @typedef {{ type: 'client-hello', requestId: string, companionProtocol: number, appVersion: string, platform: 'ios'|'android' }} ClientHelloFrame */
/** @typedef {{ type: 'ping', requestId: string }} PingFrame */
/** @typedef {{ type: 'sessions', requestId: string }} SessionsRequestFrame */
/** @typedef {{ type: 'search', requestId: string, query: string }} SearchRequestFrame */
/** @typedef {{ type: 'history', requestId: string, sessionId: string, beforeSeq?: number, maxMessages?: number, maxBytes?: number }} HistoryRequestFrame */
/** @typedef {{ type: 'subscribe', requestId: string, sessionId: string }} SubscribeFrame */
/** @typedef {{ type: 'unsubscribe', requestId: string }} UnsubscribeFrame */
/** @typedef {{ type: 'message', requestId: string, sessionId: string, text: string, clientMsgId: string, mode?: 'queue'|'steer' }} MessageFrame */
/** @typedef {{ type: 'session-cancel', requestId: string, sessionId: string }} SessionCancelFrame */
/** @typedef {{ type: 'approval-response', requestId: string, rpcId: string, sessionId: string, approvalId: string, argsHash: string, outcome: 'allowed-once'|'rejected' }} ApprovalResponseFrame */
/** @typedef {{ type: 'device-info', requestId: string }} DeviceInfoRequestFrame */
/** @typedef {{ type: 'device-forget', requestId: string }} DeviceForgetFrame */
/** @typedef {{ type: 'push-register', requestId: string, platform: 'apns'|'fcm', token: string }} PushRegisterFrame */
/** @typedef {{ type: 'push-remove', requestId: string }} PushRemoveFrame */

/**
 * Server → client `hello` (contract §3.5). Sent after `paired` (first pairing) or after the
 * bearer credential was accepted.
 * @typedef {Object} HelloFrame
 * @property {'hello'} kind
 * @property {number} protocol Upstream wire protocol number (3 today), not the companion version.
 * @property {number} companionProtocol {@link COMPANION_PROTOCOL_VERSION}
 * @property {number} minClientVersion {@link MIN_CLIENT_VERSION}
 * @property {string[]} capabilities {@link CAPABILITIES} plus any advertised {@link OPTIONAL_CAPABILITIES}.
 * @property {boolean} authenticated
 * @property {DeviceInfo} device
 * @property {string} gatewayId
 * @property {string} [dshVersion] DSH runtime version, e.g. `0.2.2-rc.1`.
 * @property {string} [certSha256] Hex SHA-256 of the pinned TLS leaf certificate.
 */

/**
 * Server → client `paired`, sent exactly once on a pairing connection (contract §3.3).
 * The client stores `token` in the secure store immediately; it is never sent again.
 * @typedef {Object} PairedFrame
 * @property {'paired'} kind
 * @property {string} token Long-lived device token.
 * @property {DeviceInfo} device
 */

/**
 * Server → client `pairing-challenge`, sent once as soon as a pairing socket opens
 * (contract §3.8). It is unconditional: no client frame triggers it.
 * @typedef {Object} PairingChallengeFrame
 * @property {'pairing-challenge'} kind
 * @property {string} serverNonce Opaque server nonce (unpadded base64url).
 * @property {string} certSha256 The pinned leaf the gateway is presenting (64 lowercase hex).
 * @property {boolean} otpRequired True for an OTP flow (the proof needs `otpProof`);
 *   false for the QR / long pairing-string flow, where the string is itself the secret.
 */

/**
 * Client → server `pairing-proof` — the ONLY frame a pairing socket may send before the
 * Host approves (contract §3.8). A second one, or any other frame, is refused.
 * @typedef {Object} PairingProofFrame
 * @property {'pairing-proof'} type
 * @property {string} clientNonce MUST match {@link PAIRING_NONCE}; see {@link createClientNonce}.
 * @property {string} [otpProof] REQUIRED when the challenge had `otpRequired: true`, and
 *   MUST be absent otherwise.
 */

/**
 * Server → client `pairing-pending`: the proof was valid and the request now waits for the
 * Host user to approve on the desktop (contract §3.8). `verificationCode` is shown to the
 * user so they can compare it with the Host. The window is 5 minutes (contract §3.8);
 * no client frame is accepted until the outcome.
 * @typedef {Object} PairingPendingFrame
 * @property {'pairing-pending'} kind
 * @property {string} verificationCode Short human code the Host displays as well.
 * @property {string} requestId Id of the pending pairing request.
 * @property {number} expiresAt Epoch milliseconds when the request expires.
 */

/**
 * Server → client `pairing-rejected`, sent just before the socket closes (contract §3.8).
 * @typedef {Object} PairingRejectedFrame
 * @property {'pairing-rejected'} kind
 * @property {string} reason Machine reason, e.g. `pairing/timeout`, `pairing/expired`,
 *   `pairing/refused`, `pairing/bad-nonce`, `pairing/busy`, `pairing/disabled`.
 */

/**
 * Server → client error frame (contract §1). `requestId`/`requestType` are present when the
 * error answers a request; `minClientVersion` accompanies `protocol/unsupported`.
 * @typedef {Object} ErrorFrame
 * @property {'error'} kind
 * @property {string} code One of {@link ERROR_CODES} or a passthrough code.
 * @property {string} [requestType] The op whose request failed.
 * @property {string} [requestId]
 * @property {string} [message]
 * @property {number} [minClientVersion]
 */

/**
 * Server push when an approval waits for a decision (contract §5).
 * `argsHash === null` means the gateway could not bind the content: the client MUST NOT offer
 * approve/reject. Deduplicate by `rpcId`.
 * @typedef {Object} ApprovalRequestedFrame
 * @property {'approval-requested'} kind
 * @property {string} rpcId
 * @property {string} sessionId
 * @property {string} approvalId
 * @property {string} toolName
 * @property {string} [callId]
 * @property {string} [reason]
 * @property {Record<string,string>} [displayReason] Localised display text, e.g. `{ "en": "..." }`.
 * @property {string|null} argsHash 64 hex chars, or `null` (desktop only).
 * @property {string} [argsPreview] ≤ 2 KB text. Always a string from a revision 2.1 gateway
 *   (contract §5a); optional here only because a pre-2.1 host may omit the field.
 * @property {boolean} [replay] True when replayed for a fresh `subscribe`.
 */

/**
 * Server receipt for an `approval-response` (contract §5).
 * @typedef {Object} ApprovalResponseReceipt
 * @property {'approval-response'} kind
 * @property {string} requestId
 * @property {string} rpcId
 * @property {string} sessionId
 * @property {string} approvalId
 * @property {'allowed-once'|'rejected'} outcome
 * @property {true} accepted
 */

/**
 * Server receipt when a decision was refused.
 * @typedef {Object} ApprovalResponseRejected
 * @property {'approval-response'} kind
 * @property {string} requestId
 * @property {string} rpcId
 * @property {string} sessionId
 * @property {string} approvalId
 * @property {'allowed-once'|'rejected'} outcome
 * @property {false} accepted
 * @property {'not-pending'|'hash-mismatch'} reason
 */

/**
 * Final-state push, sent to every client once an approval leaves the pending set.
 * @typedef {Object} ApprovalResolvedFrame
 * @property {'approval-resolved'} kind
 * @property {string} rpcId
 * @property {string} sessionId
 * @property {string} approvalId
 * @property {'allowed-once'|'rejected'|'cancelled'|'unavailable'} outcome
 */

/**
 * Decoded pairing payload: the unpadded-base64url QR/manual text decodes to this JSON
 * (contract §2).
 * @typedef {Object} PairingPayload
 * @property {3} version {@link PAIRING_QR_VERSION}
 * @property {string} publicUrl `wss://…`
 * @property {string} pairingCode Base64url 256-bit one-time code.
 * @property {number} expiresAt Epoch milliseconds, ≤ 5 min ahead.
 * @property {string} certSha256 64 lowercase hex.
 * @property {string} gatewayId UUID v4.
 * @property {string} gatewayName
 * @property {string[]} endpoints `wss://…` URLs; `publicUrl` is always first.
 */

/**
 * One session row from `sessions`/`search` (upstream list projection, contract rev 2.1 §5a:
 * canonical `sessionId`, epoch-ms `updatedAt`, `running`, title in `projections.values.title`;
 * the client derives running/idle/archived).
 * @typedef {Object} SessionRow
 * @property {string} sessionId Canonical upstream session id.
 * @property {string} [id] Deprecated: pre-rev2.1 alias; only a documented compatibility fallback.
 * @property {number|string} [updatedAt] Epoch ms (epoch seconds tolerated for legacy hosts).
 * @property {boolean} [running] True while the session runs; false/absent means idle.
 * @property {'running'|'idle'|'archived'} [state] Deprecated: not an upstream field.
 * @property {{ values?: { title?: string }, [key: string]: unknown }} [projections]
 * @property {boolean} [needsDecision]
 */

/** @typedef {typeof OPS[number]} Op */
/** @typedef {typeof SCOPE_BY_TYPE[keyof typeof SCOPE_BY_TYPE]} ScopedOp */
/** @typedef {typeof DEVICE_KINDS[number]} DeviceKind */
/** @typedef {typeof SCOPES[number]} Scope */
/** @typedef {typeof AUTHORING_CLIENT_TYPES[number]} AuthoringType */
/** @typedef {typeof REMOTE_UPLOAD_CLIENT_TYPES[number]} RemoteUploadType */
/** @typedef {typeof CAPABILITIES[number] | typeof OPTIONAL_CAPABILITIES[number]} Capability */
/** @typedef {typeof APPROVAL_OUTCOMES_CLIENT[number]} ClientApprovalOutcome */
/** @typedef {typeof APPROVAL_OUTCOMES_FINAL[number]} FinalApprovalOutcome */
/** @typedef {typeof RECEIPT_REASONS[number]} ReceiptReason */
/** @typedef {keyof typeof CLOSE_CODES} CloseCodeName */
/** @typedef {typeof CLOSE_CODES[CloseCodeName]} CloseCode */
/** @typedef {keyof typeof PAIRING_CLOSE_CODES} PairingCloseCodeName */
/** @typedef {typeof PAIRING_CLOSE_CODES[PairingCloseCodeName]} PairingCloseCode */
