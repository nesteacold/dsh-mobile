// Host command / message admission helpers, moved verbatim from index.mjs.
import { log } from './logging.mjs'
import { parseSessionTarget } from './session-target.mjs'
import { serializeMessageText } from './message-text.mjs'

const IMAGE_MEDIA_TYPES = new Set(['image/png', 'image/jpeg', 'image/webp', 'image/gif'])

// Validate one sessionId field; returns { value } or { error }.
function requireSessionId(msg) {
  const sessionId = typeof msg.sessionId === 'string' && msg.sessionId.trim() !== '' ? msg.sessionId.trim() : null
  if (!sessionId) {
    return { error: { kind: 'error', code: 'bad-request', message: 'this request requires a sessionId', requestType: typeof msg.type === 'string' ? msg.type : 'query' } }
  }
  return { value: sessionId }
}

// DSH 0.1.5-rc.2 command descriptors use input.attachments.
function commandAcceptsAttachments(command) {
  return command?.input?.attachments === true
}

// A preset ID is a plain identifier; anything path-like or structured never leaves the Host.
const PRESET_ID = /^[A-Za-z0-9._:-]{1,64}$/

function parseAgentPreset(msg, requestType, required = false) {
  if (msg.agentPreset === undefined && !required) return {}
  if (typeof msg.agentPreset !== 'string' || !msg.agentPreset.trim()) {
    return { error: { kind: 'error', code: 'bad-request', requestType,
      message: 'agentPreset must be a non-empty preset ID' } }
  }
  return { value: msg.agentPreset.trim() }
}

function parseWireImages(rawImages, requestType) {
  const images = rawImages === undefined ? [] : rawImages
  if (!Array.isArray(images)) {
    return { error: { kind: 'error', code: 'bad-request', message: 'images must be an array', requestType } }
  }
  if (images.length > 20) {
    return { error: { kind: 'error', code: 'bad-request', message: 'a request can contain at most 20 images', requestType } }
  }
  const imageParts = []
  for (let index = 0; index < images.length; index++) {
    const image = images[index]
    if (!image || typeof image !== 'object') {
      return { error: { kind: 'error', code: 'bad-request', message: `images[${index}] must be an object`, requestType } }
    }
    if (!IMAGE_MEDIA_TYPES.has(image.mediaType)) {
      return { error: { kind: 'error', code: 'bad-request', message: `images[${index}].mediaType is unsupported`, requestType } }
    }
    if (typeof image.data !== 'string' || image.data.length === 0) {
      return { error: { kind: 'error', code: 'bad-request', message: `images[${index}].data must be a non-empty base64 string`, requestType } }
    }
    if (image.name !== undefined && (typeof image.name !== 'string' || image.name.length > 255)) {
      return { error: { kind: 'error', code: 'bad-request', message: `images[${index}].name must be a string of at most 255 characters`, requestType } }
    }
    imageParts.push({
      type: 'image',
      mediaType: image.mediaType,
      data: image.data,
      ...(image.name ? { name: image.name } : {}),
    })
  }
  return { value: imageParts }
}

function commandNameOf(line) {
  const trimmed = line.trim()
  if (!trimmed.startsWith('/')) return null
  const end = trimmed.search(/\s/)
  return (end === -1 ? trimmed.slice(1) : trimmed.slice(1, end)) || null
}

async function listHostCommands(host, sessionId) {
  const listed = await host.commands.list(sessionId, new AbortController().signal)
  if (!Array.isArray(listed)) throw new Error('commands/list returned an invalid catalog')
  return listed
}

async function executeHostCommand(host, sessionId, line, images, requestType) {
  try {
    const execution = await host.commands.execute(sessionId, line, images, new AbortController().signal)
    if (execution === undefined || execution === null) {
      return { kind: 'error', code: 'unknown-command', message: `unknown or malformed command: ${line}`, requestType, sessionId }
    }
    log(`command executed: session=${sessionId} line=${JSON.stringify(line)} commandId=${execution.commandId} outcome=${execution.result.kind}`)
    return {
      kind: 'command-executed',
      sessionId,
      line,
      commandId: execution.commandId,
      result: execution.result,
    }
  } catch (error) {
    const code = error && error.code ? error.code : 'internal'
    const message = error && error.message ? error.message : String(error)
    log(`command rejected: session=${sessionId} ${code}: ${message}`)
    return { kind: 'error', code, message, requestType, sessionId }
  }
}

