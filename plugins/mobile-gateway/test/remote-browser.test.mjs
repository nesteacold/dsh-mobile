// Spec 016 Phase 3 / spec 014 C6 — the host→client browser channel and the driver record.
//
// The service is the only place that decides whether a `browser-command` may reach a
// machine, so every refusal path and every "takes effect immediately" rule is pinned
// here: one command per device, the scope, the capability, the deadline, the cancel, and
// the revocation that must kill a command already in flight.
import assert from 'node:assert/strict'
import { test } from 'node:test'

import * as contract from '../lib/vendor/mobile-protocol.mjs'
import {
  HOST_TARGET,
  REMOTE_BROWSER_SERVICE,
  REMOTE_SESSION_SCOPE_SERVICE,
  createRemoteBrowser,
  createSessionDriver,
  provideHostService,
  sessionIdOf,
} from '../lib/remote-browser.mjs'

// ---------------------------------------------------------------------------
// Fixtures
// ---------------------------------------------------------------------------

/** A registry stub: `get` sees live records, `list` sees the active ones. */
function fakeRegistry(seed = {}) {
  const devices = new Map(Object.entries(seed))
  return {
    devices,
    get: (id) => devices.get(id),
    list: () => [...devices.values()].filter((device) => !device.revokedAt),
    add(id, overrides = {}) {
      const device = { id, name: id, scopes: ['browser:control'], revokedAt: undefined, ...overrides }
      devices.set(id, device)
      return device
    },
  }
}

/** A connection stub that records what the host sent. */
function fakeClient(deviceId, { capabilities, readyState = 1 } = {}) {
  const sent = []
  return {
    deviceId,
    readyState,
    clientHello: capabilities === undefined ? {} : { capabilities },
    sent,
    sendFrame(frame) { sent.push(frame) },
    send(wire) { sent.push(JSON.parse(wire)) },
    get commands() { return sent.filter((frame) => frame.kind === 'browser-command') },
    get cancels() { return sent.filter((frame) => frame.kind === 'browser-cancel') },
  }
}

/** Manual timers, so a deadline is a call away instead of a wall-clock wait. */
function fakeTimers() {
  let nextId = 0
  const pending = new Map()
  return {
    setTimer(fn) {
      const id = ++nextId
      pending.set(id, fn)
      return { id, unref() {} }
    },
    clearTimer(timer) { if (timer) pending.delete(timer.id) },
    fireAll() {
      const due = [...pending.entries()]
      pending.clear()
      for (const [, fn] of due) fn()
    },
    get size() { return pending.size },
  }
}

function makeService(seed = {}, options = {}) {
  const registry = fakeRegistry(seed)
  const timers = options.timers ?? fakeTimers()
  const logs = []
  const driver = createSessionDriver({ getDevice: registry.get, now: options.now })
  const clients = new Set()
  const service = createRemoteBrowser({
    getDevice: registry.get,
    listDevices: registry.list,
    listClients: () => clients,
    sessionDriver: driver,
    log: (line) => logs.push(line),
    setTimer: timers.setTimer,
    clearTimer: timers.clearTimer,
  })
  return { registry, timers, logs, driver, clients, service }
}

const CAPABLE = { capabilities: ['browser-agent:1'] }

/** Give the promise machinery a turn without waiting on a real timer. */
const tick = () => new Promise((resolve) => setImmediate(resolve))

// ---------------------------------------------------------------------------
// sessionIdOf / the driver record
// ---------------------------------------------------------------------------

test('sessionIdOf reads a DSH session, a row, a bare id, or nothing', () => {
  assert.equal(sessionIdOf({ id: 's1' }), 's1')
  assert.equal(sessionIdOf({ sessionId: ' s2 ' }), 's2')
  assert.equal(sessionIdOf({ header: { id: 's3' } }), 's3')
  assert.equal(sessionIdOf(' s4 '), 's4')
  assert.equal(sessionIdOf({}), undefined)
  assert.equal(sessionIdOf('   '), undefined)
  assert.equal(sessionIdOf(null), undefined)
  assert.equal(sessionIdOf(42), undefined)
})

test('a device prompt makes the session remote, with that device scopes', () => {
  const { registry, driver } = makeService()
  registry.add('dev-1', { scopes: ['sessions:read', 'browser:control'] })
  assert.equal(driver.noteDevicePrompt('s1', 'dev-1'), true)
  assert.deepEqual(driver.describe({ id: 's1' }),
    { driven: 'remote', deviceId: 'dev-1', scopes: ['sessions:read', 'browser:control'] })
})

