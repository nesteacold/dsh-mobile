// Spec 044 — behavioural + source tests for the web attachment byte seam.
//
// There is no component renderer here: the seam is a pure module and is exercised directly with
// fake picker assets (a DOM-File-shaped object or a base64 data URL). The screen-side ownership,
// object-URL and copy wiring is checked against its source, in the established style of
// `session-controls-041.test.ts`. No Host, socket or real picker is involved.

import assert from 'node:assert/strict';
import { readFileSync, statSync } from 'node:fs';
import { createRequire } from 'node:module';
import path from 'node:path';
import { describe, it } from 'node:test';
import { fileURLToPath } from 'node:url';

import { registerPickedObjectUrl } from '../app/session/[id]';
import { MESSAGES } from '../i18n';
import { CLIENT_UPLOAD_MAX_BYTES } from '../src/core/remote-upload';
import { isCurrentUpload, ownsUpload } from '../src/ui/conversation/upload-lifecycle';
import {
  decodeBase64DataUrl,
  isPickerObjectUrl,
  PickedFileAsset,
  PickedFileError,
  readPickedFile,
  revokePickerObjectUrl,
} from '../src/platform/picked-file.web';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const APP = path.resolve(HERE, '..');
const WEB_SEAM = path.join(APP, 'src', 'platform', 'picked-file.web.ts');
const NATIVE_SEAM = path.join(APP, 'src', 'platform', 'picked-file.ts');
const SCREEN = path.join(APP, 'app', 'session', '[id].tsx');
const webSource = readFileSync(WEB_SEAM, 'utf8');
const nativeSource = readFileSync(NATIVE_SEAM, 'utf8');
const screen = readFileSync(SCREEN, 'utf8');

const ALL_BYTES = Uint8Array.from({ length: 256 }, (_value, index) => index);
const dataUrl = (bytes: Uint8Array): string =>
  `data:image/png;base64,${Buffer.from(bytes).toString('base64')}`;

function codeOf(error: unknown): string | undefined {
  return (error as { code?: string } | null)?.code;
}

function fakeDomFile(overrides: Record<string, unknown> = {}): PickedFileAsset['file'] {
  return {
    name: 'picked.png',
    type: 'image/png',
    size: ALL_BYTES.length,
    arrayBuffer: async () => ALL_BYTES.buffer.slice(0) as ArrayBuffer,
    ...overrides,
  } as NonNullable<PickedFileAsset['file']>;
}

