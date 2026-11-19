// Spec 050 — controlled NATIVE-phone string-pairing regression.
//
// The released build1 app parser (apps/mobile-companion/src/core/qr.ts at commit
// ff88ccd5f39f4f4b7382359ab1dcfa70f499f074) is embedded verbatim below, with ONE
// documented transformation: its import of PAIRING_QR_VERSION/PairingQr from the
// app protocol module is replaced by the inlined constant that the same
// commit's protocol.ts re-exports from @dsh-ext/mobile-protocol. It is written to
// a temp .mts module and executed by Node 24's TypeScript stripping, so this test
// runs the RELEASED parser, not a re-implementation. No QR payload or credential
// is printed: assertions name fields and booleans only.
//
// Flow: genuine POST /mgw/pair {mode:'string', kind:'mobile', scopes excluding
// web:unlock} -> released parser accepts v3/pin -> pinned TLS pairing client
// (test/client/pair.mjs, no pin weakening) -> Host pending -> widening with
// web:unlock refused -> approve subset -> paired scopes exclude web:unlock,
// no hello.webLock, and a token-authenticated `sessions` read succeeds.

import assert from 'node:assert/strict'
import crypto from 'node:crypto'
import fs from 'node:fs'
import http from 'node:http'
import net from 'node:net'
import os from 'node:os'
import path from 'node:path'
import tls from 'node:tls'
import { once } from 'node:events'
import { test } from 'node:test'
import { pathToFileURL } from 'node:url'

import WebSocket from 'ws'
import { scopesForKind } from '@dsh-ext/mobile-protocol'
import plugin from '../lib/index.mjs'
import { createTestConnection, createTestRemoteAccess } from './helpers/peer.mjs'
import { listenFetchSafe } from './support/fetch-safe-listen.mjs'
import { connect, pinnedTlsOptions } from './client/pair.mjs'