test('a local prompt makes the session local', () => {
  const { driver } = makeService()
  driver.noteLocalPrompt('s1')
  assert.deepEqual(driver.describe({ id: 's1' }), { driven: 'local' })
  // The `user/message` event path says the same thing.
  driver.noteUserMessage('s2')
  assert.deepEqual(driver.describe({ id: 's2' }), { driven: 'local' })
})

test('the user/message caused by a device prompt keeps the device attribution', () => {
  const { registry, driver } = makeService()
  registry.add('dev-1')
  driver.noteDevicePrompt('s1', 'dev-1')
  // The prompt surfaces as an event: it belongs to the device, not to the local owner.
  driver.noteUserMessage('s1')
  assert.equal(driver.describe({ id: 's1' }).driven, 'remote')
  assert.equal(driver.describe({ id: 's1' }).deviceId, 'dev-1')
  // A SECOND event with nothing outstanding is a local prompt again.
  driver.noteUserMessage('s1')
  assert.deepEqual(driver.describe({ id: 's1' }), { driven: 'local' })
})

test('an unknown session is remote with no scopes — C6 fails closed', () => {
  const { driver } = makeService()
  assert.deepEqual(driver.describe({ id: 'never-seen' }), { driven: 'remote' })
  // Undeterminable (no id at all) is the same answer, never "local".
  assert.deepEqual(driver.describe({}), { driven: 'remote' })
  assert.deepEqual(driver.describe(undefined), { driven: 'remote' })
})

test('a frame without a sessionId records nothing', () => {
  const { registry, driver } = makeService()
  registry.add('dev-1')
  assert.equal(driver.noteDevicePrompt('', 'dev-1'), false)
  assert.equal(driver.noteDevicePrompt(undefined, 'dev-1'), false)
  assert.equal(driver.size, 0)
})

test('a revoked device never becomes the driver', () => {
  const { registry, driver } = makeService()
  const device = registry.add('dev-1')
  driver.noteDevicePrompt('s1', 'dev-1')
  device.revokedAt = Date.now()
  // The record is gone with the credential: remote, but holding no scopes.
  assert.deepEqual(driver.describe({ id: 's1' }), { driven: 'remote', deviceId: 'dev-1', scopes: [] })
  // And a NEW prompt from that device is refused outright.
  assert.equal(driver.noteDevicePrompt('s2', 'dev-1'), false)
  assert.equal(driver.size, 1)
})

test('a record older than the TTL stops naming a driver', () => {
  let clock = 1_000
  const { registry, driver } = makeService({}, { now: () => clock })
  registry.add('dev-1')
  driver.noteDevicePrompt('s1', 'dev-1')
  clock += 13 * 60 * 60 * 1000
  assert.deepEqual(driver.describe({ id: 's1' }), { driven: 'remote' })
})

test('the recorded descriptor carries deviceId and the live scopes', () => {
  const { registry, driver } = makeService()
  registry.add('dev-9', { scopes: ['prompt:send'] })
  driver.noteDevicePrompt('s1', 'dev-9')
  const described = driver.describe('s1')
  assert.equal(described.driven, 'remote')
  assert.equal(described.deviceId, 'dev-9')
  // No browser:control: the sidebar browser reads this and refuses (spec 014 C6).
  assert.deepEqual(described.scopes, ['prompt:send'])
})

// ---------------------------------------------------------------------------
// targets()
// ---------------------------------------------------------------------------

test('targets always offers the host first, then every device with its flags', () => {
  const { registry, clients, service } = makeService()
  registry.add('dev-1')
  registry.add('dev-2', { scopes: [] })
  const capable = fakeClient('dev-1', CAPABLE)
  clients.add(capable)
  clients.add(fakeClient('dev-2', { readyState: 3 })) // closed socket: not connected

  const rows = service.targets('s1')
  assert.deepEqual(rows[0], { id: HOST_TARGET, name: 'This machine', connected: true, capable: true, granted: true })
  const byId = Object.fromEntries(rows.slice(1).map((row) => [row.id, row]))
  assert.deepEqual(byId['dev-1'], { id: 'dev-1', name: 'dev-1', connected: true, capable: true, granted: true })
  assert.deepEqual(byId['dev-2'], { id: 'dev-2', name: 'dev-2', connected: false, capable: false, granted: false })
})

