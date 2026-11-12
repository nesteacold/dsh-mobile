/**
 * TypeScript declarations for `@dsh-ext/mobile-protocol` (contract v1, revision 12).
 *
 * Keep in step with `src/index.mjs`; `test/contract.test.mjs` checks the runtime values
 * against the contract document, and `types.test-d.ts` inside the companion app keeps a
 * type-level check that this surface still matches what the app imports.
 */

// ---------------------------------------------------------------------------
// §1 / §3 — framing, subprotocols
// ---------------------------------------------------------------------------

export const PROTOCOL_SUBPROTOCOL: 'dsh-mobile-v1'
export const COMPANION_PROTOCOL_VERSION: 1
export const MIN_CLIENT_VERSION: 1
export const PAIRING_QR_VERSION: 3

export const SUBPROTOCOL_PREFIXES: Readonly<{
  pair: 'dsh-pair.'
  auth: 'dsh-auth.'
  device: 'dsh-device.'
}>

export const DEVICE_ID_HEADER: 'X-DSH-Device-ID'

export function pairingSubprotocols(pairingCode: string): string[]
export function authSubprotocols(token?: string): string[]
export function deviceSubprotocol(installUuid: string): string

// ---------------------------------------------------------------------------
// §4 — operations
// ---------------------------------------------------------------------------

export type Op =
  | 'client-hello'
  | 'ping'
  | 'sessions'
  | 'search'
  | 'history'
  | 'subscribe'
  | 'unsubscribe'
  | 'message'
  | 'session-cancel'
  | 'approval-response'
  | 'device-info'
  | 'device-forget'
  | 'push-register'
  | 'push-remove'
  // Spec 011 (revision 7): session-authoring ops, gated by `sessions:author`.
  | 'workspaces'
  | 'session-create'
  | 'models'
  | 'select-model'
  // Revision 11: rename / archive one session the device already sees.
  | 'session-rename'
  | 'session-archive'

export const OPS: readonly Op[]

export type ResponseKind =
  | 'client-hello'
  | 'pong'
  | 'sessions'
  | 'search'
  | 'history'
  | 'subscribed'
  | 'unsubscribed'
  | 'sent'
  | 'session-cancelled'
  | 'approval-response'
  | 'device-info'
  | 'device-forgotten'
  | 'push-registered'
  | 'push-removed'
  // Spec 011 (revision 7): the kinds the upstream gateway answers the authoring ops with.
  | 'workspaces'
  | 'session-created'
  | 'models'
  | 'select-model'
  // Revision 11.
  | 'session-renamed'
  | 'session-archived'

export const OP_RESPONSES: Readonly<Record<Op, ResponseKind>>

export type PushKind = 'approval-requested' | 'approval-resolved' | 'event'
export const SERVER_PUSH_KINDS: readonly PushKind[]

// ---------------------------------------------------------------------------
// Device kinds and scopes (spec 005, FR2)
// ---------------------------------------------------------------------------

export type DeviceKind = 'mobile' | 'desktop'
export const DEVICE_KINDS: readonly DeviceKind[]

export type Scope =
  | 'sessions:read'
  | 'prompt:send'
  | 'approval:respond'
  | 'files:read'
  | 'files:write'
  | 'settings:write'
  /** Spec 018 (revision 10) read-only session metrics; never a default. */
  | 'stats:read'
  /** Spec 020 (revision 10) web PWA Host-attested unlock; mobile-holdable, never a default. */
  | 'web:unlock'
  /** Spec 008: remote-bridge channel; desktop only, never a default. */
  | 'harness:remote'
  /** Spec 008 full control (revision 5): desktop only, explicit only, never a default. */
  | 'commands:execute'
  | 'workspace:manage'
  | 'credentials:write'
  | 'plugins:manage'
  | 'schedule:write'
  /** Spec 018 item 3 (revision 12) read-only schedule list/view; a new scope, never a default. */
  | 'schedule:read'
  | 'terminal'
  /**
   * Spec 011: list this Host's workspaces, list the model catalog, create a session and
   * pick its provider/model. Explicit only; deliberately NOT desktop-only (a `mobile`
   * device may hold it).
   */
  | 'sessions:author'
  /**
   * Spec 013: send attachment bytes into a session on this Host (`remote-upload-*`).
   * Part of the desktop default set, never part of a kind-independent default, and
   * the frames themselves require a `desktop` device.
   */
  | 'attachments:write'
  /**
   * Spec 014 C6: drive the Host's built-in side-panel browser from a device.
   * Grantable like every other scope (no hard block); part of the desktop default
   * set, never part of a kind-independent default.
   */
  | 'browser:control'
  /**
   * Spec 019 Wave 3: read this Host's permission presets and switch ONE session to a
   * strictly stricter preset (`permission-options` / `permission-lower`). Explicit
   * only, never a default; `full` includes it. It can never widen a preset.
   */
  | 'permission:lower'