async function admitCommand(host, msg) {
  const sessionId = requireSessionId(msg)
  if (sessionId.error) return sessionId.error
  const line = typeof msg.line === 'string' ? msg.line.trim() : ''
  const name = commandNameOf(line)
  if (!name) {
    return { kind: 'error', code: 'bad-request', message: 'command-execute requires a slash-prefixed line', requestType: 'command-execute', sessionId: sessionId.value }
  }
  const parsedImages = parseWireImages(msg.images, 'command-execute')
  if (parsedImages.error) return { ...parsedImages.error, sessionId: sessionId.value }
  try {
    const listed = await listHostCommands(host, sessionId.value)
    const descriptor = listed.find((command) => command && command.name === name)
    if (!descriptor) {
      return { kind: 'error', code: 'unknown-command', message: `command not found: /${name}`, requestType: 'command-execute', sessionId: sessionId.value }
    }
    if (parsedImages.value.length > 0 && !commandAcceptsAttachments(descriptor)) {
      return { kind: 'error', code: 'bad-request', message: `/${name} does not accept image attachments`, requestType: 'command-execute', sessionId: sessionId.value }
    }
    return executeHostCommand(host, sessionId.value, line, parsedImages.value, 'command-execute')
  } catch (error) {
    const code = error && error.code ? error.code : 'internal'
    const message = error && error.message ? error.message : String(error)
    return { kind: 'error', code, message, requestType: 'command-execute', sessionId: sessionId.value }
  }
}

