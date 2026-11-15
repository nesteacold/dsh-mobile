// Spec 031 §8 — the browser pairs through the page it was opened from, never through a typed or
// linked address.
//
// What the pair screen must do (and what this file pins):
//   * a supported page (`https://<tailnet>.ts.net`) shows its CURRENT origin as read-only text and
//     dials exactly that origin — there is no address field to type over and ignore;
//   * a foreign address cannot redirect the pairing: neither the link's `a=` nor any hash/typed
//     value reaches the address the code flow dials;
//   * an unsupported web origin (plain `http:`, or an `https:` page that is not `*.ts.net`) refuses
//     BOTH flows — the code form and a scanned/pasted QR string — with the host/HTTPS guidance that
//     already exists, BEFORE any controller or socket exists;
//   * the native OTP refusal and the native QR flow are unchanged (the QR still dials its own pinned
//     address, and the code is still refused before any socket exists).
//
// How it is driven (there is no component library here: see `test/ui-test-hooks.test.ts`):
//   1. the app's own submit seam, `planPairSubmit` (in `src/core/gateway-address.ts`), fed by
//      `planOtpAddress` exactly as the panel feeds it — both panel handlers call it first, so a
//      `blocked` answer is the same rule the screen shows;
//   2. the behaviour it implies against the REAL controller: an unsupported page pairs nothing, and
//      a supported page's OTP connect dials its own origin even when a hostile link was submitted;
//   3. a source tripwire, so an edit that bypasses the seam fails loudly.
//
// Note: the panel itself is a `.tsx` React component with no node-test harness in this repo; this
// file therefore drives the seam the panel calls and the controller it calls, never a copy of the
// guard and never a rendered button.

import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { afterEach, describe, it } from 'node:test';
import { fileURLToPath } from 'node:url';

import { GATEWAY_WS_PATH, planOtpAddress, planPairSubmit, type WebLocation } from '../src/core/gateway-address';
import { parsePairHash, parsePairLinkUrl } from '../src/core/pair-link';
import { AppController } from '../src/app-state';
import { ScriptedTransport } from './support/scripted-transport';
import { waitFor } from './support/wait';
import { resetAppState } from './support/stubs/react-native.stub';

const APP_DIR = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const PANEL = path.join(APP_DIR, 'src', 'ui', 'pair-panel.tsx');

const TAILNET: WebLocation = { protocol: 'https:', host: 'host.example.ts.net:8443' };
const TAILNET_URL = `wss://host.example.ts.net:8443${GATEWAY_WS_PATH}`;
const FOREIGN_PAGE: WebLocation = { protocol: 'https:', host: 'evil.example.com' };
const HTTP_PAGE: WebLocation = { protocol: 'http:', host: 'host.example.ts.net:8443' };

const OTP = '04291375';
/** A foreign host a link or a person might try to put in front of the app. */
const FOREIGN = 'wss://attacker.example.com:30081/ws/mobile';
/** The pair-link form the Devices dialog encodes, carrying a foreign `a=`. */
const HOSTILE_LINK = `https://host.example.ts.net/pair#a=attacker.example.com:30081&c=${OTP}`;

interface Wiring {
  controller: AppController;
  transport: ScriptedTransport;
  stop(): void;
}

async function wire(location: () => WebLocation | null): Promise<Wiring> {
  const transport = new ScriptedTransport();
  const controller = new AppController({ locale: () => 'en', transport: () => transport, webLocation: location, pairAckTimeoutMs: 50 });
  await controller.start();
  return { controller, transport, stop: () => controller.stop() };
}

/** What the panel decides for this page and this submit (the screen's own seam, same inputs). */
function decide(location: WebLocation | null, onWeb: boolean, link: boolean) {
  return planPairSubmit(planOtpAddress(location), onWeb, link);
}

