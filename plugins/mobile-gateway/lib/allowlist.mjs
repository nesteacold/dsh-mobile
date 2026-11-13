// Operation allowlists (T022 / R4, US3).
//
// A companion device token authenticates a *phone*, and a phone may only do the
// companion's job: read sessions, read history, send a prompt, cancel a turn,
// answer an approval, manage its own device. Everything the upstream gateway
// exposed to any paired device — plugin management, settings, permission
// presets, schedules, workspace mutations, file upload/download, speech —
// is refused before it can touch the Host; session create/rename/archive are
// lifted per device by `sessions:author` below.
//
// Two lists exist:
//  - COMPANION_V1_TYPES: the contract §4 operations, served for device-token
//    (non-admin) callers on the companion channel.
//  - ADMIN_ONLY_TYPES: every other request `type` the router/host adapter still
//    implements for the legacy loopback admin client. Keeping the list explicit
//    makes `test/allowlist.test.mjs` able to enumerate it.
//
// `./vendor/mobile-protocol.mjs` is the GENERATED copy of the contract's source
// of truth (`packages/mobile-protocol/src/index.mjs`); a bare package specifier
// would not resolve in an installed tarball. Regenerate with
// `node scripts/sync-mobile-protocol.mjs`; `COMPANION_PROTOCOL_VERSION` is
// defined locally until it lands there.
import * as contract from './vendor/mobile-protocol.mjs'

/** Spec 018 item 3: the scope that lifts the read-only schedule endpoints. */
const SCHEDULE_READ_SCOPE = contract.SCHEDULE_READ_SCOPE ?? 'schedule:read'

/** Companion wire-protocol revision (contract §3.5/§3.6). TODO use @dsh-ext/mobile-protocol */
export const COMPANION_PROTOCOL_VERSION = contract.COMPANION_PROTOCOL_VERSION ?? 1

/** Oldest companion client version a Host accepts. TODO use @dsh-ext/mobile-protocol */
export const MIN_CLIENT_VERSION = contract.MIN_CLIENT_VERSION ?? 1

/** WebSocket close code for a revoked credential (contract §3, §6). */
export const CLOSE_REVOKED = contract.CLOSE_CODES?.revoked ?? 4401
/** Spec 020: a web:unlock device locked by the Host account. NOT 4401 (that wipes the credential). */
export const CLOSE_LOCKED = contract.CLOSE_CODES?.locked ?? 4412

/** Error code for a request outside the allowlist (contract §4, §6). */
export const OP_FORBIDDEN = 'op/forbidden'

/** Error code for an unsupported companion protocol revision (contract §3.6, §6). */
export const PROTOCOL_UNSUPPORTED = 'protocol/unsupported'

/** Local fallback of the contract §4 operation list, used only if the package omits it. */
const FALLBACK_COMPANION_V1_TYPES = Object.freeze([
  'client-hello', 'ping', 'sessions', 'search', 'history', 'subscribe', 'unsubscribe', 'message',
  'session-cancel', 'approval-response', 'device-info', 'device-forget', 'push-register', 'push-remove',
])

/**
 * Contract §4 operations, in contract order. The op identity is the client
 * frame's `type`; anything outside this set is `op/forbidden`.
 * TODO use @dsh-ext/mobile-protocol for the whole list (package OPS)
 */
export const COMPANION_V1_TYPES = new Set(
  Array.isArray(contract.OPS) && contract.OPS.length > 0 ? contract.OPS : FALLBACK_COMPANION_V1_TYPES,
)

/** Capabilities advertised on the companion channel: exactly the package CAPABILITIES (contract §3.5). */
export const COMPANION_CAPABILITIES = Object.freeze(
  Array.isArray(contract.CAPABILITIES) && contract.CAPABILITIES.length > 0
    ? [...contract.CAPABILITIES]
    : ['sessions-read', 'prompt', 'cancel', 'approval-v1'],
)

