// Multi-host routing for the CONTROLLER machine (spec 008 P2a).
//
// One DSH Desktop UI owns exactly one `typertGateway` instance, and the official
// client attaches no session context to a call. Remote hosts therefore become
// addressable by tagging every routable id with its host: `h:<hostId>:<id>`.
// This module is the only place that knows the tag:
//
//  - a call whose payload carries a tagged id travels to that remote
//    (`remote-call` / `remote-stream-open` over the pinned WSS connection of
//    lib/remote-client.mjs) and its result comes back renamed;
//  - a call with no tagged id stays Local, unless the client passed the host hint
//    `__dshHost` (needed for global endpoints such as llm/*, which have no id);
//  - `session/list`, `workspace/follow` and `session/modelCatalog` are merged:
//    Local plus every connected remote, so the native sidebar shows one list and
//    the native model picker one catalog (see `#mergeModelCatalog`). A merged
//    remote Workspace carries its host in the title (`REA_Project · Sigma-DSH`),
//    and that suffix is taken off again before a title travels back.
//  - a PROVIDER is the second name that must not cross hosts, because it selects
//    which Host runs the model. The picker compares a session's projected
//    `provider` against the catalog's group ids and hands the matched id back to
//    `session/selectModel`, so a remote provider is named `<provider>@<hostId>`
//    everywhere the UI sees it (merged catalog group id, projected selection) and
//    the tag is taken off before the call reaches that Host. The picker needs no
//    new surface for this: it renders one section per group, so Local and each
//    remote Host become their own section (see `#labelledGroups`).
//
// The invariants are the interesting part, not the routing:
//  - a namespaced id never leaves this machine (`#assertNoNamespace`, asserted on
//    the transport stubs by the tests);
//  - a raw id from a remote never reaches the local UI (every field in ID_FIELDS
//    is rewritten on the way back, recursively, including `$events` payloads);
//  - an id that comes FROM a remote is opaque: it is wrapped in that host's
//    namespace unconditionally, and a payload whose id already carries a namespace
//    tag is refused with `remote/id-leak`. Without that, a compromised Host B could
//    send `h:A:<id>` and have its row or card land in host A's namespace, where
//    every later decision would route to the wrong Host. The tag is minted here and
//    nowhere else;
//  - a remote approval decision always carries the `argsHash` of the card the
//    Host issued, because the bridge refuses an unbound decision.
//
// Two slices ride on top of the routing (spec 008 P2c):
//  - interaction cards: the remote Host pushes its approval/question cards to a
//    connected device (they are the only frames that carry `rpcId`, `approvalId`
//    and `argsHash`). They are rebuilt as the native `$events` waterfall frames
//    the controller's own UI answers, with every id namespaced, so the native
//    approval/question card appears inside a remote conversation. The answer
//    travels back to the Host that issued the card with its original ids: an
//    approval through the bridge's hash-bound `$events/result`, an ACTIVE question
//    through the `question-answer` companion frame to the gateway that owns its
//    pending card. Only a CONTINUED late answer falls back to `userQuestions/answer`;
//    that service finds no open question (dsh-user-questions/src/index.ts:170-173).
//  - offline transcript cache: every frame of a remote `session/follow` is
//    appended to `deps.cache` (lib/session-cache.mjs) and replayed read-only
//    when that host is offline, so a conversation survives a dead Host.
//
// Adapted from liguobao/ds-harness-remote (MIT): packages/plugin/src/
// typert-gateway-switch.ts (install/restore, commands-free self-test, rc.1
// local-open arity probe) and owner-peer.ts (the local carrier needs the caller's
// Peer). See NOTICE-ds-harness-remote in this folder.

/** Prefix that marks an id as belonging to a remote host. */
export const HOST_PREFIX = 'h:'
/** Payload field the client uses to name a host for a call that carries no id. */
export const HOST_HINT = '__dshHost'

/**
 * Separator between a remote Workspace's own title and its host name. The native
 * browser renders Local and remote Workspaces as one list, so a remote title says
 * which Host owns it (`REA_Project · Sigma-DSH`). The suffix is display only:
 * `withoutWorkspaceTitle` takes it off again before a title travels back.
 */
const WORKSPACE_HOST_SEPARATOR = ' · '
/**
 * The stored title the native client replaces with the localized default name
 * (`workspaceDisplayTitle` in dsh-client-ui-workspace). Only that EXACT string is
 * translated, so a suffixed one would render verbatim; a remote default Workspace
 * therefore reads as this plain word plus its host. A Host has no client language
 * to localize with, so `Default · <host>` is the honest fallback.
 */
const DEFAULT_WORKSPACE_TITLE = 'default-workspace'
const DEFAULT_WORKSPACE_LABEL = 'Default'

/**
 * The ONE rename table (spec 008 P2a). Keys are field names that occur in the
 * DSH wire payloads; the value says how to rewrite what sits under that key.
 *   `id`      a single id string
 *   `ids`     an array of id strings
 *   `items:id` an array of records whose own `id` field is a session id
 *   `id@<key>` a record whose own `id` field is a session id, but only when the
 *             record also carries `<key>` (used for the `session/follow` opening
 *             frame `{type:'snapshot', header:{version, id}}`, so a payload that
 *             merely happens to call something a `header` is left alone)
 * Anything not listed here is copied structurally and kept verbatim, so an
 * unknown payload field keeps its value (never invent a rename for a field that * might not be an id: `callId`, `attachmentId` … are opaque). `provider` is the one
 * field handled outside this table: it is not an id but it does name a Host, so it
 * is tagged by shape wherever it labels a model selection (see `namespaceIds`).
 */
export const ID_FIELDS = Object.freeze({
  sessionId: 'id',
  workspaceId: 'id',
  agentId: 'id',
  parentSessionId: 'id',
  childSessionId: 'id',
  // `workspaceFiles/*` (`list`, `changes`, `read`, `readBytes`, `stat`) and
  // `officeToPdf/render` name their scope with this field instead of `sessionId`:
  // it is the wire name of their `workspaceFileScope` lookup parameter, and its
  // value IS a SessionId (the Host resolves the workspace root from that session's // header). Without the entry a tagged scope fell through to Local, so a remote
  // session's Workspace files tab listed THIS machine's files.
  workspaceFileScopeId: 'id',
  // Approval/question correlation ids: the card the local UI decides on carries
  // the same id, so tagging it is what lets `$events/result` route to the host
  // that issued it (and keeps two hosts' ids from colliding in one UI).
  // EXCEPTION (`source: 'source'`, see `rewriteIds`): a message's `source` object is
  // walked as a unit so its `rpcId` can be judged by `kind`. On `kind:'user'` that
  // `rpcId` is NOT the Host's id — it is the `requestId` THIS controller minted for
  // the prompt, and the native controller settles the optimistic user bubble by
  // looking that value up (`submissionSettlements.get(source.rpcId)`). Tagging it
  // made every remote prompt render twice: the echo never matched the durable
  // `user/message`. An approval/question card's `rpcId` is namespaced as before.
  source: 'source',
  rpcId: 'id',
  eventId: 'id',
  approvalId: 'id',
  // The ANCHOR of a reorder: the row the moved one lands before
  // (`workspace/insertBefore` → `beforeWorkspaceId`, `workspace/insertSessionBefore` // → `beforeSessionId`). It is an id like any other, and the merged sidebar is what
  // makes that matter: the anchor it hands back belongs to the list the user sees, so
  // for a remote row it is `h:<hostId>:<id>`. Without these two entries the anchor was
  // the one id the table never rewrote, so moving a remote Workspace reached its Host
  // as `{workspaceId:'wb1', beforeWorkspaceId:'h:<hostId>:<wb2>'}` and the registry
  // answered `workspace/not-found` — the drag simply did nothing.
  beforeWorkspaceId: 'id',
  beforeSessionId: 'id',
  // Remote agent-browser handles. A follow-up browser call (`close {tabId}`, a // frame-scoped op …) need not carry a sessionId or `__dshHost`, so `#route`
  // could only send it to the right Host if the handle itself is tagged. Without
  // these entries an untagged `{tabId}` fell through to Local.
  targetId: 'id',
  tabId: 'id',
  frameId: 'id',
  sessionIds: 'ids',
  archivedSessionIds: 'ids',
  pinnedSessionIds: 'ids',
  workspaceIds: 'ids',
  // `projections.values.subagentCatalog` — one record per direct child session.
  subagentCatalog: 'items:id',
  // `session/follow` / `session/events` opening frame. The id is on the record's OWN
  // `id`, guarded by its `version` (`id@.id:version`): a payload that merely happens
  // to call a record a `header` is not an opening frame and stays untouched.
  header: 'id@.id:version',
})

/** Endpoints the wrapper answers with a merged view instead of routing. */
export const MERGED_ENDPOINTS = Object.freeze(['session/list', 'workspace/follow', 'session/modelCatalog'])

/**
 * The two reorder endpoints and the argument that anchors them. Both take the row
 * being moved plus an optional "land before this one" (`dsh-workspace` * `insertBefore` / `insertSessionBefore`); the anchor is the id the merged sidebar
 * produces from the row it was dropped on, so it is the one that has to be checked
 * for a cross-list drop (see `#assertSameReorderList`).
 */
const REORDER_ANCHOR_FIELDS = Object.freeze({
  'workspace/insertBefore': 'beforeWorkspaceId',
  'workspace/insertSessionBefore': 'beforeSessionId',
})

/** The endpoints whose cards carry an approval hash the bridge requires. */
const APPROVAL_RESULT_ENDPOINT = '$events/result'
const APPROVAL_HASH = /^[a-f0-9]{64}$/

/**
 * The companion frames that answer/cancel an ACTIVE (open) question. The gateway
 * that minted the card owns `pendingQuestions[rpcId]` and settles the tool call;
 * `RemoteConnection.request()` sends the frame and correlates the `question-response`
 * receipt by `requestId` (lib/remote-client.mjs).
 */
const QUESTION_ANSWER_TYPE = 'question-answer'
const QUESTION_CANCEL_TYPE = 'question-cancel'
/** Only an explicit user "skip" sends the cancel frame; a timeout/abort is already settled. */
const QUESTION_CANCEL_CODES = new Set(['ASK_CANCELLED'])
/**
 * Bridge call for a CONTINUED question only (`dsh-user-questions/src/index.ts:170`
 * looks in `continued(agent)` and returns false otherwise). Used solely after the
 * gateway has evidenced that it no longer holds the question as pending.
 */
const QUESTION_CONTINUED_ENDPOINT = 'userQuestions/answer'

/**
 * The DSH release this wrapper was last self-tested against. Informational only
 * (diagnostics): the wrap is gated on the live API shapes plus DSH_ENGINES_RANGE,
 * not on equality with this value (owner 2026-11-13, auto-compat layer 2).
 */
export const PINNED_DSH_VERSION = '0.2.2-rc.3'

/** Mirrors package.json engines.dsh; DSH evaluates it with semver includePrerelease. */
export const DSH_ENGINES_RANGE = '>=0.2.2-rc.3 <0.3.0-0'

const SEMVER = /^(\d+)\.(\d+)\.(\d+)(?:-([0-9A-Za-z.-]+))?(?:\+[0-9A-Za-z.-]+)?$/

function comparePre(a, b) {
  if (a === undefined) return b === undefined ? 0 : 1
  if (b === undefined) return -1
  const x = a.split('.'), y = b.split('.')
  for (let i = 0; i < Math.max(x.length, y.length); i++) {
    if (x[i] === undefined) return -1
    if (y[i] === undefined) return 1
    const nx = /^\d+$/.test(x[i]), ny = /^\d+$/.test(y[i])
    if (nx && ny) { const d = Number(x[i]) - Number(y[i]); if (d) return Math.sign(d); continue }
    if (nx !== ny) return nx ? -1 : 1
    if (x[i] !== y[i]) return x[i] < y[i] ? -1 : 1
  }
  return 0
}

/**
 * True when version satisfies DSH_ENGINES_RANGE (>=0.2.2-rc.3, same 0.2 minor, * no 0.3 prerelease). Dependency-free so the devices plugin stays dep-less.
 */
export function dshVersionInRange(version) {
  const m = typeof version === 'string' ? SEMVER.exec(version.trim()) : null
  if (!m) return false
  const [maj, min, pat] = [Number(m[1]), Number(m[2]), Number(m[3])]
  if (maj !== 0 || min !== 2) return false
  if (pat !== 2) return pat > 2
  return comparePre(m[4], 'rc.3') >= 0
}

/**
 * Marks one of our carrier wrappers with the function it replaced, so a router
 * installed later (a reload) finds the TRUE DSH original instead of wrapping a
 * wrapper. Without this, an `uninstall()` between the two left the inner
 * wrapper reading a nulled `#originals` and every call died with
 * "Cannot read properties of null (reading 'dispatchRpc')" (measured live).
 */
const ORIGINAL = Symbol.for('@dsh-ext/devices.carrierOriginal')

/** The DSH original underneath any number of our wrappers. */
function rootOriginal(fn) {
  let current = fn
  for (let depth = 0; depth < 8; depth += 1) {
    const next = current?.[ORIGINAL]
    if (typeof next !== 'function') return current
    current = next
  }
  return current
}

/** How deep an id-bearing payload may nest; anything deeper is refused. */
// Session history (message parts, tool args/results, JSON trees) legitimately nests
// well past 32; 256 recursive frames stay far below the stack limit.
const MAX_ID_DEPTH = 256
/**
 * How many durable events a re-opened follow's snapshot may hold that the reader
 * has NOT seen yet — the stretch the link lost — before a repair replay is refused
 * instead of turned into a whole second window (see `resumeOpeningFrames`).
 */
const MAX_RESUME_GAP = 4096
/**
 * Keys a payload may never carry. `JSON.parse` turns them into own properties, and
 * one plain assignment of `__proto__` rebuilds the prototype of the renamed copy
 * instead of copying a field. No DSH wire payload has a field with these names.
 */
const UNSAFE_KEYS = new Set(['__proto__', 'constructor', 'prototype'])

/** The forwarded-event stream the controller's own UI consumes (rc.1 `$events`). */
const EVENTS_ENDPOINT = '$events'
/** The per-session history stream: one opening snapshot, then increments. */
const SESSION_FOLLOW_ENDPOINT = 'session/follow'
/**
 * The Host-wide projection control stream. DSH's client folds each
 * `{type:'projection', sessionId, seq, changes}` frame into the per-session
 * `ProjectionValueStore` that the native model chip reads (`modelSelection`).
 * Remote sessions never cross it on their own, so it is merged like the catalog.
 */
const SESSION_CONTROL_ENDPOINT = 'session/control'
/**
 * Bound on seed-requiring cuts carried between generations. The native retry opens a
 * new generation for each such cut, so without a cap an abandoned stream could pin
 * one block per session forever.
 */
const MAX_CARRIED_CONTROL_CUTS = 64
/**
 * Bound on the per-session "last fallback watermark" table. A re-opened follow
 * replays the same claim event; without a memory of the seq we just published,
 * that replay would spam the merged control stream with duplicates. Bounded like
 * the other per-session tables here, and cleared on uninstall.
 */
const MAX_FALLBACK_CONTROL_SEQS = 64
/**
 * Bound on the per-merged-session reconstructed inbox table. A remote Host can
 * open many sessions; without a cap this state would outlive every open stream.
 */
const MAX_TRACKED_INBOX_STATES = 64
/** The Host-generation model catalog the native picker loads (it takes no argument). */
const MODEL_CATALOG_ENDPOINT = 'session/modelCatalog'
/**
 * The longest remote group header the merged catalog passes on. The header is the
 * remote's own provider name plus a label this module mints, and it is the only
 * text the picker renders for a provider, so it is bounded here instead of being
 * trusted to be a tidy one-liner.
 */
const MAX_REMOTE_GROUP_NAME = 120
/**
 * `Remote · <host> — <provider name>`: the header of one remote provider group.
 * The picker renders a group's `name` and nothing else (no per-host slot), so the
 * host has to be part of that string for the sections to be tellable apart.
 */
const REMOTE_GROUP_LABEL = 'Remote'
const REMOTE_PROVIDER_SEPARATOR = ' — '
/**
 * Separator between a provider route and the host that owns it: a remote
 * provider is named `<provider>@<hostId>` wherever the local UI reads it.
 *
 * `@` cannot occur in a real provider id, so the tag is unambiguous: the only
 * path that mints a new route is the custom-provider card, which validates it
 * against `/^[a-z][a-z0-9]*(?:-[a-z0-9]+)*$/` (dsh-client-ui-settings-models, * `ROUTE_PATTERN`: lowercase letters, digits, single hyphens), and every shipped
 * route (`deepseek-account`, `deepseek-official`, …) has the same shape.
 */
const PROVIDER_HOST_SEPARATOR = '@'
/** The one endpoint that writes a session's model selection. */
const MODEL_SELECT_ENDPOINT = 'session/selectModel'
/**
 * The local event the native picker reloads the catalog on (one of the four it * subscribes to). It is an `emit` frame, forwarded to the client verbatim.
 */
const MODEL_CATALOG_REFRESH_EVENT = 'llm/models-updated'
/** The two waterfall events whose cards the native UI renders and answers. */
const APPROVAL_EVENT = 'approval/request'
const QUESTION_EVENT = 'user-questions/request'
/** The native event that carries a session's running dot (sidebar status). */
const SESSION_STATUS_EVENT = 'api-session/status'
/** The native events that create and withdraw a sidebar row. */
const SESSION_ADDED_EVENT = 'api-session/added'
const SESSION_REMOVED_EVENT = 'api-session/removed'
/**
 * How long a status naming an unknown session waits before the one coalesced
 * `session/list` reload. A burst of statuses in the same window is one reload.
 */
const SESSION_STATUS_LIST_REFRESH_MS = 250
/** How many remote cards one controller keeps addressable (bounded like the buffer). */
const MAX_TRACKED_CARDS = 128
/** How many per-host refusals the status keeps for the Devices page (bounded). */
const MAX_HOST_ERRORS = 32
/**
 * How long two host-set announcements must be apart (`#announceHostSet`). A link
 * supervisor retries a failing host on its own backoff, so a flapping host could
 * otherwise make the picker reload the merged catalog on every retry; one emit per
 * window still corrects the catalog within a second of the set actually settling.
 */
const MODEL_CATALOG_ANNOUNCE_INTERVAL_MS = 1000
/**
 * How many hosts keep their last-known session list while they are disconnected.
 * Bounded like every other per-host table here: a paired set is small, and a
 * forgotten host is dropped from the retention entirely (see `#knownHostIds`).
 */
const MAX_RETAINED_HOSTS = 32
/**
 * The frame-ordering failure `lib/remote-client.mjs` raises on a stream whose frames
 * arrived out of `seq` order. A literal because that module does not export it and
 * this one must not import it: the code IS the contract between the two (the tests * pin both sides to it).
 */
const STREAM_DESYNC_CODE = 'remote/stream-desync'
/** The terminal code a follow ends on when DESYNCs keep repeating with no progress. */
const STREAM_DESYNC_REPEATED_CODE = 'remote/stream-desync-repeated'
/**
 * How many consecutive DESYNCs a follow tolerates with no frame delivered between
 * them. A DESYNC is resumable (the re-opened follow carries a snapshot), but a Host
 * that accepts every open and immediately sends out-of-order frames would otherwise
 * be re-opened forever at the minimal delay. Five attempts still ride the normal
 * backoff (100…500 ms) and is well under the gateway's per-device stream cap, so a
 * recoverable desync still repair it; a persistent one becomes visible instead of
 * piling subscriptions up against that cap.
 */
const MAX_CONSECUTIVE_DESYNCS = 5
/**
 * The terminal code a follow ends on when a re-joined page holds more of the lost
 * stretch than `MAX_RESUME_GAP`: repairing it would replay a whole session as rows,
 * so the page is refused VISIBLY (see `resumeOverflowError`) instead of dropped.
 */
const STREAM_RESUME_OVERFLOW_CODE = 'remote/stream-resume-overflow'

/** A refusal this module produced; `code` rides the Gateway failure vocabulary. */
export class HostRouterError extends Error {
  constructor(code, message, details = {}) {
    super(message)
    this.name = 'HostRouterError'
    this.code = code
    this.details = details
  }
}

const isPlainObject = (value) => {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) return false
  const prototype = Object.getPrototypeOf(value)
  return prototype === Object.prototype || prototype === null
}

/**
 * DSH's `InboxWireState` is exactly these two hyphenated arrays. An id is the
 * only identity a splice needs to check; message bodies stay opaque here, so no
 * content is copied into a log or a synthetic frame beyond the wire value itself.
 */
const isInboxMessage = (message) => isPlainObject(message) && typeof message.id === 'string' && message.id !== ''

/** Validate and detach one whole inbox value; duplicate ids mean unknown state. */
function normalizeInboxValue(value) {
  if (!isPlainObject(value)) return null
  const nextTurn = value['next-turn']
  const nextStep = value['next-step']
  if (!Array.isArray(nextTurn) || !Array.isArray(nextStep)) return null
  const ids = new Set()
  for (const message of [...nextTurn, ...nextStep]) {
    if (!isInboxMessage(message) || ids.has(message.id)) return null
    ids.add(message.id)
  }
  return { 'next-turn': nextTurn.slice(), 'next-step': nextStep.slice() }
}

/**
 * The standard durable-splice fold (dsh-agent-loop/src/inbox.ts `inboxProjectionDefinition`):
 * validate the whole splice against BOTH queues, then return the full post-state.
 * A null result means the Host's event cannot be trusted for reconstruction.
 */
function foldInboxValue(state, data) {
  if (!isPlainObject(data) || (data.target !== 'next-turn' && data.target !== 'next-step')) return null
  const removedCount = data.removedCount ?? 0
  if (!Number.isSafeInteger(data.start) || data.start < 0) return null
  if (!Number.isSafeInteger(removedCount) || removedCount < 0 || !Array.isArray(data.inserted)) return null
  const inbox = state[data.target]
  if (data.start > inbox.length || data.start + removedCount > inbox.length) return null
  const next = inbox.slice()
  next.splice(data.start, removedCount, ...data.inserted)
  return normalizeInboxValue(data.target === 'next-turn'
    ? { 'next-turn': next, 'next-step': state['next-step'] }
    : { 'next-turn': state['next-turn'], 'next-step': next })
}

/**
 * The hosts one merged catalog included, as one comparable key (sorted, so the
 * host order of a list can never matter). Shared by the merge that records it
 * (`#mergeModelCatalog`) and the announcement that compares against it.
 * @param {{hostId: string}[]} hosts
 */
const catalogKey = (hosts) => hosts.map((host) => host.hostId).sort().join('\u0000')

/** `h:<hostId>:<rawId>` -> `<hostId>`, anything else -> null. */
export function hostIdOfId(value) {
  if (typeof value !== 'string' || !value.startsWith(HOST_PREFIX)) return null
  const rest = value.slice(HOST_PREFIX.length)
  const separator = rest.indexOf(':')
  if (separator <= 0) return null
  return rest.slice(0, separator)
}

/**
 * `<rawId>` -> `h:<hostId>:<rawId>`.
 *
 * An id that arrives from a remote Host is OPAQUE: it is always wrapped in the
 * authenticated source host's namespace, so a compromised Host cannot make its own
 * row or card look like another host's by sending an id that is already tagged. An
 * already-tagged id therefore never reaches this function; when one does (a second * pass, a replayed cache, a hostile frame) it is refused instead of trusted.
 */
export function namespaceId(hostId, value) {
  if (typeof value !== 'string' || value === '') return value
  if (value.startsWith(HOST_PREFIX)) {
    throw new HostRouterError('remote/id-leak',
      `refusing a pre-tagged id (${value.length} chars): only this controller may name a host namespace`,
      { hostId })
  }
  return `${HOST_PREFIX}${hostId}:${value}`
}

/**
 * Rewrite every id in the table, recursively, into a fresh value.
 *
 * Prototype-safe: an own `__proto__`/`constructor`/`prototype` key is dropped
 * instead of being assigned. Bounded: a payload nested deeper than MAX_ID_DEPTH is
 * refused — returning the original subtree would hand back an unrenamed id, i.e. a
 * raw remote id in the local UI.
 */