/** A long pairing string (contract v3) whose own address is a foreign host. */
async function longString(publicUrl: string): Promise<string> {
  const { encodePairingPayload } = await import('../src/core');
  return encodePairingPayload({
    version: 3,
    publicUrl,
    pairingCode: 'A'.repeat(43),
    expiresAt: Date.now() + 240_000,
    certSha256: 'a'.repeat(64),
    gatewayId: '0f8fad5b-d9cb-469f-a165-70867728950e',
    gatewayName: 'my-pc',
    endpoints: [publicUrl],
  });
}

afterEach(() => {
  resetAppState();
});

describe('planOtpAddress — the page origin is the only browser address', () => {
  it('a supported page yields its own origin and wss URL, and nothing to type', () => {
    const plan = planOtpAddress(TAILNET);
    assert.deepEqual(plan, { kind: 'same-origin', url: TAILNET_URL, origin: 'https://host.example.ts.net:8443' });
    // No address is part of the plan: there is no field the user could type into.
    assert.equal('typed' in plan || 'address' in plan, false);
  });

  it('unsupported web origins are refused WITH a reason (host guidance follows each)', () => {
    const refused: Array<[string, WebLocation, 'insecure' | 'not-tailnet']> = [
      ['plain http on a tailnet name', HTTP_PAGE, 'insecure'],
      ['https on a foreign host', FOREIGN_PAGE, 'not-tailnet'],
      ['https on the bare suffix', { protocol: 'https:', host: 'ts.net' }, 'not-tailnet'],
      ['https on a lookalike', { protocol: 'https:', host: 'host.example.ts.net.evil.com' }, 'not-tailnet'],
    ];
    for (const [label, location, reason] of refused) {
      assert.deepEqual(planOtpAddress(location), { kind: 'unsupported', reason }, label);
    }
  });

  it('off the web there is no page origin, so the plan is native', () => {
    assert.deepEqual(planOtpAddress(null), { kind: 'native' });
    assert.deepEqual(planOtpAddress(undefined), { kind: 'native' });
  });
});

describe('planPairSubmit — one guard for the code form and the QR', () => {
  it('on a supported page the code AND a link dial the page origin', () => {
    assert.deepEqual(decide(TAILNET, true, false), { kind: 'otp', url: TAILNET_URL, origin: 'https://host.example.ts.net:8443' });
    // A link only pre-fills the code form; its code goes to the same page origin.
    assert.deepEqual(decide(TAILNET, true, true), { kind: 'otp', url: TAILNET_URL, origin: 'https://host.example.ts.net:8443' });
  });

  it('an unsupported page blocks BOTH flows — with or without a link', () => {
    const refused: Array<[string, WebLocation, 'insecure' | 'not-tailnet']> = [
      ['plain http', HTTP_PAGE, 'insecure'],
      ['foreign https', FOREIGN_PAGE, 'not-tailnet'],
      ['lookalike host', { protocol: 'https:', host: 'host.example.ts.net.evil.com' }, 'not-tailnet'],
    ];
    for (const [label, location, reason] of refused) {
      for (const link of [false, true]) {
        assert.deepEqual(decide(location, true, link), { kind: 'blocked', reason }, `${label} / link=${link}`);
      }
    }
  });

  it('native, as the panel actually calls it (onWeb=false, no link), is answered `qr`', () => {
    // The seam does not block native OTP; the code handler's `decision.kind !== 'otp'` guard does
    // (covered by the source check at the end of this file).
    assert.deepEqual(decide(null, false, false), { kind: 'qr' });
  });

  it("a phone's QR / long string is allowed through; only a link's address is refused", () => {
    // The QR path (long string) and the scanned `https://…/pair#a=…&c=…` link are told apart only
    // by `link`. On a phone the QR keeps its own pin, so the seam must not block it.
    const long = `dsh-pair-v3.${'A'.repeat(43)}`;
    assert.equal(parsePairLinkUrl(long), null, 'the long string is not a pair link');
    assert.deepEqual(decide(null, false, parsePairLinkUrl(long) !== null), { kind: 'qr' });
    // A link's `a=` is not a pinned address: the phone explains it instead of dialling it.
    assert.deepEqual(decide(null, false, parsePairLinkUrl(HOSTILE_LINK) !== null), { kind: 'blocked', reason: 'otpLinkNative' });
    // A page must never claim the QR path — every web submit is the code flow.
    assert.deepEqual(decide(TAILNET, true, false), { kind: 'otp', url: TAILNET_URL, origin: 'https://host.example.ts.net:8443' });
  });
});

