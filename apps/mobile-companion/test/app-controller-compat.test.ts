// Controller-level smoke tests for the Spec 029 compat surface (`snapshot().compat`,
// `dismissCompat`, `snapshot().dismissedCompat`), pinned BEFORE the AppController split
// (docs/arch-notes/split-plan-20261114.md, "Before step 3").
//
// The "gateway" here is a stand-in client carrying the `hello` a Host would send; the pure
// classification itself is covered by compat.test.ts. Only the facade wiring is pinned here.

import assert from 'node:assert/strict';
import { beforeEach, describe, it } from 'node:test';

import { CAPABILITIES, COMPANION_PROTOCOL_VERSION } from '@dsh-ext/mobile-protocol';

import { AppController } from '../src/app-state';
import { resetAppState } from './support/stubs/react-native.stub';

const GATEWAY = 'gw-compat';

function hello(over: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    kind: 'hello',
    protocol: 3,
    companionProtocol: COMPANION_PROTOCOL_VERSION,
    minClientVersion: COMPANION_PROTOCOL_VERSION,
    capabilities: [...CAPABILITIES],
    gatewayId: GATEWAY,
    ...over,
  };
}

function fakeGatewayClient(h: unknown): unknown {
  return {
    state: 'ready',
    hello: h,
    webPush: null,
    close: () => {},
    stop: () => {},
    on: () => () => {},
    off: () => {},
  };
}

function controllerWith(h: unknown): AppController {
  const controller = new AppController({ locale: () => 'en' });
  (controller as unknown as { client: unknown }).client = fakeGatewayClient(h);
  return controller;
}

describe('AppController compat (Spec 029, controller level)', () => {
  beforeEach(() => resetAppState('active'));

  it('compat is null before any hello', () => {
    const c = new AppController({ locale: () => 'en' });
    try {
      assert.equal(c.snapshot().compat, null);
      assert.deepEqual(c.snapshot().dismissedCompat, []);
    } finally {
      c.stop();
    }
  });

  it('ok: matching protocol and full capability set', () => {
    const c = controllerWith(hello());
    try {
      assert.deepEqual(c.snapshot().compat, { kind: 'ok', unknownCapabilities: [], missingCapabilities: [], dismissKey: null });
    } finally {
      c.stop();
    }
  });

  it('newer: unknown capabilities surface with a dismiss key', () => {
    const c = controllerWith(hello({ capabilities: [...CAPABILITIES, 'zz-future-v9'] }));
    try {
      const compat = c.snapshot().compat;
      assert.equal(compat?.kind, 'ok');
      if (compat?.kind !== 'ok') return;
      assert.deepEqual(compat.unknownCapabilities, ['zz-future-v9']);
      assert.equal(compat.dismissKey, `${GATEWAY}|3|zz-future-v9`);
    } finally {
      c.stop();
    }
  });

  it('missing: an older gateway that lacks a baseline capability', () => {
    const dropped = CAPABILITIES[0] as string;
    const c = controllerWith(hello({ capabilities: CAPABILITIES.filter((x) => x !== dropped) }));
    try {
      const compat = c.snapshot().compat;
      assert.equal(compat?.kind, 'ok');
      if (compat?.kind === 'ok') assert.deepEqual(compat.missingCapabilities, [dropped]);
    } finally {
      c.stop();
    }
  });

  it('incompatible: a newer major line asks the app to update', () => {
    const c = controllerWith(hello({ companionProtocol: COMPANION_PROTOCOL_VERSION + 1 }));
    try {
      assert.deepEqual(c.snapshot().compat, {
        kind: 'incompatible',
        appVersion: COMPANION_PROTOCOL_VERSION,
        gatewayVersion: COMPANION_PROTOCOL_VERSION + 1,
        side: 'app',
      });
    } finally {
      c.stop();
    }
  });

  it('incompatible: a refused hello kept after the client is gone still reports compat', () => {
    const c = new AppController({ locale: () => 'en' });
    try {
      (c as unknown as { mismatchHello: unknown }).mismatchHello = hello({ minClientVersion: COMPANION_PROTOCOL_VERSION + 1 });
      assert.equal(c.snapshot().compat?.kind, 'incompatible');
    } finally {
      c.stop();
    }
  });

  it('dismissCompat persists the key in the snapshot, once', () => {
    const c = controllerWith(hello({ capabilities: [...CAPABILITIES, 'zz-future-v9'] }));
    try {
      const compat = c.snapshot().compat;
      const key = compat?.kind === 'ok' ? compat.dismissKey : null;
      assert.ok(key);
      c.dismissCompat(key);
      c.dismissCompat(key);
      assert.deepEqual(c.snapshot().dismissedCompat, [key]);
    } finally {
      c.stop();
    }
  });
});
