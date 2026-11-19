// Web transport (spec 020 requirement 2) — reviewer-requested coverage.
//
// The web transport is `src/platform/pinned-transport.web.ts`: a `Transport` over the browser's
// WebSocket. It cannot pin a certificate, so these tests pin the three things that must hold
// instead: only tailnet hosts are contacted, the accepted subprotocol is verified after `open`,
// and a socket that never opens reports exactly ONE failure (never the doubled report that made
// the client believe it had already retried).

import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { afterEach, beforeEach, describe, it } from 'node:test';

import type { Transport } from '../src/core/transport';
import {
  DEVICE_NAME_MAX_ENCODED,
  PinnedTransport,
  createPinnedTransport,
  encodeDeviceName,
  isTailnetUrl,
} from '../src/platform/pinned-transport.web';

const HOST = 'wss://host.example.ts.net:8443';

interface RecordedEvent {
  type: string;
  code?: string | number;
  reason?: string;
}

/** Minimal WebSocket stand-in: the test decides what the browser would do. */
class FakeWebSocket {
  static last: FakeWebSocket | null = null;
  static created: number = 0;
  readonly url: string;
  readonly protocols: string | string[] | undefined;
  protocol = '';
  onopen: (() => void) | null = null;
  onmessage: ((event: { data: unknown }) => void) | null = null;
  onerror: (() => void) | null = null;
  onclose: ((event: { code: number; reason: string; wasClean: boolean }) => void) | null = null;
  closedWith: { code: number; reason: string } | null = null;
  sent: string[] = [];

  constructor(url: string, protocols?: string | string[]) {
    this.url = url;
    this.protocols = protocols;
    FakeWebSocket.last = this;
    FakeWebSocket.created += 1;
  }

  send(data: string): void {
    this.sent.push(data);
  }

  close(code: number, reason: string): void {
    this.closedWith = { code, reason };
  }

  /** The browser opened the socket and negotiated `protocol`. */
  simulateOpen(protocol: string): void {
    this.protocol = protocol;
    this.onopen?.();
  }

  simulateCloseBeforeOpen(code = 1006, reason = ''): void {
    this.onerror?.();
    this.onclose?.({ code, reason, wasClean: false });
  }
}

function record(transport: Transport): RecordedEvent[] {
  const events: RecordedEvent[] = [];
  transport.on((event) => {
    events.push({ type: event.type, ...(event.type === 'error' ? { code: event.code } : {}), ...(event.type === 'close' ? { code: event.code, reason: event.reason } : {}) });
  });
  return events;
}