describe('a foreign address cannot reach the pairing', () => {
  it('the pair link keeps its address, but the plan never reads one', () => {
    const link = parsePairLinkUrl(`https://host.example.ts.net/pair#a=attacker.example.com:30081&c=${OTP}`);
    assert.equal(link?.address, 'attacker.example.com:30081', 'the parser still reports what the link said');
    // What the screen dials comes from the page alone: the link address has no path into it.
    const decision = decide(TAILNET, true, link !== null);
    assert.equal(decision.kind === 'otp' ? decision.url : null, TAILNET_URL);
    // A hash that is not a pair link changes nothing either.
    assert.equal(parsePairHash('#address=attacker.example.com'), null);
    assert.equal(parsePairHash(`#c=${OTP}&address=attacker.example.com`)?.address, '');
  });

  it('seam decision: an unsupported page is `blocked` for the code AND a valid long string', async () => {
    // Unit test of the decision only. That the panel returns before any controller call on
    // `blocked` is checked by the source tripwires below (no render harness exists here).
    const long = await longString(FOREIGN);
    assert.equal(planPairSubmit(planOtpAddress(FOREIGN_PAGE), true, false).kind, 'blocked', 'the code form');
    assert.equal(planPairSubmit(planOtpAddress(FOREIGN_PAGE), true, parsePairLinkUrl(long) !== null).kind, 'blocked', 'a long QR string');
  });

  it('the OTP connect dials the page origin, whatever the link carried', async () => {
    const location = () => TAILNET;
    const w = await wire(location);
    try {
      // The link's `a=` is foreign, but the seam's answer only ever names the page origin.
      const decision = decide(TAILNET, true, true);
      assert.equal(decision.kind, 'otp');
      if (decision.kind !== 'otp') return;
      void w.controller.pair('', { otp: { otp: OTP, url: decision.url, gatewayName: decision.origin } }).catch(() => undefined);
      await waitFor(() => w.transport.connects.length === 1, { label: 'OTP socket opened' });
      assert.equal(w.transport.connects[0]?.url, TAILNET_URL, 'same-origin wss://<host>/ws/mobile');
      assert.equal(JSON.stringify(w.transport.connects).includes('attacker'), false);
      // The control case: the seam hands the controller exactly this URL, nothing else.
      assert.equal(decision.url, `wss://${TAILNET.host}${GATEWAY_WS_PATH}`);
    } finally {
      w.stop();
    }
  });
});

// ---------------------------------------------------------------------------
// Malicious link matrix — every shape goes through the same seam as a submit.
// ---------------------------------------------------------------------------

const FOREIGN_ADDRESSES = [
  'attacker.example.com:30081',
  'attacker.example.com:30081.evil.com',
  'attacker.example.com.example.ts.net:30081',
  'xn--ts-nx8.example.invalid',
  'host.example.ts.net.attacker.example.com',
  'host.example.ts.net%0d%0a.attacker.example.com',
];

interface LinkCase {
  label: string;
  /** The `/pair#…` fragment the Devices dialog would encode. */
  hash: string;
  /** The page the user actually opened, when it is not the tailnet one. */
  page?: WebLocation;
}

