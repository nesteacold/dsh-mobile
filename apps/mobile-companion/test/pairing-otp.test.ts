// OTP pairing (contract revision 5, `dsh-pair-otp.v1`) — the client half.
//
// WHY THIS FILE EXISTS: the live PWA reported "Could not pair" against a Host whose "Generate
// pairing code" flow (`POST /mgw/pair {mode:'otp'}`) offers an 8-digit code. The app only knew the
// long pairing string and closed `client/pairing-otp-unsupported` whenever the challenge said
// `otpRequired: true`. This suite pins the implemented flow:
//
//   * the code the app derives is BYTE-IDENTICAL to the Host's HMAC (`node:crypto` cross-check);
//   * a correct code pairs through the real TLS listener and the Host approval lifecycle;
//   * a wrong code is refused the way the Host refuses it (4410) and never claims success;
//   * an expired approval window is 4410, and nothing is persisted;
//   * a Host rejection is 4403 and stores nothing;
//   * malformed input is refused locally, before a socket exists (no attempt is spent);
//   * the code never reaches a frame, an error, a log sink or storage;
//   * the long pairing-string flow is unchanged (regression).
//
// The fixture verifies the proof with the Host's own formula (`test/support/fake-gateway.ts`
// `options.otp`), so a pass here cannot come from merely sending a non-empty string.

import assert from 'node:assert/strict';
import { createHash, createHmac } from 'node:crypto';
import { beforeEach, describe, it } from 'node:test';

import { FakeGateway } from './support/fake-gateway';
import { generateTestCertificate, sha256OfCertificate } from './support/certs';
import { NodePinnedTransport } from './support/node-pinned-transport';
import { ScriptedTransport } from './support/scripted-transport';
import { waitFor } from './support/wait';

import { AppController } from '../src/app-state';
import { CompanionClient, otpSubprotocols } from '../src/core/client';
import { hmacSha256Hex, sha256Hex } from '../src/core/hmac';
import { normalizeOtp, otpProof, OTP_SUBPROTOCOL, verificationCode } from '../src/core/pairing-otp';
import { redactValue } from '../src/core/redact';
import type { PinnedTransport } from '../src/platform';

const INSTALL_ID = '9f1c2b3a-4d5e-4f60-8a7b-1c2d3e4f5a6b';
const OTP = '04291375';
const VALID_NONCE = 'unit-clientnonce-0123456789-_';
const PIN = 'a'.repeat(64);
const TARGET = { installId: INSTALL_ID, deviceName: 'Pixel test', appVersion: '0.1.0', platform: 'android' as const };

/** The Host's own formula (`otpProof()` in `plugins/mobile-gateway/lib/pairing-requests.mjs`). */
const hostProof = (otp: string, cert: string, client: string, server: string): string =>
  createHmac('sha256', String(otp)).update(String(cert)).update(String(client)).update(String(server)).digest('hex');

// ---------------------------------------------------------------------------
// §1 Proof arithmetic — must equal the Host's, byte for byte
// ---------------------------------------------------------------------------

describe('OTP proof (contract revision 5)', () => {
  it('derives exactly the proof the Host computes', () => {
    const proof = otpProof(OTP, PIN, VALID_NONCE, 's'.repeat(32));
    assert.equal(proof, hostProof(OTP, PIN, VALID_NONCE, 's'.repeat(32)));
    assert.match(proof, /^[0-9a-f]{64}$/);
  });

  it('changes with every one of the four inputs (no field can be dropped)', () => {
    const base = otpProof(OTP, PIN, VALID_NONCE, 'server-nonce-0123456789');
    for (const variant of [
      otpProof('04291376', PIN, VALID_NONCE, 'server-nonce-0123456789'),
      otpProof(OTP, 'b'.repeat(64), VALID_NONCE, 'server-nonce-0123456789'),
      otpProof(OTP, PIN, 'another-nonce-0123456789', 'server-nonce-0123456789'),
      otpProof(OTP, PIN, VALID_NONCE, 'another-server-0123456789'),
    ]) {
      assert.notEqual(variant, base);
    }
  });

  it('agrees with node:crypto on random inputs (the construction, not just one vector)', () => {
    for (let index = 0; index < 25; index += 1) {
      const otp = String(Math.floor(Math.random() * 100_000_000)).padStart(8, '0');
      const cert = createHash('sha256').update(`pin-${index}`).digest('hex');
      const client = createHash('sha256').update(`c-${index}`).digest('base64url');
      const server = createHash('sha256').update(`s-${index}`).digest('base64url');
      assert.equal(otpProof(otp, cert, client, server), hostProof(otp, cert, client, server));
    }
  });

  it('computes the 6-digit comparison code the same way the Host does', () => {
    const cert = PIN;
    const client = VALID_NONCE;
    const server = 's'.repeat(32);
    const hostDigest = createHash('sha256').update(cert).update(client).update(server).update('dsh-verify').digest('hex');
    const expected = (BigInt(`0x${hostDigest}`) % 1_000_000n).toString().padStart(6, '0');
    assert.equal(verificationCode(cert, client, server), expected);
    assert.equal(sha256Hex(`${cert}${client}${server}dsh-verify`), hostDigest);
    assert.equal(hmacSha256Hex(OTP, `${cert}${client}${server}`), hostProof(OTP, cert, client, server));
  });

  it('offers the contract subprotocols, none of which carries the code', () => {
    assert.deepEqual(otpSubprotocols(), ['dsh-mobile-v1', OTP_SUBPROTOCOL]);
    for (const value of otpSubprotocols()) assert.equal(value.includes(OTP), false);
  });
});

