// Spec 025 R1-R3 — owner-side scope update for a paired device.
//
// Scopes used to be fixed at pairing, so a record paired before spec 013 could never gain
// `attachments:write` without re-pairing. This module validates one `{ add, remove }` request against
// the SAME contract tables the pairing path uses, applies it atomically and reports what changed.
// It owns no sockets and no persistence: `index.mjs` hands it the registry record and the store
// writer, and decides what to do with live sockets (spec 025 R3 asks for the revoke close code).
//
// Nothing here writes a log line or an error message that carries a credential: a device id and
// scope NAMES only, all of which the owner already sees on the Devices page.

import {
  SCOPES as CONTRACT_SCOPES, DESKTOP_ONLY_SCOPES, WEB_UNLOCK_SCOPE,
} from './vendor/mobile-protocol.mjs'

/**
 * The scopes a record of this kind may hold. The same rule `lib/devices.js` loads a record with:
 * a desktop-only scope survives only on a `desktop`. Exported so the Devices page and the tests
 * read one list instead of restating it.
 */
export function scopesForKind(kind) {
  return CONTRACT_SCOPES.filter((scope) => !DESKTOP_ONLY_SCOPES.includes(scope) || kind === 'desktop')
}

/** `web:unlock` is deliberately unreachable here: the passkey flow owns granting and revoking it. */
export const UNSETTABLE_SCOPES = Object.freeze([WEB_UNLOCK_SCOPE])

function badRequest(message, code = 'bad-request') {
  const error = new Error(message)
  error.status = 400
  error.code = code
  return error
}

/**
 * Validate a request body against one device record. Pure: it computes the next scope list and
 * throws before anything is written, so a refused request leaves the record untouched (R2).
 *
 * @param {{ body: unknown, device: { id: string, kind?: string, scopes?: string[] } }} input
 * @returns {{ added: string[], removed: string[], scopes: string[], scopesChanged: boolean }}
 */
export function planScopeUpdate({ body, device }) {
  if (!body || typeof body !== 'object' || Array.isArray(body)) {
    throw badRequest('body must be an object with add and/or remove arrays')
  }
  const { add, remove } = body
  for (const [label, value] of [['add', add], ['remove', remove]]) {
    if (value === undefined) continue
    if (!Array.isArray(value)) throw badRequest(`${label} must be an array of scope names`)
    if (value.some((scope) => typeof scope !== 'string')) throw badRequest(`${label} must be an array of scope names`)
  }
  if (add === undefined && remove === undefined) throw badRequest('name at least one of add or remove')
  const adding = [...new Set(add ?? [])]
  const removing = [...new Set(remove ?? [])]
  // R2: an unknown name is a caller error, not something to skip silently — a typo must not look
  // like a successful update. Checked before the kind rule so the message names the real problem.
  for (const scope of [...adding, ...removing]) {
    if (!CONTRACT_SCOPES.includes(scope)) throw badRequest(`unknown scope: ${scope}`, 'unknown-scope')
  }
  // R2: `web:unlock` never moves here, in either direction.
  for (const scope of [...adding, ...removing]) {
    if (UNSETTABLE_SCOPES.includes(scope)) {
      throw badRequest(`${scope} cannot be changed here; the passkey flow owns it`, 'scope-not-updatable')
    }
  }
  const allowed = scopesForKind(device && device.kind)
  for (const scope of adding) {
    if (!allowed.includes(scope)) throw badRequest(`scope ${scope} is not available for a ${device.kind} device`, 'scope-not-for-kind')
  }
  const current = Array.isArray(device && device.scopes) ? device.scopes : []
  const next = []
  // Contract order, like every other grant in this package: the record's own order is not authority.
  for (const scope of CONTRACT_SCOPES) {
    const held = current.includes(scope)
    const wanted = adding.includes(scope) ? true : (removing.includes(scope) ? false : held)
    if (wanted && allowed.includes(scope)) next.push(scope)
  }
  const added = next.filter((scope) => !current.includes(scope))
  const removed = current.filter((scope) => !next.includes(scope))
  return { added, removed, scopes: next, scopesChanged: added.length > 0 || removed.length > 0 }
}