const LINK_MATRIX: LinkCase[] = [
  { label: 'plain foreign a=', hash: `#a=${FOREIGN_ADDRESSES[0]}&c=${OTP}` },
  { label: 'an extra parameter after the code', hash: `#a=${FOREIGN_ADDRESSES[0]}&c=${OTP}&x=1` },
  { label: 'parameters reordered', hash: `#c=${OTP}&a=${FOREIGN_ADDRESSES[0]}` },
  { label: 'a second code after the real one', hash: `#a=${FOREIGN_ADDRESSES[0]}&c=${OTP}&c=11111111` },
  { label: 'a= repeated, tailnet first', hash: `#a=node.tail.ts.net:30443&a=${FOREIGN_ADDRESSES[0]}&c=${OTP}` },
  { label: 'uppercase host and port', hash: `#a=${String(FOREIGN_ADDRESSES[0]).toUpperCase()}&c=${OTP}` },
  { label: 'lookalike that ends in the tailnet suffix', hash: `#a=${FOREIGN_ADDRESSES[2]}&c=${OTP}` },
  { label: 'IDN as punycode', hash: `#a=${FOREIGN_ADDRESSES[3]}&c=${OTP}` },
  { label: 'userinfo inside a=', hash: `#a=user@attacker.example.com:30081&c=${OTP}` },
  { label: 'userinfo with a password', hash: `#a=user:pass@attacker.example.com:30081&c=${OTP}` },
  { label: 'backslash separator', hash: `#a=attacker.example.com\\30081&c=${OTP}` },
  { label: 'crlf in the host', hash: `#a=${FOREIGN_ADDRESSES[5]}&c=${OTP}` },
  { label: 'URL-encoded at-sign', hash: `#a=attacker%40example.com:30081&c=${OTP}` },
  { label: 'the link opened on a plain http page', hash: `#a=${FOREIGN_ADDRESSES[0]}&c=${OTP}`, page: HTTP_PAGE },
  { label: 'the link opened on a foreign https page', hash: `#a=${FOREIGN_ADDRESSES[0]}&c=${OTP}`, page: FOREIGN_PAGE },
  { label: 'the link opened on a lookalike page', hash: `#a=${FOREIGN_ADDRESSES[0]}&c=${OTP}`, page: { protocol: 'https:', host: 'host.example.ts.net.evil.com' } },
];

describe('a malicious link cannot move the connect address', () => {
  for (const testCase of LINK_MATRIX) {
    it(testCase.label, async () => {
      const location = testCase.page ?? TAILNET;
      const link = parsePairLinkUrl(`https://host.example.ts.net/pair${testCase.hash}`);
      const decision = decide(location, true, link !== null);

      if (planOtpAddress(location).kind === 'unsupported') {
        // Foreign page: the submit is refused outright, whatever the link carried.
        assert.equal(decision.kind, 'blocked', 'a foreign page pairs nothing');
        if (decision.kind === 'blocked') {
          assert.equal(decision.reason, location.protocol === 'https:' ? 'not-tailnet' : 'insecure');
        }
        return;
      }
      // Supported page: the answer is a connect on the page's own origin, never the link's.
      assert.equal(decision.kind, 'otp', 'a supported page keeps the code flow');
      if (decision.kind !== 'otp') return;
      const target = new URL(decision.url);
      assert.equal(target.protocol, 'wss:', 'same-origin wss');
      assert.equal(target.host, 'host.example.ts.net:8443', 'the page host');
      assert.equal(target.pathname, GATEWAY_WS_PATH, '/ws/mobile');
      assert.equal(target.username, '');
      assert.equal(target.password, '');
      const dial = target.href.toLowerCase();
      assert.equal(dial.includes('attacker'), false, 'no foreign host in the dial');
      for (const foreign of FOREIGN_ADDRESSES) {
        const bare = foreign.replace(/%0d%0a/g, '').toLowerCase();
        assert.equal(dial.includes(bare), false, foreign);
      }

      // And that exact URL is what the controller then dials.
      const w = await wire(() => location);
      try {
        void w.controller.pair('', { otp: { otp: OTP, url: decision.url, gatewayName: decision.origin } }).catch(() => undefined);
        await waitFor(() => w.transport.connects.length === 1, { label: 'one dial' });
        assert.equal(w.transport.connects.length, 1);
        assert.equal(w.transport.connects[0]?.url, decision.url);
      } finally {
        w.stop();
      }
    });
  }

  it("an opaque origin ('null', file:, data:) is not a page origin", () => {
    const opaque: WebLocation[] = [
      // Browsers report an opaque origin's host as '' — what `readWebLocation` hands over.
      { protocol: 'null', host: '' },
      { protocol: 'file:', host: '' },
      { protocol: 'data:', host: '' },
      { protocol: 'https:', host: 'null' },
    ];
    for (const location of opaque) {
      assert.equal(planOtpAddress(location).kind, 'unsupported', JSON.stringify(location));
      for (const link of [false, true]) {
        assert.equal(decide(location, true, link).kind, 'blocked', `${JSON.stringify(location)} link=${link}`);
      }
    }
    // Case in the suffix is judged on the hostname, not on the raw string.
    assert.equal(planOtpAddress({ protocol: 'https:', host: 'HOST.Example.TS.NET:8443' }).kind, 'same-origin');
  });
});

