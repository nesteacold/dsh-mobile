// Asset-fix (2026-11-17): Expo dynamic-route chunks are emitted as `[id]-<hash>.js` and loaded by
// the PWA either with literal brackets or with `%5B`/`%5D`. These are EXECUTABLE tests: they build a
// real dist tree, take a real snapshot, and drive `serveWebAsset` with real request/response shapes.
// No source-regex assertions. Every pre-existing fence is re-checked against the widened allowlist.
import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import test from 'node:test'
import { assetTypeFor, buildAssetSnapshot, serveWebAsset } from '../lib/web-assets.mjs'

const temp = fs.mkdtempSync(path.join(os.tmpdir(), 'dsh-web-assets-'))
const HASH = 'ce9e0cef980d6a1cd4de7a81795852c0'
const CHUNK = `[id]-${HASH}.js`
const CHUNK_PATH = `/_expo/static/js/web/${CHUNK}`
const CHUNK_BODY = '/* dynamic route chunk */\nconsole.log("ok")\n'
const STAMPED_WASM = 'zxing_reader-3.1.6-5003fb4b.wasm'
const WASM_PATH = `/${STAMPED_WASM}`
const WASM_BODY = 'WASM-FIXTURE-BYTES'

fs.mkdirSync(path.join(temp, '_expo', 'static', 'js', 'web'), { recursive: true })
// The app's built entry also carries the same policy as a <meta> (spec 043, scripts/build-web.mjs).
// Kept here so the served-header-vs-meta parity check below reads a REAL served response body.
const META_CSP = [
  "default-src 'self'", "script-src 'self' 'wasm-unsafe-eval'", "style-src 'self' 'unsafe-inline'",
  "img-src 'self' data: blob:", "font-src 'self' data:", "connect-src 'self' wss://*.ts.net:*",
  "manifest-src 'self'", "object-src 'none'", "base-uri 'none'", "form-action 'self'",
  "frame-ancestors 'none'",
].join('; ')
fs.writeFileSync(path.join(temp, 'index.html'),
  `<!doctype html><title>pwa</title><meta http-equiv="Content-Security-Policy" content="${META_CSP}">`)
fs.writeFileSync(path.join(temp, CHUNK_PATH.slice(1)), CHUNK_BODY)
fs.writeFileSync(path.join(temp, STAMPED_WASM), WASM_BODY)
// Decoys the PRE-EXISTING admission rules reject: a leading-dot file, a device name, a source map,
// a name with a space and a non-ASCII name. (A plain `x.env`/`other.js` is legitimately admitted by
// the unchanged rules; the widening here is only about brackets.)
fs.writeFileSync(path.join(temp, '.env'), 'DOTFILE-MUST-NOT-BE-SERVED')
fs.writeFileSync(path.join(temp, 'nul.txt'), 'DEVICE-MUST-NOT-BE-SERVED')
fs.writeFileSync(path.join(temp, 'other.js.map'), 'MAP-MUST-NOT-BE-SERVED')
fs.writeFileSync(path.join(temp, 'bad name.js'), 'SPACE-MUST-NOT-BE-SERVED')
fs.writeFileSync(path.join(temp, 'caf\u00e9.js'), 'UNICODE-MUST-NOT-BE-SERVED')
// A bracketed SOURCE MAP: brackets are now admitted, but the `.map` refusal must still win.
fs.writeFileSync(path.join(temp, CHUNK_PATH.slice(1).replace('.js', '.map')), 'MAP-MUST-NOT-BE-SERVED')
// Admin-prefix decoys that the SNAPSHOT DOES admit (plain names). If a 404 here came from an absent
// key the test would be vacuous; these prove the prefix GUARD, not the snapshot's admission rules.
for (const dir of ['mgw', 'api', 'dsh']) {
  fs.mkdirSync(path.join(temp, dir), { recursive: true })
  fs.writeFileSync(path.join(temp, dir, 'x.js'), `PREFIX-${dir}-MUST-NOT-BE-SERVED`)
}

const built = buildAssetSnapshot(fs.realpathSync(temp))
/** A minimal response double: records the status/headers/body `serveWebAsset` writes. */
const answer = (req) => {
  const out = { status: null, headers: null, body: undefined }
  const res = {
    writeHead(status, headers) { out.status = status; out.headers = headers; return this },
    end(body) { out.body = body; return this },
  }
  serveWebAsset(req, res, built)
  return out
}
const get = (target, method = 'GET') => answer({ method, url: target })
const text = (out) => (out.body === undefined ? '' : String(out.body))

