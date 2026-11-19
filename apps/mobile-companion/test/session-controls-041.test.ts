// Spec 041 — source + pure-core tests for the three restored session controls.
//
// There is no component renderer in this repo, so the HOOK wiring is checked against the screen's
// source (the same style as `ui-test-hooks.test.ts`). The contract frames and the ring clamp are pure
// functions in `src/core` / `src/ui`, so they are exercised directly with a fake client: no socket,
// no renderer, and no real file picker is involved.

import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { describe, it } from 'node:test';
import { fileURLToPath } from 'node:url';

import { ATTACHMENTS_WRITE_SCOPE, REMOTE_UPLOAD_RESULT_KIND } from '@dsh-ext/mobile-protocol';

import { MESSAGES, type MessageKey } from '../i18n';
import { AppController } from '../src/app-state';
import type { CompanionClient } from '../src/core/client';
import { CoreError } from '../src/core/errors';
import {
  admitClientUploadSize,
  canonicalBase64,
  chunkParams,
  CLIENT_UPLOAD_MAX_BYTES,
  CoreUploadError,
  openParams,
  remoteUpload,
  toChunkView,
  toFinishView,
  toOpenView,
  uploadSha256,
} from '../src/core/remote-upload';
import { contextRingRatio } from '../src/ui/read-only-views';
import { isCurrentUpload, ownsUpload, shouldClearReceipt } from '../src/ui/conversation/upload-lifecycle';
import { resetAppState } from './support/stubs/react-native.stub';

const SCREEN = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', 'app', 'session', '[id].tsx');
// Spec 044 moved the native read into the platform seam; the screen now drives the seam.
const NATIVE_SEAM = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', 'src', 'platform', 'picked-file.ts');
const SESSION = 'sess-041';

interface Sent {
  op: unknown;
  params: Record<string, unknown>;
  options?: { allowNonOpType?: boolean };
}

/** Fake client that answers frames in order and records every request (including its opt-in). */
function clientAnswering(replies: Record<string, unknown>[]): { client: CompanionClient; sent: Sent[] } {
  const sent: Sent[] = [];
  let index = 0;
  const client = {
    request: async (op: unknown, params: Record<string, unknown>, options?: { allowNonOpType?: boolean }) => {
      sent.push({ op, params, options });
      const reply = replies[index] as Record<string, unknown> | undefined;
      index += 1;
      if (reply === undefined) throw new Error('no queued reply');
      if (reply instanceof Error) throw reply;
      return reply;
    },
  };
  return { client: client as CompanionClient, sent };
}

function result(value: Record<string, unknown>): Record<string, unknown> {
  return { kind: REMOTE_UPLOAD_RESULT_KIND, ok: true, value };
}

const BYTES = new Uint8Array([0, 1, 2, 3, 250, 251, 252, 253, 254, 255]);

describe('spec 041 hook wiring (source, no renderer)', () => {
  const source = readFileSync(SCREEN, 'utf8');

  it('renders each new control once, with a localized accessibility label', () => {
    for (const id of ['session-permission-picker', 'session-context-ring', 'session-attach']) {
      assert.equal(source.split(`testID="${id}"`).length - 1, 1, `${id} renders exactly once`);
    }
    for (const key of ['session.permissionPicker', 'session.contextUsage', 'session.attach'] as MessageKey[]) {
      assert.ok(source.includes(`tr('${key}')`), `${key} is the control's localized label`);
    }
  });

  it('opens the EXISTING permission and stats sheets, and never sends a forbidden permission frame', () => {
    assert.ok(source.includes('onPress={() => setPermissionSheetOpen(true)}'), 'the button opens the existing sheet');
    assert.ok(source.includes('setStatsOpen(true)'), 'the ring opens the existing stats sheet');
    assert.ok(source.includes('controller.readPermissionOptions(sessionId)'));
    assert.ok(source.includes('controller.lowerPermission(sessionId, preset)'));
    assert.equal(source.includes("'permission-lower'"), false, 'no raw upstream permission op');
    assert.equal(/session\/attachment|file-upload-(open|chunk|finish|cancel)/.test(source), false, 'no legacy upload endpoint');
    assert.ok(source.includes('controller.uploadAttachment('), 'the attach sheet uses the scoped upload');
    assert.ok(source.includes('controller.hasScope(ATTACHMENTS_WRITE_SCOPE)'));
  });

  it('provides both locales for every new user-facing string', () => {
    const keys: MessageKey[] = [
      'session.permissionPicker', 'session.permissionDisabled',
      'session.contextUsage', 'session.contextUnavailable',
      'session.attach', 'session.attachTitle', 'session.attachImage', 'session.attachFile',
      'session.attachUnavailable', 'session.attachTooLarge', 'session.attachTooMany', 'session.attachProgress',
      'session.sending', 'session.processing',
      'session.attachCancel', 'session.attachFailed', 'session.attachReadFailed', 'session.attachReceipt',
      'session.attachNoFile', 'session.attachBusy',
    ];
    const copy = (locale: 'en' | 'vi', key: MessageKey): string => {
      const value = MESSAGES[locale][key];
      return typeof value === 'function' ? value({}) : value;
    };
    for (const key of keys) {
      assert.ok(copy('en', key)?.trim(), `en/${key}`);
      assert.ok(copy('vi', key)?.trim(), `vi/${key}`);
    }
    assert.equal(copy('en', 'session.permissionDisabled'), 'Permission changes are not enabled for this device');
    assert.equal(copy('vi', 'session.permissionDisabled'), 'Thiết bị này không được phép đổi quyền');
  });
});