describe('web transport: tailnet-only, protocol-checked, one failure report', () => {
  const realWebSocket = globalThis.WebSocket;

  beforeEach(() => {
    FakeWebSocket.last = null;
    FakeWebSocket.created = 0;
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    (globalThis as any).WebSocket = FakeWebSocket;
  });

  afterEach(() => {
    globalThis.WebSocket = realWebSocket;
  });

  it('accepts a tailnet host on a non-default port and rejects everything else', () => {
    // Port 443 is taken on this tailnet (spec 020 §Port): :8443 must pass. `URL.hostname` has no
    // port, so the check is port-agnostic by construction.
    assert.equal(isTailnetUrl(HOST), true);
    assert.equal(isTailnetUrl('wss://host.example.ts.net'), true);
    assert.equal(isTailnetUrl('wss://evil.example.com:8443'), false);
    assert.equal(isTailnetUrl('wss://ts.net'), false, 'bare suffix is not a tailnet host');
    assert.equal(isTailnetUrl('ws://host.example.ts.net:8443'), false, 'cleartext is refused');
    assert.equal(isTailnetUrl('not a url'), false);
  });

  it('refuses a non-tailnet host before opening any socket', () => {
    const transport = createPinnedTransport();
    const events = record(transport);
    transport.connect('wss://evil.example.com:8443', { certSha256: 'a'.repeat(64) });

    assert.equal(FakeWebSocket.created, 0, 'no socket is created for a foreign host');
    assert.deepEqual(events.map((event) => event.type), ['error', 'close']);
    assert.equal(events[0]?.code, 'client/bad-url');
    assert.equal(events[1]?.reason, 'not-tailnet');
  });

  it('refuses an unusable installation id before the upgrade', () => {
    const transport = createPinnedTransport();
    const events = record(transport);
    transport.connect(HOST, { certSha256: 'a'.repeat(64), headers: { 'X-DSH-Device-ID': 'bad id!' } });

    assert.equal(FakeWebSocket.created, 0);
    assert.equal(events[0]?.code, 'client/bad-url');
    assert.equal(events[1]?.reason, 'bad-device-id');
  });

  it('sends the device id as the dsh-device subprotocol (browsers cannot send headers)', () => {
    const transport = createPinnedTransport();
    record(transport);
    transport.connect(HOST, {
      certSha256: 'a'.repeat(64),
      protocols: ['dsh-mobile-v1', 'dsh-pair.code123'],
      headers: { 'X-DSH-Device-ID': 'install-1234-abcdef' },
    });

    const socket = FakeWebSocket.last;
    assert.ok(socket !== null);
    assert.deepEqual(socket.protocols, ['dsh-mobile-v1', 'dsh-pair.code123', 'dsh-device.install-1234-abcdef']);
  });

  it('sends the device name as the dsh-device-name subprotocol (browsers cannot send headers)', () => {
    const transport = createPinnedTransport();
    record(transport);
    transport.connect(HOST, {
      certSha256: 'a'.repeat(64),
      protocols: ['dsh-mobile-v1', 'dsh-pair.code123'],
      headers: { 'X-DSH-Device-ID': 'install-1234-abcdef', 'X-DSH-Device-Name': 'DSH Orbit (Web)' },
    });

    const socket = FakeWebSocket.last;
    assert.ok(socket !== null);
    // UTF-8 -> unpadded Base64URL, the exact encoding `lib/index.mjs` decodes.
    assert.deepEqual(socket.protocols, [
      'dsh-mobile-v1',
      'dsh-pair.code123',
      'dsh-device.install-1234-abcdef',
      'dsh-device-name.RFNIIE9yYml0IChXZWIp',
    ]);
  });

  it('offers no name subprotocol when the client reports no name', () => {
    const transport = createPinnedTransport();
    record(transport);
    transport.connect(HOST, {
      certSha256: 'a'.repeat(64),
      headers: { 'X-DSH-Device-ID': 'install-1234-abcdef', 'X-DSH-Device-Name': '   ' },
    });

    const socket = FakeWebSocket.last;
    assert.ok(socket !== null);
    assert.deepEqual(socket.protocols, ['dsh-mobile-v1', 'dsh-device.install-1234-abcdef']);
  });

  const connectWithName = (name: string): string[] => {
    const transport = createPinnedTransport();
    const events = record(transport);
    transport.connect(HOST, {
      certSha256: 'a'.repeat(64),
      protocols: ['dsh-mobile-v1', 'dsh-pair.code123'],
      headers: { 'X-DSH-Device-ID': 'install-1234-abcdef', 'X-DSH-Device-Name': name },
    });
    assert.equal(events.length, 0, 'connecting with any name never reports a failure');
    const socket = FakeWebSocket.last;
    assert.ok(socket !== null, 'a socket is still created');
    return socket.protocols as string[];
  };
  const BASE_PROTOCOLS = ['dsh-mobile-v1', 'dsh-pair.code123', 'dsh-device.install-1234-abcdef'];
  const decodeName = (protocol: string): string =>
    Buffer.from(protocol.slice('dsh-device-name.'.length), 'base64url').toString('utf8');

  it('encodes a Unicode name as UTF-8 Base64URL, trimmed and without control characters', () => {
    const protocols = connectWithName('  Điện thoại 📱\u0000\n  ');
    assert.deepEqual(protocols.slice(0, 3), BASE_PROTOCOLS);
    assert.equal(protocols.length, 4);
    assert.equal(decodeName(protocols[3] as string), 'Điện thoại 📱');
  });

  it('caps a long name at 80 code points (not UTF-16 units) and keeps the connection', () => {
    const protocols = connectWithName('😀'.repeat(200));
    assert.deepEqual(protocols.slice(0, 3), BASE_PROTOCOLS);
    assert.equal(protocols.length, 4);
    assert.equal(Array.from(decodeName(protocols[3] as string)).length, 80);
  });

  it('drops only the name protocol when the encoded name exceeds 512 characters', () => {
    // 80 code points of 4 UTF-8 bytes = 320 bytes = 427 base64url chars (fits); a 4-byte-per-point
    // name never exceeds 512 once capped, so prove the guard through the exported encoder's bound.
    assert.equal(encodeDeviceName('😀'.repeat(80))?.length, 427);
    assert.ok(DEVICE_NAME_MAX_ENCODED >= 427 && DEVICE_NAME_MAX_ENCODED === 512);
    // A name that is only control characters / whitespace yields no name protocol at all.
    assert.deepEqual(connectWithName('\u0000\u0007  \t'), BASE_PROTOCOLS);
  });

  it('survives an encode failure: no name protocol, all other protocols kept, no throw', () => {
    const realEncode = TextEncoder.prototype.encode;
    TextEncoder.prototype.encode = function () {
      throw new Error('simulated encode failure');
    };
    try {
      assert.equal(encodeDeviceName('Phone'), null);
      assert.deepEqual(connectWithName('Phone'), BASE_PROTOCOLS);
    } finally {
      TextEncoder.prototype.encode = realEncode;
    }
    assert.equal(typeof encodeDeviceName('Phone'), 'string', 'encoder restored');
  });

  it('closes 1002 and reports a protocol mismatch when the host does not accept dsh-mobile-v1', () => {
    const transport = createPinnedTransport();
    const events = record(transport);
    transport.connect(HOST, { certSha256: 'a'.repeat(64) });
    const socket = FakeWebSocket.last;
    assert.ok(socket !== null);

    socket.simulateOpen('some-other-protocol');

    assert.equal(socket.closedWith?.code, 1002);
    assert.equal(socket.closedWith?.reason, 'protocol-mismatch');
    assert.equal(events[0]?.type, 'error');
    assert.equal(events[0]?.code, 'client/protocol-mismatch');
    assert.equal(events.some((event) => event.type === 'open'), false, 'a mismatched socket is never open');
  });

  it('reports exactly one connect-failed for a socket that never opened', () => {
    const transport = createPinnedTransport();
    const events = record(transport);
    transport.connect(HOST, { certSha256: 'a'.repeat(64) });
    const socket = FakeWebSocket.last;
    assert.ok(socket !== null);

    socket.simulateCloseBeforeOpen(); // the browser fires error, then close

    const failures = events.filter((event) => event.type === 'error');
    assert.equal(failures.length, 1, 'one failure report, not two');
    assert.equal(failures[0]?.code, 'client/connect-failed');
  });

  it('sends nothing before open and reports open only for the contract protocol', () => {
    const transport = createPinnedTransport();
    const events = record(transport);
    transport.connect(HOST, { certSha256: 'a'.repeat(64) });
    const socket = FakeWebSocket.last;
    assert.ok(socket !== null);

    assert.equal(transport.send('{"type":"ping"}'), false, 'no bytes before open');
    socket.simulateOpen('dsh-mobile-v1');
    assert.deepEqual(events.map((event) => event.type), ['open']);
    assert.equal(transport.send('{"type":"ping"}'), true);
    assert.deepEqual(socket.sent, ['{"type":"ping"}']);
  });
});

