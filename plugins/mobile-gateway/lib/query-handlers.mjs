// Mobile query dispatch (`handleQuery`) and its helpers, moved verbatim from index.mjs.
import { log } from './logging.mjs'
import { assistantFinish, toolResultDetails } from './session-event-details.mjs'
import { toolImages } from './tool-images.mjs'
import { SESSION_FORMAT_VERSION } from './dsh-host-adapter.mjs'
import { handlePluginQuery, PLUGIN_REQUEST_TYPES } from './plugin-management.mjs'
import { parseSessionTarget } from './session-target.mjs'
import { serializeMessageText } from './message-text.mjs'
import { createServerDirectory, listServerDirectory } from './file-transfer.mjs'
import { handleScheduleQuery, SCHEDULE_REQUEST_TYPES } from './schedule-management.mjs'
import { SCHEDULE_READ_TYPES } from './allowlist.mjs'
import { COMMAND_CATALOG_COPY, COMMAND_UI_OVERRIDES } from './gateway-constants.mjs'
import {
  PRESET_ID, admitCommand, commandAcceptsAttachments, listHostCommands, parseAgentPreset, proxyQuery,
  querySessionProjection, requireSessionId,
} from './host-commands.mjs'

/**
 * The fixed message a DEVICE gets for a failed `session-rename` / `session-archive` /
 * `schedule-catalog` / `schedule-list` / `schedule-view`. `proxyQuery` otherwise copies
 * `error.message` from the Host, whose text is not part of this contract and can name
 * Host internals (a filesystem path, a title the device may not read, a record id). The
 * device keeps the structured `code` and learns a stable sentence instead; the admin
 * (owner) loopback keeps the Host's own text, the same split the `workspaces` projection
 * already draws. One KEY PER CODE, never one generic sentence, so the refusal still
 * distinguishes its causes: no Claude-style "invalid code" collapse.
 */
const DEVICE_SESSION_EDIT_MESSAGES = Object.freeze({
  'session-rename': Object.freeze({
    'bad-request': 'the title must be a non-empty string of at most 200 characters',
    'session/title-invalid': 'the Host rejected the new session title',
  }),
  'session-archive': Object.freeze({
    'bad-request': 'the request must name the session to archive',
    'session/not-found': 'the Host does not serve this session to this device',
  }),
  'schedule-catalog': Object.freeze({
    'bad-request': 'schedule-catalog takes no arguments',
  }),
  'schedule-list': Object.freeze({
    'bad-request': 'schedule-list takes a limit of 1..500, a nonnegative offset and active only on a host-wide list',
  }),
  'schedule-view': Object.freeze({
    'bad-request': 'schedule-view requires the id of one scheduled task',
  }),
})

/** `code`'s fixed device sentence for `requestType`, or a code-named sentence for an unmapped code. */
function deviceRefusalMessage(requestType, code) {
  const byType = Object.hasOwn(DEVICE_SESSION_EDIT_MESSAGES, requestType) ? DEVICE_SESSION_EDIT_MESSAGES[requestType] : null
  if (byType !== null && Object.hasOwn(byType, code)) return byType[code]
  // Unmapped codes still drop the Host's free text; the code itself is structured data.
  return `${requestType} failed (${code})`
}


// Goal mutations use DSH's compare-and-set reference. Returning a stale
// revision is intentionally rejected by DSH instead of overwriting a newer
// WebUI/mobile update.
function requireGoalRef(msg, sessionId) {
  const ref = msg.ref
  const id = ref && typeof ref.id === 'string' && ref.id.trim() !== '' ? ref.id.trim() : null
  const revision = ref && typeof ref.revision === 'number' && Number.isSafeInteger(ref.revision) && ref.revision > 0
    ? ref.revision
    : null
  if (!id || revision === null) {
    return {
      error: {
        kind: 'error',
        code: 'bad-request',
        message: `${typeof msg.type === 'string' ? msg.type : 'goal mutation'} requires ref.id and a positive integer ref.revision`,
        requestType: typeof msg.type === 'string' ? msg.type : 'goal',
        sessionId,
      },
    }
  }
  return { value: { id, revision } }
}

async function readSessionProjection(api, type, sessionId, key, target = { sessionId }) {
  const history = await proxyQuery(api, 'history', api.sessions.history.bind(api.sessions), { ...target, maxMessages: 1 })
  if (history.kind !== 'history') return { ...history, ...target, requestType: type }
  const values = (history.projections && history.projections.values) || {}
  return {
    kind: type,
    ...target,
    asOfSeq: history.projections ? history.projections.asOfSeq : undefined,
    [key]: Object.prototype.hasOwnProperty.call(values, key) ? values[key] : null,
  }
}

async function mutateGoal(api, type, method, payload) {
  if (!api.goals || typeof api.goals[method] !== 'function') {
    return {
      kind: 'error',
      code: 'unsupported',
      message: 'goal management is unavailable in this DSH host',
      requestType: type,
      sessionId: payload.sessionId,
    }
  }
  return proxyQuery(api, type, api.goals[method].bind(api.goals), payload)
}

// ---------------------------------------------------------------------------
// History frame sizing: raw session logs can be huge (trajectory, tool output,
// context), so a single history response must never blow the client's
// WebSocket frame limit. We cap the serialized size per frame, keep the NEWEST
// suffix within the budget, and hand the client `hasMore` + `nextBeforeSeq` so
// it can page backward. An optional `view: "conversation"` trims events that
// are not needed for a chat page (token-level chunks, system-prompt headers)
// and truncates oversized tool-result text.
// ---------------------------------------------------------------------------
const HISTORY_DEFAULT_MAX_BYTES = 4 * 1024 * 1024 // 4 MiB per frame
// Opening snapshots should be readable before older history is requested.
// Keep the newest indivisible message even when it alone exceeds this budget.
const HISTORY_OPENING_MAX_BYTES = 256 * 1024
const HISTORY_TOOL_RESULT_MAX_CHARS = 2000 // per text block in conversation view

function eventBytes(event) {
  return Buffer.byteLength(JSON.stringify(event), 'utf8')
}

// Trim one event for the conversation page: null drops it, otherwise a shallow
// copy with oversized payloads truncated. The events come from the host RPC as
// plain JSON, so copying is safe.
function trimConversationEvent(event) {
  switch (event.type) {
    case 'assistant/chunk':
    case 'request/header':
    case 'request/context':
    case 'system/message':
      // token-level replay / system-prompt header: not rendered on the chat page
      return null
    case 'assistant/message':
    case 'assistant/attempt': {
      const { stream, ...data } = event.data || {}
      const finish = assistantFinish(event.data || {})
      return { ...event, data: { ...data, ...(finish ? { finish } : {}) } }
    }
    case 'tool/result': {
      const d = event.data || {}
      const message = d.message
      const images = toolImages(d)
      const details = { ...toolResultDetails(d), ...(images.length ? { images } : {}) }
      if (!message || !Array.isArray(message.content)) return { ...event, data: { ...d, ...details } }
      let changed = false
      const truncateBlock = (block) => {
        if (!block || typeof block !== 'object') return block
        if (block.type === 'text' && typeof block.text === 'string' && block.text.length > HISTORY_TOOL_RESULT_MAX_CHARS) {
          changed = true
          return { ...block, text: block.text.slice(0, HISTORY_TOOL_RESULT_MAX_CHARS) + '…' }
        }
        if (Array.isArray(block.content)) {
          return { ...block, content: block.content.map(truncateBlock) }
        }
        return block
      }
      const content = message.content.map(truncateBlock)
      return { ...event, data: { ...d, ...details, ...(changed ? { message: { ...message, content } } : {}) } }
    }
    case 'tool/ptc-dispatch':
    case 'tool/code-dispatch': {
      const d = event.data || {}
      const images = toolImages(d, event.type)
      return { ...event, data: { ...d, ...(images.length ? { images } : {}) } }
    }
    default:
      return event
  }
}

