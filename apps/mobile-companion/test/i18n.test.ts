// i18n tests (A024): both locales cover the same keys, placeholders interpolate, the device
// locale falls back to Vietnamese, and every US1 pairing failure maps to a specific message.

import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import {
  DEFAULT_LOCALE,
  LOCALES,
  MESSAGES,
  detectLocale,
  pairErrorFromCode,
  pairErrorFromQr,
  relativeTime,
  t,
} from '../i18n';
import type { QrRejectReason } from '../src/core';

describe('i18n tables', () => {
  it('every key exists in both locales', () => {
    const reference = Object.keys(MESSAGES.en).sort();
    for (const locale of LOCALES) {
      assert.deepEqual(Object.keys(MESSAGES[locale]).sort(), reference, `${locale} keys`);
    }
  });

  it('spec 036: the unconfirmed-lock copy exists in both locales and names the 24h grant', () => {
    const en = t('en', 'unlock.lockUnconfirmed');
    const vi = t('vi', 'unlock.lockUnconfirmed');
    assert.match(en, /not confirmed the lock/i);
    assert.match(en, /24-hour unlock grant may still be valid/i);
    assert.match(vi, /chưa xác nhận đã khoá/i);
    assert.match(vi, /24 giờ có thể vẫn còn hiệu lực/i);
  });

  it('no message is empty', () => {
    for (const locale of LOCALES) {
      for (const [key, value] of Object.entries(MESSAGES[locale])) {
        if (typeof value === 'string') assert.ok(value.trim() !== '', `${locale}:${key}`);
      }
    }
  });

  it('interpolates named placeholders', () => {
    assert.equal(t('en', 'pair.connecting', { host: 'my-pc' }), 'Connecting to my-pc…');
    assert.equal(t('vi', 'sessions.updatedAgo', { when: '2m' }), 'cập nhật 2m');
    assert.equal(t('en', 'approval.title', { tool: 'bash' }), 'Approval needed: bash');
  });

  it('falls back to Vietnamese for unknown locales', () => {
    assert.equal(detectLocale('fr-FR'), DEFAULT_LOCALE);
    assert.equal(detectLocale(null), 'vi');
    assert.equal(detectLocale('en-US'), 'en');
    assert.equal(detectLocale('vi-VN'), 'vi');
  });
});

