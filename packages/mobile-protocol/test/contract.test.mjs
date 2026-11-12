// T007 / FR-005 — the protocol package must match the shipped contract document.
//
// Parses `specs/001-gateway-hardening/contracts/mobile-protocol-v1.md` (looked up from this
// package, going up until the repo root) and asserts that every exported constant is exactly
// what the document says: the §4 `type` column / response `kind` column, the §6 error table
// (`—` ⇒ null), the §2 QR payload, the §3 `hello` and `client-hello` frames, the §5 approval
// outcomes and receipt reasons, and the §3 close codes. Any drift fails here instead of at a
// device.
import assert from 'node:assert/strict'
import fs from 'node:fs'
import path from 'node:path'
import { test } from 'node:test'
import { fileURLToPath } from 'node:url'

import * as protocol from '../src/index.mjs'
import {
  APPROVAL_OUTCOMES_CLIENT,
  APPROVAL_OUTCOMES_FINAL,
  CAPABILITIES,
  CLOSE_CODES,
  COMPANION_PROTOCOL_VERSION,
  ERROR_CODES,
  MIN_CLIENT_VERSION,
  OP_RESPONSES,
  OPTIONAL_CAPABILITIES,
  OPS,
  PAIRING_QR_VERSION,
  PING_INTERVAL_MS,
  PROTOCOL_SUBPROTOCOL,
  RECEIPT_REASONS,
  SUBPROTOCOL_PREFIXES,
} from '../src/index.mjs'

const CONTRACT_PATH = 'specs/001-gateway-hardening/contracts/mobile-protocol-v1.md'

function findContract() {
  let directory = path.dirname(fileURLToPath(import.meta.url))
  while (true) {
    const candidate = path.join(directory, CONTRACT_PATH)
    if (fs.existsSync(candidate)) return candidate
    const parent = path.dirname(directory)
    if (parent === directory) throw new Error(`cannot find ${CONTRACT_PATH} above ${import.meta.url}`)
    directory = parent
  }
}

const contract = fs.readFileSync(findContract(), 'utf8')
const lines = contract.replace(/\r/g, '').split('\n')

function section(prefix) {
  const start = lines.findIndex((line) => line.startsWith(prefix))
  assert.notEqual(start, -1, `contract section starting with "${prefix}" not found`)
  const body = []
  for (let index = start + 1; index < lines.length && !lines[index].startsWith('## '); index += 1) body.push(lines[index])
  return body
}

/**
 * Markdown table rows of a section, as arrays of trimmed cells. `\|` is an escaped pipe inside
 * a cell (the contract writes `queue`/`steer` and `apns`/`fcm` unions that way), so only
 * unescaped pipes split cells.
 */
function tableRows(prefix) {
  const rows = []
  for (const line of section(prefix)) {
    const row = line.trim()
    if (!row.startsWith('|')) continue
    const cells = splitRow(row)
    if (cells.length === 0) continue
    if (cells.every((cell) => /^:?-{3,}:?$/.test(cell))) continue // separator row
    rows.push(cells)
  }
  return rows
}

function splitRow(row) {
  const cells = []
  let current = ''
  for (let index = 0; index < row.length; index += 1) {
    const char = row[index]
    if (char === '\\' && row[index + 1] === '|') {
      current += '|'
      index += 1
      continue
    }
    if (char === '|') {
      cells.push(current.trim())
      current = ''
      continue
    }
    current += char
  }
  cells.push(current.trim())
  // The row is fenced by pipes: drop the empty leading/trailing cells they produce.
  return cells.slice(1, -1)
}

/** First inline code span of a cell (`\`x\` …` ⇒ `x`), or the bare cell text. */
function firstCode(cell) {
  const match = cell.match(/`([^`]+)`/)
  return match ? match[1] : cell.trim()
}

/**
 * Kind in a response cell. Every §4 kind is a response kind of this package, so it is located
 * by membership — never by guessing which code span in the cell is the kind. The `message`
 * cell also spells the `queue|steer` mode and `push-register` the platform enum, and a few
 * cells append the payload shape (`{items[]}`), which this avoids entirely.
 */
function responseKind(cell) {
  // Tokens anywhere in the cell: backticked spans first, then plain words. Selecting by
  // membership keeps parameters (`queue|steer`, `apns|fcm`) and payload shapes (`{items[]}`)
  // out of the result without an index guess.
  const tokens = [
    ...[...cell.matchAll(/`([^`]+)`/g)].map((m) => m[1]),
    ...(cell.match(/[A-Za-z][A-Za-z-]*/g) ?? []),
  ]
  const kind = tokens.find((token) => isResponseKind(token))
  return kind ?? cell.trim()
}

/** Response kinds per contract §4 (an immutable fixture, not `OP_RESPONSES` — see below). */
const CONTRACT_RESPONSE_KINDS = new Set([
  'client-hello', 'pong', 'sessions', 'search', 'history', 'subscribed', 'unsubscribed',
  'sent', 'session-cancelled', 'approval-response', 'device-info', 'device-forgotten',
  'push-registered', 'push-removed',
  // Revision 7 (spec 011): the four session-authoring rows, listed like every other one.
  'workspaces', 'session-created', 'models', 'select-model',
  // Revision 11: session rename / archive, same shape as the revision 7 rows.
  'session-renamed', 'session-archived',
])

function isResponseKind(token) {
  return CONTRACT_RESPONSE_KINDS.has(token)
}

// ---------------------------------------------------------------------------
// §4 operations
// ---------------------------------------------------------------------------

const opRows = tableRows('## 4. Operations').slice(1) // drop the header row
const contractOps = opRows.map((cells) => firstCode(cells[0]))
const contractOpResponses = Object.fromEntries(
  opRows.map((cells) => [firstCode(cells[0]), responseKind(cells[2])]),
)

/**
 * Spec 011 (revision 7): the §4 rows whose Notes name the authoring scope are the authoring
 * ops. Read from the document, not restated here — a lost row or a dropped scope mention
 * leaves this list short and fails the scope assertions below.
 */
const contractAuthoringOps = opRows
  .filter((cells) => (cells[3] ?? '').includes('`sessions:author`'))
  .map((cells) => firstCode(cells[0]))

test('OPS is the §4 `type` column in table order', () => {
  assert.ok(contractOps.length > 0, 'no operations parsed from the contract')
  // The document is the whole allowlist, revision 7 rows included: an extra, missing or
  // reordered row fails here, so an op absent from §4 (or listed twice) still bites.
  assert.deepEqual([...OPS], [...contractOps])
  // The spec 011 export stays pinned to the document's authoring rows, by name.
  assert.deepEqual([...protocol.AUTHORING_CLIENT_TYPES], contractAuthoringOps)
  assert.equal(Object.isFrozen(OPS), true)
})

test('OPS holds only unique operation names', () => {
  assert.equal(new Set(OPS).size, OPS.length)
})

test('OP_RESPONSES is the §4 response `kind` column', () => {
  assert.ok(opRows.length > 0, 'no operations parsed from the contract')
  assert.deepEqual({ ...OP_RESPONSES }, contractOpResponses)
  // One response kind per op, no orphan entry.
  assert.deepEqual(Object.keys(OP_RESPONSES).sort(), [...OPS].sort())
  assert.equal(Object.isFrozen(OP_RESPONSES), true)
})

// ---------------------------------------------------------------------------
// §6 error codes
// ---------------------------------------------------------------------------

function contractErrorCodes() {
  const rows = tableRows('## 6. Error codes')
  const found = new Map()
  for (const cells of rows.slice(1)) {
    const code = firstCode(cells[0])
    const http = cells[1]
    // Error codes are either `ns/name` or a single lowercase word (`bad-request`).
    assert.match(code, /^[a-z][a-z-]*(\/[a-z][a-z-]*)?$/, `unexpected error code cell "${code}"`)
    if (http === '—' || http === '-') found.set(code, null)
    else if (/^\d{3}$/.test(http)) found.set(code, Number(http))
    else assert.fail(`unexpected HTTP cell "${http}" for ${code}`)
  }
  return found
}