export const SCOPES: readonly Scope[]
export const DESKTOP_DEFAULT_SCOPES: readonly Scope[]
/**
 * Scopes no kind-independent default may contain (spec 011 FR-006, spec 013).
 * `sessions:author` is grantable to a `mobile` device, so it is not desktop-only and
 * would otherwise fall into both default computations; it must be an explicit tick.
 * `attachments:write` is a desktop default in DESKTOP_DEFAULT_SCOPES, but the mobile
 * default and the pre-005 migration must never acquire it.
 * `browser:control` (spec 014 C6) is listed for the same reason.
 * Explicit grants (an owner's tick, `SCOPE_PRESETS.full`) still include them.
 */
export const NEVER_DEFAULT_SCOPES: readonly Scope[]
/** Scopes only a `desktop` device may hold, and only when chosen explicitly. */
export const DESKTOP_ONLY_SCOPES: readonly Scope[]
export type ScopePresetName = 'standard' | 'full'
/** Devices UI presets: `standard` = default at Approve, `full` = every contract scope. */
export const SCOPE_PRESETS: Readonly<Record<ScopePresetName, readonly Scope[]>>

/**
 * Spec 011 client types (revision 7) plus revision 11's session rename/archive — all
 * served only to a device holding `sessions:author`.
 */
export type AuthoringType = 'workspaces' | 'session-create' | 'models' | 'select-model'
  | 'session-rename' | 'session-archive'
export const AUTHORING_CLIENT_TYPES: readonly AuthoringType[]
/** The scope every authoring type requires (`sessions:author`). */
export const AUTHORING_SCOPE: Scope

/** Spec 018 (revision 10) read-only session-metric types. */
export type StatsReadType = 'session-stats' | 'context-usage'
/** Spec 018 item 2: read-on-demand team/subagent frames, under `sessions:read`. */
export type TeamReadType = 'agent-team' | 'subagents'
export const TEAM_READ_CLIENT_TYPES: readonly TeamReadType[]
/** Their scope: the ordinary session read scope (`sessions:read`), not a new one. */
export const TEAM_READ_SCOPE: Scope
/** Spec 018 item 3: read-only schedule frames, under the explicit-only `schedule:read`. */
export type ScheduleReadType = 'schedule-catalog' | 'schedule-list' | 'schedule-view'
export const SCHEDULE_READ_CLIENT_TYPES: readonly ScheduleReadType[]
/** Their scope: `schedule:read` — never granted by a preset default. */
export const SCHEDULE_READ_SCOPE: Scope
/** Spec 018 item 4: answer/decline a question, under the approval scope. */
export type QuestionResponseType = 'question-answer' | 'question-cancel'
export const QUESTION_RESPONSE_TYPES: readonly QuestionResponseType[]
/** Their scope: `approval:respond` (no scope of their own). */
export const QUESTION_RESPONSE_SCOPE: Scope
/** Longest `custom` free-text answer. */
export const QUESTION_CUSTOM_MAX_LENGTH: number
export const STATS_READ_CLIENT_TYPES: readonly StatsReadType[]
/** The scope both metric types require (`stats:read`); never a default. */
export const STATS_READ_SCOPE: Scope

// ---------------------------------------------------------------------------
// Spec 021 (revision 14) — web passkey unlock (replaces the spec 020 account attestation)
// ---------------------------------------------------------------------------

/** The four web (PWA) passkey client frames; not §4 ops, all behind `web:unlock`. */
export type PasskeyType =
  | 'passkey-register-options'
  | 'passkey-register'
  | 'passkey-assert-options'
  | 'passkey-assert'
export const PASSKEY_REGISTER_OPTIONS_TYPE: 'passkey-register-options'
export const PASSKEY_REGISTER_TYPE: 'passkey-register'
export const PASSKEY_ASSERT_OPTIONS_TYPE: 'passkey-assert-options'
export const PASSKEY_ASSERT_TYPE: 'passkey-assert'
export const PASSKEY_CLIENT_TYPES: readonly PasskeyType[]

