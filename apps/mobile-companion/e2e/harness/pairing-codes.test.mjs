// Accepted pairing codes of the fixture gateway: what the payload advertises must be what the
// upgrade takes.
//
// WHY this file exists (MEASURED BUG): `rotatePairingCode()` minted a fresh code, put it in
// `pairingCodes` and returned a payload for it, but the payload the fixture ADVERTISED at startup
// was built once, for `--fixed-pairing-code`. `/pairing/new` therefore handed out a payload for one
// code while the operator's own code was the only one the fixture had been primed with — and after
// any rotate the printed payload was the one thing that could not pair. A capture run that fetches
// `/pairing/new` and pastes the answer was the case that broke.
//
// The rule these tests pin down:
//   * `--fixed-pairing-code` is always accepted (it is the operator's code) and is what the payload
//     advertises — a rotate re-advertises it with a fresh `expiresAt` rather than advertising a
//     second code the operator never sees;
//   * every code `/pairing/new` mints is accepted until its own expiry, and the payload's
//     `expiresAt` IS that expiry;
//   * a rotate never invalidates a code it did not mint, and never one it just issued;
//   * a code is consumed at most once — the proof takes it, and `consumedPairingCodes` names it
//     exactly once — so a consumed code is a 401 at the upgrade, never a second pairing;
//   * a code past its own expiry is refused at the upgrade.
//
// These drive the real fixture over real TLS as a raw `ws` client (the same shape the app's native
// transport produces: subprotocols `dsh-mobile-v1, dsh-pair.<code>` + `X-DSH-Device-ID`), because
// the property under test is the fixture's own accept/refuse decision.
//
//   node --test e2e/harness/pairing-codes.test.mjs

import assert from 'node:assert/strict'
import { spawn } from 'node:child_process'
import { once } from 'node:events'
import crypto from 'node:crypto'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { test } from 'node:test'

import WebSocket from 'ws'

const here = path.dirname(fileURLToPath(import.meta.url))
const gatewayEntry = path.join(here, 'gateway.mjs')

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms))

// ---------------------------------------------------------------------------
// Fixture lifecycle
// ---------------------------------------------------------------------------

/**
 * Start the fixture on two ephemeral loopback ports and return its startup block plus helpers.
 *
 * `--ttl-ms` lets the expiry case use a real TTL instead of waiting four minutes: the advertised
 * `expiresAt` is then a second away and the refusal is the fixture's own clock check, not a
 * simulated one.
 */
async function startFixture (extraArgs = []) {
  const child = spawn(process.execPath, [
    gatewayEntry,
    '--bind', '127.0.0.1',
    '--lan-host', '127.0.0.1',
    '--port', '0',
    '--control-port', '0',
    '--print-json',
    '--quiet',
    ...extraArgs,
  ], { stdio: ['ignore', 'pipe', 'pipe'] })

  let stdout = ''
  let stderr = ''
  child.stdout.on('data', (chunk) => { stdout += chunk.toString() })
  child.stderr.on('data', (chunk) => { stderr += chunk.toString() })

  const deadline = Date.now() + 30_000
  while (Date.now() < deadline) {
    const text = stdout.trim()
    if (text !== '') {
      try {
        const state = JSON.parse(text.split('\n').filter(Boolean).at(-1))
        return {
          state,
          stderrText: () => stderr,
          async control (route, body) {
            const response = await fetch(`${state.controlUrl}${route}`, {
              method: 'POST',
              headers: { 'content-type': 'application/json', 'x-fixture-token': state.controlToken },
              body: JSON.stringify(body ?? {}),
            })
            const payload = await response.json()
            if (!response.ok) throw new Error(`control ${route}: ${response.status} ${JSON.stringify(payload)}`)
            return payload
          },
          async readState () {
            return (await fetch(`${state.controlUrl}/state`)).json()
          },
          async stop () {
            child.kill()
            await once(child, 'exit').catch(() => {})
          },
        }
      } catch {
        // still streaming
      }
    }
    if (child.exitCode !== null) throw new Error(`fixture exited:\n${stderr}`)
    await sleep(50)
  }
  child.kill()
  throw new Error(`fixture did not start:\n${stderr}`)
}

// ---------------------------------------------------------------------------
// A raw pairing client (what `modules/pinned-ws` sends)
// ---------------------------------------------------------------------------