test('ERROR_CODES equals the §6 table exactly (— ⇒ null)', () => {
  const expected = contractErrorCodes()
  assert.ok(expected.size > 0, 'no error codes parsed from the contract')
  assert.deepEqual({ ...ERROR_CODES }, Object.fromEntries(expected))
  assert.equal(Object.isFrozen(ERROR_CODES), true)
  // The three upgrade-time statuses the contract makes normative.
  assert.equal(ERROR_CODES['auth/required'], 401)
  assert.equal(ERROR_CODES['remote/disabled'], 403)
  assert.equal(ERROR_CODES['pairing/expired'], 401)
  assert.equal(ERROR_CODES['op/forbidden'], null)
  // Spec 021 (revision 14): in band only, and its §6 row names the lock states the gateway sends
  // as `reason` (§14.2). The WS close `4412` is now reserved for a replaced passkey (§3).
  assert.equal(ERROR_CODES['auth/locked'], null)
  assert.match(contract, /\| `auth\/locked` \| — \|/)
  const lockedRow = tableRows('## 6. Error codes').find((cells) => firstCode(cells[0]) === 'auth/locked')
  assert.ok(lockedRow, 'auth/locked row not found in §6')
  for (const reason of ['locked', 'unregistered', 'rate-limited']) {
    assert.ok(lockedRow[2].includes(`\`${reason}\``), `the auth/locked row must name the ${reason} reason`)
  }
  assert.equal(lockedRow[2].includes('host-signed-out'), false, 'the spec 020 account reasons are withdrawn')
})

// ---------------------------------------------------------------------------
// §3 connection: close codes, hello, capabilities, subprotocols
// ---------------------------------------------------------------------------

test('CLOSE_CODES match §3 (4004 disabled, 4003 re-auth, 4401 revoked, 4412 locked)', () => {
  const closeSection = section('## 3. Connection').join('\n')
  assert.match(closeSection, /`4004` gateway disabled \(stop auto-reconnect\)/)
  assert.match(closeSection, /`4003` re-authenticate/)
  assert.match(closeSection, /`4401` revoked/)
  // Spec 021 (revision 14): a replaced/approved passkey re-asserts; the credential is KEPT (not 4401).
  assert.match(closeSection, /`4412` locked/)
  assert.deepEqual({ ...CLOSE_CODES }, { gatewayDisabled: 4004, reauth: 4003, revoked: 4401, locked: 4412 })
  assert.equal(Object.isFrozen(CLOSE_CODES), true)
})

/** The `hello` JSON example of §3.5 (it spans several lines, fenced by ```json). */
function contractHello() {
  const start = lines.findIndex((line) => line.includes('{ "kind": "hello"'))
  assert.notEqual(start, -1, 'hello example not found')
  let blockStart = -1
  for (let index = start - 1; index >= 0; index -= 1) {
    if (lines[index].trim() === '```json') {
      blockStart = index
      break
    }
  }
  assert.notEqual(blockStart, -1, 'hello example must sit in a ```json block')
  const blockEnd = lines.findIndex((line, index) => index > start && line.trim() === '```')
  assert.notEqual(blockEnd, -1, 'unterminated hello example block')
  return JSON.parse(lines.slice(blockStart + 1, blockEnd).join('\n'))
}

test('hello example carries the package companion protocol constants and capabilities', () => {
  const hello = contractHello()
  assert.equal(hello.kind, 'hello')
  assert.equal(hello.companionProtocol, COMPANION_PROTOCOL_VERSION)
  assert.equal(hello.minClientVersion, MIN_CLIENT_VERSION)
  assert.deepEqual(hello.capabilities, [...CAPABILITIES])
  for (const capability of hello.capabilities) {
    assert.ok(CAPABILITIES.includes(capability) || OPTIONAL_CAPABILITIES.includes(capability), capability)
  }
  assert.equal(COMPANION_PROTOCOL_VERSION, 1)
  assert.equal(MIN_CLIENT_VERSION, 1)
})

test('CAPABILITIES / OPTIONAL_CAPABILITIES match the prose of §3.5', () => {
  assert.match(contract, /`capabilities` on the companion channel are exactly the package `CAPABILITIES` the gateway supports;/)
  // Revision 11 reflowed this sentence onto two lines, so it is checked as two facts
  // rather than as one line: the rename/archive condition and the push condition.
  // (Revision 13 reflowed the middle of the same §3.5 list, so these are no longer
  // contiguous with the `capabilities` sentence above either.)
  assert.ok(contract.includes('`push-v1` is added only when remote push is configured;'))
  assert.ok(contract.includes('`session-rename` and `session-archive` are'))
  assert.ok(contract.includes('added only when the device holds `sessions:author` (revision 11);'))
  assert.deepEqual([...CAPABILITIES], ['sessions-read', 'prompt', 'cancel', 'approval-v1'])
  // Spec 016 Phase 3 (revision 10) adds the host→client browser capability: optional,
  // because a host without the bridge (or a client without a browser) must keep working.
  // Revision 11 adds the two session-edit capabilities, only for `sessions:author`; revision
  // 13 adds `permission-lower`, only for `permission:lower`.
  assert.deepEqual([...OPTIONAL_CAPABILITIES],
    ['push-v1', 'browser-agent:1', 'session-rename', 'session-archive', ...SPEC_019_CAPABILITIES])
  // Revision 13 reflowed the tail of this list (it now feeds `permission-lower`), so the
  // rename/archive condition dropped its closing period; the two facts asserted above
  // still pin its names and the scope it names, so a scope change cannot pass silently.
  // Revision 13 reflowed its condition onto a second line; both halves must be there, and it
  // must name the same capability the scope map lifts.
  assert.ok(contract.includes('`permission-lower` is added only'), 'revision 13 must say what `permission-lower` is gated on')
  assert.ok(contract.includes('when the device holds `permission:lower` (revision 13).'),
    'revision 13 must name `permission:lower` as the condition')
  for (const [capability, scope] of Object.entries(protocol.SESSION_EDIT_CAPABILITY_SCOPE)) {
    assert.ok(OPTIONAL_CAPABILITIES.includes(capability), capability + ' must be optional')
    assert.ok(scope === protocol.AUTHORING_SCOPE || scope === protocol.PERMISSION_LOWER_SCOPE,
      capability + ' must need an advertised scope')
    assert.ok(protocol.SCOPES.includes(scope), capability + ' needs a contract scope')
  }
  // Spec 019: exactly the one capability the scope map lifts, and it is the same name the
  // document and the exported constant use.
  for (const capability of SPEC_019_CAPABILITIES) {
    assert.equal(protocol.SESSION_EDIT_CAPABILITY_SCOPE[capability], protocol.PERMISSION_LOWER_SCOPE,
      `${capability} must ride the permission scope`)
    assert.equal(protocol.PERMISSION_LOWER_CAPABILITY, capability, 'the exported capability must be the mapped name')
  }
  // Lowering permission control is never a required capability: a host without it stays v1.
  for (const capability of SPEC_019_CAPABILITIES) assert.equal(CAPABILITIES.includes(capability), false, capability)
  assert.equal(Object.isFrozen(CAPABILITIES), true)
  assert.equal(Object.isFrozen(OPTIONAL_CAPABILITIES), true)
  assert.equal(Object.isFrozen(protocol.SESSION_EDIT_CAPABILITY_SCOPE), true)
  assert.equal(Object.isFrozen(protocol.PERMISSION_LOWER_TYPES), true)
})