// Keep the newest suffix of `events` (ascending seq) within `maxBytes`.
// Always keeps the newest event even if it alone exceeds the budget (an event
// cannot be split); drops older events beyond the budget. Returns the kept
// events, their total serialized bytes, and whether anything was dropped.
function capHistoryEvents(events, maxBytes, trim) {
  const processed = trim ? events.map(trimConversationEvent).filter(Boolean) : events
  if (processed.length === 0) return { events: [], bytes: 0, dropped: 0 }
  let total = 0
  let keptStart = processed.length
  for (let i = processed.length - 1; i >= 0; i--) {
    const size = eventBytes(processed[i])
    if (keptStart === processed.length) {
      // always keep the newest event
      total = size
      keptStart = i
      continue
    }
    if (total + size > maxBytes) break
    total += size
    keptStart = i
  }
  return { events: processed.slice(keptStart), bytes: total, dropped: keptStart }
}

function validateHistoryCursor(msg, sessionId, field) {
  if (msg[field] === undefined && msg.historyFormatVersion === undefined) return null
  if (msg.historyFormatVersion !== SESSION_FORMAT_VERSION) {
    return { kind: 'error', code: 'history-format-mismatch', requestType: msg.type, sessionId,
      historyFormatVersion: SESSION_FORMAT_VERSION, resetRequired: true,
      message: `Reload the Session baseline before using a history or fork cursor; historyFormatVersion must be ${SESSION_FORMAT_VERSION}` }
  }
  if (msg[field] !== undefined && (!Number.isSafeInteger(msg[field]) || msg[field] < 0)) {
    return { kind: 'error', code: 'bad-request', requestType: msg.type, sessionId,
      message: `${field} must be a non-negative safe integer` }
  }
  return null
}

function historyPage(value, msg) {
  const rawEvents = value.events.map(entry => entry.event)
  const maxBytes = Number.isSafeInteger(msg.maxBytes) && msg.maxBytes > 0 ? msg.maxBytes : HISTORY_DEFAULT_MAX_BYTES
  const trim = msg.view === 'conversation'
  const capped = capHistoryEvents(rawEvents, maxBytes, trim)
  const hasMore = value.hasMore === true || capped.dropped > 0
  // An all-hidden page still needs a cursor so callers can reach older text.
  const oldest = capped.events[0]?.seq ?? rawEvents[0]?.seq
  return { ...value, kind: 'history', sessionId: msg.sessionId,
    events: capped.events, bytes: capped.bytes, hasMore,
    ...(trim ? { view: 'conversation' } : {}),
    ...(hasMore && oldest !== undefined ? { nextBeforeSeq: oldest } : {}),
  }
}

function resolveCommandCatalogCopy(locale) {
  return typeof locale === 'string' && !locale.toLowerCase().startsWith('zh')
    ? COMMAND_CATALOG_COPY.en
    : COMMAND_CATALOG_COPY.zh
}


function commandUiDescriptor(command, copy) {
  const override = COMMAND_UI_OVERRIDES[command.name]
  if (override) return { ...override, insertText: `/${command.name}` }
  if (command.input && typeof command.input.hint === 'string') {
    const displayHint = copy.hints[command.name]
    return {
      kind: 'input',
      insertText: `/${command.name} `,
      hint: command.input.hint,
      ...(displayHint ? { displayHint } : {}),
      images: commandAcceptsAttachments(command),
      submitRequest: 'command-execute',
    }
  }
  return { kind: 'immediate', submitRequest: 'command-execute', submitText: `/${command.name}` }
}

function skillUiDescriptor(skill) {
  return {
    kind: 'input',
    insertText: `/${skill.name} `,
    images: true,
    submitRequest: 'message',
  }
}

function modelCommandOptionId(provider, model) {
  return Buffer.from(JSON.stringify([provider, model]), 'utf8').toString('base64url')
}

function decodeModelCommandOptionId(optionId) {
  try {
    const value = JSON.parse(Buffer.from(optionId, 'base64url').toString('utf8'))
    if (!Array.isArray(value) || value.length !== 2 || value.some((part) => typeof part !== 'string' || part === '')) return null
    return { provider: value[0], model: value[1] }
  } catch {
    return null
  }
}

async function loadCommandOptions(api, command, sessionId) {
  if (command === 'model') {
    const frame = await proxyQuery(api, 'models', api.sessions.models.bind(api.sessions), { sessionId })
    if (frame.kind !== 'models') return frame
    const options = []
    for (const group of frame.groups || []) {
      for (const model of group.models || []) {
        options.push({
          id: modelCommandOptionId(String(group.id), String(model.id)),
          label: String(model.name || model.id),
          detail: String(group.name || group.id),
          ...(model.description ? { description: String(model.description) } : {}),
          selected: frame.current && frame.current.provider === group.id && frame.current.model === model.id,
        })
      }
    }
    return { kind: 'command-options', sessionId, command, options }
  }

  if (command === 'permission') {
    const history = await proxyQuery(api, 'history', api.sessions.history.bind(api.sessions), { sessionId })
    if (history.kind !== 'history') return history
    const permissions = history.projections && history.projections.values && history.projections.values.permissions
    const catalog = await proxyQuery(api, 'permission-catalog', api.permissionPresets.catalog.bind(api.permissionPresets), {})
    if (catalog.kind === 'error') return catalog
    if (!permissions || typeof permissions.currentValue !== 'string' || !Array.isArray(catalog.options)) {
      return {
        kind: 'error',
        code: 'command-options-unavailable',
        message: 'permission options are unavailable for this session',
        requestType: 'command-options',
        sessionId,
      }
    }
    return {
      kind: 'command-options',
      sessionId,
      command,
      options: catalog.options.map((option) => ({
        id: String(option.value),
        label: String(option.name || option.value),
        ...(option.description ? { description: String(option.description) } : {}),
        selected: option.value === permissions.currentValue,
      })),
    }
  }

  return {
    kind: 'error',
    code: 'bad-request',
    message: `command does not provide selectable options: ${command}`,
    requestType: 'command-options',
    sessionId,
  }
}