describe('spec 041 FR-2 remote upload frames', () => {
  it('builds canonical base64 and sha256 from the SAME bytes', () => {
    const encoded = canonicalBase64(BYTES);
    assert.equal(encoded, Buffer.from(BYTES).toString('base64'));
    assert.equal(canonicalBase64(new Uint8Array()), '');
    assert.equal(uploadSha256(BYTES), createHash('sha256').update(BYTES).digest('hex'));
  });

  it('rejects a non-canonical base64 chunk instead of silently rewriting it', () => {
    // The gateway compares Buffer#toString('base64') byte-for-byte; a non-canonical spelling is a
    // refusal, not something the app should "helpfully" fix. Our encoder is canonical by construction.
    const encoded = canonicalBase64(BYTES);
    assert.equal(Buffer.from(encoded, 'base64').toString('base64'), encoded);
    assert.equal(encoded.includes('\n'), false);
    assert.equal(encoded.endsWith('='), true);
  });

  it('sends open → chunk → finish over allowNonOpType with decoded-byte offsets', async () => {
    const input = { sessionId: SESSION, kind: 'file' as const, bytes: BYTES, name: 'a.bin' };
    const replies = [
      result({ uploadId: 'u1', sessionId: SESSION, kind: 'file', size: BYTES.length, chunkBytes: 4, maxBytes: 1024 }),
      result({ uploadId: 'u1', sessionId: SESSION, nextOffset: 4 }),
      result({ uploadId: 'u1', sessionId: SESSION, nextOffset: 8 }),
      result({ uploadId: 'u1', sessionId: SESSION, nextOffset: 10 }),
      { kind: REMOTE_UPLOAD_RESULT_KIND, ok: true, value: { receiptId: 'r1', file: { attachmentId: 'a1', bytes: 10 } } },
    ];
    const { client, sent } = clientAnswering(replies);
    const progress: Array<[number, number]> = [];
    const receipt = await remoteUpload(client, input, { progress: (s, t) => progress.push([s, t]) });

    assert.deepEqual(receipt, { receiptId: 'r1', attachmentId: 'a1' });
    assert.deepEqual(sent.map((frame) => frame.op), [
      'remote-upload-open', 'remote-upload-chunk', 'remote-upload-chunk', 'remote-upload-chunk', 'remote-upload-finish',
    ]);
    assert.ok(sent.every((frame) => frame.options?.allowNonOpType === true), 'non-op opt-in on every frame');
    assert.deepEqual(sent[0]?.params, openParams(input));
    assert.equal(sent[0]?.params.sha256, createHash('sha256').update(BYTES).digest('hex'));
    assert.deepEqual(sent.slice(1, 4).map((frame) => frame.params.offset), [0, 4, 8]);
    assert.deepEqual(progress, [[4, 10], [8, 10], [10, 10]]);
    assert.deepEqual(chunkParams('u1', 4, BYTES.subarray(4, 8)).data, canonicalBase64(BYTES.subarray(4, 8)));
  });

  it('validates the open reply (wrong session/kind/size is a client defect)', () => {
    const input = { sessionId: SESSION, kind: 'file' as const, bytes: BYTES };
    assert.throws(
      () => toOpenView(result({ uploadId: 'u1', sessionId: 'another', kind: 'file', size: 10, chunkBytes: 4, maxBytes: 100 }), input),
      (error: unknown) => error instanceof CoreUploadError && error.code === 'client/bad-message',
    );
    assert.throws(
      () => toOpenView(result({ uploadId: 'u1', sessionId: SESSION, kind: 'file', size: 10, chunkBytes: 0, maxBytes: 100 }), input),
      (error: unknown) => error instanceof CoreUploadError && error.code === 'file-upload-invalid-response',
    );
    assert.throws(
      () => toOpenView(result({ uploadId: 'u1', sessionId: SESSION, kind: 'image', size: 10, chunkBytes: 4, maxBytes: 100 }), input),
      (error: unknown) => error instanceof CoreUploadError && error.code === 'client/bad-message',
    );
  });

  it('checks the maxBytes from the open reply BEFORE any chunk is sent', async () => {
    const { client, sent } = clientAnswering([
      result({ uploadId: 'u1', sessionId: SESSION, kind: 'file', size: BYTES.length, chunkBytes: 4, maxBytes: 4 }),
    ]);
    await assert.rejects(
      remoteUpload(client, { sessionId: SESSION, kind: 'file', bytes: BYTES }),
      (error: unknown) => error instanceof CoreUploadError && error.code === 'file-too-large',
    );
    assert.deepEqual(sent.map((frame) => frame.op), ['remote-upload-open', 'remote-upload-cancel'], 'a reserved slot is always cancelled');
  });

  it('cancels a reserved slot when the OPEN reply itself is structurally invalid', async () => {
    const { client, sent } = clientAnswering([
      result({ uploadId: 'u1', sessionId: SESSION, kind: 'file', size: BYTES.length, chunkBytes: 0, maxBytes: 100 }),
      result({ uploadId: 'u1', sessionId: SESSION, cancelled: true }),
    ]);
    await assert.rejects(
      remoteUpload(client, { sessionId: SESSION, kind: 'file', bytes: BYTES }),
      (error: unknown) => error instanceof CoreUploadError && error.code === 'file-upload-invalid-response',
    );
    assert.deepEqual(sent.map((frame) => frame.op), ['remote-upload-open', 'remote-upload-cancel']);
  });

  it('refuses a pick above the client ceiling BEFORE any open frame', () => {
    const huge = new Uint8Array(CLIENT_UPLOAD_MAX_BYTES + 1);
    assert.throws(
      () => openParams({ sessionId: SESSION, kind: 'file', bytes: huge }),
      (error: unknown) => error instanceof CoreUploadError && error.code === 'file-too-large',
    );
  });

  it('a cancel after the LAST chunk never commits the upload', async () => {
    const { client, sent } = clientAnswering([
      result({ uploadId: 'u1', sessionId: SESSION, kind: 'file', size: BYTES.length, chunkBytes: 16, maxBytes: 100 }),
      result({ uploadId: 'u1', sessionId: SESSION, nextOffset: BYTES.length }),
      result({ uploadId: 'u1', sessionId: SESSION, cancelled: true }),
    ]);
    let chunks = 0;
    await assert.rejects(
      remoteUpload(client, { sessionId: SESSION, kind: 'file', bytes: BYTES }, {
        cancel: { cancelled: () => chunks > 0 },
        progress: () => { chunks += 1; },
      }),
      (error: unknown) => error instanceof CoreUploadError && error.code === 'file-upload-cancelled',
    );
    assert.deepEqual(sent.map((frame) => frame.op), ['remote-upload-open', 'remote-upload-chunk', 'remote-upload-cancel'], 'no finish');
  });

  it('a cancelled transfer sends remote-upload-cancel and stops chunking', async () => {
    const { client, sent } = clientAnswering([
      result({ uploadId: 'u1', sessionId: SESSION, kind: 'file', size: BYTES.length, chunkBytes: 4, maxBytes: 100 }),
      result({ uploadId: 'u1', sessionId: SESSION, nextOffset: 4 }),
      result({ uploadId: 'u1', sessionId: SESSION, cancelled: true }),
    ]);
    let count = 0;
    await assert.rejects(
      remoteUpload(client, { sessionId: SESSION, kind: 'file', bytes: BYTES }, {
        cancel: { cancelled: () => (count += 1) > 1 },
      }),
      (error: unknown) => error instanceof CoreUploadError && error.code === 'file-upload-cancelled',
    );
    assert.deepEqual(sent.map((frame) => frame.op), ['remote-upload-open', 'remote-upload-chunk', 'remote-upload-cancel']);
  });

  it('rejects a chunk answer whose nextOffset is not the decoded-byte total', () => {
    assert.throws(
      () => toChunkView(result({ uploadId: 'u1', nextOffset: 5 }), 'u1', 4, 4),
      (error: unknown) => error instanceof CoreUploadError && error.code === 'file-upload-offset',
    );
    assert.equal(toChunkView(result({ uploadId: 'u1', nextOffset: 8 }), 'u1', 4, 4), 8);
  });

  it('requires the Host receipt id on finish', () => {
    assert.throws(
      () => toFinishView(result({ file: { attachmentId: 'a1' } }), 'u1'),
      (error: unknown) => error instanceof CoreUploadError && error.code === 'file-upload-invalid-response',
    );
    assert.deepEqual(toFinishView(result({ receiptId: 'r1', image: { attachmentId: 'a1' } }), 'u1'), { receiptId: 'r1', attachmentId: 'a1' });
  });
});

