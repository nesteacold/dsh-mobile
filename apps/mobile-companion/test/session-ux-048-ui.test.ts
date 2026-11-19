// Spec 048 §1/§2/§4 — UI tests for the opaque web header, the PWA image batch and the fixed
// progress indicator. Pure helpers exported by the screen are exercised directly; the JSX wiring is
// checked against source (this suite has no renderer), in the established style of the repo.

import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { describe, it } from 'node:test';
import { fileURLToPath } from 'node:url';

import {
  addReceipt,
  admitImageBatch,
  clearSnapshottedReceipts,
  MAX_BATCH_IMAGES,
  progressPhase,
  receiptsForSession,
  registerPickedObjectUrl,
  resolveHeaderBackground,
  type AttachmentReceipt,
} from '../app/session/[id]';
import { MESSAGES } from '../i18n';
import { CLIENT_UPLOAD_MAX_BYTES } from '../src/core/remote-upload';
import { isPickerObjectUrl } from '../src/platform/picked-file.web';

const SCREEN = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', 'app', 'session', '[id].tsx');
const screen = readFileSync(SCREEN, 'utf8');
const SESSION = 'sess-048';

interface FakeAsset { uri: string; name: string; size: number; mimeType: string }

function asset(index: number, size = 10): FakeAsset {
  return { uri: `blob:https://pwa.invalid/pick-${index}`, name: `p${index}.png`, size, mimeType: 'image/png' };
}

interface BatchOutcome {
  uploaded: string[]; receipts: AttachmentReceipt[]; revokes: string[]; failed: string | null;
}

/** Behavioural driver: only the screen's OWN pure helpers drive admission, cleanup and receipts. */
async function runBatch(input: {
  assets: FakeAsset[]; failAt?: number; cancelAt?: number; stale?: boolean;
}): Promise<BatchOutcome> {
  const releases: Array<() => void> = [];
  const revoked: string[] = [];
  const receipts: AttachmentReceipt[] = [];
  const uploaded: string[] = [];
  let failed: string | null = null;
  let live = true;
  try {
    for (const item of input.assets) {
      const owner = { releaseObjectUrl: () => {} };
      registerPickedObjectUrl(owner, item.uri, isPickerObjectUrl, (url) => revoked.push(url));
      releases.push(owner.releaseObjectUrl);
    }
    if (input.stale) live = false;
    if (!live) return { uploaded, receipts, revokes: revoked, failed };
    admitImageBatch(input.assets.map((item) => ({ size: item.size })));
    for (let index = 0; index < input.assets.length; index += 1) {
      if (!live || (input.cancelAt !== undefined && index >= input.cancelAt)) break;
      const item = input.assets[index] as FakeAsset;
      if (input.failAt === index) { failed = 'session.attachReadFailed'; break; }
      uploaded.push(item.name);
      const next = addReceipt(receipts, { sessionId: SESSION, name: item.name, receiptId: `r${index}` });
      receipts.splice(0, receipts.length, ...next);
    }
  } catch (error) {
    const code = (error as { code?: string } | null)?.code;
    failed = code === 'too-many-files' ? 'session.attachTooMany' : 'session.attachTooLarge';
  } finally {
    for (const release of releases) release();
  }
  return { uploaded, receipts, revokes: revoked, failed };
}

describe('spec 048 §1 — opaque web header', () => {
  it('uses the opaque same-scheme token on web and keeps the native translucent look', () => {
    const colors = { bg: '#0f172a', glassSolid: '#101927' };
    assert.equal(resolveHeaderBackground(colors, true), colors.glassSolid);
    assert.equal(resolveHeaderBackground(colors, true).includes('rgba'), false);
    assert.equal(resolveHeaderBackground(colors, false), '#0f172ad9', 'native keeps the alpha suffix');
    // Spec 049 supersedes the scheme-derived web fill: the header uses the fixed dark chrome pair.
    assert.ok(screen.includes('backgroundColor: isWeb ? chrome.surface : resolveHeaderBackground(colors, false)'));
    assert.equal(/backgroundColor:\s*translucent\(colors\.bg\)/.test(screen), false);
    assert.ok(screen.includes('onLayout={(event) => setHeaderMeasured('), 'header measurement kept');
    assert.ok(screen.includes('testID="session-back"') && screen.includes('testID="session-more"'));
    assert.ok(screen.includes('borderBottomColor: colors.border'), 'floating border kept');
  });
});