// ---------------------------------------------------------------------------
// §2 Input handling — malformed input costs no attempt
// ---------------------------------------------------------------------------

describe('one-time code input', () => {
  it('accepts the 8 digits however they were grouped', () => {
    for (const accepted of ['04291375', '0429 1375', '0429-1375', ' 0429 1375 ', '00000000', '99999999']) {
      const result = normalizeOtp(accepted);
      assert.equal(result.ok, true, `${JSON.stringify(accepted)} must be accepted`);
      assert.equal(result.ok ? result.otp : null, accepted.replace(/[ -]/g, ''));
    }
  });

  it('refuses an empty, short, long, alphabetic or oddly-spaced code', () => {
    const cases: Array<[string, string]> = [
      ['', 'otp/empty'],
      ['   ', 'otp/empty'],
      ['0429137', 'otp/bad-length'],
      ['042913750', 'otp/bad-length'],
      ['0429137a', 'otp/bad-length'],
      ['abcdefgh', 'otp/bad-length'],
      ['0429\t1375', 'otp/bad-length'],
      ['0429\n1375', 'otp/bad-length'],
      ['0429\u00a01375', 'otp/bad-length'],
      ['+849129', 'otp/bad-length'],
    ];
    for (const [input, reason] of cases) {
      const result = normalizeOtp(input);
      assert.equal(result.ok, false, `${JSON.stringify(input)} must be refused`);
      assert.equal(result.ok === false ? result.reason : null, reason);
    }
    // A missing value is the same "nothing typed" outcome, not a crash.
    for (const absent of [null, undefined]) {
      const result = normalizeOtp(absent as unknown as string);
      assert.equal(result.ok === false ? result.reason : null, 'otp/empty');
    }
  });
});

// ---------------------------------------------------------------------------
// §3 The wire, frame by frame (no sockets needed for the protocol assertions)
// ---------------------------------------------------------------------------