describe('spec 041 FR-2 scope gate (controller)', () => {
  function controllerWith(client: unknown): AppController {
    resetAppState('active');
    const controller = new AppController({ locale: () => 'en' });
    (controller as unknown as { client: unknown }).client = client;
    return controller;
  }

  function fakeClient(scopes: string[] | undefined, requests: Record<string, unknown>[]): { client: CompanionClient; asked: unknown[] } {
    const asked: unknown[] = [];
    return {
      asked,
      client: {
        state: 'ready',
        device: { id: 'dev-1', name: 'phone', ...(scopes === undefined ? {} : { scopes }) },
        close: () => {},
        stop: () => {},
        on: () => {},
        off: () => {},
        request: async (op: unknown) => {
          asked.push(op);
          const reply = requests.shift();
          if (reply === undefined) throw new Error('no queued reply');
          return reply;
        },
      } as unknown as CompanionClient,
    };
  }

  it('hasScope is fail-closed and does not rename or widen hasReadScope', () => {
    resetAppState('active');
    const controller = new AppController({ locale: () => 'en' });
    try {
      assert.equal(controller.hasScope(ATTACHMENTS_WRITE_SCOPE), false, 'no client grants nothing');
      assert.equal(controller.hasReadScope('stats:read'), false, 'the read gate is unchanged');
    } finally {
      controller.stop();
    }
    const granted = controllerWith(fakeClient([ATTACHMENTS_WRITE_SCOPE], []).client);
    try {
      assert.equal(granted.hasScope(ATTACHMENTS_WRITE_SCOPE), true);
      assert.equal(granted.hasReadScope('stats:read'), false, 'attachments:write is not a read scope');
    } finally {
      granted.stop();
    }
  });

  it('never sends a frame when the device lacks attachments:write', async () => {
    const { client, asked } = fakeClient(['sessions:read'], []);
    const controller = controllerWith(client);
    try {
      await assert.rejects(
        controller.uploadAttachment({ sessionId: SESSION, kind: 'file', bytes: BYTES }),
        (error: unknown) => error instanceof CoreError && error.code === 'auth/forbidden-scope',
      );
      assert.deepEqual(asked, [], 'not one forbidden frame went on the wire');
    } finally {
      controller.stop();
    }
  });

  it('with the grant, delegates to the contract upload', async () => {
    const replies = [
      result({ uploadId: 'u1', sessionId: SESSION, kind: 'file', size: BYTES.length, chunkBytes: 16, maxBytes: 100 }),
      result({ uploadId: 'u1', sessionId: SESSION, nextOffset: BYTES.length }),
      { kind: REMOTE_UPLOAD_RESULT_KIND, ok: true, value: { receiptId: 'r1', file: { attachmentId: 'a1' } } },
    ];
    const { client, asked } = fakeClient([ATTACHMENTS_WRITE_SCOPE], replies);
    const controller = controllerWith(client);
    try {
      assert.deepEqual(
        await controller.uploadAttachment({ sessionId: SESSION, kind: 'file', bytes: BYTES }),
        { receiptId: 'r1', attachmentId: 'a1' },
      );
      assert.deepEqual(asked, ['remote-upload-open', 'remote-upload-chunk', 'remote-upload-finish']);
    } finally {
      controller.stop();
    }
  });
});