function rewriteIds(value, transform, seen = new Map(), depth = 0, selection) {
  if (depth > MAX_ID_DEPTH) {
    throw new HostRouterError('remote/payload-too-deep', `refusing a payload nested deeper than ${MAX_ID_DEPTH} levels`, { depth: MAX_ID_DEPTH })
  }
  if (Array.isArray(value)) {
    if (seen.has(value)) return seen.get(value)
    const out = []
    seen.set(value, out)
    for (const item of value) out.push(rewriteIds(item, transform, seen, depth + 1, selection))
    return out
  }
  // Buffers, typed arrays, dates … are values, not structures: never touch them
  // (a binary result must stay byte-exact).
  if (!isPlainObject(value)) return value
  if (seen.has(value)) return seen.get(value)
  const out = {}
  seen.set(value, out)
  for (const [key, item] of Object.entries(value)) {
    if (UNSAFE_KEYS.has(key)) continue
    const rule = ID_FIELDS[key]
    if (rule === 'id') {
      out[key] = typeof item === 'string' ? transform(item) : item
    } else if (rule === 'ids') {
      out[key] = Array.isArray(item) ? item.map((entry) => (typeof entry === 'string' ? transform(entry) : entry)) : item
    } else if (rule === 'items:id') {
      out[key] = Array.isArray(item)
        ? item.map((entry) => (isPlainObject(entry) && typeof entry.id === 'string'
          ? { ...rewriteIds(entry, transform, seen, depth + 1, selection), id: transform(entry.id) }
          : rewriteIds(entry, transform, seen, depth + 1, selection)))
        : item
    } else if (typeof rule === 'string' && rule.startsWith('id@.')) {
      // Nested alias (`header: 'id@.id:version'`): the id sits on the record's OWN
      // `<inner>` field, guarded by a sibling `<guard>` of the same record, so a
      // payload that merely happens to use the key stays untouched. Checked before
      // the outer `id@<guard>` form, which would otherwise read `id:version` as a
      // property of the outer object and never rename the value.
      const [inner, guard] = rule.slice(4).split(':')
      out[key] = !isPlainObject(item) ? rewriteIds(item, transform, seen, depth + 1, selection)
        : Object.hasOwn(item, guard) && typeof item[inner] === 'string'
          ? { ...rewriteIds(item, transform, seen, depth + 1, selection), [inner]: transform(item[inner]) }
          : rewriteIds(item, transform, seen, depth + 1, selection)
    } else if (typeof rule === 'string' && rule.startsWith('id@')) {
      // The `id@` form guards a record whose own `id` is a session id.
      const guarded = isPlainObject(item) && typeof item.id === 'string' && Object.hasOwn(item, rule.slice(4))
      out[key] = guarded
        ? { ...rewriteIds(item, transform, seen, depth + 1, selection), id: transform(item.id) }
        : rewriteIds(item, transform, seen, depth + 1, selection)
      // The rule names THIS field, so the value carried here is transformed too: an
      // untransformed one left a tagged `rpcId` on the way to its Host (and a raw id
      // on the way to the UI).
      if (typeof item === 'string') out[key] = transform(item)
    } else if (rule === 'source') {
      // A message's `source` is walked as a unit ONLY when it is the object an
      // approval/question card carries, so its `rpcId` can be judged by `kind`; a
      // `source` that is anything else (a bare string in another payload) is left to
      // the walker exactly as before. On `kind:'user'` the `rpcId` is the `requestId`
      // THIS controller minted (see `ID_FIELDS`), so it is kept; every other id is
      // renamed as usual, and an approval/question card's `rpcId` is namespaced.
      out[key] = isPlainObject(item) && typeof item.rpcId === 'string' && item.kind === 'user'
        ? { ...rewriteIds({ ...item, rpcId: undefined }, transform, seen, depth + 1, selection), rpcId: item.rpcId }
        : rewriteIds(item, transform, seen, depth + 1, selection)
    } else {
      out[key] = rewriteIds(item, transform, seen, depth + 1, selection)
    }
  }
  // A model selection's `provider` is not an id (it is not minted here), but it is
  // the other name the local UI compares per host, so the same pass tags it: no
  // caller can rename a remote payload's ids and forget its selection. The value
  // is read from the source object: `provider` is not in the table, so it is
  // copied verbatim and `out` holds the same string.
  if (selection !== undefined
    && typeof value.provider === 'string' && value.provider !== ''
    && typeof value.model === 'string' && value.model !== '') {
    out.provider = selection(value.provider)
  }
  return out
}

/**
 * Local ids -> `h:<hostId>:<id>` (a remote result on its way to the local UI),
 * and a model selection's provider -> `<provider>@<hostId>` for the same reason:
 * a session on that Host must never read as a session on this one.
 */
export function namespaceIds(value, hostId) {
  if (typeof hostId !== 'string' || hostId === '') return value
  return rewriteIds(value, (id) => namespaceId(hostId, id), new Map(), 0, (provider) => tagProvider(hostId, provider))
}

/** `h:<hostId>:<id>` -> `<id>` (a local call on its way to that remote). */
export function stripHostIds(value, hostId) {
  if (typeof hostId !== 'string' || hostId === '') return value
  const prefix = `${HOST_PREFIX}${hostId}:`
  return rewriteIds(value, (id) => (id.startsWith(prefix) ? id.slice(prefix.length) : id))
}

/**
 * The provider route a merged catalog uses for `provider`, which a remote Host
 * named: `<provider>@<hostId>`. The picker matches a session's projected
 * `provider` against these group ids, so both sides of that comparison carry it.
 */
function tagProvider(hostId, provider) {
  return `${provider}${PROVIDER_HOST_SEPARATOR}${hostId}`
}

/**
 * The host a provider is tagged for, or null when it carries no tag.
 *
 * A provider id cannot contain `@` (see PROVIDER_HOST_SEPARATOR), so the FIRST
 * one is always the tag this module minted. An empty provider, and a string that
 * starts with the separator, are untagged — never half-parsed into a host.
 */
function providerHostOf(provider) {
  const at = provider.indexOf(PROVIDER_HOST_SEPARATOR)
  return at <= 0 ? null : provider.slice(at + 1)
}

/**
 * The provider a call routed to `hostId` must carry, or a `model/wrong-host`
 * refusal. `hostId === null` means the call stays Local.
 *
 * The UI only ever sees merged ids, so a selection for a remote session arrives
 * tagged with that host: the tag comes off here, and the Host never sees it. A
 * tag naming another host — or an untagged provider handed to a remote session —
 * is refused instead of being rerouted: silently running a model on the wrong
 * machine is the one outcome this tag exists to prevent.
 */
function routedProvider(provider, hostId) {
  const tagged = providerHostOf(provider)
  if (hostId === null) {
    if (tagged === null) return provider
    throw new HostRouterError('model/wrong-host',
      `provider "${provider}" belongs to remote host ${tagged}; a Local session cannot select it`,
      { hostId: tagged })
  }
  if (tagged === null) {
    throw new HostRouterError('model/wrong-host',
      `provider "${provider}" is a Local provider; a session on ${hostId} must name its provider as "<provider>${PROVIDER_HOST_SEPARATOR}${hostId}"`,
      { hostId })
  }
  if (tagged !== hostId) {
    throw new HostRouterError('model/wrong-host',
      `provider "${provider}" belongs to remote host ${tagged}, not to ${hostId}`,
      { hostId: tagged })
  }
  return provider.slice(0, provider.length - tagged.length - 1)
}

/**
 * Rewrite the provider of every model selection in a call's arguments.
 *
 * A selection is the `{provider, model}` pair the picker compares against the
 * catalog. It is not in the id table (`provider` is a routing label, not an id * this controller mints), so it is found by shape anywhere in the arguments — the
 * flat shape and the nested `request` shape the gateway also accepts.
 */
function retargetSelections(value, hostId, depth = 0) {
  if (depth > MAX_ID_DEPTH) {
    throw new HostRouterError('remote/payload-too-deep', `refusing a payload nested deeper than ${MAX_ID_DEPTH} levels`, { depth: MAX_ID_DEPTH })
  }
  if (Array.isArray(value)) return value.map((item) => retargetSelections(item, hostId, depth + 1))
  if (!isPlainObject(value)) return value
  const out = {}
  for (const [key, item] of Object.entries(value)) {
    if (UNSAFE_KEYS.has(key)) continue
    out[key] = retargetSelections(item, hostId, depth + 1)
  }
  if (typeof out.provider === 'string' && out.provider !== '' && typeof out.model === 'string' && out.model !== '') {
    out.provider = routedProvider(out.provider, hostId)
  }
  return out
}

/**
 * The title one remote Workspace carries in the merged sidebar: `<title> · <host>`.
 * The native `WorkspaceBrowser` renders merged rows as they arrive, so this is the
 * only place the host name can be attached without replacing the browser. The
 * default-title sentinel — and a workspace that carries no title at all — is not
 * carried through: it reads as `Default · <host>` (see DEFAULT_WORKSPACE_LABEL).
 */
function workspaceTitle(title, hostName) {
  const own = typeof title === 'string' && title !== '' ? title : DEFAULT_WORKSPACE_LABEL
  const base = own === DEFAULT_WORKSPACE_TITLE ? DEFAULT_WORKSPACE_LABEL : own
  return `${base}${WORKSPACE_HOST_SEPARATOR}${hostName}`
}

/**
 * One remote `session/list` row with `cwd` taken off (spec 012).
 *
 * A remote row's `cwd` is the working directory on the Host that owns the session,
 * and the native UI treats a known `cwd` as the precondition of the "Show in folder"
 * item: `ctx.sessions.list.getSnapshot().byId[sessionId]?.cwd` decides whether the
 * item is enabled and is passed to the file manager (dsh-client-ui-open-in-app). A
 * remote path would therefore enable a menu that opens THIS machine's file manager
 * at a directory belonging to another machine. The key is omitted — never replaced
 * with a path of ours — exactly the shape the core produces for a session whose
 * working directory is unknown (`{...entry.cwd !== void 0 ? {cwd: entry.cwd} : {}}` * in dsh-api-session-controller), which keeps the item disabled. Every other field
 * (ids, title, projections) is left exactly as `#ingress` renamed it.
 */
function withoutRemoteCwd(row) {
  if (!isPlainObject(row) || !Object.hasOwn(row, 'cwd')) return row
  const { cwd: _cwd, ...rest } = row
  return rest
}

/**
 * The native SessionManager treats a `session/list` row as a `SessionSummary`:
 * `handleSessionAdded` reads `sessionId`, `running`, `blank` and `projections`,
 * and `applyListBlock` iterates `projections.values` (dsh-api-session-controller
 * src/client/sessions/manager.ts:649-653, 664-677). `#ingress` only renames ids —
 * it is not a shape check. A malformed row must never reach the native UI or a
 * retained list; fields with the right types are otherwise left verbatim.
 */
function isSessionSummaryRow(row) {
  if (!isPlainObject(row) || typeof row.sessionId !== 'string' || row.sessionId === '') return false
  for (const key of ['running', 'blank', 'agentAvailable']) {
    if (row[key] !== undefined && typeof row[key] !== 'boolean') return false
  }
  if (row.updatedAt !== undefined && !Number.isFinite(row.updatedAt)) return false
  if (row.projections === undefined) return true
  if (!isPlainObject(row.projections)) return false
  const { kind, asOfSeq, values } = row.projections
  return (kind === 'sequenced' || kind === 'cached')
    && typeof asOfSeq === 'number' && Number.isFinite(asOfSeq)
    && isPlainObject(values)
}

/**
 * The reverse, for the one payload that sends a title back: `workspace/rename`
 * takes exactly `{workspaceId, title}`, and the native rename dialog starts from
 * the title it displays, so an edited draft can still end with our suffix. The
 * remote Host stores its own titles and must never receive our decoration. Only
 * this host's exact suffix is removed; any other title passes through untouched.
 */
function withoutWorkspaceTitle(args, hostName) {
  if (!isPlainObject(args) || typeof args.title !== 'string') return args
  const suffix = `${WORKSPACE_HOST_SEPARATOR}${hostName}`
  if (!args.title.endsWith(suffix) || args.title.length === suffix.length) return args
  return { ...args, title: args.title.slice(0, -suffix.length) }
}

/** Every id string the rename table covers, at any depth (bounded like the walker). */
function visitIds(value, visit, seen = new Set(), depth = 0) {
  if (value === null || typeof value !== 'object' || depth > MAX_ID_DEPTH || seen.has(value)) return
  seen.add(value)
  if (Array.isArray(value)) {
    for (const item of value) visitIds(item, visit, seen, depth + 1)
    return
  }
  if (!isPlainObject(value)) return
  for (const [key, item] of Object.entries(value)) {
    const rule = ID_FIELDS[key]
    if (rule === 'id') {
      if (typeof item === 'string') visit(item)
    } else if (rule === 'ids') {
      if (Array.isArray(item)) for (const entry of item) if (typeof entry === 'string') visit(entry)
    } else if (rule === 'items:id') {
      if (Array.isArray(item)) {
        for (const entry of item) {
          if (isPlainObject(entry) && typeof entry.id === 'string') visit(entry.id)
          visitIds(entry, visit, seen, depth + 1)
        }
      }
    } else if (rule === 'source') {
      // Matches `rewriteIds`: a user message's source `rpcId` is neither renamed nor
      // inspected (the controller minted it), while every other id inside the source
      // — and any card's `rpcId` — is still walked, so the egress/refusal checks
      // agree with the table exactly.
      if (isPlainObject(item) && item.kind === 'user' && typeof item.rpcId === 'string') {
        visitIds({ ...item, rpcId: undefined }, visit, seen, depth + 1)
      } else visitIds(item, visit, seen, depth + 1)
    } else if (typeof rule === 'string' && rule.startsWith('id@.')) {
      // Matches `rewriteIds`' nested alias (`header: 'id@.id:version'`).
      const [inner, guard] = rule.slice(4).split(':')
      if (isPlainObject(item) && Object.hasOwn(item, guard) && typeof item[inner] === 'string') visit(item[inner])
      visitIds(item, visit, seen, depth + 1)
    } else if (typeof rule === 'string' && rule.startsWith('id@')) {
      // Matches `rewriteIds`: an outer guard, and the field's own value when it is
      // the id itself.
      if (isPlainObject(item) && Object.hasOwn(item, rule.slice(4)) && typeof item.id === 'string') visit(item.id)
      if (typeof item === 'string') visit(item)
      visitIds(item, visit, seen, depth + 1)
    } else {
      visitIds(item, visit, seen, depth + 1)
    }
  }
}

/** Every host id named by a table field anywhere in `value`. */
export function hostIdsIn(value) {
  const out = new Set()
  visitIds(value, (id) => {
    const hostId = hostIdOfId(id)
    if (hostId) out.add(hostId)
  })
  return out
}

/**
 * Every id in `value` that already carries a namespace tag. A remote Host may not
 * send one (`#ingress` refuses the payload); this is the check that catches it.
 */
export function taggedIdsIn(value) {
  const out = new Set()
  visitIds(value, (id) => { if (id.startsWith(HOST_PREFIX)) out.add(id) })
  return out
}

/**
 * True when any `callId` (at any depth) already starts with the host prefix.
 * `callId` is opaque to the rename table, so the table walk cannot see it; it must
 * still never impersonate a tag this controller minted, on ANY remote frame.
 */
export function hasPseudoTaggedCallId(value, seen = new Set(), depth = 0) {
  if (value === null || typeof value !== 'object' || depth > MAX_ID_DEPTH || seen.has(value)) return false
  seen.add(value)
  if (Array.isArray(value)) return value.some((item) => hasPseudoTaggedCallId(item, seen, depth + 1))
  if (!isPlainObject(value)) return false
  for (const [key, item] of Object.entries(value)) {
    if (key === 'callId' && typeof item === 'string' && item.startsWith(HOST_PREFIX)) return true
    if (hasPseudoTaggedCallId(item, seen, depth + 1)) return true
  }
  return false
}

/**
 * Refuse an interaction card whose ids are not opaque (spec 008 review fix).
 *
 * A card is remote data like every other frame, but it is the ONE payload this
 * module rebuilds field by field instead of renaming a copy, so the rename table
 * alone does not protect it: `rpcId`/`sessionId` were checked, `approvalId` and
 * `callId` were copied straight out of the frame. A compromised Host could send
 * `approvalId: 'h:<anotherHost>:<id>'`, have the value parked in the controller's
 * card table and approval buffer, and be handed it back on the decision. The WHOLE
 * card is therefore validated against the rename table (every id-bearing field, * nested ones included) before either buffer is touched.
 *
 * `callId` is opaque to the table (it is the Host's own tool-call id and is * forwarded unchanged), so the table walk cannot see it; it must still never
 * impersonate a tag this controller minted. The value itself is never logged.
 *
 * @param {string} hostId the host the card arrived from
 * @param {unknown} frame the card as the Host pushed it
 * @returns {unknown} the same frame, when every id on it is opaque
 */
export function assertCleanCard(hostId, frame) {
  if (taggedIdsIn(frame).size === 0 && !hasPseudoTaggedCallId(frame)) return frame
  throw new HostRouterError('remote/id-leak',
    'an interaction card carried an id that already names a host namespace; the card was refused',
    { hostId })
}

/** The host hint a payload carries, at `args.__dshHost` or top level. */
export function hostHintOf(payload) {
  if (!isPlainObject(payload)) return null
  const sources = [isPlainObject(payload.args) ? payload.args : null, payload]
  for (const source of sources) {
    if (source && typeof source[HOST_HINT] === 'string' && source[HOST_HINT] !== '') return source[HOST_HINT]
  }
  return null
}

/** A payload's `args`, the only field the Gateway carrier forwards. */
const payloadArgs = (payload) => (isPlainObject(payload) && isPlainObject(payload.args) ? payload.args : {})

/**
 * Whether a model selection anywhere in `payload` is tagged `<provider>@<hostId>`.
 *
 * A tag IS a route: it names the machine the model must run on (see
 * `routedProvider`). Anything that forwards a payload without routing it — the
 * zero-host passthrough — must therefore look for it, or a remote selection runs
 * on Local. Only the endpoint that carries a selection is walked, and the walk
 * mirrors `retargetSelections`, so the two agree on what a selection is.
 * @param {string} endpoint the call being dispatched
 * @param {object} payload the call as the local UI issued it
 */
function carriesTaggedProvider(endpoint, payload) {
  if (endpoint !== MODEL_SELECT_ENDPOINT) return false
  return hasTaggedSelection(payloadArgs(payload))
}

function hasTaggedSelection(value, depth = 0) {
  if (depth > MAX_ID_DEPTH) return false
  if (Array.isArray(value)) return value.some((item) => hasTaggedSelection(item, depth + 1))
  if (!isPlainObject(value)) return false
  // Same shape test `retargetSelections` uses, so no selection is missed or invented.
  if (typeof value.provider === 'string' && value.provider !== ''
    && typeof value.model === 'string' && value.model !== ''
    && providerHostOf(value.provider) !== null) return true
  return Object.entries(value).some(([key, item]) => !UNSAFE_KEYS.has(key) && hasTaggedSelection(item, depth + 1))
}

/** Drop the client-side hint before anything is sent to a remote. */
function withoutHint(args) {
  if (!isPlainObject(args) || !Object.hasOwn(args, HOST_HINT)) return args
  const { [HOST_HINT]: _hint, ...rest } = args
  return rest
}

/**
 * A failure that means "the link is momentarily gone" — worth resuming a follow
 * stream for, and worth keeping a host's rows through — as opposed to a refusal the
 * Host itself produced (`auth/forbidden-scope`, a protocol error), which is "no".
 *
 * A closed transport carries the socket's own close code; a socket-level failure
 * carries the Node error code. Anything else presents a code, so it is classified by
 * that code alone.
 */
function isLinkFailure(error) {
  const code = typeof error?.code === 'string' ? error.code : ''
  return error?.closeCode !== undefined || code === 'remote/host-offline'
    || code === 'remote/unreachable' || code === 'remote/stream-open-timeout' || code === 'cancelled'
    // Spec 008 defect fix: a DESYNC is not a refusal the Host produced, it is this
    // connection's frame numbering breaking. Re-opening the follow from the last durable
    // sequence is exactly the repair, so it belongs here and not with the terminal errors
    // (`auth/forbidden-scope`, `auth/locked`, an endpoint denial) that must end the follow.
    || code === 'remote/stream-desync'
    || code === 'ECONNREFUSED' || code === 'ECONNRESET' || code === 'ETIMEDOUT' || code === 'EPIPE'
}

/**
 * The durable sequence one follow frame advances the reader to, or null for a frame
 * that owns none (an assistant-stream frame is process-local, not durable).
 */
function followSeqOf(value) {
  if (!isPlainObject(value)) return null
  if (value.type === 'snapshot') return Number.isSafeInteger(value.cursor) ? value.cursor : null
  if (value.type === 'event') return Number.isSafeInteger(value.event?.seq) ? value.event.seq : null
  return null
}

/**
 * The durable events a RE-JOINED follow's page carries that this reader does not hold,
 * deduplicated by `seq` and handed over OLDEST FIRST.
 *
 * The Host answers a re-join from the cursor in the request, and it splits that answer
 * into two regions in one order: its OWN events past that cursor (newest first) and then
 * `records`, which reach back over the page up to its last event. Both regions are the
 * same journal, so delivering one region first hands the newest reply over before the
 * prompt that triggered it, and delivering both hands the overlapping turn over twice.
 * The native chat draws rows in the order they arrive, keyed by the Host's `seq`
 * (`ui-chat` `observedInputs`/`anchorSeq`), so they are merged here: every seq above
 * `lastSeq` once, in `seq` order, as plain `event` frames (a second snapshot would * replace the journal the reader already holds).
 *
 * The SECOND region reaches this router as `events`, and it is not always shaped like
 * `records`: the gateway builds its own page with `historyPage`
 * (plugins/mobile-gateway/lib/query-handlers.mjs:211-224), whose `events` are
 * `value.events.map(entry => entry.event)` (line 212) — BARE session events. The remote
 * bridge then forwards the carrier's snapshot values unchanged
 * (plugins/mobile-gateway/lib/remote-bridge.mjs:865-878, `pump`), so both a bare event and
 * the shaped `{type: 'event', event}` record can arrive here for the same region. Both
 * are accepted below, so neither upstream shape is silently dropped; only an entry that
 * carries a usable `seq` (its own, or its inner event's) joins the merge.
 *
 * A seq that appears in no region entry at all is a dense stretch the Host summarised
 * rather than sent (a `created` record stands for the seqs it covers, and that fill is * never replayed on the wire), so `followFrames` fills it from its `firstLiveSeq`/`end`
 * instead: a gap in the reader's journal is worse than an event without a payload.
 * @param {unknown} value the raw snapshot the Host sent
 * @param {number|null} lastSeq the durable sequence already delivered (`null`: none)
 * @returns {{type: 'event', event: object}[]} the unseen durable events, in `seq` order
 */
function unseenSnapshotEvents(value, lastSeq) {
  // `null` means the reader has no durable position yet: every event is unseen.
  const seen = lastSeq ?? -1
  const bySeq = new Map()
  const add = (event) => {
    if (!isPlainObject(event) || !Number.isSafeInteger(event.seq) || event.seq <= seen || bySeq.has(event.seq)) return
    bySeq.set(event.seq, { type: 'event', event })
  }
  // Regions are collected oldest-first; the page's own `cursor` is not needed here
  // because every per-event region is already deduplicated against the reader.
  for (const record of Array.isArray(value.records) ? value.records : []) {
    if (record?.type === 'event') add(record.event)
  }
  // The gateway-built page (`historyPage`) lists its own region as bare events; a
  // shaped `{type: 'event', event}` entry (the `records` shape) is accepted too.
  for (const entry of Array.isArray(value.events) ? value.events : []) {
    if (!isPlainObject(entry)) continue
    add(entry.event)
    add(entry)
  }
  const out = [...bySeq.values()].sort((left, right) => left.event.seq - right.event.seq)
  return out
}

/** The durable `seq` a frame owns, seeing through a snapshot record or its history page. */
function durableSeqOf(value) {
  const own = followSeqOf(value)
  if (own !== null) return own
  if (!isPlainObject(value)) return null
  const eventSeq = isPlainObject(value.event) && Number.isSafeInteger(value.event.seq) ? value.event.seq : null
  return eventSeq ?? rangeEndOf(value)
}

/**
 * The `end` of a frame that stands for a seq RANGE (a `created` record), or null. The
 * snapshot's own `end` is not one of those: it is keyed by `cursor` (see * `isSnapshotFrame`), and a snapshot's value is its cursor, not a page record's cut.
 */
function rangeEndOf(value) {
  return isPlainObject(value) && isCreatedRecordFrame(value) ? value.end : null
}

/**
 * Whether a frame is the snapshot itself, however it is framed, rather than a part of
 * it. The snapshot is the only frame that says where a page ENDS (`cursor`) or carries
 * the session `header`; the one other frame with an integer `end` is a range-covered
 * `created` record (`firstLiveSeq`/`end`), which is a part of the page (see * `isCreatedRecordFrame`) and must never be taken for a second opening.
 */
const isSnapshotFrame = (value) => Number.isSafeInteger(value.cursor) || isPlainObject(value.header)

/**
 * What a LIVE frame of an already-open follow contributes. Only a durable event is
 * de-duplicated (by `seq`, the identity the Host commits it under — never its text, * so the same prompt sent twice stays two rows); every other frame is the Host's
 * own live traffic and is delivered as-is. Assistant-stream frames in particular are
 * process-local presentation frames with their own revision counter, and the field
 * must forward them: they are what draws the streaming text of a remote turn.
 * @param {unknown} value the raw frame the Host sent
 * @param {number|null} lastSeq the durable sequence already delivered
 * @returns {object[]} the raw frames to deliver
 */