test('targets lists the auto candidate first', () => {
  const { registry, clients, driver, service } = makeService()
  registry.add('dev-1')
  registry.add('dev-2')
  clients.add(fakeClient('dev-1', CAPABLE))
  clients.add(fakeClient('dev-2', CAPABLE))
  driver.noteDevicePrompt('s1', 'dev-2')
  const rows = service.targets('s1')
  assert.equal(rows[1].id, 'dev-2', 'the device that prompted the session is the auto candidate')
  assert.equal(rows[2].id, 'dev-1')
})

// ---------------------------------------------------------------------------
// send() — the refusal matrix
// ---------------------------------------------------------------------------

test('the host target is not served over the gateway', async () => {
  const { service } = makeService()
  const result = await service.send('host', 's1', 'screenshot', {})
  assert.equal(result.ok, false)
  assert.equal(result.error.code, 'browser/not-supported')
})

test('an unknown or revoked device is refused', async () => {
  const { registry, service } = makeService()
  registry.add('dev-1')
  registry.get('dev-1').revokedAt = Date.now()
  const result = await service.send('dev-1', 's1', 'screenshot', {})
  assert.equal(result.ok, false)
  assert.equal(result.error.code, 'browser/unknown-target')
})

test('a device without the capability advertises no browser', async () => {
  const { registry, clients, service } = makeService()
  registry.add('dev-1')
  clients.add(fakeClient('dev-1')) // no capabilities array
  const result = await service.send('dev-1', 's1', 'screenshot', {})
  assert.equal(result.ok, false)
  assert.equal(result.error.code, 'browser/not-supported')
})

test('an offline device is refused before any frame is built', async () => {
  const { registry, service } = makeService()
  registry.add('dev-1')
  const result = await service.send('dev-1', 's1', 'screenshot', {})
  assert.equal(result.ok, false)
  assert.equal(result.error.code, 'browser/offline')
})

test('a device without browser:control is refused and told nothing', async () => {
  const { registry, clients, service } = makeService()
  registry.add('dev-1', { scopes: ['sessions:read'] })
  const client = fakeClient('dev-1', CAPABLE)
  clients.add(client)
  const result = await service.send('dev-1', 's1', 'screenshot', {})
  assert.equal(result.ok, false)
  assert.equal(result.error.code, 'browser/forbidden-scope')
  assert.equal(client.sent.length, 0, 'no frame reaches a device that may not be driven')
})

test('one command in flight per device: the second is busy', async () => {
  const { registry, clients, service } = makeService()
  registry.add('dev-1')
  clients.add(fakeClient('dev-1', CAPABLE))
  const first = service.send('dev-1', 's1', 'screenshot', {})
  const second = await service.send('dev-1', 's1', 'text', {})
  assert.equal(second.ok, false)
  assert.equal(second.error.code, 'browser/busy')
  // A different device is unaffected.
  registry.add('dev-2')
  clients.add(fakeClient('dev-2', CAPABLE))
  const other = service.send('dev-2', 's1', 'text', {})
  assert.equal(service.inFlight, 2)
  // Settle both so the test leaves nothing pending.
  for (const client of clients) {
    const command = client.commands[0]
    service.handleClientFrame(client, { type: 'browser-result', commandId: command.commandId, ok: true, result: {} })
  }
  await Promise.all([first, other])
  assert.equal(service.inFlight, 0)
})

test('malformed arguments never reach a device', async () => {
  const { service } = makeService()
  for (const [op, args, session] of [['eval', {}, 's1'], ['screenshot', 'text', 's1'], ['', {}, 's1'], ['screenshot', {}, '']]) {
    const result = await service.send('dev-1', session, op, args)
    assert.equal(result.ok, false)
    assert.equal(result.error.code, 'browser/bad-request', `${op}/${JSON.stringify(args)}`)
  }
})

test('a command whose frame exceeds 1 MiB is refused as frame-too-large', async () => {
  const { registry, clients, service } = makeService()
  registry.add('dev-1')
  const client = fakeClient('dev-1', CAPABLE)
  clients.add(client)
  const result = await service.send('dev-1', 's1', 'type', { text: 'x'.repeat(contract.BROWSER_FRAME_MAX_BYTES) })
  assert.equal(result.ok, false)
  assert.equal(result.error.code, 'browser/frame-too-large')
  assert.equal(client.sent.length, 0)
})

// ---------------------------------------------------------------------------
// send() — the happy path and the settle rules
// ---------------------------------------------------------------------------

