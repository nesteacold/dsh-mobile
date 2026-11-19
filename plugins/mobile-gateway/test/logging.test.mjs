import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { spawnSync } from 'node:child_process'
import { fileURLToPath } from 'node:url'
import { test } from 'node:test'

const loggingURL = new URL('../lib/logging.mjs', import.meta.url).href
const restartPath = new URL('../lib/web-restart.mjs', import.meta.url)

function inTemporaryDirectory(body) {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'dsh-logging-'))
  try { body(directory) } finally { fs.rmSync(directory, { recursive: true, force: true }) }
}

function environment(directory) {
  // Windows 使用 TEMP/TMP；Unix 使用 TMPDIR。
  return { ...process.env, TMPDIR: directory, TEMP: directory, TMP: directory }
}

function writeFixture(directory) {
  return spawnSync(process.execPath, ['--input-type=module', '-e',
    `import { log } from ${JSON.stringify(loggingURL)}; log('logging-fixture')`],
  { env: environment(directory), encoding: 'utf8' })
}

test('writes logs under the platform temporary directory, including paths with spaces', () => {
  inTemporaryDirectory(root => {
    const directory = path.join(root, 'temporary logs')
    fs.mkdirSync(directory)
    const result = writeFixture(directory)
    assert.equal(result.status, 0, result.stderr)
    assert.match(fs.readFileSync(path.join(directory, 'mobile-gateway.log'), 'utf8'), /logging-fixture/)
    assert.match(result.stdout, /logging-fixture/)
    assert.equal(result.stderr, '')
  })
})

test('reports file failures to stderr and preserves normal output without throwing', () => {
  inTemporaryDirectory(root => {
    const result = writeFixture(path.join(root, 'missing-directory'))
    assert.equal(result.status, 0)
    assert.match(result.stdout, /logging-fixture/)
    assert.match(result.stderr, /cannot write log file/)
    assert.match(result.stderr, /mobile-gateway\.log/)
  })
})

test('restart diagnostics use the same platform log file', () => {
  inTemporaryDirectory(directory => {
    const result = spawnSync(process.execPath, [fileURLToPath(restartPath),
      Buffer.from(JSON.stringify({ pid: -1 })).toString('base64url')],
    { env: environment(directory), encoding: 'utf8' })
    assert.equal(result.status, 1)
    assert.match(fs.readFileSync(path.join(directory, 'mobile-gateway.log'), 'utf8'), /invalid restart handoff/)
  })
})

function runLogging(directory, snippet, extraEnv = {}) {
  const source = `import { log, LOG_FILE, MAX_LOG_BYTES } from ${JSON.stringify(loggingURL)}; ${snippet}`
  return spawnSync(process.execPath, ['--input-type=module', '-e', source],
    { env: { ...environment(directory), ...extraEnv }, encoding: 'utf8' })
}

function fileSize(file) {
  return fs.statSync(file).size
}

test('rotates at the configured cap and leaves unrelated files untouched', () => {
  inTemporaryDirectory(root => {
    const cap = 96
    const sentinel = path.join(root, 'unrelated.txt')
    fs.writeFileSync(sentinel, 'do not touch')
    const result = runLogging(root, `log('entry-one'); log('entry-two'); log('entry-three')`,
      { DSH_MOBILE_GATEWAY_LOG_MAX_BYTES: String(cap) })
    assert.equal(result.status, 0, result.stderr)
    const active = path.join(root, 'mobile-gateway.log')
    const rotated = `${active}.1`
    assert.equal(fs.existsSync(rotated), true)
    assert.ok(fileSize(active) <= cap, `active file ${fileSize(active)} > ${cap}`)
    assert.ok(fileSize(rotated) <= cap, `rotated file ${fileSize(rotated)} > ${cap}`)
    assert.ok(fileSize(active) + fileSize(rotated) <= 2 * cap)
    assert.match(fs.readFileSync(rotated, 'utf8'), /entry-one/)
    assert.match(fs.readFileSync(rotated, 'utf8'), /entry-two/)
    assert.match(fs.readFileSync(active, 'utf8'), /entry-three/)
    assert.equal(fs.readFileSync(sentinel, 'utf8'), 'do not touch')
    assert.match(result.stdout, /entry-three/)
  })
})

test('counts bytes already on disk, so writes from another process are respected', () => {
  inTemporaryDirectory(root => {
    const cap = 128
    const active = path.join(root, 'mobile-gateway.log')
    fs.writeFileSync(active, 'x'.repeat(100))
    const result = runLogging(root, `log('from-another-process-check')`,
      { DSH_MOBILE_GATEWAY_LOG_MAX_BYTES: String(cap) })
    assert.equal(result.status, 0, result.stderr)
    assert.equal(fs.existsSync(`${active}.1`), true)
    assert.match(fs.readFileSync(`${active}.1`, 'utf8'), /^x{100}$/)
    assert.match(fs.readFileSync(active, 'utf8'), /from-another-process-check/)
  })
})