// ---------------------------------------------------------------------------
// Source tripwire — a future edit must not bypass the seam.
// ---------------------------------------------------------------------------

describe('pair screen source — the seam decides every submit', () => {
  const source = readFileSync(PANEL, 'utf8');

  it('both submit handlers call the seam, and every controller call sits AFTER it', () => {
    const seamImport = /import \{[\s\S]*?planPairSubmit[\s\S]*?\} from '\.\.\/core\/gateway-address'/.test(source);
    assert.ok(seamImport, 'the panel imports the seam from the core module');
    // The seam is CALLED in both handlers — the import line above is not one of these.
    const seamCalls = [...source.matchAll(/\bplanPairSubmit\(/g)].map((match) => match.index);
    assert.equal(seamCalls.length, 2, 'one call in the QR/paste handler, one in the code handler');
    // Every controller call must be preceded by a seam call, and each seam call must guard the
    // controller call that follows it (no controller call may be reachable before a decision).
    const controllerCalls = [source.indexOf('controller.parsePairPayload('), source.indexOf('controller.pair(')]
      .filter((at) => at > 0);
    assert.equal(controllerCalls.length, 2, 'the QR flow parses then pairs, and the code flow pairs');
    for (const at of controllerCalls) {
      assert.ok(seamCalls.some((seam) => seam < at), `a controller call at ${at} follows a seam call`);
    }
    // And no controller call may appear before the FIRST seam call.
    assert.ok(Math.min(...controllerCalls) > Math.min(...seamCalls), 'the seam is consulted before any controller call');
  });

  it('a blocked decision shows the existing copy instead of dialling', () => {
    const blocked = source.indexOf("if (decision.kind === 'blocked')");
    assert.ok(blocked > 0, 'the panel handles a blocked decision');
    assert.match(source.slice(blocked, source.indexOf('return;', blocked)), /refusalKey/);
    // The old foreign-page branch (which paired from any website) is gone.
    assert.equal(/Platform\.OS === 'web'\) applyPairLink/.test(source), false);
  });

  it('takes only the code from a pairing link, never its address', () => {
    assert.match(source, /setOtpCode\(link\.otp\)/);
    assert.equal(/link\.address/.test(source), false, 'the link address is never adopted');
    // The typed-address helper is native-only now: the browser never reaches it (the OTP connect
    // uses the seam's url), and the supported-page branch renders no such field.
    assert.equal(source.includes('const url = otpGatewayUrl('), false, 'the browser never dials a typed address');
  });

  it('never renders the WSS url as a read-only origin field on a supported page', () => {
    const otpBlock = source.slice(source.indexOf("mode === 'otp' ? ("));
    const nativeBranch = otpBlock.indexOf('(\n                <>\n                  {/* Native');
    assert.ok(nativeBranch > 0, 'the native address branch is present');
    const field = otpBlock.indexOf('testID="pair-otp-address"');
    assert.ok(field > nativeBranch, 'the address field exists only in the native branch');
    const codeInput = otpBlock.indexOf('testID="pair-otp-input"');
    assert.ok(field < codeInput, 'the field precedes the code input');
    assert.match(otpBlock, /<Text[\s\S]*?testID="pair-otp-origin"/);
  });

  it('shows the unsupported-host guidance and skips the code form there', () => {
    assert.match(source, /testID="pair-web-unsupported"/);
    assert.match(source, /pair\.webUnsupportedInsecure/);
    assert.match(source, /const otpBlocked = web\.kind === 'unsupported'/);
  });
});