test('a command is sent with the contract shape and its result comes back', async () => {
  const { registry, clients, service } = makeService()
  registry.add('dev-1')
  const client = fakeClient('dev-1', CAPABLE)
  clients.add(client)
  const pending = service.send('dev-1', 's1', 'text', { selector: 'main' })
  await tick()

  const [frame] = client.commands
  assert.equal(client.commands.length, 1)
  assert.equal(frame.kind, 'browser-command')
  assert.equal(frame.sessionId, 's1')
  assert.equal(frame.op, 'text')
  assert.deepEqual(frame.args, { selector: 'main' })
  assert.equal(frame.deadlineMs, contract.BROWSER_DEADLINE_DEFAULT_MS)
  assert.match(frame.commandId, contract.BROWSER_COMMAND_ID)

  service.handleClientFrame(client, { type: 'browser-result', commandId: frame.commandId, ok: true, result: { text: 'hi' } })
  assert.deepEqual(await pending, { ok: true, value: { text: 'hi' } })
  assert.equal(service.inFlight, 0)
})

test('a client error is passed through as its own code', async () => {
  const { registry, clients, service } = makeService()
  registry.add('dev-1')
  const client = fakeClient('dev-1', CAPABLE)
  clients.add(client)
  const pending = service.send('dev-1', 's1', 'navigate', { url: 'https://example.test' })
  const command = client.commands[0]
  service.handleClientFrame(client, { type: 'browser-result', commandId: command.commandId, ok: false,
    error: { code: 'browser/denied', message: 'consent is off' } })
  assert.deepEqual(await pending, { ok: false, error: { code: 'browser/denied', message: 'consent is off' } })
})

test('oversized text/html is cut host-side and flagged', async () => {
  const { registry, clients, service } = makeService()
  registry.add('dev-1')
  const client = fakeClient('dev-1', CAPABLE)
  clients.add(client)
  const pending = service.send('dev-1', 's1', 'text', {})
  const command = client.commands[0]
  const long = 'a'.repeat(contract.BROWSER_TEXT_MAX_BYTES + 5)
  service.handleClientFrame(client, { type: 'browser-result', commandId: command.commandId, ok: true, result: { text: long } })
  const result = await pending
  assert.equal(result.ok, true)
  assert.equal(result.value.truncated, true)
  assert.equal(result.value.text.length, contract.BROWSER_TEXT_MAX_BYTES)
})

test('a foreign device cannot answer another device command', async () => {
  const { registry, clients, service } = makeService()
  registry.add('dev-1')
  registry.add('dev-2')
  const client = fakeClient('dev-1', CAPABLE)
  const intruder = fakeClient('dev-2', CAPABLE)
  clients.add(client)
  clients.add(intruder)
  let settled = false
  const pending = service.send('dev-1', 's1', 'text', {}).then((value) => { settled = true; return value })
  const command = client.commands[0]
  service.handleClientFrame(intruder, { type: 'browser-result', commandId: command.commandId, ok: true, result: { text: 'stolen' } })
  await tick()
  assert.equal(settled, false, 'the intruder answer is ignored')
  assert.equal(service.inFlight, 1)
  service.handleClientFrame(client, { type: 'browser-result', commandId: command.commandId, ok: true, result: { text: 'mine' } })
  assert.deepEqual((await pending).value, { text: 'mine' })
})

test('a duplicate or unknown result is ignored, never applied and never answered', async () => {
  const { registry, clients, service, logs } = makeService()
  registry.add('dev-1')
  const client = fakeClient('dev-1', CAPABLE)
  clients.add(client)
  const pending = service.send('dev-1', 's1', 'text', {})
  const command = client.commands[0]
  service.handleClientFrame(client, { type: 'browser-result', commandId: 'nope', ok: true, result: {} })
  service.handleClientFrame(client, { type: 'browser-result', commandId: command.commandId, ok: true, result: { text: 'first' } })
  service.handleClientFrame(client, { type: 'browser-result', commandId: command.commandId, ok: true, result: { text: 'second' } })
  assert.deepEqual((await pending).value, { text: 'first' })
  assert.ok(logs.some((line) => line.includes('unknown commandId')))
  assert.equal(client.sent.length, 1, 'the host answers nothing: the promise is the answer')
})