/**
 * Host operations that need the owner and are never served to a device token,
 * even if a future contract version added the operation to the wire vocabulary:
 * plugin management, settings, permission presets, defaults, filesystem and
 * workspace mutations, commands, schedules, goals, session creation/forking/
 * renaming/queue control, speech and the file transfer surface. (Session
 * create/rename/archive leave this set through `sessions:author`, never by
 * being deleted from it — see COMPANION_AUTHOR_DENIED_ENDPOINTS.)
 * The vocabulary is the union of the upstream `PLUGIN_REQUEST_TYPES`,
 * `SCHEDULE_REQUEST_TYPES`, `SPEECH_REQUEST_TYPES`, `FILE_UPLOAD_REQUEST_TYPES`
 * and the router's own `type` table, so the list stays in step with the router.
 */
export const ADMIN_ONLY_TYPES = new Set([
  // plugin management (upstream PLUGIN_REQUEST_TYPES, 17 operations)
  'plugin-catalog', 'plugin-registries', 'plugin-versions', 'plugin-detail', 'plugin-update',
  'plugin-inspect', 'plugin-install', 'plugin-install-status', 'plugin-install-cancel',
  'plugin-bundle-set-enabled', 'plugin-entry-set-enabled', 'plugin-remove',
  'plugin-settings', 'plugin-settings-mutate', 'plugin-version-exemptions',
  'plugin-version-exemption-set',
  // settings / defaults / permission presets
  'settings', 'settings-describe', 'settings-update', 'settings-mutate',
  'permission', 'permission-options',
  'set-default', 'default-model', 'save-default-model', 'defaults',
  'agent-presets', 'select-agent-preset', 'session-agent-preset',
  // filesystem + workspace mutations and file transfer
  'directories', 'directory-create', 'workspace-create', 'workspaces',
  'file-list', 'file-resolve', 'file-download-open', 'file-download-read', 'file-download-cancel',
  'file-upload-open', 'file-upload-chunk', 'file-upload-finish', 'file-upload-cancel',
  // commands and speech (upstream SPEECH_REQUEST_TYPES)
  'commands', 'command-execute', 'command-options', 'command-select',
  'speech-catalog', 'speech-subscribe', 'speech-unsubscribe', 'speech-configure',
  'speech-prepare', 'speech-cancel-preparation', 'speech-transcribe', 'speech-cancel',
  // sessions beyond the companion surface
  'session-create', 'session-archive', 'session-rename', 'fork', 'queue-update', 'attachment',
  'subagents', 'agent-team',
  // schedules (upstream SCHEDULE_REQUEST_TYPES), goals, models, host introspection
  'schedule-catalog', 'schedule-list', 'schedule-view', 'schedule-history',
  'schedule-create', 'schedule-edit', 'schedule-run', 'schedule-delete-inactive',
  'schedule-update', 'schedule-delete',
  'goal', 'goal-edit', 'goal-pause', 'goal-resume', 'goal-clear',
  'models', 'select-model', 'providers', 'host', 'context-usage', 'session-stats', 'tasks',
  // Spec 019 Wave 3: the two permission frames. They stay OUTSIDE the companion
  // surface (nothing here is served without a scope) and reach a device only through
  // the `permission:lower` gate, which is never a default.
  'permission-options', 'permission-lower',
  // interactions the companion answers through `approval-response` only
  'question-answer', 'question-cancel',
])

/**
 * Operations that mutate Host state and are additionally refused in
 * `lib/dsh-host-adapter.mjs` when the adapter belongs to a device token. The
 * router allowlist already refuses them; this list is the second, independent
 * layer so a router regression cannot reach a mutating endpoint.
 */