async function selectCommandOption(api, host, command, sessionId, optionId) {
  const catalog = await loadCommandOptions(api, command, sessionId)
  if (catalog.kind !== 'command-options') return catalog
  const option = catalog.options.find((candidate) => candidate.id === optionId)
  if (!option) {
    return {
      kind: 'error',
      code: 'bad-request',
      message: `unknown option for ${command}: ${optionId}`,
      requestType: 'command-select',
      sessionId,
    }
  }

  if (command === 'permission') {
    try {
      const execution = await host.commands.execute(
        sessionId,
        '/permission ' + optionId,
        [],
        new AbortController().signal,
      )
      if (!execution || !execution.result) throw new Error('permission command returned an invalid result')
      if (execution.result.kind === 'error') {
        return { kind: 'error', code: 'command-error', message: execution.result.text, requestType: 'command-select', sessionId }
      }
      return { kind: 'command-selected', sessionId, command, selected: { ...option, selected: true } }
    } catch (error) {
      const code = error && error.code ? error.code : 'internal'
      const message = error && error.message ? error.message : String(error)
      return { kind: 'error', code, message, requestType: 'command-select', sessionId }
    }
  }

  if (command === 'model') {
    const selection = decodeModelCommandOptionId(optionId)
    if (!selection) {
      return { kind: 'error', code: 'bad-request', message: 'invalid model option id', requestType: 'command-select', sessionId }
    }
    const models = await proxyQuery(api, 'models', api.sessions.models.bind(api.sessions), { sessionId })
    if (models.kind !== 'models') return models
    const group = (models.groups || []).find((candidate) => candidate.id === selection.provider)
    const model = group && (group.models || []).find((candidate) => candidate.id === selection.model)
    if (!model) {
      return { kind: 'error', code: 'bad-request', message: 'model option is no longer available', requestType: 'command-select', sessionId }
    }
    const payload = { sessionId, ...selection }
    const reasoningEffort = models.current && models.current.provider === selection.provider && models.current.model === selection.model
      ? models.current.reasoningEffort
      : model.reasoning && model.reasoning.defaultEffort
    if (reasoningEffort) payload.reasoningEffort = reasoningEffort
    const selected = await proxyQuery(api, 'select-model', api.sessions.selectModel.bind(api.sessions), payload)
    if (selected.kind !== 'select-model') return selected
    return {
      kind: 'command-selected',
      sessionId,
      command,
      selected: { ...option, selected: true },
      value: selected.selected,
    }
  }

  return { kind: 'error', code: 'bad-request', message: `command is not selectable: ${command}`, requestType: 'command-select', sessionId }
}

/**
 * Whether this dispatch came from the loopback admin surface rather than a paired device.
 * `handleQuery` learns the socket from its two call sites: the admin management branch
 * passes only `{ workspaceGroupFieldsFor, ... }`, the device branches pass the sending
 * `ws` as `client`. That field is the ONE discriminator, because `adminCaller` also
 * covers a test-only `legacyAdmin` device socket, which still speaks the device wire.
 */
function deviceless(pluginContext) {
  return pluginContext?.client === undefined
}