test('a malformed result is refused without settling the command', async () => {
  const { registry, clients, service } = makeService()
  registry.add('dev-1')
  const client = fakeClient('dev-1', CAPABLE)
  clients.add(client)
  const pending = service.send('dev-1', 's1', 'text', {})
  const command = client.commands[0]
  service.handleClientFrame(client, { type: 'browser-result', commandId: command.commandId, ok: true }) // no result
  service.handleClientFrame(client, { type: 'browser-result', commandId: command.commandId, ok: false, error: {} })
  await tick()
  assert.equal(service.inFlight, 1)
  service.handleClientFrame(client, { type: 'browser-result', commandId: command.commandId, ok: true, result: {} })
  await pending
})

// ---------------------------------------------------------------------------
// Deadline, cancel, revocation — "takes effect immediately"
// ---------------------------------------------------------------------------

test('the deadline cancels the command on the device and answers timeout', async () => {
  const { registry, clients, service, timers } = makeService()
  registry.add('dev-1')
  const client = fakeClient('dev-1', CAPABLE)
  clients.add(client)
  const pending = service.send('dev-1', 's1', 'text', {})
  const command = client.commands[0]
  timers.fireAll()
  assert.deepEqual(await pending, { ok: false, error: { code: 'browser/timeout',
    message: `the device did not answer within ${contract.BROWSER_DEADLINE_DEFAULT_MS} ms` } })
  assert.deepEqual(client.cancels, [{ kind: 'browser-cancel', commandId: command.commandId }])
  assert.equal(service.inFlight, 0)
})

test('an aborted command tells the device and answers cancelled', async () => {
  const { registry, clients, service } = makeService()
  registry.add('dev-1')
  const client = fakeClient('dev-1', CAPABLE)
  clients.add(client)
  const controller = new AbortController()
  const pending = service.send('dev-1', 's1', 'text', {}, controller.signal)
  const command = client.commands[0]
  controller.abort()
  assert.deepEqual(await pending, { ok: false, error: { code: 'browser/cancelled', message: 'the command was cancelled' } })
  assert.deepEqual(client.cancels, [{ kind: 'browser-cancel', commandId: command.commandId }])
})

test('an already-aborted signal sends nothing', async () => {
  const { registry, clients, service } = makeService()
  registry.add('dev-1')
  const client = fakeClient('dev-1', CAPABLE)
  clients.add(client)
  const controller = new AbortController()
  controller.abort()
  const result = await service.send('dev-1', 's1', 'text', {}, controller.signal)
  assert.equal(result.ok, false)
  assert.equal(result.error.code, 'browser/cancelled')
  assert.equal(client.sent.length, 0)
})

test('the device may decline a command it was given', async () => {
  const { registry, clients, service } = makeService()
  registry.add('dev-1')
  const client = fakeClient('dev-1', CAPABLE)
  clients.add(client)
  const pending = service.send('dev-1', 's1', 'text', {})
  const command = client.commands[0]
  service.handleClientFrame(client, { type: 'browser-cancel', commandId: command.commandId })
  const result = await pending
  assert.equal(result.ok, false)
  assert.equal(result.error.code, 'browser/cancelled')
  assert.equal(service.inFlight, 0)
})

test('revoking the device mid-flight cancels the command at once', async () => {
  const { registry, clients, service } = makeService()
  const device = registry.add('dev-1')
  const client = fakeClient('dev-1', CAPABLE)
  clients.add(client)
  const pending = service.send('dev-1', 's1', 'text', {})
  // The socket closes on every revoke path; the gateway calls cancelDevice there.
  device.revokedAt = Date.now()
  assert.equal(service.cancelDevice('dev-1'), true)
  const result = await pending
  assert.equal(result.ok, false)
  assert.equal(result.error.code, 'browser/offline')
  assert.equal(service.inFlight, 0)
})

test('removing browser:control mid-flight refuses the eventual result', async () => {
  const { registry, clients, service } = makeService()
  const device = registry.add('dev-1')
  const client = fakeClient('dev-1', CAPABLE)
  clients.add(client)
  const pending = service.send('dev-1', 's1', 'text', {})
  const command = client.commands[0]
  // The owner unticks the scope while the command is out. No socket closes.
  device.scopes = ['sessions:read']
  service.handleClientFrame(client, { type: 'browser-result', commandId: command.commandId, ok: true, result: { text: 'late' } })
  const result = await pending
  assert.equal(result.ok, false)
  assert.equal(result.error.code, 'browser/forbidden-scope')
})