export const COMPANION_DENIED_HOST_ENDPOINTS = Object.freeze([
  'pluginInventory/*', 'pluginManager/*',
  'settings/*',
  'permissions/*', 'permissionPresets/*',
  'workspace/create', 'workspace/archiveSession', 'workspace/rename',
  'schedule/*', 'goals/*', 'agentPresets/select',
  'session/create', 'session/fork', 'session/rename', 'session/updateQueue',
  'session/selectModel', 'commands/execute',
  'session/attachment', 'session/canOpenWorkspacePath',
  'speech/*',
])

/** Scope that lifts the authoring exemptions below (spec 011). */
export const AUTHOR_SCOPE = contract.AUTHORING_SCOPE

/**
 * Spec 011 FR-008: `session/create` and `session/selectModel` stay in the denied
 * list above, but a device token that actually holds `sessions:author` may now
 * reach them. The denial is lifted by PERMISSION, never by deleting the entry,
 * so a device without the scope is denied here exactly as before — and a router
 * regression that skipped the scope gate still could not reach a create/model
 * write. Revision 11 adds the same lift for ONE session's rename and archive
 * (`session/rename`, `workspace/archiveSession`): their session-resource leg in
 * `companion-access.mjs` is what keeps a device to sessions it can see.
 * `workspace/create`, `workspace/rename`, the plugin/schedule/settings families
 * and everything else stay denied for every device, whatever it holds.
 */
export const COMPANION_AUTHOR_DENIED_ENDPOINTS = Object.freeze([
  'session/create', 'session/selectModel',
  // Revision 11 (session rename/archive).
  'session/rename', 'workspace/archiveSession',
])

/**
 * Spec 018 item 3 (revision 12): `schedule/*` stays in the denied list above, but the three
 * READ-ONLY endpoints are lifted for a device that holds `schedule:read`.
 *
 * Same shape as the spec 011 author lift, and for the same reason: the entry is never deleted, so a
 * device without the scope is denied here exactly as before, and a router regression that skipped
 * the scope gate still could not reach a schedule MUTATION — those are not in this list.
 */
export const COMPANION_SCHEDULE_READ_DENIED_ENDPOINTS = Object.freeze([
  'schedule/catalog', 'schedule/list', 'schedule/view',
])

/** Whether `scopes` grants the spec 018 schedule read scope (a malformed list grants nothing). */
export function holdsScheduleReadScope(scopes) {
  return typeof SCHEDULE_READ_SCOPE === 'string' && Array.isArray(scopes) && scopes.includes(SCHEDULE_READ_SCOPE)
}

/**
 * Spec 011: the authoring message types (revision 7) plus revision 11's session
 * rename/archive. They remain in `ADMIN_ONLY_TYPES` (the enumeration of everything
 * outside the companion surface, kept intact so a new router type cannot slip in
 * unclassified) — the router now serves them to a device that holds
 * `sessions:author`, and refuses them by scope to any other.
 */
export const SESSIONS_AUTHOR_TYPES = Object.freeze(
  Array.isArray(contract.AUTHORING_CLIENT_TYPES) ? [...contract.AUTHORING_CLIENT_TYPES] : [],
)

/** Whether `scopes` grants the spec 011 author scope (a malformed list grants nothing). */
export function holdsAuthorScope(scopes) {
  if (typeof AUTHOR_SCOPE !== 'string') return false
  return Array.isArray(scopes) && scopes.includes(AUTHOR_SCOPE)
}

/**
 * Spec 018 (revision 10): the read-only session-metric types, served only to a
 * device that holds `stats:read`. Like the authoring types they stay in
 * `ADMIN_ONLY_TYPES` (that list enumerates everything OUTSIDE the companion
 * surface; deleting an entry would hide it from the enumeration the allowlist test
 * walks), and they reach a device through the same scope gate as every other type.
 * They only read the session's own projections, so the per-item rule is the ordinary
 * "this device may see this session".
 */
export const STATS_READ_TYPES = Object.freeze(
  Array.isArray(contract.STATS_READ_CLIENT_TYPES) ? [...contract.STATS_READ_CLIENT_TYPES] : ['session-stats', 'context-usage'],
)