test('PROTOCOL_SUBPROTOCOL and the subprotocol fallbacks match §1/§3', () => {
  assert.match(contract, /Subprotocol always includes `dsh-mobile-v1`\./)
  assert.equal(PROTOCOL_SUBPROTOCOL, 'dsh-mobile-v1')
  assert.equal(SUBPROTOCOL_PREFIXES.pair, 'dsh-pair.')
  assert.equal(SUBPROTOCOL_PREFIXES.auth, 'dsh-auth.')
  assert.equal(SUBPROTOCOL_PREFIXES.device, 'dsh-device.')
  for (const prefix of Object.values(SUBPROTOCOL_PREFIXES)) {
    assert.ok(contract.includes(`${prefix}<`), `${prefix}<…> must appear in the contract`)
  }
  // The header that travels with the pair subprotocol, and its subprotocol fallback.
  assert.match(contract, /`X-DSH-Device-ID:/)
  assert.equal(protocol.DEVICE_ID_HEADER, 'X-DSH-Device-ID')
  assert.deepEqual(protocol.pairingSubprotocols('abc'), ['dsh-mobile-v1', 'dsh-pair.abc'])
  assert.deepEqual(protocol.authSubprotocols('tok'), ['dsh-mobile-v1', 'dsh-auth.tok'])
  assert.deepEqual(protocol.authSubprotocols(), ['dsh-mobile-v1'])
  assert.equal(protocol.deviceSubprotocol('uuid-1'), 'dsh-device.uuid-1')
})

test('client-hello example (§3.6) uses the package shape', () => {
  const match = contract.match(/\{ "type": "client-hello", "requestId": "[^"]*", "companionProtocol": (\d+), "appVersion": "[^"]*", "platform": "ios\|android" \}/)
  assert.ok(match, 'client-hello example not found in §3.6')
  assert.equal(Number(match[1]), COMPANION_PROTOCOL_VERSION)
  const example = protocol.pairingSubprotocols // keep the import tree-shake proof honest
  assert.equal(typeof example, 'function')
})

// ---------------------------------------------------------------------------
// §2 pairing QR
// ---------------------------------------------------------------------------

test('PAIRING_QR_VERSION matches the §2 example', () => {
  const match = contract.match(/\{ "version": (\d+), "publicUrl":/)
  assert.ok(match, 'QR payload example not found in §2')
  assert.equal(Number(match[1]), PAIRING_QR_VERSION)
  assert.equal(PAIRING_QR_VERSION, 3)
  assert.match(contract, /Client MUST reject `version !== 3`/)
  assert.match(contract, /`expiresAt` is epoch milliseconds/)
  assert.match(contract, /unpadded base64url/)
})

// ---------------------------------------------------------------------------
// §5 approvals
// ---------------------------------------------------------------------------

test('APPROVAL_OUTCOMES_CLIENT matches the §5 response line', () => {
  const match = contract.match(/"outcome": "([a-z-]+)" \| "([a-z-]+)"/)
  assert.ok(match, 'client outcome union not found in §5')
  assert.deepEqual([...APPROVAL_OUTCOMES_CLIENT], [match[1], match[2]])
  assert.equal(Object.isFrozen(APPROVAL_OUTCOMES_CLIENT), true)
  assert.match(contract, /`cancelled`\/`unavailable` are host states and are never sent by the client\./)
})

test('APPROVAL_OUTCOMES_FINAL matches the §5 approval-resolved line', () => {
  const match = contract.match(/"outcome": "([a-z-]+)"\s*\n?\s*\| "([a-z-]+)" \| "([a-z-]+)" \| "([a-z-]+)" \}/)
  assert.ok(match, 'final outcome union not found in §5')
  const finals = match.slice(1, 5)
  assert.deepEqual([...APPROVAL_OUTCOMES_FINAL], finals)
  // The first two are exactly the client-sendable outcomes.
  assert.deepEqual(finals.slice(0, 2), [...APPROVAL_OUTCOMES_CLIENT])
  assert.equal(Object.isFrozen(APPROVAL_OUTCOMES_FINAL), true)
})

test('RECEIPT_REASONS match the §5 receipt paragraph', () => {
  // "…or `accepted: false` with `reason` ∈ `not-pending` (already decided / handed to desktop),
  //  `hash-mismatch` (content changed — …)"
  const match = contract.match(/`accepted: false` with `reason` ∈ `([a-z-]+)`[\s\S]{0,200}?\n?`([a-z-]+)`/)
  assert.ok(match, 'receipt reasons not found in §5')
  assert.deepEqual([...RECEIPT_REASONS], [match[1], match[2]])
  assert.deepEqual([...RECEIPT_REASONS], ['not-pending', 'hash-mismatch'])
  assert.equal(Object.isFrozen(RECEIPT_REASONS), true)
})

test('approval-requested push carries argsHash: null for desktop-only requests', () => {
  assert.match(contract, /"argsHash": "<64 hex> \| null"/)
  assert.match(contract, /the client MUST NOT offer approve\/reject/)
  assert.match(contract, /Client deduplicates by `rpcId`\./)
})

test('PING_INTERVAL_MS matches the §4 ping row', () => {
  const pingRow = opRows.find((cells) => firstCode(cells[0]) === 'ping')
  assert.ok(pingRow, 'ping row not found')
  assert.match(pingRow[3] ?? '', /every 25 s/)
  assert.equal(PING_INTERVAL_MS, 25_000)
})

test('every export is frozen where it is a constant table', () => {
  for (const name of [
    'OPS', 'CAPABILITIES', 'OPTIONAL_CAPABILITIES', 'ERROR_CODES', 'CLOSE_CODES', 'RECEIPT_REASONS',
    'APPROVAL_OUTCOMES_CLIENT', 'APPROVAL_OUTCOMES_FINAL', 'SUBPROTOCOL_PREFIXES', 'OP_RESPONSES',
    'SERVER_PUSH_KINDS', 'PASSTHROUGH_ERROR_CODES', 'DEVICE_KINDS', 'SCOPES', 'DESKTOP_DEFAULT_SCOPES',
    'SCOPE_BY_TYPE', 'REMOTE_CLIENT_TYPES', 'REMOTE_SERVER_KINDS', 'DESKTOP_ONLY_SCOPES', 'SCOPE_PRESETS',
    'AUTHORING_CLIENT_TYPES', 'NEVER_DEFAULT_SCOPES', 'REMOTE_UPLOAD_CLIENT_TYPES',
    // Revision 11.
    'SESSION_EDIT_CAPABILITY_SCOPE',
    // Spec 016 Phase 3 (revision 10).
    'BROWSER_OPS', 'BROWSER_HOST_KINDS', 'BROWSER_CLIENT_TYPES', 'BROWSER_ERROR_CODES',
    // Spec 019 Wave 3 (revision 13).
    'PERMISSION_LOWER_CLIENT_TYPES', 'PERMISSION_LOWER_TYPES', 'PERMISSION_LOWER_REASONS',
    'PERMISSION_LOWER_MESSAGES', 'SANDBOX_MODE_ORDER', 'APPROVAL_POLICY_ORDER',
  ]) {
    assert.equal(Object.isFrozen(protocol[name]), true, `${name} must be frozen`)
  }
})

// ---------------------------------------------------------------------------
// Spec 005 — device kinds, scopes, auth/forbidden-scope (revision 3)
// ---------------------------------------------------------------------------

const SPEC_008_SCOPES = [
  'harness:remote', 'commands:execute', 'workspace:manage', 'credentials:write', 'plugins:manage', 'schedule:write', 'terminal',
]
/** Spec 011 (revision 7): explicit-only, but allowed on a `mobile` device. */
const SPEC_011_SCOPES = ['sessions:author']
/** Spec 013 (revision 8): a desktop default, never a kind-independent default. */
const SPEC_013_SCOPES = ['attachments:write']
/** Spec 014 C6: grantable, a desktop default, never a kind-independent default. */
const SPEC_014_SCOPES = ['browser:control']
/**
 * Spec 018 Wave 2. `stats:read` is item 1 (read-only session metrics) and belongs to the
 * 005-era read family; `schedule:read` is item 3 (read-only scheduled tasks) and sits next
 * to the `schedule:write` it never implies (see SPEC_008_SCHEDULE_SCOPES). Both are
 * explicit-only and never a default; the read-only views sit on `agent-team`/`subagents`,
 * which ride `sessions:read`, so those two are deliberately NOT in this list.
 */
const SPEC_018_STATS_SCOPES = ['stats:read']
const SPEC_018_SCHEDULE_SCOPES = ['schedule:read']
const SPEC_018_SCOPES = [...SPEC_018_STATS_SCOPES, ...SPEC_018_SCHEDULE_SCOPES]
/**
 * Spec 020 owns the web unlock scope; spec 021 (revision 14) keeps the scope name and replaces
 * what it gates with the WebAuthn passkey frames. Spec 021's own spec is asserted below.
 */
const SPEC_020_SCOPES = ['web:unlock']
const SPEC_021_SCOPES = ['web:unlock']
/**
 * Spec 019 Wave 3 (contract revision 13): view + lower-only permission control. The scope is
 * new, never-default and mobile-grantable, it gates two frames that are NOT §4 ops
 * (`permission-options`, `permission-lower`, asserted against the protocol's own exported
 * list like every other listed family), and it lifts exactly one capability in `hello`.
 */
const SPEC_019_SCOPES = ['permission:lower']
const SPEC_019_CAPABILITIES = ['permission-lower']

test('SCOPES are the six spec 005 FR2 scopes, then the scopes of specs 008, 011, 013, 014, 018, 019 and 020', () => {
  // Table order: the 005 read family (with spec 018's metric scope and spec 020's unlock),
  // then the spec 008 block (spec 018's `schedule:read` pinned right after `schedule:write`,
  // inside the block), then the spec 011, 013, 014, 018's `stats:read` (already in the read
  // family) and spec 019 scopes.
  const spec008Block = [...SPEC_008_SCOPES]
  // `schedule:read` sits between `schedule:write` and `terminal`: the read scope next to the
  // write family it never implies.
  spec008Block.splice(spec008Block.indexOf('schedule:write') + 1, 0, ...SPEC_018_SCHEDULE_SCOPES)
  assert.deepEqual([...protocol.SCOPES],
    ['sessions:read', 'prompt:send', 'approval:respond', 'files:read', 'files:write', 'settings:write',
      ...SPEC_018_STATS_SCOPES, ...SPEC_020_SCOPES, ...spec008Block, ...SPEC_011_SCOPES,
      ...SPEC_013_SCOPES, ...SPEC_014_SCOPES, ...SPEC_019_SCOPES])
  assert.deepEqual(
    protocol.SCOPES.slice(protocol.SCOPES.indexOf('schedule:write'), protocol.SCOPES.indexOf('schedule:write') + 2),
    ['schedule:write', ...SPEC_018_SCHEDULE_SCOPES],
  )
  // Spec 008, spec 011, spec 018, spec 019 and spec 020: these must be chosen at pair time,
  // never defaulted.
  for (const scope of [...SPEC_008_SCOPES, ...SPEC_011_SCOPES, ...SPEC_018_SCOPES, ...SPEC_019_SCOPES,
    ...SPEC_020_SCOPES]) {
    assert.equal(protocol.DESKTOP_DEFAULT_SCOPES.includes(scope), false, `${scope} must not be a default`)
  }
  // Spec 011 crosses the desktop-only line on purpose: a `mobile` device may hold it.
  for (const scope of SPEC_011_SCOPES) {
    assert.equal(protocol.DESKTOP_ONLY_SCOPES.includes(scope), false, `${scope} must be grantable to a mobile device`)
  }
  // Spec 018 and spec 020 scopes are mobile-holdable too: a phone may read its metrics and
  // the web PWA is itself a `mobile` device (`web:unlock`). None of them rides the full-control
  // families, so none may become desktop-only.
  for (const scope of [...SPEC_018_SCOPES, ...SPEC_020_SCOPES]) {
    assert.equal(protocol.DESKTOP_ONLY_SCOPES.includes(scope), false, `${scope} must be grantable to a mobile device`)
  }
  // Spec 019 is mobile-grantable as well: the phone is the device that asks for a stricter
  // preset, and "lower only" is the whole point of the scope.
  for (const scope of SPEC_019_SCOPES) {
    assert.equal(protocol.DESKTOP_ONLY_SCOPES.includes(scope), false, `${scope} must be grantable to a mobile device`)
  }
  assert.deepEqual([...protocol.DESKTOP_ONLY_SCOPES], SPEC_008_SCOPES)
  // `schedule:read` is a new scope, NOT part of the spec 008 `schedule:write` family: reading
  // the schedule list never implies write authority and vice versa.
  assert.equal(protocol.DESKTOP_ONLY_SCOPES.includes('schedule:read'), false)
  assert.equal(protocol.SCOPES.includes('schedule:write'), true)
  assert.deepEqual([...protocol.DEVICE_KINDS], ['mobile', 'desktop'])
  // Spec 013 R1: the attachment scope is part of the DESKTOP default set (the owner
  // unticks it), and no kind-independent default may contain it (NEVER_DEFAULT).
  assert.deepEqual([...protocol.DESKTOP_DEFAULT_SCOPES],
    ['sessions:read', 'prompt:send', 'approval:respond', ...SPEC_013_SCOPES, ...SPEC_014_SCOPES])
  for (const scope of SPEC_013_SCOPES) {
    assert.equal(protocol.DESKTOP_ONLY_SCOPES.includes(scope), false, `${scope} must not be explicit-only`)
    assert.equal(protocol.NEVER_DEFAULT_SCOPES.includes(scope), true, `${scope} must not be a kind-independent default`)
  }
  // Assertion order that has been relied on since spec 018. Revision 13 inserted
  // `permission:lower` after `web:unlock` instead, so this pins membership plus "web:unlock
  // still last" rather than a position the document itself never fixes (reported, not
  // reordered here — `web:unlock` and the spec 018 scopes have no contract revision entry).
  assert.deepEqual([...protocol.NEVER_DEFAULT_SCOPES],
    [...SPEC_011_SCOPES, ...SPEC_013_SCOPES, ...SPEC_014_SCOPES, ...SPEC_018_SCOPES, ...SPEC_020_SCOPES,
      ...SPEC_019_SCOPES])
  // Every never-default scope is a contract scope.
  for (const scope of protocol.NEVER_DEFAULT_SCOPES) assert.ok(protocol.SCOPES.includes(scope), scope)

  // The spec restates the revision in the contract document; both must list every scope.
  const specsRoot = path.dirname(path.dirname(path.dirname(findContract())))
  const spec = fs.readFileSync(path.join(specsRoot, '005-remote-desktop-client', 'spec.md'), 'utf8')
  const spec011 = fs.readFileSync(path.join(specsRoot, '011-mobile-session-authoring', 'spec.md'), 'utf8')
  const spec013 = fs.readFileSync(path.join(specsRoot, '013-remote-attachments', 'spec.md'), 'utf8')
  const spec014 = fs.readFileSync(path.join(specsRoot, '014-sidebar-browser', 'spec.md'), 'utf8')
  const spec018 = fs.readFileSync(path.join(specsRoot, '018-parity-wave2-readonly-surface', 'spec.md'), 'utf8')
  const spec020 = fs.readFileSync(path.join(specsRoot, '020-pwa-web-target', 'spec.md'), 'utf8')
  const contractDoc = fs.readFileSync(findContract(), 'utf8')
  assert.match(contractDoc, /\*\*Revision 3/)
  // Spec 008, spec 011, spec 013, spec 014, spec 018, spec 019 and spec 020 scopes belong to
  // their own specs, not to 005.
  for (const scope of protocol.SCOPES.filter(
    (name) => !SPEC_008_SCOPES.includes(name) && !SPEC_011_SCOPES.includes(name)
      && !SPEC_013_SCOPES.includes(name) && !SPEC_014_SCOPES.includes(name)
      && !SPEC_018_SCOPES.includes(name) && !SPEC_019_SCOPES.includes(name)
      && !SPEC_020_SCOPES.includes(name),
  )) {
    assert.ok(spec.includes(`\`${scope}\``), `${scope} must appear in spec 005`)
    assert.ok(contractDoc.includes(`\`${scope}\``), `${scope} must appear in contract §3/§6`)
  }
  // Spec 011 owns its scope (the contract document gains it with revision 7).
  for (const scope of SPEC_011_SCOPES) {
    assert.ok(spec011.includes(`\`${scope}\``), `${scope} must appear in spec 011`)
  }
  // Spec 013 owns its scope (contract revision 8).
  for (const scope of SPEC_013_SCOPES) {
    assert.ok(spec013.includes(`\`${scope}\``), `${scope} must appear in spec 013`)
    assert.ok(contractDoc.includes(`\`${scope}\``), `${scope} must appear in the contract`)
  }
  // Spec 014 C6 owns its scope. It is deliberately NOT asserted against the
  // contract document yet: that document is lead-owned and does not carry a
  // revision for spec 014 (see the report), so the spec is the source here.
  for (const scope of SPEC_014_SCOPES) {
    assert.ok(spec014.includes(`\`${scope}\``), `${scope} must appear in spec 014`)
  }
  // Spec 020 owns `web:unlock` in its "Web unlock" decision; spec 021 (revision 14) keeps it and
  // replaces the attestation with the passkey frames. Revision 14 now names the scope in the
  // contract document too, so both are asserted.
  for (const scope of SPEC_020_SCOPES) {
    assert.ok(spec020.includes(`\`${scope}\``), `${scope} must appear in spec 020`)
  }
  const spec021 = fs.readFileSync(path.join(specsRoot, '021-web-passkey-unlock', 'spec.md'), 'utf8')
  for (const scope of SPEC_021_SCOPES) {
    assert.ok(spec021.includes(`\`${scope}\``), `${scope} must appear in spec 021`)
    assert.ok(contractDoc.includes(`\`${scope}\``), `${scope} must appear in the contract document`)
  }
  assert.match(contractDoc, /## Revision 14 \(spec 021 web passkey unlock, additive\)/)
  // Spec 019 owns `permission:lower`: its spec names it as the approved scope ("Approved for
  // code (owner, Wave 3): permission control as view + lower-only, scope `permission:lower`
  // (never-default)"), the design note spells out "a NEW never-default scope" that is "in the
  // `full` preset only", and contract revision 13 joined the scope table. All three must
  // agree with the constant.
  const spec019 = fs.readFileSync(path.join(specsRoot, '019-parity-wave3-high-risk-design', 'spec.md'), 'utf8')
  const design019 = fs.readFileSync(
    path.join(specsRoot, '019-parity-wave3-high-risk-design', 'permission-lower.md'), 'utf8',
  )
  for (const scope of SPEC_019_SCOPES) {
    assert.equal(protocol.PERMISSION_LOWER_SCOPE, scope, 'the exported scope must be the spec 019 scope')
    assert.ok(spec019.includes(`scope \`${scope}\``), `${scope} must appear in spec 019`)
    assert.ok(design019.includes(`\`${scope}\``), `${scope} must appear in the spec 019 design`)
    assert.ok(design019.includes('NEW never-default scope'), `the design must keep ${scope} never-default`)
    assert.ok(design019.includes('`full` preset only'), `the design must keep ${scope} in the full preset only`)
    assert.ok(contractDoc.includes(`\`${scope}\``), `${scope} must appear in the contract document`)
    assert.ok(contractDoc.includes('never-default, mobile-grantable, present only in'), `revision 13 must say how ${scope} is granted`)
  }
  // Revision 13 is the contract-side record of spec 019 (the same way revision 12 is 018/020).
  assert.match(contractDoc, /## Revision 13 \(spec 019 permission control, additive\)/)
  // Spec 018 owns the metric scope by its item list ("session stats + context usage");
  // the gateway protocol document names `stats:read` as the spec 018 scope, and both
  // read-only views it lifts (`session-stats`, `context-usage`) are spec 018 items.
  assert.match(spec018, /session stats \+ context usage/)
  assert.equal(protocol.STATS_READ_SCOPE, 'stats:read')
  for (const frame of protocol.STATS_READ_CLIENT_TYPES) assert.ok(protocol.SCOPES.includes(protocol.SCOPE_BY_TYPE[frame]), frame)
  const gatewayProtocol = fs.readFileSync(
    path.join(path.dirname(specsRoot), 'plugins', 'mobile-gateway', 'PROTOCOL.md'), 'utf8',
  )
  assert.ok(gatewayProtocol.includes('`stats:read`（spec 018'), 'stats:read must be the spec 018 scope there')
  // `schedule:read` has no line in specs/018's short spec: it is item 3 ("scheduled tasks
  // (read only)") whose scope only the gateway protocol document names (reported as a doc gap).
  assert.match(spec018, /scheduled tasks \(read only\)/)
  assert.equal(protocol.SCHEDULE_READ_SCOPE, 'schedule:read')
  assert.ok(gatewayProtocol.includes('`schedule:read`**（显式授予，'), 'schedule:read must be the spec 018 new scope there')
  for (const scope of protocol.DESKTOP_DEFAULT_SCOPES) assert.ok(protocol.SCOPES.includes(scope), scope)
})

