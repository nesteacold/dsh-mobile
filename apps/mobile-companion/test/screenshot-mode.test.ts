// Spec 032 — store-screenshot mode: the gate decision, the platform adapter, the demo store, the
// demo transport, the release guard.
//
// The decision is pure (`src/core/screenshot-mode.ts`) and its whole matrix is exercised here. The
// PLATFORM ADAPTER (`src/platform/screenshot-mode.ts`) is exercised too, because the first review
// found a defect that lived only there: an inverted "is a device" fact. The demo store and the
// demo transport are executable Node tests; the controller wiring that consumes them is asserted
// as source (this repo has no component renderer, see `test/ui-test-hooks.test.ts`).
//
// The claims a reviewer checks first:
//   * demo mode needs a POSITIVE compile-time iOS-simulator fact (a PROPERTY of the native module,
//     `Constants { simulator }`); a physical phone, an unknown or absent native module, a module
//     that only exposes `constants()` and a missing property keep the normal A020 gate;
//   * Android is `normal` unconditionally (no emulator heuristic exists in this build);
//   * demo mode keeps its own in-memory host/credential store: the controller's demo branches are
//     asserted below, and the store itself is tested here;
//   * the demo transport dials the NATIVE pinned transport (the leaf pin is checked in the TLS
//     handshake), refuses anything but `wss://127.0.0.1:<port>`, and — as the Node rule — refuses
//     another leaf before a credential or frame is sent;
//   * no layer has a trust relaxation: no `loopbackAllowance`, no option that could answer a
//     challenge with default handling (spec 032 review #2);
//   * the release path (both build scripts + the resolved production config) refuses the flag.

import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { describe, it } from 'node:test';
import { fileURLToPath, pathToFileURL } from 'node:url';

import { PROTOCOL_SUBPROTOCOL } from '@dsh-ext/mobile-protocol';

import {
  decideScreenshotMode,
  isProductionProfile,
  resolveBuildProfile,
  type ScreenshotModeInput,
} from '../src/core/screenshot-mode';
import { isDemoPairingHost, isLoopbackPairingEndpoint, pairedHostFromPayload } from '../src/core/host';
import {
  TRANSPORT_ERROR,
  type PairedHost,
  type Transport,
  type TransportEvent,
} from '../src/core';
import { createDemoStore } from '../src/platform/demo-store';
import { createDemoTransport } from '../src/platform/pinned-transport.demo';
import {
  nativePinnedWsConstants,
  screenshotDecision,
  screenshotModeInput,
  setScreenshotNativeModuleForTests,
  simulatorFact,
} from '../src/platform/screenshot-mode';
import type { PinnedWsAdapter } from '../modules/pinned-ws';
import { generateTestCertificate } from './support/certs';
import { FakeGateway } from './support/fake-gateway';
import { NodePinnedTransport } from './support/node-pinned-transport';
import { waitFor } from './support/wait';

const APP_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const read = (relative: string): string => readFileSync(path.join(APP_ROOT, relative), 'utf8');

/** A valid-looking pin: the fixture's own shape (`e2e/harness/gateway.mjs`). */
const PIN = 'a'.repeat(64);
const LOOPBACK = 'wss://127.0.0.1:3443';

function input(overrides: Partial<ScreenshotModeInput> = {}): ScreenshotModeInput {
  return {
    flagBakedIn: true,
    platform: 'ios',
    isSimulator: true,
    profile: 'development',
    ...overrides,
  };
}

describe('screenshot gate: the three conditions', () => {
  it('flag off -> the normal gate, even on a simulator', () => {
    assert.deepEqual(decideScreenshotMode(input({ flagBakedIn: false })), { gate: 'normal', reason: 'flag-off' });
  });

  it('flag on + a physical phone (isSimulator false) -> the normal gate', () => {
    assert.deepEqual(decideScreenshotMode(input({ isSimulator: false })), { gate: 'normal', reason: 'physical-device' });
  });

  it('flag on + an UNKNOWN simulator fact (null/absent) -> the normal gate', () => {
    for (const value of [null, undefined] as unknown[]) {
      assert.deepEqual(
        decideScreenshotMode(input({ isSimulator: value as boolean | null })),
        { gate: 'normal', reason: 'physical-device' },
        `isSimulator=${String(value)} must keep the gate`,
      );
    }
  });

  it('flag on + simulator + production profile -> the normal gate', () => {
    assert.deepEqual(decideScreenshotMode(input({ profile: 'production' })), { gate: 'normal', reason: 'production-profile' });
  });

  it('flag on + iOS simulator + non-production profile -> unlocked-demo', () => {
    assert.deepEqual(decideScreenshotMode(input()), { gate: 'unlocked-demo', reason: null });
  });

  it('ANDROID is always the normal gate — no emulator heuristic, whatever the facts say', () => {
    for (const isSimulator of [true, false, null] as const) {
      assert.deepEqual(
        decideScreenshotMode(input({ platform: 'android', isSimulator })),
        { gate: 'normal', reason: 'android' },
        `android must be normal even with isSimulator=${String(isSimulator)}`,
      );
    }
  });

  it('web is never skipped, whatever the flag says', () => {
    assert.deepEqual(decideScreenshotMode(input({ platform: 'web', isSimulator: true })), { gate: 'normal', reason: 'web' });
  });

  it('a flag value that is not exactly true keeps the gate', () => {
    for (const value of ['true', 1, null, undefined] as unknown[]) {
      const decision = decideScreenshotMode(input({ flagBakedIn: value as boolean }));
      assert.equal(decision.gate, 'normal', `flagBakedIn=${String(value)} must not enable the mode`);
    }
  });

  it('an unknown profile is NOT production, but a prod-looking one is', () => {
    assert.equal(isProductionProfile('development'), false);
    assert.equal(isProductionProfile('preview'), false);
    assert.equal(isProductionProfile('internal'), false);
    for (const profile of ['production', ' Production ', 'prod', 'prod-store', 'release', 'release-apk', 'store', 'app-store']) {
      assert.equal(isProductionProfile(profile), true, `${profile} must count as a release profile`);
    }
    assert.equal(decideScreenshotMode(input({ profile: 'prod-store' })).gate, 'normal');
  });
});