// Dispatch one mobile query frame; returns the wire frame to send back.
async function handleQuery(api, host, agentDefaultModel, msg, pluginContext) {
  if (PLUGIN_REQUEST_TYPES.has(msg.type)) return handlePluginQuery(api, msg, pluginContext)
  if (msg.type === 'agent-team' || msg.type === 'subagents') {
    const session = requireSessionId(msg)
    const identity = typeof msg.requestId === 'string' ? { requestId: msg.requestId } : {}
    if (session.error) return { ...session.error, ...identity }
    const sessionId = session.value
    const key = msg.type === 'agent-team' ? 'agentTeam' : 'subagentCatalog'
    try {
      const snapshot = await api.sessions.projections({ sessionId })
      if (snapshot === null) throw Object.assign(new Error('session not found'), { code: 'session/not-found' })
      if (!['sequenced', 'migration-required'].includes(snapshot?.kind)
        || !snapshot.values || (snapshot.kind === 'sequenced' && !Number.isSafeInteger(snapshot.asOfSeq))) {
        throw new Error('invalid session projections')
      }
      const value = snapshot.values[key] ?? null
      if (value !== null && (key === 'subagentCatalog' ? !Array.isArray(value)
        : !Array.isArray(value.members) || !Array.isArray(value.tasks))) throw new Error('invalid team projection')
      return { kind: msg.type, sessionId, ...identity,
        projectionState: snapshot.kind === 'migration-required' ? 'migration-required'
          : value === null ? 'unavailable' : 'ready',
        ...(snapshot.kind === 'sequenced' ? { asOfSeq: snapshot.asOfSeq } : {}), [key]: value }
    } catch (error) {
      return { kind: 'error', code: error.code || 'internal', message: error.message,
        requestType: msg.type, sessionId, ...identity }
    }
  }
  if (msg.type === 'session-agent-preset' || msg.type === 'select-agent-preset') {
    const session = requireSessionId(msg)
    const preset = parseAgentPreset(msg, msg.type, msg.type === 'select-agent-preset')
    const requestId = typeof msg.requestId === 'string' ? { requestId: msg.requestId } : {}
    if (session.error || preset.error) return { ...(session.error || preset.error), ...requestId }
    const method = msg.type === 'session-agent-preset' ? 'session' : 'select'
    const frame = await proxyQuery(api, msg.type, api.agentPresets[method].bind(api.agentPresets), {
      sessionId: session.value, ...(preset.value === undefined ? {} : { agentPreset: preset.value }),
    })
    return { ...frame, sessionId: session.value, ...requestId }
  }
  if (msg.type === 'session-create') {
    if (typeof msg.requestId !== 'string' || !msg.requestId.trim()) {
      return { kind: 'error', code: 'bad-request', message: 'session-create requires a requestId', requestType: 'session-create' }
    }
    const payload = {}
    const preset = parseAgentPreset(msg, msg.type)
    if (preset.error) return { ...preset.error, requestId: msg.requestId }
    if (preset.value !== undefined) payload.agentPreset = preset.value
    if (typeof msg.workspaceId === 'string' && msg.workspaceId.trim()) {
      payload.workspaceId = msg.workspaceId.trim()
    } else if (typeof msg.cwd === 'string' && msg.cwd.trim()) {
      payload.cwd = msg.cwd.trim()
    }
    const frame = await proxyQuery(api, 'session-created', api.sessions.create.bind(api.sessions), payload)
    return { ...frame, ...(frame.kind === 'error' ? { requestType: 'session-create' } : {}), requestId: msg.requestId }
  }
  if (msg.type === 'workspaces') {
    return proxyQuery(api, 'workspaces', api.workspace.list.bind(api.workspace), {})
  }
  if (msg.type === 'sessions') {
    const frame = await proxyQuery(api, 'sessions', api.sessions.list.bind(api.sessions), {})
    if (frame.kind !== 'sessions' || !Array.isArray(frame.items)) return frame
    // Spec 011 addendum: the companion groups conversations by workspace. DSH's
    // session record carries no workspaceId, so the gateway attaches the id the Host
    // itself relates the session to (`workspace.sessionIds`) plus that workspace's
    // label, from the same rule the `workspaces` op uses; a direct-subagent session
    // inherits its parent's workspace. Additive and optional: `workspaceId` and
    // `workspaceLabel` are omitted together when the Host relates the session to no
    // workspace. Only an id and a basename label travel — never a path — and a row
    // reaches a client only if that client may see it.
    const groupFieldsFor = typeof pluginContext?.workspaceGroupFieldsFor === 'function'
      ? pluginContext.workspaceGroupFieldsFor : undefined
    // Lists need only titles; full projections can make these frames many MiB.
    // Copy at the mobile boundary so Host data and history projections stay intact.
    return { ...frame, items: frame.items.map(item => {
      const group = groupFieldsFor === undefined || !item
        ? undefined
        : groupFieldsFor(item.sessionId, item.parentSessionId)
      const withWorkspace = group === undefined ? item : { ...item, ...group }
      if (!withWorkspace?.projections) return withWorkspace
      const { asOfSeq, values } = withWorkspace.projections
      // Spec 018: the session screen shows which agent preset the session runs (view only).
      // Only the plain preset ID travels: a Host value outside the ID charset stays on the Host.
      const agentPreset = values?.agentPreset
      const shownPreset = typeof agentPreset === 'string' && PRESET_ID.test(agentPreset) ? agentPreset : undefined
      return { ...withWorkspace, projections: {
        ...(asOfSeq === undefined ? {} : { asOfSeq }),
        values: { ...(values && Object.hasOwn(values, 'title') ? { title: values.title } : {}),
          ...(shownPreset === undefined ? {} : { agentPreset: shownPreset }) },
      } }
    }) }
  }
  if (msg.type === 'history') {
    const target = parseSessionTarget(msg)
    if (target.error) return target.error
    const { sessionId } = target.value
    const identity = typeof msg.requestId === 'string' ? { requestId: msg.requestId } : {}
    const cursorError = validateHistoryCursor(msg, sessionId, 'beforeSeq')
    if (cursorError) return { ...cursorError, ...target.value, ...identity }
    const payload = { ...target.value }
    if (typeof msg.beforeSeq === 'number' && Number.isFinite(msg.beforeSeq)) payload.beforeSeq = msg.beforeSeq
    if (typeof msg.maxMessages === 'number' && Number.isFinite(msg.maxMessages)) payload.maxMessages = msg.maxMessages
    const frame = await proxyQuery(api, 'history', api.sessions.history.bind(api.sessions), payload)
    if (frame.kind === 'history') return { ...historyPage(frame, { ...msg, sessionId }), ...target.value, ...identity }
    return { ...frame, ...target.value, ...identity }
  }
  if (msg.type === 'attachment') {
    const sessionId = requireSessionId(msg)
    if (sessionId.error) return sessionId.error
    const attachmentId = typeof msg.attachmentId === 'string' && msg.attachmentId.trim() !== '' ? msg.attachmentId.trim() : null
    if (!attachmentId) {
      return { kind: 'error', code: 'bad-request', message: 'attachment requires an attachmentId', requestType: 'attachment', sessionId: sessionId.value }
    }
    const frame = await proxyQuery(api, 'attachment', api.sessions.attachment.bind(api.sessions), {
      sessionId: sessionId.value,
      attachmentId,
    })
    if (frame.kind === 'attachment') frame.sessionId = sessionId.value
    return frame
  }
  if (msg.type === 'search') {
    const query = typeof msg.query === 'string' ? msg.query.trim() : ''
    if (!query) {
      return { kind: 'error', code: 'bad-request', message: 'search requires a query', requestType: 'search' }
    }
    return proxyQuery(api, 'search', api.sessions.search.bind(api.sessions), { query }, new AbortController().signal)
  }
  if (msg.type === 'host') {
    return proxyQuery(api, 'host', api.host.describe.bind(api.host), {})
  }
  if (msg.type === 'default-model') {
    try {
      const selection = agentDefaultModel.currentSelection()
      log(`default-model queried: ${selection.provider}/${selection.model}`)
      return { kind: 'default-model', selection }
    } catch (error) {
      const message = error && error.message ? error.message : String(error)
      return { kind: 'error', code: 'internal', message, requestType: 'default-model' }
    }
  }
  if (msg.type === 'save-default-model') {
    const provider = typeof msg.provider === 'string' && msg.provider.trim() !== '' ? msg.provider.trim() : null
    const model = typeof msg.model === 'string' && msg.model.trim() !== '' ? msg.model.trim() : null
    if (!provider || !model) {
      return { kind: 'error', code: 'bad-request', message: 'save-default-model requires provider and model', requestType: 'save-default-model' }
    }
    const selection = { provider, model }
    if (typeof msg.reasoningEffort === 'string' && msg.reasoningEffort.trim() !== '') selection.reasoningEffort = msg.reasoningEffort.trim()
    try {
      await agentDefaultModel.saveSelection(selection)
      log(`default model saved: ${provider}/${model}${selection.reasoningEffort ? ' (effort=' + selection.reasoningEffort + ')' : ''}`)
      return { kind: 'save-default-model', saved: selection }
    } catch (error) {
      const message = error && error.message ? error.message : String(error)
      log(`save-default-model failed: ${message}`)
      return { kind: 'error', code: 'internal', message, requestType: 'save-default-model' }
    }
  }
  if (msg.type === 'fork') {
    const sessionId = requireSessionId(msg)
    if (sessionId.error) return sessionId.error
    const cursorError = validateHistoryCursor(msg, sessionId.value, 'atSeq')
    if (cursorError) return cursorError
    const payload = { sessionId: sessionId.value }
    if (typeof msg.atSeq === 'number' && Number.isFinite(msg.atSeq)) payload.atSeq = Math.floor(msg.atSeq)
    const frame = await proxyQuery(api, 'fork', api.sessions.fork.bind(api.sessions), payload)
    if (frame.kind === 'fork') {
      log(`forked session ${sessionId.value} -> ${frame.sessionId}${payload.atSeq !== undefined ? ' at seq ' + payload.atSeq : ''}`)
    }
    return frame
  }
  if (msg.type === 'session-cancel') {
    const target = parseSessionTarget(msg)
    if (target.error) return target.error
    const identity = typeof msg.requestId === 'string' ? { requestId: msg.requestId } : {}
    const frame = await proxyQuery(
      api,
      'session-cancel',
      api.sessions.cancel.bind(api.sessions),
      target.value,
    )
    if (frame.kind === 'error') return { ...frame, ...target.value, ...identity }
    return { ...frame, kind: 'session-cancelled', ...target.value, ...identity }
  }
  if (msg.type === 'queue-update') {
    const sessionId = requireSessionId(msg)
    if (sessionId.error) return sessionId.error
    const itemId = typeof msg.itemId === 'string' && msg.itemId.trim() ? msg.itemId.trim() : null
    const actionKind = typeof msg.action === 'string' ? msg.action.trim() : ''
    if (!itemId || !['edit', 'remove', 'steer'].includes(actionKind)) {
      return {
        kind: 'error',
        code: 'bad-request',
        message: 'queue-update requires itemId and action edit, remove, or steer',
        requestType: 'queue-update',
        sessionId: sessionId.value,
      }
    }
    let action
    if (actionKind === 'edit') {
      let text = msg.text
      try {
        if (msg.textParts !== undefined) text = serializeMessageText(msg.text, msg.textParts)
        if (typeof text !== 'string' || !text.trim()) throw new Error('queue-update edit requires non-empty text')
      } catch (error) {
        return {
          kind: 'error',
          code: 'bad-request',
          message: error.message,
          requestType: 'queue-update',
          sessionId: sessionId.value,
          itemId,
        }
      }
      action = { kind: 'edit', content: [{ type: 'text', text }] }
    } else {
      action = { kind: actionKind }
    }
    const frame = await proxyQuery(
      api,
      'queue-update',
      api.sessions.updateQueue.bind(api.sessions),
      { sessionId: sessionId.value, itemId, action },
    )
    if (frame.kind === 'error') return { ...frame, sessionId: sessionId.value, itemId }
    return {
      ...frame,
      kind: 'queue-item-updated',
      sessionId: sessionId.value,
      itemId,
      action: actionKind,
    }
  }
  if (msg.type === 'session-archive') {
    const sessionId = requireSessionId(msg)
    if (sessionId.error) return sessionId.error
    const frame = await proxyQuery(
      api,
      'session-archive',
      api.workspace.archiveSession.bind(api.workspace),
      { sessionId: sessionId.value },
    )
    if (frame.kind === 'error') {
      // Reviewer item 5(b): Host text never reaches a device — it names Host internals
      // and is not contract. The admin path keeps the Host's own message.
      const reply = deviceless(pluginContext) ? frame : { ...frame, message: deviceRefusalMessage('session-archive', frame.code) }
      return { ...reply, sessionId: sessionId.value }
    }
    // Reviewer item 5(a): the Host replies with its COMPLETE archive set (PROTOCOL.md §5),
    // so an unfiltered pass-through shows a device the ids of every session the owner
    // archived — sessions that device may not see. Reduce it by the SAME per-recipient
    // rule the `session-archives` broadcast uses (`aggregateFrameFor`), not a second
    // filter that could drift from it. An admin socket gets the whole set back unchanged;
    // a device whose credential is no longer live would be sent no broadcast at all, so
    // it gets the `sessionId` receipt with no set, never the Host's.
    // Fail closed: a DEVICE socket without the reducer cannot apply the rule, so it
    // gets no set at all rather than the Host's complete one. Only the admin path,
    // which is the owner and needs no reduction, keeps the set unchanged.
    const { archivedSessionIds: hostArchives, ...receipt } = frame
    let archivedSessionIds
    if (deviceless(pluginContext)) {
      archivedSessionIds = frame.archivedSessionIds
    } else {
      const reduceArchives = typeof pluginContext?.aggregateFrameFor === 'function' ? pluginContext.aggregateFrameFor : undefined
      if (reduceArchives !== undefined && Array.isArray(frame.archivedSessionIds)) {
        const visible = reduceArchives(pluginContext.client, { kind: 'session-archives', archivedSessionIds: frame.archivedSessionIds })
        archivedSessionIds = visible === null ? undefined : visible.archivedSessionIds
      }
    }
    return { ...receipt, kind: 'session-archived', sessionId: sessionId.value, ...(Array.isArray(archivedSessionIds) ? { archivedSessionIds } : {}) }
  }
  if (msg.type === 'session-rename') {
    const sessionId = requireSessionId(msg)
    if (sessionId.error) return sessionId.error
    // Revision 11 (contract §4): the title is trimmed and must be non-empty and at
    // most 200 CODE POINTS. Counted in code points, not UTF-16 units, so one emoji
    // is one character — 200 emoji pass where a UTF-16 count would refuse them while
    // looking short. The trimmed value is what is stored and echoed.
    const title = typeof msg.title === 'string' ? msg.title.trim() : ''
    const refusal = !title
      ? 'session-rename requires a non-empty title'
      : Array.from(title).length > 200
        ? 'session-rename title must be at most 200 characters'
        : null
    if (refusal !== null) {
      return {
        kind: 'error',
        code: 'bad-request',
        message: refusal,
        requestType: 'session-rename',
        sessionId: sessionId.value,
      }
    }
    const frame = await proxyQuery(
      api,
      'session-rename',
      api.sessions.rename.bind(api.sessions),
      { sessionId: sessionId.value, title },
    )
    if (frame.kind === 'error') {
      // Reviewer item 5(b): fixed device text, the Host's own text on the admin path.
      const reply = deviceless(pluginContext) ? frame : { ...frame, message: deviceRefusalMessage('session-rename', frame.code) }
      return { ...reply, sessionId: sessionId.value }
    }
    // Contract §4: the receipt carries the trimmed title that was stored, never the
    // untrimmed request value.
    return { ...frame, kind: 'session-renamed', sessionId: sessionId.value, title }
  }
  if (msg.type === 'workspace-create') {
    const wsPath = typeof msg.path === 'string' && msg.path.trim() !== '' ? msg.path.trim() : null
    if (!wsPath) {
      return { kind: 'error', code: 'bad-request', message: 'workspace-create requires a path', requestType: 'workspace-create' }
    }
    return proxyQuery(api, 'workspace-create', api.workspace.create.bind(api.workspace), { path: wsPath })
  }
  if (msg.type === 'directories') {
    return listServerDirectory(typeof msg.path === 'string' && msg.path.trim() !== '' ? msg.path.trim() : undefined)
  }
  if (msg.type === 'directory-create') {
    return createServerDirectory(msg.path, msg.name)
  }
  if (msg.type === 'models') {
    const sessionId = typeof msg.sessionId === 'string' && msg.sessionId.trim() !== '' ? msg.sessionId.trim() : null
    if (sessionId) {
      // per-session catalog: current selection + routable + full groups
      return proxyQuery(api, 'models', api.sessions.models.bind(api.sessions), { sessionId })
    }
    // global catalog: every provider route, no session needed
    return proxyQuery(api, 'models', api.llm.models.bind(api.llm), {})
  }
  if (msg.type === 'providers') {
    return proxyQuery(api, 'providers', api.llm.providers.bind(api.llm), {})
  }
  if (msg.type === 'command-execute') {
    return admitCommand(host, msg)
  }
  if (msg.type === 'commands') {
    const sessionId = requireSessionId(msg)
    if (sessionId.error) return sessionId.error
    const copy = resolveCommandCatalogCopy(msg.locale)
    try {
      // This is the same session-scoped catalog used by the official Web UI.
      // Copy only the stable descriptor fields so no live Typert object crosses
      // the mobile wire. The Web UI also contributes /model client-side; expose
      // the equivalent action here so mobile clients can render the same menu.
      const [listed, skillFrame] = await Promise.all([
        listHostCommands(host, sessionId.value),
        api.skills && typeof api.skills.list === 'function'
          ? proxyQuery(api, 'skills', api.skills.list.bind(api.skills), { sessionId: sessionId.value })
          : Promise.resolve({ kind: 'error', code: 'unsupported', message: 'skill catalog is unavailable', requestType: 'skills' }),
      ])
      if (!Array.isArray(listed)) throw new Error('commands/list returned an invalid catalog')
      const commands = listed
        .filter((command) => command && typeof command.name === 'string' && typeof command.description === 'string')
        .map((command) => ({
          id: `command:${command.name}`,
          name: command.name,
          description: command.description,
          source: 'host',
          action: 'execute',
          ui: commandUiDescriptor(command, copy),
          ...(command.input && typeof command.input.hint === 'string'
            ? { input: { hint: command.input.hint, ...(commandAcceptsAttachments(command) ? { images: true } : {}) } }
            : {}),
        }))
      if (!commands.some((command) => command.name === 'model')) {
        commands.push({
          id: 'command:model',
          name: 'model',
          description: copy.modelDescription,
          source: 'client',
          action: 'select-model',
          ui: commandUiDescriptor({ name: 'model' }, copy),
        })
      }
      const skills = skillFrame.kind === 'skills' && Array.isArray(skillFrame.skills)
        ? skillFrame.skills
          .filter((skill) => skill && typeof skill.name === 'string' && typeof skill.description === 'string')
          .map((skill) => ({
            id: `skill:${skill.name}`,
            name: skill.name,
            description: skill.modelInvocable === true ? skill.description : `${copy.userOnly} · ${skill.description}`,
            source: 'skill',
            action: 'insert',
            modelInvocable: skill.modelInvocable === true,
            ...(typeof skill.whenToUse === 'string' && skill.whenToUse !== '' ? { whenToUse: skill.whenToUse } : {}),
            ui: skillUiDescriptor(skill),
          }))
        : []
      const groups = [
        { id: 'commands', title: copy.commandsTitle, items: commands },
        ...(skills.length > 0 ? [{ id: 'skills', title: copy.skillsTitle, items: skills }] : []),
      ]
      const warnings = skillFrame.kind === 'error'
        ? [{ source: 'skills', code: skillFrame.code, message: skillFrame.message }]
        : []
      log(`command catalog queried: session=${sessionId.value} commands=${commands.length} skills=${skills.length}`)
      return {
        kind: 'commands',
        sessionId: sessionId.value,
        locale: copy.locale,
        groups,
        ...(warnings.length > 0 ? { warnings } : {}),
      }
    } catch (error) {
      const code = error && error.code ? error.code : 'internal'
      const message = error && error.message ? error.message : String(error)
      log(`command catalog failed: session=${sessionId.value} ${code}: ${message}`)
      return { kind: 'error', code, message, requestType: 'commands', sessionId: sessionId.value }
    }
  }
  if (msg.type === 'command-options') {
    const sessionId = requireSessionId(msg)
    if (sessionId.error) return sessionId.error
    const command = typeof msg.command === 'string' && msg.command.trim() !== '' ? msg.command.trim() : null
    if (!command) return { kind: 'error', code: 'bad-request', message: 'command-options requires a command', requestType: 'command-options', sessionId: sessionId.value }
    return loadCommandOptions(api, command, sessionId.value)
  }
  if (msg.type === 'command-select') {
    const sessionId = requireSessionId(msg)
    if (sessionId.error) return sessionId.error
    const command = typeof msg.command === 'string' && msg.command.trim() !== '' ? msg.command.trim() : null
    const optionId = typeof msg.optionId === 'string' && msg.optionId !== '' ? msg.optionId : null
    if (!command || !optionId) return { kind: 'error', code: 'bad-request', message: 'command-select requires command and optionId', requestType: 'command-select', sessionId: sessionId.value }
    return selectCommandOption(api, host, command, sessionId.value, optionId)
  }
  if (msg.type === 'select-model') {
    const sessionId = requireSessionId(msg)
    if (sessionId.error) return sessionId.error
    const provider = typeof msg.provider === 'string' && msg.provider.trim() !== '' ? msg.provider.trim() : null
    const model = typeof msg.model === 'string' && msg.model.trim() !== '' ? msg.model.trim() : null
    if (!provider || !model) {
      return { kind: 'error', code: 'bad-request', message: 'select-model requires provider and model', requestType: 'select-model' }
    }
    const payload = { sessionId: sessionId.value, provider, model }
    if (typeof msg.reasoningEffort === 'string' && msg.reasoningEffort.trim() !== '') payload.reasoningEffort = msg.reasoningEffort.trim()
    return proxyQuery(api, 'select-model', api.sessions.selectModel.bind(api.sessions), payload)
  }
  if (msg.type === 'permission-options') {
    const [frame, catalog] = await Promise.all([
      proxyQuery(api, 'permission-options', api.settings.describe.bind(api.settings), {}),
      proxyQuery(api, 'permission-catalog', api.permissionPresets.catalog.bind(api.permissionPresets), {}),
    ])
    if (frame.kind !== 'permission-options') return frame
    if (catalog.kind === 'error') return catalog
    const out = {
      kind: 'permission-options',
      namespace: (frame.namespaces || []).find((n) => n.ns === 'permission') || null,
      options: catalog.options,
      defaultOptions: catalog.defaultOptions,
      defaultPreset: catalog.defaultPreset,
    }
    const sessionId = typeof msg.sessionId === 'string' && msg.sessionId.trim() !== '' ? msg.sessionId.trim() : null
    if (sessionId) {
      out.sessionId = sessionId
      const hist = await querySessionProjection(api, msg.type, sessionId)
      if (hist.kind === 'error') return hist
      if (hist.kind === 'history' && hist.projections && hist.projections.values) {
        const current = hist.projections.values.permissions
        out.sessionPermissions = current ? { ...current, options: catalog.options } : null
      }
    }
    return out
  }
  if (msg.type === 'permission') {
    const sessionId = requireSessionId(msg)
    if (sessionId.error) return sessionId.error
    const name = typeof msg.name === 'string' && msg.name.trim() !== '' ? msg.name.trim() : null
    if (!name) {
      return { kind: 'error', code: 'bad-request', message: 'permission requires a name', requestType: 'permission' }
    }
    // Execute the /permission command through the Typert Remote gateway — the
    // same endpoint the browser calls (remote.commands.execute). This runs the
    // command registry handler WITHOUT sending anything to the model, and the
    // api-remotes agent lookup resumes cold sessions just like prompt does.
    try {
      // commands/execute 的当前 Typert descriptor 要求 images 字段始终存在；
      // 权限斜杠命令没有附件，因此显式传空数组。
      const execution = await host.commands.execute(
        sessionId.value,
        '/permission ' + name,
        [],
        new AbortController().signal,
      )
      if (execution === undefined || execution === null) {
        return { kind: 'error', code: 'unknown-command', message: 'command not found: /permission', requestType: 'permission', sessionId: sessionId.value }
      }
      log(`permission switched: session=${sessionId.value} preset=${name} (commandId=${execution.commandId})`)
      return {
        kind: 'permission',
        sessionId: sessionId.value,
        set: name,
        commandId: execution.commandId,
        result: execution.result,
      }
    } catch (error) {
      const code = error && error.code ? error.code : 'internal'
      const message = error && error.message ? error.message : String(error)
      log(`permission rejected: ${code}: ${message}`)
      return { kind: 'error', code, message, requestType: 'permission', sessionId: sessionId.value }
    }
  }
  if (msg.type === 'context-usage') {
    const sessionId = requireSessionId(msg)
    if (sessionId.error) return sessionId.error
    const hist = await querySessionProjection(api, msg.type, sessionId.value)
    if (hist.kind !== 'history') return hist
    const values = (hist.projections && hist.projections.values) || {}
    return {
      kind: 'context-usage',
      sessionId: sessionId.value,
      asOfSeq: hist.projections ? hist.projections.asOfSeq : undefined,
      tokenUsage: values.tokenUsage || null,
      contextPressure: values.contextPressure || null,
    }
  }
  if (msg.type === 'session-stats') {
    const sessionId = requireSessionId(msg)
    if (sessionId.error) return sessionId.error
    const hist = await querySessionProjection(api, msg.type, sessionId.value)
    if (hist.kind !== 'history') return hist
    const values = (hist.projections && hist.projections.values) || {}
    return {
      kind: 'session-stats',
      sessionId: sessionId.value,
      asOfSeq: hist.projections ? hist.projections.asOfSeq : undefined,
      sessionStats: values.sessionStats || null,
      tokenUsage: values.tokenUsage || null,
      contextPressure: values.contextPressure || null,
    }
  }
  if (msg.type === 'tasks' || msg.type === 'goal') {
    const target = parseSessionTarget(msg)
    if (target.error) return target.error
    const frame = await readSessionProjection(api, msg.type, target.value.sessionId,
      msg.type === 'tasks' ? 'todos' : 'goal', target.value)
    return { ...frame, ...(typeof msg.requestId === 'string' ? { requestId: msg.requestId } : {}) }
  }
  if (msg.type === 'goal-edit') {
    const sessionId = requireSessionId(msg)
    if (sessionId.error) return sessionId.error
    const ref = requireGoalRef(msg, sessionId.value)
    if (ref.error) return ref.error
    const payload = { sessionId: sessionId.value, ref: ref.value }
    if (typeof msg.objective === 'string' && msg.objective.trim() !== '') payload.objective = msg.objective.trim()
    if (typeof msg.maxGoalRounds === 'number' && Number.isSafeInteger(msg.maxGoalRounds) && msg.maxGoalRounds > 0) {
      payload.maxGoalRounds = msg.maxGoalRounds
    }
    if (payload.objective === undefined && payload.maxGoalRounds === undefined) {
      return { kind: 'error', code: 'bad-request', message: 'goal-edit requires a non-empty objective or a positive maxGoalRounds', requestType: 'goal-edit', sessionId: sessionId.value }
    }
    return mutateGoal(api, 'goal-edit', 'edit', payload)
  }
  if (msg.type === 'goal-pause' || msg.type === 'goal-resume' || msg.type === 'goal-clear') {
    const sessionId = requireSessionId(msg)
    if (sessionId.error) return sessionId.error
    const ref = requireGoalRef(msg, sessionId.value)
    if (ref.error) return ref.error
    const method = msg.type === 'goal-pause' ? 'pause' : msg.type === 'goal-resume' ? 'resume' : 'clear'
    return mutateGoal(api, msg.type, method, { sessionId: sessionId.value, ref: ref.value })
  }
  if (SCHEDULE_REQUEST_TYPES.has(msg.type)) {
    const frame = await handleScheduleQuery(api, msg)
    // Reviewer item 5(b): a device sees the STRUCTURED schedule refusal and a fixed
    // sentence, never the Host's `error.message` (the three reads are device-reachable
    // through `schedule:read`; every other schedule type stays admin-only and keeps the
    // Host text). Everything else in the frame — the task record, `code`, identity — is
    // forwarded verbatim.
    if (frame?.kind === 'error' && !deviceless(pluginContext) && SCHEDULE_READ_TYPES.includes(msg.type)) {
      frame.message = deviceRefusalMessage(msg.type, frame.code)
    }
    return frame
  }
  if (msg.type === 'agent-presets') {
    return proxyQuery(api, 'agent-presets', api.agentPresets.list.bind(api.agentPresets), {})
  }
  if (msg.type === 'defaults') {
    const [presets, catalog] = await Promise.all([
      proxyQuery(api, 'agent-presets', api.agentPresets.list.bind(api.agentPresets), {}),
      proxyQuery(api, 'permission-catalog', api.permissionPresets.catalog.bind(api.permissionPresets), {}),
    ])
    if (presets.kind === 'error') return presets
    if (catalog.kind === 'error') return catalog
    return {
      kind: 'defaults',
      agentPresetDefault: presets.presets?.find((preset) => preset.isDefault)?.id ?? null,
      permissionDefault: catalog.defaultPreset ?? null,
      permissionDefaultOptions: catalog.defaultOptions ?? [],
      // rc.2 removed this roster flag; only an explicit older-host false disables selection.
      modeSelectionEnabled: presets.modeSelectionEnabled !== false,
    }
  }
  if (msg.type === 'set-default') {
    const target = typeof msg.target === 'string' && msg.target.trim() !== '' ? msg.target.trim() : null
    const value = typeof msg.value === 'string' && msg.value.trim() !== '' ? msg.value.trim() : null
    if (target !== 'agent-preset' && target !== 'permission') {
      return { kind: 'error', code: 'bad-request', message: 'set-default target must be "agent-preset" or "permission"', requestType: 'set-default' }
    }
    if (!value) {
      return { kind: 'error', code: 'bad-request', message: 'set-default requires a value', requestType: 'set-default' }
    }
    const catalog = target === 'agent-preset'
      ? await proxyQuery(api, 'agent-presets', api.agentPresets.list.bind(api.agentPresets), {})
      : await proxyQuery(api, 'permission-catalog', api.permissionPresets.catalog.bind(api.permissionPresets), {})
    if (catalog.kind === 'error') return catalog
    if (target === 'agent-preset' && catalog.modeSelectionEnabled === false) {
      return { kind: 'error', code: 'mode-selection-disabled', message: 'Agent mode selection is disabled', requestType: 'set-default' }
    }
    const choices = target === 'agent-preset'
      ? catalog.presets?.filter((preset) => !preset.broken).map((preset) => preset.id)
      : catalog.defaultOptions?.map((option) => option.value)
    if (!choices?.includes(value)) {
      return { kind: 'error', code: 'bad-request', message: 'default value is not available', requestType: 'set-default' }
    }
    const ns = target === 'agent-preset' ? 'agent-preset-registry' : 'permission'
    const patch = target === 'agent-preset' ? { selectedDefault: value } : { defaultPreset: value }
    const updated = await proxyQuery(api, 'set-default', api.settings.update.bind(api.settings), { ns, patch })
    if (updated.kind !== 'set-default') return updated
    log(`default updated: ${ns}.${Object.keys(patch)[0]} = ${value}`)
    return { kind: 'set-default', target, value, applied: true, namespace: updated }
  }
  return null
}