const PARSER_COMMIT = 'ff88ccd5f39f4f4b7382359ab1dcfa70f499f074'
const RELEASED_PARSER_SOURCE = "// QR v3 parsing/validation per contract §2 (revision 2):\n//\n//   QR/manual text = unpadded base64url(UTF-8 JSON\n//     { version: 3, publicUrl, pairingCode, expiresAt (epoch ms), certSha256, gatewayId,\n//       gatewayName, endpoints[] })\n//\n// Pure: no react-native/expo/Node imports; the clock is injected for tests. base64url is\n// decoded locally (no Buffer/atob), so the same code runs in Node tests and in Hermes.\n//\n// Reject rule summary (spec FR-002 / SC-002): nothing about a QR we cannot fully trust may\n// reach the transport, because the QR is the only source of the certificate pin.\n//\n// Every rule below is the contract\u0027s, with no extra tolerance:\n//   - `expiresAt` must be epoch milliseconds ≤ 5 min (300 000 ms) ahead of the injected clock.\n//     No clock-skew allowance: the contract states the bound, and a longer grace period would\n//     let the phone keep presenting a code the host has already dropped.\n//   - `gatewayId` must be the UUID v4 the host writes (`crypto.randomUUID()`); the host itself\n//     refuses a state file whose id is not lowercase v4, so any other spelling cannot be live.\n//   - `pairingCode` must be the canonical unpadded base64url of 256 bits: exactly 43 characters\n//     from the base64url alphabet, decoding to 32 bytes with the two spare bits zero.\n//   - the raw text and the decoded payload are bounded before any JSON work, so a pasted blob\n//     cannot turn the parser into an allocation/parse amplifier.\n\nconst PAIRING_QR_VERSION = 3; // inlined from the same commit\u0027s protocol.ts re-export of the contract constant\n\nexport type QrRejectReason =\n  /** Not base64url text, larger than any pairing code, or not valid UTF-8 JSON. */\n  | \u0027qr/invalid-json\u0027\n  /** `version` missing or != 3. */\n  | \u0027qr/unsupported-version\u0027\n  /** `publicUrl` or `endpoints[]` missing, not a URL, or scheme != wss. */\n  | \u0027qr/bad-endpoint\u0027\n  /** `certSha256` missing or not exactly 64 lowercase hex chars. */\n  | \u0027qr/bad-cert-sha256\u0027\n  /** `pairingCode` missing or not the canonical 43-char base64url of 32 bytes. */\n  | \u0027qr/bad-pairing-code\u0027\n  /** `expiresAt` missing or not epoch milliseconds. */\n  | \u0027qr/bad-expires-at\u0027\n  /** `expiresAt` is at or before the injected clock, or more than `PAIRING_TTL_MS` ahead. */\n  | \u0027qr/expired\u0027\n  /** `gatewayName` present but not a string (or too long). */\n  | \u0027qr/bad-host-name\u0027\n  /** `gatewayId` missing or not a canonical lowercase UUID v4. */\n  | \u0027qr/bad-gateway-id\u0027;\n\nexport type QrParseResult =\n  | { ok: true; value: PairingQr }\n  | { ok: false; reason: QrRejectReason; message: string };\n\n/** RFC 4648 §5 alphabet without padding. */\nconst BASE64URL_RE = /^[A-Za-z0-9_-]+$/;\nconst CERT_SHA256_RE = /^[0-9a-f]{64}$/;\n/** The id the host writes (`crypto.randomUUID()`), and the only form its own state file accepts. */\nconst GATEWAY_ID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;\nconst MAX_GATEWAY_NAME = 128;\n\n/** Contract §2: `expiresAt` is ≤ 5 min ahead. Strict — the contract documents no skew allowance. */\nexport const PAIRING_TTL_MS = 5 * 60 * 1000;\n/** Contract §2: `pairingCode` is 256 bits of unpadded base64url — 32 bytes, 43 characters. */\nexport const PAIRING_CODE_BYTES = 32;\nexport const PAIRING_CODE_LENGTH = 43;\n\n/**\n * Upper bound on the raw QR/manual text, checked before decoding.\n *\n * A QR symbol tops out at 2953 bytes (version 40, error correction L), and the gateway\u0027s payload\n * is ~400 bytes in practice, so 16 KiB is several times larger than anything a real pairing code\n * (or the spec-005 desktop copy-paste of the same string) can be. It is a bound, not a size\n * budget: a pasted blob is refused instead of being decoded and parsed.\n */\nexport const MAX_QR_TEXT_LENGTH = 16 * 1024;\n/** Upper bound on the decoded UTF-8 JSON: base64url expands 4 characters per 3 bytes. */\nexport const MAX_QR_PAYLOAD_BYTES = (MAX_QR_TEXT_LENGTH / 4) * 3;\n\nexport interface ParseQrOptions {\n  /** Injected clock (epoch ms); defaults to `Date.now`. Expiry is compared against this. */\n  now?: () =\u003e number;\n}\n\n/**\n * Parse the raw text of a scanned QR (or the manually pasted string). Accepts only the\n * contract\u0027s unpadded base64url encoding of the JSON payload. Never throws.\n */\nexport function parsePairingQr(raw: string, options: ParseQrOptions = {}): QrParseResult {\n  const now = options.now ?? Date.now;\n\n  const text = typeof raw === \u0027string\u0027 ? raw.trim() : \u0027\u0027;\n  if (text === \u0027\u0027) return reject(\u0027qr/invalid-json\u0027, \u0027The code is empty\u0027);\n  if (text.length \u003e MAX_QR_TEXT_LENGTH) {\n    return reject(\n      \u0027qr/invalid-json\u0027,\n      `The code is too large to be a pairing code (limit ${MAX_QR_TEXT_LENGTH} characters)`,\n    );\n  }\n  if (!BASE64URL_RE.test(text)) {\n    return reject(\u0027qr/invalid-json\u0027, \u0027The code is not unpadded base64url text (no JSON, no \"=\" padding)\u0027);\n  }\n  const bytes = decodeBase64Url(text);\n  if (bytes === null) return reject(\u0027qr/invalid-json\u0027, \u0027The code is not valid base64url\u0027);\n  if (bytes.length \u003e MAX_QR_PAYLOAD_BYTES) {\n    return reject(\u0027qr/invalid-json\u0027, `The decoded payload is too large (limit ${MAX_QR_PAYLOAD_BYTES} bytes)`);\n  }\n\n  let data: unknown;\n  try {\n    data = JSON.parse(decodeUtf8(bytes)) as unknown;\n  } catch {\n    return reject(\u0027qr/invalid-json\u0027, \u0027The decoded code is not UTF-8 JSON\u0027);\n  }\n  if (typeof data !== \u0027object\u0027 || data === null || Array.isArray(data)) {\n    return reject(\u0027qr/invalid-json\u0027, \u0027The decoded code is not a JSON object\u0027);\n  }\n  const obj = data as Record\u003cstring, unknown\u003e;\n\n  if (obj.version !== PAIRING_QR_VERSION) {\n    return reject(\u0027qr/unsupported-version\u0027, `Code version must be ${PAIRING_QR_VERSION}`);\n  }\n\n  const publicUrlCheck = checkWssUrl(obj.publicUrl);\n  if (publicUrlCheck !== null) return reject(\u0027qr/bad-endpoint\u0027, `publicUrl: ${publicUrlCheck}`);\n\n  const endpointsCheck = checkEndpoints(obj.endpoints);\n  if (endpointsCheck !== null) return reject(\u0027qr/bad-endpoint\u0027, endpointsCheck);\n\n  if (typeof obj.certSha256 !== \u0027string\u0027 || !CERT_SHA256_RE.test(obj.certSha256)) {\n    return reject(\u0027qr/bad-cert-sha256\u0027, \u0027certSha256 must be 64 lowercase hex characters\u0027);\n  }\n\n  if (!isPairingCode(obj.pairingCode)) {\n    return reject(\n      \u0027qr/bad-pairing-code\u0027,\n      `pairingCode must be ${PAIRING_CODE_LENGTH} canonical base64url characters (${PAIRING_CODE_BYTES} bytes)`,\n    );\n  }\n\n  if (typeof obj.expiresAt !== \u0027number\u0027 || !Number.isSafeInteger(obj.expiresAt) || obj.expiresAt \u003c= 0) {\n    return reject(\u0027qr/bad-expires-at\u0027, \u0027expiresAt must be epoch milliseconds\u0027);\n  }\n  const remaining = obj.expiresAt - now();\n  if (remaining \u003c= 0) {\n    return reject(\u0027qr/expired\u0027, \u0027This code has expired; show a new one on your computer\u0027);\n  }\n  if (remaining \u003e PAIRING_TTL_MS) {\n    // A far-future expiry is not what the gateway emits: the phone clock is wrong, and a\n    // pairing attempt would look valid long after the host dropped the code.\n    return reject(\u0027qr/expired\u0027, \u0027This code expires too far in the future; check your phone clock\u0027);\n  }\n\n  if (typeof obj.gatewayId !== \u0027string\u0027 || !GATEWAY_ID_RE.test(obj.gatewayId)) {\n    return reject(\u0027qr/bad-gateway-id\u0027, \u0027gatewayId must be a lowercase UUID v4\u0027);\n  }\n\n  if (typeof obj.gatewayName !== \u0027string\u0027 || obj.gatewayName.length === 0 || obj.gatewayName.length \u003e MAX_GATEWAY_NAME) {\n    return reject(\u0027qr/bad-host-name\u0027, \u0027gatewayName must be a non-empty string\u0027);\n  }\n\n  const value: PairingQr = {\n    version: PAIRING_QR_VERSION,\n    publicUrl: obj.publicUrl as string,\n    pairingCode: obj.pairingCode as string,\n    expiresAt: obj.expiresAt,\n    certSha256: obj.certSha256 as string,\n    gatewayId: obj.gatewayId,\n    gatewayName: obj.gatewayName,\n    endpoints: [...(obj.endpoints as string[])],\n  };\n  return { ok: true, value };\n}\n\n/** Throwing variant for call sites that already surface a typed error to the UI. */\nexport function parsePairingQrOrThrow(raw: string, options: ParseQrOptions = {}): PairingQr {\n  const result = parsePairingQr(raw, options);\n  if (result.ok) return result.value;\n  const err = new Error(result.message);\n  err.name = \u0027QrError\u0027;\n  (err as Error \u0026 { reason: QrRejectReason }).reason = result.reason;\n  throw err;\n}\n\n/** Milliseconds until `expiresAt` (negative when already expired). */\nexport function qrExpiresInMs(qr: Pick\u003cPairingQr, \u0027expiresAt\u0027\u003e, now: () =\u003e number = Date.now): number {\n  return qr.expiresAt - now();\n}\n\n/** Encode the contract payload back to QR text (tests and any local tooling). */\nexport function encodePairingPayload(payload: PairingQr): string {\n  return encodeBase64Url(decodeUtf8ToBytes(JSON.stringify(payload)));\n}\n\n/**\n * `wss://` only. Query strings and fragments are rejected outright because they are how tokens\n * leaked (`?token=`); the contract carries the code in a subprotocol, never the URL.\n */\nfunction checkWssUrl(value: unknown): string | null {\n  if (typeof value !== \u0027string\u0027 || value.length === 0) return \u0027missing\u0027;\n  let url: URL;\n  try {\n    url = new URL(value);\n  } catch {\n    return \u0027not a URL\u0027;\n  }\n  if (url.protocol !== \u0027wss:\u0027) return \u0027must use wss://\u0027;\n  if (url.username !== \u0027\u0027 || url.password !== \u0027\u0027) return \u0027must not embed credentials\u0027;\n  if (url.search !== \u0027\u0027) return \u0027must not carry a query string\u0027;\n  if (url.hash !== \u0027\u0027) return \u0027must not carry a fragment\u0027;\n  if (url.hostname === \u0027\u0027) return \u0027must name a host\u0027;\n  return null;\n}\n\nfunction checkEndpoints(value: unknown): string | null {\n  if (!Array.isArray(value) || value.length === 0) return \u0027endpoints must be a non-empty array\u0027;\n  if (value.length \u003e 16) return \u0027endpoints has too many entries\u0027;\n  for (const endpoint of value) {\n    const problem = checkWssUrl(endpoint);\n    if (problem !== null) return `endpoints entry: ${problem}`;\n  }\n  return null;\n}\n\n/**\n * Contract §2 `pairingCode` is 256 bits: canonical unpadded base64url of exactly 32 bytes. The\n * shape is pinned rather than \"any base64url\", so a short/over-long/foreign-alphabet code can\n * never be offered as `dsh-pair.\u003ccode\u003e`. `decodeBase64Url` also rejects non-zero trailing bits,\n * so two different strings cannot denote the same 32 bytes.\n */\nfunction isPairingCode(value: unknown): boolean {\n  if (typeof value !== \u0027string\u0027 || value.length !== PAIRING_CODE_LENGTH) return false;\n  if (!BASE64URL_RE.test(value)) return false;\n  const bytes = decodeBase64Url(value);\n  return bytes !== null \u0026\u0026 bytes.length === PAIRING_CODE_BYTES;\n}\n\n// ---------------------------------------------------------------------------\n// base64url (no Buffer / atob: identical in Hermes and Node)\n// ---------------------------------------------------------------------------\n\nconst ALPHABET = \u0027ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789-_\u0027;\nconst LOOKUP = new Int16Array(128).fill(-1);\nfor (let index = 0; index \u003c ALPHABET.length; index += 1) LOOKUP[ALPHABET.charCodeAt(index)] = index;\n\n/** Strict base64url decode: no padding, no other characters, non-zero trailing bits rejected. */\nexport function decodeBase64Url(text: string): Uint8Array | null {\n  if (text.length % 4 === 1) return null;\n  const bytes = new Uint8Array(Math.floor((text.length * 3) / 4));\n  let buffer = 0;\n  let bits = 0;\n  let written = 0;\n  for (let index = 0; index \u003c text.length; index += 1) {\n    const code = text.charCodeAt(index);\n    const value = code \u003c 128 ? LOOKUP[code] : -1;\n    if (value === undefined || value === -1) return null;\n    buffer = (buffer \u003c\u003c 6) | value;\n    bits += 6;\n    if (bits \u003e= 8) {\n      bits -= 8;\n      bytes[written] = (buffer \u003e\u003e bits) \u0026 0xff;\n      written += 1;\n    }\n  }\n  // Leftover bits must be zero, otherwise the encoding is not canonical.\n  if (bits \u003e 0 \u0026\u0026 (buffer \u0026 ((1 \u003c\u003c bits) - 1)) !== 0) return null;\n  return bytes.subarray(0, written);\n}\n\nexport function encodeBase64Url(bytes: Uint8Array): string {\n  let output = \u0027\u0027;\n  let buffer = 0;\n  let bits = 0;\n  for (const byte of bytes) {\n    buffer = (buffer \u003c\u003c 8) | byte;\n    bits += 8;\n    while (bits \u003e= 6) {\n      bits -= 6;\n      output += ALPHABET[(buffer \u003e\u003e bits) \u0026 0x3f];\n    }\n  }\n  if (bits \u003e 0) output += ALPHABET[(buffer \u003c\u003c (6 - bits)) \u0026 0x3f];\n  return output;\n}\n\n/** UTF-8 decode that throws on malformed input (TextDecoder is available in RN and Node). */\nfunction decodeUtf8(bytes: Uint8Array): string {\n  return new TextDecoder(\u0027utf-8\u0027, { fatal: true }).decode(bytes);\n}\n\nfunction decodeUtf8ToBytes(text: string): Uint8Array {\n  return new TextEncoder().encode(text);\n}\n\nfunction reject(reason: QrRejectReason, message: string): QrParseResult {\n  return { ok: false, reason, message };\n}"
const delay = (ms) => new Promise((resolve) => setTimeout(resolve, ms))