describe('build profile resolution', () => {
  it('prefers EAS_BUILD_PROFILE, then extra.eas.buildProfile, then empty', () => {
    assert.equal(resolveBuildProfile('staging', { eas: { buildProfile: 'production' } }), 'staging');
    assert.equal(resolveBuildProfile(undefined, { eas: { buildProfile: 'preview' } }), 'preview');
    assert.equal(resolveBuildProfile('  ', {}), '');
    assert.equal(resolveBuildProfile(undefined, undefined), '');
  });
});

/**
 * A native `pinned-ws` double: the surface the adapter reads. `simulator` is a PROPERTY of the
 * module object, exactly as Expo decorates a `Constants { ... }` dictionary
 * (`ObjectDefinition.swift:111-118`); there is no `constants()` function on a real module.
 */
function adapterWith(constants?: { readonly simulator?: unknown }): PinnedWsAdapter {
  const base = {
    connect: async () => undefined,
    send: async () => true,
    close: async () => undefined,
    addListener: () => ({ remove() {} }),
  };
  return (constants === undefined ? base : { ...base, ...constants }) as unknown as PinnedWsAdapter;
}

describe('platform adapter: the simulator fact is read and passed correctly', () => {
  const simulator = (value: unknown): PinnedWsAdapter => adapterWith({ simulator: value });
  const extra = { screenshotMode: true, eas: { buildProfile: 'development' } };

  it('PHYSICAL phone (native says false) -> the normal gate, even with the flag baked in', () => {
    const decision = decideScreenshotMode(screenshotModeInput({ extra, platform: 'ios', nativeModule: simulator(false) }));
    assert.deepEqual(decision, { gate: 'normal', reason: 'physical-device' });
  });

  it('iOS simulator (native says true) -> unlocked-demo', () => {
    const decision = decideScreenshotMode(screenshotModeInput({ extra, platform: 'ios', nativeModule: simulator(true) }));
    assert.deepEqual(decision, { gate: 'unlocked-demo', reason: null });
  });

  it('missing native module (null or undefined) -> the normal gate, never "not a device"', () => {
    for (const nativeModule of [null, undefined]) {
      assert.deepEqual(
        decideScreenshotMode(screenshotModeInput({ extra, platform: 'ios', nativeModule })),
        { gate: 'normal', reason: 'physical-device' },
      );
    }
  });

  it('missing simulator property, a wrong type or a throwing getter -> the normal gate', () => {
    const unreadable = [
      adapterWith(),
      adapterWith({}),
      adapterWith({ simulator: 'true' }),
      adapterWith({ simulator: 1 }),
      adapterWith({ simulator: null }),
      (() => {
        const base = adapterWith();
        Object.defineProperty(base, 'simulator', {
          get() {
            throw new Error('no constants');
          },
        });
        return base;
      })(),
    ];
    for (const adapter of unreadable) {
      assert.equal(simulatorFact(adapter), null, 'an unreadable fact is unknown, never false');
      assert.deepEqual(
        decideScreenshotMode(screenshotModeInput({ extra, platform: 'ios', nativeModule: adapter })),
        { gate: 'normal', reason: 'physical-device' },
      );
    }
  });

  it('a module exposing only constants() is UNKNOWN: the real Expo module exports a property', () => {
    // The review #2 defect: `Constants { ... }` is decorated onto the module OBJECT
    // (`expo-modules-core/ios/Core/Objects/ObjectDefinition.swift:111-118`), so `constants()` never
    // existed on a real module and always answered "unknown" — a demo build could never unlock.
    const legacy = {
      ...adapterWith(),
      constants: () => ({ simulator: true }),
    } as unknown as PinnedWsAdapter;
    assert.equal(simulatorFact(legacy), null, 'a constants() function is not the exported constant');
    assert.deepEqual(nativePinnedWsConstants(legacy), {}, 'nothing is read from constants()');
    assert.deepEqual(
      decideScreenshotMode(screenshotModeInput({ extra, platform: 'ios', nativeModule: legacy })),
      { gate: 'normal', reason: 'physical-device' },
    );
    assert.deepEqual(nativePinnedWsConstants(simulator(true)), { simulator: true }, 'the property is what is read');
  });

  it('the fact is a simulator value, not a device flag: true is simulator, false is a device', () => {
    assert.equal(simulatorFact(simulator(true)), true);
    assert.equal(simulatorFact(simulator(false)), null, 'false is a DEVICE fact only to the decision, via the gate');
    assert.deepEqual(nativePinnedWsConstants(simulator(false)), {}, 'only exactly true is reported as a fact');
    assert.deepEqual(nativePinnedWsConstants(null), {});
    // The decision itself still sees `false` when the platform adapter reports it: a device build
    // must be "not a simulator", and `screenshotModeInput` keeps that distinction.
    assert.equal(screenshotModeInput({ extra, platform: 'ios', nativeModule: simulator(false) }).isSimulator, null);
  });
  it('a simulator fact cannot unlock an Android or a web build', () => {
    assert.equal(screenshotModeInput({ extra, platform: 'android', nativeModule: simulator(true) }).isSimulator, true);
    assert.deepEqual(decideScreenshotMode(screenshotModeInput({ extra, platform: 'android', nativeModule: simulator(true) })), { gate: 'normal', reason: 'android' });
    assert.deepEqual(decideScreenshotMode(screenshotModeInput({ extra, platform: 'web', nativeModule: simulator(true) })), { gate: 'normal', reason: 'web' });
  });

  it('the adapter never asks the native module unless the flag is baked in', async () => {
    let reads = 0;
    const base = adapterWith();
    const counted = Object.defineProperty(base, 'simulator', {
      get() {
        reads += 1;
        return true;
      },
    }) as PinnedWsAdapter;
    setScreenshotNativeModuleForTests(counted);
    try {
      // The stubbed `expo-constants` reports no `extra`, so this run has no baked flag.
      const decision = await screenshotDecision();
      assert.equal(decision.gate, 'normal');
      assert.equal(reads, 0, 'a build without the flag never touches the native module');
    } finally {
      setScreenshotNativeModuleForTests(undefined);
    }
  });

  it('the native modules declare the simulator constant at compile time (iOS) and never (Android)', () => {
    const swift = read(path.join('modules', 'pinned-ws', 'ios', 'PinnedWsModule.swift'));
    assert.ok(swift.includes('#if targetEnvironment(simulator)'), 'iOS: a compile-time conditional');
    assert.ok(swift.includes('return ["simulator": true]') && swift.includes('return ["simulator": false]'));
    const kotlin = read(path.join('modules', 'pinned-ws', 'android', 'src', 'main', 'java', 'expo', 'modules', 'pinnedws', 'PinnedWsModule.kt'));
    assert.ok(kotlin.includes('"simulator" to false'), 'Android never claims a simulator');    // The inverted fact and the module that supplied it are gone from the adapter's CODE; the
    // file's header still names the defect it documents.
    const adapter = read(path.join('src', 'platform', 'screenshot-mode.ts'));
    const code = adapter.split('\n').filter((line) => !line.trimStart().startsWith('//')).join('\n');
    assert.equal(code.includes("from 'expo-device'"), false);
    assert.equal(code.includes('isDevice'), false);
    // Review #2: the fact is a PROPERTY of the module object, never a `constants()` call.
    assert.equal(/\.constants\s*\(/.test(code), false, 'no constants() call on the module');
    assert.match(code, /\.simulator/);
  });
});

describe('demo store: an in-memory host/credential lifecycle', () => {
  const record = (gatewayId: string): PairedHost => ({
    schemaVersion: 1,
    gatewayId,
    name: 'demo',
    publicUrl: LOOPBACK,
    endpoints: [LOOPBACK],
    certSha256: PIN,
    deviceId: 'dev-1',
    deviceName: 'iOS phone',
    pairedAt: 1,
    demoPairing: true,
  });

  it('stores, upserts and drops hosts and their credentials, and hands out copies', () => {
    const store = createDemoStore();
    store.saveHost(record('g1'));
    store.saveToken('g1', 'tok-1');
    assert.deepEqual(store.hosts().map((entry) => entry.gatewayId), ['g1']);
    assert.equal(store.hasToken('g1'), true);
    assert.equal(store.token('g1'), 'tok-1');
    store.saveHost(record('g1'));
    assert.equal(store.hosts().length, 1, 'an upsert by gatewayId never duplicates');
    store.hosts().push(record('external'));
    assert.deepEqual(store.hosts().map((entry) => entry.gatewayId), ['g1'], 'the caller cannot mutate the store');
    store.forgetHost('g1');
    assert.deepEqual(store.hosts(), []);
    assert.equal(store.hasToken('g1'), false, 'the credential dies with its host');
  });

  it('drops records that are not a PairedHost and never shares the seed array', () => {
    const seed: PairedHost[] = [record('g1'), { gatewayId: 'bogus' } as unknown as PairedHost];
    const store = createDemoStore(seed);
    assert.deepEqual(store.hosts().map((entry) => entry.gatewayId), ['g1']);
    seed.length = 0;
    assert.deepEqual(store.hosts().map((entry) => entry.gatewayId), ['g1']);
  });

  it('dropCredentials empties the credentials but keeps the host records', () => {
    const store = createDemoStore([record('g1')]);
    store.saveToken('g1', 'tok-1');
    store.dropCredentials();
    assert.equal(store.hasToken('g1'), false);
    assert.deepEqual(store.hosts().map((entry) => entry.gatewayId), ['g1']);
  });
});

/** A native module double that records `connect` calls and lets a test answer with events. */
interface NativeDouble extends PinnedWsAdapter {
  readonly connects: Array<Record<string, unknown>>;
  readonly urls: string[];
}

function nativeDouble(): NativeDouble {
  const listeners = new Map<string, (event: unknown) => void>();
  const connects: Array<Record<string, unknown>> = [];
  const urls: string[] = [];
  return {
    connects,
    urls,
    connect: async (_id: string, url: string, options: Record<string, unknown>) => {
      urls.push(url);
      connects.push(options);
    },
    send: async () => true,
    close: async () => undefined,
    addListener: (name: string, listener: (event: unknown) => void) => {
      listeners.set(name, listener);
      return { remove: () => listeners.delete(name) };
    },
    simulator: true,
  } as unknown as NativeDouble;
}

function collect(transport: Transport): TransportEvent[] {
  const events: TransportEvent[] = [];
  transport.on((event) => events.push(event));
  return events;
}

describe('demo transport: the native pinned transport, loopback only', () => {
  it('refuses anything but wss://127.0.0.1:<port> and a pairing with no pin — before any dial', async () => {
    const nativeModule = nativeDouble();
    for (const url of ['wss://localhost:3443', 'wss://100.64.0.7:3443', 'ws://127.0.0.1:3443', `${LOOPBACK}/x`, 'wss://user:pw@127.0.0.1:3443']) {
      const transport = createDemoTransport({ module: nativeModule });
      const events = collect(transport);
      transport.connect(url, { certSha256: PIN });
      await waitFor(() => events.length >= 1, { label: `refusal for ${url}` });
      assert.equal(events[0]?.type, 'error', `${url} is refused`);
      assert.equal((events[0] as { code?: string }).code, TRANSPORT_ERROR.insecureUrl, `${url} is not the exact loopback spelling`);
      assert.equal(nativeModule.connects.length, 0, 'nothing reached the native module');
    }
    const transport = createDemoTransport({ module: nativeDouble() });
    const events = collect(transport);
    transport.connect(LOOPBACK, { certSha256: 'not-a-pin' });
    await waitFor(() => events.length >= 1);
    assert.equal((events[0] as { code?: string }).code, TRANSPORT_ERROR.pinMismatch);
  });

  it('forwards the pairing pin and the exact loopback URL to the native transport (options only)', async () => {
    // THIS IS AN OPTIONS-FORWARDING TEST: it proves what reaches `module.connect(...)` and nothing
    // about TLS. The trust path itself (leaf pin, validity window, no default handling, no
    // exception for any build) is native code, compiled out of every build except the one it ships
    // in, and is verified by the Mac simulator run in the spec's acceptance list — never here.
    const simulatorModule = nativeDouble();
    const simplex = createDemoTransport({ module: simulatorModule, isSimulator: true });
    const simulatorEvents = collect(simplex);
    simplex.connect(LOOPBACK, { certSha256: PIN.toUpperCase() });
    await waitFor(() => simulatorModule.connects.length === 1, { timeoutMs: 2_000, label: 'native connect' });
    assert.equal(simulatorModule.urls[0], LOOPBACK);
    assert.equal(simulatorModule.connects[0]?.certSha256, PIN, 'the pin reaches the native handshake, lower-cased');
    assert.equal(simulatorModule.connects[0]?.loopbackAllowance, undefined, 'the demo build passes no trust relaxation');
    assert.equal(simulatorEvents.length, 0, 'no event before the native side answers');

    const deviceModule = nativeDouble();
    const device = createDemoTransport({ module: deviceModule, isSimulator: false });
    device.connect(LOOPBACK, { certSha256: PIN });
    await waitFor(() => deviceModule.connects.length === 1, { timeoutMs: 2_000, label: 'native connect (device)' });
    assert.equal(deviceModule.connects[0]?.loopbackAllowance, undefined, 'a device build passes no allowance either');
    assert.deepEqual(Object.keys(deviceModule.connects[0] ?? {}).sort(), ['certSha256', 'headers', 'protocols'], 'exactly the three shipped options');
  });

  it('nothing is sent before the native side opens the socket', async () => {
    const nativeModule = nativeDouble();
    const transport = createDemoTransport({ module: nativeModule });
    transport.connect(LOOPBACK, { certSha256: PIN });
    await waitFor(() => nativeModule.connects.length === 1, { timeoutMs: 2_000, label: 'native connect' });
    assert.equal(transport.send('{}'), false, 'nothing goes on the wire before the native open');
  });

  it('a DIFFERENT TLS leaf on the approved loopback endpoint: the Node pin rule refuses it, nothing is sent', async () => {
    // WHAT THIS PROVES (and only this): the repo's Node implementation of the pinned transport
    // (`test/support/node-pinned-transport.ts`, the app Transport the tests and e2e use) refuses a
    // served leaf that is not the pairing pin BEFORE the HTTP upgrade, so the server receives no
    // credential and no frame. It is NOT evidence about the native iOS handshake: that delegate is
    // Swift, is compiled out of every build except a simulator build, and is verified by the Mac
    // simulator run listed in the spec's acceptance list.
    const served = await generateTestCertificate();
    const other = await generateTestCertificate();
    assert.notEqual(served.certSha256, other.certSha256);
    // A REAL TLS/WS server: it records the upgrade request and every frame, and it answers one
    // frame if a socket ever opened (so "the server saw a credential" would be observable).
    const gateway = await FakeGateway.create({ certificate: served });
    try {
      const pairPin = other.certSha256; // the pairing declares a DIFFERENT leaf than the one served
      const transport = new NodePinnedTransport({ handshakeTimeoutMs: 2_000 });
      const events = collect(transport);
      transport.connect(gateway.endpoint, {
        certSha256: pairPin,
        protocols: [PROTOCOL_SUBPROTOCOL],
        headers: { Authorization: 'Bearer must-not-leave', 'X-DSH-Device-ID': 'dev-1' },
      });
      await waitFor(() => events.some((event) => event.type === 'close'), { timeoutMs: 2_000, label: 'pin rejection' });

      const error = events.find((event) => event.type === 'error') as { code?: string } | undefined;
      assert.equal(error?.code, TRANSPORT_ERROR.pinMismatch, 'the served leaf is refused as a pin mismatch');
      assert.equal(events.some((event) => event.type === 'open' || event.type === 'message'), false, 'the socket never opened');
      // ZERO credentials, zero upgrades and zero frames reached the server.
      assert.equal(gateway.connectionAttempts, 0, 'no HTTP upgrade was attempted');
      assert.equal(gateway.allReceivedFrames.length, 0, 'no frame reached the server');
      assert.deepEqual(gateway.tokensAccepted, [], 'the bearer token was never presented');
      assert.deepEqual(gateway.offeredPairingCodes, [], 'no pairing code was offered');
      assert.equal(transport.framesSent.length, 0, 'the client wrote nothing');
      assert.deepEqual(transport.observedFingerprints, [served.certSha256], 'it observed the served leaf and rejected it');
      await waitFor(() => true, { timeoutMs: 1_000, label: 'settle' });
      assert.equal(gateway.connectionAttempts, 0, 'still zero after the rejection settled');
    } finally {
      await gateway.close();
    }
  });
});


describe('demo-data rule: which pairings may exist', () => {
  it('a loopback pairing is a demo pairing and keeps the marker', () => {
    const host = pairedHostFromPayload(
      { gatewayId: 'g', gatewayName: 'dsh-e2e', publicUrl: LOOPBACK, endpoints: [LOOPBACK], certSha256: PIN },
      { id: 'dev', name: 'iOS phone' },
      1,
    );
    assert.equal(host.demoPairing, true);
    assert.equal(isDemoPairingHost(host), true);
  });

  it('a Tailscale / LAN pairing is not a demo pairing', () => {
    for (const url of ['wss://100.64.0.7:3443', 'wss://192.168.1.20:3443', 'wss://127.0.0.1.evil.example:3443']) {
      const host = pairedHostFromPayload(
        { gatewayId: 'g', gatewayName: 'dsh-e2e', publicUrl: url, endpoints: [url], certSha256: PIN },
        { id: 'dev', name: 'iOS phone' },
        1,
      );
      assert.equal(host.demoPairing, undefined, `${url} must not be a demo pairing`);
      assert.equal(isLoopbackPairingEndpoint([url]), false, `${url} must not be loopback`);
    }
  });

  it('a hand-edited record cannot claim demo-ness over a real address', () => {
    const host = pairedHostFromPayload(
      { gatewayId: 'g', gatewayName: 'dsh-e2e', publicUrl: 'wss://100.64.0.7:3443', endpoints: ['wss://100.64.0.7:3443'], certSha256: PIN },
      { id: 'dev', name: 'iOS phone' },
      1,
    );
    assert.equal(isDemoPairingHost({ ...host, demoPairing: true }), false, 'the flag alone must not pass');
  });

  it('an empty endpoint list is never loopback', () => {
    assert.equal(isLoopbackPairingEndpoint([]), false);
  });
});

describe('runtime wiring (app/_layout.tsx)', () => {
  const layout = read(path.join('app', '_layout.tsx'));

  it('skips the biometric prompt ONLY behind the demo decision, and still unlocks the controller', () => {
    const demo = layout.indexOf('if (demoGate === true) {');
    assert.ok(demo > 0, 'the demo branch exists');
    const otherwise = layout.indexOf('} else {', demo);
    const prompt = layout.indexOf('authenticate(tr(\'unlock.prompt\')', otherwise);
    assert.ok(otherwise > demo && prompt > otherwise, 'authenticate() is called only in the normal branch');
    const demoBranch = layout.slice(demo, otherwise);
    assert.match(demoBranch, /await controller\.unlock\(\)/);
    assert.equal(demoBranch.includes('authenticate('), false, 'no biometric prompt in the demo branch');
  });

  it('builds the controller with the demo transport only for the demo decision', () => {
    // Review #2: the layout hands the build's own simulator fact to the factory explicitly
    // (`createDemoTransport({ ...options, isSimulator })`), instead of assuming one inside it.
    assert.match(layout, /demoGate === true\s*\?\s*\{\s*screenshotMode: \{\s*enabled: true as const,\s*transport: \(options\?: CreatePinnedTransportOptions\) =>\s*createDemoTransport\(\{/);
    assert.equal(layout.includes('createDemoTransport(this'), false);
    assert.match(layout, /isSimulator: demoSimulator/);
    assert.match(layout, /nativePinnedWsConstants\(\)\.simulator === true/);
  });

  it('does not start the gate before the decision resolved', () => {
    assert.match(layout, /if \(!isWeb && gate === 'checking' && demoGate !== null\)/);
  });
});

describe('no trust relaxation anywhere (spec 032 review #2)', () => {
  it('no layer of the app carries a loopback allowance option', () => {
    const files = [
      path.join('src', 'platform', 'pinned-transport.ts'),
      path.join('src', 'platform', 'pinned-transport.web.ts'),
      path.join('src', 'platform', 'pinned-transport.demo.ts'),
      path.join('app', '_layout.tsx'),
      path.join('modules', 'pinned-ws', 'ios', 'PinnedWsConnection.swift'),
      path.join('modules', 'pinned-ws', 'ios', 'PinnedWsRegistry.swift'),
      path.join('modules', 'pinned-ws', 'android', 'src', 'main', 'java', 'expo', 'modules', 'pinnedws', 'PinnedWsRegistry.kt'),
    ];
    for (const relative of files) {
      const source = read(relative);
      // Kotlin line comments start with `//` too, so one filter covers both languages.
      const code = source.split('\n').filter((line) => !line.trimStart().startsWith('//')).join('\n');
      assert.equal(/loopbackAllowance|useLoopbackAllowance/.test(code), false, `${relative} must carry no allowance in code`);
    }
  });

  it('the native challenge handler never answers default handling', () => {
    const swift = read(path.join('modules', 'pinned-ws', 'ios', 'PinnedWsConnection.swift'));
    const code = swift.split('\n').filter((line) => !line.trimStart().startsWith('//')).join('\n');
    assert.equal(code.includes('.performDefaultHandling'), false, 'the iOS delegate never defers to platform policy');
    assert.equal(code.includes('.defaultHandling'), false, 'and the invalid spelling is gone too');
    assert.ok(code.includes('URLSession.AuthChallengeDisposition'), 'the exact disposition type');
    assert.ok(code.includes('@escaping (URLSession.AuthChallengeDisposition, URLCredential?) -> Void'), 'the exact completion-handler type');
    for (const disposition of ['.cancelAuthenticationChallenge', '.useCredential']) {
      assert.ok(code.includes(disposition), `${disposition} is part of the shipped disposition call`);
    }
  });

  it('an injected simulator fact changes no dial option and cannot relax anything', async () => {
    for (const isSimulator of [true, false]) {
      const nativeModule = nativeDouble();
      const transport = createDemoTransport({ module: nativeModule, isSimulator });
      transport.connect(LOOPBACK, { certSha256: PIN });
      await waitFor(() => nativeModule.connects.length === 1, { timeoutMs: 2_000, label: `connect (isSimulator=${isSimulator})` });
      assert.deepEqual(Object.keys(nativeModule.connects[0] ?? {}).sort(), ['certSha256', 'headers', 'protocols']);
    }
  });
});

describe('demo-data rule: the controller never touches a real credential or host list', () => {
  const appState = read(path.join('src', 'app-state.ts'));

  it('reads the credential only in the non-demo branch', () => {
    assert.equal(appState.includes('const token = demo === null ? await readToken(host.gatewayId) : this.demoToken ?? DEMO_GATEWAY_TOKEN;'), true);
  });

  it('writes the credential only through the demo store in demo mode', () => {
    const persist = appState.slice(appState.indexOf('private persistToken('));
    const demoCall = persist.indexOf('demo.saveToken(gatewayId, token)');
    const write = persist.indexOf('saveToken(gatewayId, token)');
    assert.ok(demoCall > 0 && write > demoCall, 'the demo branch returns before the real keychain write');
  });

  it('every host-list access has a demo branch (start, pair, pair recovery, delete/forget)', () => {
    assert.ok(appState.includes('const hosts = demo !== null ? demo.hosts() : await readHosts();'), 'start() never reads the device list in demo mode');
    assert.ok(appState.includes('return this.demoStore === null ? saveHost(host) : this.demoStore.saveHost(host);'), 'pair() success');
    assert.ok(appState.includes('return this.demoStore === null ? saveHost(recovered) : this.demoStore.saveHost(recovered);'), 'pair() recovery');
    const instance = appState.slice(appState.indexOf('private deleteCredentialInstance('), appState.indexOf('private dropHostRecord('));
    assert.ok(instance.includes('demo.forgetHost(gatewayId)'), 'revoke/forget/failed pair go to the demo store');
    assert.ok(instance.includes('await forgetHost(gatewayId)'), 'and only the non-demo path reaches the real wipe');
    assert.equal(appState.includes('demo.saveHosts('), false, 'no undocumented store call');
  });

  it('the real store calls are each guarded by the demo store being absent', () => {
    // The one store-owning method is checked for BOTH branches in order; every real call sits
    // inside a branch a `demo` check selected (there is no `.then(storeCall)` shortcut).
    const instance = appState.slice(
      appState.indexOf('private deleteCredentialInstance('),
      appState.indexOf('private dropHostRecord('),
    );
    const branch = instance.indexOf('if (demo === null) {');
    const real = instance.indexOf('await forgetHost(gatewayId);');
    const demo = instance.indexOf('demo.forgetHost(gatewayId);');
    assert.ok(branch > 0 && real > branch && demo > real, 'the real wipe has its own branch; the demo store never shares it');
    const lines = appState.split('\n');
    // Real calls: not a `demo.` call, and not a comment line.
    const realCalls = lines.filter((line) => /\b(readHosts|saveHost|forgetHost|readToken|saveToken)\(/.test(line))
      .filter((line) => !line.trimStart().startsWith('//') && !line.trimStart().startsWith('*'))
      .filter((line) => line.includes('demo.') === false);
    assert.ok(realCalls.length > 0);
    const forgetLine = realCalls.findIndex((line) => line.includes('await forgetHost(gatewayId);'));
    for (const line of realCalls) {
      if (line.includes('await forgetHost(gatewayId);')) {
        // Covered by the branch assertions above (a statement of its own on its own line).
        continue;
      }
      assert.ok(
        /\b(demo|this\.demoStore)\s*[!=]==?\s*null\b/.test(line) || /\.then\(\(\) => revision\)/.test(line),
        `unguarded real store call: ${line.trim()}`,
      );
    }
    assert.ok(forgetLine >= 0, 'the real wipe exists exactly once');
  });

  it('refuses to pair a non-loopback host before any socket exists', () => {
    const pair = appState.slice(appState.indexOf('async pair('), appState.indexOf('const pairingClient = this.newClient();'));
    const guard = pair.indexOf('if (this.screenshotMode !== null && !isLoopbackPairingEndpoint(');
    const socket = appState.indexOf('const pairingClient = this.newClient();');
    assert.ok(guard > 0, 'the loopback pairing guard exists');
    assert.ok(appState.indexOf('return { ok: false, code, message };', appState.indexOf('async pair(')) < socket);
  });

  it('refuses to connect to any host that is not a demo pairing', () => {
    const connect = appState.slice(appState.indexOf('private async connectHost('));
    assert.ok(connect.indexOf('isDemoPairingHost(host)') > 0);
    assert.ok(connect.indexOf('isDemoPairingHost(host)') < connect.indexOf('DEMO_GATEWAY_TOKEN'));
  });
});

describe('release guard: no store build may carry the flag', () => {
  it('mac/ios-build.sh refuses the flag with the production profile', () => {
    const script = read(path.join('scripts', 'remote-ios-build', 'mac', 'ios-build.sh'));
    assert.match(script, /if \[ "\$\{DSH_SCREENSHOT_MODE:-\}" = '1' \] && \[ "\$PROFILE" = 'production' \]; then/);
    assert.match(script, /die 2 "refusing to build: DSH_SCREENSHOT_MODE=1 with --profile=production/);
    assert.ok(script.indexOf('DSH_SCREENSHOT_MODE') > script.indexOf('validate_args() {'));
    assert.ok(script.indexOf('DSH_SCREENSHOT_MODE') < script.indexOf('acquire_lock\n'));
  });

  it('Invoke-RemoteIosBuild.ps1 refuses the same combination before any ssh call', () => {
    const driver = read(path.join('scripts', 'remote-ios-build', 'Invoke-RemoteIosBuild.ps1'));
    assert.match(driver, /\$env:DSH_SCREENSHOT_MODE -eq '1' -and \$EffectiveProfile -eq 'production'/);
    const guard = driver.indexOf('[string]$env:DSH_SCREENSHOT_MODE');
    const problems = driver.indexOf('if ($problems.Count -gt 0)');
    const firstSshCall = driver.indexOf('Invoke-MacSelfTest -StagedPath');
    assert.ok(guard > 0 && guard < problems && problems > 0 && problems < firstSshCall, 'guard -> refusal -> ssh, in that order');
  });
});

describe('release guard: the production config resolves screenshotMode=false even if the env leaks', () => {
  const configPath = path.join(APP_ROOT, 'app.config.ts');

  async function resolveConfig(env: Record<string, string | undefined>, extra: Record<string, unknown> = {}): Promise<Record<string, unknown>> {
    const vars = ['DSH_SCREENSHOT_MODE', 'EAS_BUILD_PROFILE', 'ENVIRONMENT'];
    const saved = new Map<string, string | undefined>();
    for (const key of vars) {
      saved.set(key, process.env[key]);
      const value = env[key];
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    }
    try {
      const module = (await import(/* @vite-ignore */ `${pathToFileURL(configPath).href}?t=${Date.now()}`)) as {
        default: (context: { config: Record<string, unknown> }) => { extra: Record<string, unknown> };
      };
      return module.default({ config: { extra } }).extra;
    } finally {
      for (const [key, value] of saved) {
        if (value === undefined) delete process.env[key];
        else process.env[key] = value;
      }
    }
  }

  it('a leaking flag with a production EAS profile resolves screenshotMode=false (no throw, just forced off)', async () => {
    const config = await resolveConfig({ DSH_SCREENSHOT_MODE: '1', EAS_BUILD_PROFILE: 'production', ENVIRONMENT: undefined });
    assert.equal(config.screenshotMode, false, 'a store profile forces the mode off');
  });

  it('a production profile forces screenshotMode=false even when the flag leaks (the required assertion)', async () => {
    const config = await resolveConfig(
      { DSH_SCREENSHOT_MODE: '1', EAS_BUILD_PROFILE: undefined, ENVIRONMENT: 'production' },
      { eas: { buildProfile: 'production' } },
    );
    assert.equal((config as Record<string, unknown>).screenshotMode, false, 'a store build must never carry the mode');
  });

  it('a leaking flag with a production profile in extra.eas resolves screenshotMode=false too', async () => {
    const config = await resolveConfig(
      { DSH_SCREENSHOT_MODE: '1', EAS_BUILD_PROFILE: undefined, ENVIRONMENT: undefined },
      { eas: { buildProfile: 'production' } },
    );
    assert.equal(config.screenshotMode, false);
  });

  it('ENVIRONMENT=production alone (no profile) resolves screenshotMode=false', async () => {
    const config = await resolveConfig({ DSH_SCREENSHOT_MODE: '1', EAS_BUILD_PROFILE: 'production', ENVIRONMENT: 'production' });
    assert.equal((config as Record<string, unknown>).screenshotMode, false);
  });

  it('a leaking flag with no profile at all fails fast (it cannot be proven a development build)', async () => {
    await assert.rejects(
      () => resolveConfig({ DSH_SCREENSHOT_MODE: '1', EAS_BUILD_PROFILE: undefined, ENVIRONMENT: undefined }),
      /declares no profile/,
    );
  });

  it('a development profile bakes the flag in and records the profile', async () => {
    const config = await resolveConfig(
      { DSH_SCREENSHOT_MODE: '1', EAS_BUILD_PROFILE: 'development', ENVIRONMENT: undefined },
      { eas: { projectId: 'p' } },
    );
    const extra = config as Record<string, unknown>;
    assert.equal(extra.screenshotMode, true);
    assert.equal((extra.eas as Record<string, unknown>).buildProfile, 'development');
    assert.equal((extra.eas as Record<string, unknown>).projectId, 'p', 'the existing EAS extra is kept');
  });

  it('a development build labelled only by ENVIRONMENT=development also works', async () => {
    const config = await resolveConfig({ DSH_SCREENSHOT_MODE: '1', EAS_BUILD_PROFILE: undefined, ENVIRONMENT: 'development' });
    assert.equal((config as Record<string, unknown>).screenshotMode, true);
  });

  it('no flag resolves screenshotMode=false', async () => {
    const config = await resolveConfig({ DSH_SCREENSHOT_MODE: undefined, EAS_BUILD_PROFILE: 'development', ENVIRONMENT: undefined });
    assert.equal(config.screenshotMode, false);
  });

  it('no flag + a production environment still resolves screenshotMode=false and keeps extra', async () => {
    const config = (await resolveConfig(
      { DSH_SCREENSHOT_MODE: undefined, EAS_BUILD_PROFILE: 'production', ENVIRONMENT: 'production' },
      { eas: { projectId: 'p' } },
    )) as Record<string, unknown>;
    assert.equal(config.screenshotMode, false);
    assert.equal((config.eas as Record<string, unknown>).projectId, 'p');
    assert.equal((config.eas as Record<string, unknown>).buildProfile, undefined, 'nothing is added to a release extra');
  });

  it('the app.config profile list matches the core profile rule', () => {
    const config = read('app.config.ts');
    const list = /const PRODUCTION_PROFILES = \[([^\]]*)\]/.exec(config)?.[1] ?? '';
    const names = [...list.matchAll(/'([^']*)'/g)].map((match) => match[1]).filter((name): name is string => name !== undefined);
    assert.ok(names.length > 0);
    for (const name of names) assert.equal(isProductionProfile(name), true, `${name} is production in core`);
    for (const name of ['development', 'preview', 'internal']) assert.equal(names.includes(name), false);
  });
});