/** The scope that gates the passkey frames and arms the server-side lock (`web:unlock`). */
export const WEB_UNLOCK_SCOPE: Scope
/** Frames a locked web device may still send (hello and ping are channel-neutral anyway). */
export const WEB_UNLOCK_EXEMPT_TYPES: readonly PasskeyType[]
/** The in-band refusal of a locked device: `auth/locked` (WS close `4412` is reserved for re-auth). */
export const WEB_LOCK_ERROR: 'auth/locked'
/** `hello.webLock` for a web device; absent for every device without `web:unlock`. */
export type WebLockState = 'unregistered' | 'locked' | 'unlocked'
export const WEB_LOCK_STATES: readonly WebLockState[]
/** Why a `web:unlock` device was refused with `auth/locked` (`reason`). */
export type WebLockReason = WebLockState | 'rate-limited'
/** Challenge lifetime: one use, bound to the socket that asked for it. */
export const PASSKEY_CHALLENGE_TTL_MS: number
/** Failed-operation rate limits (per device 5 / 10 min, global 30 / hour). */
export const PASSKEY_RATE_LIMITS: Readonly<{
  perDevice: number
  perDeviceWindowMs: number
  global: number
  globalWindowMs: number
}>
/** Inactivity bound of an unlock (15 min): a new connection always starts locked. */
export const WEB_UNLOCK_IDLE_MS: number
/** The passkey frames' error codes (contract §6). `already-registered` needs Host approval. */
export type PasskeyErrorCode =
  | 'passkey/not-registered'
  | 'passkey/already-registered'
  | 'passkey/challenge-expired'
  | 'passkey/verification-failed'
  | 'passkey/rate-limited'
export const PASSKEY_ERROR_CODES: readonly PasskeyErrorCode[]
/** Server frame announcing that the owner approved replacing this device's passkey. */
export const PASSKEY_APPROVAL_KIND: 'passkey-approval'
/** Approvals a desktop client may decide for a web device's passkey. */
export const PASSKEY_APPROVAL_ACTIONS: readonly ('approve' | 'reject')[]

/** Scope of each scoped inbound type; a type absent here is refused for a scoped device. */
export const SCOPE_BY_TYPE: Readonly<Partial<Record<Op | RemoteClientType | AuthoringType | RemoteUploadType | StatsReadType | TeamReadType | ScheduleReadType | QuestionResponseType | PermissionLowerType | PasskeyType, Scope>>>

// ---------------------------------------------------------------------------
// Spec 019 Wave 3 — permission control, view + lower-only (additive)
// ---------------------------------------------------------------------------

/** The two spec 019 client frames (not §4 ops; both need `permission:lower`). */
export type PermissionLowerType = 'permission-options' | 'permission-lower'
export const PERMISSION_LOWER_CLIENT_TYPES: readonly PermissionLowerType[]
/** Alias of `PERMISSION_LOWER_CLIENT_TYPES`, for the listed-but-not-§4 families. */
export const PERMISSION_LOWER_TYPES: readonly PermissionLowerType[]
/** The scope that lifts them (`permission:lower`); never a default, in `full`. */
export const PERMISSION_LOWER_SCOPE: Scope
/** Advertised in `hello` only for a device holding `permission:lower`. */
export const PERMISSION_LOWER_CAPABILITY: 'permission-lower'
/** The sandbox axis, strictest first (a higher index is looser). */
export const SANDBOX_MODE_ORDER: readonly ('read-only' | 'workspace-write' | 'danger-full-access')[]
/** The approval axis, strictest first (`ask` prompts, `never` does not). */
export const APPROVAL_POLICY_ORDER: readonly ('ask' | 'never')[]
/** Current values that are never comparable (`custom`, `auto`). */
export const PERMISSION_INCOMPARABLE_CURRENTS: readonly ('custom' | 'auto')[]
/** Why a `permission-lower` write was refused (the receipt's `reason`). */
export type PermissionLowerReason = 'not-stricter' | 'custom-current' | 'raced' | 'unavailable'
export const PERMISSION_LOWER_REASONS: readonly PermissionLowerReason[]
/** The fixed sentence a device gets for each refusal — never the Host's text. */
export const PERMISSION_LOWER_MESSAGES: Readonly<Record<PermissionLowerReason, string>>

/** Read the current preset and the strictly-stricter presets this Host offers. */
export interface PermissionOptionsFrame {
  type: 'permission-options'
  requestId: string
  sessionId: string
}

/** Switch one session to a strictly stricter preset. */
export interface PermissionLowerFrame {
  type: 'permission-lower'
  requestId: string
  sessionId: string
  preset: string
}

/** One offered target's knob pair, as the gateway resolved it. */
export interface PermissionOption {
  preset: string
  sandbox: 'read-only' | 'workspace-write' | 'danger-full-access'
  approval: 'ask' | 'never'
}

export interface PermissionOptionsReply {
  kind: 'permission-options'
  requestId: string
  sessionId: string
  /** The preset in effect (`custom`/`auto` included), or `null` when unresolvable. */
  currentValue: string | null
  /** Only presets stricter than `currentValue` on at least one axis, looser on none. */
  options: PermissionOption[]
}

