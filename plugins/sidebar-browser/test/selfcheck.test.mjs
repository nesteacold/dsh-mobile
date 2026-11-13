/**
 * C7 — screenshot savePath is confined to the plugin data directory, and the DOM-hook
 * self-check refuses with a visible reason instead of driving a shell it no longer knows.
 */
import test from 'node:test'
import assert from 'node:assert/strict'
import { existsSync, mkdtempSync, rmSync, symlinkSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { createHost, runTool, tempDataDir, TINY_PNG, FULL_HOOKS } from './harness.mjs'
import { __internals } from '../lib/index.js'

const exec = { name: 'internal_browser_screenshot', agent: { session: {} }, callId: 'call-1' }

test('a savePath outside the data directory is refused before anything runs', async () => {
  const { dir, done } = tempDataDir()
  try {
    const host = createHost({ config: { dataDir: dir } })
    for (const savePath of ['../escape.png', 'shots/../../escape.png', resolve(dir, '..', 'escape.png'), '/etc/passwd', 'C:\\Windows\\evil.png']) {
      await assert.rejects(
        () => host.tools.get('internal_browser_screenshot').execute({ savePath }, exec),
        (error) => {
          assert.match(error.message, /must stay inside the plugin data directory/)
          assert.match(error.message, /spec 014 C7/)
          return true
        },
        `savePath ${JSON.stringify(savePath)} must be refused`,
      )
    }
  } finally {
    done()
  }
})

test('the confinement helper refuses traversal and symlink escapes', () => {
  const { dir, done } = tempDataDir()
  try {
    assert.equal(__internals.confineSavePath(dir, undefined).startsWith(resolve(dir)), true)
    assert.equal(__internals.confineSavePath(dir, 'shots/a.png'), join(resolve(dir), 'shots', 'a.png'))
    assert.throws(() => __internals.confineSavePath(dir, '../a.png'), /spec 014 C7/)
    assert.throws(() => __internals.confineSavePath(dir, '/tmp/a.png'), /spec 014 C7/)
    // An absolute path INSIDE the directory is accepted.
    assert.equal(__internals.confineSavePath(dir, join(dir, 'ok.png')), join(resolve(dir), 'ok.png'))
  } finally {
    done()
  }
})

test('minor: a symlinked directory inside the data directory cannot carry the write out', (t) => {
  const { dir, done } = tempDataDir()
  const outside = mkdtempSync(join(tmpdir(), 'dsh-sidebar-browser-outside-'))
  try {
    if (!link(t, outside, join(dir, 'link'), 'junction')) return
    assert.throws(
      () => __internals.confineSavePath(dir, 'link/out.png'),
      /escapes the plugin data directory through a symlink/,
    )
  } finally {
    rmSync(outside, { recursive: true, force: true })
    done()
  }
})

test('minor: an unresolvable ancestor fails closed instead of being written through', (t) => {
  const { dir, done } = tempDataDir()
  try {
    // A dangling symlink exists on disk but resolves nowhere: the confinement cannot be
    // verified, so the write must be refused (realpath errors are not swallowed).
    if (!link(t, join(dir, 'missing-target'), join(dir, 'dangling'), 'file')) return
    assert.throws(
      () => __internals.confineSavePath(dir, 'dangling/out.png'),
      /cannot be verified against the plugin data directory/,
    )
  } finally {
    done()
  }
})

/** Create a symlink, or skip the test when this machine does not allow one. */
function link (t, target, path, type) {
  try {
    symlinkSync(target, path, type)
    return true
  } catch (error) {
    t.skip(`cannot create a ${type} symlink here (${error.code})`)
    return false
  }
}

test('a savePath inside the data directory writes the file and returns its path', async () => {
  const { dir, done } = tempDataDir()
  try {
    const host = createHost({ config: { dataDir: dir } })
    let call = 0
    const result = await runTool(host, 'internal_browser_screenshot', { savePath: 'shots/proof.png' }, {
      respond: async () => {
        call++
        if (call === 1) return false
        if (call === 2) return true
        return TINY_PNG
      },
    })
    const file = join(resolve(dir), 'shots', 'proof.png')
    assert.equal(result.split('\n')[0], file)
    assert.equal(existsSync(file), true, 'the PNG must be on disk inside the data directory')
  } finally {
    done()
  }
})

test('a missing DOM hook is refused with the selector and the DSH version', async () => {
  const host = createHost()
  const broken = { ...FULL_HOOKS, frame: false, frameKind: null }
  const exchange = await (await import('./harness.mjs')).pollAndReply(host, { hooks: broken, waitMs: 25, respond: async () => 'unused' })
  assert.equal(exchange.idle, true, 'the first handshake carries the report, not a command')

  await assert.rejects(
    () => host.tools.get('internal_browser_snapshot').execute({}, { name: 'internal_browser_snapshot', agent: { session: {} } }),
    (error) => {
      assert.match(error.message, /webview\[data-sidebar-browser-frame\]/)
      assert.match(error.message, /0\.2\.2-rc\.3/)
      assert.match(error.message, /needs an update/)
      return true
    },
  )
})

test('a missing dock hook is refused for open/close only', async () => {
  const host = createHost()
  const broken = { ...FULL_HOOKS, dockTab: false, rightToggle: false }
  await (await import('./harness.mjs')).pollAndReply(host, { hooks: broken, waitMs: 25, respond: async () => 'unused' })

  // The self-check runs inside the tool body, before anything talks to the page: the user
  // is never asked (C2a) about a call that cannot work on this shell, because approval is
  // decided before the body only for the risk declaration — and a broken hook refuses here.
  for (const name of ['internal_browser_open', 'internal_browser_close']) {
    await assert.rejects(
      () => host.tools.get(name).execute({}, { name, agent: { session: {} } }),
      /\[data-dockkit-tab\]/,
      `${name} must refuse without the dock hooks`,
    )
  }
  // A page tool still runs: it needs only the frame hook.
  const text = await runTool(host, 'internal_browser_text', {}, {
    hooks: broken,
    respond: async () => 'hello',
  })
  assert.match(text, /hello/, 'page tools do not depend on the dock hooks')
})

test('the self-check is silent when every hook is present', () => {
  assert.equal(__internals.hookProblem({ hooks: FULL_HOOKS }, 'frame'), null)
  assert.equal(__internals.hookProblem({ hooks: FULL_HOOKS }, 'dock'), null)
  assert.equal(__internals.hookProblem(null, 'frame'), null, 'no report yet is not a failure')
  assert.match(__internals.hookProblem({ hooks: null }, 'frame'), /did not report its sidebar DOM hooks/)
})