function liveFollowFrames(value, lastSeq) {
  if (!isPlainObject(value)) return []
  const seq = isPlainObject(value.event) && Number.isSafeInteger(value.event.seq) ? value.event.seq : null
  if (seq !== null && lastSeq !== null && seq <= lastSeq) return []
  return [value]
}

/**
 * The Host's assistant-stream baseline (`snapshot.assistantStream`), kept for the LIVE
 * frames that follow it on the same attempt: it names the attempt the Host already
 * has open and the revision the stream continues at.
 */
function followBaseline(value) {
  const baseline = isPlainObject(value?.assistantStream) ? value.assistantStream : null
  if (!baseline) return undefined
  return {
    revision: Number.isSafeInteger(baseline.revision) ? baseline.revision : null,
    attemptId: isPlainObject(baseline.activeAttempt) && typeof baseline.activeAttempt.attemptId === 'string'
      ? baseline.activeAttempt.attemptId
      : null,
    // The chunk ordinal the attempt's next chunk carries; absent when the Host does
    // not publish it, and then only the first chunk of a run can be checked by shape.
    nextIndex: isPlainObject(baseline.activeAttempt) && Number.isSafeInteger(baseline.activeAttempt.nextIndex)
      ? baseline.activeAttempt.nextIndex
      : null,
  }
}

/**
 * A page record that STANDS FOR a dense stretch of the journal its page folded in
 * without sending it: a `created` record names the first seq of its page
 * (`firstLiveSeq`) and the last seq it covers (`end`), and neither that fill nor those
 * events are ever replayed on the wire.
 */
const isCreatedRecordFrame = (value) => Number.isSafeInteger(value.firstLiveSeq) && Number.isSafeInteger(value.end)

/**
 * The `{seq}` an uncovered `created` record contributes: the open fill exactly as many.
 * Bounded by MAX_RESUME_GAP like every other resumed page: a record that stands for
 * more than the lost stretch is a page this repair must not fold in, so the fill is
 * REFUSED (`OVERFLOW_MARKER`, which ends the follow visibly in the pump) instead of
 * replaying a whole second window of rows — and never dropped, which would let later
 * live events carry the reader past seqs it never saw.
 */
function coveredCreatedSeq(value, lastSeq) {
  const start = Number.isSafeInteger(value.firstLiveSeq) ? value.firstLiveSeq : -1
  const end = Number.isSafeInteger(value.end) ? value.end : -1
  if (end < start) return null
  if (end - Math.max(start, lastSeq + 1) + 1 > MAX_RESUME_GAP) return [{ ...OVERFLOW_MARKER, count: end - Math.max(start, lastSeq + 1) + 1 }]
  const out = []
  for (let seq = Math.max(start, lastSeq + 1); seq <= end; seq += 1) out.push({ type: 'event', event: { seq } })
  return out
}

/**
 * The frame `followFrames` hands the pump when a repair would deliver more than
 * `MAX_RESUME_GAP` unseen events at once. It never reaches a reader: the pump ends the
 * follow on `STREAM_RESUME_OVERFLOW_CODE` (`resumeOverflowError`), so the stretch is
 * reported to the user rather than skipped silently — `lastSeq` does not move past it,
 * and no later live event can be accepted across it.
 */
const OVERFLOW_MARKER = { type: 'resume-overflow' }

/** The terminal error one refused repair ends its follow on. */
function resumeOverflowError(hostId, count) {
  return new HostRouterError(STREAM_RESUME_OVERFLOW_CODE,
    `the remote Host's re-joined page holds ${count} events this window has not seen, more than ${MAX_RESUME_GAP}; the follow was stopped instead of skipping them`, { hostId, unseen: count, limit: MAX_RESUME_GAP })
}

/**
 * What a follow delivers to its reader, given what the reader already holds.
 *
 * A FIRST open is a pass-through: the Host's frames, then whatever the link sends,
 * unchanged (`liveFollowFrames` de-duplicates a re-sent durable event by `seq`).
 *
 * A RE-OPEN (any attempt after the first) is a resume, and it is repaired rather than
 * passed through. The reader's journal already holds the opening snapshot — a second
 * one replaces the whole window, and an assistant-stream baseline on a journal that is
 * not being replaced collides with the attempt on screen (dsh-api-session-controller, * `ClientAssistantStream.replace`) — while the re-opened follow always opens with one.
 * So a re-opened attempt delivers, ONCE, a repaired replacement:
 *
 *  - its `snapshot` becomes the durable events the reader has not seen (`seq > *    lastSeq`): the missed stretch, in order, as plain `event` frames;
 *  - the history page's `records` (older than the snapshot's own events) are never
 *    delivered, and an assistant-stream `notification` that precedes the baseline is
 *    the Host replaying the prefix of the attempt the baseline describes, which this
 *    reader may already show — it is held back;
 *  - a `created` record whose seq the reader has not covered is delivered as the
 *    `seq`s it stands for, so the gap is closed rather than dropped;
 *  - a page whose unseen stretch exceeds `MAX_RESUME_GAP` is REFUSED, never trimmed
 *    and never dropped: it is returned as `OVERFLOW_MARKER`, and the pump ends this
 *    follow on `STREAM_RESUME_OVERFLOW_CODE` before any later live frame is accepted;
 *  - everything after is the live stream: `liveFollowFrames`, except the attempt this
 *    resume landed in the middle of, which is walked forward from the revision the
 *    baseline named rather than replayed (`openingAttemptStep`).
 *
 * A snapshot may arrive in PARTS, so the first attempt reads only the target id the
 * Host names, and each region is recognised by its own key rather than by `type`
 * alone: a snapshot by `cursor`, its records by `event`, a `created` record by
 * `firstLiveSeq`/`end`, an event by `event.seq`, a presentation frame by `frame`.
 * @param {unknown} value the raw frame the Host sent
 * @param {{resumed: boolean, expected?: number|null, lastSeq: number|null,
 *   opening: {baseline?: object, lineage?: object, lastSeq: number}}} state the pump keeps for this follow
 * @returns {object[]} the raw frames to deliver
 */
function followFrames(value, state) {
  if (!isPlainObject(value)) return []
  const { resumed, expected, lastSeq, opening } = state
  // Before this attempt's opening snapshot has been seen there is nothing to repair
  // and no attempt boundary to read a baseline from: the Host's own frame passes
  // through, so a snapshot arriving in parts is never mistaken for a part of the page.
  if (opening === null || opening === undefined) {
    // An overflow marker is the repair's own refusal, not a part of the page: it must
    // reach the pump (which ends the follow on it) however this attempt is still waiting
    // for its snapshot, or the refusal is dropped and the unseen stretch is skipped.
    if (value.type === OVERFLOW_MARKER.type) return [value]
    const end = rangeEndOf(value)
    if (expected === null || durableSeqOf(value) === expected || end === expected) return [value]
    return []
  }
  if (isSnapshotFrame(value)) {
    opening.cursor = Number.isSafeInteger(value.cursor) ? value.cursor : (Number.isSafeInteger(value.end) ? value.end : null)
    if (!resumed) return [value]
    const baseline = followBaseline(value)
    if (baseline) {
      opening.baseline = baseline
      // A new page starts a new lineage: nothing of this attempt has been delivered
      // yet, so whatever its baseline named is the last revision the reader holds.
      opening.lineage = newAttemptLineage(baseline)
    }
    // The snapshot page is the newest N events: beyond the lost stretch it is a whole
    // second window, which a repair must never fold into the reader's journal. It is
    // refused VISIBLY (marker below) and never dropped: a page dropped here leaves
    // `lastSeq` behind it, and the live events of this very connection (the pump // advances `lastSeq` past them) would carry the reader over the stretch forever.
    const resumedEvents = unseenSnapshotEvents(value, lastSeq)
    if (resumedEvents.length > MAX_RESUME_GAP) return [{ ...OVERFLOW_MARKER, count: resumedEvents.length }]
    return resumedEvents
  }
  // A durable event is de-duplicated by what the reader already holds (`lastSeq`).
  // The snapshot's cursor bounds only the events INSIDE that snapshot page (above):
  // a live event after the opening is covered by `lastSeq` alone, or the stretch
  // the Host replays live would be dropped as "already in the page".
  if (isPlainObject(value.event) && Number.isSafeInteger(value.event.seq)) return liveFollowFrames(value, lastSeq)
  // A `created` record is a part of the page, not a second snapshot: the re-opened
  // follow's dense fill reaches the reader as the seqs it stands for (`resumed` // bounded by MAX_RESUME_GAP), and a first open's is the Host's own frame.
  if (isCreatedRecordFrame(value)) return resumed ? coveredCreatedSeq(value, lastSeq ?? -1) ?? [] : [value]
  if (isPlainObject(value.frame)) {
    if (!resumed) return [value]
    // Before the baseline there is no attempt boundary: what precedes it on this
    // attempt is the Host's replay of an attempt the reader may already show.
    if (opening.baseline === undefined) return []
    if (openingAttemptStep(opening, value.frame)) return []
  }
  return liveFollowFrames(value, lastSeq)
}

/**
 * The assistant stream the reader holds for ONE attempt of a resumed follow: the
 * revisions it has already received and the chunk ordinal the attempt's next chunk
 * carries (`ClientAssistantStream`, `acceptFrame`, holds both and refuses anything
 * else with `rebaseline`, which for a chunk of an open attempt it cannot re-fetch
 * leaves that attempt frozen until the commit).
 */
function newAttemptLineage(baseline) {
  return {
    revision: Number.isSafeInteger(baseline.revision) ? baseline.revision : null,
    index: Number.isSafeInteger(baseline.nextIndex) ? baseline.nextIndex : null,
    pinned: Number.isSafeInteger(baseline.nextIndex),
  }
}

/**
 * Is this live assistant-stream frame of a resumed follow worth delivering?
 *
 * The Host's baseline names the attempt still open at the reconnect (`activeAttempt`)
 * and the revision its stream continues at. A frame of THAT attempt (the one the Host * had open when the reader's journal was replaced) is its residue: the reader showed
 * its text before the gap and the Host does not re-send it, so the WHOLE attempt
 * reads as a revision gap and makes the consumer re-baseline.
 *
 * The attempt itself is still live, though, and re-joining it mid-stream is exactly
 * the repair: the resume landed at revision R, so the attempt ran R+1, R+2, … and
 * every frame from R+1 on is one the reader has NOT seen — the chunks to draw and the
 * `end` that closes it. Those are delivered in ONE unbroken revision run (the carrier * throws a desync on any other revision), and each delivered revision is remembered so
 * the step after it continues the run instead of waiting for the commit. A revision
 * the reader already holds (`≤ R`) is its residue and is dropped. A gap (`revision === * R` after the run started, which only the consumer's own re-baseline makes safe) is
 * dropped rather than drawn into a run the reader cannot finish.
 *
 * The chunk ordinal can only be CHECKED, never repaired: the consumer's count starts at
 * whatever the baseline pinned (`activeAttempt.nextIndex`) or at the run's first chunk,
 * so the first chunk after the resume always belongs to the run, and only a mismatch
 * inside it means the consumer's own count diverged — that attempt freezes instead of
 * drawing through it. An `end` without a chunk index (the shape before revisions were * introduced) can close no run the consumer would finish, so it is the one frame the
 * durable event closes the turn for.
 *
 * A `start` is always a new turn: the Host restarts its counter for a fresh attempt.
 * @param {{baseline: {revision: number|null, attemptId: string|null},
 *   lineage?: {revision: number|null, index: number|null}}} opening the attempt state
 * @param {object} wire the frame inside an `assistant-stream` entry
 * @returns {boolean} whether to hold the frame back
 */
function openingAttemptStep(opening, wire) {
  if (wire.type === 'start') return false
  const { baseline } = opening
  if (baseline.attemptId === null || wire.attemptId !== baseline.attemptId) return false
  if (!Number.isSafeInteger(wire.revision)) return true
  if (!opening.lineage) opening.lineage = newAttemptLineage(baseline)
  const lineage = opening.lineage
  // Only the run that has already started advances here; a first chunk of the run is
  // accepted whatever ordinal it carries, because it either continues the ordinal the
  // baseline pinned (`nextIndex`) or starts the run where the consumer's count starts.
  const inRun = lineage.revision !== baseline.revision && lineage.revision !== null
  const ordinalOk = !inRun || !lineage.pinned || lineage.index === null || wire.index === lineage.index
  if (lineage.revision !== null && Number.isSafeInteger(wire.revision) && wire.revision > lineage.revision
    && ordinalOk && wire.type !== 'end') {
    lineage.revision = wire.revision
    // After this chunk the consumer's own count is one past the ordinal it just drew.
    lineage.index = Number.isSafeInteger(wire.index) ? wire.index + 1 : null
    return false
  }
  if (wire.type === 'end' && !Number.isSafeInteger(wire.index)) return true
  if (!Number.isSafeInteger(lineage.revision)) return true
  if (wire.revision === lineage.revision + 1 && ordinalOk) {
    lineage.revision = wire.revision
    lineage.index = Number.isSafeInteger(wire.index) ? wire.index + 1 : null
    return false
  }
  return true
}

/** The target id a follow's opening names: the snapshot's `<header id>`, however it is framed. */
function openingTargetId(value) {
  if (!isPlainObject(value)) return null
  const own = isPlainObject(value.header) ? value.header.id : null
  const folded = isPlainObject(value.event) && isPlainObject(value.event.header) ? value.event.header.id : null
  const id = own ?? folded
  return typeof id === 'string' && id !== '' ? id : null
}

/**
 * The single session a `session/follow` request is about (its `request.address`),
 * or null for anything else (a subagent address names two sessions, so it is not * cached: the cache is keyed by exactly one id).
 */
function followSessionId(args) {
  if (!isPlainObject(args)) return null
  const address = isPlainObject(args.request) ? args.request.address : undefined
  const id = isPlainObject(address) ? address.sessionId : args.sessionId
  return typeof id === 'string' && id !== '' ? id : null
}

/**
 * Can this Gateway object be wrapped at all? The switch patches the two private
 * carrier methods DSH calls with `this`; when a release renames or re-signs them,
 * remote mode must switch itself off instead of corrupting every call.
 *
 * Constitution A1.1: the wrap is allowed only while the structural self-test passes
 * and the running version is inside the declared `engines.dsh` range gate. An unknown or
 * out-of-range running version means no wrap at all and a reason the Devices page shows — never a guess.
 *
 * Order matters: the gateway itself and its two carrier methods are checked
 * BEFORE the version, because that is the more fundamental failure. A Host that
 * composes no `typertGateway` reports `no-gateway` whatever version it runs, and
 * only a present carrier with both methods can report a version reason.
 * @param {object} gateway
 * @param {{dshVersion?: string}} [options] the running DSH version (detected by the plugin)
 * @returns {string|null} a short reason, or null when the carrier matches
 */
export function selfTest(gateway, { dshVersion } = {}) {
  if (!gateway || (typeof gateway !== 'object' && typeof gateway !== 'function')) return 'no-gateway'
  if (typeof gateway.dispatchRpc !== 'function') return 'dispatchRpc-missing'
  if (typeof gateway.openWireStream !== 'function') return 'openWireStream-missing'
  if (typeof dshVersion !== 'string' || dshVersion === '') return 'dsh-version-unknown'
  if (!dshVersionInRange(dshVersion)) return 'dsh-version-out-of-range'
  // rc.3: dispatchRpc(endpoint, payload, signal, peer);
  // openWireStream(endpoint, payload, uplink, peer, signal, control, uplinkWindow?).
  if (gateway.dispatchRpc.length < 4) return 'dispatchRpc-signature'
  if (gateway.openWireStream.length < 5) return 'openWireStream-signature'
  return null
}

/** Gateway-call failure -> the `{code, message, details}` shape DSH consumes. */
function failureOf(error) {
  if (error && typeof error.code === 'string' && typeof error.message === 'string') {
    return { code: error.code, message: error.message, details: isPlainObject(error.details) ? error.details : {} }
  }
  return { code: 'internal', message: error instanceof Error ? error.message : 'the remote call failed', details: {} }
}

/**
 * A remote result that still holds bytes has to reach DSH's native gateway as the
 * attachment envelope it understands: JSON carries a null placeholder and the bytes
 * travel beside it. Anything else keeps its existing `{ok, value}` shape.
 */
function binaryResultEnvelope(value) {
  // A fresh Uint8Array owns its bytes: a Buffer may be a view into a shared pool,
  // and handing the original on would alias memory this caller does not own.
  const copyBytes = (bytes) => new Uint8Array(bytes)
  if (value instanceof Uint8Array) {
    return { ok: true, value: null, attachments: [{ path: [], bytes: copyBytes(value) }] }
  }
  if (value !== null && typeof value === 'object' && value.data instanceof Uint8Array) {
    return { ok: true, value: { ...value, data: null }, attachments: [{ path: ['data'], bytes: copyBytes(value.data) }] }
  }
  return null
}
/** Bounded FIFO the merged streams deliver through. */
class ValueQueue {
  constructor(max = 4096) {
    this.max = max
    this.items = []
    this.waiters = []
    this.closed = false
    this.error = null
  }

  push(value) {
    if (this.closed) return
    const waiter = this.waiters.shift()
    if (waiter) { waiter({ value, done: false }); return }
    if (this.items.length >= this.max) {
      this.fail(new Error('the merged workspace stream is not being read'))
      return
    }
    this.items.push(value)
  }

  close() {
    if (this.closed) return
    this.closed = true
    for (const waiter of this.waiters.splice(0)) waiter({ value: undefined, done: true })
  }

  fail(error) {
    if (this.closed) return
    this.error = error
    this.close()
  }

  async *[Symbol.asyncIterator]() {
    for (;;) {
      if (this.items.length > 0) { yield this.items.shift(); continue }
      if (this.closed) { if (this.error) throw this.error; return }
      const next = await new Promise((resolve) => this.waiters.push(resolve))
      if (next.done) { if (this.error) throw this.error; return }
      yield next.value
    }
  }
}

/**
 * The merged workspace map. Local workspaces keep their ids and titles; a remote
 * workspace is stored already renamed (`hostId` + `hostName` added, ids tagged, and * the host name in the title) so the baseline, an upsert and the sidebar all agree
 * on identity and on which Host owns the row.
 *
 * It is a DATA store only: which side the sidebar shows is a display decision
 * (owner 2026-11-15 — the sidebar's two tabs never filter what is merged, because
 * DSH itself reads `workspace/follow` to resolve a workspace).
 */
class MergeState {
  constructor() {
    this.ready = false
    this.local = { items: new Map(), order: [], archived: [], pinned: [] }
    /** @type {Map<string, {hostId: string, hostName: string, items: Map<string, object>, order: string[], archived: string[], pinned: string[]}>} */
    this.hosts = new Map()
  }

  #emit(frames) {
    return this.ready ? frames : []
  }

  setLocal(value) {
    this.local = { items: new Map(), order: [], archived: [], pinned: [] }
    for (const item of Array.isArray(value?.items) ? value.items : []) {
      if (!isPlainObject(item) || typeof item.workspaceId !== 'string') continue
      this.local.items.set(item.workspaceId, item)
      this.local.order.push(item.workspaceId)
    }
    this.local.archived = Array.isArray(value?.archivedSessionIds) ? [...value.archivedSessionIds] : []
    this.local.pinned = Array.isArray(value?.pinnedSessionIds) ? [...value.pinnedSessionIds] : []
  }

  applyLocal(type, frame) {
    if (type === 'upsert' && isPlainObject(frame.workspace) && typeof frame.workspace.workspaceId === 'string') {
      this.local.items.set(frame.workspace.workspaceId, frame.workspace)
      if (!this.local.order.includes(frame.workspace.workspaceId)) this.local.order.push(frame.workspace.workspaceId)
      return this.#emit([frame])
    }
    if (type === 'remove' && typeof frame.workspaceId === 'string') {
      this.local.items.delete(frame.workspaceId)
      this.local.order = this.local.order.filter((id) => id !== frame.workspaceId)
      return this.#emit([frame])
    }
    if (type === 'order' && Array.isArray(frame.workspaceIds)) {
      this.local.order = [...frame.workspaceIds]
      return this.#emit([{ type: 'order', workspaceIds: this.order() }])
    }
    if (type === 'archived' && Array.isArray(frame.archivedSessionIds)) {
      this.local.archived = [...frame.archivedSessionIds]
      return this.#emit([{ type: 'archived', archivedSessionIds: this.#union('archived') }])
    }
    if (type === 'pinned' && Array.isArray(frame.pinnedSessionIds)) {
      this.local.pinned = [...frame.pinnedSessionIds]
      return this.#emit([{ type: 'pinned', pinnedSessionIds: this.#union('pinned') }])
    }
    // A Local frame type this merge does not model is Local's own increment (the
    // stream contract grows without this wrapper). Local owns no namespace, so it is
    // forwarded exactly as it came; dropping it would silently withhold an increment
    // the UI is waiting on.
    return this.#emit([frame])
  }

  /** A remote baseline (initial or after a re-subscribe) replaces that host only. */
  setHost(host, value) {
    const items = new Map()
    const order = []
    for (const item of Array.isArray(value?.items) ? value.items : []) {
      if (!isPlainObject(item) || typeof item.workspaceId !== 'string') continue
      const renamed = this.#renameWorkspace(host, item)
      items.set(renamed.workspaceId, renamed)
      order.push(renamed.workspaceId)
    }
    this.hosts.set(host.hostId, {
      hostId: host.hostId,
      hostName: host.hostName,
      items,
      order,
      archived: this.#renameList(host, value?.archivedSessionIds),
      pinned: this.#renameList(host, value?.pinnedSessionIds),
    })
    // A (re)connected host changes the merged picture: republish the whole state.
    return this.#emit([{ type: 'replace', value: this.baseline() }])
  }

  applyHost(host, frame) {
    const type = frame?.type
    const entry = this.hosts.get(host.hostId)
    if (!entry) return []
    if (type === 'upsert' && isPlainObject(frame.workspace) && typeof frame.workspace.workspaceId === 'string') {
      const renamed = this.#renameWorkspace(host, frame.workspace)
      entry.items.set(renamed.workspaceId, renamed)
      if (!entry.order.includes(renamed.workspaceId)) entry.order.push(renamed.workspaceId)
      return this.#emit([{ type: 'upsert', workspace: renamed }])
    }
    if (type === 'remove' && typeof frame.workspaceId === 'string') {
      const workspaceId = namespaceId(host.hostId, frame.workspaceId)
      entry.items.delete(workspaceId)
      entry.order = entry.order.filter((id) => id !== workspaceId)
      return this.#emit([{ type: 'remove', workspaceId }])
    }
    if (type === 'order' && Array.isArray(frame.workspaceIds)) {
      entry.order = frame.workspaceIds.filter((id) => typeof id === 'string').map((id) => namespaceId(host.hostId, id))
      return this.#emit([{ type: 'order', workspaceIds: this.order() }])
    }
    if (type === 'archived' && Array.isArray(frame.archivedSessionIds)) {
      entry.archived = this.#renameList(host, frame.archivedSessionIds)
      return this.#emit([{ type: 'archived', archivedSessionIds: this.#union('archived') }])
    }
    if (type === 'pinned' && Array.isArray(frame.pinnedSessionIds)) {
      entry.pinned = this.#renameList(host, frame.pinnedSessionIds)
      return this.#emit([{ type: 'pinned', pinnedSessionIds: this.#union('pinned') }])
    }
    return []
  }

  dropHost(hostId) {
    if (!this.hosts.delete(hostId)) return []
    return this.#emit([{ type: 'replace', value: this.baseline() }])
  }

  #renameWorkspace(host, item) {
    const renamed = namespaceIds(item, host.hostId)
    const hostName = host.hostName ?? host.hostId
    return { ...renamed, hostId: host.hostId, hostName, title: workspaceTitle(renamed.title, hostName) }
  }

  #renameList(host, value) {
    return Array.isArray(value)
      ? value.filter((id) => typeof id === 'string').map((id) => namespaceId(host.hostId, id))
      : []
  }

  #union(key) {
    const out = [...this.local[key]]
    for (const host of this.hosts.values()) out.push(...host[key])
    return [...new Set(out)]
  }

  /** Local order first (the sidebar's "Local workspaces" group), then each host. */
  order() {
    const ids = [...this.local.order]
    for (const host of this.hosts.values()) ids.push(...host.order)
    return ids
  }

  baseline() {
    const items = []
    for (const id of this.local.order) {
      const item = this.local.items.get(id)
      if (item) items.push(item)
    }
    for (const host of this.hosts.values()) {
      for (const id of host.order) {
        const item = host.items.get(id)
        if (item) items.push(item)
      }
    }
    return { items, archivedSessionIds: this.#union('archived'), pinnedSessionIds: this.#union('pinned') }
  }
}

