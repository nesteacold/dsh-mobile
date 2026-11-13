// Roadmap P1-1: a wire kind/code that the contract exports must be spelled through the contract
// constant by the gateway and the app, never as a quoted literal of its own. This scan fails when
// one of the guarded literals below reappears ('...' or "...") in a runtime source file outside
// this package. Whole comment lines are not matched. Grow GUARDED as more constants are adopted.
import { test } from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import * as contract from '../src/index.mjs'

const repo = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../../..')

const GUARDED = [
  contract.PASSKEY_LOCK_TYPE,
  contract.PASSKEY_REGISTER_OPTIONS_TYPE,
  contract.PASSKEY_REGISTER_TYPE,
  contract.PASSKEY_ASSERT_OPTIONS_TYPE,
  contract.PASSKEY_ASSERT_TYPE,
  contract.PASSKEY_APPROVAL_KIND,
  contract.WEB_LOCK_ERROR,
  ...contract.PASSKEY_ERROR_CODES,
]

/** Runtime source roots (tests and fixtures may spell wire bytes on purpose). */
const ROOTS = [
  { dir: 'plugins/mobile-gateway/lib', skip: /[\\/]vendor[\\/]/ },
  { dir: 'apps/mobile-companion/src' },
  { dir: 'apps/mobile-companion/app' },
]
const EXT = /\.(mjs|cjs|js|ts|tsx)$/

function* walk(dir, skip) {
  if (!fs.existsSync(dir)) return
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    const full = path.join(dir, entry.name)
    if (skip?.test(full) || entry.name === 'node_modules') continue
    if (entry.isDirectory()) yield* walk(full, skip)
    else if (EXT.test(entry.name)) yield full
  }
}

test('every guarded literal is a string the contract exports', () => {
  for (const value of GUARDED) assert.equal(typeof value, 'string')
})

test('guarded wire kind/code literals appear only in packages/mobile-protocol', () => {
  const offences = []
  let scanned = 0
  for (const { dir, skip } of ROOTS) {
    for (const file of walk(path.join(repo, dir), skip)) {
      scanned++
      const lines = fs.readFileSync(file, 'utf8').split(/\r?\n/)
      lines.forEach((line, i) => {
        if (/^\s*(\/\/|\/?\*)/.test(line)) return // comment lines document the wire, they do not speak it
        for (const value of GUARDED) {
          if (line.includes(`'${value}'`) || line.includes(`"${value}"`)) {
            offences.push(`${path.relative(repo, file)}:${i + 1}: ${value}`)
          }
        }
      })
    }
  }
  assert.ok(scanned > 0, 'no source files scanned — roots moved?')
  assert.deepEqual(offences, [], `use the packages/mobile-protocol constant instead:\n${offences.join('\n')}`)
})