export type PermissionLowerReply =
  | { kind: 'permission-lower'; requestId: string; sessionId: string; preset: string; currentValue: string; accepted: true }
  | { kind: 'permission-lower'; requestId: string; sessionId: string; currentValue: string | null; accepted: false; reason: PermissionLowerReason }

export interface WorkspacesFrame {
  type: 'workspaces'
  requestId: string
}

export interface SessionCreateFrame {
  type: 'session-create'
  requestId: string
  /** One of this Host's workspaces; a foreign id is refused. */
  workspaceId?: string
  /** Needs `workspace:manage`: an arbitrary Host directory. */
  cwd?: string
  /** Needs `workspace:manage`: an arbitrary agent composition. */
  agentPreset?: string
}

export interface ModelsFrame {
  type: 'models'
  requestId: string
  /** With a session: that session's catalog. Without: the whole Host catalog. */
  sessionId?: string
}

export interface SelectModelFrame {
  type: 'select-model'
  requestId: string
  /** A session this device can address; otherwise refused like `session/prompt`. */
  sessionId: string
  provider: string
  model: string
  reasoningEffort?: string
}

/** Revision 11: rename one session the device may see. `title` trimmed, 1–200 code points. */
export interface SessionRenameFrame {
  type: 'session-rename'
  requestId: string
  sessionId: string
  title: string
}

/** Revision 11: archive one session the device may see. The conversation stays on the Host. */
export interface SessionArchiveFrame {
  type: 'session-archive'
  requestId: string
  sessionId: string
}

// ---------------------------------------------------------------------------
// Spec 008 — remote-bridge channel (revision 4, additive)
// ---------------------------------------------------------------------------

export type RemoteClientType =
  | 'remote-call'
  | 'remote-stream-open'
  | 'remote-stream-cancel'
  | 'remote-stream-credit'

export type RemoteServerKind = 'remote-result' | 'remote-frame' | 'remote-stream-closed'

export const REMOTE_CLIENT_TYPES: readonly RemoteClientType[]
export const REMOTE_SERVER_KINDS: readonly RemoteServerKind[]
export const REMOTE_STREAM_DEFAULT_CREDIT: 64
export const REMOTE_BINARY_CHUNK_BYTES: 262144

/** A DSH Gateway endpoint (`namespace/method`, `$events` or `$events/result`). */
export interface RemoteCallFrame {
  type: 'remote-call'
  requestId: string
  endpoint: string
  args: Record<string, unknown>
}

export interface RemoteStreamOpenFrame {
  type: 'remote-stream-open'
  requestId?: string
  streamId: string
  endpoint: string
  args: Record<string, unknown>
}

export interface RemoteStreamCancelFrame {
  type: 'remote-stream-cancel'
  streamId: string
}

/** Grants the host `n` more frames on the stream (credit-based backpressure). */
export interface RemoteStreamCreditFrame {
  type: 'remote-stream-credit'
  streamId: string
  n: number
}

export interface RemoteError {
  code: string
  message: string
}

export type RemoteResultFrame =
  | { kind: 'remote-result'; requestId: string; ok: true; value: unknown }
  | { kind: 'remote-result'; requestId: string; ok: false; error: RemoteError }

export interface RemoteFrame {
  kind: 'remote-frame'
  streamId: string
  seq: number
  value: unknown
}

export interface RemoteStreamClosedFrame {
  kind: 'remote-stream-closed'
  streamId: string
  error?: RemoteError
}

// ---------------------------------------------------------------------------
// Spec 013 — attachment upload (revision 8, additive)
// ---------------------------------------------------------------------------

export type RemoteUploadType =
  | 'remote-upload-open'
  | 'remote-upload-chunk'
  | 'remote-upload-finish'
  | 'remote-upload-cancel'

export const REMOTE_UPLOAD_CLIENT_TYPES: readonly RemoteUploadType[]
/** The single answer kind to every `remote-upload-*` frame. */
export const REMOTE_UPLOAD_RESULT_KIND: 'remote-upload-result'
/** Largest chunk (decoded bytes) per `remote-upload-chunk`; the open answer's `chunkBytes` wins. */
export const REMOTE_UPLOAD_MAX_CHUNK_BYTES: 262144
/** The scope every upload frame requires (`attachments:write`). */
export const ATTACHMENTS_WRITE_SCOPE: Scope

/** Which Host store the bytes end up in: a verbatim file, or a normalized prompt image. */
export type RemoteUploadKind = 'file' | 'image'

/**
 * Start one transfer. `size` is the exact decoded byte count and `sha256` its
 * 64 lowercase hex digest, verified against the received bytes at `finish`.
 * `name` is an optional display name (a leaf filename). `mediaType` is required
 * for `kind: 'image'` and must be one the Host accepts.
 */
export interface RemoteUploadOpenFrame {
  type: 'remote-upload-open'
  requestId: string
  sessionId: string
  kind: RemoteUploadKind
  name?: string
  mediaType?: string
  size: number
  sha256: string
}