test('SCOPE_BY_TYPE only names contract ops and scopes, and covers the FR2 mapped types', () => {
  // Every type this package maps without being a §4 op: it names the protocol's own
  // exported list instead of restating the names, so a renamed frame follows its list.
  const listedTypes = [
    ...protocol.REMOTE_CLIENT_TYPES,
    ...protocol.REMOTE_UPLOAD_CLIENT_TYPES,
    ...protocol.STATS_READ_CLIENT_TYPES,
    ...protocol.TEAM_READ_CLIENT_TYPES,
    ...protocol.SCHEDULE_READ_CLIENT_TYPES,
    ...protocol.QUESTION_RESPONSE_TYPES,
    // Spec 021 (revision 14): the four passkey frames replace spec 020's `account-attestation`.
    ...protocol.PASSKEY_CLIENT_TYPES,
    // Spec 019 (revision 13): the two permission frames.
    ...protocol.PERMISSION_LOWER_TYPES,
  ]
  for (const [type, scope] of Object.entries(protocol.SCOPE_BY_TYPE)) {
    // Spec 008 remote-bridge, spec 013 upload frames, the spec 018 read-only views, the
    // spec 019 permission frames and the spec 020 attestation are scoped too, but are not
    // §4 ops.
    assert.ok(OPS.includes(type) || listedTypes.includes(type), `${type} is not a contract §4 op`)
    assert.ok(protocol.SCOPES.includes(scope), `${type} → unknown scope ${scope}`)
  }
  // The types the desktop client (spec 005 US2) must be able to send.
  for (const type of ['sessions', 'history', 'message', 'session-cancel', 'approval-response']) {
    assert.ok(protocol.SCOPE_BY_TYPE[type], `${type} must be mapped`)
  }
  // Unmappable today: they manage the credential or push, not a scoped capability.
  for (const type of ['device-forget', 'push-register', 'push-remove']) {
    assert.equal(protocol.SCOPE_BY_TYPE[type], undefined, `${type} must stay unmapped (fail closed)`)
  }
  // Spec 011 FR-002: exactly the §4 authoring rows — and nothing else — carry the scope.
  for (const type of contractAuthoringOps) {
    assert.equal(protocol.SCOPE_BY_TYPE[type], protocol.AUTHORING_SCOPE, `${type} must need the authoring scope`)
  }
  assert.deepEqual(
    Object.keys(protocol.SCOPE_BY_TYPE).filter((type) => protocol.SCOPE_BY_TYPE[type] === protocol.AUTHORING_SCOPE).sort(),
    [...contractAuthoringOps].sort(),
  )
  assert.equal(protocol.AUTHORING_SCOPE, 'sessions:author')
  // Spec 013 R1/R3: exactly the four upload frames carry the attachment scope.
  assert.deepEqual(
    Object.keys(protocol.SCOPE_BY_TYPE).filter((type) => protocol.SCOPE_BY_TYPE[type] === 'attachments:write').sort(),
    [...protocol.REMOTE_UPLOAD_CLIENT_TYPES].sort(),
  )
  assert.equal(protocol.ATTACHMENTS_WRITE_SCOPE, 'attachments:write')
  // Spec 018 item 1: exactly the two metric frames carry `stats:read`.
  assert.deepEqual(
    Object.keys(protocol.SCOPE_BY_TYPE).filter((type) => protocol.SCOPE_BY_TYPE[type] === 'stats:read').sort(),
    [...protocol.STATS_READ_CLIENT_TYPES].sort(),
  )
  // Spec 018 item 2: the team frames need no scope of their own, only `sessions:read`.
  for (const type of protocol.TEAM_READ_CLIENT_TYPES) {
    assert.equal(protocol.SCOPE_BY_TYPE[type], 'sessions:read', `${type} must ride sessions:read`)
  }
  // Spec 018 item 3: exactly the three read-only schedule frames carry `schedule:read`; the
  // mutating schedule ops stay unmapped, so they are refused whatever scope the device holds.
  assert.deepEqual(
    Object.keys(protocol.SCOPE_BY_TYPE).filter((type) => protocol.SCOPE_BY_TYPE[type] === 'schedule:read').sort(),
    [...protocol.SCHEDULE_READ_CLIENT_TYPES].sort(),
  )
  for (const type of ['schedule-create', 'schedule-update', 'schedule-delete', 'schedule-run', 'schedule-history']) {
    assert.equal(protocol.SCOPE_BY_TYPE[type], undefined, `${type} must stay unmapped (fail closed)`)
  }
  // Spec 018 item 4: answering a question is the same interaction as an approval card, so
  // exactly these two frames ride `approval:respond` alongside the §4 approval op.
  assert.deepEqual(
    Object.keys(protocol.SCOPE_BY_TYPE).filter((type) => protocol.SCOPE_BY_TYPE[type] === 'approval:respond').sort(),
    ['approval-response', ...protocol.QUESTION_RESPONSE_TYPES].sort(),
  )
  // Spec 021 (revision 14): exactly the four passkey frames map to `web:unlock`, the scope keeps
  // its spec 020 name, and spec 020's account attestation is withdrawn from the wire vocabulary.
  assert.equal(protocol.WEB_UNLOCK_SCOPE, 'web:unlock')
  assert.deepEqual(
    Object.keys(protocol.SCOPE_BY_TYPE).filter((type) => protocol.SCOPE_BY_TYPE[type] === 'web:unlock').sort(),
    [...protocol.PASSKEY_CLIENT_TYPES].sort(),
  )
  assert.equal(protocol.SCOPE_BY_TYPE['account-attestation'], undefined, 'the spec 020 attestation is withdrawn')
  assert.equal(Object.hasOwn(protocol, 'ACCOUNT_ATTESTATION_TYPE'), false, 'no exported spec 020 frame name remains')
  // Spec 019 (revision 13): exactly the exported permission frames carry `permission:lower`,
  // and neither of them is a §4 op — the protocol's own list is what this pins, so a renamed
  // frame follows its list instead of being restated here.
  assert.deepEqual(protocol.PERMISSION_LOWER_TYPES, protocol.PERMISSION_LOWER_CLIENT_TYPES,
    'the alias must be the same list the scope map fills')
  assert.deepEqual(
    [...protocol.PERMISSION_LOWER_TYPES].sort(),
    Object.keys(protocol.SCOPE_BY_TYPE).filter((type) => protocol.SCOPE_BY_TYPE[type] === 'permission:lower').sort(),
  )
  for (const type of protocol.PERMISSION_LOWER_TYPES) {
    assert.equal(contractOps.includes(type), false, `${type} must not appear in the §4 table`)
    assert.equal(protocol.SCOPE_BY_TYPE[type], protocol.PERMISSION_LOWER_SCOPE, `${type} must need the permission scope`)
    // Revision 13 names each frame followed by its arguments: `permission-options {sessionId}`.
    assert.ok(contract.includes(`\`${type} {`), `${type} must be named as \`${type} {...}\` in the contract document`)
  }
  // Lowering is not answering an approval: the interaction frames must not ride this scope.
  for (const type of ['approval-response', ...protocol.QUESTION_RESPONSE_TYPES]) {
    assert.notEqual(protocol.SCOPE_BY_TYPE[type], protocol.PERMISSION_LOWER_SCOPE, `${type} must not need permission:lower`)
  }
  // The exempt ops a locked web device may still send are the passkey frames only — never a
  // §4 op and never a device-management frame, so the lock cannot be routed around.
  assert.deepEqual([...protocol.WEB_UNLOCK_EXEMPT_TYPES], [...protocol.PASSKEY_CLIENT_TYPES])
  for (const type of protocol.WEB_UNLOCK_EXEMPT_TYPES) {
    assert.equal(OPS.includes(type), false, `${type} must not be a §4 op`)
    assert.equal(protocol.SCOPE_BY_TYPE[type], 'web:unlock', `${type} must need web:unlock`)
  }
})

