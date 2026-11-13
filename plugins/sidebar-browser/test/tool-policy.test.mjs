/**
 * C2a — the session's permission preset is the switch. Mutating tools declare their risk
 * through DSH's `tools/pre-execute` waterfall (`{ kind: 'ask' }`), so the tools pipeline —
 * not this plugin — raises the approval and the session's approval policy decides. Under
 * the Full access preset nothing asks.
 */
import test from 'node:test'
import assert from 'node:assert/strict'
import { createHost } from './harness.mjs'
import { __internals } from '../lib/index.js'

const SESSION = { cwd: '/tmp/project' }
const exec = (name, args = {}) => ({ name, arguments: args, agent: { session: SESSION }, callId: 'call-1' })

/** A preset service reporting one fixed preset for every session. */
const preset = (name) => ({ current: () => name })

const MUTATING_TOOLS = [
  ['internal_browser_navigate', { url: 'https://example.com/login' }],
  ['internal_browser_click', { index: 3 }],
  ['internal_browser_type', { text: 'hello' }],
  ['internal_browser_press', { key: 'Enter' }],
  ['internal_browser_scroll', { direction: 'down' }],
  ['internal_browser_eval', { expression: '1 + 1' }],
  ['internal_browser_history', { action: 'reload' }],
  ['internal_browser_open', { url: 'https://example.com' }],
  ['internal_browser_close', {}],
]

const READ_ONLY_TOOLS = [
  ['internal_browser_tabs', {}],
  ['internal_browser_snapshot', {}],
  ['internal_browser_text', {}],
  ['internal_browser_html', { index: 1 }],
]

test('the plugin has no master switch and no origin allowlist of its own', () => {
  assert.equal('enabled' in __internals.DEFAULTS, false, 'C2a dropped the master switch')
  assert.equal('originAllowlist' in __internals.DEFAULTS, false, 'the native approval decides now')
  assert.deepEqual(Object.keys(__internals.normalizeConfig({})).sort(), ['dataDir', 'grantedScopes', 'tab'])
  // A config that still carries the removed keys loads: they are simply not read.
  assert.deepEqual(Object.keys(__internals.normalizeConfig({ enabled: true, originAllowlist: ['example.com'] })).sort(), ['dataDir', 'grantedScopes', 'tab'])
})

test('under Full access no mutating tool asks', async () => {
  const host = createHost({ permissionPresets: preset(__internals.FULL_ACCESS_PRESET) })
  for (const [name, args] of MUTATING_TOOLS) {
    const decision = await host.riskDecision(exec(name, args))
    assert.equal(decision.kind, 'allow', `${name} must pass through under Full access`)
  }
})

test('outside Full access every mutating tool returns the native ask decision', async () => {
  for (const presetName of ['workspace-write', 'read-only', 'custom']) {
    const host = createHost({ permissionPresets: preset(presetName) })
    for (const [name, args] of MUTATING_TOOLS) {
      const decision = await host.riskDecision(exec(name, args))
      assert.equal(decision.kind, 'ask', `${name} must ask under ${presetName}`)
      assert.equal(typeof decision.reason, 'string')
      assert.ok(decision.reason.length > 0)
      assert.match(decision.reason, /^the sidebar browser will /)
    }
  }
})

test('read-only tools never ask, whatever the preset', async () => {
  const host = createHost({ permissionPresets: preset('workspace-write') })
  for (const [name, args] of READ_ONLY_TOOLS) {
    const decision = await host.riskDecision(exec(name, args))
    assert.equal(decision.kind, 'allow', `${name} is a read and must not ask`)
  }
})

test('the ask reason names the call and the page, never a raw placeholder', async () => {
  const host = createHost({ permissionPresets: preset('workspace-write') })
  // Teach the bridge the current page the way the client half does on a poll.
  const { pollAndReply } = await import('./harness.mjs')
  await pollAndReply(host, { page: 'https://shop.example/cart', waitMs: 25, respond: async () => 'unused' })

  const click = await host.riskDecision(exec('internal_browser_click', { index: 7 }))
  assert.equal(click.reason, 'the sidebar browser will click element [7] on https://shop.example/cart')

  const navigate = await host.riskDecision(exec('internal_browser_navigate', { url: 'https://example.com/x' }))
  assert.equal(navigate.reason, 'the sidebar browser will navigate to https://example.com/x')

  const type = await host.riskDecision(exec('internal_browser_type', { text: 'abcd', index: 2 }))
  assert.equal(type.reason, 'the sidebar browser will type 4 character(s) into element [2] on https://shop.example/cart')

  const closeCollapse = await host.riskDecision(exec('internal_browser_close', { sidebar: true }))
  assert.equal(closeCollapse.reason, 'the sidebar browser will collapse the right sidebar')
})

test('a plugin tool the waterfall does not own is left to the rest of the pipeline', async () => {
  const host = createHost({ permissionPresets: preset('workspace-write') })
  for (const name of ['internal_browser_bogus', 'read_file', 'internal_browser_']) {
    const decision = await host.riskDecision(exec(name))
    assert.equal(decision.kind, 'allow', `${name} is not a mutating browser tool`)
  }
})