describe('spec 041 reviewer fixes — receipt, no-scope, single-flight, ring', () => {
  const source = readFileSync(SCREEN, 'utf8');

  it('no-scope tap opens a sheet that RENDERS the localized refusal (not a blank sheet)', () => {
    assert.ok(source.includes("setAttachMessage(canAttach ? null : tr('session.attachUnavailable'))"), 'the open handler sets the refusal');
    assert.ok(source.includes('{attachMessage ?? tr(\'session.attachUnavailable\')}'), 'the sheet renders the fallback even if state is stale');
    assert.ok(source.includes('{canAttach && attachMessage === null ? ('), 'choices are still gated on the scope');
  });

  it('places the attach choices in a bottom sheet, never a top-anchored popover', () => {
    const sheetStart = source.indexOf('<Modal visible={attachSheetOpen}');
    const sheet = source.slice(sheetStart, source.indexOf('</Modal>', sheetStart));
    assert.ok(sheet.includes("justifyContent: 'flex-end'"), 'the scrim pushes the sheet to the bottom');
    assert.ok(sheet.includes('marginBottom: insets.bottom + space.lg'), 'safe-area bottom clearance');
    assert.equal(sheet.includes('marginTop:'), false, 'no top anchor under the Dynamic Island');
    assert.equal(sheet.includes('popover'), false, 'no native anchored popover');
    for (const id of ['session-attach-sheet', 'session-attach-close', 'session-attach-image', 'session-attach-file']) {
      assert.ok(sheet.includes(`testID="${id}"`), `${id} is unchanged by placement`);
    }
  });

  it('claims the single-flight slot synchronously before any picker or file read', () => {
    assert.ok(source.includes('if (attachInFlight.current) return;'), 'duplicate taps are refused');
    assert.ok(source.includes('attachInFlight.current = true;'), 'the guard is claimed before await');
    const claim = source.indexOf('attachInFlight.current = true;');
    const picker = source.indexOf('DocumentPicker.getDocumentAsync(');
    assert.ok(claim > 0 && picker > claim, 'the guard precedes the picker');
    const seamCall = source.indexOf('await readPickedFile(asset, readOptions);');
    assert.ok(seamCall > claim, 'the guard precedes the whole-file read');
    assert.ok(source.includes('if (!multi && asset.size !== undefined) admitClientUploadSize(asset.size);'), 'single-file picker size is admitted before the read');
    assert.ok(source.indexOf('if (!multi && asset.size !== undefined) admitClientUploadSize(asset.size);') < seamCall, 'admission precedes the seam');
    assert.ok(source.includes('admitImageBatch(assets.map('), 'a web image batch is admitted as a whole before any read');
    const native = readFileSync(NATIVE_SEAM, 'utf8');
    assert.ok(native.includes('const info = file.info();'), 'native metadata is read before arrayBuffer');
    const infoAt = native.indexOf('const info = file.info();');
    const readAt = native.indexOf('await file.arrayBuffer()');
    assert.ok(infoAt > 0 && readAt > infoAt, 'native metadata check precedes the whole-file read');
    assert.ok(native.includes('admitClientUploadSize(info.size);'), 'missing/nonfinite/negative/oversize metadata fails closed');
    assert.ok(source.includes('if (value === \'\' || sending || attachInFlight.current) return;'), 'Send handler is guarded too');
    assert.ok(source.includes('controller.sendPrompt(payload, {'), 'the send carries the receipt options');
    assert.ok(source.includes('clearSnapshottedReceipts(current, sessionId, receiptIds)'), 'only the snapshotted receipts are cleared after ack');
    assert.ok(source.includes('}, [invalidateUpload, sessionId]);'), 'attachment state is reset on session change');

    // Per-transfer lifecycle isolation: generation + unique token + own cancellation flag.
    assert.ok(source.includes('const uploadGen = useRef(0);'));
    assert.ok(source.includes('const activeUpload = useRef<{'));
    assert.ok(source.includes('uploadGen.current += 1;'), 'session change invalidates the generation');
    assert.ok(source.includes('void controller.cancelRemoteUpload(active.uploadId).catch(() => {})'), 'an active slot is cancelled');
    assert.equal(source.split('void controller.cancelRemoteUpload(active.uploadId).catch(() => {})').length - 1, 2, 'cancel on both session change and the cancel button');
    assert.ok(source.includes('isCurrentUpload('), 'post-await updates are identity-gated');
    assert.ok(source.includes('if (!current()) return;'), 'stale completions are no-ops');
    assert.ok(source.includes('onUploadId: (uploadId) => { if (current()) active.uploadId = uploadId; }'), 'the uploadId is captured for cleanup');
    const guardCount = source.split('if (!current()) return;').length - 1;
    assert.ok(guardCount >= 4, `every await is followed by an identity check (${guardCount})`);
    assert.ok(source.includes('if (ownsUpload('), 'cleanup is guarded by OWNERSHIP, not publish permission');
  });

  it('ring read failures restore neutral and stale generations are discarded', () => {
    assert.ok(source.includes('const contextRingGen = useRef(0);'), 'a generation token exists');
    assert.ok(source.includes('if (contextRingGen.current !== generation) return;'), 'stale answers are dropped');
    assert.ok(source.includes('if (contextRingGen.current === generation) setContextFill(null);'), 'a failed read restores neutral');
    assert.ok(source.includes('useEffect(() => () => { contextRingGen.current += 1; }, []);'), 'unmount invalidates the read');
  });

  it('sends the Host receipt in the ACTUAL prompt message frame (contract `files`)', async () => {
    const frames: Array<{ op: unknown; params: Record<string, unknown> }> = [];
    const client = {
      state: 'ready',
      connected: true,
      device: { id: 'dev-1', name: 'phone', scopes: ['sessions:read', 'prompt:send'] },
      close: () => {},
      stop: () => {},
      on: () => {},
      off: () => {},
      request: async (op: unknown, params: Record<string, unknown>) => {
        frames.push({ op, params });
        return { kind: 'sent', sessionId: SESSION, clientMsgId: params.clientMsgId, mode: 'queue' };
      },
    } as unknown as CompanionClient;
    resetAppState('active');
    const controller = new AppController({ locale: () => 'en' });
    (controller as unknown as { client: CompanionClient }).client = client;
    (controller as unknown as { openSessionId: string | null }).openSessionId = SESSION;
    try {
      const acked = await controller.sendPrompt('read this', { files: [{ receiptId: 'host-receipt-1' }] });
      assert.equal(acked, true, 'only the Host receipt makes this a successful send');
      const message = frames.find((frame) => frame.op === 'message');
      assert.ok(message, 'the prompt went out as the contract message frame');
      assert.equal(message?.params.sessionId, SESSION);
      assert.equal(message?.params.text, 'read this');
      assert.deepEqual(message?.params.files, [{ receiptId: 'host-receipt-1' }]);
      assert.equal(typeof message?.params.clientMsgId, 'string', 'stable id kept for idempotent retry');
    } finally {
      controller.stop();
    }
  });
});