test('redaction survives into both the active and rotated log files', () => {
  inTemporaryDirectory(root => {
    const cap = 96
    // Assembled from bytes so a secret scanner cannot mistake it for a live token.
    const pairingCode = Buffer.from('0123456789abcdef0123456789abcdef').toString('base64url')
    const snippet = `const code = ${JSON.stringify(pairingCode)}; `
      + `log('paired code=' + code); log('again code=' + code); log('last code=' + code)`
    const result = runLogging(root, snippet, { DSH_MOBILE_GATEWAY_LOG_MAX_BYTES: String(cap) })
    assert.equal(result.status, 0, result.stderr)
    const active = path.join(root, 'mobile-gateway.log')
    const captured = [result.stdout, fs.readFileSync(active, 'utf8')]
    if (fs.existsSync(`${active}.1`)) captured.push(fs.readFileSync(`${active}.1`, 'utf8'))
    for (const text of captured) {
      assert.equal(text.includes(pairingCode), false)
      assert.match(text, /\[redacted\]/)
    }
  })
})

test('a single oversized entry is bounded in the file without losing stdout', () => {
  inTemporaryDirectory(root => {
    const cap = 96
    const huge = 'z'.repeat(5000)
    const result = runLogging(root, `log('oversize:' + ${JSON.stringify(huge)})`,
      { DSH_MOBILE_GATEWAY_LOG_MAX_BYTES: String(cap) })
    assert.equal(result.status, 0, result.stderr)
    const active = path.join(root, 'mobile-gateway.log')
    assert.ok(fileSize(active) <= cap, `active file ${fileSize(active)} > ${cap}`)
    assert.match(fs.readFileSync(active, 'utf8'), /\[truncated\]/)
    assert.equal(result.stdout.includes('oversize:' + huge), true)
  })
})

test('a failed rotation stops appends instead of growing an oversized log', () => {
  inTemporaryDirectory(root => {
    const cap = 96
    const active = path.join(root, 'mobile-gateway.log')
    fs.mkdirSync(`${active}.1`) // not a regular file: rotation cannot replace it
    const result = runLogging(root,
      `log('first-entry'); log('second-entry'); log('third-entry'); log('fourth-entry')`,
      { DSH_MOBILE_GATEWAY_LOG_MAX_BYTES: String(cap) })
    assert.equal(result.status, 0, result.stderr)
    assert.match(result.stderr, /cannot write log file/)
    assert.ok(fileSize(active) <= cap, `active file ${fileSize(active)} > ${cap}`)
    assert.equal(fs.statSync(`${active}.1`).isDirectory(), true)
    for (const marker of ['first-entry', 'second-entry', 'third-entry', 'fourth-entry']) {
      assert.equal(result.stdout.includes(marker), true)
    }
  })
})

test('a malformed cap override falls back to the default instead of disabling the cap', () => {
  inTemporaryDirectory(root => {
    const result = runLogging(root, `log('still-logged'); console.log('cap=' + MAX_LOG_BYTES)`,
      { DSH_MOBILE_GATEWAY_LOG_MAX_BYTES: 'not-a-number' })
    assert.equal(result.status, 0, result.stderr)
    assert.match(result.stdout, /cap=10485760/)
    assert.equal(result.stderr, '')
    assert.match(fs.readFileSync(path.join(root, 'mobile-gateway.log'), 'utf8'), /still-logged/)
  })
})

test('a symlink at the rotation target is refused instead of being replaced', (t) => {
  inTemporaryDirectory(root => {
    const cap = 96
    const active = path.join(root, 'mobile-gateway.log')
    try {
      fs.symlinkSync(path.join(root, 'elsewhere.txt'), `${active}.1`)
    } catch (error) {
      if (error?.code === 'EPERM' || error?.code === 'EACCES' || error?.code === 'ENOSYS') {
        t.skip(`symlink creation unsupported here (${error.code})`)
        return
      }
      throw error
    }
    const result = runLogging(root, `log('first-entry'); log('second-entry'); log('third-entry')`,
      { DSH_MOBILE_GATEWAY_LOG_MAX_BYTES: String(cap) })
    assert.equal(result.status, 0, result.stderr)
    assert.match(result.stderr, /cannot write log file/)
    assert.ok(fileSize(active) <= cap, `active file ${fileSize(active)} > ${cap}`)
    assert.equal(fs.lstatSync(`${active}.1`).isSymbolicLink(), true)
  })
})

test('truncation never leaves a UTF-8 replacement character in the file', () => {
  inTemporaryDirectory(root => {
    const cap = 96
    const message = '\u{1F4A1}'.repeat(100)
    const result = runLogging(root, `log(${JSON.stringify(message)})`,
      { DSH_MOBILE_GATEWAY_LOG_MAX_BYTES: String(cap) })
    assert.equal(result.status, 0, result.stderr)
    const file = fs.readFileSync(path.join(root, 'mobile-gateway.log'), 'utf8')
    assert.equal(file.includes('\uFFFD'), false)
    assert.match(file, /\[truncated\]/)
  })
})
