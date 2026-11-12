// Spec 019 Wave 3 — permission control, view + lower-only (app half).
//
// Two layers, both pure enough to run in Node:
//   * `src/core/permission-lower.ts` — the two frames, their envelope checks and the receipt,
//     driven through a recording stand-in client (the frames are asserted, not assumed);
//   * `src/ui/permission-lower.ts` — the chip/sheet policy (capability last, data not labels, the
//     gateway's list taken as-is);
//   * `AppController` — the accessors the screen uses: no socket ⇒ `unavailable`, real refusals
//     reject with `CoreError`, a capability the Host did not advertise is never sent.
//
// The Host side is pinned by `plugins/mobile-gateway/test/permission-lower.test.mjs`; what this
// file pins is that the APP sends only the preset NAMES the Host offered (it holds no strictness
// rule of its own), never shows the Host's message, and never invents a preset the Host did not name.

import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import { AppController } from '../src/app-state';
import type { CompanionClient } from '../src/core/client';
import { CoreError } from '../src/core/errors';
import {
  lowerPermission,
  readPermissionOptions,
  reasonMessage,
  toLowerOutcome,
  toOptionsView,
} from '../src/core/permission-lower';
import {
  canLowerPermission,
  chipView,
  optionRows,
  shouldShowPermissionChip,
} from '../src/ui/permission-lower';
import { resetAppState } from './support/stubs/react-native.stub';

const SESSION = 'sess-perm';
const CAPABILITIES = ['sessions-read', 'prompt', 'cancel', 'approval-v1', 'permission-lower'];

/** A recording stand-in client: every frame is kept, so the wire is asserted rather than assumed. */
function fakeClient(state: string, reply: unknown, hello?: { capabilities?: string[] }): CompanionClient {
  const sent: Array<{ type: string; payload: unknown }> = [];
  const client = {
    state,
    hello: hello === undefined ? null : { capabilities: hello.capabilities ?? [] },
    close: () => {},
    stop: () => {},
    on: () => {},
    off: () => {},
    request: async (type: string, payload: unknown) => {
      sent.push({ type, payload });
      if (reply instanceof Error) throw reply;
      return reply as Record<string, unknown>;
    },
    __sent: sent,
  };
  return client as unknown as CompanionClient;
}

const framesOf = (client: CompanionClient): Array<{ type: string; payload: unknown }> =>
  (client as unknown as { __sent: Array<{ type: string; payload: unknown }> }).__sent;

function controllerWith(client: unknown): AppController {
  resetAppState('active');
  const controller = new AppController({ locale: () => 'en' });
  // Private on purpose: the TEST may reach in, the UI may not.
  (controller as unknown as { client: unknown }).client = client;
  return controller;
}

// ===========================================================================
// core — readPermissionOptions
// ===========================================================================

describe('core readPermissionOptions', () => {
  it('sends permission-options {sessionId} and keeps only well-formed pairs, in order', async () => {
    const client = fakeClient('ready', {
      kind: 'permission-options',
      requestId: 'r1',
      sessionId: SESSION,
      currentValue: 'workspace-write',
      options: [
        { preset: 'read-only', sandbox: 'read-only', approval: 'ask' },
        { preset: 'locked', sandbox: 'read-only', approval: 'never' },
      ],
    });
    const result = await readPermissionOptions(client, ` ${SESSION} `);
    assert.deepEqual(framesOf(client), [{ type: 'permission-options', payload: { sessionId: SESSION } }],
      'the register op reaches the wire with the trimmed id and nothing else');
    assert.equal(result.state, 'ready');
    assert.deepEqual(result.state === 'ready' ? result.value : null, {
      currentValue: 'workspace-write',
      options: [
        { preset: 'read-only', sandbox: 'read-only', approval: 'ask' },
        { preset: 'locked', sandbox: 'read-only', approval: 'never' },
      ],
    });
  });

  it('a Host saying it cannot serve presets is `unavailable`, not an error', async () => {
    for (const reply of [
      { kind: 'error', code: 'unavailable', requestType: 'permission-options' },
      { kind: 'error', code: 'custom-current', requestType: 'permission-options' },
    ]) {
      const client = fakeClient('ready', reply);
      assert.deepEqual(await readPermissionOptions(client, SESSION), { state: 'unavailable' }, JSON.stringify(reply));
    }
  });

  it('a REFUSAL that is not unavailability rejects with the Host code (never swallowed)', async () => {
    const client = fakeClient('ready', { kind: 'error', code: 'auth/forbidden-scope', requestType: 'permission-options' });
    await assert.rejects(
      () => readPermissionOptions(client, SESSION),
      (error: unknown) => error instanceof CoreError && error.code === 'auth/forbidden-scope',
    );
  });

  it('a reply about another session, or an unknown kind, is a contract violation', async () => {
    const other = fakeClient('ready', { kind: 'permission-options', sessionId: 'someone-else', currentValue: 'a', options: [] });
    await assert.rejects(() => readPermissionOptions(other, SESSION), (error: unknown) => error instanceof CoreError);
    const unknown = fakeClient('ready', { kind: 'ping' });
    await assert.rejects(() => readPermissionOptions(unknown, SESSION), (error: unknown) => error instanceof CoreError);
  });

  it('an unusable option pair rejects instead of silently shortening the Host\'s list', () => {
    assert.throws(() => toOptionsView({ options: [{ preset: 'x', sandbox: 'read-only', approval: 'maybe' }] }), (error: unknown) => error instanceof CoreError);
  });

  it('a blank id never reaches the wire', async () => {
    const client = fakeClient('ready', {});
    await assert.rejects(() => readPermissionOptions(client, '   '), (error: unknown) => error instanceof CoreError);
    assert.equal(framesOf(client).length, 0);
  });
});

