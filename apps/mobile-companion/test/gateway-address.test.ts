// Spec 020 (owner decision 2026-11-13) — the SAME-ORIGIN gateway address of the web build.
//
// The PWA is served from one tailnet HTTPS origin and `tailscale serve` routes `/ws/mobile` on that
// origin to the gateway's TLS listener. So the browser must dial its OWN origin, not the QR's
// `wss://<tailnet ip>:<port>`: that listener is self-signed by design, a browser refuses it before
// any frame moves, and a browser cannot pin a leaf (spec 020 §owner).
//
// Two layers are covered here:
//   * the pure derivation (`src/core/gateway-address.ts`), including every shape it must REFUSE;
//   * the controller wiring: `pair()` must actually connect to the derived address, and an
//     unchanged payload on native (where the location reader answers `null`).

import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import {
  GATEWAY_WS_PATH,
  encodePairingPayload,
  sameOriginGatewayUrl,
  withSameOriginEndpoint,
  type PairingPayload,
} from '../src/core';
import { AppController } from '../src/app-state';
import { readWebLocation } from '../src/platform/web-location';
import { ScriptedTransport } from './support/scripted-transport';
import { waitFor } from './support/wait';

/** A tailnet origin: the page's own host:port, exactly as the browser writes it. */
const TAILNET = { protocol: 'https:', host: 'host.example.ts.net:8443' };
const TAILNET_URL = `wss://host.example.ts.net:8443${GATEWAY_WS_PATH}`;

const PAIRING_CODE = 'A'.repeat(43);
const PIN = 'a'.repeat(64);
const GATEWAY_ID = '0f8fad5b-d9cb-469f-a165-70867728950e';

function payload(publicUrl: string, endpoints: string[]): PairingPayload {
  return {
    version: 3,
    publicUrl,
    pairingCode: PAIRING_CODE,
    expiresAt: Date.now() + 240_000,
    certSha256: PIN,
    gatewayId: GATEWAY_ID,
    gatewayName: 'my-pc',
    endpoints,
  };
}

describe('sameOriginGatewayUrl', () => {
  it('maps a tailnet HTTPS origin to its own wss:// gateway path', () => {
    assert.equal(sameOriginGatewayUrl(TAILNET), TAILNET_URL);
    // A default-port origin keeps no port, exactly as `location.host` writes it.
    assert.equal(sameOriginGatewayUrl({ protocol: 'https:', host: 'host.example.ts.net' }), `wss://host.example.ts.net${GATEWAY_WS_PATH}`);
  });

  it('refuses every origin that is not a tailnet HTTPS page', () => {
    const refused: Array<[string, { protocol: string; host: string } | null]> = [
      ['no location (native)', null],
      ['plain http page', { protocol: 'http:', host: 'host.example.ts.net:8443' }],
      ['a non-tailnet host', { protocol: 'https:', host: 'evil.example.com' }],
      ['the bare suffix', { protocol: 'https:', host: 'ts.net' }],
      ['a suffix-lookalike', { protocol: 'https:', host: 'example.ts.net.evil.com' }],
      ['an empty host', { protocol: 'https:', host: '   ' }],
    ];
    for (const [label, location] of refused) {
      assert.equal(sameOriginGatewayUrl(location), null, label);
    }
  });

  it('matches the transport rule: the URL it proposes is one isTailnetUrl accepts', async () => {
    const { isTailnetUrl } = await import('../src/platform/pinned-transport.web');
    assert.equal(isTailnetUrl(TAILNET_URL), true);
    // The whole point: every address the deriver refuses is also one the transport refuses, so the
    // app can never propose a URL it would then reject at connect time.
    for (const host of ['evil.example.com', 'ts.net', 'example.ts.net.evil.com']) {
      assert.equal(isTailnetUrl(`wss://${host}${GATEWAY_WS_PATH}`), false, host);
    }
  });
});