// Spec 011: the four authoring ops (`workspaces`, `session-create`, `models`,
// `select-model`) are served to a device that holds `sessions:author` by the SAME
// upstream handlers the loopback admin channel uses (`handleQuery`), through THIS
// connection's non-owner adapter: the positive guard and DSH's `remoteAccess`
// policy therefore see every Host call, and the handlers themselves are unchanged.
// What is added here is only the argument rule the desktop bridge already enforces
// for `session/create` (FR-005). A session the device cannot address needs no rule
// here: `session/selectModel` is mapped as a `session` resource in
// `companion-access.mjs` exactly like `session/prompt`, so DSH applies the
// identical rule to both and no second session policy exists.
async function admitAuthoring(api, host, agentDefaultModel, msg, device, refreshWorkspaces, workspaceGroupFieldsFor, aggregateFrameFor, client) {
  if (msg.type === 'session-create') {
    const refusal = await createdSessionRefusal(api, msg, device)
    if (refusal) return refusal
  }
  // DSH decides item visibility from the policy bindings, which are built from the
  // cached workspace ids, so the cache must be current BEFORE the filtered call.
  if (msg.type === 'workspaces' && typeof refreshWorkspaces === 'function') {
    await refreshWorkspaces().catch(() => {})
  }
  const frame = await handleQuery(api, host, agentDefaultModel, msg, {
    ...(typeof workspaceGroupFieldsFor === 'function' ? { workspaceGroupFieldsFor } : {}),
    // The per-recipient archive reduction closes over `apply`'s visible-session
    // snapshot, so it reaches `handleQuery` that way too (same as the group fields).
    ...(typeof aggregateFrameFor === 'function' ? { aggregateFrameFor } : {}),
    ...(client === undefined ? {} : { client }),
  })
  // Minor 1 (reviewer, spec 011): a phone learns which workspace ids it may target,
  // not where the owner's projects live on disk.
  return msg.type === 'workspaces' ? projectWorkspacesForDevice(frame, device) : frame
}