test('snapshot admits a bracketed Expo dynamic-route chunk and keeps every other admission fence', () => {
  assert.equal(built.error, null, `snapshot must be stable: ${built.error}`)
  assert.equal(built.snapshot.has(CHUNK_PATH), true,
    `snapshot keys: ${JSON.stringify([...built.snapshot.keys()])}`)
  assert.equal(built.snapshot.get(CHUNK_PATH).body.toString('utf8'), CHUNK_BODY)
  assert.equal(assetTypeFor(CHUNK_PATH), 'text/javascript; charset=utf-8')
  assert.equal(built.snapshot.has(WASM_PATH), true, 'the stamped WASM is in the snapshot')
  assert.equal(assetTypeFor(WASM_PATH), 'application/wasm', 'streaming compile MIME')
  // Widening brackets must not admit dotfiles, source maps (even bracketed ones) or other decoys.
  for (const absent of ['/.env', '/nul.txt', '/other.js.map', '/bad name.js', '/caf\u00e9.js',
    '/_expo/static/js/web/other.js', CHUNK_PATH.replace('.js', '.map')]) {
    assert.equal(built.snapshot.has(absent), false, absent)
  }
  // Positive control for the prefix test below: these ARE in the snapshot, so a 404 there can only
  // come from the management-prefix guard.
  for (const present of ['/mgw/x.js', '/api/x.js', '/dsh/x.js']) {
    assert.equal(built.snapshot.has(present), true, present)
  }
})

test('GET raw brackets: 200, correct JS content-type, exact chunk body', () => {
  const out = get(CHUNK_PATH)
  assert.equal(out.status, 200)
  assert.equal(out.headers['Content-Type'], 'text/javascript; charset=utf-8')
  assert.equal(out.headers['Content-Length'], Buffer.byteLength(CHUNK_BODY))
  assert.equal(text(out), CHUNK_BODY)
})

test('served CSP header permits same-origin WASM, keeps every other directive, and matches the served meta', () => {
  // Executed against the real response double (the same seam as all other tests here), never a
  // source-only regex: the browser enforces THIS HEADER over the <meta> in the HTML.
  const scriptSrc = (csp) => csp.split(';').map((directive) => directive.trim())
    .find((directive) => directive.startsWith('script-src '))
  const expected = "script-src 'self' 'wasm-unsafe-eval'"
  for (const target of ['/index.html', CHUNK_PATH]) {
    const out = get(target)
    assert.equal(out.status, 200, target)
    const header = out.headers['Content-Security-Policy']
    assert.ok(header, `${target} carries a CSP header`)
    assert.equal(scriptSrc(header), expected, `${target}: ${header}`)
    // `'wasm-unsafe-eval'` is tokenised; a bare `'unsafe-eval'` would be general JS eval.
    assert.equal(header.includes("'unsafe-eval'"), false, `${target}: no general JS eval`)
    assert.equal(/jsdelivr|unpkg|cdn\./i.test(header), false, `${target}: no CDN origin`)
    assert.equal(header.includes('https:'), false, `${target}: no blanket https: source`)
    for (const directive of [
      "default-src 'self'", "style-src 'self' 'unsafe-inline'", "img-src 'self' data: blob:",
      "font-src 'self' data:", "connect-src 'self' wss://*.ts.net:*", "manifest-src 'self'",
      "object-src 'none'", "base-uri 'none'", "form-action 'self'", "frame-ancestors 'none'",
    ]) assert.ok(header.includes(directive), `${target}: missing ${directive}`)
  }
  const served = get('/index.html')
  const meta = text(served).match(/<meta http-equiv="Content-Security-Policy" content="([^"]+)">/)?.[1]
  assert.ok(meta, 'the served HTML carries a meta CSP')
  assert.equal(scriptSrc(meta), scriptSrc(served.headers['Content-Security-Policy']),
    'the header script-src matches the meta script-src')
})