describe('PWA build input (built by scripts/build-web.mjs)', () => {
  const buildScript = path.resolve(import.meta.dirname, '..', 'scripts', 'build-web.mjs');

  it('allows the tailnet WebSocket on an explicit port and nothing wider', () => {
    const source = readFileSync(buildScript, 'utf8');
    assert.ok(source.includes("connect-src 'self' wss://*.ts.net:*"), 'connect-src must keep the explicit port wildcard');
    assert.equal(source.includes("connect-src 'self' wss: https:'"), false, 'no blanket wss:/https: source');
    assert.ok(source.includes("script-src 'self'"), 'scripts stay same-origin only');
  });

  it('sends the SAME connect-src from the host that serves the PWA (spec 020 same-origin gateway)', () => {
    // The build injects the policy as a <meta>; `scripts/serve-web.mjs` sends it as a header so
    // `frame-ancestors` is enforced too. The same-origin gateway socket rides `'self'` in both, and
    // a divergence between the two copies would silently block pairing on one path only.
    const serveWeb = readFileSync(path.resolve(import.meta.dirname, '..', 'scripts', 'serve-web.mjs'), 'utf8');
    assert.ok(serveWeb.includes("connect-src 'self' wss://*.ts.net:*"), 'the header CSP matches the meta CSP');
    assert.equal(serveWeb.includes("connect-src 'self' wss: https:'"), false, 'no blanket wss:/https: source in the header either');
  });
});