describe('native is unchanged', () => {
  it('the QR flow still dials the pinned address inside the payload', async () => {
    const location = () => null;
    const w = await wire(location);
    const payload = {
      version: 3 as const,
      publicUrl: 'wss://100.100.10.20:30081/ws/mobile',
      pairingCode: 'A'.repeat(43),
      expiresAt: Date.now() + 240_000,
      certSha256: 'a'.repeat(64),
      gatewayId: '0f8fad5b-d9cb-469f-a165-70867728950e',
      gatewayName: 'my-pc',
      endpoints: ['wss://100.100.10.20:30081/ws/mobile'],
    };
    const { encodePairingPayload } = await import('../src/core');
    try {
      // The seam lets a phone's QR through untouched, so the payload is what dials.
      assert.equal(decide(null, false, false).kind, 'qr');
      void w.controller.pair(encodePairingPayload(payload)).catch(() => undefined);
      await waitFor(() => w.transport.connects.length === 1, { label: 'pairing socket opened' });
      assert.equal(w.transport.connects[0]?.url, payload.publicUrl);
      assert.equal(w.transport.connects[0]?.options.certSha256, payload.certSha256, 'still pinned');
    } finally {
      w.stop();
    }
  });

  it('the code flow is still refused on native before any socket exists', () => {
    // 1. The seam, called as the native panel calls it, answers `qr` — not `otp`.
    assert.deepEqual(decide(null, false, false), { kind: 'qr' });
    // 2. The screen: the CODE handler (the second seam call — the QR handler's guard returns to the
    //    camera, the code handler's must return to the form) refuses and returns before any
    //    controller call. Read from the code handler onward, so the QR flow's own connect (which
    //    appears earlier in the file) cannot stand in for it.
    const source = readFileSync(PANEL, 'utf8');
    const seamCalls = [...source.matchAll(/\bplanPairSubmit\(/g)].map((match) => match.index ?? -1);
    assert.equal(seamCalls.length, 2, 'the QR handler and the code handler each call the seam once');
    const codeHandlerStart = seamCalls[1] ?? -1;
    assert.ok(codeHandlerStart > 0, 'the code handler calls the seam');
    const guard = source.indexOf("if (decision.kind === 'blocked')", codeHandlerStart);
    assert.ok(guard > codeHandlerStart, 'the code handler checks the decision it just got');
    const connect = source.indexOf('controller.pair(', guard);
    assert.ok(connect > 0, 'the OTP form does connect on the web');
    const refused = source.slice(guard, connect);
    assert.match(refused, /setFailure\(refusalKey[\s\S]*?return;/, 'it refuses through the copy and returns');
    assert.equal(refused.includes('controller.'), false, 'nothing reaches the controller');
    // 3. The native path: a non-`otp` decision (what native gets) also returns before the connect.
    const notOtp = source.indexOf("if (decision.kind !== 'otp')", guard);
    assert.ok(notOtp > guard && notOtp < connect, 'the code handler refuses any non-otp decision before connecting');
    const nativeRefusal = source.slice(notOtp, connect);
    assert.match(nativeRefusal, /setFailure\('pair\.error\.otpNative'\)[\s\S]*?return;/);
    assert.equal(nativeRefusal.includes('controller.'), false);
  });
});