/** Whether `scopes` grants the spec 018 metric scope (a malformed list grants nothing). */
export function holdsStatsReadScope(scopes) {
  const scope = contract.STATS_READ_SCOPE
  if (typeof scope !== 'string') return false
  return Array.isArray(scopes) && scopes.includes(scope)
}

/** Path prefixes of the shared Fetch channel a device token may never use (file upload). */
export const COMPANION_DENIED_FETCH_PREFIXES = Object.freeze(['/api/session/upload'])

function matchesEndpoint(pattern, namespace, method) {
  const [patternNamespace, patternMethod] = pattern.split('/')
  const namespaceMatches = patternNamespace === '*' || patternNamespace === namespace
  const methodMatches = patternMethod === '*' || patternMethod === method
  return namespaceMatches && methodMatches
}

/**
 * Whether a device-token caller may invoke this Host Remote endpoint.
 *
 * `scopes` is the calling device's live scope list. It only matters for the
 * endpoints in {@link COMPANION_AUTHOR_DENIED_ENDPOINTS}: a device holding
 * `sessions:author` reaches them, every other caller is denied. Omitted scopes
 * grant nothing beyond the plain denied list (fail closed).
 */
export function hostEndpointAllowedForCompanion(namespace, method, scopes) {
  const denied = COMPANION_DENIED_HOST_ENDPOINTS.find((pattern) => matchesEndpoint(pattern, namespace, method))
  if (denied === undefined) return true
  const endpoint = `${namespace}/${method}`
  if (COMPANION_AUTHOR_DENIED_ENDPOINTS.includes(endpoint)) return holdsAuthorScope(scopes)
  if (COMPANION_SCHEDULE_READ_DENIED_ENDPOINTS.includes(endpoint)) return holdsScheduleReadScope(scopes)
  return false
}

/** Whether a device-token caller may use this shared Fetch path (file upload). */
export function fetchPathAllowedForCompanion(pathname) {
  return !COMPANION_DENIED_FETCH_PREFIXES.some((prefix) => String(pathname).startsWith(prefix))
}

/** Whether a request `type` is part of the companion vocabulary. */
export function isCompanionType(type) {
  return typeof type === 'string' && COMPANION_V1_TYPES.has(type)
}

/** Whether a request `type` is a spec 008 remote-bridge frame (not a companion-v1 op). */
export function isRemoteBridgeType(type) {
  return typeof type === 'string' && Array.isArray(contract.REMOTE_CLIENT_TYPES)
    && contract.REMOTE_CLIENT_TYPES.includes(type)
}

/** Whether a request `type` is a spec 011 authoring op (not a companion-v1 op either). */
export function isSessionsAuthorType(type) {
  return typeof type === 'string' && SESSIONS_AUTHOR_TYPES.includes(type)
}

/**
 * Whether a request `type` is a spec 013 attachment-upload frame. Like the
 * remote-bridge frames, they are outside the §4 vocabulary but ARE scoped
 * (`attachments:write`) and must reach the scope gate.
 */
export function isRemoteUploadType(type) {
  return typeof type === 'string' && Array.isArray(contract.REMOTE_UPLOAD_CLIENT_TYPES)
    && contract.REMOTE_UPLOAD_CLIENT_TYPES.includes(type)
}

/**
 * Spec 021: the PWA's own re-lock frame (contract §14.2). Re-exported from the contract
 * (`packages/mobile-protocol` `PASSKEY_LOCK_TYPE`); not one of the four ceremony frames.
 */
export const PASSKEY_LOCK_TYPE = contract.PASSKEY_LOCK_TYPE

/**
 * Whether `type` is one of the spec 021 web passkey frames (scoped by `web:unlock`).
 *
 * `passkey-lock` belongs to the family: it needs the same scope, it is allowed on a locked
 * socket (giving up a secret never needs a proof), and it is never a §4 op.
 */