describe('pairing failure mapping', () => {
  it('maps every QR rejection reason to a user-facing state', () => {
    const reasons: QrRejectReason[] = [
      'qr/invalid-json',
      'qr/unsupported-version',
      'qr/bad-endpoint',
      'qr/bad-cert-sha256',
      'qr/bad-pairing-code',
      'qr/bad-expires-at',
      'qr/expired',
      'qr/bad-host-name',
      'qr/bad-gateway-id',
    ];
    for (const reason of reasons) {
      const kind = pairErrorFromQr(reason);
      assert.ok(['expired', 'generic', 'appUpdate', 'pairingVersion', 'badPayload'].includes(kind), reason);
      assert.ok(t('en', `pair.error.${kind}` as never).length > 0);
    }
    assert.equal(pairErrorFromQr('qr/expired'), 'expired');
  });

  it('gives a pasted non-payload its own copy, and keeps the two update cases apart', () => {
    // The owner report: pasting something that is not a pairing string showed the generic "pairing
    // failed", which reads as "your computer refused you" — the wrong remedy for a typo or the wrong
    // field. A QR that parses as nothing is now `badPayload`; an observed expiry stays `expired`.
    for (const reason of ['qr/invalid-json', 'qr/bad-endpoint', 'qr/bad-gateway-id', 'qr/bad-host-name',
      'qr/bad-cert-sha256', 'qr/bad-pairing-code', 'qr/bad-expires-at'] as QrRejectReason[]) {
      assert.equal(pairErrorFromQr(reason), 'badPayload', reason);
    }
    assert.equal(pairErrorFromQr('qr/expired'), 'expired');
    // A version mismatch says nothing about which side is behind — `qr/unsupported-version` covers an
    // older Host, an older app, and a missing or malformed `version` alike — so it takes the
    // direction-neutral copy, never the "the app must be updated" assertion.
    assert.equal(pairErrorFromQr('qr/unsupported-version'), 'pairingVersion');
    assert.notEqual(pairErrorFromQr('qr/unsupported-version'), 'appUpdate');
    // The contract's own refusal still means the app is behind.
    assert.equal(pairErrorFromCode('client/update-app-required'), 'appUpdate');
    assert.notEqual(pairErrorFromQr('qr/invalid-json'), 'generic', 'no QR parse failure falls back to generic');
    for (const locale of LOCALES) {
      const text = t(locale, 'pair.error.badPayload');
      assert.ok(text.trim().length > 0, `${locale}: pair.error.badPayload`);
      assert.notEqual(text, t(locale, 'pair.error.generic'), `${locale}: it is not the generic failure`);
    }
    assert.notEqual(t('en', 'pair.error.badPayload'), t('vi', 'pair.error.badPayload'), 'really localized');
    // The paste-detected notice exists in both locales and points at the confirm step.
    for (const locale of LOCALES) assert.ok(t(locale, 'pair.otpDetected').trim().length > 0, `${locale}: pair.otpDetected`);
  });

  it('gives an unreadable pairing-code version its own direction-neutral copy', () => {
    // `qr/unsupported-version` is what `parsePairingQr` returns for any `version` but the one this
    // app reads, including older, missing, or a non-number: the copy must name BOTH sides, because
    // "your computer needs a newer app" is false when the phone is the side that is behind.
    for (const locale of LOCALES) {
      const text = t(locale, 'pair.error.pairingVersion');
      assert.ok(text.trim().length > 0, `${locale}: pair.error.pairingVersion`);
      assert.notEqual(text, t(locale, 'pair.error.appUpdate'), `${locale}: it is not the app-update copy`);
      assert.notEqual(text, t(locale, 'pair.error.generic'), `${locale}: it is not the generic failure`);
    }
    assert.notEqual(
      t('en', 'pair.error.pairingVersion'),
      t('vi', 'pair.error.pairingVersion'),
      'really localized',
    );
    // The neutral copy still offers the only remedy the user has: get a fresh code afterwards.
    assert.match(t('en', 'pair.error.pairingVersion'), /up to date/i);
    assert.match(t('vi', 'pair.error.pairingVersion'), /cập nhật/i);
  });

  it('maps contract + client codes to the US1 error states', () => {
    assert.equal(pairErrorFromCode('remote/disabled'), 'remoteDisabled');
    assert.equal(pairErrorFromCode('client/remote-disabled'), 'remoteDisabled');
    assert.equal(pairErrorFromCode('pairing/expired'), 'expired');
    assert.equal(pairErrorFromCode('client/pin-mismatch'), 'pinMismatch');
    // The Host's own identity could not be trusted: it stated none, or it claimed another known one.
    // Both are refused locally, so each needs its own copy (a generic line would hide the cause).
    assert.equal(pairErrorFromCode('client/pairing-no-host-id'), 'noHostId');
    assert.equal(pairErrorFromCode('client/pairing-host-conflict'), 'hostConflict');
    // A pairing refused because the stored host list had not loaded yet still has to say something:
    // "bad-state" is the code the controller uses, and a generic line would hide the retry.
    assert.equal(pairErrorFromCode('client/bad-state'), 'notReady');
    assert.equal(pairErrorFromCode('client/update-app-required'), 'appUpdate');
    assert.equal(pairErrorFromCode('client/update-host-required'), 'hostUpdate');
    assert.equal(pairErrorFromCode('client/pinned-transport-unavailable'), 'unavailable');
    assert.equal(pairErrorFromCode('client/disconnected'), 'unavailable');
    assert.equal(pairErrorFromCode('agent-busy'), 'generic');
  });

  it('gives the phone its own copy for a flow it cannot complete, in both locales', () => {
    // The 8-digit code cannot be verified on a phone (no certificate rides with it, and the native
    // transport will not open an unpinned socket), so the screen must point at the QR / long string
    // instead of reporting a failure the user cannot act on.
    for (const locale of LOCALES) {
      const text = t(locale, 'pair.error.otpNative');
      assert.ok(text.trim().length > 0, `${locale}: the native OTP refusal has copy`);
      // It names the alternative the phone CAN use, which is the whole point of the message.
      assert.match(text, /QR/);
    }
    const en = t('en', 'pair.error.otpNative');
    const vi = t('vi', 'pair.error.otpNative');
    assert.notEqual(en, vi, 'the message is really localized');
    // Each identity refusal has its own line, distinct from the generic pairing failure.
    for (const key of ['pair.error.noHostId', 'pair.error.hostConflict', 'pair.error.notReady'] as const) {
      for (const locale of LOCALES) assert.ok(t(locale, key).trim().length > 0, `${locale}:${key}`);
    }
  });
});

describe('relativeTime', () => {
  it('renders short relative durations in both locales', () => {
    assert.equal(relativeTime('en', 30_000), '30s');
    assert.equal(relativeTime('en', 5 * 60_000), '5 min');
    assert.equal(relativeTime('vi', 5 * 60_000), '5 phút');
    assert.equal(relativeTime('en', 3 * 3_600_000), '3 h');
    assert.equal(relativeTime('vi', 2 * 86_400_000), '2 ngày');
    assert.equal(relativeTime('en', -5_000), '0s');
  });
});