async function releasedParser(t) {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'dsh-spec050-parser-'))
  const file = path.join(directory, 'qr.mts')
  fs.writeFileSync(file, RELEASED_PARSER_SOURCE)
  t.after(() => fs.rmSync(directory, { recursive: true, force: true }))
  const module = await import(pathToFileURL(file).href)
  return module
}

async function factory(t) {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'dsh-spec050-gateway-'))
  let management
  let upgrade
  let dispose = () => {}
  const server = http.createServer((req, res) => {
    if (management && (req.url === management.path || req.url.startsWith(`${management.path}/`))) { management.handler(req, res); return }
    res.writeHead(404).end()
  })
  server.on('upgrade', (req, socket, head) => { if (upgrade) upgrade.handler(req, socket, head); else socket.destroy() })
  await listenFetchSafe(server)
  const port = server.address().port
  const ctx = {
    webServer: {
      port,
      register(route) { management = route; return () => { management = undefined } },
      registerUpgrade(route) { upgrade = route; return () => { upgrade = undefined } },
    },
    connection: createTestConnection(),
    remoteAccess: createTestRemoteAccess(),
    typertGateway: {
      async invoke() { return { items: [] } },
      async stream(request) {
        return (async function* () {
          yield { type: 'baseline', value: { items: [], archivedSessionIds: [], projections: {} } }
          while (!request.signal.aborted) await delay(10)
        })()
      },
    },
    agentDefaultModel: {},
    on() { return () => {} },
    effect(fn) { dispose = fn() },
  }
  await plugin.apply(ctx, {
    remoteControl: { enabled: true }, gatewayMode: 'persistent', gatewayWaitTimeoutMs: 60_000,
    gatewayName: `spec050-${port}`, deviceFile: path.join(directory, 'devices.json'),
    pairingTtlMs: 60_000,
    lanEnabled: true, lanHost: '127.0.0.1', lanPort: 0, ...{},
  })
  t.after(async () => {
    dispose()
    await new Promise((resolve) => server.close(resolve))
    fs.rmSync(directory, { recursive: true, force: true })
  })
  const instance = {
    port, base: `http://127.0.0.1:${port}`,
    async post(route, body) {
      const response = await fetch(`${instance.base}/mgw/${route}`, {
        method: 'POST', headers: { 'Content-Type': 'application/json', Origin: instance.base },
        body: JSON.stringify(body ?? {}),
      })
      return { status: response.status, data: await response.json() }
    },
    async get(route) {
      const response = await fetch(`${instance.base}/mgw/${route}`)
      return { status: response.status, data: await response.json() }
    },
  }
  for (let attempt = 0; attempt < 200; attempt += 1) {
    const status = (await instance.get('status')).data
    if (status.lan?.listening && status.lan.urls.length > 0) { instance.lanUrl = status.lan.urls[0]; instance.pin = status.lan.certSha256; return instance }
    if (status.lan?.error) throw new Error(`TLS listener failed: ${status.lan.error}`)
    await delay(20)
  }
  throw new Error('TLS listener did not become ready')
}