/**
 * Last path segment of a Host path, for a label. Never returns the path itself:
 * `/home/me/DXVK_Project` → `DXVK_Project`, `C:\Users\me\default-workspace\` →
 * `default-workspace`. Empty when there is no usable segment.
 */
function pathBasename(value) {
  if (typeof value !== 'string' || value === '') return ''
  const segments = value.split(/[\\/]+/).filter((segment) => segment !== '')
  return segments.length === 0 ? '' : segments[segments.length - 1]
}

/**
 * One workspace's display label — THE single source for both the `workspaces` op and
 * the additive `workspaceLabel` on session rows/events (spec 011 addendum).
 *
 * Order: an explicit `name`, then `title`, then the last segment of `path`. Real Hosts
 * store an EMPTY name and only a path (measured 2026-11-10: nine workspaces, all
 * `name: ""`), so the basename is the label. It is a LABEL, not a location: the path
 * never leaves the Host. Empty when nothing could be shown, so callers can omit the
 * field instead of rendering a raw uuid.
 */
function workspaceLabelOf(item) {
  if (!item || typeof item !== 'object') return ''
  const named = typeof item.name === 'string' && item.name !== ''
    ? item.name
    : typeof item.title === 'string' && item.title !== '' ? item.title : ''
  return named !== '' ? named : pathBasename(item.path)
}