export function isPasskeyType(type) {
  if (typeof type !== 'string') return false
  if (type === PASSKEY_LOCK_TYPE) return true
  return Array.isArray(contract.PASSKEY_CLIENT_TYPES) && contract.PASSKEY_CLIENT_TYPES.includes(type)
}

/** The scope that gates the passkey frames and arms the server-side lock. */
export const WEB_UNLOCK_SCOPE = typeof contract.WEB_UNLOCK_SCOPE === 'string'
  ? contract.WEB_UNLOCK_SCOPE
  : 'web:unlock'

/** Whether scopes grants the web-unlock scope (a malformed list grants nothing). */
export function holdsWebUnlockScope(scopes) {
  return Array.isArray(scopes) && scopes.includes(WEB_UNLOCK_SCOPE)
}

export function isStatsReadType(type) {
  return typeof type === 'string' && STATS_READ_TYPES.includes(type)
}

/**
 * Spec 018 item 2 (revision 11, plan A): the read-on-demand agent-team and subagent-catalog types.
 *
 * They get NO scope of their own. The same projections already travel to every `sessions:read`
 * device in `projection-baseline` and in the `agent-team-updated` / `subagents-updated` frames
 * (measured 2026-11-11: 31/52 sessions carried `agentTeam`), so a dedicated scope would widen the
 * pairing matrix without widening what a device can see — and gating the baseline on it would break
 * the clients already running. Their entry in `ADMIN_ONLY_TYPES` stays: that list enumerates
 * everything OUTSIDE the companion surface, and deleting an entry would hide it from the
 * enumeration the allowlist test walks. They reach a device only through the scope gate, which
 * answers `auth/forbidden-scope` with the ordinary session read scope.
 */
export const TEAM_READ_TYPES = Object.freeze(
  Array.isArray(contract.TEAM_READ_CLIENT_TYPES) ? [...contract.TEAM_READ_CLIENT_TYPES] : ['agent-team', 'subagents'],
)

/** Whether `type` is one of the spec 018 team read-on-demand frames. */
export function isTeamReadType(type) {
  return typeof type === 'string' && TEAM_READ_TYPES.includes(type)
}

/**
 * Spec 018 item 3 (revision 12): the READ-ONLY schedule frames, lifted by the explicit-only
 * `schedule:read` scope.
 *
 * Unlike the team frames, this is real new visibility: measured 2026-11-11, NO schedule data
 * travels in `projection-baseline` or in any broadcast (the baseline carries goal, todos,
 * turnOutline, agentTeam, subagentCatalog, subagent, subagentTiming — nothing about schedules).
 * That is why it gets its own never-default scope instead of riding `sessions:read`.
 *
 * Entries stay in `ADMIN_ONLY_TYPES`: that list enumerates everything outside the companion
 * surface, and these reach a device only through the scope gate.
 */
export const SCHEDULE_READ_TYPES = Object.freeze(
  Array.isArray(contract.SCHEDULE_READ_CLIENT_TYPES) ? [...contract.SCHEDULE_READ_CLIENT_TYPES] : ['schedule-catalog', 'schedule-list', 'schedule-view'],
)

/** Whether `type` is one of the spec 018 read-only schedule frames. */
export function isScheduleReadType(type) {
  return typeof type === 'string' && SCHEDULE_READ_TYPES.includes(type)
}

/**
 * Spec 018 item 4 (revision 13): the two question frames, lifted by the EXISTING
 * `approval:respond` scope.
 *
 * Answering a question is the same interaction as an approval card, so it does not get a scope of
 * its own. They are served only to a device that holds `approval:respond` AND may see the asking
 * session — the per-session check lives in the router (`respondToQuestion`), because the Host
 * promise behind a question is resolved inside the gateway and no Host per-item check covers it.
 */
