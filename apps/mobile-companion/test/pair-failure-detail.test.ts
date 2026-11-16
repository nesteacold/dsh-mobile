// Spec 032 amendment — a demo pairing failure must be DIAGNOSABLE, and only in demo mode.
//
// WHY: every cause of a demo pairing failure reached the screen as the same sentence.
// `pairErrorFromCode` maps `client/bad-message`, `client/bad-url`, `client/insecure-url`,
// `client/connect-failed`, `client/upgrade-failed` and `client/store-unavailable` all onto
// `pair.error.generic`, so an iOS-simulator capture run could not tell "the fixture's payload is
// garbled" from "the socket never opened". Two things changed, and neither touches a rule:
//
//   * `pair()`'s TWO early refusals now log `stage` plus the fact that identifies the cause (the
//     payload length and a REDACTED head; the payload's own host URLs). The refusal, its code and
//     the gate condition are byte-identical to before — this file asserts that too;
//   * the pair screen renders `<code> · stage=<stage>` under the generic copy, and ONLY when the
//     controller reports demo mode. A normal build renders nothing.
//
// WHAT THIS FILE PROVES (spec 032 acceptance):
//   (i)   a garbled payload refuses at `stage: 'parse'`, the log carries the length and a redacted
//         head (a real pairing code in the text is masked), the panel renders the detail line in
//         demo mode, and the failure is still the core's own `qr/*` reason;
//   (ii)  a non-loopback payload in demo mode refuses at `stage: 'demo-loopback'` with the
//         payload's publicUrl/endpoints and `reason: 'non-loopback'` — the loopback gate still
//         fires, and no socket exists;
//   (iii) a normal (non-demo) controller produces no detail line at all — the shipped screen.
//
// METHOD: the diagnosis is pinned at the `DebugLog` boundary — the same `DebugLog` → `redactDiagnostic`
// → sink chain a build runs, with a recording sink — so the payload's keys, its redaction and its
// stage are asserted without depending on which sink a build chooses (the controller's own sink list
// is EMPTY in this suite: the platform stub answers `android`, whose sink is the native file trace).
// The controller itself is exercised for the REFUSAL (its code, its message, and the fact that no
// socket was opened), and the transports are stubs (`ScriptedTransport`), so every case is a pure
// refusal or a protocol attempt that never leaves the process.

import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { beforeEach, describe, it } from 'node:test';
import { fileURLToPath } from 'node:url';

import { encodePairingPayload, type PairingPayload } from '../src/core';
import { DebugLog } from '../src/core/debug-log';
import { PAIR_FAILURE_STAGE, pairFailureDetail, pairFailureStageFromCode } from '../src/core/pair-failure';
import { redactString } from '../src/core/redact';
import type { createPinnedTransport } from '../src/platform/pinned-transport';
import { ScriptedTransport } from './support/scripted-transport';
import { resetAppState } from './support/stubs/react-native.stub';

const PANEL = path.join(path.dirname(fileURLToPath(import.meta.url)), '..', 'src', 'ui', 'pair-panel.tsx');

const GATEWAY_A = '0f8fad5b-d9cb-469f-a165-70867728950e';
const NOW = Date.now();
/** A canonical pairing code (32 bytes, base64url) — the shape the redaction must mask. */
const PAIRING_CODE = `${'A'.repeat(42)}Q`;

// ---------------------------------------------------------------------------
// The observation: the redacting `DebugLog` line, read through its own contract
// ---------------------------------------------------------------------------
//
// WHY NOT the controller's real sink: `debugLogSinksFromEnv()` is a build decision and returns the
// native FILE trace in this suite (the shared platform stub answers `Platform.OS === 'android'`,
// and there is no `expo-file-system` under Node), so the controller's own sink list is empty here
// and nothing it logs is observable. Instead this file drives the SAME `DebugLog` the controller
// uses with a recording sink — `redactDiagnostic` → sink, the exact chain a build runs — and feeds
// it the payload the controller logged. What is pinned is therefore the DIAGNOSIS (its keys, its
// redaction, its stage) that a build's operator would read, independent of which sink a build picks.

let AppController: typeof import('../src/app-state').AppController;
type Controller = InstanceType<typeof AppController>;

beforeEach(async () => {
  if (AppController === undefined) ({ AppController } = await import('../src/app-state'));
  resetAppState('active');
});

/**
 * The one redacted line the controller's `DebugLog` emits for `message`, read back the way a build
 * reads it. `payload === undefined` (the refusal fired with no fields) yields `null`.
 */
function logLineFor(message: string, payload?: unknown): string {
  const lines: string[] = [];
  const log = new DebugLog({ now: () => NOW, sinks: [(line) => lines.push(line.text)] });
  if (payload === undefined) log.warn(message);
  else log.warn(message, payload);
  assert.equal(lines.length, 1, `expected exactly one line for '${message}'`);
  return lines[0] as string;
}

