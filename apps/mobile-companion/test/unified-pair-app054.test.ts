// Spec 054 — native pairing link carries a certificate pin; web never adopts address/pin.

import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { describe, it } from 'node:test';
import { fileURLToPath } from 'node:url';

import { parsePairHash, parsePairLinkUrl } from '../src/core/pair-link';
import { planNativeOtpSubmit, planPairSubmit } from '../src/core/gateway-address';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const PIN = 'a'.repeat(64);
const PANEL = readFileSync(path.join(ROOT, 'src', 'ui', 'pair-panel.tsx'), 'utf8');

describe('spec 054: pair link pin', () => {
  it('parses p only as 64 lowercase hex', () => {
    assert.deepEqual(parsePairHash(`a=host:1234&c=12345678&p=${PIN}`), { address: 'host:1234', otp: '12345678', pin: PIN });
    assert.equal(parsePairHash('a=h&c=12345678')?.pin, undefined, 'bare link still parses on web');
    assert.equal(parsePairHash(`a=h&c=12345678&p=${'A'.repeat(64)}`), null);
    assert.equal(parsePairHash('a=h&c=12345678&p=abc'), null);
    assert.equal(parsePairLinkUrl(`https://x/pair#a=h&c=12345678&p=${PIN}`)?.pin, PIN);
  });

  it('native plan requires address + pin and builds the wss URL', () => {
    assert.deepEqual(planNativeOtpSubmit('host:1234', PIN), { kind: 'otp', url: 'wss://host:1234/ws/mobile', origin: 'host:1234', pin: PIN });
    assert.deepEqual(planNativeOtpSubmit('host', undefined), { kind: 'blocked', reason: 'pin-required' });
    assert.deepEqual(planNativeOtpSubmit('', PIN), { kind: 'blocked', reason: 'bad-address' });
    assert.deepEqual(planNativeOtpSubmit('host/a', PIN), { kind: 'blocked', reason: 'bad-address' });
    assert.deepEqual(planNativeOtpSubmit('host:99999', PIN), { kind: 'blocked', reason: 'bad-address' });
  });

  it('web keeps same-origin and ignores address/pin from a link', () => {
    const webPlan = { kind: 'same-origin' as const, url: 'wss://n.ts.net/ws/mobile', origin: 'https://n.ts.net' };
    assert.deepEqual(planPairSubmit(webPlan, true, true), { kind: 'otp', url: webPlan.url, origin: webPlan.origin });
    assert.match(PANEL, /if \(Platform\.OS !== 'web'\) \{\s*setOtpAddress\(link\.address\);\s*setOtpPin\(link\.pin \?\? ''\);\s*\}/);
    assert.match(PANEL, /certSha256: pin/);
  });

  it('native bare link is blocked; pin input is native only; no pin logging', () => {
    assert.match(PANEL, /bareNativeLink/);
    assert.match(PANEL, /testID="pair-otp-pin"/);
    assert.doesNotMatch(PANEL, /console\.(log|info|warn|error)/);
    assert.match(PANEL, /placeholder=\{tr\('pair\.otpPinPlaceholder'\)\}/);
  });
});