test('stamped same-origin WASM is served with application/wasm (no streaming-compile warning)', () => {
  const out = get(WASM_PATH)
  assert.equal(out.status, 200)
  assert.equal(out.headers['Content-Type'], 'application/wasm')
  assert.equal(out.headers['Content-Security-Policy'].includes("script-src 'self' 'wasm-unsafe-eval'"), true)
  assert.equal(text(out), WASM_BODY)
})

test('GET percent-encoded brackets (%5B/%5D, both hex cases): 200, same body', () => {
  for (const target of [
    CHUNK_PATH.replace('[', '%5B').replace(']', '%5D'),
    CHUNK_PATH.replace('[', '%5b').replace(']', '%5d'),
    CHUNK_PATH.replace('[', '%5B').replace(']', '%5d'),
  ]) {
    const out = get(target)
    assert.equal(out.status, 200, target)
    assert.equal(out.headers['Content-Type'], 'text/javascript; charset=utf-8', target)
    assert.equal(text(out), CHUNK_BODY, target)
  }
})

test('query string survives: encoded bracket chunk with ?query still 200', () => {
  const out = get(`${CHUNK_PATH.replace('[', '%5B').replace(']', '%5D')}?v=1`)
  assert.equal(out.status, 200)
  assert.equal(text(out), CHUNK_BODY)
})

test('HEAD on the bracketed chunk has GET headers and no body', () => {
  const out = get(CHUNK_PATH, 'HEAD')
  assert.equal(out.status, 200)
  assert.equal(out.headers['Content-Type'], 'text/javascript; charset=utf-8')
  assert.equal(out.headers['Content-Length'], Buffer.byteLength(CHUNK_BODY))
  assert.equal(out.body, undefined)
})

test('traversal, ADS, encoded separators/dots, backslash and control bytes stay refused', () => {
  const attacks = [
    '/../secret.env',
    '/_expo/static/js/web/../../secret.env',
    '/%2e%2e/secret.env',
    '/..%2fsecret.env',
    '/%2fsecret.env',
    '/index.html%00.js',
    '/index.html::$DATA',
    '/index.html%3a%3a%24DATA',
    '/a\\b.js',
    '/index%20.html',
    '/%25index.html',
    '/_expo/static/js/web/%5Bid%5D-other.js',
  ]
  for (const target of attacks) {
    const out = get(target)
    assert.equal(out.status, 404, `${target} -> ${out.status}`)
    assert.equal(text(out).includes('MUST-NOT-BE-SERVED'), false, target)
  }
  // A request that is not in the snapshot is a 404 even with admitted bracket syntax.
  assert.equal(get('/[different]-hash.js').status, 404)
})

test('management / DSH / WS prefixes are never served, bracketed or not', () => {
  // `/mgw/x.js`, `/api/x.js` and `/dsh/x.js` really exist in the snapshot (positive control above):
  // a 404 must come from the prefix guard, not from a missing key.
  for (const target of ['/mgw/x.js', '/api/x.js', '/dsh/x.js', '/MGW/x.js', '/API/x.js', '/Dsh/x.js',
    '/mgw', '/api', '/dsh', '/mgw%5Bx%5D/x.js', '/ws/mobile', '/WS/mobile']) {
    const out = get(target)
    assert.equal(out.status, target.toLowerCase().startsWith('/ws') ? 426 : 404, target)
    assert.equal(text(out).includes('MUST-NOT-BE-SERVED'), false, target)
  }
})

test('a bracketed source map is refused at both snapshot and serve time', () => {
  const mapPath = CHUNK_PATH.replace('.js', '.map')
  assert.equal(built.snapshot.has(mapPath), false)
  assert.equal(get(mapPath).status, 404)
  assert.equal(get(mapPath.replace('[', '%5B').replace(']', '%5D')).status, 404)
})

test('non-GET/HEAD is 405; no decoy file is ever reachable through the widened gate', () => {
  for (const method of ['POST', 'PUT', 'DELETE', 'PATCH']) {
    const out = get(CHUNK_PATH, method)
    assert.equal(out.status, 405, method)
    assert.equal(out.headers.Allow, 'GET, HEAD')
  }
  for (const target of ['/.env', '/nul.txt', '/other.js.map', '/bad name.js', '/caf\u00e9.js',
    '/_expo/static/js/web/other.js']) {
    assert.equal(built.snapshot.has(target), false, target)
    assert.equal(get(target).status, 404, target)
  }
})