export interface RemoteUploadChunkFrame {
  type: 'remote-upload-chunk'
  requestId: string
  uploadId: string
  /** Decoded byte offset; must equal the bytes already accepted (`nextOffset`). */
  offset: number
  /** Canonical base64 (standard alphabet, padded) of the chunk's bytes. */
  data: string
}

export interface RemoteUploadFinishFrame {
  type: 'remote-upload-finish'
  requestId: string
  uploadId: string
}

export interface RemoteUploadCancelFrame {
  type: 'remote-upload-cancel'
  requestId: string
  uploadId: string
}

/** The Host's own upload failure: its stable code, its message and any `details`. */
export interface RemoteUploadError {
  code: string
  message: string
  details?: unknown
}

/** Answer to `remote-upload-open`. `chunkBytes` is the effective chunk limit for this transfer. */
export interface RemoteUploadOpenedValue {
  uploadId: string
  sessionId: string
  kind: RemoteUploadKind
  name?: string
  mediaType?: string
  size: number
  chunkBytes: number
  maxBytes: number
  idleTimeoutMs: number
}

export interface RemoteUploadChunkAcceptedValue {
  uploadId: string
  sessionId: string
  nextOffset: number
}

export interface RemoteUploadCancelledValue {
  uploadId: string
  sessionId: string
  cancelled: true
}

/**
 * The Host's staged receipt, exactly as the native `POST /api/session/uploadFileBinary`
 * route returns it: a `receiptId` and either a `file` or an `image` reference. The
 * client passes it on unchanged (`{type:'file'|'image', receiptId}` in a `message`).
 */
export interface RemoteUploadReceiptValue {
  receiptId: string
  file?: Record<string, unknown>
  image?: Record<string, unknown>
}

export type RemoteUploadResultFrame =
  | { kind: 'remote-upload-result'; requestId: string; ok: true; value: unknown }
  | { kind: 'remote-upload-result'; requestId: string; ok: false; error: RemoteUploadError }

// ---------------------------------------------------------------------------
// Spec 016 Phase 3 — the host drives a browser on the paired client (revision 10)
// ---------------------------------------------------------------------------

/** Advertised by the gateway in `hello` and by a client in `client-hello.capabilities`. */
export const BROWSER_AGENT_CAPABILITY: 'browser-agent:1'
/** The device scope a `browser-command` needs (`browser:control`, spec 014 C6). */
export const BROWSER_CONTROL_SCOPE: Scope

export type BrowserOp =
  | 'navigate'
  | 'click'
  | 'type'
  | 'press'
  | 'scroll'
  | 'open'
  | 'close'
  | 'snapshot'
  | 'text'
  | 'html'
  | 'screenshot'
  | 'tabs'

/** Server → client kinds (`browser-command`, and `browser-cancel` in that direction). */
export type BrowserHostKind = 'browser-command' | 'browser-cancel'
/** Client → server types (`browser-result`, and `browser-cancel` in that direction). */
export type BrowserClientType = 'browser-result' | 'browser-cancel'

export const BROWSER_OPS: readonly BrowserOp[]
export const BROWSER_HOST_KINDS: readonly BrowserHostKind[]
export const BROWSER_CLIENT_TYPES: readonly BrowserClientType[]

/** A complete frame, serialized, may not exceed this many bytes (either direction). */
export const BROWSER_FRAME_MAX_BYTES: 1048576
/** Deadline applied when a command omits `deadlineMs`. */
export const BROWSER_DEADLINE_DEFAULT_MS: 30000
/** Largest deadline a command may ask for; a larger value is clamped, not refused. */
export const BROWSER_DEADLINE_MAX_MS: 120000
/** Largest decoded `result.screenshot` (JPEG bytes, before base64). */
export const BROWSER_SCREENSHOT_MAX_BYTES: 786432
/** Largest `result.text` / `result.html` kept; longer text is cut and flagged `truncated`. */
export const BROWSER_TEXT_MAX_BYTES: 262144
/** A `commandId`: 1..64 characters of `[A-Za-z0-9._-]`. */
export const BROWSER_COMMAND_ID: RegExp
export const BROWSER_ERROR_CODES: readonly string[]

export interface BrowserCommandFrame {
  kind: 'browser-command'
  commandId: string
  /** The session whose agent asked; the client shows it in the "agent is driving" banner. */
  sessionId: string
  op: BrowserOp
  args: Record<string, unknown>
  /** 1..120000; absent means 30000. A larger value is clamped by the receiver. */
  deadlineMs?: number
}

export interface BrowserError {
  /** `browser/…`; a client may return its own `browser/...` code. */
  code: string
  message: string
}