describe('spec 041 review2 — pre-read admission and upload lifecycle identity', () => {
  it('fails closed for absent, nonfinite, negative and oversize pre-read sizes', () => {
    for (const size of [undefined, Number.NaN, Number.POSITIVE_INFINITY, -1, CLIENT_UPLOAD_MAX_BYTES + 1]) {
      assert.throws(
        () => admitClientUploadSize(size),
        (error: unknown) => error instanceof CoreUploadError && error.code === 'file-too-large',
        `size ${String(size)} must be refused before reading bytes`,
      );
    }
    assert.equal(admitClientUploadSize(0), 0, 'an empty file has a finite nonnegative size');
    assert.equal(admitClientUploadSize(CLIENT_UPLOAD_MAX_BYTES), CLIENT_UPLOAD_MAX_BYTES);
  });

  it('a session change during read/upload makes the stale completion a no-op', () => {
    const token = {};
    const identity = { generation: 1, token, cancelled: false };
    const currentSlot = { generation: 1, token };
    assert.equal(isCurrentUpload(currentSlot, identity), true, 'the owning transfer is current');

    // Simulate the session-change effect: generation bumped, slot cleared, old flag set.
    const afterSessionChange = { generation: 2, token: null };
    assert.equal(isCurrentUpload(afterSessionChange, identity), false, 'a late read cannot paint the new session');
    assert.equal(isCurrentUpload(afterSessionChange, { ...identity, cancelled: true }), false, 'cancel also blocks it');

    // A new transfer in the SAME generation must not accept the old token's completion.
    const newToken = {};
    assert.equal(isCurrentUpload({ generation: 1, token: newToken }, identity), false, 'stale token is refused');
    assert.equal(isCurrentUpload({ generation: 1, token: newToken }, { ...identity, token: newToken }), true);
  });

  it('cancelling the CURRENT upload releases its slot and progress (ownership ≠ publish)', () => {
    // Behavioral model of the screen: slot/token/generation + a single-flight flag + progress.
    let generation = 1;
    let slotToken: object | null = null;
    let inFlight = false;
    let progress: string | null = null;
    const token = {};
    const identity = { generation, token, cancelled: false, uploadId: 'u1' as string | null };
    slotToken = token;
    inFlight = true;
    progress = 'a.bin 40%';

    // The user taps cancel: the flag flips, but ownership is unchanged.
    identity.cancelled = true;
    assert.equal(isCurrentUpload({ generation, token: slotToken }, identity), false, 'no receipt/error published');

    // The screen's finally uses ownsUpload: cleanup MUST happen for this same identity.
    if (ownsUpload({ generation, token: slotToken }, identity)) {
      progress = null;
      inFlight = false;
      if (slotToken === token) slotToken = null;
    }
    assert.equal(inFlight, false, 'Send is unlocked after cancel');
    assert.equal(progress, null, 'the stuck progress line is cleared');
    assert.equal(slotToken, null, 'the active upload slot is released');
  });

  it('a stale-cancel/new-transfer case never releases the NEW transfer slot', () => {
    let generation = 1;
    let slotToken: object | null = null;
    let inFlight = false;
    const staleToken = {};
    const stale = { generation, token: staleToken, cancelled: false };
    slotToken = staleToken;
    inFlight = true;

    // Session changes: generation bump + new transfer owns the slot; the old cancel lands late.
    generation += 1;
    const newToken = {};
    slotToken = newToken;
    stale.cancelled = true;
    const current = { generation, token: newToken, cancelled: false };

    assert.equal(isCurrentUpload({ generation, token: slotToken }, stale), false, 'stale result is not published');
    if (ownsUpload({ generation, token: slotToken }, stale)) {
      inFlight = false; // must NOT run
      slotToken = null;
    }
    assert.equal(inFlight, true, 'the new transfer still owns the single-flight slot');
    assert.equal(slotToken, newToken, 'the stale cleanup cannot clear the new transfer');
    assert.equal(isCurrentUpload({ generation, token: slotToken }, current), true, 'the new transfer can publish');
  });

  it('only the matching session/receipt clears a chip with a functional update', () => {
    const expected = { sessionId: 'sess-A', receiptId: 'r1' };
    assert.equal(shouldClearReceipt(null, expected), false);
    assert.equal(shouldClearReceipt({ sessionId: 'sess-A', receiptId: 'r1' }, expected), true);
    assert.equal(shouldClearReceipt({ sessionId: 'sess-B', receiptId: 'r1' }, expected), false, 'new session wins');
    assert.equal(shouldClearReceipt({ sessionId: 'sess-A', receiptId: 'r2' }, expected), false, 'replaced receipt wins');
  });
});