export const QUESTION_RESPONSE_TYPES = Object.freeze(
  Array.isArray(contract.QUESTION_RESPONSE_TYPES) ? [...contract.QUESTION_RESPONSE_TYPES] : ['question-answer', 'question-cancel'],
)

/** Whether `type` is one of the spec 018 question frames. */
export function isQuestionResponseType(type) {
  return typeof type === 'string' && QUESTION_RESPONSE_TYPES.includes(type)
}

/**
 * Spec 019 Wave 3 (permission control): `permission-options` (read the presets) and
 * `permission-lower` (switch ONE session to a strictly stricter preset). Like the
 * authoring and metric types they are NOT contract §4 ops, they stay in
 * `ADMIN_ONLY_TYPES` (that list enumerates everything OUTSIDE the companion surface),
 * and they reach a device only through the scope gate — `permission:lower`, which is
 * never a default.
 */
export const PERMISSION_LOWER_TYPES = Object.freeze(
  Array.isArray(contract.PERMISSION_LOWER_CLIENT_TYPES) ? [...contract.PERMISSION_LOWER_CLIENT_TYPES] : ['permission-options', 'permission-lower'],
)

/** The scope that lifts the spec 019 frames; explicit-only, never a default. */
export const PERMISSION_LOWER_SCOPE = typeof contract.PERMISSION_LOWER_SCOPE === 'string'
  ? contract.PERMISSION_LOWER_SCOPE
  : 'permission:lower'

/** Whether `type` is one of the spec 019 permission frames. */
export function isPermissionLowerType(type) {
  return typeof type === 'string' && PERMISSION_LOWER_TYPES.includes(type)
}

/**
 * Spec 005 FR2: scopes a device's own credential management cannot be gated on.
 * `device-forget` revokes the calling device (contract §4) — a leaked token must
 * always be able to remove itself, so it is never refused *by scope*.
 */
export const SCOPE_EXEMPT_TYPES = new Set(['device-forget'])

/**
 * The refusal a scoped device gets for `type`, or `undefined` when its scopes
 * allow the request. A `companion-v1` type with no entry in `SCOPE_BY_TYPE` is
 * refused (fail closed), so an operation added to the wire vocabulary later
 * stays closed until it is given a scope on purpose; a type outside that
 * vocabulary is already refused by the allowlist (`op/forbidden`).
 *
 * A device without a live scope list (no record, or a record whose `scopes` is
 * not an array) has no grant at all: it is refused rather than treated as
 * unrestricted. `devices.js` normalizes every stored record at load, so this
 * only catches a caller whose record vanished or was never there.
 * @param {{ scopes?: string[] }|undefined} device
 * @param {string} type
 */
export function scopeDenial(device, type) {
  return scopeDenialAgainst(contract.SCOPE_BY_TYPE, device, type)
}

/**
 * The gate itself, parameterised by the scope map.
 *
 * Exported for the closure test (reviewer, spec 018 item 1): the pre-fix defect only
 * shows for a mapped type whose FAMILY nobody had added, and no such type exists in
 * today's contract — so the test supplies a synthetic map with one to prove the
 * decision follows the map rather than a hand-maintained family list. Production
 * callers use {@link scopeDenial}, which passes the contract's own frozen map.
 *
 * @param {Record<string, string>} scopeByType typed request type → required scope
 * @param {{ scopes?: string[] }|undefined} device
 * @param {string} type
 */