export type BrowserResultFrame =
  | { type: 'browser-result'; commandId: string; ok: true; result: unknown }
  | { type: 'browser-result'; commandId: string; ok: false; error: BrowserError }

/** Sent by either side: the host cancels a command, or the client declines one it was given. */
export interface BrowserCancelFrame {
  commandId: string
  /** Present on the host → client frame. */
  kind?: 'browser-cancel'
  /** Present on the client → server frame. */
  type?: 'browser-cancel'
}

/** `{ ok: true, value } | { ok: false, code, message }` — the validator result shape. */
export type BrowserValidation<T> = { ok: true; value: T } | { ok: false; code: string; message: string }

export function browserFrameBytes(frame: unknown): number
export function validateBrowserCommand(frame: unknown): BrowserValidation<{
  commandId: string
  sessionId: string
  op: BrowserOp
  args: Record<string, unknown>
  deadlineMs: number
}>
export function validateBrowserResult(frame: unknown): BrowserValidation<
  | { commandId: string; ok: true; result: unknown }
  | { commandId: string; ok: false; error: BrowserError }
>
export function validateBrowserCancel(frame: unknown): BrowserValidation<{ commandId: string }>
/** Cut a text/html result to `maxBytes` of UTF-8 without splitting a code point. */
export function truncateBrowserText(text: unknown, maxBytes?: number): { text: string; truncated: boolean; bytes: number }

// ---------------------------------------------------------------------------
// §3.5 / §5 / §6 — capabilities, close codes, errors, approvals
// ---------------------------------------------------------------------------

export type Capability = 'sessions-read' | 'prompt' | 'cancel' | 'approval-v1'
/** `browser-agent:1` (spec 016 Phase 3) is advertised only by a host/client that speaks it. */
export type OptionalCapability = 'push-v1' | 'browser-agent:1' | 'session-rename' | 'session-archive'
  /** Spec 019: advertised only for a device holding `permission:lower`. */
  | 'permission-lower'

export const CAPABILITIES: readonly Capability[]
export const OPTIONAL_CAPABILITIES: readonly OptionalCapability[]
/**
 * Revision 11: the optional capabilities advertised PER DEVICE, only for a device holding
 * the named scope (`session-rename` / `session-archive` → `sessions:author`,
 * `permission-lower` → `permission:lower`, spec 019).
 */
export const SESSION_EDIT_CAPABILITY_SCOPE: Readonly<Record<'session-rename' | 'session-archive' | 'permission-lower', Scope>>

export const CLOSE_CODES: Readonly<{
  gatewayDisabled: 4004
  reauth: 4003
  revoked: 4401
  /**
   * Spec 021 (revision 14): a web device whose passkey was replaced (or whose replacement was
   * approved) re-asserts. KEEP the credential (unlike 4401). An ordinary locked socket is
   * answered in band with `auth/locked`, never closed.
   */
  locked: 4412
}>

// ---------------------------------------------------------------------------
// §3.8 — pairing proof exchange (revision 6, additive)
// ---------------------------------------------------------------------------

/** The single client frame a pairing socket may send before the Host approves. */
export const PAIRING_PROOF_TYPE: 'pairing-proof'
/** Format a `clientNonce` MUST match: 16–64 chars of unpadded base64url (stateless regex). */
export const PAIRING_NONCE: RegExp
/**
 * Close codes of a pairing connection. Deliberately separate from {@link CLOSE_CODES},
 * which stays pinned to the authenticated-connection codes.
 * `rejected` 4403, `timeout` 4408, `expired` 4410.
 */
export const PAIRING_CLOSE_CODES: Readonly<{
  rejected: 4403
  timeout: 4408
  expired: 4410
}>

/**
 * Build a `clientNonce`: 32 chars of unpadded base64url (192 bits), inside
 * {@link PAIRING_NONCE}. `randomBytes` defaults to Web Crypto and may be injected
 * (e.g. the app's `expo-crypto`); it MUST return cryptographically secure bytes, and
 * the function THROWS rather than fall back to a weak source.
 */
export function createClientNonce(randomBytes?: (size: number) => Uint8Array | ArrayLike<number>): string

/** Server frame sent once as soon as a pairing socket opens (unconditional). */
export interface PairingChallengeFrame {
  kind: 'pairing-challenge'
  /** Opaque server nonce (unpadded base64url). */
  serverNonce: string
  /** The pinned leaf the gateway presents (64 lowercase hex). */
  certSha256: string
  /** True for an OTP flow (the proof needs `otpProof`); false for the QR/long-string flow. */
  otpRequired: boolean
}