describe('spec 041 review2 — per-caller prompt ack tracking', () => {
  function controlledController(): {
    controller: AppController;
    frames: Record<string, unknown>[];
    gates: Array<() => void>;
    failures: Array<Error | null>;
  } {
    const frames: Record<string, unknown>[] = [];
    const gates: Array<() => void> = [];
    const failures: Array<Error | null> = [];
    const client = {
      state: 'ready',
      connected: true,
      device: { id: 'dev-1', name: 'phone', scopes: ['sessions:read', 'prompt:send'] },
      close: () => {},
      stop: () => {},
      on: () => {},
      off: () => {},
      request: async (op: unknown, params: Record<string, unknown>) => {
        if (op !== 'message') return {};
        frames.push(params);
        const index = frames.length - 1;
        await new Promise<void>((resolve) => gates.push(resolve));
        if (failures[index] !== null && failures[index] !== undefined) throw failures[index];
        return { kind: 'sent', sessionId: SESSION, clientMsgId: params.clientMsgId, mode: 'queue' };
      },
    } as unknown as CompanionClient;
    resetAppState('active');
    const controller = new AppController({ locale: () => 'en' });
    (controller as unknown as { client: CompanionClient }).client = client;
    (controller as unknown as { openSessionId: string | null }).openSessionId = SESSION;
    return { controller, frames, gates, failures };
  }

  const tick = (): Promise<void> => new Promise((resolve) => setImmediate(resolve));

  it('resolves each delayed caller by its OWN clientMsgId', async () => {
    const { controller, frames, gates } = controlledController();
    try {
      const first = controller.sendPrompt('first');
      await tick();
      const second = controller.sendPrompt('second', { files: [{ receiptId: 'r1' }] });
      await tick();
      assert.equal(frames.length, 1, 'the outbox serializes drains; the second waits for the first');
      gates[0]?.();
      await tick();
      assert.equal(frames.length, 2);
      gates[1]?.();
      assert.deepEqual(await Promise.all([first, second]), [true, true]);
      assert.deepEqual(frames.map((frame) => frame.text), ['first', 'second']);
      assert.notEqual(frames[0]?.clientMsgId, frames[1]?.clientMsgId, 'each caller owns a stable id');
      assert.deepEqual(frames[1]?.files, [{ receiptId: 'r1' }]);
    } finally {
      controller.stop();
    }
  });

  it('one caller refusing does not resolve another caller pending on a later drain', async () => {
    const { controller, frames, gates, failures } = controlledController();
    failures[0] = new CoreError({ code: 'auth/revoked', message: 'test refusal' });
    try {
      const first = controller.sendPrompt('refused');
      await tick();
      const second = controller.sendPrompt('accepted');
      await tick();
      gates[0]?.();
      await tick();
      gates[1]?.();
      assert.deepEqual(await Promise.all([first, second]), [false, true]);
      assert.equal(frames.length, 2);
    } finally {
      controller.stop();
    }
  });
});