test('the ask sentence never throws on arguments of an unexpected shape', async () => {
  const host = createHost({ permissionPresets: preset('workspace-write') })
  for (const args of [undefined, null, 'x', 7, [], { index: {}, text: 5, url: null }]) {
    for (const [name] of MUTATING_TOOLS) {
      const decision = await host.riskDecision({ name, arguments: args, agent: { session: SESSION }, callId: 'c' })
      assert.equal(decision.kind, 'ask', `${name} with ${JSON.stringify(args)} must still ask, not throw`)
    }
  }
})

test('the preset service is authoritative; the sandbox policy is only the fallback', async () => {
  // No preset table mounted: the shared sandbox policy names the effective mode.
  const sandboxOnly = createHost({ sandboxPolicy: { resolve: () => ({ mode: __internals.FULL_ACCESS_PRESET }) } })
  assert.equal((await sandboxOnly.riskDecision(exec('internal_browser_click', { index: 1 }))).kind, 'allow')

  const sandboxConfined = createHost({ sandboxPolicy: { resolve: () => ({ mode: 'workspace-write' }) } })
  assert.equal((await sandboxConfined.riskDecision(exec('internal_browser_click', { index: 1 }))).kind, 'ask')

  // The preset service wins over the fallback when both are mounted.
  const both = createHost({
    permissionPresets: preset('workspace-write'),
    sandboxPolicy: { resolve: () => ({ mode: __internals.FULL_ACCESS_PRESET }) },
  })
  assert.equal((await both.riskDecision(exec('internal_browser_click', { index: 1 }))).kind, 'ask')
})

test('an unusable or throwing permission reader fails closed to asking', async () => {
  for (const host of [
    createHost(),
    createHost({ permissionPresets: { current: () => { throw new Error('projection not ready') } } }),
    createHost({ permissionPresets: { current: () => 'custom' }, sandboxPolicy: { resolve: () => { throw new Error('no session') } } }),
  ]) {
    assert.equal((await host.riskDecision(exec('internal_browser_click', { index: 1 }))).kind, 'ask')
  }
  // No session at all (an agentless call) cannot be in Full access.
  const host = createHost({ permissionPresets: preset(__internals.FULL_ACCESS_PRESET) })
  assert.equal((await host.riskDecision({ name: 'internal_browser_click', arguments: {}, callId: 'c' })).kind, 'ask')
})

test('the plugin never raises an approval request of its own', async () => {
  // No approval service is composed in this harness at all: the tools still run their
  // bodies, which proves the plugin does not call ctx.approval itself any more.
  const host = createHost({ permissionPresets: preset(__internals.FULL_ACCESS_PRESET) })
  assert.equal(host.services.approval, undefined)
  for (const [name, args] of MUTATING_TOOLS) {
    await assert.rejects(
      () => host.tools.get(name).execute(args, exec(name)),
      /app window has not connected/,
      `${name} must reach its body, not an approval wall`,
    )
  }
})

test('a missing or malformed required argument is refused, never coerced', async () => {
  const host = createHost({ permissionPresets: preset(__internals.FULL_ACCESS_PRESET) })
  const cases = [
    ['internal_browser_navigate', {}, /missing required argument "url"/],
    ['internal_browser_click', {}, /missing required argument "index"/],
    ['internal_browser_click', { index: 'three' }, /"index" must be an integer/],
    ['internal_browser_scroll', { direction: 'sideways' }, /"direction" must be one of/],
    ['internal_browser_history', { action: 'rewind' }, /"action" must be one of/],
    ['internal_browser_eval', { expression: '' }, /"expression" must be a non-empty string/],
  ]
  for (const [name, args, expected] of cases) {
    await assert.rejects(
      () => host.tools.get(name).execute(args, exec(name)),
      (error) => {
        assert.match(error.message, expected, `${name} ${JSON.stringify(args)}`)
        return true
      },
    )
  }
})

test('every registration has the shape the registry accepts without defineTool', () => {
  const host = createHost()
  const expected = [
    'internal_browser_tabs', 'internal_browser_snapshot', 'internal_browser_text',
    'internal_browser_html', 'internal_browser_screenshot', 'internal_browser_navigate',
    'internal_browser_click', 'internal_browser_type', 'internal_browser_press',
    'internal_browser_scroll', 'internal_browser_eval', 'internal_browser_history',
    'internal_browser_open', 'internal_browser_close',
  ]
  assert.deepEqual([...host.tools.keys()].sort(), [...expected].sort())
  for (const [name, tool] of host.tools) {
    assert.equal(typeof tool.description, 'string')
    assert.ok(tool.description.length > 40, `${name} needs a description the model can use`)
    assert.equal(tool.parameters.type, 'object', `${name} parameters must be an object schema`)
    assert.equal(typeof tool.parameters.properties, 'object')
    assert.equal(tool.output.schema.type, 'string', `${name} renders text`)
    assert.equal(typeof tool.output.render, 'function')
    assert.equal(typeof tool.execute, 'function')
    assert.equal(tool.timeoutMs, undefined, `${name} uses the executor default timeout`)
  }
})