test('auth/forbidden-scope is an in-band-only contract error (spec 005 FR6)', () => {
  assert.equal(protocol.ERROR_CODES['auth/forbidden-scope'], null)
  assert.match(contract, /\| `auth\/forbidden-scope` \| — \|/)
  assert.match(contract, /Other host error codes .* passed through unchanged/)
})

// ---------------------------------------------------------------------------
// Spec 008 — remote-bridge channel (revision 4, additive)
// ---------------------------------------------------------------------------

test('remote-bridge frame types are additive: not §4 ops, every client type needs harness:remote', () => {
  assert.deepEqual([...protocol.REMOTE_CLIENT_TYPES],
    ['remote-call', 'remote-stream-open', 'remote-stream-cancel', 'remote-stream-credit'])
  assert.deepEqual([...protocol.REMOTE_SERVER_KINDS], ['remote-result', 'remote-frame', 'remote-stream-closed'])
  for (const type of protocol.REMOTE_CLIENT_TYPES) {
    // The companion-v1 allowlist (§4) is untouched: a mobile device cannot send these.
    assert.equal(OPS.includes(type), false, `${type} must not join the §4 OPS`)
    assert.equal(protocol.SCOPE_BY_TYPE[type], 'harness:remote', `${type} must require harness:remote`)
  }
  // Revision 4 adds no op: the allowlist is exactly the §4 table (revision 7's four rows are
  // in it), so a bridge frame sneaking into the contract would break these counts.
  assert.equal(OPS.length, contractOps.length)
  for (const type of protocol.REMOTE_CLIENT_TYPES) {
    assert.equal(contractOps.includes(type), false, `${type} must not appear in the §4 table`)
  }
  assert.equal(protocol.REMOTE_STREAM_DEFAULT_CREDIT, 64)
  assert.equal(protocol.REMOTE_BINARY_CHUNK_BYTES, 256 * 1024)
})