/** The only client frame a pairing socket may send before the Host approves. */
export interface PairingProofFrame {
  type: 'pairing-proof'
  /** MUST match {@link PAIRING_NONCE}. */
  clientNonce: string
  /** REQUIRED when the challenge had `otpRequired: true`, and MUST be absent otherwise. */
  otpProof?: string
}

/** Proof accepted; the request now waits for the Host user's approval (5-minute window). */
export interface PairingPendingFrame {
  kind: 'pairing-pending'
  /** Short human code, shown on the Host too; the user compares them. */
  verificationCode: string
  requestId: string
  /** Epoch milliseconds when the pending request expires. */
  expiresAt: number
}

/** Sent just before the socket closes, with one of the pairing close codes. */
export interface PairingRejectedFrame {
  kind: 'pairing-rejected'
  /** e.g. `pairing/timeout`, `pairing/expired`, `pairing/refused`, `pairing/bad-nonce`. */
  reason: string
}

export type PairingCloseCode = 4403 | 4408 | 4410

export type ContractErrorCode =
  | 'auth/required'
  | 'auth/revoked'
  | 'auth/forbidden-scope'
  | 'remote/disabled'
  | 'op/forbidden'
  | 'pairing/expired'
  | 'protocol/unsupported'
  | 'bad-request'
  | 'session-not-found'
  /**
   * Spec 021 (revision 14): a `web:unlock` device that has not passed a passkey assertion on
   * this socket. `reason` is `WebLockReason`.
   */
  | 'auth/locked'
  /** Spec 021: the passkey frames' refusals (in band, no detail beyond the code). */
  | 'passkey/not-registered'
  | 'passkey/already-registered'
  | 'passkey/challenge-expired'
  | 'passkey/verification-failed'
  | 'passkey/rate-limited'

export type PassthroughErrorCode = 'agent-busy' | 'internal'

export const ERROR_CODES: Readonly<Record<ContractErrorCode, number | null>>
export const PASSTHROUGH_ERROR_CODES: readonly PassthroughErrorCode[]

export type ClientApprovalOutcome = 'allowed-once' | 'rejected'
export type FinalApprovalOutcome = 'allowed-once' | 'rejected' | 'cancelled' | 'unavailable'
export type ReceiptReason = 'not-pending' | 'hash-mismatch'

export const APPROVAL_OUTCOMES_CLIENT: readonly ClientApprovalOutcome[]
export const APPROVAL_OUTCOMES_FINAL: readonly FinalApprovalOutcome[]
export const RECEIPT_REASONS: readonly ReceiptReason[]

export const PING_INTERVAL_MS: 25000

// ---------------------------------------------------------------------------
// Frames and payloads (§2–§5)
// ---------------------------------------------------------------------------

export interface DeviceInfo {
  id: string
  name: string
  createdAt?: number | string
  /** Absent on a gateway that predates scopes (revision 2). */
  kind?: DeviceKind
  /** Absent on a gateway that predates scopes; then every type is allowed. */
  scopes?: Scope[]
}

export interface PairingPayload {
  version: 3
  publicUrl: string
  pairingCode: string
  expiresAt: number
  certSha256: string
  gatewayId: string
  gatewayName: string
  endpoints: string[]
}

export interface ClientHelloFrame {
  type: 'client-hello'
  requestId: string
  companionProtocol: number
  appVersion: string
  platform: 'ios' | 'android'
  /**
   * Spec 016 Phase 3 (revision 10): optional capabilities this client offers. Only
   * `browser-agent:1` is read today — it says the client can answer `browser-command`.
   * Absent/unknown values are ignored, so an older client keeps working unchanged.
   */
  capabilities?: string[]
}

export interface PingFrame {
  type: 'ping'
  requestId: string
}

export interface SessionsRequestFrame {
  type: 'sessions'
  requestId: string
}

export interface SearchRequestFrame {
  type: 'search'
  requestId: string
  query: string
}

export interface HistoryRequestFrame {
  type: 'history'
  requestId: string
  sessionId: string
  beforeSeq?: number
  maxMessages?: number
  maxBytes?: number
}

export interface SubscribeFrame {
  type: 'subscribe'
  requestId: string
  sessionId: string
}

export interface UnsubscribeFrame {
  type: 'unsubscribe'
  requestId: string
}

export interface MessageFrame {
  type: 'message'
  requestId: string
  sessionId: string
  text: string
  clientMsgId: string
  mode?: 'queue' | 'steer'
}

export interface SessionCancelFrame {
  type: 'session-cancel'
  requestId: string
  sessionId: string
}

export interface ApprovalResponseFrame {
  type: 'approval-response'
  requestId: string
  rpcId: string
  sessionId: string
  approvalId: string
  argsHash: string
  outcome: ClientApprovalOutcome
}

export interface DeviceInfoRequestFrame {
  type: 'device-info'
  requestId: string
}

