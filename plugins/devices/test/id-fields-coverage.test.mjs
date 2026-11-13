// Roadmap P1-5: ID_FIELDS (lib/host-router.mjs) must cover every id-bearing field
// that appears in the known remote payload fixtures. The fixtures are the payload
// literals the devices suite feeds the router plus the gateway's transport-v1 frames.
// Every key ending in `Id`/`Ids` (or named `id`) is either renamed by ID_FIELDS or
// listed below as deliberately opaque, with a reason. A new key fails the test until
// someone decides which side it belongs on.
import test from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { ID_FIELDS } from '../lib/host-router.mjs'

const here = path.dirname(fileURLToPath(import.meta.url))
const gatewayFrames = path.join(here, '..', '..', 'mobile-gateway', 'test', 'fixtures', 'transport-v1', 'frames.json')

/** Id-shaped keys that are intentionally NOT rewritten, with the reason. */
const OPAQUE = Object.freeze({
  id: 'generic record key; session records are handled via items:id / id@version',
  hostId: 'names the Host itself (the namespace), never a remote-scoped id',
  gatewayId: 'local Devices store key for a saved gateway',
  remoteId: 'local Devices store bookkeeping',
  clientId: 'transport client identity, not a DSH entity',
  clientDeviceId: 'pairing device identity, local to the gateway',
  clientMsgId: 'client-generated message correlation, echoed verbatim',
  callId: 'opaque tool-call id (see ID_FIELDS doc comment)',
  attachmentId: 'opaque (see ID_FIELDS doc comment)',
  uploadId: 'upload handle scoped to the routed request',
  commandId: 'opaque command correlation',
  requestId: 'opaque request correlation',
  receiptId: 'opaque receipt correlation',
  providerId: 'model provider name, handled by shape outside ID_FIELDS',
})

const ID_KEY = /^(?:id|[A-Za-z]+Ids?)$/

function keysFromJson(value, out) {
  if (Array.isArray(value)) value.forEach((v) => keysFromJson(v, out))
  else if (value && typeof value === 'object') {
    for (const [k, v] of Object.entries(value)) {
      if (ID_KEY.test(k)) out.add(k)
      keysFromJson(v, out)
    }
  }
}

function collectKeys() {
  const keys = new Set()
  for (const name of fs.readdirSync(here)) {
    if (!name.endsWith('.test.mjs') || name === path.basename(fileURLToPath(import.meta.url))) continue
    const src = fs.readFileSync(path.join(here, name), 'utf8')
    for (const m of src.matchAll(/[{,]\s*['"]?([A-Za-z]+Ids?|id)['"]?\s*:/g)) keys.add(m[1])
  }
  if (fs.existsSync(gatewayFrames)) keysFromJson(JSON.parse(fs.readFileSync(gatewayFrames, 'utf8')), keys)
  return keys
}

test('every id-bearing fixture field is covered by ID_FIELDS or declared opaque', () => {
  const keys = collectKeys()
  assert.ok(keys.has('sessionId'), 'fixture scan found sessionId (scanner sanity)')
  const unknown = [...keys].filter((k) => !(k in ID_FIELDS) && !(k in OPAQUE)).sort()
  assert.deepEqual(unknown, [], `unclassified id fields: ${unknown.join(', ')} — add to ID_FIELDS (lib) or OPAQUE (here)`)
})

test('ID_FIELDS and OPAQUE do not overlap', () => {
  const both = Object.keys(OPAQUE).filter((k) => k in ID_FIELDS)
  assert.deepEqual(both, [])
})