describe('pairing-challenge framing for a one-time code', () => {
  function scriptedClient(overrides: Record<string, unknown> = {}): { client: CompanionClient; transport: ScriptedTransport } {
    const transport = new ScriptedTransport();
    const client = new CompanionClient({
      transport,
      appVersion: '0.1.0',
      platform: 'android',
      requestTimeoutMs: 1_000,
      pingIntervalMs: 0,
      clientNonce: () => VALID_NONCE,
      ...overrides,
    });
    return { client, transport };
  }

  it('answers with one `pairing-proof` carrying the Host-derived `otpProof`, and nothing else', () => {
    const { client, transport } = scriptedClient();
    const errors: Array<{ code: string }> = [];
    client.on('error', (error) => errors.push(error));
    client.connect({ url: 'wss://127.0.0.1:1/ws', certSha256: PIN, otp: OTP, ...TARGET });
    transport.fireOpen();
    // The pin the fixture presents is the one this connection verified (it asked for `PIN`).
    transport.deliver({ kind: 'pairing-challenge', serverNonce: 'server-nonce-0123456789-_', certSha256: PIN, otpRequired: true });

    const sent = transport.sentFrames();
    assert.equal(sent.length, 1, 'the only frame before admission is the proof');
    assert.equal(sent[0]?.type, 'pairing-proof');
    const expected = otpProof(OTP, PIN, VALID_NONCE, 'server-nonce-0123456789-_');
    assert.equal(sent[0]?.otpProof, expected, 'exactly the Host formula');
    assert.equal(typeof sent[0]?.clientNonce, 'string');
    assert.equal(sent[0]?.requestId, undefined, 'the proof carries no requestId (contract §3.8)');
    assert.deepEqual(errors, []);
    // The raw code appears NOWHERE in the frame text.
    assert.equal(transport.sent[0]?.includes(OTP), false);
    client.close();
  });

  it('sends a second challenge no proof at all', () => {
    const { client, transport } = scriptedClient();
    const errors: Array<{ code: string }> = [];
    client.on('error', (error) => errors.push(error));
    client.connect({ url: 'wss://127.0.0.1:1/ws', certSha256: PIN, otp: OTP, ...TARGET });
    transport.fireOpen();
    const challenge = { kind: 'pairing-challenge', serverNonce: 's'.repeat(32), certSha256: PIN, otpRequired: true };
    transport.deliver(challenge);
    transport.deliver(challenge);
    assert.equal(transport.sentFrames().filter((frame) => frame.type === 'pairing-proof').length, 1);
    assert.equal(errors[0]?.code, 'client/bad-message');
    client.close();
  });

  it('refuses a challenge on a flow this attempt did not start (no code supplied)', () => {
    const { client, transport } = scriptedClient();
    const errors: Array<{ code: string }> = [];
    client.on('error', (error) => errors.push(error));
    client.connect({ url: 'wss://127.0.0.1:1/ws', certSha256: PIN, pairingCode: 'Q'.repeat(43), ...TARGET });
    transport.fireOpen();
    transport.deliver({ kind: 'pairing-challenge', serverNonce: 's'.repeat(32), certSha256: PIN, otpRequired: true });
    assert.deepEqual(transport.sentFrames(), [], 'a proof the Host would close 4410 on is not sent');
    assert.equal(errors[0]?.code, 'client/pairing-otp-required');
    assert.equal(client.state, 'closed');
    client.close();
  });

  it('refuses a pin that disagrees with the challenge, before any proof leaves', () => {
    const { client, transport } = scriptedClient();
    const errors: Array<{ code: string }> = [];
    client.on('error', (error) => errors.push(error));
    client.connect({ url: 'wss://127.0.0.1:1/ws', certSha256: PIN, otp: OTP, ...TARGET });
    transport.fireOpen();
    transport.deliver({ kind: 'pairing-challenge', serverNonce: 's'.repeat(32), certSha256: 'b'.repeat(64), otpRequired: true });
    assert.deepEqual(transport.sentFrames(), [], 'no proof is keyed to an identity that was never verified');
    assert.equal(errors[0]?.code, 'client/pin-mismatch');
    assert.equal(client.state, 'closed');
    client.close();
  });

  it('adopts the challenge leaf ONLY when the attempt declared no pin, and says so', () => {
    // Trust on first use, explicit (contract revision 5: an 8-digit code carries no fingerprint).
    const adopted = scriptedClient();
    adopted.client.connect({ url: 'wss://127.0.0.1:1/ws', certSha256: '', otp: OTP, ...TARGET });
    adopted.transport.fireOpen();
    adopted.transport.deliver({ kind: 'pairing-challenge', serverNonce: 's'.repeat(32), certSha256: 'c'.repeat(64), otpRequired: true });
    assert.equal(adopted.client.adoptedPin, 'c'.repeat(64), 'the pin is adopted and readable for storage');
    assert.equal(adopted.transport.sentFrames()[0]?.type, 'pairing-proof');
    assert.equal(
      adopted.transport.sentFrames()[0]?.otpProof,
      otpProof(OTP, 'c'.repeat(64), VALID_NONCE, 's'.repeat(32)),
      'the proof is keyed to the leaf the Host will verify it against',
    );
    adopted.client.close();

    // A pinned attempt never reports an adoption.
    const pinned = scriptedClient();
    pinned.client.connect({ url: 'wss://127.0.0.1:1/ws', certSha256: PIN, otp: OTP, ...TARGET });
    pinned.transport.fireOpen();
    pinned.transport.deliver({ kind: 'pairing-challenge', serverNonce: 's'.repeat(32), certSha256: PIN, otpRequired: true });
    assert.equal(pinned.client.adoptedPin, null);
    pinned.client.close();
  });

  it('refuses a malformed one-time code before opening a socket', () => {
    const transport = new ScriptedTransport();
    const client = new CompanionClient({ transport, appVersion: '0.1.0', platform: 'android', pingIntervalMs: 0 });
    assert.throws(
      () => client.connect({ url: 'wss://127.0.0.1:1/ws', certSha256: PIN, otp: '0429137', ...TARGET }),
      (error: { code?: string }) => error.code === 'client/bad-state',
    );
    assert.deepEqual(transport.connects, [], 'nothing was dialled');
    client.close();
  });

  it('refuses two credentials at once (an OTP and a pairing code)', () => {
    const transport = new ScriptedTransport();
    const client = new CompanionClient({ transport, appVersion: '0.1.0', platform: 'android', pingIntervalMs: 0 });
    assert.throws(
      () => client.connect({ url: 'wss://127.0.0.1:1/ws', certSha256: PIN, otp: OTP, pairingCode: 'Q'.repeat(43), ...TARGET } as never),
      (error: { code?: string }) => error.code === 'client/bad-state',
    );
    client.close();
  });

  it('reports a MISSING pin and a MALFORMED pin as different failures', () => {
    // A long-string pairing always comes with a fingerprint, so "none at all" is a broken caller;
    // a fingerprint of the wrong shape is a caller that supplied something unusable. Both are
    // `client/pin-mismatch` (the vocabulary the UI maps), but the message must say which happened.
    const missing = new ScriptedTransport();
    const noPin = new CompanionClient({ transport: missing, appVersion: '0.1.0', platform: 'android', pingIntervalMs: 0 });
    const missingError = (() => {
      try {
        noPin.connect({ url: 'wss://127.0.0.1:1/ws', pairingCode: 'Q'.repeat(43), ...TARGET } as never);
        return null;
      } catch (error) {
        return error as { code?: string; message?: string };
      }
    })();
    assert.ok(missingError !== null);
    assert.equal(missingError.code, 'client/pin-mismatch');
    assert.match(String(missingError.message), /no certificate fingerprint/i);
    assert.deepEqual(missing.connects, [], 'nothing was dialled');
    noPin.close();

    const malformed = new ScriptedTransport();
    const badPin = new CompanionClient({ transport: malformed, appVersion: '0.1.0', platform: 'android', pingIntervalMs: 0 });
    const malformedError = (() => {
      try {
        badPin.connect({ url: 'wss://127.0.0.1:1/ws', certSha256: 'not-a-sha256', pairingCode: 'Q'.repeat(43), ...TARGET } as never);
        return null;
      } catch (error) {
        return error as { code?: string; message?: string };
      }
    })();
    assert.ok(malformedError !== null);
    assert.equal(malformedError.code, 'client/pin-mismatch');
    assert.match(String(malformedError.message), /SHA-256/i);
    assert.notEqual(malformedError.message, missingError.message, 'the two failures must not read the same');
    assert.deepEqual(malformed.connects, [], 'nothing was dialled');
    badPin.close();
  });

  it('fails the challenge when a supplied pin is met with NO certSha256 in it', () => {
    // The connection is pinned to a leaf it verified, so a challenge that states no leaf cannot
    // show the Host is that computer. Accepting it silently would key the proof to a pin the frame
    // never confirmed — `pairing-bad-challenge`, and no proof is written.
    const { client, transport } = scriptedClient();
    const errors: Array<{ code: string }> = [];
    const closed: Array<{ code: number; reason: string }> = [];
    client.on('error', (error) => errors.push(error));
    client.on('disconnected', (frame) => closed.push(frame));
    client.connect({ url: 'wss://127.0.0.1:1/ws', certSha256: PIN, otp: OTP, ...TARGET });
    transport.fireOpen();
    // No `certSha256` at all: distinctly different from a contradictory one.
    transport.deliver({ kind: 'pairing-challenge', serverNonce: 's'.repeat(32), otpRequired: true });

    assert.deepEqual(transport.sentFrames(), [], 'no proof is keyed to an unconfirmed identity');
    assert.equal(errors[0]?.code, 'client/pin-mismatch');
    assert.equal(closed[0]?.code, 1002);
    assert.equal(closed[0]?.reason, 'pairing-bad-challenge');
    assert.equal(client.state, 'closed');
    client.close();
  });
});