async function onePending(instance) {
  for (let attempt = 0; attempt < 200; attempt += 1) {
    const list = (await instance.get('pending')).data.pending
    if (list.length === 1) return list[0]
    await delay(10)
  }
  throw new Error('expected one pending request')
}

/**
 * Native-style first pairing over a PINNED TLS socket, with the long string code
 * (never an OTP). Mirrors test/client/pair.mjs's trustedPinOptions but keeps the
 * socket visible so the test can send the string-mode `pairing-proof` and wait
 * through the Host's pending approval. The pin checks are the exported helper's,
 * unchanged: a wrong pin aborts the TLS handshake before any frame is sent.
 */
async function openPinnedPairing(payload, deviceId) {
  const pin = pinnedTlsOptions(payload)
  const target = new URL(payload.publicUrl)
  const probe = tls.connect({
    host: target.hostname.replace(/^\[|\]$/g, ''), port: Number(target.port) || 443,
    servername: net.isIP(target.hostname) ? undefined : target.hostname, rejectUnauthorized: false,
  })
  await once(probe, 'secureConnect')
  const raw = probe.getPeerCertificate(true).raw
  probe.destroy()
  const mismatch = pin.__pinCheck(raw)
  if (mismatch) throw mismatch
  const options = { ...pin, rejectUnauthorized: true, ca: new crypto.X509Certificate(raw).toString() }
  const ws = new WebSocket(payload.publicUrl, ['dsh-mobile-v1', `dsh-pair.${payload.pairingCode}`], {
    ...options, headers: { 'X-DSH-Device-ID': deviceId }, origin: undefined,
  })
  const frames = []
  ws.on('message', (data) => { try { frames.push(JSON.parse(data.toString())) } catch { /* not json */ } })
  ws.on('error', () => {})
  await once(ws, 'open')
  const take = async (predicate, timeoutMs = 8_000) => {
    const deadline = Date.now() + timeoutMs
    while (Date.now() < deadline) {
      const found = frames.find(predicate)
      if (found) return found
      await delay(5)
    }
    throw new Error(`timed out waiting for a pairing frame (${frames.map((f) => f.kind).join(', ')})`)
  }
  const challenge = await take((frame) => frame.kind === 'pairing-challenge')
  assert.equal(challenge.otpRequired, false, 'a string offer needs no OTP')
  ws.send(JSON.stringify({ type: 'pairing-proof', clientNonce: crypto.randomBytes(18).toString('base64url') }))
  await take((frame) => frame.kind === 'pairing-pending')
  return { ws, frames, take, close() { try { ws.close() } catch { /* already closed */ } } }
}