/**
 * Spec 011 Minor 1: the `workspaces` answer for a device that does NOT hold
 * `workspace:manage` carries only the identity a phone needs to create a session:
 * `{ workspaceId, name }` per item.
 *
 * The Host's workspace baseline also carries the absolute `path`, the member
 * `sessionIds` and timestamps — Host filesystem structure, which is exactly what a
 * stolen phone must not learn about a machine it can no longer be trusted on. The
 * companion app only reads `workspaceId` (or `id`) plus an optional display `name`,
 * and falls back to the id when the name is absent, so dropping the rest is
 * compatible with it. A device that may already manage workspaces
 * (`workspace:manage`) keeps the full Host shape: it is allowed to name paths
 * anyway, and the desktop bridge already exposes them to that class of device.
 */
function projectWorkspacesForDevice(frame, device) {
  if (!frame || frame.kind !== 'workspaces' || !Array.isArray(frame.items)) return frame
  const scopes = Array.isArray(device?.scopes) ? device.scopes : []
  // `workspace:manage` keeps the full shape, archive set included: that class may
  // already browse the Host's directories, and this is the same carve-out as below.
  if (scopes.includes('workspace:manage')) return frame
  const items = []
  for (const item of frame.items) {
    if (!item || typeof item !== 'object') continue
    const id = typeof item.workspaceId === 'string' && item.workspaceId !== ''
      ? item.workspaceId
      : typeof item.id === 'string' && item.id !== '' ? item.id : ''
    // No id: the app drops the row and cannot create a session from it.
    if (id === '') continue
    // Same label rule as the session rows' `workspaceLabel` (one source of truth).
    const name = workspaceLabelOf(item)
    if (name === '') continue
    items.push({ workspaceId: id, name })
  }
  // `archivedSessionIds` names sessions the device may not be able to address: it
  // is archive bookkeeping the peer that can already list those sessions keeps, not
  // something a phone needs to render a workspace picker.
  const { archivedSessionIds: _archived, ...rest } = frame
  return { ...rest, items }
}