// ---------------------------------------------------------------------------
// §4 Against the real TLS listener: the Host's verdict decides
// ---------------------------------------------------------------------------

describe('one-time code against the Host (TLS listener + Host verification)', () => {
  it('pairs with a correct code, after the Host verifies the proof', async () => {
    const certificate = await generateTestCertificate();
    const gateway = await FakeGateway.create({ certificate, otpRequired: true, otp: OTP, autoApprovePairing: false });
    try {
      const transports: NodePinnedTransport[] = [];
      const client = new CompanionClient({
        transport: { create: () => { const transport = new NodePinnedTransport(); transports.push(transport); return transport; } },
        appVersion: '0.1.0',
        platform: 'android',
        requestTimeoutMs: 2_000,
        pingIntervalMs: 0,
        clientNonce: () => VALID_NONCE,
      });
      const pending: unknown[] = [];
      client.on('pairingPending', (frame) => pending.push(frame));
      client.connect({ url: gateway.endpoint, certSha256: sha256OfCertificate(certificate.cert), otp: OTP, ...TARGET });
      await waitFor(() => pending.length > 0, { timeoutMs: 5_000, label: 'pairing-pending' });
      assert.equal(gateway.otpProofAccepts, 1, 'the fixture verified the proof with the Host formula');
      assert.equal(gateway.otpProofFailures, 0);
      assert.deepEqual(transports[0]?.offeredProtocols, ['dsh-mobile-v1', OTP_SUBPROTOCOL]);
      assert.equal((transports[0]?.offeredProtocols ?? []).some((protocol) => protocol.startsWith('dsh-pair.')), false);
      for (const frame of transports[0]?.framesSent ?? []) assert.equal(frame.includes(OTP), false, 'the raw code never leaves as text');
      client.close();
    } finally {
      await gateway.close();
    }
  });

  it('the Host REJECTS a proof built from a wrong code (4410) and never issues a token', async () => {
    const certificate = await generateTestCertificate();
    const gateway = await FakeGateway.create({ certificate, otpRequired: true, otp: OTP, autoApprovePairing: false });
    try {
      const client = new CompanionClient({
        transport: { create: () => new NodePinnedTransport() },
        appVersion: '0.1.0',
        platform: 'android',
        requestTimeoutMs: 2_000,
        pingIntervalMs: 0,
      });
      const errors: Array<{ code: string }> = [];
      const paired: unknown[] = [];
      client.on('error', (error) => errors.push(error));
      client.on('paired', (frame) => paired.push(frame));
      client.connect({ url: gateway.endpoint, certSha256: sha256OfCertificate(certificate.cert), otp: '04291376', ...TARGET });
      await waitFor(() => client.state === 'closed', { timeoutMs: 5_000, label: 'refused' });
      assert.equal(gateway.otpProofFailures, 1, 'the Host refused a proof built from the wrong code');
      assert.equal(gateway.otpProofAccepts, 0);
      assert.equal(errors.at(-1)?.code, 'client/pairing-expired', '4410 is the wrong-or-expired-code outcome');
      assert.deepEqual(paired, [], 'nothing was paired');
      assert.equal(gateway.mintedTokens.length, 0, 'no token was issued');
    } finally {
      await gateway.close();
    }
  });

  it('the Host refuses the OTP subprotocol when it is not offering a code', async () => {
    // The reverse mismatch: a code was typed, but the Host is in the long-string flow. It must not
    // report a pairing this code did not create.
    const certificate = await generateTestCertificate();
    const gateway = await FakeGateway.create({ certificate, otp: OTP, pairingCodes: ['string-flow-code'] });
    try {
      const client = new CompanionClient({
        transport: { create: () => new NodePinnedTransport() },
        appVersion: '0.1.0',
        platform: 'android',
        requestTimeoutMs: 2_000,
        pingIntervalMs: 0,
      });
      const errors: Array<{ code: string }> = [];
      client.on('error', (error) => errors.push(error));
      client.connect({ url: gateway.endpoint, certSha256: sha256OfCertificate(certificate.cert), otp: OTP, ...TARGET });
      await waitFor(() => client.state === 'closed', { timeoutMs: 5_000, label: 'refused' });
      assert.equal(gateway.pairingChallenges, 0, 'the Host never opened a pairing socket for it');
      assert.equal(gateway.otpProofFailures, 0);
      assert.equal(gateway.mintedTokens.length, 0);
      assert.notEqual(errors.length, 0);
    } finally {
      await gateway.close();
    }
  });
});