// Handle one mobile -> agent message through the official host API. Returns
// the wire frame to send back, or null when nothing should be sent.
async function admitMessage(api, msg) {
  const target = parseSessionTarget(msg, { optional: true })
  if (target.error) return target.error
  const requestIdentity = typeof msg.requestId === 'string' ? { requestId: msg.requestId } : {}
  const rejectMessage = frame => ({ ...frame, requestType: 'message', ...target.value, ...requestIdentity })
  if (target.value.parentSessionId !== undefined && target.value.subagentMode !== 'continuable') {
    return { kind: 'error', code: 'subagent/not-resumable', requestType: 'message', ...target.value,
      ...requestIdentity, message: 'only continuable subagents accept messages' }
  }
  const preset = parseAgentPreset(msg, 'message')
  if (preset.error) return rejectMessage(preset.error)
  if (preset.value !== undefined && typeof msg.sessionId === 'string' && msg.sessionId.trim()) {
    return rejectMessage({ kind: 'error', code: 'bad-request',
      message: 'use select-agent-preset before sending a message to an existing session' })
  }
  if (msg.requestId !== undefined && (typeof msg.requestId !== 'string' || !msg.requestId.trim() || msg.requestId.length > 128)) {
    return rejectMessage({ kind: 'error', code: 'bad-request', message: 'requestId must contain 1..128 characters' })
  }
  let text
  try { text = serializeMessageText(msg.text, msg.textParts) }
  catch (error) { return rejectMessage({ kind: 'error', code: 'bad-request', message: error.message }) }
  const parsedImages = parseWireImages(msg.images, 'message')
  if (parsedImages.error) return rejectMessage(parsedImages.error)
  const imageParts = parsedImages.value
  const files = msg.files === undefined ? [] : msg.files
  if (!Array.isArray(files) || files.length > 20 || files.some(file => !file || typeof file.receiptId !== 'string'
    || !file.receiptId.trim() || file.receiptId.length > 256)
    || new Set(files.map(file => file.receiptId)).size !== files.length) {
    return rejectMessage({ kind: 'error', code: 'bad-request', message: 'files must contain at most 20 distinct receiptId entries' })
  }
  if (files.length && (target.value.parentSessionId !== undefined || typeof msg.sessionId !== 'string' || !msg.sessionId.trim())) {
    return rejectMessage({ kind: 'error', code: target.value.parentSessionId ? 'subagent/attachment-invalid' : 'bad-request',
      message: 'file receipts require an existing ordinary session' })
  }
  if (files.length && (typeof msg.requestId !== 'string' || !msg.requestId.trim() || msg.requestId.length > 128)) {
    return rejectMessage({ kind: 'error', code: 'bad-request', message: 'file messages require a requestId of 1..128 characters' })
  }
  if (!text && imageParts.length === 0 && files.length === 0) {
    return rejectMessage({ kind: 'error', code: 'bad-request', message: 'message requires text, images or uploaded file receipts' })
  }
  const mode = msg.mode === 'steer' ? 'steer' : 'queue'

  let sessionId = typeof msg.sessionId === 'string' && msg.sessionId.trim() !== '' ? msg.sessionId.trim() : undefined
  try {
    if (sessionId === undefined) {
      // New session: optionally place it in a workspace (at most one of
      // workspaceId / cwd, per the host create contract; workspaceId wins).
      const createPayload = {}
      if (preset.value !== undefined) createPayload.agentPreset = preset.value
      if (typeof msg.workspaceId === 'string' && msg.workspaceId.trim() !== '') {
        createPayload.workspaceId = msg.workspaceId.trim()
      }
      if (typeof msg.cwd === 'string' && msg.cwd.trim() !== '') {
        if (createPayload.workspaceId) log('mobile message: both workspaceId and cwd given, using workspaceId')
        else createPayload.cwd = msg.cwd.trim()
      }
      const created = await api.sessions.create(createPayload)
      sessionId = created.sessionId
      log(`mobile message created new session ${sessionId} (${JSON.stringify(createPayload)})`)
    }

    const resp = await api.sessions.prompt({
      ...target.value,
      sessionId,
      mode,
      ...requestIdentity,
      // Match the official WebUI ordering: images first, optional text last.
      content: [...imageParts, ...files.map(file => ({ type: 'file', receiptId: file.receiptId })),
        ...(text ? [{ type: 'text', text }] : [])],
      ...(typeof msg.clientTimeZone === 'string' && msg.clientTimeZone.trim() ? { clientTimeZone: msg.clientTimeZone.trim() } : {}),
    })
    log(`mobile message accepted: session=${sessionId} mode=${mode} images=${imageParts.length} text="${text.slice(0, 60)}"`)
    return {
      kind: 'sent',
      sessionId,
      mode,
      ...requestIdentity,
      ...(target.value.parentSessionId === undefined ? {} : {
        parentSessionId: target.value.parentSessionId, subagentMode: target.value.subagentMode,
        messageId: resp.messageId,
      }),
      ...(resp.command ? { command: resp.command } : {}),
    }
  } catch (error) {
    const code = error && error.code ? error.code : 'internal'
    const message = error && error.message ? error.message : String(error)
    log(`mobile message failed: ${message}`)
    return { kind: 'error', code, message, requestType: 'message', ...target.value,
      ...requestIdentity, ...(sessionId ? { sessionId } : {}) }
  }
}

// Proxy one read-only query to the official host API (the same surface the
// browser uses). Success returns `{ kind: <type>, ...value }`; failure returns
// the uniform `{ kind: 'error', code, message, requestType }` frame.
async function proxyQuery(api, type, method, payload, signal) {
  try {
    const value = signal ? await method(payload, signal) : await method(payload)
    if (value === null || typeof value !== 'object' || Array.isArray(value)) {
      throw new Error(`${type} returned an invalid response`)
    }
    log(`query ok: ${type}`)
    return { kind: type, ...value }
  } catch (error) {
    const code = error && error.code ? error.code : 'internal'
    const message = error && error.message ? error.message : String(error)
    log(`query failed: ${type} -> ${code}: ${message}`)
    return { kind: 'error', code, message, requestType: type }
  }
}

// Projection queries must keep the caller's request identity on failure.
// They need the opening cut and projections, not the full conversation body.
async function querySessionProjection(api, requestType, sessionId) {
  const history = await proxyQuery(api, 'history', api.sessions.history.bind(api.sessions), { sessionId, maxMessages: 1 })
  return history.kind === 'error' ? { ...history, requestType, sessionId } : history
}

export {
  IMAGE_MEDIA_TYPES, PRESET_ID, admitCommand, admitMessage, commandAcceptsAttachments, commandNameOf,
  executeHostCommand, listHostCommands, parseAgentPreset, parseWireImages, proxyQuery, querySessionProjection,
  requireSessionId,
}