/**
 * Spec 011 FR-005 for `session-create`, the same rule `remote-bridge.mjs`
 * already applies to the 008 bridge: `cwd` and `agentPreset` pick an arbitrary
 * directory or agent composition, so they need `workspace:manage`; a
 * `workspaceId` must name a workspace of THIS Host, and a device that cannot name
 * directories must name one at all (lead decision 2026-11-10: the Host's own
 * default working directory is not a place a phone may choose by omission). The
 * list is read through the same adapter the create call will use and never cached;
 * an unreadable list refuses instead of guessing (fail closed).
 */
async function createdSessionRefusal(api, msg, device) {
  const requestId = typeof msg.requestId === 'string' ? { requestId: msg.requestId } : {}
  const refuse = (code, message) => ({ kind: 'error', code, message, requestType: 'session-create', ...requestId })
  const scopes = Array.isArray(device?.scopes) ? device.scopes : []
  const workspaceManage = scopes.includes('workspace:manage')
  if (!workspaceManage) {
    for (const key of ['cwd', 'agentPreset']) {
      if (msg[key] === undefined) continue
      return refuse('remote/argument-denied',
        `session-create: ${key} needs workspace:manage; pass a workspaceId of an existing workspace`)
    }
  }
  const workspaceId = typeof msg.workspaceId === 'string' ? msg.workspaceId.trim() : ''
  // A device with `workspace:manage` may place a session anywhere on its Host (the
  // admin/desktop rule). Every other device MUST name a workspace of this Host: an
  // omitted, blank, whitespace-only or non-string `workspaceId` would let the create
  // land in the Host's default working directory, which the phone never chose.
  if (workspaceManage) return undefined
  if (workspaceId === '') {
    return refuse('remote/argument-denied',
      'session-create: workspaceId is required; name a workspace of this Host')
  }
  let baseline
  try { baseline = await api.workspace.list({}) } catch { baseline = undefined }
  if (!baseline || !Array.isArray(baseline.items)) {
    return refuse('remote/unavailable', 'session-create: the Host workspace list is unavailable')
  }
  if (!baseline.items.some((item) => item && item.workspaceId === workspaceId)) {
    return refuse('remote/argument-denied', 'session-create: workspaceId is not a workspace of this Host')
  }
  return undefined
}

export {
  DEVICE_SESSION_EDIT_MESSAGES, HISTORY_DEFAULT_MAX_BYTES, HISTORY_OPENING_MAX_BYTES, HISTORY_TOOL_RESULT_MAX_CHARS,
  admitAuthoring, capHistoryEvents, createdSessionRefusal, decodeModelCommandOptionId, deviceRefusalMessage,
  deviceless, eventBytes, handleQuery, historyPage, loadCommandOptions, modelCommandOptionId, mutateGoal,
  pathBasename, projectWorkspacesForDevice, readSessionProjection, requireGoalRef, resolveCommandCatalogCopy,
  selectCommandOption, skillUiDescriptor, commandUiDescriptor, trimConversationEvent, validateHistoryCursor,
  workspaceLabelOf,
}