/**
 * The multi-host wrapper. `deps.hosts()` is read fresh on every call (a host can * go offline mid-session), `deps.onHostsChanged` is the only subscription.
 *
 * @param {object} deps
 * @param {object} deps.gateway the Host `typertGateway` instance to patch
 * @param {() => Array<{hostId: string, hostName?: string, connection: object, online?: boolean}>} [deps.hosts]
 * @param {() => Array<{hostId: string, hostName?: string}>} [deps.knownHosts] every PAIRED
 *   host, connected or not: a disconnected host keeps its last-known rows in the merged
 *   list (see `#retainedRows`). Omitted means the connected set is all there is, which is
 *   the pre-retention behaviour.
 * @param {(listener: () => void) => (() => void)} [deps.onHostsChanged]
 * @param {{card?: (hostId: string, ids: object) => object|undefined,
 *   pending?: (hostId: string) => object[]}} [deps.approvals]
 * @param {{append: Function, read: Function}} [deps.cache] offline transcript cache
 * @param {(line: string) => void} [deps.log]
 * @param {number} [deps.mergeBaselineTimeoutMs] how long the merged baseline waits for remotes
 * @param {string} [deps.dshVersion] the running DSH version (constitution A1.1 self-test)
 */
export class HostRouter {
  #gateway
  #hosts
  #knownHosts
  #onHostsChanged
  #approvals
  #cache
  #log
  #baselineTimeoutMs
  #dshVersion
  #originals = null
      #root = null
      #wrapped = null
  #installed = false
  #reason = null
  /** Stop functions of the merged streams currently being consumed. */
  #merges = new Set()
  /**
   * Seed-requiring `session/control` baselines that ended their generation, keyed by
   * merged session id. A remote greeting is asynchronous and can arrive after the
   * native retry's next opening baseline, so the cut must be carried explicitly:
   * waiting for the greeting cannot carry a -1 cursor or clear a key the cut omits.
   * Snapshotted by each generation and retired only when that Host finally greets
   * at the seeded watermark: an unrelated Host's rebase must not drop it. Bounded
   * so a discarded stream cannot grow it.
   * @type {Map<string, {hostId: string|null, block: object}>}
   */
  #carriedControlCuts = new Map()
  /**
   * Stop functions of the `session/follow` pumps, keyed by host.
   *
   * A pump outlives the LINK on purpose, but not the PAIRING: once a host is
   * forgotten or revoked its follow can never resume, so a pump still waiting for
   * it would hold the reader's stream open forever instead of ending it. Keying
   * them by host is what lets `forgetHost` end exactly that host's streams.
   * @type {Map<string, Set<() => void>>}
   */
  #followStops = new Map()
  /** Push functions of the `$events` streams currently open in the native UI. */
  #eventSinks = new Set()
  /**
   * Push functions of the merged `session/control` streams currently open in the
   * native UI. A remote follow can publish a projection fallback here; with no
   * open stream there is nowhere to publish, so the frame is dropped rather than
   * buffered across generations (the stream's own opening baseline seeds state).
   */
  #controlSinks = new Set()
  /**
   * Last inbox fallback seq published per namespaced session, so a re-opened
   * follow (or a replayed snapshot) does not republish a claim it already advanced.
   * @type {Map<string, number>}
   */
  #fallbackControlSeqs = new Map()
  /**
   * Last authoritative inbox value per merged session id, at the seq of the
   * source that carried it (control baseline, control projection, or a follow
   * snapshot's projections block). Every value here is ALREADY INGRESSED into
   * controller-id space. A claim splice folds into this value so the
   * synthetic frame preserves every OTHER queued message; with no known value
   * there is nothing safe to synthesize.
   * @type {Map<string, {seq: number, value: {'next-turn': object[], 'next-step': object[]}}>}
   */
  #inboxStates = new Map()
  /**
   * The connected-host set last announced (`#connectedKey`), so an unchanged SET
   * stays quiet. It is bookkeeping about this stream's own notifications; what the
   * picker is actually told is decided against `#catalogHostKey`.
   */
  #lastHostSet = null
  /**
   * The hosts — sorted, joined — whose `session/modelCatalog` answer the last merged
   * catalog actually included. It is the ONLY record of what the native picker is
   * holding: the picker reloads the catalog it caches on `llm/models-updated`, and a
   * reload that races a host's link, or a host whose catalog call failed, leaves a
   * catalog with the host silently missing. A connect/disconnect notification alone
   * cannot tell whether that history already cost the user a section.
   */
  #catalogHostKey = null
  /**
   * The connected-host set for which a stale catalog was ALREADY announced. A host
   * whose catalog keeps failing is stale on every reload; announcing that same state
   * again (a rate-limited retry included) would make the picker reload forever, ask
   * the failing host twice each time and log it. A NEW set, or a set that became
   * fresh, re-arms the announcement.
   */
  #catalogAnnouncedKey = null
  /** When the picker was last told to reload (`#announceHostSet`, rate-limited). */
  #lastAnnounceAt = 0
  /**
   * A reload the picker is still owed: the rule asked for one, but the rate limit
   * held the frame back (or the last `$events` stream was superseded before it was
   * sent). The next merged answer, and the next merge that opens, retry it.
   */
  #catalogRefreshPending = false
  /** The one retry timer for a rate-limited announcement (`#scheduleCatalogRefresh`). */
  #catalogTimer = null
  /**
   * Remote cards the native stream knows about, keyed `hostId\u0000<rpcId>`, with
   * the original ids and the Host's `argsHash`: the answer is routed back with
   * these, never with an id or hash invented here.
   * @type {Map<string, {hostId: string, sessionId: string, rpcId: string,
   *   approvalId?: string, argsHash?: string, kind: 'approval'|'question'}>}
   */
  #cards = new Map()
  /**
   * The last call a host refused, per host (`{code, scope?, at}`), so the Devices
   * page can show it on that host's row. A failing remote contributes no rows to
   * a merged answer, which otherwise looks exactly like a host with nothing in it
   * (spec 008: a short grant showed as a connected host with an empty sidebar).
   * @type {Map<string, {code: string, scope?: string, at: number}>}
   */
  #hostErrors = new Map()
  /**
   * The last `session/list` rows of each host, kept AFTER they were renamed into that
   * host's namespace.
   *
   * A disconnected host must not take the user's sessions off the screen: the merged
   * list is the only thing the native sidebar renders, so dropping a host's rows made
   * every one of its sessions vanish the moment the link dropped, and the row could
   * not even be clicked to read the local copy the cache keeps. Retention is keyed by
   * the stable remote record id, which is also the id every alias was minted under
   * (`h:<hostId>:<sid>`), so a reconnected host hands the SAME ids back: the native
   * catalog replaces rows by id and nothing is duplicated, and an open session resumes
   * under the alias the user already had.
   *
   * Rows are stored already renamed and already `cwd`-stripped, so replaying them here
   * never runs `namespaceId` twice (a second pass would refuse its own tag as * `remote/id-leak`) and never re-adds this machine's `cwd`.
   *
   * Cleared only by an explicit forget/revoke (`forgetHost`) or eviction once
   * MAX_RETAINED_HOSTS paired hosts are remembered — never by a transient drop.
   * @type {Map<string, object[]>}
   */
  #retainedRows = new Map()

  constructor(deps = {}) {
    this.#gateway = deps.gateway
    this.#hosts = typeof deps.hosts === 'function' ? deps.hosts : () => []
    this.#knownHosts = typeof deps.knownHosts === 'function' ? deps.knownHosts : null
    this.#onHostsChanged = typeof deps.onHostsChanged === 'function' ? deps.onHostsChanged : () => () => {}
    this.#approvals = deps.approvals ?? null
    this.#cache = deps.cache ?? null
    this.#log = typeof deps.log === 'function' ? deps.log : () => {}
    this.#baselineTimeoutMs = Number.isFinite(deps.mergeBaselineTimeoutMs) ? deps.mergeBaselineTimeoutMs : 3000
    // A1.1: the wrap is gated on the declared `engines.dsh` range (not the pinned version), so the running version is
    // part of the self-test. A caller that cannot detect it gets no wrap.
    this.#dshVersion = typeof deps.dshVersion === 'string' ? deps.dshVersion : undefined
  }

  /** Wrap the carrier; on a carrier mismatch nothing is patched and status says why. */
  install() {
    if (this.#installed) return this.status()
    const reason = selfTest(this.#gateway, { dshVersion: this.#dshVersion })
    if (reason !== null) {
      this.#reason = reason
      this.#log(`multi-host routing disabled: ${reason} (running DSH ${this.#dshVersion ?? 'unknown'}, declared ${DSH_ENGINES_RANGE}, last tested ${PINNED_DSH_VERSION})`)
      return this.status()
    }
    const gateway = this.#gateway
    // Restore target: exactly what was there before us (another router's // wrapper, on a reload). Local calls target the ROOT DSH original instead,
    // so a stacked wrapper can never route our own local call back into us.
    const dispatchRpc = gateway.dispatchRpc
    const openWireStream = gateway.openWireStream
    const rootDispatchRpc = rootOriginal(dispatchRpc)
    const rootOpenWireStream = rootOriginal(openWireStream)
    // rc.1 moved the signal out of the third slot; keep the probe in one place.
    const rc1 = rootOpenWireStream.length >= 5
    this.#originals = { dispatchRpc, openWireStream, rc1 }
    this.#root = { dispatchRpc: rootDispatchRpc, openWireStream: rootOpenWireStream }
    const router = this
    // Explicit parameter lists, not (...args): the bridge and the upstream switch
    // detect the rc.1 opener by `openWireStream.length >= 5`.
    const wrappedDispatch = function (endpoint, payload, signal, peer) {
      return router.#dispatchRpc(endpoint, payload, signal, peer)
    }
    const wrappedOpen = function (endpoint, payload, uplink, peer, signal, control, uplinkWindow) {
      return router.#openWireStream(endpoint, payload, uplink, peer, signal, control, uplinkWindow)
    }
    this.#wrapped = { dispatchRpc: wrappedDispatch, openWireStream: wrappedOpen }
    // A wrapper is discoverable from anywhere, so a reload that stacks a second
    // router still finds the TRUE DSH original instead of wrapping a wrapper.
    Object.defineProperty(wrappedDispatch, ORIGINAL, { value: rootDispatchRpc })
    Object.defineProperty(wrappedOpen, ORIGINAL, { value: rootOpenWireStream })
    gateway.dispatchRpc = wrappedDispatch
    gateway.openWireStream = wrappedOpen
    this.#installed = true
    this.#reason = null
    this.#log(`multi-host routing installed (opens: ${rc1 ? 'rc1' : 'legacy'} arity)`)
    return this.status()
  }

  /** Restore the original carrier methods (a later wrapper is never clobbered). */
  uninstall() {
    for (const stop of [...this.#merges]) stop()
    this.#merges.clear()
    this.#carriedControlCuts.clear()
    for (const stops of [...this.#followStops.values()]) for (const stop of [...stops]) stop()
    this.#followStops.clear()
    this.#eventSinks.clear()
    this.#controlSinks.clear()
    this.#fallbackControlSeqs.clear()
    this.#inboxStates.clear()
    this.#cards.clear()
    this.#hostErrors.clear()
    // Retention describes hosts this controller was reading a moment ago: a torn-down
    // router must not replay them out of its own state on the next install.
    this.#retainedRows.clear()
    this.#lastHostSet = null
    this.#catalogHostKey = null
    this.#catalogAnnouncedKey = null
    this.#lastAnnounceAt = 0
    this.#catalogRefreshPending = false
    if (this.#catalogTimer !== null) {
      clearTimeout(this.#catalogTimer)
      this.#catalogTimer = null
    }
    if (!this.#installed) return
    const gateway = this.#gateway
    const dispatchOurs = gateway.dispatchRpc === this.#wrapped.dispatchRpc
    const openOurs = gateway.openWireStream === this.#wrapped.openWireStream
    if (dispatchOurs) gateway.dispatchRpc = this.#originals.dispatchRpc
    else this.#log('dispatchRpc is no longer ours; left in place')
    if (openOurs) gateway.openWireStream = this.#originals.openWireStream
    else this.#log('openWireStream is no longer ours; left in place')
    this.#installed = false
    // The originals are never nulled. A reload can stack a new router on top of
    // ours, and Cordis disposes the old one first; that old wrapper is then
    // still in the call chain and must keep working. Nulling these made every
    // such call die with "Cannot read properties of null (reading // 'dispatchRpc')" (measured live on 0.2.2-rc.1, spec 008). The retained
    // references are two functions and a flag — the cost is negligible.
  }

  /**
   * What the Devices page shows: whether remote routing is live, and why not.
   * A host whose last call was refused also carries that refusal (`error`), so the
   * page never presents an empty-but-connected host as a healthy one.
   *
   * `hosts` stays exactly the CONNECTED set (it is what the merged views read); a
   * paired host that is only momentarily away is reported separately in
   * `disconnected`, with how many of its sessions are still on screen from the
   * retention. That is the difference between "disconnected, read-only" and "no such
   * host", which the row has to be able to say.
   * @returns {{remote: boolean, reason: string|null, hosts: object[], disconnected: object[], merged: string[]}}
   */
  status() {
    let hosts = []
    try {
      hosts = this.#hosts().map((host) => {
        const hostId = String(host?.hostId ?? '')
        const error = this.#hostErrors.get(hostId)
        return {
          hostId,
          hostName: String(host?.hostName ?? host?.hostId ?? ''),
          online: host?.online !== false,
          // Only when there is something to say: an entry stays exactly as before
          // for a host that never refused a call.
          ...(error ? { error } : {}),
        }
      })
    } catch { hosts = [] }
    const disconnected = this.#disconnectedHosts().map((host) => ({
      hostId: host.hostId,
      hostName: String(host.hostName ?? host.hostId),
      online: false,
      // Rows the merged list still carries for it: 0 means the user simply has none
      // listed yet, which is not a failure.
      retainedSessions: (this.#retainedRows.get(host.hostId) ?? []).length,
    }))
    return {
      remote: this.#installed, reason: this.#installed ? null : this.#reason,
      hosts, disconnected, merged: [...MERGED_ENDPOINTS],
    }
  }

  /** Remember the last refusal of one host (the log line stays the audit trail). */
  #noteHostError(hostId, error) {
    if (typeof hostId !== 'string' || hostId === '') return
    this.#hostErrors.delete(hostId)
    this.#hostErrors.set(hostId, {
      code: typeof error?.code === 'string' ? error.code : 'error',
      // `auth/forbidden-scope` names the permission the caller lacked.
      ...(typeof error?.scope === 'string' ? { scope: error.scope } : {}),
      at: Date.now(),
    })
    while (this.#hostErrors.size > MAX_HOST_ERRORS) this.#hostErrors.delete(this.#hostErrors.keys().next().value)
  }

  // -- the carrier wrappers -------------------------------------------------

  #connectedHosts() {
    let hosts
    try { hosts = this.#hosts() } catch { return [] }
    return (Array.isArray(hosts) ? hosts : []).filter((host) => host && typeof host.hostId === 'string' && host.online !== false)
  }

  /**
   * Whether this controller has NO host at all — none connected and none paired
   * (`deps.knownHosts`, which a caller that omits it reports as none).
   *
   * A pairing is a different product: with one, a connected host's rows are merged
   * and a disconnected one's rows are retained, so both carriers have work to do.
   * With none, the carrier wrapper has nothing to route, rename or hold back, and
   * standing between the UI and Local only lets the merge's own shapes — the
   * `{args:…}` envelope, a re-baselined `replace`, an increment it does not model —
   * differ from the Local call the UI made (owner, 2026-11-16, zero hosts: "New
   * chat → choose workspace" bounced back to "Choose workspace").
   */
  #noPairedHosts() {
    if (this.#connectedHosts().length > 0) return false
    return this.#disconnectedHosts().length === 0
  }

  /**
   * Whether a call is purely Local and may therefore pass the carrier untouched
   * (see `#noPairedHosts`). True only when the controller has no paired host AND
   * the payload names no remote route of any kind: no host id, no host hint, and
   * no provider tagged `<provider>@<hostId>`.
   *
   * The provider tag is checked because it names a host on its own: a selection
   * tagged for `hostB` says "run this on hostB", so passing it through would run
   * it here instead. `routedProvider` must get the chance to refuse it
   * (`model/wrong-host`) or route it, exactly as with a pairing present.
   * @param {string} endpoint the call being dispatched
   * @param {object} payload the call as the local UI issued it
   */
  #isPurelyLocal(endpoint, payload) {
    if (!this.#noPairedHosts()) return false
    if (hostIdsIn(payload).size > 0 || hostHintOf(payload) !== null) return false
    return !carriesTaggedProvider(endpoint, payload)
  }

  #hostById(hostId) {
    return this.#connectedHosts().find((host) => host.hostId === hostId)
  }

  /** The connected hosts as one comparable key (order-independent). */
  #connectedKey() {
    return this.#connectedHosts().map((host) => host.hostId).sort().join('\u0000')
  }

  /**
   * Tell the native UI to reload the merged model catalog when the catalog it is
   * holding does not already cover the connected hosts.
   *
   * The picker keeps one catalog per Host generation (`ModelCatalogDirectory`, no
   * session argument) and reloads it on `llm/models-updated`, so the decision may
   * not rest on a connect/disconnect edge alone: a catalog loaded while a host was
   * still linking, or one answered while that host's catalog call was failing, has
   * the host missing with no further edge ever coming — the picker stayed
   * Local-only and every remote pick was then refused by `routedProvider`
   * (`remote/wrong-host`) from a section that should not have been offered. So the
   * rule is state, not edge: compare the connected hosts against `#catalogHostKey`,
   * the hosts the last merged catalog actually included, and reload only when they
   * differ. An equal key means the picker already has every section, and a flap
   * that leaves the set unchanged still emits nothing.
   *
   * `withdraw` tells the caller that leaving hosts have already been dropped from
   * the merged answers (cards withdrawn, rows replayed). Their sections are only
   * correct in that caller's hands: it announces its own decision first, so a frame
   * queued for a stream this change is about to end is not ported into the next one.
   */
  #announceHostSet({ withdraw = false } = {}) {
    const key = this.#connectedKey()
    const changed = key !== this.#lastHostSet
    this.#lastHostSet = key
    // A joining host changes the key by construction (see `#catalogStale`).
    if (withdraw) {
      if (changed) this.#emitCatalogRefresh()
      return
    }
    if (!this.#catalogRefreshDue()) this.#catalogRefreshPending = false
    else this.#catalogRefreshPending = !this.#emitCatalogRefresh()
  }

  /**
   * Whether the merge of `connected` left the last merged catalog short of any
   * connected host (`#catalogHostKey`). A missing key means no merge has answered
   * since the router was installed, so nothing about the picker's catalog is known.
   * An empty set needs no section, whatever the key says.
   */
  #catalogStale(connected = this.#connectedHosts()) {
    if (connected.length === 0 || this.#catalogHostKey === null) return false
    return catalogKey(connected) !== this.#catalogHostKey
  }

  /**
   * Whether the picker must be told to reload before the merged answers are trusted:
   * the connected set is not what the last answer included, or an earlier attempt was
   * held back by the rate limit.
   */
  #catalogRefreshDue(connected = this.#connectedHosts()) {
    if (this.#catalogRefreshPending) return true
    if (!this.#catalogStale(connected)) return false
    // Already told the picker about THIS missing section: a picker reload is not a
    // new host set, so it must not re-arm the announcement (see #catalogAnnouncedKey).
    return catalogKey(connected) !== this.#catalogAnnouncedKey
  }

  /**
   * Ask the picker to reload: at most once per `MODEL_CATALOG_ANNOUNCE_INTERVAL_MS`.
   * The frame's exact three keys are what the client's `$events` parser accepts;
   * `args` is a list, empty here because every listener takes no argument that
   * matters for a full reload.
   * @returns {boolean} whether the frame was sent (a rate limit is false, so the
   *   caller knows the picker was NOT told and its next chance is not a frame it
   *   queued for a stream this one superseded)
   */
  #emitCatalogRefresh() {
    const now = Date.now()
    const waited = now - this.#lastAnnounceAt
    if (waited < MODEL_CATALOG_ANNOUNCE_INTERVAL_MS) {
      // The picker is still owed this frame. A rate limit that is never retried would
      // lose it for good — a host leaving inside the window left the picker showing a
      // section whose Host is gone, and nothing else would ever say so.
      this.#scheduleCatalogRefresh(MODEL_CATALOG_ANNOUNCE_INTERVAL_MS - waited)
      return false
    }
    this.#lastAnnounceAt = now
    this.#publishEvent({ type: 'emit', event: MODEL_CATALOG_REFRESH_EVENT, args: [] })
    return true
  }