export function scopeDenialAgainst(scopeByType, device, type) {
  if (SCOPE_EXEMPT_TYPES.has(type)) return undefined
  // Reviewer fix (spec 018, item 1): the contract map is the PRIMARY authority. Any
  // type the map names is scoped, whatever family it belongs to — deciding this from a
  // hand-maintained family list is what let a newly added, mapped type fall through as
  // `undefined` (served) simply because nobody had added its family yet.
  //
  // Spec 008: the remote-bridge frames are outside `OPS` but mapped to `harness:remote`.
  // Spec 011: the four authoring types are mapped to `sessions:author`. Spec 013 adds the
  // four `remote-upload-*` frames (`attachments:write`). Spec 018 adds the two read-only
  // metric frames (`stats:read`), spec 019 the two permission frames (`permission:lower`).
  // All of them must reach the decision below so a device lacking the scope is refused
  // here (fail closed), never `undefined` (serve).
  const mapped = typeof type === 'string' && Object.hasOwn(scopeByType, type)
  if (!mapped && !isCompanionType(type) && !isRemoteBridgeType(type) && !isSessionsAuthorType(type)
    && !isRemoteUploadType(type) && !isStatsReadType(type) && !isTeamReadType(type) && !isScheduleReadType(type)
    && !isQuestionResponseType(type) && !isPasskeyType(type) && !isPermissionLowerType(type)) return undefined
  const scopes = Array.isArray(device?.scopes) ? device.scopes : []
  // Spec 021: `passkey-lock` is the one passkey frame the contract does not map, because
  // `packages/mobile-protocol` names only the four ceremony frames. It still needs the SAME scope
  // as the rest of its family (`web:unlock`) — a device that may not unlock may not lock either,
  // and the literal is not in `SCOPE_BY_TYPE` to say so by itself.
  const scope = mapped ? scopeByType[type] : (type === PASSKEY_LOCK_TYPE ? WEB_UNLOCK_SCOPE : undefined)
  if (scope && scopes.includes(scope)) return undefined
  return {
    kind: 'error',
    code: 'auth/forbidden-scope',
    requestType: type,
    ...(scope ? { scope } : {}),
    message: scope ? `this device was not paired with ${scope}` : `${type} is not covered by any scope`,
  }
}

/**
 * Whether a request `type` is universally refused for a device token: the
 * companion allowlist is the positive set, this the explicit negative one.
 */
export function isAdminOnlyType(type) {
  return ADMIN_ONLY_TYPES.has(type)
}

/** The guard an adapter created for a device token enforces. */
export const COMPANION_DEVICE_GUARD = Object.freeze({
  hostEndpoint: hostEndpointAllowedForCompanion,
  fetchPath: fetchPathAllowedForCompanion,
})

/**
 * T022a: the guard of an adapter bound to a per-device NON-OWNER Peer. Both
 * layers must pass: the denied-list above AND the positive list of
 * `companion-access.mjs` (`hostEndpointAllowedForDevice`, passed in so this
 * file keeps no dependency on it). Fetch is refused outright: DSH's shared
 * Fetch handler already answers 403 to every non-owner Peer, and the device
 * adapter has no reason to open an HTTP upload, so there is no allowed path.
 *
 * Spec 011: `getScopes()` supplies the calling device's LIVE scope list, so the
 * denied-list half can lift `session/create` and `session/selectModel` for a
 * device that actually holds `sessions:author` — and for no one else. A missing,
 * throwing or malformed source grants no exemption (fail closed). Called on
 * every endpoint, so it must stay synchronous and cheap; the caller reads an
 * in-memory device record, never the Host.
 * @param {(namespace: string, method: string) => boolean} positiveHostEndpoint
 * @param {() => unknown} [getScopes]
 */
export function createPositiveDeviceGuard(positiveHostEndpoint, getScopes = () => undefined) {
  if (typeof positiveHostEndpoint !== 'function') throw new TypeError('createPositiveDeviceGuard requires a positive endpoint predicate')
  if (typeof getScopes !== 'function') throw new TypeError('createPositiveDeviceGuard requires a scopes function when one is given')
  return Object.freeze({
    hostEndpoint: (namespace, method) => {
      let scopes
      try { scopes = getScopes() } catch { return false }
      return hostEndpointAllowedForCompanion(namespace, method, scopes)
        && positiveHostEndpoint(namespace, method) === true
    },
    fetchPath: () => false,
  })
}
