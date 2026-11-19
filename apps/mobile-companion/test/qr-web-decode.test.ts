// Spec 043 — web/PWA pairing QR decode (with reviewer changes).
//
// Root cause: iOS Safari PWA has no native BarcodeDetector, so expo-camera imports `barcode-detector`
// (ZXing WASM). Its default `locateFile` fetches from a CDN, which the PWA CSP blocks; the rejection
// is swallowed and the camera preview opens without ever decoding. We self-host a version+hash
// stamped binary and install the override SYNCHRONOUSLY at module initialization.
//
// No component renderer here (see `test/ui-test-hooks.test.ts`), so panel behaviour is a source
// tripwire plus the real seams; the platform/fetch/build behaviour is executed directly.

import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { existsSync, mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { describe, it } from 'node:test';
import { fileURLToPath, pathToFileURL } from 'node:url';

import { PNG } from 'pngjs';

import { classifyPastedPairing } from '../src/ui/pair-classify';
import { parsePairLinkUrl } from '../src/core/pair-link';
import { CSP, QR_WASM_ASSET, QR_WASM_SHA256, buildPrecacheList, verifyQrWasm } from '../scripts/build-web.mjs';

const APP = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const PANEL = path.join(APP, 'src', 'ui', 'pair-panel.tsx');
const I18N = path.join(APP, 'i18n', 'index.ts');
const SW = path.join(APP, 'public', 'sw.js');
const STAMPED = 'zxing_reader-3.1.6-5003fb4b.wasm';
const STAMPED_PATH = `/${STAMPED}`;
const WASM = path.join(APP, 'public', STAMPED);
const PANEL_SOURCE = readFileSync(PANEL, 'utf8');

// Node 24 has no ImageData/DOMRectReadOnly globals; supply the DOM types the real detector expects.
// The detector itself, its WASM and the QR pixels are NOT stubbed.
const G = globalThis as Record<string, unknown>;
G.ImageData ??= class ImageData {
  constructor(public width: number, public height: number, public data: Uint8ClampedArray) {}
};
G.DOMRectReadOnly ??= class DOMRectReadOnly {
  constructor(public x: number, public y: number, public width: number, public height: number) {}
};

// Offline QR fixture: the PNG `image` returned by the installed zxing-wasm WRITER for FIXTURE_TEXT
// (ecLevel H, scale 6, quiet zones), base64-embedded. pngjs turns it into RGBA that the REAL
// BarcodeDetector accepts as ImageData. Verified: zxing-wasm reader decodes it to FIXTURE_TEXT.
const FIXTURE_TEXT = 'DSH-ORBIT-SPEC-043';
const FIXTURE_PNG_BASE64 = 'iVBORw0KGgoAAAANSUhEUgAAAMYAAADGCAAAAACs8KCBAAADiElEQVR4XmP8zzAcABPDqDcGTwiMxsZgSo2jsTEaG1QPgdFENZqoRhMV9hAYzRujeWM0b4zmjcHfJRktqUZLqtGSarSkGvwlFQsuJzIS7XbkkS6ILogIMhtiGC5Z8uxCduBogTta4I4WuMO6wGXBH7/4x9vxlzCYJRhmeYVsOyV2jZZUoyXVaEk1kksq5LIFf6lCTLsIV+sL2WRMc4iZnRwtqUZLqtGSarSkIi8NIJc5mP1B6q6OGC2pRkuq0ZJqtKQiJg0gl0WY41GYLSXMUSxKUtpoSTVaUo2WVKMlFfHtH1xjU8T0+yDhTF5ba7SkGi2pRkuqkVxSET8rR8y8HjEzg+Slt9GSarSkGi2phnVJReXdNKTOBlJrtGq0pBotqUZLqpHcpkL2O64Rcoga5DIHf/lDTDsN0y786XC0pBotqUZLqtGSCjkEMGfxILKYPTvMEgxXGUW8Xlxl4GhJNVpSjZZUw7qkwtn7w5ybI75NhVx2YZZymO00YvqA+OcKR0uq0ZJqtKQaLakwyxbk9hJmSwn/TB/+MoeY9hVmjIyWVKMl1WhJNaxLKgK7aXCVQhBxzFIFf98QV/mGSxem+tHeH8MQAKP1xmi9QfUQIGrfH3J5hatXiFzaQFyJqxzD9ANmeYirZYXL/6N5YzRvjLapRttUyG0b5FIIOWRwlWD4SznMfiKmmcSkwNGSarSkGi2phnVJRcKIOmYZhdmOQg4rzJ4acqmFqx9HjBrMGBktqUZLqtGSaliXVCzExC+uMXD8pQqmLvwtKGJKudFxKoYhAEbrjdF6g+ohQLU16sSPLOEfP8dlzn+8Xh/NG6N5Y7RNNTLbVIxER/x/IlQSMx5Fqhpka0dLqtGSarSkGpklFcTX+EshzN4fLhFiVCKHM/H9RIiu0ZJqtKQaLalGckkF8Ttm+wr/aDmmLuQeH7JpuFpu+EfAMGNktKQaLalGS6rRkoq8NIBcOiGbgH+cCrmUw2xZ4WrjjZZUoyXVaEk1WlIRkwYwyyXMthNmGYWr7TTa+2MYwmC03hitN6geAizEl0LE242rLYSrr0dMufQfr/WjeWM0b4y2qUZym4qRxOgnpr+Gq/eH3y6I7Gjvbyg0tUbrjdF6g+ohQOUzPwcqhkbzxmjeGG1TDes21WgWH83io1l8NIsP/qb6aEk1WlKNllSjJdVoSUWnEBgtcEcL3NECd1gXuAD544OxiXdrHgAAAABJRU5ErkJggg==';

function qrImageData() {
  const decoded = PNG.sync.read(Buffer.from(FIXTURE_PNG_BASE64, 'base64'));
  const data = new Uint8ClampedArray(decoded.data);
  const Ctor = (globalThis as Record<string, unknown>).ImageData as
    | (new (w: number, h: number, d: Uint8ClampedArray) => object)
    | undefined;
  const image = Ctor
    ? new Ctor(decoded.width, decoded.height, data)
    : { width: decoded.width, height: decoded.height, data };
  Object.defineProperty(image, Symbol.toStringTag, { value: 'ImageData' });
  return image;
}

// ---------------------------------------------------------------------------
// 1. Web setup: same-origin stamped locateFile installed at module init; native no-op.
// ---------------------------------------------------------------------------

describe('qr-decoder.web — synchronous same-origin ZXing WASM', () => {
  it('installs a stamped same-origin locateFile at module init; native is a no-op', async () => {
    const stub = await import('./support/stubs/barcode-detector.stub');
    stub.resetZXingOverrides();
    const web = await import('../src/platform/qr-decoder.web'); // installs at import time

    assert.equal(web.WEB_QR_WASM_PATH, STAMPED_PATH, 'exact stamped path, never a CDN URL');
    assert.equal(stub.installedOverrides.length, 1, 'installed synchronously at module initialization');
    const installed = stub.installedOverrides[0];
    assert.equal(typeof installed?.locateFile, 'function');
    assert.equal(
      installed?.locateFile?.('zxing_reader.wasm', 'https://fastly.jsdelivr.net/npm/zxing-wasm@3.1.6/dist/reader/'),
      STAMPED_PATH,
      'the CDN prefix is never used',
    );
    assert.equal(installed?.locateFile?.('aux.js', '/prefix/'), '/prefix/aux.js', 'non-WASM keeps default');
    assert.deepEqual(web.webQrModuleOverrides().locateFile('zxing_reader.wasm', 'x'), STAMPED_PATH);

    web.configureWebQrDecoder(); // explicit PairPanel call is a belt-and-braces no-op
    assert.equal(stub.installedOverrides.length, 1, 'idempotent: no second installation');

    const native = await import('../src/platform/qr-decoder');
    assert.equal(typeof native.configureWebQrDecoder, 'function', 'same export as the web module');
    assert.equal(native.WEB_QR_WASM_PATH, STAMPED_PATH);
    native.configureWebQrDecoder();
    assert.equal(stub.installedOverrides.length, 1, 'native never touches ZXing overrides');
    assert.equal(native.webQrModuleOverrides(), null, 'native installs no locateFile override');
  });

  it('PairPanel configures at module scope — never from a useEffect', () => {
    assert.match(PANEL_SOURCE, /import \{ configureWebQrDecoder \} from '\.\.\/platform\/qr-decoder'/);
    assert.ok(PANEL_SOURCE.indexOf('configureWebQrDecoder();') < PANEL_SOURCE.indexOf('export function PairPanel'),
      'called at module scope, before any render or effect');
    const effect = PANEL_SOURCE.slice(PANEL_SOURCE.indexOf('useEffect(() => {'), PANEL_SOURCE.indexOf('const submit = useCallback('));
    assert.equal(effect.includes('configureWebQrDecoder'), false, 'no useEffect-based configuration');
  });
});

// ---------------------------------------------------------------------------
// 2. Decoded QR -> submit exactly once; existing classification unchanged.
// ---------------------------------------------------------------------------

describe('decoded QR still follows the existing submit path', () => {
  it('the camera hands scan.data to submit once and keeps scanLocked single-submit', () => {
    const submits = [...PANEL_SOURCE.matchAll(/submit\(scan\.data, lease\)/g)];
    assert.equal(submits.length, 1, 'one decoded QR -> exactly one submit() call');
    const guard = PANEL_SOURCE.indexOf('scanLocked || busy');
    const handler = PANEL_SOURCE.indexOf('submit(scan.data, lease)');
    assert.ok(guard > 0 && guard < handler, 'the scanLocked guard gates the submit');
    assert.match(PANEL_SOURCE, /onBarcodeScanned=\{\s*scanLocked \|\| busy \|\| imageBusy\s*\? undefined/,
      'a locked/busy scanner is disabled rather than re-submitting');
    assert.match(PANEL_SOURCE, /const lease = gate\.acquire\('camera'\);[\s\S]*?setScanLocked\(true\);[\s\S]*?submit\(scan\.data, lease\)/,
      'the synchronous lease is taken before the single submit');
  });

  it('an 8-digit scan fills the OTP field instead of dialling', () => {
    assert.deepEqual(classifyPastedPairing('1213 9679'), { kind: 'code', otp: '12139679' });
    const branch = PANEL_SOURCE.slice(
      PANEL_SOURCE.indexOf("if (pasted.kind === 'code')"),
      PANEL_SOURCE.indexOf('const link = parsePairLinkUrl(raw)'),
    );
    assert.match(branch, /setMode\('otp'\);[\s\S]*setOtpCode\(pasted\.otp\);/, 'the code fills the OTP field');
    assert.match(branch, /setOtpDetected\(true\);\s*return;/, 'it returns before any connection');
    assert.equal(branch.includes('controller.'), false, 'a code fill never reaches the controller');
  });

  it('a /pair# link fills the code only; its address is never adopted', () => {
    const link = parsePairLinkUrl('https://host.example.ts.net:8443/pair#a=attacker.example.com:30081&c=04291375');
    assert.ok(link, 'the link parses');
    assert.equal(link.otp, '04291375');
    assert.equal(link.address, 'attacker.example.com:30081', 'the parser reports what the link said');
    assert.match(PANEL_SOURCE, /setOtpCode\(link\.otp\)/);
    assert.match(PANEL_SOURCE, /if \(Platform\.OS !== 'web'\) \{\s*setOtpAddress\(link\.address\);/);
  });
});

// ---------------------------------------------------------------------------
// 3. Timeout / failure hint and data hygiene.
// ---------------------------------------------------------------------------

describe('scan failure hint (spec 043)', () => {
  it('a 12 s window runs only while the camera is granted and no decode happened', () => {
    assert.match(PANEL_SOURCE, /const QR_SCAN_TIMEOUT_MS = 12_000/);
    assert.match(PANEL_SOURCE, /Platform\.OS !== 'web' \|\| mode !== 'code' \|\| permission\?\.granted !== true/,
      'web-only: native scanning is unchanged, no timer runs there');
    assert.match(PANEL_SOURCE, /\{Platform\.OS === 'web' && scanHintTimedOut \? \(/,
      'the hint renders on web only');
    assert.match(PANEL_SOURCE, /setTimeout\(\(\) => setScanHintTimedOut\(true\), QR_SCAN_TIMEOUT_MS\)/);
    assert.match(PANEL_SOURCE, /return \(\) => clearTimeout\(timer\)/, 'cleanup cancels the timer on unmount / success / dependency change');
  });

  it('a WASM 404 / compile failure is visible as the same hint; manual paste stays usable', () => {
    assert.match(PANEL_SOURCE, /testID="pair-scan-timeout">\{tr\('pair\.scanTimeout'\)\}/);
    assert.match(PANEL_SOURCE, /testID="pair-scan-retry" onPress=\{retryScan\}/);
    assert.match(PANEL_SOURCE, /testID="pair-manual-input"/, 'the manual field stays rendered');
    const i18n = readFileSync(I18N, 'utf8');
    assert.ok(i18n.includes("'pair.scanTimeout': 'Không đọc được mã QR; dùng ô nhập tay'"), 'vi copy');
    assert.ok(i18n.includes("'pair.scanTimeout': 'Could not read the QR; paste the code'"), 'en copy');
    assert.match(i18n, /\| 'pair\.scanTimeout'/, 'typed MessageKey union');
    // Failure is inferred from "no decode": a fetch/compile rejection leaves scanLocked false, so
    // the same bounded window fires. No error payload is ever rendered.
    assert.equal(/scan\.data|raw|exception|error\.message/.test(
      PANEL_SOURCE.slice(PANEL_SOURCE.indexOf('testID="pair-scan-timeout"'), PANEL_SOURCE.indexOf('/>', PANEL_SOURCE.indexOf('testID="pair-scan-timeout"'))),
    ), false, 'the hint carries no decoded string, URL fragment or exception text');
    assert.equal(/console\.(log|warn|error)/.test(PANEL_SOURCE), false, 'no decoded data is logged by the panel');
  });

  it('resets on decode, mode change and retry', () => {
    assert.ok([...PANEL_SOURCE.matchAll(/setScanHintTimedOut\(false\)/g)].length >= 5);
    assert.match(PANEL_SOURCE, /setScanHintTimedOut\(false\);\s*setScanLocked\(true\);/, 'success clears it');
    assert.match(PANEL_SOURCE, /const retryScan = useCallback\(\(\) => \{[\s\S]*?setScanRetryNonce/,
      'retry restarts the window');
    for (const mode of ['code', 'otp']) {
      assert.match(PANEL_SOURCE,
        new RegExp(`onPress=\\{\\(\\) => \\{[^\\n]*setMode\\('${mode}'\\); setOtpDetected\\(false\\); setScanHintTimedOut\\(false\\)`),
        `the ${mode} tab clears it`);
    }
  });
});

// ---------------------------------------------------------------------------
// 4. Same-origin fallback: native detector absent, CDN blocked.
// ---------------------------------------------------------------------------

describe('fallback: real BarcodeDetector, no native API, CDN blocked', () => {
  /**
   * Loads the ACTUAL published package (absolute file URL bypasses the Node test stub hook), so the
   * detector, its cached WASM module and the override are the same objects expo-camera would use.
   */
  async function realDecoder() {
    return import(pathToFileURL(path.join(APP, 'node_modules', 'barcode-detector', 'dist', 'es', 'index.js')).href);
  }

  it('decodes a QR fixture to its rawValue using only the same-origin WASM', async () => {
    const originalFetch = globalThis.fetch;
    const globals = globalThis as Record<string, unknown>;
    const originalDetector = globals.BarcodeDetector;
    const originalRect = globals.DOMRectReadOnly;
    const requested: string[] = [];
    const bytes = readFileSync(WASM);
    try {
      delete globals.BarcodeDetector; // iOS PWA: no native BarcodeDetector
      globals.DOMRectReadOnly ??= class { constructor(public x: number, public y: number, public width: number, public height: number) {} };
      globalThis.fetch = (async (input: RequestInfo | URL) => {
        const url = String(input);
        requested.push(url);
        if (/jsdelivr|unpkg|cdn\./i.test(url)) throw new Error('CDN blocked by CSP');
        if (url !== STAMPED_PATH) throw new Error(`unexpected same-origin request: ${url}`);
        return new Response(bytes, { status: 200, headers: { 'content-type': 'application/wasm' } });
      }) as typeof fetch;

      const real = await realDecoder();
      const web = await import('../src/platform/qr-decoder.web');
      real.setZXingModuleOverrides(web.webQrModuleOverrides());
      const detector = new real.BarcodeDetector({ formats: ['qr_code'] as never });
      const results = await detector.detect(qrImageData() as never);
      assert.ok(results.length >= 1, `the real detector decoded the fixture (got ${results.length})`);
      assert.equal(results[0]?.rawValue, FIXTURE_TEXT, 'the QR rawValue is the fixture payload');
      assert.equal(requested.includes(STAMPED_PATH), true, 'the stamped same-origin WASM was fetched');
      assert.equal(requested.some((url) => /jsdelivr|unpkg|cdn\./i.test(url)), false, 'no CDN request was made');
    } finally {
      globalThis.fetch = originalFetch;
      globals.BarcodeDetector = originalDetector;
      globals.DOMRectReadOnly = originalRect;
    }
  });

  it('a WASM 404 makes the real detector fail (no decode), so the panel hint is the fallback', async () => {
    const originalFetch = globalThis.fetch;
    const globals = globalThis as Record<string, unknown>;
    const originalDetector = globals.BarcodeDetector;
    try {
      delete globals.BarcodeDetector;
      globalThis.fetch = (async (input: RequestInfo | URL) => {
        const url = String(input);
        if (/jsdelivr|unpkg|cdn\./i.test(url)) throw new Error('CDN blocked by CSP');
        return new Response('not found', { status: 404 });
      }) as typeof fetch;
      const real = await realDecoder();
      // A fresh module instance is not reusable here (the previous test cached the working module),
      // so assert the failure contract at the decoder boundary: no result -> panel's no-decode timer.
      real.purgeZXingModule();
      real.setZXingModuleOverrides({ locateFile: () => STAMPED_PATH });
      const detector = new real.BarcodeDetector({ formats: ['qr_code'] as never });
      let failed = false;
      try { await detector.detect(qrImageData() as never); } catch { failed = true; }
      assert.equal(failed, true, 'a 404 WASM yields no decode');
      // The panel maps "no decode within 12 s" to the visible hint (source-tripwired above), with
      // the manual field rendered independently — no exception payload is ever interpolated.
      assert.match(PANEL_SOURCE, /testID="pair-scan-timeout">\{tr\('pair\.scanTimeout'\)\}/);
      assert.match(PANEL_SOURCE, /testID="pair-manual-input"/);
    } finally {
      globalThis.fetch = originalFetch;
      globals.BarcodeDetector = originalDetector;
    }
  });
});

// ---------------------------------------------------------------------------
// 5. Stamped asset, SW allowlist, upgrade + offline reload, narrow CSP.
// ---------------------------------------------------------------------------

describe('self-hosted WASM, service worker and CSP (spec 043)', () => {
  it('ships the exact stamped binary, byte-for-byte with the installed package', () => {
    assert.ok(existsSync(WASM), `${STAMPED} exists for Expo to export`);
    assert.ok(statSync(WASM).size > 100_000, 'the real decoder binary, not a stub');
    const digest = createHash('sha256').update(readFileSync(WASM)).digest('hex');
    assert.equal(digest, '5003fb4b88c4fbd1fd518a2fd8c8ad365c519e183a08c03a322dddfea3cea84e');
    const nodeCopy = path.join(APP, 'node_modules', 'zxing-wasm', 'dist', 'reader', 'zxing_reader.wasm');
    assert.equal(readFileSync(WASM).equals(readFileSync(nodeCopy)), true);
  });

  it('CSP permits WASM compilation and admits no external origin', () => {
    assert.ok(CSP.includes("script-src 'self' 'wasm-unsafe-eval'"));
    assert.equal(/jsdelivr|unpkg|cdn\./i.test(CSP), false, 'no CDN origin');
    assert.match(CSP, /connect-src 'self' wss:\/\/\*\.ts\.net:\*/, 'connect-src unchanged');
    assert.equal(CSP.includes('https:'), false, 'no blanket https: source');
    assert.match(CSP, /object-src 'none'/, 'hardening kept');
    // DEV PARITY: serve-web.mjs sends this exact policy as the authoritative HTTP header on the
    // dev origin. Read the REAL exported constant with native Node ESM in a child process — a plain
    // `import` here fails top-level await under tsx's CJS transform. No source-only regex.
    const devUrl = pathToFileURL(path.join(APP, 'scripts', 'serve-web.mjs')).href;
    const dev = JSON.parse(execFileSync(process.execPath, ['-e',
      `import(${JSON.stringify(devUrl)}).then(m => process.stdout.write(JSON.stringify({ csp: m.CSP, wasmType: m.typeFor('${STAMPED}') })))`],
      { encoding: 'utf8', timeout: 10_000 }));
    const devCsp = dev.csp;
    assert.equal(dev.wasmType, 'application/wasm', 'dev server serves the stamped WASM with the streaming-compile MIME');
    assert.equal(devCsp, CSP, 'dev server CSP header matches the built HTML meta exactly');
    assert.ok(devCsp.includes("script-src 'self' 'wasm-unsafe-eval'"), 'dev header carries the WASM token');
    assert.equal(devCsp.includes("'unsafe-eval'"), false, 'dev header admits no general JS eval');
    assert.equal(/jsdelivr|unpkg|cdn\./i.test(devCsp), false, 'dev header admits no CDN origin');
  });

  it('SW allowlists the exact stamped path — never *.wasm, never /pair — and bumps its cache', () => {
    const sw = readFileSync(SW, 'utf8');
    assert.ok(sw.includes(`'${STAMPED_PATH}'`), 'the exact stamped path is a shell asset');
    assert.equal(/\*\.wasm|\\\.wasm|\/wasm/.test(sw), false, 'no generic WASM allowlist');
    assert.match(sw, /const CACHE = 'dsh-shell-v6'/, 'v6 so an old PWA drops the stale decoder');
    // Upgrade: install precaches the exact entry; activate deletes every other cache name.
    assert.match(sw, /const cache = await caches\.open\(CACHE\)/);
    assert.match(sw, /names\.filter\(\(name\) => name !== CACHE\)\.map\(\(name\) => caches\.delete\(name\)\)/,
      'old v5 cache is deleted on activate');
    // Offline reload: the navigation handler falls back to the cached shell.
    assert.match(sw, /cache\.match\(new URL\('\/', self\.location\.origin\)\.href\)/);
    assert.match(sw, /'offline and no cached shell'/, 'honest failure when there is no shell');
    assert.match(sw, /NEVER_CACHE = \[[^\]]*'\/pair'/);
  });

  it('SW behavioural: exact WASM path caches, suffixed path does not; upgrade drops old cache', async () => {
    const vm = await import('node:vm');
    const swSource = readFileSync(SW, 'utf8');
    const handlers: Record<string, (event: unknown) => unknown> = {};
    const deleted: string[] = [];
    const responded: string[] = [];
    const stored: string[] = [];
    const cache = { put: async (url: string) => { stored.push(url); }, match: async () => undefined };
    const self = {
      location: { origin: 'https://host.example.ts.net' },
      addEventListener: (name: string, fn: (event: unknown) => unknown) => { handlers[name] = fn; },
      skipWaiting: async () => {},
      clients: { claim: async () => {}, matchAll: async () => [] },
      registration: { showNotification: async () => {} },
      navigator: { language: 'en' },
    };
    const ctx = {
      self,
      URL,
      caches: { open: async () => cache, keys: async () => ['dsh-shell-v5', 'dsh-shell-v6'], delete: async (n: string) => { deleted.push(n); } },
      fetch: async (input: unknown) => {
        const url = String(input);
        if (url === '/precache.json') return { ok: true, json: async () => ['/', '/icon.svg'] };
        return { ok: true, clone: () => ({}), headers: { get: () => 'text/html' } };
      },
      console,
    };
    vm.runInNewContext(swSource, ctx);

    // Fetch handler: exact stamped path is a shell asset; a suffixed path is NOT.
    for (const pathname of [STAMPED_PATH, `${STAMPED_PATH}.anything`]) {
      let respondedHere = false;
      handlers.fetch?.({
        request: { method: 'GET', url: `https://host.example.ts.net${pathname}`, mode: 'no-cors', headers: { has: () => false } },
        respondWith: (p: unknown) => { respondedHere = true; void p; },
      });
      if (pathname === STAMPED_PATH) assert.equal(respondedHere, true, 'exact stamped WASM is cache-first');
      else assert.equal(respondedHere, false, 'a suffixed WASM path must NOT be cached');
    }
    // Activate deletes the previous cache generation (old PWA -> new decoder).
    let activated: Promise<unknown> | undefined;
    handlers.activate?.({ waitUntil: (p: Promise<unknown>) => { activated = p; } });
    await activated;
    assert.deepEqual(deleted, ['dsh-shell-v5'], 'v5 is dropped on upgrade');
  });

  it('the build hard-fails on a missing or altered WASM asset', () => {
    assert.equal(QR_WASM_ASSET, STAMPED);
    assert.equal(QR_WASM_SHA256, '5003fb4b88c4fbd1fd518a2fd8c8ad365c519e183a08c03a322dddfea3cea84e');
    assert.equal(verifyQrWasm(APP + path.sep + 'public'), QR_WASM_SHA256, 'the real public asset verifies');
    const empty = mkdtempSync(path.join(tmpdir(), 'qr-wasm-missing-'));
    const corrupt = mkdtempSync(path.join(tmpdir(), 'qr-wasm-bad-'));
    try {
      assert.throws(() => verifyQrWasm(empty), /REQUIRED decoder asset missing/, 'missing file fails the build');
      writeFileSync(path.join(corrupt, STAMPED), 'not a wasm');
      assert.throws(() => verifyQrWasm(corrupt), /SHA-256 .* != pinned/, 'wrong bytes fail the build');
    } finally {
      rmSync(empty, { recursive: true, force: true });
      rmSync(corrupt, { recursive: true, force: true });
    }
  });

  it('the build checks and precaches the stamped binary', () => {
    const build = readFileSync(path.join(APP, 'scripts', 'build-web.mjs'), 'utf8');
    assert.ok(build.includes(`'${STAMPED}'`), 'the build asserts/precache-lists the exact name');
    const list = buildPrecacheList(['manifest.json', 'icon.svg', 'icon-maskable.svg', 'register-sw.js', STAMPED, 'sw.js']);
    assert.ok(list.includes(STAMPED_PATH), 'precached as a same-origin shell asset');
  });
});