async function attachInbox (socket) {
  const inbox = []
  socket.inbox = inbox
  socket.on('message', (data) => {
    try {
      inbox.push(JSON.parse(data.toString()))
    } catch {
      inbox.push({ kind: 'unparseable' })
    }
  })
  return socket
}

function framesOf (socket) {
  return socket.inbox.map((frame) => frame.kind)
}

async function waitForFrame (socket, predicate, timeoutMs = 5_000) {
  const found = socket.inbox.find(predicate)
  if (found !== undefined) return found
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => {
      socket.off('message', onMessage)
      reject(new Error(`timed out waiting for a frame (saw ${socket.inbox.map((frame) => frame.kind).join(',')})`))
    }, timeoutMs)
    const onMessage = (data) => {
      const frame = JSON.parse(data.toString())
      if (!predicate(frame)) return
      clearTimeout(timer)
      socket.off('message', onMessage)
      resolve(frame)
    }
    socket.on('message', onMessage)
  })
}

/**
 * Open the upgrade with a pairing code.
 *
 * Resolves with `{ socket }` when the upgrade is accepted, or `{ refused: status }` when the fixture
 * answered 401/403 — the distinction the contract makes between "a pairing socket" and "nothing was
 * sent" (contract §3, §3.8).
 */
async function openPairing (state, code) {
  const socket = new WebSocket(state.endpoint, ['dsh-mobile-v1', `dsh-pair.${code}`], {
    rejectUnauthorized: false,
    headers: { 'X-DSH-Device-ID': crypto.randomUUID().toLowerCase() },
    handshakeTimeout: 10_000,
  })
  attachInbox(socket)
  return new Promise((resolve, reject) => {
    socket.once('open', () => resolve({ socket }))
    socket.once('unexpected-response', (_request, response) => {
      socket.terminate()
      resolve({ refused: response.statusCode })
    })
    socket.once('error', (error) => reject(error))
  })
}

/** Answer the challenge the way the app does, and wait for the `paired` the fixture auto-approves. */
async function pairThrough (state, code, { approval = false } = {}) {
  if (approval) await control(state, '/scenario/pairing/require-approval', { enabled: true })
  const attempt = await openPairing(state, code)
  assert.ok('socket' in attempt, `expected an accepted upgrade for ${code.slice(0, 8)}…, got ${JSON.stringify(attempt)}`)
  const { socket } = attempt
  const challenge = await waitForFrame(socket, (frame) => frame.kind === 'pairing-challenge')
  assert.match(challenge.serverNonce, /^[A-Za-z0-9_-]{16,64}$/)
  socket.send(JSON.stringify({ type: 'pairing-proof', clientNonce: crypto.randomBytes(24).toString('base64url') }))
  await waitForFrame(socket, (frame) => frame.kind === 'pairing-pending')
  if (approval) await control(state, '/scenario/pairing/approve')
  const paired = await waitForFrame(socket, (frame) => frame.kind === 'paired' || frame.kind === 'pairing-rejected')
  assert.equal(paired.kind, 'paired', JSON.stringify(paired))
  const hello = await waitForFrame(socket, (frame) => frame.kind === 'hello')
  assert.equal(hello.authenticated, true)
  return { socket, token: paired.token }
}

async function control (state, route, body) {
  const response = await fetch(`${state.controlUrl}${route}`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', 'x-fixture-token': state.controlToken },
    body: JSON.stringify(body ?? {}),
  })
  const payload = await response.json()
  if (!response.ok) throw new Error(`control ${route}: ${response.status} ${JSON.stringify(payload)}`)
  return payload
}