describe('spec 048 §2 — web image batch', () => {
  it('admits the WHOLE batch before any read: count and total ceiling', () => {
    assert.equal(MAX_BATCH_IMAGES, 6);
    assert.throws(
      () => admitImageBatch(Array.from({ length: 7 }, (_v, i) => ({ size: 1 }))),
      (error: unknown) => (error as { code?: string }).code === 'too-many-files',
    );
    assert.throws(
      () => admitImageBatch([{ size: CLIENT_UPLOAD_MAX_BYTES }, { size: 1 }]),
      (error: unknown) => (error as { code?: string }).code === 'file-too-large',
    );
    for (const size of [undefined, Number.NaN, -1]) {
      assert.throws(() => admitImageBatch([{ size }]));
    }
    admitImageBatch(Array.from({ length: 6 }, () => ({ size: 1 })));
  });

  it('preflights EVERY DOM File.size before any read, not just the current asset', () => {
    // A small reported size must not hide a huge DOM File on the third image: the whole batch is
    // refused up front, with the same fixed code as spec 044's per-file admission.
    assert.throws(
      () => admitImageBatch([
        { size: 1, fileSize: 1 },
        { size: 1, fileSize: 1 },
        { size: 1, fileSize: CLIENT_UPLOAD_MAX_BYTES + 1 },
      ]),
      (error: unknown) => (error as { code?: string }).code === 'file-too-large',
    );
    for (const fileSize of [Number.NaN, -1, Number.POSITIVE_INFINITY]) {
      assert.throws(() => admitImageBatch([{ size: 1, fileSize }]));
    }
    // The authoritative DOM File size also counts toward the batch total.
    assert.throws(
      () => admitImageBatch([
        { size: 1, fileSize: CLIENT_UPLOAD_MAX_BYTES },
        { size: 1, fileSize: 1 },
      ]),
      (error: unknown) => (error as { code?: string }).code === 'file-too-large',
    );
    assert.ok(screen.includes('fileSize: (asset as { file?: { size?: number } }).file?.size'));
  });

  it('uploads sequentially, keeps every successful receipt and revokes all six URLs', async () => {
    const assets = Array.from({ length: 3 }, (_v, i) => asset(i));
    const result = await runBatch({ assets });
    assert.deepEqual(result.uploaded, ['p0.png', 'p1.png', 'p2.png']);
    assert.deepEqual(result.receipts.map((receipt) => receipt.receiptId), ['r0', 'r1', 'r2']);
    assert.equal(result.revokes.length, 3);
    assert.equal(result.failed, null);
  });

  it('stops on failure, keeps prior receipts and still revokes UNREAD assets', async () => {
    const result = await runBatch({ assets: [asset(0), asset(1), asset(2)], failAt: 1 });
    assert.deepEqual(result.uploaded, ['p0.png']);
    assert.deepEqual(result.receipts.map((receipt) => receipt.receiptId), ['r0']);
    assert.equal(result.failed, 'session.attachReadFailed');
    assert.equal(result.revokes.length, 3, 'the unread third asset is revoked too');
  });

  it('cancel stops the batch, keeps receipts and revokes every asset', async () => {
    const result = await runBatch({ assets: [asset(0), asset(1), asset(2)], cancelAt: 1 });
    assert.deepEqual(result.uploaded, ['p0.png']);
    assert.equal(result.receipts.length, 1, 'cancel never deletes a successful receipt');
    assert.equal(result.revokes.length, 3);
    assert.equal(result.failed, null);
  });

  it('a stale picker still revokes every asset and sends no upload', async () => {
    const result = await runBatch({ assets: [asset(0), asset(1)], stale: true });
    assert.deepEqual(result.uploaded, []);
    assert.equal(result.receipts.length, 0);
    assert.deepEqual(result.revokes, [asset(0).uri, asset(1).uri]);
  });

  it('snapshots the exact receiptIds on send; ack clears only that set', async () => {
    const pending = [
      { sessionId: SESSION, name: 'a.png', receiptId: 'r0' },
      { sessionId: SESSION, name: 'b.png', receiptId: 'r1' },
      { sessionId: 'other', name: 'c.png', receiptId: 'r9' },
    ];
    assert.deepEqual(receiptsForSession(pending, SESSION).map((r) => r.receiptId), ['r0', 'r1']);
    const withNew = addReceipt(pending, { sessionId: SESSION, name: 'c.png', receiptId: 'r2' });
    const afterAck = clearSnapshottedReceipts(withNew, SESSION, ['r0', 'r1']);
    assert.deepEqual(afterAck.map((r) => r.receiptId), ['r9', 'r2'], 'a receipt added mid-send survives');
    assert.deepEqual(clearSnapshottedReceipts(withNew, SESSION, []), withNew, 'refusal/timeout keeps them all');
    assert.deepEqual(clearSnapshottedReceipts(withNew, 'other', ['r0']), withNew, 'another session clears nothing');
    assert.deepEqual(receiptsForSession(pending, 'other').map((r) => r.receiptId), ['r9']);
  });

  it('only WEB image picks are multiple; native and File stay single', () => {
    assert.ok(screen.includes("const multi = kind === 'image' && Platform.OS === 'web'"));
    assert.ok(screen.includes('multiple: multi'));
    assert.equal(screen.includes('multiple: true'), false, 'no unconditional multi-pick');
    assert.ok(screen.includes('base64: false'));
    assert.ok(screen.includes('if (multi) admitImageBatch(assets.map('));
    assert.ok(screen.includes('setAttachReceipts([])'), 'session switch drops every receipt');
  });
});