// ---------------------------------------------------------------------------
// §5 The controller: the Host approval lifecycle, host record, and no storage of the code
// ---------------------------------------------------------------------------

function controllerFor(): { controller: AppController; transports: NodePinnedTransport[] } {
  const transports: NodePinnedTransport[] = [];
  const controller = new AppController({
    locale: () => 'en',
    transport: () => {
      const transport = new NodePinnedTransport();
      transports.push(transport);
      return transport as unknown as PinnedTransport;
    },
  });
  return { controller, transports };
}

/**
 * Start the controller and open its unlock gate. Without `unlock()` the controller is locked by
 * design (A020: a locked app must not read a stored credential), and a pairing then never reaches
 * `paired` — which is what every other pairing test does too (`test/app-controller-pairing.test.ts`).
 */
async function startUnlocked(): Promise<{ controller: AppController; transports: NodePinnedTransport[] }> {
  const created = controllerFor();
  await created.controller.start();
  await created.controller.unlock();
  return created;
}

/** A QR/manual payload for the long-string flow (contract §2). */
function encodeQr(gateway: FakeGateway, certPem: string, code: string): string {
  return Buffer.from(JSON.stringify({
    version: 3,
    publicUrl: gateway.endpoint,
    pairingCode: code,
    expiresAt: Date.now() + 4 * 60_000,
    certSha256: sha256OfCertificate(certPem),
    gatewayId: gateway.status.gatewayId,
    gatewayName: 'my-pc',
    endpoints: [gateway.endpoint],
  }), 'utf8').toString('base64url');
}

/**
 * The one-time-code target as the Host's OFFER hands it over (`POST /mgw/pair {mode:'otp'}` returns
 * `{ otp, certSha256, addresses }` — `plugins/mobile-gateway/lib/index.mjs:4954-4963`).
 *
 * The pin is included because the pairing transport here is the pinned Node one, which — like the
 * native module — refuses to open an unpinned socket. That refusal is the security property under
 * test elsewhere; these tests are about the OTP exchange itself, so they arrive with the pin the
 * user's device would really have been given.
 */
function otpTarget(gateway: FakeGateway, certPem: string, otp: string): { otp: string; url: string; certSha256: string; gatewayName: string } {
  return { otp, url: gateway.endpoint, certSha256: sha256OfCertificate(certPem), gatewayName: 'my-pc' };
}

