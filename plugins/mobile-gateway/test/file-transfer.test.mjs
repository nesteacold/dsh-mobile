// Split plan step 2 (2026-11-14): pins isInsideWorkspace against '..' and symlink escapes.
import test from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { isInsideWorkspace } from '../lib/file-transfer.mjs'

test('isInsideWorkspace rejects .. escapes', () => {
  const root = path.resolve(os.tmpdir(), 'ws-root')
  assert.equal(isInsideWorkspace(root, root), true)
  assert.equal(isInsideWorkspace(root, path.join(root, 'a', 'b.txt')), true)
  assert.equal(isInsideWorkspace(root, path.join(root, '..dotdir')), true)
  assert.equal(isInsideWorkspace(root, path.resolve(root, '..')), false)
  assert.equal(isInsideWorkspace(root, path.resolve(root, '..', 'other')), false)
  assert.equal(isInsideWorkspace(root, path.resolve(root, 'a', '..', '..', 'x')), false)
  assert.equal(isInsideWorkspace(root, path.resolve(root + '-sibling')), false)
})

test('isInsideWorkspace rejects a symlink escape once realpath-resolved', (t) => {
  const base = fs.mkdtempSync(path.join(os.tmpdir(), 'ft-'))
  t.after(() => fs.rmSync(base, { recursive: true, force: true }))
  const root = path.join(base, 'root')
  const outside = path.join(base, 'outside')
  fs.mkdirSync(root)
  fs.mkdirSync(outside)
  const link = path.join(root, 'link')
  try {
    fs.symlinkSync(outside, link, 'dir')
  } catch (error) {
    if (error && (error.code === 'EPERM' || error.code === 'EACCES')) {
      t.skip(`symlink not permitted here (${error.code})`)
      return
    }
    throw error
  }
  const realRoot = fs.realpathSync(root)
  assert.equal(isInsideWorkspace(root, link), true, 'lexically inside before resolution')
  assert.equal(isInsideWorkspace(realRoot, fs.realpathSync(link)), false)
})