// ===========================================================================
// core — lowerPermission and the receipt
// ===========================================================================

describe('core lowerPermission', () => {
  it('sends permission-lower {sessionId, preset} and reports an accepted switch', async () => {
    const client = fakeClient('ready', { kind: 'permission-lower', sessionId: SESSION, preset: 'read-only', currentValue: 'read-only', accepted: true });
    const outcome = await lowerPermission(client, SESSION, ' read-only ');
    assert.deepEqual(framesOf(client), [{ type: 'permission-lower', payload: { sessionId: SESSION, preset: 'read-only' } }],
      'a preset NAME goes on the wire — never a command line');
    assert.deepEqual(outcome, { accepted: true, preset: 'read-only', currentValue: 'read-only' });
  });

  it('each refusal reason carries its own fixed sentence and the Host\'s re-read', () => {
    const reasons = ['not-stricter', 'custom-current', 'raced', 'unavailable'] as const;
    const expected = {
      'not-stricter': 'session.permissionNotStricter',
      'custom-current': 'session.permissionCustomCurrent',
      raced: 'session.permissionRaced',
      unavailable: 'session.permissionUnavailable',
    };
    for (const reason of reasons) {
      const receipt = toLowerOutcome({ kind: 'permission-lower', sessionId: SESSION, currentValue: 'workspace-write', accepted: false, reason }, SESSION);
      assert.equal(receipt.accepted, false);
      assert.equal(receipt.accepted === false ? receipt.reason : null, reason);
      assert.equal(receipt.accepted === false ? receipt.message : null, expected[reason]);
    }
    // An error FRAME with the same code (the gateway's typed refusal) reads the same way; its raw
    // `message` is not what the app shows, so it is not part of the receipt at all.
    const framed = toLowerOutcome({ kind: 'error', code: 'not-stricter', requestType: 'permission-lower', message: 'host text that must never render' }, SESSION);
    assert.equal(framed.accepted, false);
    assert.equal(framed.accepted === false ? framed.message : null, 'session.permissionNotStricter');
    assert.equal(JSON.stringify(framed).includes('host text'), false, 'the Host message never becomes app copy');
    assert.equal(reasonMessage(null), 'session.permissionError');
  });

  it('a frame this app never builds (bad-request) or the device\'s grant (auth/*) rejects', async () => {
    for (const code of ['bad-request', 'auth/forbidden-scope']) {
      const client = fakeClient('ready', { kind: 'error', code, requestType: 'permission-lower' });
      await assert.rejects(
        () => lowerPermission(client, SESSION, 'read-only'),
        (error: unknown) => error instanceof CoreError && error.code === code,
        code,
      );
    }
  });

  it('a receipt with no accepted flag, or an accepted one naming no preset, is a contract violation', async () => {
    const noFlag = fakeClient('ready', { kind: 'permission-lower', sessionId: SESSION, currentValue: 'a' });
    await assert.rejects(() => lowerPermission(noFlag, SESSION, 'read-only'), (error: unknown) => error instanceof CoreError);
    const noPreset = fakeClient('ready', { kind: 'permission-lower', sessionId: SESSION, currentValue: 'a', accepted: true });
    await assert.rejects(() => lowerPermission(noPreset, SESSION, 'read-only'), (error: unknown) => error instanceof CoreError);
  });

  it('never sends an empty preset', async () => {
    const client = fakeClient('ready', {});
    await assert.rejects(() => lowerPermission(client, SESSION, '  '), (error: unknown) => error instanceof CoreError);
    assert.equal(framesOf(client).length, 0);
  });
});

// ===========================================================================
// ui — the chip and the sheet's rows
// ===========================================================================