/**
 * The credential store, imported EXACTLY as `src/app-state.ts` does (`../src/platform`).
 *
 * This matters: the same file reached through a different specifier can be a second module
 * instance with its own in-memory stub map, so reading `./platform/secure-store` directly observed
 * a store the app never wrote to, and a pairing that really persisted looked like it stored nothing.
 */
async function appStore(): Promise<typeof import('../src/platform')> {
  return import('../src/platform');
}

/**
 * Empty the credential store between tests.
 *
 * It goes through the store module, NOT the stub file: the stub is reachable under several
 * specifiers and the loader can hand out separate instances. Resetting the test-side one emptied a
 * store the app never wrote to, so a record left by a previous test survived.
 */
async function clearStore(): Promise<void> {
  const store = await appStore();
  for (const host of await store.readHosts()) await store.deleteToken(host.gatewayId);
  await store.writeHosts([]);
}

describe('AppController one-time-code pairing', () => {
  beforeEach(clearStore);

  it('waits for Host approval, then completes and stores the Host id, pin and device', async () => {
    const certificate = await generateTestCertificate();
    const gateway = await FakeGateway.create({ certificate, otpRequired: true, otp: OTP, autoApprovePairing: false, deviceScopes: [] });
    const { controller } = await startUnlocked();
    try {
      // Grouped like the Host dialog displays it: "0429 1375".
      const pairing = controller.pair('', { otp: otpTarget(gateway, certificate.cert, '0429 1375') });
      await waitFor(() => controller.snapshot().pairingPending !== null, { timeoutMs: 5_000, label: 'approval code shown' });
      // No record for THIS Host until the desktop user approves.
      const store = await appStore();
      assert.equal((await store.readHosts()).some((entry) => entry.gatewayId === gateway.status.gatewayId), false);
      assert.equal(gateway.mintedTokens.length, 0);
      gateway.approvePairing();
      const result = await pairing;
      assert.equal(result.ok, true);
      assert.equal(gateway.otpProofAccepts, 1);
      assert.equal(gateway.otpProofFailures, 0);
      const host = controller.snapshot().hosts[0] ?? null;
      assert.ok(host !== null);
      assert.equal(host.gatewayId, gateway.status.gatewayId, 'the id comes from the Host frame');
      assert.equal(host.certSha256, sha256OfCertificate(certificate.cert), 'the verified leaf is pinned');
      assert.equal(host.deviceId.length > 0, true);
      assert.equal(controller.snapshot().pairingPending, null);
    } finally {
      controller.stop();
      await gateway.close();
    }
  });

  it('a Host rejection is `client/pairing-rejected` and stores nothing', async () => {
    const certificate = await generateTestCertificate();
    const gateway = await FakeGateway.create({ certificate, otpRequired: true, otp: OTP, autoApprovePairing: false });
    const { controller } = await startUnlocked();
    try {
      const pairing = controller.pair('', { otp: otpTarget(gateway, certificate.cert, OTP) });
      await waitFor(() => controller.snapshot().pairingPending !== null, { timeoutMs: 5_000, label: 'approval code shown' });
      gateway.rejectPairing();
      const result = await pairing;
      assert.equal(result.ok, false);
      if (!result.ok) assert.equal(result.code, 'client/pairing-rejected');
      // Nothing was persisted for THIS Host: the rejected proof never reached `paired`, so there is
      // no record for it and no credential. Asserted against the store, which is what "stores
      // nothing" means — a controller list can also hold a record from an earlier test in this file.
      const store = await appStore();
      assert.equal((await store.readHosts()).some((entry) => entry.gatewayId === gateway.status.gatewayId), false);
      assert.equal(await store.readToken(gateway.status.gatewayId), null);
      assert.equal(controller.snapshot().pairingPending, null);
      assert.equal(controller.snapshot().pairingPending, null);
    } finally {
      controller.stop();
      await gateway.close();
    }
  });

  it('an expired approval window is `client/pairing-expired`', async () => {
    const certificate = await generateTestCertificate();
    const gateway = await FakeGateway.create({ certificate, otpRequired: true, otp: OTP, autoApprovePairing: false });
    const { controller } = await startUnlocked();
    try {
      const pairing = controller.pair('', { otp: otpTarget(gateway, certificate.cert, OTP) });
      await waitFor(() => controller.snapshot().pairingPending !== null, { timeoutMs: 5_000, label: 'approval code shown' });
      gateway.expirePairing();
      const result = await pairing;
      assert.equal(result.ok, false);
      if (!result.ok) assert.equal(result.code, 'client/pairing-expired');
      // The approval window closed before any approval, so nothing was stored for this Host.
      const store = await appStore();
      assert.equal((await store.readHosts()).some((entry) => entry.gatewayId === gateway.status.gatewayId), false);
    } finally {
      controller.stop();
      await gateway.close();
    }
  });

  it('refuses a malformed code locally, spending no attempt and opening no socket', async () => {
    const certificate = await generateTestCertificate();
    const gateway = await FakeGateway.create({ certificate, otpRequired: true, otp: OTP, autoApprovePairing: false });
    const { controller, transports } = await startUnlocked();
    try {
      for (const bad of ['', '   ', '0429137', 'abcdefgh', '0429137a']) {
        const result = await controller.pair('', { otp: otpTarget(gateway, certificate.cert, bad) });
        assert.equal(result.ok, false, `${JSON.stringify(bad)} must be refused`);
        if (!result.ok) assert.equal(result.code, bad.trim() === '' ? 'otp/empty' : 'otp/bad-length');
      }
      assert.equal(transports.length, 0, 'no socket was opened for unprovable input');
      assert.equal(gateway.pairingChallenges, 0);
      assert.equal(gateway.otpProofFailures, 0, 'no attempt was spent');
    } finally {
      controller.stop();
      await gateway.close();
    }
  });

  it('pairs with the long pairing string exactly as before (regression)', async () => {
    const certificate = await generateTestCertificate();
    // `parsePairingQr` requires the canonical unpadded base64url of 32 bytes: 43 characters whose
    // last one has its two spare bits zero (`test/app-controller-pairing.test.ts` documents the set).
    const code = 'A'.repeat(42) + 'Q';
    const gateway = await FakeGateway.create({ certificate, pairingCodes: [code], deviceScopes: [] });
    const { controller } = await startUnlocked();
    try {
      const result = await controller.pair(encodeQr(gateway, certificate.cert, code));
      assert.equal(result.ok, true);
      assert.equal(controller.snapshot().hosts[0]?.gatewayId, gateway.status.gatewayId);
      // The OTP machinery did not touch this flow.
      assert.equal(gateway.otpProofAccepts, 0);
      assert.equal(gateway.otpProofFailures, 0);
    } finally {
      controller.stop();
      await gateway.close();
    }
  });

  it('refuses a `paired` frame that states NO host id, and stores nothing', async () => {
    // An OTP attempt has no payload id, so the Host's own statement in `paired` is the only
    // identity available. Without it the credential would be keyed to '' — unreachable at
    // reconnect and namable by no revocation — so the pairing must be refused instead.
    const certificate = await generateTestCertificate();
    const gateway = await FakeGateway.create({ certificate, otpRequired: true, otp: OTP, omitGatewayId: true, deviceScopes: [] });
    const { controller, transports } = await startUnlocked();
    try {
      const before = controller.snapshot();
      const result = await controller.pair('', { otp: otpTarget(gateway, certificate.cert, OTP) });

      assert.equal(result.ok, false);
      if (!result.ok) assert.equal(result.code, 'client/pairing-no-host-id');
      // The socket was really used (so this is the `paired` refusal, not an earlier one), and the
      // Host even minted a token — yet this phone's paired set is exactly what it was before.
      assert.equal(transports.length, 1, 'the attempt did reach a socket');
      assert.deepEqual(gateway.mintedTokens.length, 1, 'the Host did mint a token we must not keep');
      const after = controller.snapshot();
      assert.deepEqual(after.hosts.map((host) => host.gatewayId), before.hosts.map((host) => host.gatewayId), 'no record was added');
      assert.equal(after.hosts.some((host) => host.gatewayId === ''), false, 'nothing is keyed to the empty id');
      assert.equal(after.activeHost, before.activeHost, 'the active host is unchanged');
      assert.equal(controller.snapshot().connection !== 'ready', true, 'no connection was made with a refused pairing');
    } finally {
      controller.stop();
      await gateway.close();
    }
  });

  it('refuses a `paired` frame naming ANOTHER computer\'s id, and keeps that host untouched', async () => {
    // The attack this closes: a pairing names an id this phone already has a record + token for.
    // Both are keyed by `gatewayId` (`saveHost` upserts, `saveToken` overwrites), so persisting it
    // would hand the attacker that host's slot. Nothing in a pairing frame proves the sender IS
    // that computer — an OTP attempt learns the id from this very frame.
    const certificate = await generateTestCertificate();
    const known = await FakeGateway.create({ certificate, otpRequired: true, otp: OTP, deviceScopes: [] });
    const { controller } = await startUnlocked();
    try {
      // The control: this phone really is paired with `known`.
      const first = await controller.pair('', { otp: otpTarget(known, certificate.cert, OTP) });
      assert.equal(first.ok, true, JSON.stringify(first));
      const knownId = known.status.gatewayId;
      const recordBefore = controller.snapshot().hosts.find((entry) => entry.gatewayId === knownId);
      assert.ok(recordBefore !== undefined, 'the control: a record exists for the known host');
      const tokenBefore = known.mintedTokens.at(-1);
      assert.ok(tokenBefore !== undefined);

      // A second Host presents the SAME identity with a different certificate and address.
      const hostileCertificate = await generateTestCertificate();
      const spoof = await FakeGateway.create({ certificate: hostileCertificate, otpRequired: true, otp: OTP, gatewayId: knownId, deviceScopes: [] });
      try {
        const result = await controller.pair('', { otp: otpTarget(spoof, hostileCertificate.cert, OTP) });

        assert.equal(result.ok, false);
        if (!result.ok) assert.equal(result.code, 'client/pairing-host-conflict');
        // The record was not replaced: it still pins the ORIGINAL leaf and address, so the
        // impostor's certificate never becomes what this phone trusts for that id.
        const recordAfter = controller.snapshot().hosts.find((entry) => entry.gatewayId === knownId);
        assert.equal(recordAfter?.certSha256, recordBefore.certSha256, 'the record still pins the original leaf');
        assert.equal(recordAfter?.publicUrl, recordBefore.publicUrl);
        assert.equal(controller.snapshot().hosts.filter((entry) => entry.gatewayId === knownId).length, 1);
        assert.equal(controller.snapshot().activeHost?.gatewayId, knownId);

        // THE CREDENTIAL PROOF: reconnecting still authenticates with the token `known` minted. The
        // impostor mints its own `tok-N`, so if that had replaced the credential, `known` would
        // refuse this socket (it accepts only what it issued) and `ready` would never arrive.
        await controller.unlock();
        await waitFor(() => controller.snapshot().connection === 'ready', { timeoutMs: 5_000, label: 'known host still reachable' });
        assert.equal(known.tokensAccepted.includes(tokenBefore), true, 'the original token is still the one in use');
      } finally {
        await spoof.close();
      }
    } finally {
      controller.stop();
      await known.close();
    }
  });

  it('re-pairs the SAME computer (same pin and address) without a conflict', async () => {
    // The conflict rule must not break the legitimate case it sits next to: pairing the same Host
    // again (a replaced credential, a fresh code) replaces its record instead of being refused.
    const certificate = await generateTestCertificate();
    const gateway = await FakeGateway.create({ certificate, otpRequired: true, otp: OTP, deviceScopes: [] });
    const { controller } = await startUnlocked();
    try {
      assert.equal((await controller.pair('', { otp: otpTarget(gateway, certificate.cert, OTP) })).ok, true);
      const again = await controller.pair('', { otp: otpTarget(gateway, certificate.cert, OTP) });

      assert.equal(again.ok, true, JSON.stringify(again));
      const records = controller.snapshot().hosts.filter((entry) => entry.gatewayId === gateway.status.gatewayId);
      assert.equal(records.length, 1, 'the record is replaced, never duplicated');
    } finally {
      controller.stop();
      await gateway.close();
    }
  });
});