describe('withSameOriginEndpoint', () => {
  it('replaces publicUrl and puts the same-origin address first in endpoints', () => {
    const original = payload('wss://100.100.10.20:30081/ws/mobile', [
      'wss://100.100.10.20:30081/ws/mobile',
      'wss://other.example.ts.net:30081/ws/mobile',
    ]);
    const rewritten = withSameOriginEndpoint(original, TAILNET);
    assert.equal(rewritten.publicUrl, TAILNET_URL);
    assert.deepEqual(rewritten.endpoints, [TAILNET_URL, 'wss://100.100.10.20:30081/ws/mobile', 'wss://other.example.ts.net:30081/ws/mobile']);
    // The original object is never mutated: it is the parsed QR, and the pages still read it.
    assert.equal(original.publicUrl, 'wss://100.100.10.20:30081/ws/mobile');
  });

  it('never lists the same-origin address twice', () => {
    const already = payload(TAILNET_URL, [TAILNET_URL, 'wss://100.100.10.20:30081/ws/mobile']);
    const rewritten = withSameOriginEndpoint(already, TAILNET);
    assert.deepEqual(rewritten.endpoints, [TAILNET_URL, 'wss://100.100.10.20:30081/ws/mobile']);
    assert.equal(rewritten, already, 'an already-correct payload is returned as is');
  });

  it('returns the payload untouched off the web (native, http page, foreign host)', () => {
    const original = payload('wss://100.100.10.20:30081/ws/mobile', ['wss://100.100.10.20:30081/ws/mobile']);
    for (const location of [null, { protocol: 'http:', host: 'host.example.ts.net:8443' }, { protocol: 'https:', host: 'evil.example.com' }]) {
      assert.equal(withSameOriginEndpoint(original, location), original);
    }
  });
});

describe('pair() on the web', () => {
  it('dials the same-origin gateway address, not the self-signed one from the QR', async () => {
    const transport = new ScriptedTransport();
    const controller = new AppController({
      locale: () => 'en',
      transport: () => transport,
      webLocation: () => TAILNET,
      pairAckTimeoutMs: 50,
    });
    const qr = encodePairingPayload(payload('wss://100.100.10.20:30081/ws/mobile', ['wss://100.100.10.20:30081/ws/mobile']));
    // `pair()` refuses until `start()` has loaded the stored host list (its identity check reads
    // it), so the production order — start, then pair — is what these tests reproduce.
    await controller.start();
    // The pairing does not complete here (no host answers); what matters is the address it opened
    // with, which is decided before the first frame. `pair()` reads the install id first, so the
    // socket appears on a later turn.
    void controller.pair(qr).catch(() => undefined);
    await waitFor(() => transport.connects.length === 1, { label: 'pairing socket opened' });
    assert.equal(transport.connects[0]?.url, TAILNET_URL);
    // The pin still travels with it: the browser ignores it, a native build would not, and nothing
    // about the credential path changes (the one-time code rides the `dsh-pair.` subprotocol).
    assert.equal(transport.connects[0]?.options.certSha256, PIN);
    assert.deepEqual(transport.connects[0]?.options.protocols, ['dsh-mobile-v1', `dsh-pair.${PAIRING_CODE}`]);
    controller.stop();
  });

  it('keeps the QR address on native, where there is no page origin', async () => {
    assert.equal(readWebLocation(), null, 'the native platform reader has no location');
    const transport = new ScriptedTransport();
    const controller = new AppController({ locale: () => 'en', transport: () => transport, pairAckTimeoutMs: 50 });
    const qr = encodePairingPayload(payload('wss://100.100.10.20:30081/ws/mobile', ['wss://100.100.10.20:30081/ws/mobile']));
    await controller.start();
    void controller.pair(qr).catch(() => undefined);
    await waitFor(() => transport.connects.length === 1, { label: 'pairing socket opened' });
    assert.equal(transport.connects[0]?.url, 'wss://100.100.10.20:30081/ws/mobile');
    controller.stop();
  });
});