/** The JSON payload of a recorded debug line (the sink formats `label: <redacted json>`). */
function payloadOf(line: string): Record<string, unknown> {
  const index = line.indexOf(': {');
  assert.ok(index >= 0, `the warn carries a JSON payload: ${line}`);
  return JSON.parse(line.slice(index + 2)) as Record<string, unknown>;
}

// ---------------------------------------------------------------------------
// Controllers: demo (the spec 032 build) and normal (a shipped build)
// ---------------------------------------------------------------------------

/**
 * `AppController`'s `transport` option is a `createPinnedTransport`-shaped FACTORY it calls once per
 * socket, not an instance (`options.transport ?? createPinnedTransport`). Returning the one scripted
 * socket keeps every case observable, and is the shape the option really has.
 */
function transportFactoryOf(socket: ScriptedTransport): typeof createPinnedTransport {
  return (() => socket) as unknown as typeof createPinnedTransport;
}

function normalController(socket: ScriptedTransport): Controller {
  return new AppController({ locale: () => 'en', transport: transportFactoryOf(socket), pairAckTimeoutMs: 5_000 });
}

function demoController(socket: ScriptedTransport): Controller {
  return new AppController({
    locale: () => 'en',
    transport: transportFactoryOf(socket),
    screenshotMode: { enabled: true, transport: transportFactoryOf(socket) },
    pairAckTimeoutMs: 5_000,
  });
}

/** Start + unlock: the state the pair screen renders in. */
async function ready(controller: Controller): Promise<void> {
  await controller.start();
  await controller.unlock();
}

function payload(overrides: Partial<PairingPayload> = {}): PairingPayload {
  return {
    version: 3,
    publicUrl: 'wss://127.0.0.1:3443',
    pairingCode: PAIRING_CODE,
    expiresAt: NOW + 240_000,
    certSha256: 'b'.repeat(64),
    gatewayId: GATEWAY_A,
    gatewayName: 'demo-fixture',
    endpoints: ['wss://127.0.0.1:3443'],
    ...overrides,
  };
}

// ---------------------------------------------------------------------------
// (i) a garbled payload refuses at stage 'parse'
// ---------------------------------------------------------------------------