// ---------------------------------------------------------------------------
// §6 No secret persistence, no secret in diagnostics
// ---------------------------------------------------------------------------

describe('one-time code secrecy', () => {
  // This block asserts on what the credential store holds, so it must start from an empty one.
  beforeEach(clearStore);

  it('is masked by the diagnostics redactor under every plausible key', () => {
    for (const key of ['otp', 'otpCode', 'otp_code', 'oneTimeCode', 'one_time_code', 'code']) {
      const redacted = redactValue({ [key]: OTP }) as Record<string, unknown>;
      assert.equal(redacted[key], '[redacted]', `${key} must be masked`);
    }
  });

  it('never appears in a serialised diagnostics value it is nested in', () => {
    const redacted = JSON.stringify(redactValue({ a: { otp: OTP }, b: [{ otpCode: OTP }] }));
    assert.equal(redacted.includes(OTP), false);
  });

  it('is never written to the host record or the credential store', async () => {
    const certificate = await generateTestCertificate();
    const gateway = await FakeGateway.create({ certificate, otpRequired: true, otp: OTP, deviceScopes: [] });
    const { controller } = await startUnlocked();
    try {
      const result = await controller.pair('', { otp: otpTarget(gateway, certificate.cert, OTP) });
      assert.equal(result.ok, true);
      // What THIS pairing recorded, taken from controller state rather than a second store import
      // (the test runner can hand out more than one instance of a stubbed module, which made a
      // correct pairing look like it persisted nothing).
      const host = controller.snapshot().hosts.find((entry) => entry.gatewayId === gateway.status.gatewayId) ?? null;
      assert.ok(host !== null, 'the control: this pairing really did write a host record');
      assert.equal(JSON.stringify(host).includes(OTP), false, 'the one-time code is never in the host record');
      // Nothing the credential store holds mentions the code either: every entry it exposes (the host
      // list and the token) is checked as raw text. Resolved by the module specifier the app itself
      // uses, so this is the store the pairing wrote to.
      const stub = await import('expo-secure-store') as unknown as { secureStoreEntries(): Array<[string, string]> };
      for (const [key, value] of stub.secureStoreEntries()) {
        assert.equal(String(key).includes(OTP) || String(value).includes(OTP), false, `no store entry carries the code (${key})`);
      }
    } finally {
      controller.stop();
      await gateway.close();
    }
  });
});