test('spec 008 full-control scopes: desktop-only, explicit-only, no frame type maps to them', () => {
  for (const scope of SPEC_008_SCOPES) {
    assert.ok(protocol.SCOPES.includes(scope), `${scope} must be a contract scope`)
    assert.ok(protocol.DESKTOP_ONLY_SCOPES.includes(scope), `${scope} must be desktop-only`)
    assert.equal(protocol.DESKTOP_DEFAULT_SCOPES.includes(scope), false)
  }
  // Frame types only ever need harness:remote; the families are checked per endpoint by the bridge.
  for (const scope of SPEC_008_SCOPES.filter((name) => name !== 'harness:remote')) {
    assert.equal(Object.values(protocol.SCOPE_BY_TYPE).includes(scope), false, `${scope} must not gate a frame type`)
  }
})

test('SCOPE_PRESETS: standard is the four read/prompt/approve/files scopes plus harness:remote; full is every desktop scope', () => {
  assert.deepEqual(Object.keys(protocol.SCOPE_PRESETS), ['standard', 'full'])
  assert.deepEqual([...protocol.SCOPE_PRESETS.standard],
    ['sessions:read', 'prompt:send', 'approval:respond', 'files:read', 'harness:remote'])
  // "Every desktop scope" = every contract scope: the desktop may hold all of them.
  assert.deepEqual([...protocol.SCOPE_PRESETS.full].sort(), [...protocol.SCOPES].sort())
  for (const scope of SPEC_008_SCOPES) assert.ok(protocol.SCOPE_PRESETS.full.includes(scope), `full must include ${scope}`)
  for (const preset of Object.values(protocol.SCOPE_PRESETS)) {
    assert.equal(Object.isFrozen(preset), true)
    for (const scope of preset) assert.ok(protocol.SCOPES.includes(scope), `${scope} is not a contract scope`)
  }
  // Neither preset is a default: DESKTOP_DEFAULT_SCOPES stays the FR3 three plus the
  // spec 013 attachment scope and the spec 014 browser scope.
  assert.deepEqual([...protocol.DESKTOP_DEFAULT_SCOPES],
    ['sessions:read', 'prompt:send', 'approval:respond', 'attachments:write', 'browser:control'])
})

test('the d.ts declares the revision 4 surface', () => {
  const declaration = fs.readFileSync(new URL('../index.d.ts', import.meta.url), 'utf8')
  assert.match(declaration, /\| 'harness:remote'/)
  for (const scope of SPEC_008_SCOPES) assert.ok(declaration.includes(`| '${scope}'`), `${scope} must be declared as a Scope`)
  for (const name of ['DESKTOP_ONLY_SCOPES', 'SCOPE_PRESETS']) {
    assert.ok(declaration.includes(`export const ${name}`), `${name} must be declared`)
  }
  for (const name of ['REMOTE_CLIENT_TYPES', 'REMOTE_SERVER_KINDS', 'REMOTE_STREAM_DEFAULT_CREDIT', 'REMOTE_BINARY_CHUNK_BYTES']) {
    assert.ok(declaration.includes(`export const ${name}`), `${name} must be declared`)
  }
  for (const type of protocol.REMOTE_CLIENT_TYPES) assert.ok(declaration.includes(`'${type}'`), `${type} must be declared`)
  for (const kind of protocol.REMOTE_SERVER_KINDS) assert.ok(declaration.includes(`'${kind}'`), `${kind} must be declared`)
  for (const name of ['RemoteCallFrame', 'RemoteStreamOpenFrame', 'RemoteStreamCancelFrame', 'RemoteStreamCreditFrame',
    'RemoteResultFrame', 'RemoteFrame', 'RemoteStreamClosedFrame']) {
    assert.match(declaration, new RegExp(`export (interface|type) ${name}\\b`), `${name} must be declared`)
  }
})

// ---------------------------------------------------------------------------
// Spec 011 — session authoring (revision 7, additive)
// ---------------------------------------------------------------------------

test('the d.ts declares the spec 011 authoring ops and scope', () => {
  const declaration = fs.readFileSync(new URL('../index.d.ts', import.meta.url), 'utf8')
  for (const op of contractAuthoringOps) {
    assert.ok(declaration.includes(`| '${op}'`), `${op} must be declared as an Op`)
    const kind = contractOpResponses[op]
    assert.ok(declaration.includes(`| '${kind}'`), `${kind} must be declared as a ResponseKind`)
  }
  for (const name of ['AUTHORING_CLIENT_TYPES', 'AUTHORING_SCOPE']) {
    assert.ok(declaration.includes(`export const ${name}`), `${name} must be declared`)
  }
  for (const scope of SPEC_011_SCOPES) {
    assert.ok(declaration.includes(`| '${scope}'`), `${scope} must be declared as a Scope`)
  }
})

// ---------------------------------------------------------------------------
// §5a — session rows (revision 2.1): canonical sessionId/running
// ---------------------------------------------------------------------------