describe('spec 048 §4 — progress visibility', () => {
  it('derives sending/processing/clear from existing state only', () => {
    assert.equal(progressPhase({ sending: true, outgoing: [], running: false }), 'sending');
    assert.equal(progressPhase({ sending: false, outgoing: [{ status: 'queued' }], running: false }), 'sending');
    assert.equal(progressPhase({ sending: false, outgoing: [{ status: 'sent' }], running: false }), 'sending');
    assert.equal(progressPhase({ sending: false, outgoing: [{ status: 'acked' }], running: false }), null);
    assert.equal(progressPhase({ sending: false, outgoing: [{ status: 'failed' }], running: false }), null,
      'a rejected prompt is terminal; no permanent "Đang gửi…"');
    assert.equal(progressPhase({ sending: false, outgoing: [{ status: 'failed' }], running: true }), 'processing');
    assert.equal(progressPhase({ sending: false, outgoing: [], running: true }), 'processing');
    assert.equal(progressPhase({ sending: false, outgoing: [], running: false }), null);
  });

  it('renders fixed localized copy and never inlines private reasoning', () => {
    for (const locale of ['en', 'vi'] as const) {
      assert.equal(typeof MESSAGES[locale]['session.sending'], 'string');
      assert.equal(typeof MESSAGES[locale]['session.processing'], 'string');
      assert.ok((MESSAGES[locale]['session.sending'] as string).trim().length > 0);
    }
    assert.equal(MESSAGES.vi['session.sending'], 'Đang gửi…');
    assert.equal(MESSAGES.vi['session.processing'], 'Đang xử lý…');
    assert.ok(screen.includes('testID="session-progress-indicator"'));
    assert.ok(screen.includes("phase === 'sending' ? tr('session.sending')"));
    // Spec 050 supersedes the static processing copy with the observed elapsed value.
    assert.ok(screen.includes("phase === 'processing' ? tr('session.processingElapsed', { elapsed: formatProcessingElapsed(elapsedMs) })"));
    assert.ok(screen.includes('pointerEvents="none"'), 'non-blocking');
    assert.ok(screen.includes('running: session?.state === \'running\''));
    assert.ok(screen.includes('outgoing: snapshot.outgoing'));
    assert.ok(screen.includes('<ProcessReasoning reasoning={message.reasoning} tr={tr} />'), 'disclosure unchanged');
  });
});