describe('spec 044 — web seam reads the picked DOM File', () => {
  it('produces exactly the picked bytes and prefers DOM File metadata', async () => {
    const asset = {
      uri: 'blob:https://pwa.invalid/pick-1',
      name: 'picker-name.png',
      mimeType: 'application/octet-stream',
      size: ALL_BYTES.length,
      file: fakeDomFile(),
    } as unknown as PickedFileAsset;
    const result = await readPickedFile(asset, { timeoutMs: 1000 });
    assert.deepEqual(Array.from(result.bytes), Array.from(ALL_BYTES));
    assert.equal(result.name, 'picked.png', 'the DOM File name wins over untrusted asset metadata');
    assert.equal(result.mediaType, 'image/png', 'the DOM File type wins; no MIME is inferred');
    assert.equal(/from\s+['"]expo-file-system['"]|require\(['"]expo-file-system['"]\)/.test(webSource), false,
      'no expo-file-system import on web');
    assert.equal(webSource.includes('require('), false, 'no runtime require on web');
    assert.ok(webSource.includes('file.arrayBuffer()'), 'the DOM File is the preferred byte source');
  });

  it('admits the DOM File.size BEFORE arrayBuffer is called', async () => {
    let reads = 0;
    const asset = {
      uri: 'blob:https://pwa.invalid/pick-2',
      size: 10,
      file: fakeDomFile({
        size: CLIENT_UPLOAD_MAX_BYTES + 1,
        arrayBuffer: async () => { reads += 1; return ALL_BYTES.buffer.slice(0) as ArrayBuffer; },
      }),
    } as unknown as PickedFileAsset;
    await assert.rejects(() => readPickedFile(asset), (error: unknown) =>
      codeOf(error) === 'file-too-large');
    assert.equal(reads, 0, 'an oversized pick is refused without allocating its bytes');
  });

  it('also admits a reported asset.size before the DOM File read', async () => {
    let reads = 0;
    const asset = {
      uri: 'blob:https://pwa.invalid/pick-3',
      size: CLIENT_UPLOAD_MAX_BYTES + 1,
      file: fakeDomFile({ arrayBuffer: async () => { reads += 1; return ALL_BYTES.buffer.slice(0); } }),
    } as unknown as PickedFileAsset;
    await assert.rejects(() => readPickedFile(asset), (error: unknown) =>
      codeOf(error) === 'file-too-large');
    assert.equal(reads, 0);
  });
});

describe('spec 044 — base64 fallback', () => {
  it('decodes 0x00–0xFF and 1/2-byte padding to the exact bytes', async () => {
    for (const bytes of [ALL_BYTES, Uint8Array.from([7]), Uint8Array.from([7, 8]), Uint8Array.from([7, 8, 9])]) {
      const asset = { name: 'fallback.bin', base64: dataUrl(bytes), size: bytes.length } as unknown as PickedFileAsset;
      const result = await readPickedFile(asset);
      assert.deepEqual(Array.from(result.bytes), Array.from(bytes));
      assert.equal(result.name, 'fallback.bin');
      assert.equal(result.mediaType, undefined, 'a data-URL header is never used as MIME');
    }
  });

  it('refuses malformed/non-data URLs and empty payloads without leaking details', async () => {
    for (const value of [
      'https://pwa.invalid/file.png',
      'data:image/png,payload',
      'data:image/png;base64,@@bad',
      'data:image/png;base64,AAAA AAAA',
      'data:image/png;base64,A',
      'data:image/png;base64,',
      null,
    ]) {
      await assert.rejects(
        () => readPickedFile({ base64: value as string | null } as unknown as PickedFileAsset),
        (error: unknown) => error instanceof PickedFileError
          && (codeOf(error) === 'read-failed' || codeOf(error) === 'no-file')
          && !JSON.stringify(error).includes('pwa.invalid'),
      );
    }
  });

  it('checks the encoded/decoded length BEFORE atob allocates its binary string', () => {
    const original = globalThis.atob;
    let atobCalls = 0;
    globalThis.atob = (() => { atobCalls += 1; throw new Error('must not be called'); }) as typeof atob;
    try {
      assert.throws(
        () => decodeBase64DataUrl(dataUrl(ALL_BYTES), 4),
        (error: unknown) => error instanceof PickedFileError && codeOf(error) === 'file-too-large',
      );
      assert.equal(atobCalls, 0, 'the ceiling was enforced on the encoded length first');
    } finally {
      globalThis.atob = original;
    }
  });

  it('falls back only when no DOM File is present (never fetches asset.uri)', () => {
    assert.ok(webSource.includes('decodeBase64DataUrl(asset.base64)'));
    assert.equal(/fetch\s*\(|XMLHttpRequest/.test(webSource), false);
  });
});

describe('spec 044 — bounded read and ownership-safe cleanup', () => {
  it('a 15 s deadline is the default and an aborted read rejects early', async () => {
    assert.ok(webSource.includes('WEB_PICKED_FILE_READ_TIMEOUT_MS = 15_000'));
    const pendingFile = fakeDomFile({ arrayBuffer: () => new Promise<ArrayBuffer>(() => {}) });
    const asset = { size: 1, file: pendingFile } as unknown as PickedFileAsset;
    const started = Date.now();
    await assert.rejects(
      () => readPickedFile(asset, { timeoutMs: 25 }),
      (error: unknown) => error instanceof PickedFileError && codeOf(error) === 'read-timeout',
    );
    assert.ok(Date.now() - started < 1000, 'the deadline ends a stuck read');

    const abort = new AbortController();
    const aborted = readPickedFile(asset, { signal: abort.signal, timeoutMs: 1000 });
    abort.abort();
    await assert.rejects(aborted, (error: unknown) =>
      error instanceof PickedFileError && codeOf(error) === 'read-failed');
  });

  it('normalizes an ordinary arrayBuffer rejection to the read-failed code', async () => {
    const asset = {
      size: 3,
      file: fakeDomFile({ arrayBuffer: async () => { throw new Error('DOMException: detached file'); } }),
    } as unknown as PickedFileAsset;
    await assert.rejects(
      () => readPickedFile(asset, { timeoutMs: 100 }),
      (error: unknown) => error instanceof PickedFileError && codeOf(error) === 'read-failed'
        && !JSON.stringify(error).includes('detached'),
      'the screen maps read-failed to its own copy, never to attachFailed or exception text',
    );
  });

  it('revokes only a picker-created blob URL (never a path, data URL or arbitrary URI)', () => {
    const original = globalThis.URL;
    const revoked: string[] = [];
    (globalThis as unknown as { URL: unknown }).URL = {
      revokeObjectURL: (url: string) => { revoked.push(url); },
    };
    try {
      const url = 'blob:https://pwa.invalid/pick-4';
      assert.equal(isPickerObjectUrl(url), true);
      revokePickerObjectUrl(url);
      revokePickerObjectUrl('https://pwa.invalid/file.png');
      revokePickerObjectUrl('data:image/png;base64,AAAA');
      revokePickerObjectUrl('/tmp/picked.png');
      revokePickerObjectUrl('C:\\tmp\\picked.png');
      assert.deepEqual(revoked, [url], 'exactly one revoke, for the blob URL only');
    } finally {
      (globalThis as unknown as { URL: unknown }).URL = original;
    }
  });

  it('the screen registers URL cleanup before the stale guard and releases it on every path', () => {
    assert.ok(screen.includes("from '../../src/platform/picked-file'"), 'extensionless seam import');
    assert.equal(screen.includes("from '../../src/platform/picked-file.web'"), false);
    assert.equal(screen.includes("from 'expo-file-system'"), false, 'web bundle has no expo-file-system');
    assert.ok(screen.includes('registerPickedObjectUrl(owner, asset.uri, isPickerObjectUrl, revokePickerObjectUrl);'));
    assert.equal(screen.includes('URL.revokeObjectURL('), false, 'only the web seam touches the DOM API');
    const assetAt = screen.indexOf('const assets = picked.assets as Array<');
    const registerAt = screen.indexOf('registerPickedObjectUrl(owner,', assetAt);
    const staleAt = screen.indexOf('if (!current()) return;', assetAt);
    assert.ok(assetAt > 0 && registerAt > assetAt && registerAt < staleAt, 'cleanup is registered before the stale guard');
    const cancelAt = screen.indexOf('if (picked.canceled || picked.assets.length === 0)');
    assert.ok(cancelAt > 0 && cancelAt < assetAt, 'no asset (picker cancel) never reaches registration');
    const finallyAt = screen.indexOf('} finally {');
    const releaseInFinally = screen.indexOf('active.releaseObjectUrl();', finallyAt);
    const ownsAt = screen.indexOf('if (ownsUpload(', finallyAt);
    assert.ok(releaseInFinally > finallyAt && releaseInFinally < ownsAt, 'stale transfers still release their own URL');
    assert.ok(screen.includes('active.abortRead();\n    active.releaseObjectUrl();'), 'invalidateUpload also releases');
  });

  it('a cancel/session switch during a read sends no frame and cannot publish stale copy', () => {
    const readAt = screen.indexOf('await readPickedFile(asset, readOptions);');
    const uploadAt = screen.indexOf('controller.uploadAttachment(', readAt);
    const guardAt = screen.indexOf('if (!current() || active.cancelled) return;', readAt);
    assert.ok(readAt > 0 && guardAt > readAt && guardAt < uploadAt, 'ownership guard precedes every frame');
    assert.ok(screen.includes('new AbortController()'));
    assert.ok(screen.includes('readAborts.push(() => readController.abort());'));
    assert.ok(screen.includes('timeoutMs: WEB_PICKED_FILE_READ_TIMEOUT_MS'));
    assert.equal(screen.includes('base64: true'), false, 'the picker never pre-reads the whole file');
    assert.ok(screen.includes('copyToCacheDirectory: true'));
    assert.ok(screen.includes('if (ownsUpload('), 'only the owning transfer releases the slot');
  });
});

describe('spec 044 — split copy, no leaks, unchanged native path', () => {
  it('read failure has its own fixed vi/en copy; upload failure keeps attachFailed', () => {
    const copy = (locale: 'en' | 'vi', key: 'session.attachFailed' | 'session.attachNoFile' | 'session.attachReadFailed'): string =>
      MESSAGES[locale][key] as string;
    for (const locale of ['en', 'vi'] as const) {
      const read = copy(locale, 'session.attachReadFailed');
      assert.ok(read.trim().length > 0);
      assert.notEqual(read, copy(locale, 'session.attachFailed'));
      assert.notEqual(read, copy(locale, 'session.attachNoFile'));
      assert.equal(/blob:|data:|Error:|0x[0-9a-fA-F]|[A-Z]:\\|\/Users\//.test(read), false, 'no URI/path/bytes/exception in copy');
    }
    assert.equal(copy('vi', 'session.attachReadFailed'), 'Không đọc được tệp. Hãy chọn lại tệp.');
  });

  it('the catch maps stable codes only and never stringifies the error', () => {
    for (const snippet of [
      "code === 'file-too-large'",
      "code === 'no-file'",
      "code === 'read-failed' || code === 'read-timeout'",
      "tr('session.attachReadFailed')",
      "tr('session.attachFailed')",
    ]) assert.ok(screen.includes(snippet), snippet);
    assert.equal(/JSON\.stringify\(error\)|error\.message|String\(error\)/.test(screen), false);
    assert.ok(screen.indexOf('code ===') > screen.indexOf('} catch (error) {'));
  });

  it('native keeps File/info/arrayBuffer and web module resolution is asserted', () => {
    assert.ok(nativeSource.includes("import { File } from 'expo-file-system'"));
    assert.ok(nativeSource.includes('new File(asset.uri)'));
    assert.ok(nativeSource.includes('const info = file.info();'));
    assert.ok(nativeSource.includes('admitClientUploadSize(info.size);'));
    assert.ok(nativeSource.includes('await file.arrayBuffer()'));
    assert.ok(existsSyncSafe(WEB_SEAM) && existsSyncSafe(NATIVE_SEAM), 'both platform modules exist');
    assert.equal(nativeSource.includes('window.'), false);
  });

  it('progress and receipt still use the exact seam bytes/name', () => {
    assert.ok(screen.includes('bytes: read.bytes'));
    assert.ok(screen.includes('name: read.name'));
    assert.ok(screen.includes('name: read.name, sent: 0, total: read.bytes.length, index: index + 1, count: assets.length'));
    assert.ok(screen.includes('addReceipt(list, {'));
    assert.ok(screen.includes('cancelled: () => active.cancelled'));
    assert.ok(screen.includes('onUploadId: (uploadId) => { if (current()) active.uploadId = uploadId; }'));
    assert.ok(screen.includes("tr('session.attachTooLarge')"));
    assert.ok(screen.includes("tr('session.attachNoFile')"));
  });
});

function existsSyncSafe(file: string): boolean {
  try {
    readFileSync(file, 'utf8');
    return true;
  } catch {
    return false;
  }
}

// Behavioural orchestration of the screen sequence with the PRODUCTION helpers (URL cleanup from
// the screen, lifecycle from src/ui, byte reading from the web seam). No renderer, no renderer
// state: the outcomes below are the observable effects the screen would produce.
interface Orchestration {
  canceledBeforeAsset?: boolean;
  stalePicker?: boolean;
  staleRead?: boolean;
  cancelDuringRead?: boolean;
  rejectRead?: boolean;
}

async function orchestrate(scenario: Orchestration): Promise<{
  uploads: number; copy: string | null; revokes: string[]; slotCleared: boolean;
}> {
  const slot = {
    generation: 1, token: {}, cancelled: false, uploadId: null as string | null,
    releaseObjectUrl: () => {}, abortRead: () => {},
  };
  let generation = 1;
  let liveToken: object | null = slot.token;
  const revokes: string[] = [];
  const revoke = (url: string): void => { revokes.push(url); };
  const current = (): boolean => isCurrentUpload({ generation, token: liveToken }, slot);
  let copy: string | null = null;
  let uploads = 0;
  const fail = (message: string): void => { if (current()) copy = message; };

  if (scenario.stalePicker) { generation += 1; liveToken = null; }
  const asset = scenario.canceledBeforeAsset ? null : {
    uri: 'blob:https://pwa.invalid/pick',
    size: ALL_BYTES.length,
    file: fakeDomFile(),
  } as unknown as PickedFileAsset;

  try {
    // The production cleanup helper is registered BEFORE the stale guard, exactly as the screen.
    if (asset !== null) registerPickedObjectUrl(slot, asset.uri, isPickerObjectUrl, revoke);
    if (asset === null) { if (current()) fail('session.attachNoFile'); return { uploads, copy, revokes, slotCleared: ownsUpload({ generation, token: liveToken }, slot) }; }
    if (!current()) return { uploads, copy, revokes, slotCleared: ownsUpload({ generation, token: liveToken }, slot) };

    const abort = new AbortController();
    slot.abortRead = () => abort.abort();
    if (scenario.cancelDuringRead) { slot.cancelled = true; abort.abort(); }
    if (scenario.rejectRead) {
      (asset.file as NonNullable<PickedFileAsset['file']>).arrayBuffer = async () => { throw new Error('detached'); };
    }
    const reading = readPickedFile(asset, { signal: abort.signal, timeoutMs: 500 });
    if (scenario.staleRead) { generation += 1; liveToken = null; }
    const read = await reading;
    if (!current()) return { uploads, copy, revokes, slotCleared: ownsUpload({ generation, token: liveToken }, slot) };
    if (scenario.cancelDuringRead) return { uploads, copy, revokes, slotCleared: ownsUpload({ generation, token: liveToken }, slot) };
    uploads += 1;
    void read.bytes;
  } catch (error) {
    if (!current()) return { uploads, copy, revokes, slotCleared: ownsUpload({ generation, token: liveToken }, slot) };
    const code = codeOf(error);
    if (code === 'no-file') fail('session.attachNoFile');
    else if (code === 'read-failed' || code === 'read-timeout') fail('session.attachReadFailed');
    else fail('session.attachFailed');
  } finally {
    slot.abortRead();
    slot.releaseObjectUrl();
  }
  const slotCleared = ownsUpload({ generation, token: liveToken }, slot);
  return { uploads, copy, revokes, slotCleared };
}

describe('spec 044 reviewer — behavioural orchestration', () => {
  it('success reads and uploads once, then revokes the picker URL exactly once', async () => {
    const result = await orchestrate({});
    assert.equal(result.uploads, 1);
    assert.equal(result.copy, null);
    assert.deepEqual(result.revokes, ['blob:https://pwa.invalid/pick']);
    assert.equal(result.slotCleared, true);
  });

  it('an ordinary read rejection shows the read copy and never uploads', async () => {
    const result = await orchestrate({ rejectRead: true });
    assert.equal(result.copy, 'session.attachReadFailed');
    assert.equal(result.uploads, 0);
    assert.equal(result.revokes.length, 1, 'the blob URL is still released once');
    assert.equal(result.slotCleared, true);
  });

  it('cancel during the read sends no frame and releases only the owning slot', async () => {
    const result = await orchestrate({ cancelDuringRead: true });
    assert.equal(result.uploads, 0);
    assert.equal(result.copy, null, 'a cancelled transfer publishes no stale sheet');
    assert.deepEqual(result.revokes, ['blob:https://pwa.invalid/pick']);
    assert.equal(result.slotCleared, true, 'the owning transfer frees Send');
  });

  it('a stale picker still revokes exactly once and cannot upload or publish', async () => {
    const result = await orchestrate({ stalePicker: true });
    assert.equal(result.uploads, 0);
    assert.equal(result.copy, null);
    assert.deepEqual(result.revokes, ['blob:https://pwa.invalid/pick'], 'no blob leak after session switch');
    assert.equal(result.slotCleared, false, 'a stale transfer cannot clear the new slot');
  });

  it('a stale read result is ignored and the newer slot survives', async () => {
    const result = await orchestrate({ staleRead: true });
    assert.equal(result.uploads, 0);
    assert.equal(result.copy, null);
    assert.deepEqual(result.revokes, ['blob:https://pwa.invalid/pick']);
    assert.equal(result.slotCleared, false);
  });

  it('picker cancel/no asset never revokes anything', async () => {
    const result = await orchestrate({ canceledBeforeAsset: true });
    assert.deepEqual(result.revokes, []);
    assert.equal(result.uploads, 0);
    assert.equal(result.copy, 'session.attachNoFile');
  });
});

describe('spec 044 reviewer — real Metro platform resolution', () => {
  it('resolves the screen\'s extensionless import to picked-file.web.ts on web and .ts on native', () => {
    const require = createRequire(import.meta.url);
    const metroResolver = require('metro-resolver') as {
      resolve: (context: unknown, specifier: string, platform: string) => { type: string; filePath?: string };
    };
    const config = (require('expo/metro-config') as {
      getDefaultConfig: (root: string) => { resolver: Record<string, unknown> };
    }).getDefaultConfig(APP);
    const context = {
      ...config.resolver,
      platforms: [...(config.resolver.platforms as string[]), 'web'],
      originModulePath: SCREEN,
      getPackageForModule: () => null,
      fileSystemLookup: (candidate: string) => {
        try {
          const stat = statSync(candidate);
          return { exists: true, type: stat.isDirectory() ? 'd' : 'f', realPath: candidate };
        } catch {
          return { exists: false, type: null, realPath: candidate };
        }
      },
    };
    const web = metroResolver.resolve(context, '../../src/platform/picked-file', 'web');
    const ios = metroResolver.resolve(context, '../../src/platform/picked-file', 'ios');
    assert.equal(web.type, 'sourceFile');
    assert.equal(path.resolve(web.filePath ?? ''), WEB_SEAM, 'Metro really selects the web seam');
    assert.equal(path.resolve(ios.filePath ?? ''), NATIVE_SEAM, 'native still selects the no-op seam');
  });
});