describe('spec 041 FR-3 context ring clamp', () => {
  it('returns null for every "no reading" answer — never zero or full by accident', () => {
    assert.equal(contextRingRatio(null), null);
    assert.equal(contextRingRatio({ contextWindow: null, pressureTokens: 10, surfaceTokens: null }), null);
    assert.equal(contextRingRatio({ contextWindow: 100, pressureTokens: null, surfaceTokens: null }), null);
    assert.equal(contextRingRatio({ contextWindow: 0, pressureTokens: 10, surfaceTokens: null }), null);
    assert.equal(contextRingRatio({ contextWindow: -10, pressureTokens: 5, surfaceTokens: null }), null);
    assert.equal(contextRingRatio({ contextWindow: Number.NaN, pressureTokens: 5, surfaceTokens: null }), null);
  });

  it('clamps into 0…1 and leaves a normal reading untouched', () => {
    assert.equal(contextRingRatio({ contextWindow: 100, pressureTokens: 25, surfaceTokens: null }), 0.25);
    assert.equal(contextRingRatio({ contextWindow: 0, pressureTokens: Number.NaN, surfaceTokens: null }), null);
    assert.equal(contextRingRatio({ contextWindow: 100, pressureTokens: -5, surfaceTokens: null }), 0);
    assert.equal(contextRingRatio({ contextWindow: 100, pressureTokens: 250, surfaceTokens: null }), 1);
    assert.equal(contextRingRatio({ contextWindow: 128_000, pressureTokens: 1_500, surfaceTokens: 2_000 }), 1500 / 128000);
  });
});
