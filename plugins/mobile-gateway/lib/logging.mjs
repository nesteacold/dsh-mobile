import { appendFileSync, lstatSync, renameSync, statSync, unlinkSync } from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { redactLine } from './redact.mjs'

export const LOG_FILE = path.join(os.tmpdir(), 'mobile-gateway.log')
export const MAX_LOG_BYTES = 10 * 1024 * 1024

const ROTATED_LOG_FILE = `${LOG_FILE}.1`
const TRUNCATION_MARKER = '[truncated]\n'

// The override is a deterministic-test seam; a malformed value must never
// turn the cap off.
function logLimit() {
  const raw = process.env.DSH_MOBILE_GATEWAY_LOG_MAX_BYTES
  if (raw === undefined || raw === '') return MAX_LOG_BYTES
  const value = Number(raw)
  return Number.isSafeInteger(value) && value > 0 ? value : MAX_LOG_BYTES
}

// Redaction already happened in log(), so a bounded copy cannot expose a secret.
function fitEntry(message, maxBytes) {
  const entry = message + '\n'
  if (Buffer.byteLength(entry, 'utf8') <= maxBytes) return entry
  const markerBytes = Buffer.byteLength(TRUNCATION_MARKER, 'utf8')
  if (maxBytes <= markerBytes) return null
  const budget = maxBytes - markerBytes
  const bytes = Buffer.from(message, 'utf8')
  let end = Math.min(budget, bytes.length)
  // Never cut in the middle of a multi-byte character (U+FFFD in the log).
  while (end > 0 && (bytes[end] & 0xc0) === 0x80) end -= 1
  return bytes.subarray(0, end).toString('utf8') + TRUNCATION_MARKER
}

// Only our own rotation target is replaced. POSIX rename would replace a
// symlink or directory too, so refuse a non-regular destination explicitly:
// the caller then skips the append instead of touching an unrelated file.
function rotate() {
  let previous
  try {
    previous = lstatSync(ROTATED_LOG_FILE)
  } catch (error) {
    if (error?.code !== 'ENOENT') throw error
  }
  if (previous) {
    if (!previous.isFile()) throw new Error(`rotation target is not a regular file: ${ROTATED_LOG_FILE}`)
    unlinkSync(ROTATED_LOG_FILE)
  }
  renameSync(LOG_FILE, ROTATED_LOG_FILE)
}

// Every line is redacted once, here, before it reaches stdout or the file
// (FR-012): bearer tokens / Authorization headers, pairing codes, device
// tokens, `arguments`/`argsPreview` payloads and credential query parameters.
export function log(line) {
  const message = `[${new Date().toISOString()}] ${redactLine(line)}`
  console.log('mobile-gateway:', message)
  try {
    const maxBytes = logLimit()
    const entry = fitEntry(message, maxBytes)
    if (entry === null) return
    // Stat on every write: another gateway process can share this temp file,
    // so a cached size would go stale and miss the cap.
    let size = 0
    try {
      size = statSync(LOG_FILE).size
    } catch (error) {
      if (error?.code !== 'ENOENT') throw error
    }
    if (size > 0 && size + Buffer.byteLength(entry, 'utf8') > maxBytes) rotate()
    appendFileSync(LOG_FILE, entry)
  } catch (error) {
    // 文件日志失败不能中断网关，stderr 仍保留诊断信息。
    // A failed rotation deliberately skips the append: never grow an oversize file.
    console.error(`mobile-gateway: cannot write log file ${LOG_FILE}: ${error?.message || String(error)}`)
  }
}