export interface DeviceForgetFrame {
  type: 'device-forget'
  requestId: string
}

export interface PushRegisterFrame {
  type: 'push-register'
  requestId: string
  platform: 'apns' | 'fcm'
  token: string
}

export interface PushRemoveFrame {
  type: 'push-remove'
  requestId: string
}

export type ClientFrame =
  | ClientHelloFrame
  | PingFrame
  | SessionsRequestFrame
  | SearchRequestFrame
  | HistoryRequestFrame
  | SubscribeFrame
  | UnsubscribeFrame
  | MessageFrame
  | SessionCancelFrame
  | ApprovalResponseFrame
  | DeviceInfoRequestFrame
  | DeviceForgetFrame
  | PushRegisterFrame
  | PushRemoveFrame

/** Every request carries a `type` from OPS and a `requestId`. */
export interface ClientRequestFrameBase {
  type: Op
  requestId: string
}

export interface HelloFrame {
  kind: 'hello'
  protocol: number
  companionProtocol: number
  minClientVersion: number
  capabilities: string[]
  authenticated: boolean
  device: DeviceInfo
  gatewayId: string
  dshVersion?: string
  certSha256?: string
  /** Spec 021: present only for a device holding `web:unlock`; see `WebLockState`. */
  webLock?: WebLockState
}

export interface PairedFrame {
  kind: 'paired'
  token: string
  device: DeviceInfo
}

export interface ErrorFrame {
  kind: 'error'
  code: string
  requestType?: string
  requestId?: string
  message?: string
  minClientVersion?: number
}

export interface ApprovalRequestedFrame {
  kind: 'approval-requested'
  rpcId: string
  sessionId: string
  approvalId: string
  toolName: string
  callId?: string
  reason?: string
  displayReason?: Record<string, string>
  argsHash: string | null
  /**
   * Always a string on the wire from a revision 2.1 gateway (contract §5a); optional here
   * because a pre-2.1 host may omit it and the client parser accepts that frame.
   */
  argsPreview?: string
  replay?: boolean
}

export interface ApprovalResponseReceipt {
  kind: 'approval-response'
  requestId: string
  rpcId: string
  sessionId: string
  approvalId: string
  outcome: ClientApprovalOutcome
  accepted: true
}

export interface ApprovalResponseRejected {
  kind: 'approval-response'
  requestId: string
  rpcId: string
  sessionId: string
  approvalId: string
  outcome: ClientApprovalOutcome
  accepted: false
  reason: ReceiptReason
}

export type ApprovalResponseAnswer = ApprovalResponseReceipt | ApprovalResponseRejected

export interface ApprovalResolvedFrame {
  kind: 'approval-resolved'
  rpcId: string
  sessionId: string
  approvalId: string
  outcome: FinalApprovalOutcome
}

export interface SentFrame {
  kind: 'sent'
  requestId: string
  sessionId: string
  clientMsgId: string
}

export interface SessionCancelledFrame {
  kind: 'session-cancelled'
  requestId: string
  accepted: boolean
}

/**
 * One session row from `sessions`/`search` (upstream list projection, contract rev 2.1 §5a).
 * Canonical rows carry `sessionId`, epoch-ms `updatedAt`, `running`, and the title in
 * `projections.values.title`; the client derives running/idle/archived from `running`.
 */
export interface SessionRow {
  /** Canonical upstream session id (contract rev 2.1 §5a). */
  sessionId: string
  /**
   * @deprecated Pre-rev2.1 gateways and old fixtures used `id`. Kept optional only as a
   * documented compatibility fallback; the store uses it when `sessionId` is absent.
   */
  id?: string
  /** Epoch milliseconds (contract §5a); epoch seconds are tolerated for legacy hosts. */
  updatedAt?: number | string
  /** True while the session runs; false/absent means idle (contract §5a). */
  running?: boolean
  /** @deprecated Not an upstream field; pre-rev2.1 fixtures only. */
  state?: 'running' | 'idle' | 'archived'
  projections?: { values?: { title?: string }; [key: string]: unknown }
  needsDecision?: boolean
  [key: string]: unknown
}

export interface SessionsFrame {
  kind: 'sessions'
  requestId: string
  items: SessionRow[]
}

export interface SearchFrame {
  kind: 'search'
  requestId: string
  items: SessionRow[]
}

export interface HistoryMessage {
  seq?: number
  id?: string
  role?: string
  text?: string
  [key: string]: unknown
}

export interface HistoryFrame {
  kind: 'history'
  requestId: string
  sessionId?: string
  items?: HistoryMessage[]
  messages?: HistoryMessage[]
  hasMore?: boolean
  [key: string]: unknown
}

export interface EventFrame {
  kind: 'event'
  sessionId?: string
  event?: unknown
  [key: string]: unknown
}