// `openPairing` takes the live state object; the fixture helper wraps the control routes.
async function withFixture (extraArgs, run) {
  const fixture = await startFixture(extraArgs)
  try {
    await run(fixture.state, fixture)
  } finally {
    await fixture.stop()
  }
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

test('a payload from /pairing/new pairs end to end, with evidence for exactly that code', async () => {
  await withFixture([], async (state, fixture) => {
    const minted = await control(state, '/pairing/new')
    // `state` is the startup block; the advertised offer after the rotate is read live.
    const advertised = (await fixture.readState()).pairing
    assert.equal(advertised.pairingCode, minted.pairingCode, 'the payload names the code it advertises')
    assert.equal(minted.expiresAt, advertised.expiresAt, 'the advertised expiry is that code\'s expiry')
    assert.ok(minted.expiresAt > Date.now(), 'the payload expiry is in the future')

    // Decode the exact text an operator pastes and pair with THAT code, not with the variable.
    const payload = JSON.parse(Buffer.from(minted.qr, 'base64url').toString('utf8'))
    assert.equal(payload.version, 3)
    assert.equal(payload.pairingCode, minted.pairingCode)
    assert.equal(payload.expiresAt, minted.expiresAt)

    const { socket } = await pairThrough(state, payload.pairingCode)
    const after = await fixture.readState()
    assert.deepEqual(after.evidence.consumedPairingCodes, [payload.pairingCode], 'the pasted code is the consumed one')
    assert.ok(after.evidence.offeredPairingCodes.includes(payload.pairingCode))
    assert.equal(after.evidence.upgradeRefusals.length, 0, 'no refused upgrade for a freshly minted payload')
    socket.close(1000, 'done')
  })
})

test('a consumed code cannot be reused (401 at the upgrade, consumed once)', async () => {
  await withFixture([], async (state, fixture) => {
    const minted = await control(state, '/pairing/new')
    const { socket } = await pairThrough(state, minted.pairingCode)
    socket.close(1000, 'done')

    const replay = await openPairing(state, minted.pairingCode)
    assert.deepEqual(replay, { refused: 401 }, 'a used code is an upgrade refusal, never a socket')
    const after = await fixture.readState()
    assert.deepEqual(after.evidence.consumedPairingCodes, [minted.pairingCode], 'at most once')
    assert.deepEqual(after.evidence.offeredPairingCodes.filter((code) => code === minted.pairingCode), [minted.pairingCode])
    const pairingRefusals = after.evidence.upgradeRefusals.filter((refusal) => refusal.reason === 'pairing/expired')
    assert.equal(pairingRefusals.length, 1, JSON.stringify(after.evidence.upgradeRefusals))
  })
})

test('--fixed-pairing-code pairs without calling /pairing/new, and survives a rotate', async () => {
  const fixed = crypto.randomBytes(32).toString('base64url')
  await withFixture(['--fixed-pairing-code', fixed], async (state, fixture) => {
    // The startup advertisement IS the operator's code: one payload, no second secret code.
    assert.equal(state.pairing.payload.pairingCode, fixed)
    assert.equal(state.pairing.pairingCode, fixed)

    // (c) no control call at all: the code from the CLI flag is what pairs.
    const first = await pairThrough(state, fixed)
    first.socket.close(1000, 'done')

    // A rotate re-advertises the operator's code (fresh expiry) and keeps a code it did not mint
    // accepted; it must not advertise a code that the fixture would refuse.
    const minted = await fixture.control('/pairing/new')
    assert.equal(minted.pairingCode, fixed, 'the advertised code stays the operator\'s code')
    assert.equal(JSON.parse(Buffer.from(minted.qr, 'base64url').toString('utf8')).pairingCode, fixed)
    const rotated = await fixture.readState()
    assert.equal(rotated.pairing.pairingCode, fixed)
    assert.ok(rotated.pairing.accepted.some((entry) => entry.code === fixed))
  })
})

test('an expired code is refused at the upgrade', async () => {
  // A real 150 ms TTL: the advertised `expiresAt` is a fraction of a second ahead, so the refusal
  // comes from the fixture's own expiry check rather than from a patched value.
  await withFixture(['--ttl-ms', '150', '--fixed-pairing-code', crypto.randomBytes(32).toString('base64url')], async (state) => {
    const code = state.pairing.pairingCode
    assert.ok(state.pairing.expiresAt <= Date.now() + 1_000, `ttl was not applied: ${state.pairing.expiresAt - Date.now()} ms`)
    await sleep(400)
    const attempt = await openPairing(state, code)
    assert.deepEqual(attempt, { refused: 401 }, 'an expired code is a 401, not a pairing socket')
    const after = await (await fetch(`${state.controlUrl}/state`)).json()
    assert.deepEqual(after.evidence.consumedPairingCodes, [], 'an expired code is never consumed')
    assert.ok(after.evidence.upgradeRefusals.some((refusal) => refusal.reason === 'pairing/expired'))
  })
})