  /**
   * Retry a rate-limited announcement once the window has passed. One timer at a
   * time; it is cleared when the router uninstalls, so nothing fires after teardown.
   * @param {number} delayMs
   */
  #scheduleCatalogRefresh(delayMs) {
    if (this.#catalogTimer !== null || typeof setTimeout !== 'function') return
    this.#catalogTimer = setTimeout(() => {
      this.#catalogTimer = null
      if (!this.#catalogRefreshDue()) return
      this.#catalogRefreshPending = !this.#emitCatalogRefresh()
    }, Math.max(1, delayMs))
    this.#catalogTimer?.unref?.()
  }

  /**
   * Strip the hint, the display suffix and any id tag, then check that no tag
   * survives. `hostId` is the host the call was routed to, so its suffix is the
   * only one that can be ours.
   */
  #forwardArgs(payload, hostId) {
    const args = withoutHint(payloadArgs(payload))
    const host = this.#hostById(hostId)
    return stripHostIds(host ? withoutWorkspaceTitle(args, host.hostName ?? hostId) : args, hostId)
  }

  #assertNoNamespace(args, hostId) {
    const leaked = hostIdsIn(args)
    if (leaked.size === 0) return
    throw new HostRouterError('remote/id-leak',
      `refusing to send a namespaced id to ${hostId}; this would expose another host's namespace`,
      { hosts: [...leaked] })
  }

  /**
   * EVERYTHING a remote Host sends passes through here: results, merged rows,
   * stream frames, cache replays and interaction cards.
   *
   * The ids are opaque, so they are wrapped in the authenticated source host's
   * namespace unconditionally — never trusted as already tagged. A payload that
   * already carries a tag is refused (`remote/id-leak`, logged without the value)
   * and a payload nested past MAX_ID_DEPTH is refused (`remote/payload-too-deep`).
   * A model selection carried by the payload gets its provider tagged for the same
   * host (`<provider>@<hostId>`, see `namespaceIds`): the picker compares it with
   * the merged catalog, which names remote providers the same way.
   * @param {string} hostId the host the payload actually arrived from
   * @param {unknown} value the payload
   * @param {string} what endpoint or frame name, for the log line
   */
  #ingress(hostId, value, what) {
    this.#refuseTagged(hostId, value, what)
    try {
      return namespaceIds(value, hostId)
    } catch (error) {
      if (error?.code === 'remote/payload-too-deep') this.#log(`${what} from ${hostId} refused: ${error.code}`)
      throw error
    }
  }

  /**
   * Refuse a remote payload whose id already carries a namespace tag, without
   * renaming anything (the merged workspace map renames as it stores).
   * @returns {unknown} the same value, when it is clean
   */
  #refuseTagged(hostId, value, what) {
    if (taggedIdsIn(value).size === 0 && !hasPseudoTaggedCallId(value)) return value
    this.#log(`${what} from ${hostId} refused: remote/id-leak`)
    throw new HostRouterError('remote/id-leak',
      `${what} from ${hostId} carried an id that already names a host namespace; the payload was refused`,
      { hostId })
  }

  /**
   * Decide where one call goes, from the ids in its payload.
   * @returns {{kind: 'local'} | {kind: 'remote', hostId: string, hostName: string, connection: object}}
   */
  #route(payload) {
    const named = hostIdsIn(payload)
    if (named.size > 1) {
      throw new HostRouterError('remote/host-conflict', 'this call names more than one remote host; a call must belong to one host', { hosts: [...named] })
    }
    let hostId = named.size === 1 ? [...named][0] : null
    // Global endpoints (llm/*, skills/list, settings/…) have no id to route by,
    // so the client names the host explicitly; the tag always wins over the hint.
    if (hostId === null) hostId = hostHintOf(payload)
    if (hostId === null) return { kind: 'local' }
    const host = this.#hostById(hostId)
    if (!host || typeof host.connection !== 'object' || host.connection === null) {
      throw new HostRouterError('remote/host-offline', `remote host ${hostId} is not connected; reconnect it in Settings → Devices`, { hostId })
    }
    return { kind: 'remote', hostId, hostName: host.hostName ?? hostId, connection: host.connection }
  }

  /**
   * A reorder moves one row next to `beforeWorkspaceId` / `beforeSessionId`. The
   * merged sidebar renders Local and every remote Workspace in ONE list, so it can
   * hand back an anchor that belongs to a different list than the row being moved —
   * but each Host stores its own durable order and no Host can express a position in
   * another's (or in Local's). Such a drag is refused here, once, with a code the UI
   * can show; forwarding it would ask a Host to place a row it does not own.
   *
   * This is the mover/anchor counterpart of `#route`'s one-host rule, and it is
   * deliberately narrow: only the two reorder endpoints carry an anchor, and only
   * they are checked. An omitted anchor (append) is always same-list by definition.
   * @param {string} endpoint the call being dispatched
   * @param {object} payload the call as the local UI issued it
   */
  #assertSameReorderList(endpoint, payload) {
    const args = payloadArgs(payload)
    const anchorKey = Object.hasOwn(REORDER_ANCHOR_FIELDS, endpoint) ? REORDER_ANCHOR_FIELDS[endpoint] : undefined
    if (anchorKey === undefined) return
    const anchor = args[anchorKey]
    // No anchor appends within the mover's own list: nothing crosses.
    if (typeof anchor !== 'string' || anchor === '') return
    const movedHost = hostIdOfId(typeof args.workspaceId === 'string' ? args.workspaceId : '')
    const anchorHost = hostIdOfId(anchor)
    if (movedHost === anchorHost) return
    // The two ways to cross a boundary, each named so the row can say which list the
    // user aimed at instead of dropping the drag on the floor.
    const listOf = (hostId) => (hostId === null ? 'Local' : `remote host ${hostId}`)
    throw new HostRouterError('remote/reorder-cross-host',
      `a reorder cannot place a row of ${listOf(movedHost)} next to a row of ${listOf(anchorHost)}; `
      + 'each list keeps its own order', { movedHost, anchorHost })
  }

  #localDispatch(endpoint, payload, signal, peer) {
    const target = this.#root?.dispatchRpc ?? rootOriginal(this.#gateway.dispatchRpc)
    if (typeof target !== 'function') {
      throw new HostRouterError('remote/unavailable',
        'this Host does not expose the Gateway carrier (dispatchRpc); the remote bridge is unavailable')
    }
    return Reflect.apply(target, this.#gateway, [endpoint, payload, signal, peer])
  }

  #localOpen(endpoint, payload, uplink, peer, signal, control, uplinkWindow) {
    const openWireStream = this.#root?.openWireStream ?? rootOriginal(this.#gateway.openWireStream)
    const { rc1 } = this.#originals ?? { rc1: true }
    return rc1
      ? Reflect.apply(openWireStream, this.#gateway, [endpoint, payload, uplink, peer, signal, control, uplinkWindow])
      : Reflect.apply(openWireStream, this.#gateway, [endpoint, payload, signal])
  }

  async #dispatchRpc(endpoint, payload, signal, peer) {
    // Zero PAIRED hosts is the plain local product: there is nothing to route to,
    // rename for or hold back, so the carrier is the pure call it wrapped. Local's
    // own reply and payload therefore reach the UI byte for byte.
    if (this.#isPurelyLocal(endpoint, payload)) {
      return this.#localDispatch(endpoint, payload, signal, peer)
    }
    // A merged endpoint answers for Local plus every connected host at once; the
    // client-side hint does not narrow it (each row carries its own hostId, the // page filters there). Only a tagged id could name one host — a list request
    // never carries one.
    if (endpoint === 'session/list' && hostIdsIn(payload).size === 0) return this.#mergeSessionList(payload, signal, peer)
    // The picker loads this one globally (no session id, no host hint), so it is
    // merged for the same reason `session/list` is.
    if (endpoint === MODEL_CATALOG_ENDPOINT && hostIdsIn(payload).size === 0) return this.#mergeModelCatalog(payload, signal, peer)
    let target
    try {
      // A drag that spans two lists cannot be stored by any one Host (the merged // sidebar draws them as one list; the durable orders are separate). Refused
      // before routing, so neither a Host nor Local is asked to place a foreign row.
      this.#assertSameReorderList(endpoint, payload)
      target = this.#route(payload)
    } catch (error) {
      return { ok: false, error: failureOf(error) }
    }
    // A model selection names a provider, and a provider belongs to the Host that
    // serves it. The UI sends the merged id (`<provider>@<hostId>`), so the tag is
    // taken off for the Host it names, and a tag naming any other Host — or an
    // untagged provider on a remote session — is refused rather than rerouted.
    let args = payload
    if (endpoint === MODEL_SELECT_ENDPOINT) {
      try {
        args = { ...payload, args: retargetSelections(payloadArgs(payload), target.kind === 'remote' ? target.hostId : null) }
      } catch (error) {
        return { ok: false, error: failureOf(error) }
      }
    }
    if (target.kind === 'local') {
      // Unchanged for Local.
      return this.#localDispatch(endpoint, args, signal, peer)
    }
    try {
      if (endpoint === APPROVAL_RESULT_ENDPOINT) return { ok: true, value: await this.#answerCard(target, payload, signal) }
      const forwarded = this.#forwardArgs(args, target.hostId)
      this.#assertNoNamespace(forwarded, target.hostId)
      const value = this.#ingress(target.hostId, await target.connection.call(endpoint, forwarded, { signal }), endpoint)
      return binaryResultEnvelope(value) ?? { ok: true, value }
    } catch (error) {
      return { ok: false, error: failureOf(error) }
    }
  }

  /**
   * The card we injected for these ids (by any of its correlation ids), or null.
   * The table is small and bounded, so a scan is the simple honest lookup.
   */
  #card(hostId, ids) {
    const wanted = [ids?.rpcId, ids?.eventId, ids?.approvalId].filter((id) => typeof id === 'string' && id !== '')
    if (wanted.length === 0) return null
    for (const entry of this.#cards.values()) {
      if (entry.hostId !== hostId) continue
      if (wanted.includes(entry.rpcId) || (entry.approvalId !== undefined && wanted.includes(entry.approvalId))) return entry
    }
    return null
  }

  /**
   * `$events/result` for a remote `$events` card: an approval goes through the
   * bridge's hash-bound decision path, a question through the `question-answer`
   * companion frame to the gateway that minted it. Both carry the original ids of
   * the card the Host issued.
   */
  async #answerCard(target, payload, signal) {
    const args = this.#forwardArgs(payload, target.hostId)
    this.#assertNoNamespace(args, target.hostId)
    const card = this.#card(target.hostId, args)
    if (card?.kind === 'question') return this.#answerQuestion(target, card, args, signal)
    return this.#decideRemote(target, args, card, signal)
  }

  /**
   * The bridge never forwards `$events/result` raw: it maps the call onto its
   * hash-bound approval decision. The hash must be the one the Host issued for
   * that card — a decision the UI cannot bind is refused here, not silently
   * applied (the request stays pending on the Host, which is what a mismatching * hash gets from the bridge as a normal `accepted:false` receipt).
   *
   * @param {object} args the decision with local ids already stripped
   * @param {object|null} card the card this router injected, when it knows it
   */
  async #decideRemote(target, args, card, signal) {
    let decision = args
    if (!(typeof args.argsHash === 'string' && APPROVAL_HASH.test(args.argsHash))) {
      const buffered = this.#approvals?.card?.(target.hostId, args)
      const binding = card ?? buffered
      if (!binding || typeof binding.argsHash !== 'string' || !APPROVAL_HASH.test(binding.argsHash)) {
        throw new HostRouterError('remote/approval-unbound', 'the approval card for this decision is not available on this host; the decision was not sent')
      }
      decision = { ...args, argsHash: binding.argsHash }
      if (decision.eventId === undefined && binding.rpcId !== undefined) decision.eventId = binding.rpcId
      if (decision.rpcId === undefined && binding.rpcId !== undefined) decision.rpcId = binding.rpcId
      if (decision.approvalId === undefined && binding.approvalId !== undefined) decision.approvalId = binding.approvalId
      if (decision.sessionId === undefined && binding.sessionId !== undefined) decision.sessionId = binding.sessionId
    } else if (card) {
      // The UI echoed a hash: keep it verbatim (the Host is the authority on // whether it still matches) but complete the ids the Host needs.
      decision = { ...args }
      if (decision.rpcId === undefined) decision.rpcId = card.rpcId
      if (decision.sessionId === undefined) decision.sessionId = card.sessionId
      if (decision.approvalId === undefined && card.approvalId !== undefined) decision.approvalId = card.approvalId
    }
    const receipt = await target.connection.call(APPROVAL_RESULT_ENDPOINT, decision, { signal })
    // A decided card is no longer addressable; the native UI already closed it.
    if (card && receipt?.accepted === true) this.#forgetCard(card, false)
    return this.#ingress(target.hostId, receipt, APPROVAL_RESULT_ENDPOINT)
  }

  /**
   * An ACTIVE question is answered on the GATEWAY that minted the card, with the
   * `question-answer` companion frame: the gateway owns `pendingQuestions[rpcId]`
   * and settles the Host's tool call when it accepts a response
   * (plugins/mobile-gateway/lib/index.mjs:2678-2729, 4670-4677). The ids and the
   * answer come only from the tracked card and the native submit — nothing is
   * guessed. `RemoteConnection.request()` echoes `requestId` on the receipt, which
   * is how this one answer is correlated (lib/remote-client.mjs:866-893).
   *
   * `userQuestions/answer` is NOT the active path: the Host's question service
   * looks only in `continued(agent)` and returns false for an open question
   * (dsh-user-questions/src/index.ts:152-173). It is a CONTINUED-only fallback, and
   * only runs after the gateway has evidenced `not-pending` — and the Host's own
   * `true` reply then verifies the continued state. Anything else is a visible
   * refusal that keeps the card tracked and retryable, never a silent drop.
   */
  async #answerQuestion(target, card, args, signal) {
    const outcome = isPlainObject(args.outcome) ? args.outcome : {}
    const value = isPlainObject(outcome.value) ? outcome.value : {}
    const answers = Array.isArray(value.answers) ? value.answers : (Array.isArray(outcome.answers) ? outcome.answers : null)
    /** One normal receipt. A refusal never closes the card on the native stream. */
    const receipt = (accepted, action = 'answer', reason) => this.#ingress(target.hostId, {
      kind: 'question-response', rpcId: card.rpcId, sessionId: card.sessionId, action, accepted,
      ...(accepted ? {} : { reason: reason ?? 'not-accepted' }),
    }, QUESTION_ANSWER_TYPE)
    /** An `error` frame (bad-request/bad-response) is surfaced, never rewritten into acceptance. */
    const errorCode = (frame) => typeof frame?.code === 'string' && frame.code !== '' ? frame.code : 'refused'

    // An explicit user "skip" ends the same pending card with `question-cancel`.
    // A timeout/abort (ASK_ABORTED/ASK_TIMED_OUT) is already settled on the Host,
    // so it must not spend a second response on the gateway.
    if (outcome.kind === 'rejected' && QUESTION_CANCEL_CODES.has(outcome.error?.code)) {
      let cancelled
      try {
        cancelled = await target.connection.request({
          type: QUESTION_CANCEL_TYPE, rpcId: card.rpcId, sessionId: card.sessionId,
        }, { signal })
      } catch (error) {
        if (error?.code === 'cancelled') return receipt(false, 'cancel', 'cancelled')
        throw error
      }
      if (cancelled?.kind === 'error') return receipt(false, 'cancel', errorCode(cancelled))
      if (cancelled?.accepted !== true) return receipt(false, 'cancel', cancelled?.reason)
      this.#forgetCard(card, false)
      return receipt(true, 'cancel')
    }

    if (outcome.kind !== 'result' || answers === null) return receipt(false, 'answer', 'no-answer')

    let reply
    try {
      reply = await target.connection.request({
        type: QUESTION_ANSWER_TYPE, rpcId: card.rpcId, sessionId: card.sessionId, answers,
      }, { signal })
    } catch (error) {
      // A caller that cancelled its own wait is still a receipt, not a link failure.
      if (error?.code === 'cancelled') return receipt(false, 'answer', 'cancelled')
      throw error
    }
    // The gateway's refusal shapes stay visible. In particular its device-only
    // answer policy (`index.mjs:2525-2567`) refuses a custom/empty selection with
    // `bad-response`: the router MUST NOT relax that here, so it forwards the code.
    if (reply?.kind === 'error') return receipt(false, 'answer', errorCode(reply))
    if (reply?.kind !== 'question-response') return receipt(false, 'answer', 'invalid-response')
    if (reply.accepted === true) {
      // Accepted ⇒ the card is spent. The duplicate cannot reach the gateway again.
      this.#forgetCard(card, false)
      return receipt(true)
    }
    const reason = typeof reply.reason === 'string' && reply.reason !== '' ? reply.reason : 'not-accepted'
    if (reason === 'not-pending') {
      // The gateway no longer holds the card. Only now may the Host's CONTINUED
      // service be asked: its `true` is the verification that the question is in
      // `continued` state (a settled open question returns false). A refusal here
      // is reported as-is, never retried against the gateway a second time.
      return this.#answerContinued(target, card, answers, signal)
    }
    return receipt(false, 'answer', reason)
  }

  /**
   * CONTINUED-only fallback. `userQuestions/answer` returns false unless the Host
   * still holds this call in `continued` state, so `true` is both the application
   * and the verification. Its two error codes mean "nothing was applied" and stay
   * retryable refusals, as does a missing tool-call id (the only id this service
   * keys by) — none of them is a transport failure that tears down the card.
   */
  async #answerContinued(target, card, answers, signal) {
    const receipt = (accepted, reason) => this.#ingress(target.hostId, {
      kind: 'question-response', rpcId: card.rpcId, sessionId: card.sessionId,
      action: 'answer', accepted, ...(accepted ? {} : { reason }),
    }, QUESTION_ANSWER_TYPE)
    if (typeof card.callId !== 'string' || card.callId === '') {
      this.#log(`continued question answer for ${target.hostId} not sent: the card carries no tool-call id`)
      return receipt(false, 'unbound')
    }
    let answered
    try {
      answered = await target.connection.call(QUESTION_CONTINUED_ENDPOINT, {
        agentId: card.sessionId, callId: card.callId, answer: { answers },
      }, { signal })
    } catch (error) {
      const code = typeof error?.code === 'string' ? error.code : ''
      if (code === 'REPLY_QUEUED' || code === 'BAD_ANSWER' || code === 'cancelled') {
        this.#log(`continued question answer for ${target.hostId} not accepted: ${code}`)
        return receipt(false, code)
      }
      throw error
    }
    if (answered !== true) {
      this.#log(`continued question answer for ${target.hostId} not accepted by the Host`)
      return receipt(false, 'not-continued')
    }
    this.#forgetCard(card, false)
    return receipt(true)
  }

  /**
   * `session/list` for the sidebar's two tabs: "This Computer" is Local alone, "Remote
   * Workspace" is every paired host alone. Neither view merges the other. The
   * client-side host hint does not narrow it (each row carries its own hostId).
   *
   * The list is not paginated — the rc.1 `session/list` result carries no
   * cursor and a page cursor minted by one Host cannot be resumed against the
   * merged view, so the request's `cursor` is dropped for both sides and the
   * complete merged list is returned. A failing remote contributes nothing (a
   * dead host must not break the list); it is logged and shown by `status()`. Its
   * half is still read while "This Computer" is showing, so the rows of a paired
   * host are retained and switching to it is instant.
   *
   * A remote row is also stripped of its `cwd` (`withoutRemoteCwd`): the native
   * "Show in folder" item is enabled by that field and would open this machine's
   * file manager at a directory on the other machine. Local rows keep theirs.
   */
  async #mergeSessionList(payload, signal, peer) {
    const raw = { ...payloadArgs(payload) }
    delete raw.cursor
    const args = withoutHint(raw)
    // The Gateway carrier forwards exactly one `args` field; a client-side hint
    // (or any other top-level key) must not travel with the merged request.
    const local = await this.#localDispatch('session/list', { args }, signal, peer)
    if (!local || local.ok !== true) return local
    const items = Array.isArray(local.value?.items) ? [...local.value.items] : []
    const hosts = this.#connectedHosts()
    const answered = new Set()
    const remote = await Promise.all(hosts.map(async (host) => {
      try {
        const value = await host.connection.call('session/list', args, { signal })
        const rows = Array.isArray(value?.items) ? value.items : []
        if (!rows.every(isSessionSummaryRow)) {
          this.#log('session/list refused: malformed-session-row')
          return this.#retainedRows.get(host.hostId) ?? []
        }
        // Each row is remote data: a row that names a host namespace is refused
        // and takes that host's whole contribution with it.
        const renamed = rows.map((row) => withoutRemoteCwd(this.#ingress(host.hostId, row, 'session/list row')))
        this.#hostErrors.delete(host.hostId)
        answered.add(host.hostId)
        this.#rememberRows(host.hostId, renamed)
        return renamed
      } catch (error) {
        this.#noteHostError(host.hostId, error)
        this.#log(`session/list from ${host.hostId} failed: ${error?.code ?? 'error'}`)
        // A host that just failed is offline as far as the list is concerned: its
        // last-known rows keep the user's sessions on screen (read-only) instead of
        // making them vanish. A refusal with a real answer (`auth/forbidden-scope`)
        // lists nothing, so retention would only resurrect a list that host no longer
        // grants — those rows are dropped instead.
        return this.#retainedOrNothing(host.hostId, error)
      }
    }))
    for (const rows of remote) items.push(...rows)
    // A host that is paired but not connected contributes what it last told us.
    for (const host of this.#disconnectedHosts()) {
      if (answered.has(host.hostId)) continue
      items.push(...(this.#retainedRows.get(host.hostId) ?? []))
    }
    // Stable sort: equal `updatedAt` keeps Local first, then host order.
    items.sort((a, b) => Number(b?.updatedAt ?? 0) - Number(a?.updatedAt ?? 0))
    return { ...local, value: { ...(isPlainObject(local.value) ? local.value : {}), items } }
  }

  /**
   * Remember one host's last `session/list` rows (already renamed, already stripped).
   * Retention is bounded and never applies to a host this controller has forgotten:
   * only a paired host is ever replayed (see `#disconnectedHosts`).
   */
  #rememberRows(hostId, rows) {
    if (typeof hostId !== 'string' || hostId === '') return
    this.#retainedRows.delete(hostId)
    this.#retainedRows.set(hostId, rows)
    while (this.#retainedRows.size > MAX_RETAINED_HOSTS) {
      this.#retainedRows.delete(this.#retainedRows.keys().next().value)
    }
  }

  /**
   * What a host contributes when its `session/list` call failed.
   *
   * A transport failure (`remote/host-offline`, a closed socket, a timeout) leaves the
   * rows it last listed intact: they are the user's sessions and their host is only
   * momentarily away. A refusal the Host itself produced (`auth/forbidden-scope`, a * protocol error) means the answer is "nothing for you", so the retained rows are
   * dropped rather than shown behind a permission that no longer exists.
   * @returns {object[]} the rows this failing host still contributes
   */
  #retainedOrNothing(hostId, error) {
    if (!isLinkFailure(error)) {
      // The Host spoke and refused: it grants nothing, so nothing is retained.
      this.#retainedRows.delete(hostId)
      return []
    }
    return this.#retainedRows.get(hostId) ?? []
  }

  /**
   * The PAIRED hosts that hold no live link right now, from `deps.knownHosts`.
   * Their rows are retained, so the merged list still carries them; the Devices page
   * marks them disconnected from the same host set. A controller mounted without
   * `knownHosts` (a router test harness, an older caller) reports none, which is
   * exactly the pre-retention answer.
   */
  #disconnectedHosts() {
    if (!this.#knownHosts) return []
    let known
    try { known = this.#knownHosts() } catch { return [] }
    const connected = new Set(this.#connectedHosts().map((host) => host.hostId))
    return (Array.isArray(known) ? known : [])
      .filter((host) => host && typeof host.hostId === 'string' && host.hostId !== '' && !connected.has(host.hostId))
  }

  /**
   * Drop everything retained for one host: the one caller is an explicit
   * forget/revoke. A transient disconnect keeps the rows (that is the point of the * retention), so this must never be reached from a state change.
   *
   * The host's follow pumps are ended here too: a forgot/revoked host can never
   * come back, so a pump waiting for it would keep the reader's stream open with
   * nothing coming. Ending them lets each stream close normally (or with the * refusal it was holding) instead of stalling.
   * @returns {boolean} whether anything was retained for `hostId`
   */
  forgetHost(hostId) {
    if (typeof hostId !== 'string' || hostId === '') return false
    this.#hostErrors.delete(hostId)
    this.#forgetInboxHost(hostId)
    const stops = this.#followStops.get(hostId)
    this.#followStops.delete(hostId)
    if (stops) for (const stop of [...stops]) stop()
    return this.#retainedRows.delete(hostId)
  }

  /** Drop both namespaced watermarks/values of one forgotten Host. */
  #forgetInboxHost(hostId) {
    const prefix = `${HOST_PREFIX}${hostId}:`
    for (const map of [this.#fallbackControlSeqs, this.#inboxStates]) {
      for (const key of [...map.keys()]) if (key.startsWith(prefix)) map.delete(key)
    }
  }

  /** Remember one host's follow stop, so `forgetHost` can end it. */
  #trackFollow(hostId, stop) {
    let stops = this.#followStops.get(hostId)
    if (!stops) { stops = new Set(); this.#followStops.set(hostId, stops) }
    stops.add(stop)
  }

  #untrackFollow(hostId, stop) {
    const stops = this.#followStops.get(hostId)
    if (!stops) return
    stops.delete(stop)
    if (stops.size === 0) this.#followStops.delete(hostId)
  }

  /**
   * `session/modelCatalog` merged: Local's groups, then every connected host's.
   *
   * The native picker loads ONE catalog per Host generation — the endpoint takes no
   * argument, so there is no way to ask it for a session's host only — and it
   * decides whether a session's own selection is selectable by looking the
   * projection's `provider`/`model` up in that catalog (`ModelDirectory.syncInputs`:
   * `groups.some(group => group.id === selection.provider && …model.id === selection.model)`),
   * which is also how it marks the current row (`state.current?.provider === group.id`)
   * and how the reasoning table is keyed (`[group.id, model.id]`). Both sides of
   * that comparison therefore have to carry the same provider id, and a remote
   * provider must not share an id with a Local one — otherwise the picker would
   * offer a remote model under an id that routes to this Host, or mark a remote
   * selection as the Local current one.
   *
   * So a remote group is renamed `<provider>@<hostId>` and keeps all of its models
   * (`#labelledGroups`); Local's groups are passed through untouched and stay
   * first, so the picker's own order is Local, then one section per Host. The tag
   * is the same one `namespaceIds` puts on a projected selection, and
   * `session/selectModel` takes it off again (`routedProvider`).
   *
   * `catalog.default` stays Local's: the picker falls back to it when a session has
   * no recorded selection (`projected.next ?? catalog.value.default`), and a remote
   * default there would be a cross-host selection for every session that has not
   * chosen yet. `routableProviders` is derived from the groups on the Host, so it
   * is recomputed here rather than copied from Local; `failures` stays Local's,
   * because a Host's own provider failures are that Host's business and are shown
   * on its Devices row by `status()`.
   *
   * Nothing here is renamed as an id: the rename table covers DSH ids, and a
   * catalog carries none (a provider/model id is a routing label, never an id this * controller mints).
   *
   * A failing remote is asked once more (`#hostCatalog`) and then contributes
   * nothing (a dead host must not break the local catalog); it is logged and shown
   * by `status()`. The same holds for a remote whose catalog carries an id that
   * already names a host namespace: the payload is refused (`remote/id-leak`) and
   * that host contributes nothing. An answer that leaves a connected host out is
   * recorded in `#catalogHostKey`, so a picker that caches it is told to reload.
   */
  async #mergeModelCatalog(payload, signal, peer) {
    const args = withoutHint({ ...payloadArgs(payload) })
    const local = await this.#localDispatch(MODEL_CATALOG_ENDPOINT, { args }, signal, peer)
    if (!local || local.ok !== true) return local
    const localValue = isPlainObject(local.value) ? local.value : {}
    const groups = (Array.isArray(localValue.groups) ? localValue.groups : [])
      .filter((group) => isPlainObject(group))
      .map((group) => ({ ...group, models: Array.isArray(group.models) ? [...group.models] : [] }))
    const hosts = this.#connectedHosts()
    const asked = new Map()
    const answered = await Promise.all(hosts.map((host) => this.#hostCatalog(host, args, signal, asked)))
    // Labelled in host order after every host answered, so the sections always
    // follow the same host order. Two hosts offering the same provider/model stay
    // two entries: they are two different selections.
    for (const entry of answered) groups.push(...this.#labelledGroups(entry.host, entry.value))
    const routableProviders = [...new Set(groups.map((group) => String(group.id)))]
    // What this answer actually covers, for the announcement that compares it with
    // the connected set: a host whose catalog failed (after its retry) is absent,
    // and the picker must be told to reload once it can answer.
    const included = answered.filter((entry) => isPlainObject(entry.value)).map((entry) => entry.host)
    this.#catalogHostKey = catalogKey(included)
    // Announce the ENTRY into a stale state, not the state itself: a host whose
    // catalog keeps failing is stale again on every picker reload, so re-announcing
    // it here would drive a reload → merge → emit → reload loop. A different set (a
    // new or recovered host) or a fresh catalog re-arms the one announcement.
    const staleKey = this.#catalogStale(hosts) ? catalogKey(hosts) : null
    if (staleKey === null) {
      this.#catalogAnnouncedKey = null
      this.#catalogRefreshPending = false
    } else if (staleKey !== this.#catalogAnnouncedKey) {
      this.#catalogAnnouncedKey = staleKey
      this.#catalogRefreshPending = this.#eventSinks.size > 0 ? !this.#emitCatalogRefresh() : true
    }
    return { ...local, value: { ...localValue, groups, routableProviders } }
  }

  /**
   * One host's `session/modelCatalog` answer, for a merge that answers the picker.
   *
   * A host that is connected but whose catalog call fails would otherwise be
   * silently missing from the merged answer, and the picker caches that answer: its
   * sessions then show a selection from a section that no longer exists. One retry,
   * bounded, is enough for the usual cause — a catalog asked while the host's link
   * was still coming up — and costs a failing host one extra call per load, not a
   * loop. `asked` makes the calls of one merge idempotent per host, so a catalog
   * asked for a second time while the first is still running is answered by it
   * instead of sending a third call to that host.
   * @param {object} host the connected host
   * @param {object} args the catalog args, forwarded as-is
   * @param {AbortSignal|undefined} signal the caller's signal
   * @param {Map<string, Promise<{host: object, value: unknown}>>} asked this merge's
   *   own calls, keyed by host
   */
  #hostCatalog(host, args, signal, asked) {
    const pending = asked.get(host.hostId)
    if (pending) return pending
    const attempt = async () => {
      try {
        const value = await host.connection.call(MODEL_CATALOG_ENDPOINT, args, { signal })
        // An id that already names a namespace is a leak, never a rename target:
        // the cursor-context merge performs no rename either.
        this.#refuseTagged(host.hostId, value, MODEL_CATALOG_ENDPOINT)
        this.#hostErrors.delete(host.hostId)
        return { host, value }
      } catch (error) {
        this.#noteHostError(host.hostId, error)
        this.#log(`session/modelCatalog from ${host.hostId} failed: ${error?.code ?? 'error'}`)
        return { host, value: null }
      }
    }
    const promise = (async () => {
      const first = await attempt()
      if (isPlainObject(first.value)) return first
      this.#log(`session/modelCatalog from ${host.hostId}: one retry before answering without it`)
      return attempt()
    })()
    asked.set(host.hostId, promise)
    return promise
  }

  /**
   * One host's catalog groups, ready to merge: every group kept, its id tagged with
   * the owning host and its header naming that host (`Remote · Sigma-DSH — R9 * Fallback`). A group with no usable model is dropped, so the menu never shows an
   * empty provider.
   *
   * The header is the only field the picker renders for a provider and it has no
   * separate slot for a host, so the host label has to fit inside it; the whole
   * string is capped because the host name is user-set and the provider name is the
   * remote's own text. Model labels are capped the same way; a model ID is not, since
   * an id is what a selection sends back and a cut one would name nothing — a model
   * whose id is over the cap is dropped instead.
   *
   * A group id that already contains the host tag separator is dropped, never
   * re-tagged: `<provider>@<hostId>` is the shape this module mints, so a remote id
   * carrying one is either a leak or a collision, and either way the picker would
   * compare it against the wrong host.
   * @param {object} host the connected host
   * @param {unknown} value the Host's `session/modelCatalog` result, or null when it failed
   */
  #labelledGroups(host, value) {
    if (!isPlainObject(value)) return []
    const label = host.hostName ?? host.hostId
    const prefix = `${REMOTE_GROUP_LABEL}${WORKSPACE_HOST_SEPARATOR}${label}${REMOTE_PROVIDER_SEPARATOR}`
    const out = []
    for (const group of Array.isArray(value.groups) ? value.groups : []) {
      if (!isPlainObject(group) || typeof group.id !== 'string' || group.id === '') continue
      if (group.id.includes(PROVIDER_HOST_SEPARATOR) || group.id.length > MAX_REMOTE_GROUP_NAME) continue
      const models = []
      for (const model of Array.isArray(group.models) ? group.models : []) {
        if (!isPlainObject(model) || typeof model.id !== 'string' || model.id === '') continue
        if (model.id.length > MAX_REMOTE_GROUP_NAME) continue
        const name = typeof model.name === 'string' && model.name !== '' ? model.name : model.id
        models.push({ ...model, name: name.length > MAX_REMOTE_GROUP_NAME ? name.slice(0, MAX_REMOTE_GROUP_NAME) : name })
      }
      if (models.length === 0) continue
      const name = typeof group.name === 'string' && group.name !== '' ? group.name : group.id
      const header = `${prefix}${name}`
      out.push({
        ...group,
        id: tagProvider(host.hostId, group.id),
        name: header.length > MAX_REMOTE_GROUP_NAME ? header.slice(0, MAX_REMOTE_GROUP_NAME) : header,
        models,
      })
    }
    return out
  }

  #openWireStream(endpoint, payload, uplink, peer, signal, control, uplinkWindow) {
    // Every branch returns a promise, like the rc.1 opener the caller probed.
    // Zero PAIRED hosts: the untouched opener, stream and all (a pairing later
    // applies to the streams opened after it, never to one already handed out).
    if (this.#isPurelyLocal(endpoint, payload)) {
      return this.#localOpen(endpoint, payload, uplink, peer, signal, control, uplinkWindow)
    }
    if (endpoint === 'workspace/follow') {
      return Promise.resolve(this.#mergeFollow({ payload, uplink, peer, signal, control, uplinkWindow }))
    }
    // Host-wide projection state is one stream in the native client. Remote
    // sessions must land in it too or the model chip only ever reads Local.
    if (endpoint === SESSION_CONTROL_ENDPOINT) {
      return Promise.resolve(this.#mergeSessionControl({ payload, uplink, peer, signal, control, uplinkWindow }))
    }
    // `$events` names no host: it stays the Local stream, with the connected
    // remotes' interaction cards merged into it (spec 008 P2c).
    if (endpoint === EVENTS_ENDPOINT) {
      return Promise.resolve(this.#mergeEvents({ payload, uplink, peer, signal, control, uplinkWindow }))
    }
    let target
    try {
      target = this.#route(payload)
    } catch (error) {
      // A session the user already opened stays readable while its host is
      // offline: replay the local copy instead of failing the whole stream.
      const replay = endpoint === SESSION_FOLLOW_ENDPOINT
        ? this.#replayCachedFollow(payload, error?.details?.hostId)
        : null
      if (replay) return Promise.resolve(replay)
      return Promise.reject(error)
    }
    if (target.kind === 'local') return this.#localOpen(endpoint, payload, uplink, peer, signal, control, uplinkWindow)
    // A followed session outlives one link: it is the transcript the user is watching,
    // so it resumes on its own instead of ending with the socket (see #openRemoteFollow).
    if (endpoint === SESSION_FOLLOW_ENDPOINT) return this.#openRemoteFollow(target, payload, signal)
    return this.#openRemote(target, endpoint, payload, uplink, signal)
  }

  /**
   * One stream opened on a remote Host. The bridge has no uplink channel, so an
   * uplink (client -> Host items) is not forwarded; every rc.1 endpoint the
   * native UI streams from is a read stream.
   *
   * A `session/follow` is also the session follower of the offline cache: its
   * frames are the transcript the user is looking at, so they are appended here
   * (raw, host-relative) for the moment that host goes away.
   */
  async #openRemote(target, endpoint, payload, uplink, signal) {
    if (uplink !== undefined && uplink !== null) this.#log(`remote stream ${endpoint}: the uplink is not forwarded`)
    const args = this.#forwardArgs(payload, target.hostId)
    this.#assertNoNamespace(args, target.hostId)
    const source = await target.connection.openStream(endpoint, args, { signal })
    const cache = this.#cache
    const sessionId = endpoint === SESSION_FOLLOW_ENDPOINT && cache ? followSessionId(args) : null
    const router = this
    return (async function* renamed() {
      for await (const value of source) {
        // Refuse before anything is cached: a frame that names a namespace must
        // never reach the UI, and it must not survive in the local copy either.
        const frame = router.#ingress(target.hostId, value, endpoint)
        if (sessionId) cache.append(target.hostId, sessionId, value)
        yield frame
      }
    })()
  }

  /**
   * One `session/follow` on a remote Host, kept alive across a reconnect.
   *
   * A followed session is the transcript the user is watching. Wiring it to one
   * `openStream` meant the stream ENDED when the socket closed — a clean end, which
   * the consumer reads as "this session has nothing more", so the conversation froze
   * until the whole page was reopened. The only way back was to restart DSH.
   *
   * So the follow is a pump rather than a pass-through: when the link drops it waits
   * for that host to come back (`onHostsChanged`, which the link supervisor already * fires on every state change) and re-opens the SAME follow. A follow re-opened on a
   * live session opens with a fresh snapshot holding everything committed meanwhile,
   * so the reader gets the missed stretch as `event` frames and nothing it already
   * showed (`followFrames`): no duplicate row and no gap.
   *
   * Only the REOPENED attempt's opening is repaired that way. Once its snapshot has
   * reached the cursor it names, the connection is the reader's live stream again
   * (`liveFollowFrames`): a new turn's assistant-stream frames cross, and the durable
   * events stay de-duplicated by the Host's `seq`. Holding the whole attempt back
   * after a reconnect dropped every new turn's streaming text.
   *
   * The reader's guarantee is unchanged: `signal` ending (or the caller abandoning the * iterator) stops the pump for good, retry included, and no attempt outlives it.
   * Cancelling during the offline wait does not have to wait for the host either.
   */
  async #openRemoteFollow(target, payload, signal) {
    const { hostId } = target
    const args = this.#forwardArgs(payload, hostId)
    this.#assertNoNamespace(args, hostId)
    const sessionId = this.#cache ? followSessionId(args) : null
    // The fallback needs the controller-side name even when there is no cache:
    // `args` are host-relative, so the id is minted in this Host's namespace here
    // and nowhere else (a frame from this pump must never name a raw remote id).
    const rawSessionId = followSessionId(args)
    const controlSessionId = rawSessionId === null ? null : namespaceId(hostId, rawSessionId)
    const cache = this.#cache
    const lifetime = new AbortController()
    const queue = new ValueQueue()
    const stop = () => { lifetime.abort(); queue.close() }
    this.#merges.add(stop)
    this.#trackFollow(hostId, stop)
    const onAbort = () => stop()
    if (signal) {
      if (signal.aborted) onAbort()
      else signal.addEventListener('abort', onAbort, { once: true })
    }
    /** The last committed durable sequence already delivered to the reader. */
    let lastSeq = null
    /** Whether a frame ever reached the reader: a later opening is a RESUME. */
    let opened = false
    /**
     * The durable sequence the FIRST opening snapshot named: from then on a snapshot
     * must reach exactly that cursor (and only the first one is the reader's opening).
     */
    let openingCursor = null
    /**
     * Per-ATTEMPT opening state (`followFrames`): `null` until the re-open's snapshot
     * has named its cursor and the Host's assistant-stream baseline, then the attempt
     * boundary every later live frame of that attempt is read against.
     * @type {{baseline?: {revision: number|null, attemptId: string|null}, lastSeq: number|null} | undefined}
     */
    let opening = null
    // The first attempt is awaited like a plain open always was: a caller that got a
    // stream from here has one open, and a refusal it can never retry still rejects.
    let settleFirst
    const firstAttempt = new Promise((resolve, reject) => { settleFirst = { resolve, reject } })
    firstAttempt.catch(() => {})
    void (async () => {
      let attempt = 0
      /** Consecutive attempts that ended in a DESYNC without delivering a frame. */
      let desyncs = 0
      let first = true
      /** Held events of the CURRENT attempt, visible to its catch (which can run before init). */
      let held = new Map()
      /** Seqs already counted toward this attempt's page bound. */
      let countedPageSeqs = new Set()
      while (!lifetime.signal.aborted) {
        /** Did this attempt put a frame in front of the reader? That, not the open, is progress. */
        let progressed = false
        held = new Map()
        countedPageSeqs = new Set()
        try {
          // The host is connected when this pump starts; if it drops in between, the
          // wait below is bounded by the reader, not by a fixed timeout.
          const host = this.#hostById(hostId)
          if (!host) { await this.#awaitHost(hostId, lifetime.signal); continue }
          const source = await host.connection.openStream(SESSION_FOLLOW_ENDPOINT, args, { signal: lifetime.signal })
          // The attempt counter is NOT reset here: a Host that accepts the open and then
          // immediately DESYNCs would answer "open succeeded" every time and be retried
          // at the minimum 100 ms forever. Only a delivered frame (`progressed` below, // handled after the attempt) counts as the link working.
          if (first) { first = false; settleFirst.resolve() }
          // Whether THIS attempt resumes a stream the reader already holds. A re-open
          // replaces only the replayed opening (`followFrames`); everything after it
          // stays the Host's live traffic, so a new turn streams on that connection too.
          const resumes = opened
          // Both attempts start BEFORE their opening snapshot is identified (`null`),
          // so the frames of a snapshot arriving in parts pass through untouched; the
          // snapshot's own cursor names the end of the opening (below).
          opening = null
          /** The cursor this attempt's opening snapshot must reach, once it is known. */
          let expected = resumes ? null : openingCursor
          // The unseen stretch this RE-OPENED page has asked for so far: its parts (a
          // snapshot arriving in pieces, and the `created` records that stand for a
          // dense fill) each arrive on their own, so the bound is the PAGE's, not one
          // frame's — a page refused once it crosses MAX_RESUME_GAP (`followFrames`
          // refuses a single part that crosses it by itself).
          /**
           * Events of a RE-OPENED page that arrived ahead of the seqs they sit on. A
           * Host may write its own region first (seq 5) and the older records after
           * (seqs 3, 4): delivering 5 first moves `lastSeq` past the hole, and the
           * later 3 and 4 are then dropped as "already seen" — a permanent gap no
           * later reconnect can fill. Held here until the missing stretch arrives (or
           * the page ends visibly unfinished), then delivered in Host seq order.
           */
          /** Every seq this page's parts have already counted (idempotent across parts). */
          for await (const value of source) {
            if (lifetime.signal.aborted) break
            // The OPENING is the snapshot: the frame that reaches the cursor `expected`
            // names ends it, and every frame after it is the connection's live traffic.
            if (opening === null && isSnapshotFrame(value)) {
              // A `header`-keyed snapshot names no cursor, so it is complete on arrival:
              // leaving `expected` null would make the gate below drop it (and every
              // frame after it) as "not the page yet" — the reader would get nothing.
              expected = Number.isSafeInteger(value.cursor) ? value.cursor : (Number.isSafeInteger(value.end) ? value.end : null)
              opening = { lastSeq }
            }
            if (!resumes && openingCursor === null && opening !== null) openingCursor = expected
            // The cursor names the snapshot, not the stream: once it has been delivered,
            // the connection is live traffic and no seq is "expected" any more.
            if (expected !== null && durableSeqOf(value) === expected) expected = null
            // Refuse before anything is cached: a frame that names a namespace must
            // never reach the UI, and it must not survive in the local copy either.
            // A follow opening snapshot carries the session's own projection cut.
            // Seed the reconstruction state before any splice from that page is
            // delivered; an absent block only means "unknown here", never empty.
            this.#noteInboxFollowSnapshot(hostId, controlSessionId, value)
            const frames = followFrames(value, { resumed: resumes, expected, lastSeq, opening })
            // The unseen stretch a part of the page names, counted toward the page's own
            // bound (see `pageUnseen`). An event's fill is already deduplicated against
            // the reader (`lastSeq`), and a snapshot's cursor is never counted: its value
            // is the page's cut, not a fill this reader lacks.
            // A refusal this part already carries is honored BEFORE walking a range the
            // remote Host named — that end can be arbitrarily far past the reader.
            const marker = frames.find((frame) => frame?.type === 'resume-overflow')
            if (!marker && resumes && isCreatedRecordFrame(value)) {
              // Count at most one page bound past the reader: an unmarked huge end is
              // refused by the size check below without walking the whole range.
              const start = Math.max(value.firstLiveSeq, (lastSeq ?? -1) + 1)
              const stop = Math.min(value.end, start + MAX_RESUME_GAP)
              for (let seq = start; seq <= stop; seq += 1) {
                countedPageSeqs.add(seq)
                if (countedPageSeqs.size > MAX_RESUME_GAP) break
              }
            } else if (!marker && resumes && isSnapshotFrame(value)) {
              for (const frame of unseenSnapshotEvents(value, lastSeq)) {
                const seq = followSeqOf(frame)
                if (seq !== null) countedPageSeqs.add(seq)
              }
            }
            // A repair this window cannot take is refused VISIBLY and ends the follow
            // here, before a later live frame of this connection is accepted: `lastSeq`
            // stays exactly where the reader is, so nothing can be skipped silently.
            const overflow = marker ?? (countedPageSeqs.size > MAX_RESUME_GAP ? { count: countedPageSeqs.size } : undefined)
            if (overflow) {
              const terminal = resumeOverflowError(hostId, overflow.count)
              this.#log(`session/follow for ${hostId} stopped (${STREAM_RESUME_OVERFLOW_CODE}): ${overflow.count} unseen events in one page`)
              if (first) { first = false; settleFirst.reject(terminal) }
              queue.fail(terminal)
              return
            }
            /** Deliver one frame (the single path that advances the durable cursor). */
            const deliver = (frame) => {
              const renamed = this.#ingress(hostId, frame, SESSION_FOLLOW_ENDPOINT)
              if (sessionId) cache?.append(hostId, sessionId, frame)
              const seq = followSeqOf(frame)
              if (seq !== null) lastSeq = seq
              // A claim that removes the pending inbox row leaves the native
              // controller's admission receipt at `index:null`; it retires the
              // optimistic echo only once seqOf('inbox') reaches this seq. The
              // Host's projection sometimes never arrives on session/control, so
              // advance that watermark from the durable splice we do see. Only a
              // removal without `outcome:'canceled'` takes that path: a canceled
              // splice is already settled by the controller itself, and an insert
              // must not be replaced by an empty inbox the Host has not sent.
              this.#fallbackInboxProjection(hostId, controlSessionId, frame)
              opened = true
              progressed = true
              queue.push(renamed)
            }
            // A page part that carries older events (a `created` fill, or the records
            // region of a snapshot) names the stretch the page starts at. An event held
            // above that floor is not a hole: the Host has just said the page starts
            // there, so the reader may continue at that seq (a fill bringing seq 4 after
            // the reader's seq 2 does not owe seq 3).
            if (resumes && held.size > 0) {
              const earliest = Math.min(...held.keys())
              let floor = Infinity
              for (const frame of frames) {
                const seq = followSeqOf(frame)
                if (seq !== null && seq < earliest && seq < floor) floor = seq
              }
              if (Number.isSafeInteger(floor) && (lastSeq ?? -1) < floor - 1) lastSeq = floor - 1
            }
            /** Deliver the held events that continue the durable run, in seq order. */
            const drainHeld = () => {
              for (;;) {
                const next = (lastSeq ?? -1) + 1
                const frame = held.get(next)
                if (frame === undefined) return
                held.delete(next)
                deliver(frame)
              }
            }
            // A frame that CARRIES several events has already gathered its whole stretch
            // (a snapshot with its records, or a dense fill): its events are in Host seq
            // order, so holding them would stall a page that is complete on arrival.
            // Merge anything held from an earlier, newer-only part into that order.
            if (resumes && frames.filter((frame) => followSeqOf(frame) !== null).length > 1) {
              const ordered = [...held.values(), ...frames.filter((frame) => followSeqOf(frame) !== null)]
                .sort((left, right) => followSeqOf(left) - followSeqOf(right))
              held.clear()
              const rest = frames.filter((frame) => followSeqOf(frame) === null)
              for (const frame of [...ordered, ...rest]) {
                const seq = followSeqOf(frame)
                if (seq !== null && seq <= (lastSeq ?? -1)) continue
                deliver(frame)
              }
              continue
            }
            for (const frame of frames) {
              const seq = followSeqOf(frame)
              if (resumes && seq !== null) {
                // A first open has no reader-held cursor to jump past; a resumed page
                // that names a seq beyond the next one has left a hole. Hold it until
                // the missing seqs arrive, instead of advancing past them forever.
                if (seq > (lastSeq ?? -1) + 1) {
                  if (!held.has(seq)) held.set(seq, frame)
                  continue
                }
                if (seq <= (lastSeq ?? -1)) continue
              }
              deliver(frame)
              if (resumes) drainHeld()
            }
          }
          // A re-opened page that still holds events when its stream ends had a hole
          // the Host never filled. End visibly rather than dropping them: a later
          // reconnect would carry the reader past the missing stretch permanently.
          if (held.size > 0) {
            const missing = Math.min(...held.keys())
            const terminal = Object.assign(resumeOverflowError(hostId, missing - (lastSeq ?? -1) - 1),
              { message: `the re-joined page left a gap from seq ${missing}; the follow was stopped instead of skipping it` })
            this.#log(`session/follow for ${hostId} stopped (${STREAM_RESUME_OVERFLOW_CODE}): ${terminal.message}`)
            if (first) { first = false; settleFirst.reject(terminal) }
            queue.fail(terminal)
            return
          }
        } catch (error) {
          if (lifetime.signal.aborted) break
          // A re-opened page left holding an event past a hole, and the Host dropped
          // the link before filling it. Do not carry the held state into a new attempt:
          // that would hand the reader a reply whose prompt never arrived. A DESYNC is
          // different — that is a frame-ordering protocol error the link repairs by
          // re-opening, so it keeps the existing backoff path below.
          if (typeof held !== 'undefined' && held.size > 0 && error?.closeCode === 1006) {
            const missing = Math.min(...held.keys())
            const terminal = Object.assign(resumeOverflowError(hostId, missing - (lastSeq ?? -1) - 1),
              { message: `the re-joined page left a gap from seq ${missing}; the follow was stopped instead of skipping it` })
            this.#log(`session/follow for ${hostId} stopped (${STREAM_RESUME_OVERFLOW_CODE}): ${terminal.message}`)
            if (first) { first = false; settleFirst.reject(terminal) }
            queue.fail(terminal)
            return
          }
          // A refusal the Host itself produced is not going to change by re-opening:
          // report it and end, exactly as a single attempt always did.
          if (!isLinkFailure(error)) {
            if (first) { first = false; settleFirst.reject(error) }
            queue.fail(error)
            return
          }
          if (error?.code === STREAM_DESYNC_CODE) {
            // Counted only while the reader got nothing: a desync AFTER a delivered frame
            // is the first of a new series, not a continuation of a stuck one.
            desyncs = progressed ? 1 : desyncs + 1
            if (desyncs >= MAX_CONSECUTIVE_DESYNCS) {
              // Visible and terminal: a Host that cannot send ordered frames is not a
              // link this follow can repair, and re-opening it again would only replace
              // a stalled subscription with another one.
              const terminal = Object.assign(new HostRouterError(STREAM_DESYNC_REPEATED_CODE,
                `the remote Host's session stream keeps arriving out of order (${desyncs} times without a frame); the follow was stopped`, { hostId }),
                { cause: error })
              this.#log(`session/follow for ${hostId} stopped (${STREAM_DESYNC_REPEATED_CODE}) after ${desyncs} out-of-order streams with no frame`)
              if (first) { first = false; settleFirst.reject(terminal) }
              queue.fail(terminal)
              return
            }
          } else {
            desyncs = 0
          }
          this.#log(`session/follow for ${hostId} stopped (${error?.code ?? error?.closeCode ?? 'link'}); it resumes with the link`)
          if (first) { first = false; settleFirst.resolve() }
        }
        if (lifetime.signal.aborted) break
        // A frame reached the reader: the link works, so the next interruption starts over
        // at the shortest delay. Anything else keeps growing the backoff.
        if (progressed) { attempt = 0; desyncs = 0 }
        // The link went away (or the Host closed the stream): wait for it and re-open.
        // `attempt` only paces the loop so a host that greets and drops cannot spin it.
        attempt += 1
        await this.#awaitHost(hostId, lifetime.signal, Math.min(100 * attempt, 1000))
      }
    })().catch((error) => {
      if (!lifetime.signal.aborted) queue.fail(error)
      settleFirst.reject(error)
    }).finally(() => {
      signal?.removeEventListener?.('abort', onAbort)
      this.#merges.delete(stop)
      this.#untrackFollow(hostId, stop)
      queue.close()
    })
    await firstAttempt
    // Abandoning the iterator is a cancellation too: the pump must not keep a link,
    // a subscription or a timer alive behind a stream nobody reads.
    const iterator = queue[Symbol.asyncIterator]()
    return {
      [Symbol.asyncIterator]() { return this },
      next: () => iterator.next(),
      return(value) {
        stop()
        return iterator.return?.(value) ?? Promise.resolve({ value: undefined, done: true })
      },
    }
  }

  /**
   * Resolve when `hostId` is connected again, the reader cancels, or `delayMs`
   * passes — whichever is first. The subscription is what makes this exact: the link
   * supervisor notifies on every state change, so nothing here polls the host.
   *
   * The delay is always honoured, even for a host that is still connected (its stream * ended on its own): re-opening at once would spin the pump against a host that
   * greets and drops.
   */
  #awaitHost(hostId, signal, delayMs = 0) {
    if (signal.aborted) return Promise.resolve()
    const ready = this.#hostById(hostId)
    if (!ready && delayMs === 0) {
      return new Promise((resolve) => {
        const finish = () => { unsubscribe(); signal.removeEventListener('abort', finish); resolve() }
        const unsubscribe = this.#onHostsChanged(() => { if (this.#hostById(hostId)) finish() })
        signal.addEventListener('abort', finish, { once: true })
      })
    }
    return new Promise((resolve) => {
      let timer = null
      const finish = () => {
        unsubscribe()
        if (timer) clearTimeout(timer)
        signal.removeEventListener('abort', finish)
        resolve()
      }
      // With a delay, both the timer and a reconnect end the wait: a host that comes
      // back earlier is re-opened earlier, and the timer bounds a host that is still up.
      const unsubscribe = ready ? () => {} : this.#onHostsChanged(() => { if (this.#hostById(hostId)) finish() })
      signal.addEventListener('abort', finish, { once: true })
      timer = setTimeout(finish, delayMs)
      timer.unref?.()
    })
  }

  /** The local copy of a session whose host is offline, as a read-only stream. */
  #replayCachedFollow(payload, hostId) {
    const cache = this.#cache
    if (!cache || typeof hostId !== 'string') return null
    const sessionId = followSessionId(this.#forwardArgs(payload, hostId))
    if (!sessionId) return null
    let frames
    try { frames = cache.read(hostId, sessionId) } catch { return null }
    if (!Array.isArray(frames) || frames.length === 0) return null
    this.#log(`session ${sessionId} of ${hostId} is offline: replaying the cached transcript`)
    // Read-only by construction: no request reaches the Host, and the stream ends
    // where the cache ends (the UI shows it behind the offline banner).
    const router = this
    return (async function* replay() {
      for (const frame of frames) yield router.#ingress(hostId, frame, 'cached transcript')
    })()
  }

  // -- interaction cards -> the native `$events` stream ----------------------
  //
  // The Host pushes its approval/question cards to every connected device that
  // may answer them (`approval-requested`, `question-requested`). Those are the
  // only frames that carry the card's own `rpcId`/`approvalId`/`argsHash`, so
  // they are the ones rebuilt as native `$events` waterfall frames. The native
  // UI then answers through `$events/result`, which comes back here.

  #cardKey(hostId, rpcId) {
    return `${hostId}\u0000${rpcId}`
  }

  /** Rebuild one device card as the native waterfall frame, and remember its ids. */
  #injectCard(host, frame) {
    const kind = frame?.kind
    const approval = kind === 'approval-requested'
    const question = kind === 'question-requested'
    if (!approval && !question) return null
    const rpcId = typeof frame.rpcId === 'string' && frame.rpcId !== '' ? frame.rpcId : null
    const sessionId = typeof frame.sessionId === 'string' && frame.sessionId !== '' ? frame.sessionId : null
    if (!rpcId || !sessionId) return null
    // The card's ids are remote data like any other: a card that names a host
    // namespace (its own or another host's) is refused, never renamed into it. The
    // WHOLE card is checked first — `approvalId`/`callId` are copied verbatim — so
    // a hostile one can never be stored in `#cards` (or reach the approval buffer).
    let eventId
    let agentId
    try {
      assertCleanCard(host.hostId, frame)
      eventId = namespaceId(host.hostId, rpcId)
      agentId = namespaceId(host.hostId, sessionId)
    } catch (error) {
      this.#log(`interaction card from ${host.hostId} refused: ${error?.code ?? 'error'}`)
      return null
    }
    /** @type {{hostId: string, sessionId: string, rpcId: string, callId?: string,
     *   approvalId?: string, argsHash?: string, kind: 'approval'|'question'}} */
    const card = { hostId: host.hostId, sessionId, rpcId, kind: approval ? 'approval' : 'question' }
    // The tool-call id is what the CONTINUED fallback needs; the active answer
    // frame keys by the card's rpcId, so a Host that omits it stays answerable.
    if (typeof frame.callId === 'string' && frame.callId !== '') card.callId = frame.callId
    if (typeof frame.approvalId === 'string' && frame.approvalId !== '') card.approvalId = frame.approvalId
    if (typeof frame.argsHash === 'string' && APPROVAL_HASH.test(frame.argsHash)) card.argsHash = frame.argsHash
    const key = this.#cardKey(host.hostId, rpcId)
    this.#cards.delete(key)
    this.#cards.set(key, card)
    while (this.#cards.size > MAX_TRACKED_CARDS) this.#cards.delete(this.#cards.keys().next().value)
    // The waterfall request carries no `agent`/`signal` (the client rejects it);
    // every field below comes from the card the Host issued, verbatim.
    const request = approval
      ? {
        ...(typeof frame.toolName === 'string' ? { toolName: frame.toolName } : {}),
        ...(frame.callId !== undefined ? { callId: frame.callId } : {}),
        ...(frame.reason !== undefined ? { reason: frame.reason } : {}),
        ...(frame.displayReason !== undefined ? { displayReason: frame.displayReason } : {}),
        ...(typeof frame.argsPreview === 'string' ? { argsPreview: frame.argsPreview } : {}),
      }
      // `wait.callId` is the ONLY field DSH consults to key a question card
      // (`dsh-client-ui-user-questions`: `request.wait?.callId`). Without it the card
      // is unnameable and DSH tears it down in the request's `finally` instead of when
      // the projection drops the answered call, so the answer can no longer route back.
      : {
        questions: Array.isArray(frame.questions) ? frame.questions : [],
        ...(typeof frame.callId === 'string' && frame.callId !== '' ? { wait: { callId: frame.callId } } : {}),
      }
    return {
      type: 'waterfall',
      event: approval ? APPROVAL_EVENT : QUESTION_EVENT,
      eventId,
      agentId,
      request,
    }
  }

  /** Drop one tracked card; `withdraw` also tells the native stream it is gone. */
  #forgetCard(card, withdraw = true) {
    const key = this.#cardKey(card.hostId, card.rpcId)
    if (!this.#cards.delete(key)) return
    if (!withdraw) return
    // The native stream closes a pending card with `{type:'cancel', eventId}`:
    // without it the UI would keep showing an approval nobody can decide.
    this.#publishEvent({ type: 'cancel', eventId: namespaceId(card.hostId, card.rpcId) })
  }

  /** Withdraw every pending card of one host (disconnect, revoke, resolve). */
  #withdrawHost(hostId) {
    for (const card of [...this.#cards.values()]) if (card.hostId === hostId) this.#forgetCard(card, true)
  }

  #publishEvent(frame) {
    for (const sink of [...this.#eventSinks]) {
      try { sink(frame) } catch { /* one broken consumer must not stop the others */ }
    }
  }

  /** Forget both the reconstruction value and its last published watermark. */
  #clearInboxState(sessionId) {
    this.#inboxStates.delete(sessionId)
    this.#fallbackControlSeqs.delete(sessionId)
  }

  /** Store a whole authoritative value under DSH's higher-seq-wins rule. */
  #setInboxState(sessionId, value, seq) {
    if (typeof sessionId !== 'string' || sessionId === '') return false
    if (!Number.isSafeInteger(seq) || seq < -1) return false
    const normalized = normalizeInboxValue(value)
    if (normalized === null) return false
    const row = this.#inboxStates.get(sessionId)
    if (row !== undefined && row.seq >= seq) return false
    this.#inboxStates.delete(sessionId)
    this.#inboxStates.set(sessionId, { seq, value: normalized })
    while (this.#inboxStates.size > MAX_TRACKED_INBOX_STATES) {
      this.#inboxStates.delete(this.#inboxStates.keys().next().value)
    }
    return true
  }

  /** Seed from a merged `session/control` baseline block's own cut. */
  #noteInboxBaseline(sessionId, values, seq) {
    if (!isPlainObject(values) || !Object.hasOwn(values, 'inbox')) {
      this.#clearInboxState(sessionId)
      return
    }
    if (!Number.isSafeInteger(seq) || seq < -1) {
      this.#clearInboxState(sessionId)
      return
    }
    if (normalizeInboxValue(values.inbox) === null) this.#clearInboxState(sessionId)
    else this.#setInboxState(sessionId, values.inbox, seq)
  }

  /** Track an ordinary sequenced projection frame on the merged control stream. */
  #noteInboxProjectionFrame(frame) {
    if (frame.type !== 'projection' || !Array.isArray(frame.changes)) return
    const change = frame.changes.find((entry) => isPlainObject(entry) && entry.key === 'inbox')
    if (change === undefined) return
    if (!Number.isSafeInteger(frame.seq) || frame.seq < 0 || normalizeInboxValue(change.val) === null) {
      this.#clearInboxState(frame.sessionId)
      return
    }
    this.#setInboxState(frame.sessionId, change.val, frame.seq)
  }

  /**
   * A `session/follow` opening snapshot carries the session's projection cut
   * (`transport.ts`: `page.projections = frame.projections`). Its absence is
   * "unknown here", not an empty inbox; an explicit block without `inbox` is a
   * capability-absent cut and clears what this router could otherwise synthesize.
   */
  #noteInboxFollowSnapshot(hostId, sessionId, value) {
    if (typeof sessionId !== 'string' || !isSnapshotFrame(value)) return
    const projections = value.projections
    if (!isPlainObject(projections)) return
    const seq = projections.asOfSeq
    if (!Number.isSafeInteger(seq) || seq < -1 || !isPlainObject(projections.values)
      || !Object.hasOwn(projections.values, 'inbox')) {
      this.#clearInboxState(sessionId)
      return
    }
    // This frame is still in RAW remote coordinates on the follow pump; the
    // baseline/projection sources are already ingressed. Fold in ONE coordinate
    // system: ingress a detached copy before it becomes tracked state. Never
    // ingress the delivered frame itself (the pump does that below).
    let renamed
    try {
      renamed = this.#ingress(hostId, structuredClone(projections.values.inbox), 'session/follow snapshot projections')
    } catch {
      this.#clearInboxState(sessionId)
      return
    }
    if (normalizeInboxValue(renamed) === null) {
      this.#clearInboxState(sessionId)
      return
    }
    this.#setInboxState(sessionId, renamed, seq)
  }

  /**
   * Reconstruct the whole inbox a remote claim splice leaves behind, then
   * publish it as a sequenced projection when the Host's own control frame is
   * missing. The splice folds into known authoritative state with DSH's own
   * `inboxProjectionDefinition`, so other queued messages survive; a later real
   * Host frame at the same seq is then identical, and `ProjectionValueStore.apply`
   * drops it as a replay instead of corrupting the value. Unknown or invalid
   * state fails closed: no synthetic frame, never an assumed-empty inbox.
   */
  #fallbackInboxProjection(hostId, sessionId, frame) {
    if (typeof sessionId !== 'string' || !isPlainObject(frame) || frame.type !== 'event') return
    const event = frame.event
    if (!isPlainObject(event) || event.type !== 'agent/inbox/spliced') return
    if (!Number.isSafeInteger(event.seq) || event.seq < 0) return
    const known = this.#inboxStates.get(sessionId)
    if (known === undefined || known.seq >= event.seq) return
    const data = event.data
    // The follow frame is raw; tracked state and the published frame are already
    // in the controller's namespace. Ingress a detached copy of the splice BEFORE
    // folding, so inserted messages use the same id coordinate as the state.
    // `namespaceIds` keeps kind:'user' source.rpcId opaque while renaming real id
    // fields; a refusal here fails closed instead of leaking raw ids downstream.
    let renamedData
    try {
      renamedData = this.#ingress(hostId, structuredClone(data), 'session/follow inbox splice')
    } catch {
      this.#clearInboxState(sessionId)
      return
    }
    const folded = foldInboxValue(known.value, renamedData)
    if (folded === null) {
      this.#clearInboxState(sessionId)
      return
    }
    this.#setInboxState(sessionId, folded, event.seq)
    if (!isPlainObject(data) || !(Number.isSafeInteger(data.removedCount) && data.removedCount > 0)) return
    if (data.outcome === 'canceled') return
    // No merged control stream open: state still advances, but there is nowhere
    // to publish and no frame is buffered across generations.
    if (this.#controlSinks.size === 0) return
    const lastSeq = this.#fallbackControlSeqs.get(sessionId)
    if (lastSeq !== undefined && lastSeq >= event.seq) return
    this.#fallbackControlSeqs.set(sessionId, event.seq)
    if (this.#fallbackControlSeqs.size > MAX_FALLBACK_CONTROL_SEQS) {
      this.#fallbackControlSeqs.delete(this.#fallbackControlSeqs.keys().next().value)
    }
    this.#publishControl({
      type: 'projection', sessionId, seq: event.seq,
      changes: [{ key: 'inbox', val: folded }],
    })
  }

  #publishControl(frame) {
    for (const sink of [...this.#controlSinks]) {
      try { sink(frame) } catch { /* one broken consumer must not stop the others */ }
    }
  }

  /**
   * `$events` merged: the Local stream unchanged, plus the interaction cards of
   * every connected Host, renamed into that Host's namespace. A disconnecting
   * Host withdraws its cards, so the native UI never shows a dead approval.
   */
  async *#mergeEvents(call) {
    const { payload, uplink, peer, signal, control, uplinkWindow } = call
    const queue = new ValueQueue()
    const lifetime = new AbortController()
    const stop = () => { lifetime.abort(); queue.close() }
    this.#merges.add(stop)
    const sink = (frame) => queue.push(frame)
    this.#eventSinks.add(sink)
    // A reload the picker is still owed may have been queued for the stream this
    // one replaces; a stale window is no override, and the rule reports `true`.
    const dueAtOpen = this.#catalogRefreshDue()
    if (dueAtOpen && this.#lastAnnounceAt === 0) this.#lastAnnounceAt = Date.now() - MODEL_CATALOG_ANNOUNCE_INTERVAL_MS
    /** @type {Map<string, () => void>} hostId -> detach its card listeners */
    const watching = new Map()
    /**
     * One coalesced `session/list` refresh per host, kept until the call settles so
     * a burst of unknown statuses cannot stack reloads. The statuses it collected
     * are replayed once the new rows exist. A watcher generation token is part of
     * the state: a reconnect reuses the same host object, so `watching.has` alone
     * cannot tell a new watcher from the one that started an old call.
     * @type {Map<string, {timer: any, statuses: Map<string, boolean>, inFlight: boolean, token: number, abort?: AbortController}>}
     */
    const pendingRefreshes = new Map()
    const watchTokens = new Map()
    const tokenOf = (hostId) => watchTokens.get(hostId) ?? 0
    const bumpToken = (hostId) => { watchTokens.set(hostId, tokenOf(hostId) + 1) }
    const cancelRefresh = (hostId) => {
      const pending = pendingRefreshes.get(hostId)
      if (!pending) return
      if (pending.timer !== null) clearTimeout(pending.timer)
      pending.abort?.abort()
      pendingRefreshes.delete(hostId)
    }
    const refreshSessions = async (host, pending) => {
      const isCurrent = () => !lifetime.signal.aborted
        && watching.has(host.hostId) && tokenOf(host.hostId) === pending.token
      if (!isCurrent()) return
      let renamed
      const abort = new AbortController()
      const abortOnLifetime = () => abort.abort()
      lifetime.signal.addEventListener('abort', abortOnLifetime, { once: true })
      pending.abort = abort
      try {
        // Same call shape as `#mergeSessionList`: the carrier takes the bare args
        // object, and a session/list without a hint or cursor sends `{}`.
        const value = await host.connection.call('session/list', {}, { signal: abort.signal })
        if (!isCurrent()) return
        if (!Array.isArray(value?.items)) throw new Error('session/list did not return an items array')
        if (!value.items.every(isSessionSummaryRow)) {
          // Ignore the whole batch: no retained change, no ids in the log.
          this.#log('session/list refresh refused: malformed-session-row')
          return
        }
        renamed = value.items.map((row) => withoutRemoteCwd(this.#ingress(host.hostId, row, 'session/list row')))
      } catch (error) {
        if (!isCurrent()) return
        // A refusal or a hostile row leaves the retained list alone: no phantom rows.
        this.#log(`session/list refresh from ${host.hostId} failed: ${error?.code ?? 'error'}`)
        return
      } finally {
        lifetime.signal.removeEventListener('abort', abortOnLifetime)
        if (pending.abort === abort) pending.abort = null
        if (pendingRefreshes.get(host.hostId) === pending) pendingRefreshes.delete(host.hostId)
      }
      // Check once more immediately before the commit: a reconnect can land while
      // the call resolves. No await follows, so this one guard covers the retained
      // update, added, removed and replayed status together.
      if (!isCurrent()) return
      const before = new Set((this.#retainedRows.get(host.hostId) ?? [])
        .map((row) => row?.sessionId).filter((id) => typeof id === 'string'))
      const after = new Set(renamed.map((row) => row?.sessionId).filter((id) => typeof id === 'string'))
      this.#rememberRows(host.hostId, renamed)
      for (const row of renamed) {
        if (before.has(row.sessionId)) continue
        // The status was already published when the row did not exist; the native
        // UI ignored it. Publish added first, then repeat the last known status
        // so the running dot survives the row's arrival.
        this.#publishEvent({ type: 'emit', event: SESSION_ADDED_EVENT, args: [row] })
        if (pending.statuses.has(row.sessionId)) {
          this.#publishEvent({ type: 'emit', event: SESSION_STATUS_EVENT, args: [row.sessionId, pending.statuses.get(row.sessionId)] })
        }
      }
      for (const id of before) {
        if (!after.has(id)) this.#publishEvent({ type: 'emit', event: SESSION_REMOVED_EVENT, args: [id] })
      }
    }
    const scheduleRefresh = (host, sessionId, running) => {
      let pending = pendingRefreshes.get(host.hostId)
      if (!pending) {
        pending = { timer: null, statuses: new Map(), inFlight: false, token: tokenOf(host.hostId) }
        pendingRefreshes.set(host.hostId, pending)
      }
      pending.statuses.set(sessionId, running)
      if (pending.timer !== null) clearTimeout(pending.timer)
      pending.timer = setTimeout(() => {
        pending.timer = null
        if (pending.inFlight) return
        pending.inFlight = true
        void refreshSessions(host, pending)
      }, SESSION_STATUS_LIST_REFRESH_MS)
      pending.timer?.unref?.()
    }

    const watch = (host) => {
      if (watching.has(host.hostId)) return
      const connection = host.connection
      // Only a live connection object can be listened to (a stub is not a source).
      if (!connection || typeof connection.on !== 'function' || typeof connection.off !== 'function') return
      // A reconnect reuses the connection object: this token is what tells an
      // answer to a call the previous watcher started from this watcher's calls.
      bumpToken(host.hostId)
      const onCard = (frame) => {
        const injected = this.#injectCard(host, frame)
        if (injected) this.#publishEvent(injected)
      }
      const onResolved = (frame) => {
        for (const card of [...this.#cards.values()]) {
          if (card.hostId !== host.hostId) continue
          if (frame?.rpcId !== undefined && card.rpcId !== frame.rpcId) continue
          this.#forgetCard(card, true)
        }
      }
      const onSessionStatus = (frame) => {
        if (typeof frame?.sessionId !== 'string' || typeof frame?.running !== 'boolean') return
        // Same rule as an interaction card: a remote may not name a host namespace.
        // `namespaceId` throws on an already-tagged id, so the frame never reaches
        // the native stream under a host it did not come from.
        let sessionId
        try {
          sessionId = namespaceId(host.hostId, frame.sessionId)
        } catch (error) {
          this.#log(`session status from ${host.hostId} refused: ${error?.code ?? 'error'}`)
          return
        }
        this.#publishEvent({ type: 'emit', event: SESSION_STATUS_EVENT, args: [sessionId, frame.running === true] })
        // The gateway forwards only the status for a newly created remote session,
        // not the `api-session/added` summary the sidebar needs for a row. The
        // retained rows are THIS host's already renamed session/list rows, so an id
        // missing there has no row to attach the dot to: reload its list once.
        const known = (this.#retainedRows.get(host.hostId) ?? [])
          .some((row) => row?.sessionId === sessionId)
        if (!known) scheduleRefresh(host, sessionId, frame.running === true)
      }
      const onState = (state) => { if (state !== 'online') this.#withdrawHost(host.hostId) }
      connection.on('approval', onCard)
      connection.on('question', onCard)
      connection.on('resolved', onResolved)
      connection.on('questionResolved', onResolved)
      connection.on('sessionStatus', onSessionStatus)
      connection.on('state', onState)
      watching.set(host.hostId, () => {
        connection.off('approval', onCard)
        connection.off('question', onCard)
        connection.off('resolved', onResolved)
        connection.off('questionResolved', onResolved)
        connection.off('sessionStatus', onSessionStatus)
        connection.off('state', onState)
      })
      // Cards the Host pushed before this stream opened (a reload, a second // window) are still answerable: seed them in the order they arrived.
      for (const card of this.#approvals?.pending?.(host.hostId) ?? []) onCard(card)
    }

    const onAbort = () => stop()
    const watched = [signal, control?.signal].filter(Boolean)
    for (const source of watched) {
      if (source.aborted) onAbort()
      else source.addEventListener('abort', onAbort, { once: true })
    }
    let unsubscribe = null
    try {
      const localSignal = signal ? AbortSignal.any([signal, lifetime.signal]) : lifetime.signal
      const localControl = control ?? new AbortController()
      const localSource = await this.#localOpen(EVENTS_ENDPOINT, payload, uplink, peer, localSignal, localControl, uplinkWindow)
      const iterator = localSource[Symbol.asyncIterator]()
      // The stream must begin with the Local `ready` frame (the client rejects a // card that arrives before it), so it is read before any card is queued.
      const first = await iterator.next()
      if (!first.done) queue.push(first.value)
      void (async () => {
        try {
          for (;;) {
            const next = await iterator.next()
            if (next.done) break
            if (lifetime.signal.aborted) break
            queue.push(next.value)
          }
        } catch (error) {
          if (lifetime.signal.aborted) return
          queue.fail(error)
        }
      })()
      for (const host of this.#connectedHosts()) watch(host)
      // The picker caches the merged catalog for this Host generation, and it loads
      // that catalog on its own once the stream is up — possibly before a host it
      // should include has linked, and this frame can reach it only through this
      // sink. So the comparison happens here, not at the host-change callback:
      // `#catalogHostKey` says what the last answer really covered.
      this.#lastHostSet = this.#connectedKey()
      this.#announceHostSet()
      unsubscribe = this.#onHostsChanged(() => {
        const hosts = this.#connectedHosts()
        const connected = new Set(hosts.map((host) => host.hostId))
        for (const host of hosts) watch(host)
        for (const hostId of [...watching.keys()]) {
          if (connected.has(hostId)) continue
          cancelRefresh(hostId)
          bumpToken(hostId)
          this.#withdrawHost(hostId)
          watching.get(hostId)?.()
          watching.delete(hostId)
        }
        // A host that leaves takes its sections with it and asks the picker to
        // reload; one that arrives only asks when the catalog it is holding did not
        // include it — a reload racing that host's link is exactly the miss this
        // frame repairs.
        this.#announceHostSet({ withdraw: watching.size < connected.size })
      })
      for await (const frame of queue) yield frame
    } finally {
      for (const source of watched) source.removeEventListener?.('abort', onAbort)
      unsubscribe?.()
      this.#eventSinks.delete(sink)
      for (const hostId of [...pendingRefreshes.keys()]) cancelRefresh(hostId)
      for (const hostId of watching.keys()) bumpToken(hostId)
      for (const detach of watching.values()) detach()
      this.#merges.delete(stop)
      stop()
    }
  }

  /**
   * `workspace/follow` merged: one Local stream plus one per connected remote.
   * Emits a merged baseline, then renamed increments; a remote (re)connect or
   * disconnect emits a `replace` of the whole merged state.
   */
  async *#mergeFollow(call) {
    const { payload, uplink, peer, signal, control, uplinkWindow } = call
    const queue = new ValueQueue()
    const state = new MergeState()
    const lifetime = new AbortController()
    const stop = () => { lifetime.abort(); queue.close() }
    const forward = (frames) => { for (const frame of frames) queue.push(frame) }
    // Which side the sidebar shows is a DISPLAY decision (client.js), never a filter
    // of this stream: DSH resolves a new chat's workspace from what is merged here.
    this.#merges.add(stop)
    /** @type {Map<string, AbortController>} */
    const pumps = new Map()
    const drop = (hostId) => {
      pumps.get(hostId)?.abort()
      pumps.delete(hostId)
      forward(state.dropHost(hostId))
    }

    const start = (host) => {
      if (pumps.has(host.hostId)) return
      const hostControl = new AbortController()
      pumps.set(host.hostId, hostControl)
      void (async () => {
        try {
          const source = await host.connection.openStream('workspace/follow', {},
            { signal: AbortSignal.any([hostControl.signal, lifetime.signal]) })
          for await (const frame of source) {
            if (hostControl.signal.aborted) break
            const type = frame?.type
            // Refuse a frame that names host namespaces BEFORE the merged map
            // stores it: the map renames as it stores, so a pre-checked frame is
            // the only way to refuse one without writing half of it.
            if (type === 'baseline' || type === 'replace') {
              forward(state.setHost(host, this.#refuseTagged(host.hostId, frame.value, 'workspace/follow baseline')))
              continue
            }
            forward(state.applyHost(host, this.#refuseTagged(host.hostId, frame, 'workspace/follow')))
          }
        } catch (error) {
          if (hostControl.signal.aborted || lifetime.signal.aborted) return
          // A broken follow stream is a dead host as far as the sidebar cares.
          this.#noteHostError(host.hostId, error)
          this.#log(`workspace/follow from ${host.hostId} stopped: ${error?.code ?? 'error'}`)
          if (pumps.get(host.hostId) === hostControl) drop(host.hostId)
        }
      })()
    }

    const onAbort = () => stop()
    const watched = [signal, control?.signal].filter(Boolean)
    for (const source of watched) {
      if (source.aborted) onAbort()
      else source.addEventListener('abort', onAbort, { once: true })
    }
    let unsubscribe = null
    try {
      const localSignal = signal ? AbortSignal.any([signal, lifetime.signal]) : lifetime.signal
      const localControl = control ?? new AbortController()
      const localSource = await this.#localOpen('workspace/follow', payload, uplink, peer, localSignal, localControl, uplinkWindow)
      let settleLocal = { resolve: () => {}, reject: () => {} }
      const localReady = new Promise((resolve, reject) => { settleLocal = { resolve, reject } })
      // The failure is also reported through the queue; this keeps a late
      // rejection from becoming an unhandled one after the baseline race settled.
      localReady.catch(() => {})
      void (async () => {
        try {
          for await (const frame of localSource) {
            if (lifetime.signal.aborted) break
            const type = frame?.type
            if (type === 'baseline' || type === 'replace') {
              state.setLocal(frame.value)
              settleLocal.resolve()
              // The first baseline is the merged one below. A LATER local replace is an
              // ordinary increment (Local's filtered re-baseline), and the merged state
              // is the only copy the UI sees: republish it or the client keeps its old
              // rows and a new chat's Workspace never resolves (owner, zero hosts:
              // "New chat → choose workspace bounces to Choose workspace").
              if (state.ready) forward([{ type: 'replace', value: state.baseline() }])
              continue
            }
            forward(state.applyLocal(type, frame))
          }
        } catch (error) {
          if (lifetime.signal.aborted) return
          // Local is the spine of the merged view: without it nothing is credible.
          settleLocal.reject(error)
          queue.fail(error)
        }
      })()

      for (const host of this.#connectedHosts()) start(host)
      unsubscribe = this.#onHostsChanged(() => {
        const hosts = this.#connectedHosts()
        const connected = new Set(hosts.map((host) => host.hostId))
        for (const host of hosts) start(host)
        for (const hostId of [...pumps.keys()]) if (!connected.has(hostId)) drop(hostId)
      })

      // One merged baseline: wait briefly for the remotes so the first paint is
      // complete, then fold a late host in as a `replace`.
      await Promise.race([localReady, this.#delay(this.#baselineTimeoutMs)])
      state.ready = true
      queue.push({ type: 'baseline', value: state.baseline() })
      for await (const frame of queue) yield frame
    } finally {
      for (const source of watched) source.removeEventListener?.('abort', onAbort)
      unsubscribe?.()
      this.#merges.delete(stop)
      stop()
    }
  }

  /**
   * Merge one `{type:'baseline', value:{projections}}` from a Host into the
   * control-stream baseline. Record KEYS are session ids (the rename table only
   * walks values), so they are tagged here; the block's projection values go
   * through `#ingress` so a remote provider is named for its Host.
   */
  #mergeControlBaseline(target, baseline, hostId) {
    const blocks = isPlainObject(baseline?.value?.projections) ? baseline.value.projections : {}
    for (const [sessionId, block] of Object.entries(blocks)) {
      if (!isPlainObject(block)) continue
      // A raw remote id is always minted into this Host's namespace here; a
      // pre-tagged one is refused by namespaceId before it can be published.
      const key = hostId === null ? sessionId : namespaceId(hostId, sessionId)
      target[key] = hostId === null || !isPlainObject(block.values)
        ? { ...block }
        : { ...block, values: this.#ingress(hostId, block.values, 'session/control baseline') }
      // A Header-only listing's cached block carries a non-comparable seq; only
      // a sequenced baseline is an authoritative cut for splice reconstruction.
      if (block.kind !== 'cached' && isPlainObject(target[key].values)) {
        this.#noteInboxBaseline(key, target[key].values, block.asOfSeq)
      }
    }
  }

  /**
   * Hold a cut that ended a generation until the native retry opens the next one.
   * `blocks` are already merged (namespaced keys, ingress-applied values), so the
   * replacement generation can put them in its ONE opening baseline verbatim.
   * Re-inserting an id moves it to the end, so the cap sheds the oldest cuts first.
   * A cut stays until its Host greets with the same watermark again: that repeat
   * proves the seeded cut reached the store, so only then is it retired.
   */
  #rememberControlCuts(hostId, blocks) {
    for (const [mergedId, block] of Object.entries(blocks)) {
      if (!isPlainObject(block)) continue
      this.#carriedControlCuts.delete(mergedId)
      this.#carriedControlCuts.set(mergedId, { hostId, block })
    }
    while (this.#carriedControlCuts.size > MAX_CARRIED_CONTROL_CUTS) {
      this.#carriedControlCuts.delete(this.#carriedControlCuts.keys().next().value)
    }
  }

  /**
   * Cuts for the generation that is opening now. This is a SNAPSHOT, not a
   * consumption: a later rebase in this generation may still need the cuts of
   * Hosts that have not re-greeted, so they must survive into its replacement.
   * Each is retired only when its Host greets at the seeded watermark again.
   */
  #snapshotCarriedControlCuts() {
    return new Map(this.#carriedControlCuts)
  }

  /** A greeting at the seeded watermark proves this cut landed; stop carrying it. */
  #retireCarriedControlCut(mergedId) {
    this.#carriedControlCuts.delete(mergedId)
  }

  /**
   * A baseline that arrives after the merged stream has opened is not a second
   * opening snapshot: DSH's snapshot stream ends on one (`snapshot-stream.ts`
   * checks `snapshotSeen`). Re-send its blocks as ordinary per-session projection
   * frames ONLY when that is admission-faithful: `ProjectionValueStore.apply`
   * drops a sequenced write whose `seq` is not newer, so an equal/old watermark
   * cannot roll a newer value back, but it also cannot clear a key the new cut
   * omits (`seed` does) and the consumer admits frame seqs with `SessionSeq`,
   * which rejects -1 while baselines may legitimately carry that empty cursor
   * (`sessionSeqCursor`). When a cut needs seed semantics or a negative cursor,
   * return null so the caller reopens the logical stream: the native's own
   * retry then opens a fresh generation whose ONE baseline carries the cut.
   *
   * @param {object} baseline the late `{type:'baseline', value:{projections}}` frame
   * @param {string|null} hostId host namespace, or null for Local
   * @param {Map<string, Set<string>>} known keys currently held per merged session id
   * @param {Map<string, number>} carriedCutSeqs watermarks of cuts carried from the
   *   generation that rebased and already seeded by this generation's opening baseline
   * @param {(mergedId: string) => void} [retire] called when a cut's own greeting
   *   repeats its seeded watermark, proving the cut no longer needs carrying
   * @returns {object[]|null} projection frames, or null when a fresh generation is required
   */
  #controlBaselineFrames(baseline, hostId, known, carriedCutSeqs, retire) {
    // Validate the WHOLE remote frame first, before any watermark shortcut: a
    // payload at a carried seq is still remote data and may smuggle an id that
    // already names a namespace. #ingress refuses that (or an over-deep payload)
    // through the same path as every other remote frame. Its renamed copy is
    // discarded here: frames below are built from the raw cut and renamed once
    // when emitted, so no id is tagged twice.
    if (hostId !== null) this.#ingress(hostId, baseline, 'session/control baseline')
    const blocks = isPlainObject(baseline?.value?.projections) ? baseline.value.projections : {}
    const frames = []
    for (const [sessionId, block] of Object.entries(blocks)) {
      if (!isPlainObject(block) || !isPlainObject(block.values)) continue
      const mergedId = hostId === null ? sessionId : namespaceId(hostId, sessionId)
      // A greeting that repeats a cut the opening baseline already seeded is a
      // duplicate, not a new cut. Native seed/apply at the same watermark cannot
      // change the value, so ignore it — otherwise a remote that greets with the
      // same -1 cut on every stream would end every generation in turn.
      if (carriedCutSeqs?.has(mergedId) && carriedCutSeqs.get(mergedId) === block.asOfSeq) {
        // The Host has now greeted at the watermark this generation seeded:
        // the cut landed, so a later rebase need not carry it again.
        retire?.(mergedId)
        continue
      }
      // A baseline cursor of -1 is a valid empty-session cut, but the consumer
      // admits projection frames with SessionSeq (non-negative safe integer).
      // Mapping it to 0 would fake an event-0 write and mask the real one.
      if (!Number.isSafeInteger(block.asOfSeq) || block.asOfSeq < 0) return null
      // seed() clears every row whose key the cut omits; apply() only writes the
      // carried keys. A prior row (from an earlier baseline or a live frame) that
      // this cut drops must be removed by the native store, not papered over.
      for (const key of known?.get(mergedId) ?? []) {
        if (!Object.hasOwn(block.values, key)) return null
      }
      const frame = {
        type: 'projection',
        sessionId,
        seq: block.asOfSeq,
        changes: Object.entries(block.values).map(([key, val]) => ({ key, val })),
      }
      frames.push(hostId === null ? frame : this.#ingress(hostId, frame, 'session/control baseline'))
    }
    return frames
  }

  /**
   * `session/control` merged: one Local stream plus one per connected remote.
   *
   * DSH's client holds one projection store for all sessions; every host has its
   * own control stream and its own seq space. The ONE opening baseline folds in
   * whatever arrived before the merge started; later baselines are re-sent as
   * per-session projection frames when that is admission-faithful, and a cut
   * that needs native seed semantics ends this stream so the consumer's retry
   * opens a fresh generation with one coherent replacement baseline. That cut is
   * carried across the retry (bounded) and seeded by the next opening baseline;
   * a repeated late greeting at the same watermark is ignored and retires the cut.
   * Every ordinary `{type:'projection'}` frame keeps its own (per-session) seq.
   * A session id is namespaced, so seqs never collide. Without this, a remote
   * `model/selection` append is durable on that Host but the native model chip
   * never sees the `modelSelection` projection frame.
   */
  async *#mergeSessionControl(call) {
    const { payload, uplink, peer, signal, control, uplinkWindow } = call
    const queue = new ValueQueue()
    const lifetime = new AbortController()
    const stop = () => { lifetime.abort(); queue.close() }
    this.#merges.add(stop)
    /** @type {Map<string, {abort: () => void, blocks: Record<string, object>}>} */
    const pumps = new Map()
    // A terminal refusal belongs to one connection: a later host-set notification
    // on that same connection must not resurrect it. A reconnect (new connection
    // object) clears the marker, so a genuinely new link may be tried again.
    /** @type {Map<string, object>} */
    const refusedConnections = new Map()
    const connectionOf = (hostId) => this.#hostById(hostId)?.connection
    // A Host that keeps ending its control stream — whether or not it greeted with
    // a baseline — is not feeding the chip; stop after this many short-lived
    // re-opens instead of spinning.
    const maxSilentReopens = 5
    // A greeting baseline is not sustained progress: a Host can greet and drop in
    // milliseconds. Only a stream open this long clears the short-lived streak.
    const streamStableMs = 1000
    let localBlocks = {}
    let started = false
    /**
     * Projection keys currently held per merged session id. A late baseline can
     * only ride as projection frames when the cut carries every key the native
     * store already has for that session (ProjectionValueStore.seed clears the
     * rest). Live frames add keys too, so they are recorded here as well.
     * @type {Map<string, Set<string>>}
     */
    const knownKeys = new Map()
    /** Remembers keys learned from a sequenced block or frame; ingress keeps keys intact. */
    const noteKeys = (id, values) => {
      if (!isPlainObject(values)) return
      let set = knownKeys.get(id)
      if (set === undefined) knownKeys.set(id, set = new Set())
      for (const key of Object.keys(values)) set.add(key)
    }
    const noteFrame = (frame) => {
      if (!isPlainObject(frame)) return
      const id = typeof frame.sessionId === 'string' ? frame.sessionId : null
      if (id === null) return
      if (frame.type === 'projection' && Array.isArray(frame.changes)) {
        for (const change of frame.changes) if (isPlainObject(change) && typeof change.key === 'string') noteKeys(id, { [change.key]: true })
      }
      // Every sequenced projection crossing the merged stream is an authoritative
      // whole value, including a late Host baseline re-sent as projection frames.
      this.#noteInboxProjectionFrame(frame)
    }
    // A cut that ended the previous generation is folded into THIS generation's
    // ONE opening baseline. Its Host may greet only after that baseline, so the
    // cut cannot wait for the greeting: a -1 cursor has no projection frame and
    // a cut that omits a key only clears the native store when seeded.
    const carried = this.#snapshotCarriedControlCuts()
    /**
     * Watermarks of cuts carried from the generation that rebased, by merged session
     * id. A late greeting repeating one of these is a duplicate of what THIS
     * generation's opening baseline already seeded; greetings first folded in here
     * are not in this map, so a remote that reopens its own stream still republishes
     * its cut as an ordinary projection frame.
     */
    const carriedCutSeqs = new Map()
    for (const [mergedId, entry] of carried) {
      carriedCutSeqs.set(mergedId, entry.block.asOfSeq)
      noteKeys(mergedId, entry.block.values)
    }
    /**
     * A baseline needing seed semantics (negative cursor or an omitted key)
     * cannot be synthesized from projection frames. End this stream after its
     * accepted opening baseline so the native RemoteStream retries and the
     * reopened generation publishes one coherent, freshly seeded baseline.
     */
    const rebase = (why) => {
      if (lifetime.signal.aborted) return
      this.#log(`${SESSION_CONTROL_ENDPOINT} re-opening merged stream: ${why}`)
      stop()
    }
    /** Increments that arrived before the first combined baseline (bounded by time, not count). */
    const pending = []
    const emit = (frame) => {
      noteFrame(frame)
      if (started) queue.push(frame)
      else pending.push(frame)
    }
    // A remote follow can publish its claim watermark here. Going through `emit`
    // keeps the snapshot-stream rule: a frame arriving before the opening baseline
    // is replayed after it, never before it and never as a second baseline.
    const controlSink = (frame) => emit(frame)
    // A new generation seeds its own projection rows; a claim this router already
    // published in the old generation may need to be advanced again there.
    this.#fallbackControlSeqs.clear()
    this.#controlSinks.add(controlSink)
    const combinedBaseline = () => {
      const projections = { ...localBlocks }
      for (const [mergedId, entry] of carried) projections[mergedId] = entry.block
      for (const pump of pumps.values()) Object.assign(projections, pump.blocks)
      return { type: 'baseline', value: { projections } }
    }
    // Only the generator below publishes the opening baseline, once. Before that,
    // a folded-in baseline is picked up by `combinedBaseline()`; after that, a
    // re-baseline rides as projection frames OR ends this whole stream so the
    // native retry opens a new generation with one replacement baseline — never
    // a second opening snapshot in the current generation.
    // An obsolete pump must never remove the one that replaced it: `expected`
    // binds this removal to the pump whose error or backoff actually ended.
    const drop = (hostId, expected) => {
      const pump = pumps.get(hostId)
      if (!pump || (expected && pump !== expected)) return
      pump.abort()
      pumps.delete(hostId)
      // A host dropping out does not withdraw its projections from the store,
      // and publishing a baseline here would be a second opening snapshot.
    }

    const start = (host) => {
      if (pumps.has(host.hostId)) return
      if (refusedConnections.has(host.hostId)) {
        if (refusedConnections.get(host.hostId) === connectionOf(host.hostId)) return
        refusedConnections.delete(host.hostId) // a new connection may retry
      }
      const hostControl = new AbortController()
      const pump = { abort: () => hostControl.abort(), blocks: {} }
      pumps.set(host.hostId, pump)
      void (async () => {
        let attempt = 0
        let shortLived = 0
        while (!hostControl.signal.aborted && !lifetime.signal.aborted) {
          let progressed = false
          let openedAt = 0
          // The connection this attempt actually used: a refusal belongs to it,
          // not to whatever connection is live when the error eventually arrives.
          let openedConnection = null
          try {
            // Re-resolve on every attempt: a link that came back while this pump
            // waited has a new connection, and a stale one cannot serve it.
            const current = this.#hostById(host.hostId)
            if (!current) {
              await this.#awaitHost(host.hostId, AbortSignal.any([hostControl.signal, lifetime.signal]))
              continue
            }
            openedConnection = current.connection
            const source = await openedConnection.openStream(SESSION_CONTROL_ENDPOINT, {},
              { signal: AbortSignal.any([hostControl.signal, lifetime.signal]) })
            openedAt = Date.now()
            for await (const frame of source) {
              if (hostControl.signal.aborted || lifetime.signal.aborted) break
              if (!isPlainObject(frame)) continue
              if (frame.type === 'baseline') {
                if (started) {
                  const projections = this.#controlBaselineFrames(frame, host.hostId, knownKeys, carriedCutSeqs,
                    (mergedId) => this.#retireCarriedControlCut(mergedId))
                  if (projections === null) {
                    // Carry this cut across to the reopened generation: its Host
                    // greeting is asynchronous and may arrive after that generation
                    // has already published its ONE opening baseline.
                    const cut = {}
                    this.#mergeControlBaseline(cut, frame, host.hostId)
                    this.#rememberControlCuts(host.hostId, cut)
                    rebase(`remote ${host.hostId} baseline needs native seed semantics`)
                    return
                  }
                  for (const projection of projections) emit(projection)
                } else {
                  pump.blocks = {}
                  this.#mergeControlBaseline(pump.blocks, frame, host.hostId)
                  for (const [id, block] of Object.entries(pump.blocks)) {
                    if (isPlainObject(block)) noteKeys(id, block.values)
                  }
                }
                progressed = true
                continue
              }
              if (frame.type === 'projection') {
                emit(this.#ingress(host.hostId, frame, SESSION_CONTROL_ENDPOINT))
                progressed = true
              }
            }
            // A normal end (the Host sent `remote-stream-closed`) is recoverable:
            // the link is still online, so re-open instead of leaving `pumps.has`
            // to block every later host-change notification (the model chip froze).
          } catch (error) {
            if (hostControl.signal.aborted || lifetime.signal.aborted) return
            this.#noteHostError(host.hostId, error)
            // A refusal the Host produced (`auth/*`) or a hostile payload
            // (`remote/id-leak`, `remote/payload-too-deep`) will not change on a
            // re-open: end this pump, exactly as a single-attempt stream did.
            if (!isLinkFailure(error)) {
              this.#log(`${SESSION_CONTROL_ENDPOINT} from ${host.hostId} refused: ${error?.code ?? 'error'}`)
              const liveHost = this.#hostById(host.hostId)
              if (liveHost && liveHost.connection !== openedConnection) {
                // A stale attempt's refusal says nothing about its replacement.
                // The host-change notification could not start a pump while this
                // one still held the slot, so hand that slot to the live link.
                drop(host.hostId, pump)
                start(liveHost)
                return
              }
              refusedConnections.set(host.hostId, openedConnection ?? host.connection)
              drop(host.hostId, pump)
              return
            }
            this.#log(`${SESSION_CONTROL_ENDPOINT} from ${host.hostId} stopped: ${error?.code ?? 'error'}; it reopens with the link`)
          }
          if (hostControl.signal.aborted || lifetime.signal.aborted) return
          if (pumps.get(host.hostId) !== pump) return
          // A greeting baseline is not sustained progress. Only a stream that
          // stayed open past the stability interval clears the short-lived streak;
          // consecutive greet-and-drop opens are bounded below.
          if (openedAt > 0 && Date.now() - openedAt >= streamStableMs) shortLived = 0
          else if (openedAt > 0) shortLived += 1
          if (shortLived > maxSilentReopens) {
            this.#log(`${SESSION_CONTROL_ENDPOINT} from ${host.hostId} stopped after ${maxSilentReopens} short-lived re-opens`)
            drop(host.hostId, pump)
            return
          }
          // A delivered frame means the link works: a later end starts at the
          // shortest delay. Silent ends keep growing the backoff.
          if (progressed) attempt = 0
          attempt += 1
          if (attempt > maxSilentReopens) {
            this.#log(`${SESSION_CONTROL_ENDPOINT} from ${host.hostId} stopped after ${maxSilentReopens} silent re-opens`)
            drop(host.hostId, pump)
            return
          }
          await this.#awaitHost(host.hostId, AbortSignal.any([hostControl.signal, lifetime.signal]), Math.min(100 * attempt, 1000))
        }
      })()
    }

    const onAbort = () => stop()
    const watched = [signal, control?.signal].filter(Boolean)
    for (const source of watched) {
      if (source.aborted) onAbort()
      else source.addEventListener('abort', onAbort, { once: true })
    }
    let unsubscribe = null
    try {
      const localSignal = signal ? AbortSignal.any([signal, lifetime.signal]) : lifetime.signal
      const localControl = control ?? new AbortController()
      const localSource = await this.#localOpen(SESSION_CONTROL_ENDPOINT, payload, uplink, peer, localSignal, localControl, uplinkWindow)
      let settleLocal = { resolve: () => {}, reject: () => {} }
      const localReady = new Promise((resolve, reject) => { settleLocal = { resolve, reject } })
      localReady.catch(() => {})
      void (async () => {
        try {
          for await (const frame of localSource) {
            if (lifetime.signal.aborted) break
            if (isPlainObject(frame) && frame.type === 'baseline') {
              if (started) {
                const projections = this.#controlBaselineFrames(frame, null, knownKeys, carriedCutSeqs,
                  (mergedId) => this.#retireCarriedControlCut(mergedId))
                if (projections === null) {
                  const cut = {}
                  this.#mergeControlBaseline(cut, frame, null)
                  this.#rememberControlCuts(null, cut)
                  rebase('Local baseline needs native seed semantics')
                  settleLocal.resolve()
                  return
                }
                for (const projection of projections) emit(projection)
              } else {
                localBlocks = {}
                this.#mergeControlBaseline(localBlocks, frame, null)
                for (const [id, block] of Object.entries(localBlocks)) {
                  if (isPlainObject(block)) noteKeys(id, block.values)
                }
              }
              settleLocal.resolve()
              continue
            }
            // Local frames are already in the controller's namespace.
            emit(frame)
          }
        } catch (error) {
          if (lifetime.signal.aborted) return
          settleLocal.reject(error)
          queue.fail(error)
        }
      })()

      for (const host of this.#connectedHosts()) start(host)
      unsubscribe = this.#onHostsChanged(() => {
        const hosts = this.#connectedHosts()
        const connected = new Set(hosts.map((host) => host.hostId))
        // An offline paired host still appears in knownHosts and keeps its marker;
        // a host removed from the inventory does not. start() separately checks the
        // connection object, so a new Host reusing the id inherits no refusal.
        const configured = new Set([...connected, ...this.#disconnectedHosts().map((host) => host.hostId)])
        for (const hostId of refusedConnections.keys()) if (!configured.has(hostId)) refusedConnections.delete(hostId)
        for (const host of hosts) start(host)
        for (const hostId of [...pumps.keys()]) if (!connected.has(hostId)) drop(hostId)
      })

      await Promise.race([localReady, this.#delay(this.#baselineTimeoutMs)])
      started = true
      // Snapshot this exact cut: a pump/local baseline buffered by `emit` while
      // the timeout settled must still be re-sent as a projection, not folded
      // into a second opening baseline here.
      const openingBaseline = combinedBaseline()
      queue.push(openingBaseline)
      for (const frame of pending) queue.push(frame)
      pending.length = 0
      for await (const frame of queue) yield frame
    } finally {
      for (const source of watched) source.removeEventListener?.('abort', onAbort)
      unsubscribe?.()
      this.#controlSinks.delete(controlSink)
      this.#merges.delete(stop)
      stop()
      refusedConnections.clear()
    }
  }

  #delay(ms) {
    return new Promise((resolve) => {
      const timer = setTimeout(resolve, ms)
      timer.unref?.()
    })
  }
}

/** @param {ConstructorParameters<typeof HostRouter>[0]} deps */
export function createHostRouter(deps) {
  return new HostRouter(deps)
}

export default createHostRouter