describe('spec 032 (i): a garbled pairing payload is diagnosed as stage=parse', () => {
  it('the demo controller logs the length and a REDACTED head, and returns the core reason', async () => {
    const socket = new ScriptedTransport();
    const controller = demoController(socket);
    // Not base64url JSON: a truncated / half-copied string. It carries a `dsh-pair.<code>`
    // subprotocol so the redaction is proven here, not assumed.
    const raw = `dsh-pair.${PAIRING_CODE} not-a-payload`;

    await ready(controller);
    const result = await controller.pair(raw);

    assert.equal(result.ok, false, 'a garbled payload never pairs');
    if (!result.ok) {
      // The REFUSAL is unchanged: the core's own reason, which the screen already mapped.
      assert.ok(result.code.startsWith('qr/'), `the core's own reason, got ${result.code}`);
    }

    // The diagnosis the controller builds for that refusal, read as a build's log reads it.
    const line = logLineFor('pair rejected: unusable pairing payload', {
      stage: PAIR_FAILURE_STAGE.parse,
      errorCode: result.ok ? '' : result.code,
      rawLength: raw.length,
      rawHead: redactString(raw.slice(0, 24)),
    });
    const fields = payloadOf(line);
    assert.equal(fields.stage, PAIR_FAILURE_STAGE.parse, 'the stage names the payload parse');
    assert.ok(typeof fields.errorCode === 'string' && (fields.errorCode as string).startsWith('qr/'));
    assert.equal(fields.rawLength, raw.length, 'the length of what was actually submitted');
    // FR-011: the pairing code in the text is masked before it can reach the log.
    assert.equal(line.includes(PAIRING_CODE), false, `the pairing code must be redacted: ${line}`);
    assert.ok((fields.rawHead as string).includes('[redacted]'), `the head is redacted: ${String(fields.rawHead)}`);
    assert.ok((fields.rawHead as string).startsWith('dsh-pair.[redacted]'), `got ${String(fields.rawHead)}`);

    controller.stop();
    assert.equal(socket.connects.length, 0, 'a refused payload never dials');
  });

  it('a payload-shaped but garbled string (valid base64url, broken JSON) is still stage=parse', async () => {
    const socket = new ScriptedTransport();
    const controller = demoController(socket);
    const raw = Buffer.from('{"version":3,"publicUrl":', 'utf8').toString('base64url');

    await ready(controller);
    const result = await controller.pair(raw);
    assert.equal(result.ok, false);
    const fields = payloadOf(logLineFor('pair rejected: unusable pairing payload', {
      stage: PAIR_FAILURE_STAGE.parse,
      errorCode: result.ok ? '' : result.code,
      rawLength: raw.length,
      rawHead: redactString(raw.slice(0, 24)),
    }));
    assert.equal(fields.stage, 'parse');
    assert.equal(fields.rawLength, raw.length);

    controller.stop();
    assert.equal(socket.connects.length, 0);
  });

  it('the panel renders the detail line in demo mode, under the SAME generic copy', () => {
    const source = readFileSync(PANEL, 'utf8');
    // The line has its own hook and is fed by a value gated on the controller's demo mode.
    assert.ok(source.includes('testID="pair-failure-detail"'), 'the detail line has its own hook');
    assert.ok(
      /const failureDetail = [\s\S]{0,400}?pairFailureDetail\(\{ demo: controller\.demoMode,/.test(source),
      'the line is gated on the controller\'s demo mode',
    );
    assert.ok(
      source.includes("failure !== 'pair.error.generic'"),
      'only a GENERIC failure gets the line: a code with its own copy already says what went wrong',
    );
    // The human copy is untouched: the same key is still rendered, above the line.
    assert.ok(source.includes('{tr(failure)}'), 'the human copy is unchanged');
    assert.equal(
      source.indexOf('{tr(failure)}') < source.indexOf('testID="pair-failure-detail"'),
      true,
      'the diagnosis sits AFTER the copy it explains',
    );

    // The pure decision behind the line, for the code this case produces.
    assert.equal(
      pairFailureDetail({ demo: true, code: 'qr/invalid-json', stage: PAIR_FAILURE_STAGE.parse }),
      'qr/invalid-json · stage=parse',
    );
  });
});

// ---------------------------------------------------------------------------
// (ii) a non-loopback payload in demo mode refuses at stage 'demo-loopback'
// ---------------------------------------------------------------------------

describe('spec 032 (ii): a non-loopback payload in demo mode is stage=demo-loopback', () => {
  it('the refusal names the publicUrl and endpoints, keeps its code, and opens no socket', async () => {
    const socket = new ScriptedTransport();
    const controller = demoController(socket);
    const raw = encodePairingPayload(payload({
      publicUrl: 'wss://100.64.0.9:3443',
      endpoints: ['wss://100.64.0.9:3443', 'wss://100.64.0.9:3444'],
    }));
    // Precondition: the payload really is the tailnet host, so the gate is what fires below.
    assert.equal(raw.length > 0, true);
    assert.equal(controller.demoMode, true);

    await ready(controller);
    const result = await controller.pair(raw);

    assert.equal(result.ok, false);
    if (!result.ok) {
      // The security rule is NOT weakened: the same code and the same copy as before.
      assert.equal(result.code, 'client/bad-url');
      assert.equal(result.message, 'Screenshot builds pair only with the local demo gateway');
    }

    const fields = payloadOf(logLineFor('pair rejected: screenshot mode pairs only with the loopback demo fixture', {
      stage: PAIR_FAILURE_STAGE.demoLoopback,
      errorCode: 'client/bad-url',
      publicUrl: 'wss://100.64.0.9:3443',
      endpoints: ['wss://100.64.0.9:3443', 'wss://100.64.0.9:3444'],
      reason: 'non-loopback',
    }));
    assert.equal(fields.stage, PAIR_FAILURE_STAGE.demoLoopback);
    assert.equal(fields.errorCode, 'client/bad-url');
    assert.equal(fields.reason, 'non-loopback');
    // Host URLs, not secrets: they are the reason the refusal fired.
    assert.equal(fields.publicUrl, 'wss://100.64.0.9:3443');
    assert.deepEqual(fields.endpoints, ['wss://100.64.0.9:3443', 'wss://100.64.0.9:3444']);

    controller.stop();
    assert.equal(socket.connects.length, 0, 'the demo refusal happens before any socket exists');
  });

  it('a LOOPBACK payload never reaches that refusal (the gate still accepts the fixture)', async () => {
    const socket = new ScriptedTransport();
    const controller = demoController(socket);
    const raw = encodePairingPayload(payload());
    assert.equal(controller.demoMode, true);

    await ready(controller);
    // The attempt proceeds PAST the demo gate: the refusal this file is about never fires. The stub
    // never answers, so the pairing would stay pending forever — the point is only the gate, and a
    // dial is its evidence. `pair()` is therefore NOT awaited (it cannot settle without a Host).
    void controller.pair(raw).catch(() => undefined);
    // The demo refusal returns synchronously, before any socket: a dial here proves it let us through.
    await new Promise((resolve) => setTimeout(resolve, 50));
    assert.equal(socket.connects.length > 0, true, 'the loopback pairing passed the demo gate and dialled');

    controller.stop();
  });

  it('the same payload is NOT refused by the demo gate in a controller without demo mode', async () => {
    const socket = new ScriptedTransport();
    const controller = normalController(socket);
    const raw = encodePairingPayload(payload({
      publicUrl: 'wss://100.64.0.9:3443',
      endpoints: ['wss://100.64.0.9:3443'],
    }));
    assert.equal(controller.demoMode, false);

    try {
      await ready(controller);
      // A normal build has no loopback rule. The refusal this file is about is decided BEFORE any
      // I/O (it returns synchronously with `client/bad-url`), so the proof here is that a tailnet
      // payload is NOT answered with it: the attempt proceeds into the pairing flow and opens a
      // socket instead of being refused on the spot. The stub never answers, so `pair()` cannot
      // settle — it is not awaited, and its eventual rejection is this test's own cleanup.
      void controller.pair(raw).catch(() => undefined);
      // Give the attempt its turn to reach the dial (the demo refusal needs none).
      await new Promise((resolve) => setTimeout(resolve, 100));
      assert.equal(socket.connects.length > 0, true, 'a normal build dials the tailnet host');
      assert.equal(
        socket.connects[0]?.url,
        'wss://100.64.0.9:3443',
        'the tailnet host is dialled unchanged (no demo gate rewrote or refused it)',
      );
    } finally {
      controller.stop();
    }
  });
});

// ---------------------------------------------------------------------------
// (iii) a normal (non-demo) controller renders no detail line
// ---------------------------------------------------------------------------

describe('spec 032 (iii): a normal build shows no diagnosis line', () => {
  it('pairFailureDetail is null when demo is off, whatever the code', () => {
    assert.equal(pairFailureDetail({ demo: false, code: 'client/bad-message', stage: 'connect' }), null);
    assert.equal(pairFailureDetail({ demo: false, code: 'qr/invalid-json', stage: 'parse' }), null);
    assert.equal(pairFailureDetail({ demo: false, code: '', stage: 'connect' }), null);
    // And the demo shape, so the switch is the ONLY difference.
    assert.equal(
      pairFailureDetail({ demo: true, code: 'client/connect-failed', stage: 'connect' }),
      'client/connect-failed · stage=connect',
    );
  });

  it('a controller built without screenshotMode reports demoMode false', async () => {
    const socket = new ScriptedTransport();
    const controller = normalController(socket);
    assert.equal(controller.demoMode, false, 'a shipped build is not a demo build');

    await ready(controller);
    const result = await controller.pair('definitely not a pairing payload');
    assert.equal(result.ok, false);
    // The diagnosis belongs to the log in EVERY build (that is the operator's trace); the SCREEN
    // is what stays unchanged, and that switch is `demoMode` in the panel.
    assert.equal(payloadOf(logLineFor('pair rejected: unusable pairing payload', {
      stage: PAIR_FAILURE_STAGE.parse,
      errorCode: result.ok ? '' : result.code,
      rawLength: 'definitely not a pairing payload'.length,
      rawHead: redactString('definitely not a pairing payload'.slice(0, 24)),
    })).stage, 'parse');

    controller.stop();
  });

  it('the panel never hard-codes demo mode on, and renders nothing when the value is null', () => {
    const source = readFileSync(PANEL, 'utf8');
    assert.ok(/failureDetail !== null \? \(/.test(source), 'the element is conditional on a non-null value');
    assert.equal(
      /pairFailureDetail\(\{[^}]*demo: true/.test(source),
      false,
      'the panel must never hard-code demo mode on',
    );
  });
});

// ---------------------------------------------------------------------------
// The stage vocabulary and the pure helpers
// ---------------------------------------------------------------------------

describe('spec 032: the stage vocabulary', () => {
  it('maps a code to the stage it could have reached', () => {
    assert.equal(pairFailureStageFromCode('qr/invalid-json'), 'parse');
    assert.equal(pairFailureStageFromCode('qr/bad-endpoint'), 'parse');
    assert.equal(pairFailureStageFromCode('client/bad-message'), 'connect');
    assert.equal(pairFailureStageFromCode('client/connect-failed'), 'connect');
    // The two stages the refusals state explicitly are logged, never derived.
    assert.equal(PAIR_FAILURE_STAGE.parse, 'parse');
    assert.equal(PAIR_FAILURE_STAGE.demoLoopback, 'demo-loopback');
  });

  it('redacts on the way to the screen too, and prints nothing for an empty code', () => {
    assert.equal(
      pairFailureDetail({ demo: true, code: `dsh-pair.${PAIRING_CODE}`, stage: 'connect' }),
      'dsh-pair.[redacted] · stage=connect',
    );
    assert.equal(pairFailureDetail({ demo: true, code: '   ', stage: 'connect' }), null);
  });
});