describe('ui permission chip', () => {
  it('is shown only with a ready socket, the capability AND a reported preset', () => {
    const base = { connection: 'ready', capabilities: CAPABILITIES, preset: 'workspace-write' };
    assert.equal(shouldShowPermissionChip(base), true);
    // Negative controls: one thing changed each time.
    assert.equal(shouldShowPermissionChip({ ...base, connection: 'connecting' }), false, 'a quiet handshake is not a permission problem');
    assert.equal(shouldShowPermissionChip({ ...base, capabilities: CAPABILITIES.filter((c) => c !== 'permission-lower') }), false);
    assert.equal(shouldShowPermissionChip({ ...base, capabilities: null }), false);
    assert.equal(shouldShowPermissionChip({ ...base, capabilities: undefined }), false);
    assert.equal(shouldShowPermissionChip({ ...base, preset: null }), false, 'an absent projection hides the chip');
    assert.equal(shouldShowPermissionChip({ ...base, preset: '   ' }), false);
    assert.equal(canLowerPermission(CAPABILITIES), true);
  });

  it('renders the Host\'s preset as data; the label is only the announcement', () => {
    const view = chipView({
      connection: 'ready',
      capabilities: CAPABILITIES,
      preset: ' workspace-write ',
      label: (preset) => `Permission: ${preset}`,
    });
    assert.deepEqual(view, { label: 'Permission: workspace-write', preset: 'workspace-write' });
    assert.equal(chipView({ connection: 'ready', capabilities: CAPABILITIES, preset: null, label: () => 'x' }), null);
  });
});

describe('ui permission sheet rows', () => {
  const describePair = (option: { sandbox: string; approval: string }) => `sandbox ${option.sandbox} · approval ${option.approval}`;

  it('lists exactly the gateway\'s offer (it already filtered), custom/auto never as targets', () => {
    const rows = optionRows([
      { preset: 'read-only', sandbox: 'read-only', approval: 'ask' },
      { preset: 'auto', sandbox: 'danger-full-access', approval: 'ask' },
      { preset: 'read-only', sandbox: 'read-only', approval: 'ask' },
    ], describePair);
    assert.deepEqual(rows, [{ preset: 'read-only', description: 'sandbox read-only · approval ask' }],
      'a looser row the gateway would never send is still not drawn twice, and auto is never offered');
  });

  it('a reply with no stricter preset yields no rows (a normal state, not an error)', () => {
    assert.deepEqual(optionRows([], describePair), []);
  });
});

// ===========================================================================
// AppController — the accessors
// ===========================================================================

describe('AppController.readPermissionOptions / lowerPermission', () => {
  it('with NO client both answer `unavailable`-style / reject, without a throw at the read', async () => {
    resetAppState('active');
    const controller = new AppController({ locale: () => 'en' });
    try {
      assert.deepEqual(await controller.readPermissionOptions(SESSION), { state: 'unavailable' });
      await assert.rejects(
        () => controller.lowerPermission(SESSION, 'read-only'),
        (error: unknown) => error instanceof CoreError && error.code === 'client/bad-state',
      );
    } finally {
      controller.stop();
    }
  });

  it('a ready Host WITHOUT the capability is never sent either frame', async () => {
    const client = fakeClient('ready', { kind: 'ping' }, { capabilities: ['sessions-read', 'prompt'] });
    const controller = controllerWith(client);
    try {
      assert.deepEqual(await controller.readPermissionOptions(SESSION), { state: 'unavailable' });
      assert.equal(framesOf(client).length, 0, 'a Host that never advertised the capability is not asked');
    } finally {
      controller.stop();
    }
  });

  it('a ready Host WITH the capability reads the options and a real refusal rejects with its code', async () => {
    const client = fakeClient('ready', { kind: 'permission-options', sessionId: SESSION, currentValue: 'workspace-write', options: [] }, { capabilities: CAPABILITIES });
    const controller = controllerWith(client);
    try {
      const read = await controller.readPermissionOptions(SESSION);
      assert.equal(read.state, 'ready');
      assert.equal(framesOf(client)[0]?.type, 'permission-options');

      const refused = fakeClient('ready', { kind: 'error', code: 'session/not-found', requestType: 'permission-options' }, { capabilities: CAPABILITIES });
      (controller as unknown as { client: unknown }).client = refused;
      await assert.rejects(
        () => controller.readPermissionOptions(SESSION),
        (error: unknown) => error instanceof CoreError && error.code === 'session/not-found',
        'a refusal is surfaced, never swallowed into an empty sheet',
      );
    } finally {
      controller.stop();
    }
  });

  it('an accepted switch moves the session row; a refusal keeps the receipt for the sheet', async () => {
    const client = fakeClient('ready', { kind: 'permission-lower', sessionId: SESSION, preset: 'read-only', currentValue: 'read-only', accepted: true }, { capabilities: CAPABILITIES });
    const controller = controllerWith(client);
    try {
      const outcome = await controller.lowerPermission(SESSION, 'read-only');
      assert.deepEqual(outcome, { accepted: true, preset: 'read-only', currentValue: 'read-only' });
      assert.deepEqual(framesOf(client), [{ type: 'permission-lower', payload: { sessionId: SESSION, preset: 'read-only' } }]);
    } finally {
      controller.stop();
    }

    const refusedClient = fakeClient('ready', { kind: 'permission-lower', sessionId: SESSION, currentValue: 'workspace-write', accepted: false, reason: 'not-stricter' }, { capabilities: CAPABILITIES });
    const second = controllerWith(refusedClient);
    try {
      const receipt = await second.lowerPermission(SESSION, 'workspace-write');
      assert.equal(receipt.accepted, false);
      assert.equal(receipt.accepted === false ? receipt.message : null, 'session.permissionNotStricter');
    } finally {
      second.stop();
    }
  });
});