test('a device revoked before it answers is refused offline', async () => {
  const { registry, clients, service } = makeService()
  const device = registry.add('dev-1')
  const client = fakeClient('dev-1', CAPABLE)
  clients.add(client)
  const pending = service.send('dev-1', 's1', 'text', {})
  const command = client.commands[0]
  device.revokedAt = Date.now()
  service.handleClientFrame(client, { type: 'browser-result', commandId: command.commandId, ok: true, result: { text: 'late' } })
  const result = await pending
  assert.equal(result.ok, false)
  assert.equal(result.error.code, 'browser/offline')
})

test('teardown settles everything in flight', async () => {
  const { registry, clients, service } = makeService()
  registry.add('dev-1')
  clients.add(fakeClient('dev-1', CAPABLE))
  const pending = service.send('dev-1', 's1', 'text', {})
  service.close()
  const result = await pending
  assert.equal(result.ok, false)
  assert.equal(result.error.code, 'browser/offline')
  assert.equal(service.inFlight, 0)
})

test('frames that are not this revision are left to the caller', () => {
  const { service } = makeService()
  assert.equal(service.handleClientFrame({ deviceId: 'd' }, { type: 'message' }), false)
  assert.equal(service.handleClientFrame({ deviceId: 'd' }, { kind: 'browser-command' }), false)
  assert.equal(service.handleClientFrame(null, null), false)
})

// ---------------------------------------------------------------------------
// auto target
// ---------------------------------------------------------------------------

test('auto picks the device that prompted the session, else the host', async () => {
  const { registry, clients, driver, service } = makeService()
  registry.add('dev-1')
  const client = fakeClient('dev-1', CAPABLE)
  clients.add(client)

  // Nothing recorded: auto means the host, which this service cannot drive.
  const none = await service.send('auto', 's1', 'text', {})
  assert.equal(none.error.code, 'browser/not-supported')

  driver.noteDevicePrompt('s1', 'dev-1')
  const pending = service.send('auto', 's1', 'text', {})
  await tick()
  assert.equal(client.commands.length, 1)
  service.handleClientFrame(client, { type: 'browser-result', commandId: client.commands[0].commandId, ok: true, result: {} })
  assert.equal((await pending).ok, true)
})

test('auto falls back to the host when the recording device is no longer granted', async () => {
  const { registry, clients, driver, service } = makeService()
  const device = registry.add('dev-1')
  clients.add(fakeClient('dev-1', CAPABLE))
  driver.noteDevicePrompt('s1', 'dev-1')
  device.scopes = []
  const result = await service.send('auto', 's1', 'text', {})
  // Granted=false: auto does not silently pick an unauthorized device.
  assert.equal(result.ok, false)
  assert.equal(result.error.code, 'browser/forbidden-scope')
})

// ---------------------------------------------------------------------------
// host service registration
// ---------------------------------------------------------------------------

test('provideHostService registers through the Host API the context offers', () => {
  const service = { describe: () => ({ driven: 'local' }) }
  // cordis-style: set(name, value).
  const bySet = {
    store: new Map(),
    set(name, value) { this.store.set(name, value) },
    get(name) { return this.store.get(name) },
  }
  assert.equal(provideHostService(bySet, REMOTE_SESSION_SCOPE_SERVICE, service), true)
  assert.equal(bySet.get(REMOTE_SESSION_SCOPE_SERVICE), service)

  // provide(name, value) once.
  const byProvide = {
    store: new Map(),
    provide(name, value) { this.store.set(name, value) },
    get(name) { return this.store.get(name) },
  }
  assert.equal(provideHostService(byProvide, REMOTE_BROWSER_SERVICE, service), true)

  // provide(name) then assignment (the shape the sidebar-browser README shows). Cordis's
  // `provide` creates the service property, so `ctx.get` then reads what was assigned.
  const byAssign = {
    store: new Map(),
    provide(name) { this.store.set(name, undefined) },
    get(name) { return Object.hasOwn(this, name) ? this[name] : this.store.get(name) },
  }
  assert.equal(provideHostService(byAssign, REMOTE_BROWSER_SERVICE, service), true)
  assert.equal(byAssign[REMOTE_BROWSER_SERVICE], service)
})

test('a context that refuses the service is reported, not thrown', () => {
  assert.equal(provideHostService(null, 'x', {}), false)
  assert.equal(provideHostService({}, 'x', {}), false)
  const hostile = { set() { throw new Error('nope') }, provide() { throw new Error('nope') }, get() { throw new Error('nope') } }
  assert.equal(provideHostService(hostile, 'x', {}), false)
})
