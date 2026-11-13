import { test } from 'node:test';
import assert from 'node:assert/strict';

import { CAPABILITIES, COMPANION_PROTOCOL_VERSION } from '@dsh-ext/mobile-protocol';
import { decideCompat } from '../src/core/compat';
import { compatBannerView } from '../src/ui/compat-banner';

const V = COMPANION_PROTOCOL_VERSION;
const hello = (over: Record<string, unknown> = {}) => ({
  protocol: 3, companionProtocol: V, minClientVersion: 1, capabilities: [...CAPABILITIES], gatewayId: 'g1', ...over,
});

test('equal: ok, no banner', () => {
  const d = decideCompat(hello());
  assert.deepEqual(d, { kind: 'ok', unknownCapabilities: [], missingCapabilities: [], dismissKey: null });
  assert.equal(compatBannerView(d, new Set()), null);
});

test('newer minor: unknown capability gives a dismissible info banner', () => {
  const d = decideCompat(hello({ capabilities: [...CAPABILITIES, 'future-x'] }));
  assert.equal(d.kind, 'ok');
  const v = compatBannerView(d, new Set());
  assert.equal(v?.key, 'compat.newer');
  assert.equal(v?.blocking, false);
  assert.ok(v?.dismissKey);
  assert.equal(compatBannerView(d, new Set([v!.dismissKey!])), null);
  // a new gateway revision reopens it
  const d2 = decideCompat(hello({ protocol: 4, capabilities: [...CAPABILITIES, 'future-x'] }));
  assert.notEqual(compatBannerView(d2, new Set([v!.dismissKey!])), null);
});

test('older minor missing a capability lists it, not dismissible', () => {
  const d = decideCompat(hello({ capabilities: ['sessions-read', 'prompt', 'cancel'] }));
  assert.equal(d.kind, 'ok');
  if (d.kind === 'ok') assert.deepEqual(d.missingCapabilities, ['approval-v1']);
  const v = compatBannerView(d, new Set());
  assert.equal(v?.key, 'compat.missing');
  assert.equal(v?.dismissKey, null);
});

test('major mismatch: gateway newer', () => {
  const d = decideCompat(hello({ companionProtocol: V + 1 }));
  assert.deepEqual(d, { kind: 'incompatible', appVersion: V, gatewayVersion: V + 1, side: 'app' });
  const v = compatBannerView(d, new Set());
  assert.equal(v?.key, 'compat.incompatible');
  assert.equal(v?.blocking, true);
  assert.deepEqual(v?.params, { app: V, gateway: V + 1 });
});

test('major mismatch: gateway older', () => {
  const d = decideCompat(hello({ companionProtocol: V - 1 }), V);
  assert.equal(d.kind, 'incompatible');
  if (d.kind === 'incompatible') assert.equal(d.side, 'host');
});

test('major mismatch: minClientVersion above app', () => {
  const d = decideCompat(hello({ minClientVersion: V + 1 }));
  assert.equal(d.kind, 'incompatible');
  if (d.kind === 'incompatible') assert.equal(d.side, 'app');
});

test('malformed hello', () => {
  for (const bad of [null, 'x', {}, hello({ companionProtocol: '1' }), hello({ capabilities: 'all' }), hello({ companionProtocol: -1 })]) {
    assert.equal(decideCompat(bad).kind, 'malformed');
  }
  assert.equal(compatBannerView({ kind: 'malformed' }, new Set())?.blocking, true);
});