test('SessionRow §5a fields are normative and the package mirrors them', () => {
  // Exact revision 2.1 clarification: the row id is `sessionId`, not `id`.
  assert.match(contract, /## 5a\. Clarifications \(rev 2\.1/)
  assert.match(
    contract,
    /`sessions` rows carry `sessionId`, `updatedAt` \(epoch ms\), `running`, `projections\.values\.title`/,
  )
  assert.match(contract, /client\s*\n\s*derives running\/idle\/archived\./)

  const declaration = fs.readFileSync(new URL('../index.d.ts', import.meta.url), 'utf8')
  const interfaceBlock = declaration.match(/export interface SessionRow \{[\s\S]*?\n\}/)?.[0]
  assert.ok(interfaceBlock, 'SessionRow interface not found in index.d.ts')
  assert.match(interfaceBlock, /^\s*sessionId: string$/m)
  assert.match(interfaceBlock, /^\s*running\?: boolean$/m)
  // `id` survives only as an explicitly deprecated optional compatibility fallback.
  assert.match(interfaceBlock, /^\s*id\?: string$/m)
  assert.match(interfaceBlock, /@deprecated[\s\S]*?id\?: string/)
  assert.doesNotMatch(interfaceBlock, /^\s*id: string$/m)

  const runtime = fs.readFileSync(new URL('../src/index.mjs', import.meta.url), 'utf8')
  const start = runtime.indexOf('@typedef {Object} SessionRow')
  assert.notEqual(start, -1, 'SessionRow typedef not found in src/index.mjs')
  const typedef = runtime.slice(start, runtime.indexOf('*/', start))
  assert.match(typedef, /@property \{string\} sessionId/)
  assert.match(typedef, /@property \{boolean\} \[running\]/)
  assert.match(typedef, /@property \{string\} \[id\] Deprecated:/)
  assert.doesNotMatch(typedef, /@property \{string\} id\b/)
})

// ---------------------------------------------------------------------------
// Spec 013 — attachment upload over the pinned link (revision 8, additive)
// ---------------------------------------------------------------------------

test('revision 8: the four upload frames are additive, scoped, and none joins the §4 ops', () => {
  assert.deepEqual([...protocol.REMOTE_UPLOAD_CLIENT_TYPES],
    ['remote-upload-open', 'remote-upload-chunk', 'remote-upload-finish', 'remote-upload-cancel'])
  assert.equal(protocol.REMOTE_UPLOAD_RESULT_KIND, 'remote-upload-result')
  // R3: the chunk bound is 256 KiB of decoded bytes.
  assert.equal(protocol.REMOTE_UPLOAD_MAX_CHUNK_BYTES, 256 * 1024)
  assert.equal(protocol.REMOTE_UPLOAD_MAX_CHUNK_BYTES, protocol.REMOTE_BINARY_CHUNK_BYTES)
  for (const type of protocol.REMOTE_UPLOAD_CLIENT_TYPES) {
    // The companion-v1 allowlist (§4) is untouched: a §4 op cannot carry these frames.
    assert.equal(OPS.includes(type), false, `${type} must not join the §4 OPS`)
    assert.equal(contractOps.includes(type), false, `${type} must not appear in the §4 table`)
    assert.equal(protocol.SCOPE_BY_TYPE[type], 'attachments:write', `${type} must require attachments:write`)
  }
  assert.equal(OPS.length, contractOps.length)
  // The scope is the last entry of the vocabulary, so the document's revision 8 must
  // name both the scope and the four frame types.
  assert.match(contract, /## Revision 8 \(spec 013, additive\)/)
  for (const text of ['attachments:write', ...protocol.REMOTE_UPLOAD_CLIENT_TYPES, 'remote-upload-result']) {
    assert.ok(contract.includes(text), `${text} must appear in the contract`)
  }
})

test('revision 8: the d.ts declares the upload surface', () => {
  const declaration = fs.readFileSync(new URL('../index.d.ts', import.meta.url), 'utf8')
  for (const name of ['REMOTE_UPLOAD_CLIENT_TYPES', 'REMOTE_UPLOAD_RESULT_KIND', 'REMOTE_UPLOAD_MAX_CHUNK_BYTES',
    'ATTACHMENTS_WRITE_SCOPE', 'RemoteUploadType', 'RemoteUploadKind']) {
    assert.ok(declaration.includes(`export const ${name}`) || declaration.includes(`export type ${name}`),
      `${name} must be declared`)
  }
  for (const type of protocol.REMOTE_UPLOAD_CLIENT_TYPES) {
    assert.ok(declaration.includes(`'${type}'`), `${type} must be declared`)
  }
  for (const name of ['RemoteUploadOpenFrame', 'RemoteUploadChunkFrame', 'RemoteUploadFinishFrame',
    'RemoteUploadCancelFrame', 'RemoteUploadResultFrame', 'RemoteUploadOpenedValue',
    'RemoteUploadReceiptValue', 'RemoteUploadError']) {
    assert.match(declaration, new RegExp(`export (interface|type) ${name}\\b`), `${name} must be declared`)
  }
  assert.ok(declaration.includes(`| 'attachments:write'`), 'attachments:write must be declared as a Scope')
})

// ---------------------------------------------------------------------------
// Spec 014 C6 — the side-panel browser scope (additive)
// ---------------------------------------------------------------------------

// ---------------------------------------------------------------------------
// Spec 016 Phase 3 — host-driven client browser (revision 10, additive)
// ---------------------------------------------------------------------------

test('revision 10: the document carries the frames, the capability and the limits verbatim', () => {
  // Revision 9 was already taken by companion parity when this revision landed, so the
  // browser surface is revision 10 (the spec's "revision 9" wording is older than it).
  assert.match(contract, /## Revision 10 \(spec 016 Phase 3/)
  assert.ok(contract.includes(`\`${protocol.BROWSER_AGENT_CAPABILITY}\``), 'the capability must appear')
  for (const frame of [...protocol.BROWSER_HOST_KINDS, ...protocol.BROWSER_CLIENT_TYPES]) {
    assert.ok(contract.includes(`\`${frame}\``), `${frame} must appear in the contract`)
  }
  // Every op the host may ask for is named, so a client cannot be expected to guess one.
  for (const op of protocol.BROWSER_OPS) assert.ok(contract.includes(`\`${op}\``), `${op} must appear`)
  // The limits are literal numbers in the document, not just prose.
  for (const limit of [protocol.BROWSER_FRAME_MAX_BYTES, protocol.BROWSER_DEADLINE_DEFAULT_MS,
    protocol.BROWSER_DEADLINE_MAX_MS, protocol.BROWSER_SCREENSHOT_MAX_BYTES, protocol.BROWSER_TEXT_MAX_BYTES]) {
    assert.ok(contract.includes(String(limit)), `the limit ${limit} must appear in the contract`)
  }
  for (const code of protocol.BROWSER_ERROR_CODES) assert.ok(contract.includes(code), `${code} must appear`)
  for (const service of ['remoteSessionScope', 'remoteBrowser']) assert.ok(contract.includes(`'${service}'`), service)
  assert.match(contract, /Two keys, never one/)
})

test('revision 10 stays additive: no §4 op, no SCOPE_BY_TYPE entry, no required capability', () => {
  assert.equal(OPS.length, contractOps.length)
  for (const frame of [...protocol.BROWSER_HOST_KINDS, ...protocol.BROWSER_CLIENT_TYPES]) {
    assert.equal(contractOps.includes(frame), false, `${frame} must not appear in the §4 table`)
    assert.equal(protocol.SCOPE_BY_TYPE[frame], undefined, `${frame} must not be gated by type`)
  }
  // The scope already existed (spec 014 C6); this revision only starts enforcing it.
  assert.ok(protocol.SCOPES.includes(protocol.BROWSER_CONTROL_SCOPE))
  assert.equal(CAPABILITIES.includes(protocol.BROWSER_AGENT_CAPABILITY), false)
})

test('the d.ts declares the revision 10 surface', () => {
  const declaration = fs.readFileSync(new URL('../index.d.ts', import.meta.url), 'utf8')
  for (const name of ['BROWSER_AGENT_CAPABILITY', 'BROWSER_CONTROL_SCOPE', 'BROWSER_OPS', 'BROWSER_HOST_KINDS',
    'BROWSER_CLIENT_TYPES', 'BROWSER_FRAME_MAX_BYTES', 'BROWSER_DEADLINE_DEFAULT_MS', 'BROWSER_DEADLINE_MAX_MS',
    'BROWSER_SCREENSHOT_MAX_BYTES', 'BROWSER_TEXT_MAX_BYTES', 'BROWSER_COMMAND_ID', 'BROWSER_ERROR_CODES']) {
    assert.ok(declaration.includes(`export const ${name}`), `${name} must be declared`)
  }
  for (const name of ['BrowserOp', 'BrowserHostKind', 'BrowserClientType', 'BrowserCommandFrame',
    'BrowserResultFrame', 'BrowserCancelFrame', 'BrowserError', 'BrowserValidation']) {
    assert.match(declaration, new RegExp(`export (interface|type) ${name}\\b`), `${name} must be declared`)
  }
  for (const fn of ['browserFrameBytes', 'validateBrowserCommand', 'validateBrowserResult',
    'validateBrowserCancel', 'truncateBrowserText']) {
    assert.ok(declaration.includes(`export function ${fn}(`), `${fn} must be declared`)
  }
  // A client advertises the capability on its own hello frame.
  const hello = declaration.match(/export interface ClientHelloFrame \{[\s\S]*?\n\}/)?.[0]
  assert.ok(hello, 'ClientHelloFrame not found')
  assert.match(hello, /^\s*capabilities\?: string\[\]$/m)
})

test('spec 014 C6: browser:control is grantable, a desktop default and never a kind-independent default', () => {
  // Spec 014 is a permissions change, not a new wire frame: no frame type carries the
  // scope (the gateway's remote bridge forwards no `browser/*` endpoint), so it must
  // not appear as a SCOPE_BY_TYPE value and must not join the §4 op list.
  assert.equal(protocol.SCOPES.includes('browser:control'), true)
  assert.equal(Object.values(protocol.SCOPE_BY_TYPE).includes('browser:control'), false,
    'browser:control must not gate a companion frame type')
  assert.equal(protocol.DESKTOP_ONLY_SCOPES.includes('browser:control'), false,
    'a phone may hold it: the owner narrows, the kind does not decide (spec 012 rule 3)')
  assert.equal(protocol.DESKTOP_DEFAULT_SCOPES.includes('browser:control'), true,
    'a new desktop grant starts with it ticked')
  assert.equal(protocol.NEVER_DEFAULT_SCOPES.includes('browser:control'), true,
    'a kind-independent default and the pre-005 migration must never acquire it')
  assert.ok(protocol.SCOPE_PRESETS.full.includes('browser:control'), 'the full preset is every scope')
  // "Not silently migrated" is the point of NEVER_DEFAULT_SCOPES: 0 of the two
  // kind-independent defaults may contain it, however the list grows.
  for (const scope of protocol.NEVER_DEFAULT_SCOPES) assert.ok(protocol.SCOPES.includes(scope), scope)
  // The d.ts must declare it, or the app cannot name the scope it has to send.
  const declaration = fs.readFileSync(new URL('../index.d.ts', import.meta.url), 'utf8')
  assert.ok(declaration.includes(`| 'browser:control'`), 'browser:control must be declared as a Scope')
})

// ---------------------------------------------------------------------------
// Spec 021 — web passkey unlock (revision 14, replaces spec 020's account attestation)
// ---------------------------------------------------------------------------

test('revision 14: the four passkey frames are listed, additive and behind web:unlock', () => {
  assert.deepEqual([...protocol.PASSKEY_CLIENT_TYPES],
    ['passkey-register-options', 'passkey-register', 'passkey-assert-options', 'passkey-assert'])
  assert.equal(protocol.PASSKEY_REGISTER_OPTIONS_TYPE, 'passkey-register-options')
  assert.equal(protocol.PASSKEY_REGISTER_TYPE, 'passkey-register')
  assert.equal(protocol.PASSKEY_ASSERT_OPTIONS_TYPE, 'passkey-assert-options')
  assert.equal(protocol.PASSKEY_ASSERT_TYPE, 'passkey-assert')
  // Additive: the §4 allowlist is exactly the §4 table, and no frame joins it.
  assert.equal(OPS.length, contractOps.length)
  for (const type of protocol.PASSKEY_CLIENT_TYPES) {
    assert.equal(contractOps.includes(type), false, `${type} must not appear in the §4 table`)
    assert.equal(protocol.SCOPE_BY_TYPE[type], 'web:unlock', `${type} must need web:unlock`)
    // The contract names every frame in §14.1 (the request line of its example, or the §14.2
    // lock frame for `passkey-lock`).
    assert.ok(contract.includes(`"type": "${type}"`), `${type} must be named as a client frame in the contract document`)
  }
  assert.equal(Object.isFrozen(protocol.PASSKEY_CLIENT_TYPES), true, 'the frame list must be frozen')
})

test('revision 14: hello.webLock states, lock reasons, challenge lifetime, idle bound and rate limits', () => {
  assert.deepEqual([...protocol.WEB_LOCK_STATES], ['unregistered', 'locked', 'unlocked'])
  assert.equal(protocol.WEB_LOCK_ERROR, 'auth/locked')
  assert.equal(protocol.PASSKEY_CHALLENGE_TTL_MS, 60_000)
  assert.equal(protocol.WEB_UNLOCK_IDLE_MS, 15 * 60_000)
  assert.deepEqual({ ...protocol.PASSKEY_RATE_LIMITS },
    { perDevice: 5, perDeviceWindowMs: 10 * 60_000, global: 30, globalWindowMs: 60 * 60_000 })
  assert.equal(Object.isFrozen(protocol.PASSKEY_RATE_LIMITS), true)
  assert.equal(Object.isFrozen(protocol.WEB_LOCK_STATES), true)
  // The contract document states the same numbers, so a silent change fails here.
  assert.match(contract, /\*\*60 s\*\* lifetime/)
  assert.match(contract, /\*\*15 minutes\*\*/)
  assert.match(contract, /\*\*5 failed operations per device in 10 minutes\*\*/)
  assert.match(contract, /\*\*30 globally per hour\*\*/)
  assert.match(contract, /\*\*32 random bytes, single use, bound to the socket that asked for it\*\*/)
})

test('revision 14: the five passkey error codes are in band only and match §6', () => {
  assert.deepEqual([...protocol.PASSKEY_ERROR_CODES],
    ['passkey/not-registered', 'passkey/already-registered', 'passkey/challenge-expired',
      'passkey/verification-failed', 'passkey/rate-limited'])
  for (const code of protocol.PASSKEY_ERROR_CODES) {
    assert.equal(ERROR_CODES[code], null, `${code} is in band (no upgrade status)`)
    assert.equal(Object.isFrozen(protocol.PASSKEY_ERROR_CODES), true)
  }
  // attStmt `none` and the two signature algorithms are the registration policy (§14.1).
  assert.match(contract, /attestation format `none` only/)
  assert.match(contract, /ES256 \(P-256, COSE algorithm identifier\n-7\) or RS256 \(COSE algorithm identifier -257\)/)
  // Registration options list the ES256/RS256 algorithms the gateway accepts.
  assert.match(contract, /\{ "type": "public-key", "alg": -7 \}, \{ "type": "public-key", "alg": -257 \}/)
})

test('revision 14: the d.ts declares the passkey surface and the withdrawn spec 020 name is gone', () => {
  const declaration = fs.readFileSync(new URL('../index.d.ts', import.meta.url), 'utf8')
  for (const name of ['PASSKEY_REGISTER_OPTIONS_TYPE', 'PASSKEY_REGISTER_TYPE', 'PASSKEY_ASSERT_OPTIONS_TYPE',
    'PASSKEY_ASSERT_TYPE', 'PASSKEY_CLIENT_TYPES', 'WEB_UNLOCK_SCOPE', 'WEB_UNLOCK_EXEMPT_TYPES', 'WEB_LOCK_ERROR',
    'WEB_LOCK_STATES', 'PASSKEY_CHALLENGE_TTL_MS', 'PASSKEY_RATE_LIMITS', 'WEB_UNLOCK_IDLE_MS',
    'PASSKEY_ERROR_CODES', 'PASSKEY_APPROVAL_KIND', 'PASSKEY_APPROVAL_ACTIONS']) {
    assert.ok(declaration.includes(`export const ${name}`), `${name} must be declared`)
  }
  for (const name of ['PasskeyType', 'WebLockState', 'WebLockReason', 'PasskeyErrorCode']) {
    assert.match(declaration, new RegExp(`export (interface|type) ${name}\\b`), `${name} must be declared`)
  }
  // `hello` carries the lock state only for a web device.
  const hello = declaration.match(/export interface HelloFrame \{[\s\S]*?\n\}/)?.[0]
  assert.ok(hello, 'HelloFrame not found')
  assert.match(hello, /^\s*webLock\?: WebLockState$/m)
  // Spec 020's account attestation is withdrawn: no surface may still declare it.
  assert.equal(declaration.includes('ACCOUNT_ATTESTATION_TYPE'), false, 'the spec 020 frame name must not remain')
  assert.equal(declaration.includes('host-signed-out'), false, 'the spec 020 lock reasons must not remain')
})