test('spec050: a native mobile string offer is accepted by the released QR parser and pins through to a usable session without web:unlock', async (t) => {
  const instance = await factory(t)
  const parser = await releasedParser(t)
  assert.equal(parser.PARSER_COMMIT ?? PARSER_COMMIT, PARSER_COMMIT, 'the embedded parser is the build1 source')

  const nativeScopes = scopesForKind('mobile').filter((scope) => scope !== 'web:unlock')
  const created = await instance.post('pair', {
    mode: 'string', kind: 'mobile', scopes: nativeScopes, publicUrl: instance.lanUrl,
  })
  assert.equal(created.status, 201, JSON.stringify(created.data))
  assert.equal(created.data.pairing.kind, 'mobile', 'the offer is a mobile-kind string offer')
  assert.deepEqual(created.data.pairing.scopes, nativeScopes)
  assert.equal(created.data.pairing.scopes.includes('web:unlock'), false, 'a native offer never asks for web:unlock')
  assert.equal(created.data.pairingString, created.data.qrPayload, 'the copyable string is the QR payload')

  // Decode with the RELEASED parser. Only field names/booleans are asserted: no payload is logged.
  const parsed = parser.parsePairingQr(created.data.qrPayload)
  assert.equal(parsed.ok, true, `released parser rejected the native QR: ${parsed.reason ?? ''}`)
  assert.equal(parsed.value.version, 3)
  assert.equal(parsed.value.certSha256, instance.pin, 'the pin is this Host certificate')
  assert.equal(parsed.value.pairingCode, created.data.payload.pairingCode)
  assert.ok(parsed.value.publicUrl.startsWith('wss://'))
  assert.ok(parsed.value.endpoints.length > 0 && parsed.value.endpoints.every((url) => url.startsWith('wss://')))
  // No weakened trust checks: the parser checks SHAPE; pin EQUALITY is enforced by
  // the pinned TLS handshake before any pairing frame is sent. A wrong pin must fail there.
  const wrongPin = { ...parsed.value, certSha256: '0'.repeat(64) }
  await assert.rejects(openPinnedPairing(wrongPin, 'spec050-0000-4000-8000-000000000000'), /certificate pin mismatch/,
    'a different certificate never reaches the pairing upgrade')

  // Pair over pinned TLS with the STRING code (not an OTP), then wait for Host approval.
  const deviceId = 'spec050-0000-4000-8000-000000000001'
  const session = await openPinnedPairing(parsed.value, deviceId)
  t.after(() => session.close())
  const request = await onePending(instance)
  assert.equal(request.kind, 'mobile')
  assert.deepEqual(request.requestedScopes, nativeScopes)
  const widened = await instance.post(`pending/${request.id}/approve`, { scopes: [...nativeScopes, 'web:unlock'] })
  assert.equal(widened.status, 400, 'approval cannot re-add web:unlock to a native offer')
  assert.equal((await instance.get('pending')).data.pending.length, 1, 'the request is still live')

  const approvedScopes = nativeScopes.filter((scope) => scope === 'sessions:read' || scope === 'prompt:send')
  const approved = await instance.post(`pending/${request.id}/approve`, { scopes: approvedScopes })
  assert.equal(approved.status, 200, JSON.stringify(approved.data))
  assert.deepEqual(approved.data.device.scopes, approvedScopes)
  assert.equal(approved.data.device.scopes.includes('web:unlock'), false)

  const paired = await session.take((frame) => frame.kind === 'paired' && typeof frame.token === 'string')
  assert.deepEqual(paired.device.scopes, approvedScopes)
  assert.equal(paired.device.scopes.includes('web:unlock'), false, 'the paired frame agrees')
  const pairingHello = await session.take((frame) => frame.kind === 'hello')
  assert.equal(pairingHello.webLock, undefined, 'a native grant arms no web lock')
  const [device] = (await instance.get('devices')).data.devices
  assert.deepEqual(device.scopes, approvedScopes)
  assert.equal(device.scopes.includes('web:unlock'), false)

  // A token-authenticated pinned connection performs a real session read: no auth/locked.
  const authenticated = await connect({ payload: parsed.value, token: paired.token, deviceId })
  t.after(() => authenticated.close())
  assert.equal(authenticated.hello.webLock, undefined, 'the authenticated socket is not locked')
  const reply = await authenticated.request({ type: 'sessions', requestId: 'spec050-sessions' })
  assert.equal(reply.kind, 'sessions', 'session read is served, not refused with auth/locked')
})