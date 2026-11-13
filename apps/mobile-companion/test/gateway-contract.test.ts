// Roadmap P1-9 — fake-vs-real gateway contract test.
//
// The SAME scripted frames are driven against
//   (a) the app's test fixture `FakeGateway` (test/support/fake-gateway.ts), and
//   (b) the real gateway plugin (plugins/mobile-gateway/lib/index.mjs), started in-process the way
//       the gateway's own suites do it (approval-hash.test.mjs / pairing-approval.test.mjs),
// and the RESPONSE SHAPES are compared: `kind`, `code`, `reason`, `accepted`, `locked`, and the
// presence of each step's required fields. Volatile values (ids, tokens, nonces, hashes, times)
// are never compared, only whether a field is there.
//
// Script: hello, client-hello, pairing claim (challenge -> proof -> pending -> paired), sessions
// list, send message, approval decision with argsHash, hash-mismatch receipt, not-pending
// duplicate, passkey-lock, push-subscribe forbidden while web push is off.
//
// Tests only: neither the fixture nor the gateway is changed here. A shape difference fails the
// test and is printed literally, so the fixture (or the gateway) can be fixed deliberately.

import assert from 'node:assert/strict';
import fs from 'node:fs';
import http from 'node:http';
import os from 'node:os';
import path from 'node:path';
import { randomBytes } from 'node:crypto';
import { test } from 'node:test';
import { fileURLToPath, pathToFileURL } from 'node:url';
import WebSocket from 'ws';

import { FakeGateway } from './support/fake-gateway';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const GATEWAY_DIR = path.resolve(HERE, '../../../plugins/mobile-gateway');
const SESSION = 's-idle';
const delay = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

type Frame = Record<string, any>;

interface Client {
  ws: WebSocket;
  frames: Frame[];
  take(pred: (f: Frame) => boolean, label: string, timeoutMs?: number): Promise<Frame>;
  close(): void;
}

function openClient(url: string, protocols: string[], headers: Record<string, string>): Promise<Client> {
  const ws = new WebSocket(url, protocols, { rejectUnauthorized: false, headers });
  const frames: Frame[] = [];
  ws.on('message', (data) => { try { frames.push(JSON.parse(data.toString())); } catch { /* not json */ } });
  ws.on('error', () => {});
  const client: Client = {
    ws,
    frames,
    async take(pred, label, timeoutMs = 5000) {
      const deadline = Date.now() + timeoutMs;
      while (Date.now() < deadline) {
        const hit = frames.find(pred);
        if (hit) return hit;
        await delay(5);
      }
      throw new Error(`timed out waiting for ${label}; got kinds: ${frames.map((f) => f.kind).join(', ')}`);
    },
    close() { try { ws.terminate(); } catch { /* gone */ } },
  };
  return new Promise((resolve, reject) => {
    ws.once('open', () => resolve(client));
    ws.once('unexpected-response', (_req, res) => reject(new Error(`upgrade refused: HTTP ${res.statusCode}`)));
    ws.once('error', reject);
  });
}

/** What one gateway under test must provide to the shared script. */
interface Host {
  name: 'fake' | 'real';
  url: string;
  /** Mint a pairing code (with the given scopes where the host supports choosing). */
  newPairingCode(scopes: string[]): Promise<string>;
  /** Approve the pending pairing raised by the proof (the desktop user's click). */
  approvePending(): Promise<void>;
  /** Raise one approval for SESSION on the host side; returns nothing (the phone reads the frame). */
  raiseApproval(callId: string): void;
  stop(): Promise<void>;
}

async function fakeHost(scopes: string[], webLock?: 'unregistered' | 'locked'): Promise<Host> {
  const fake = await FakeGateway.create({ autoApprovePairing: false, deviceScopes: scopes, webLock });
  return {
    name: 'fake',
    url: fake.endpoint,
    async newPairingCode() {
      const code = `pc-${randomBytes(8).toString('hex')}`;
      fake.addPairingCode(code);
      return code;
    },
    async approvePending() { fake.approvePairing(); },
    raiseApproval(callId) {
      fake.pushApprovalRequested({
        approvalId: `ap-${callId}`, rpcId: `rpc-${callId}`, sessionId: SESSION, toolName: 'bash', callId,
        argsHash: randomBytes(32).toString('hex'), argsPreview: '{"command":"ls"}', reason: 'contract suite',
      });
    },
    stop: () => fake.close(),
  };
}

async function realHost(): Promise<Host> {
  const plugin = (await import(pathToFileURL(path.join(GATEWAY_DIR, 'lib/index.mjs')).href)).default;
  const { createTestConnection, createTestRemoteAccess } = await import(pathToFileURL(path.join(GATEWAY_DIR, 'test/helpers/peer.mjs')).href);
  const { listenFetchSafe } = await import(pathToFileURL(path.join(GATEWAY_DIR, 'test/support/fetch-safe-listen.mjs')).href);
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'dsh-contract-'));
  const listeners: Record<string, any> = {};
  let upgrade: any;
  let management: any;
  let dispose: () => void = () => {};
  let seq = 0;
  const server = http.createServer((req, res) => {
    if (management && req.url?.startsWith('/mgw')) management.handler(req, res);
    else { res.writeHead(404); res.end(); }
  });
  server.on('upgrade', (req, socket, head) => { if (upgrade) upgrade.handler(req, socket, head); else socket.destroy(); });
  await listenFetchSafe(server);
  const port = (server.address() as any).port as number;
  const base = `http://127.0.0.1:${port}`;
  const ctx = {
    webServer: {
      port,
      register(route: any) { management = route; return () => { management = undefined; }; },
      registerUpgrade(route: any) { upgrade = route; return () => { upgrade = undefined; }; },
    },
    connection: createTestConnection(),
    remoteAccess: createTestRemoteAccess(),
    typertGateway: {
      async invoke(request: any) {
        if (request.namespace === 'session' && request.method === 'list') {
          return { items: [{ sessionId: SESSION, state: 'idle', updatedAt: 1_787_000_000_000, projections: { values: { title: 'Write the release notes' } } }] };
        }
        if (request.namespace === 'session' && request.method === 'prompt') return { messageId: 'msg-1' };
        return { items: [] };
      },
      async stream(request: any) {
        return (async function* () {
          yield { type: 'baseline', value: request.namespace === 'workspace' ? { items: [], archivedSessionIds: [] } : { projections: {} } };
          while (!request.signal.aborted) await delay(5);
        })();
      },
    },
    agentDefaultModel: {},
    on(name: string, handler: any) { listeners[name] = handler; return () => {}; },
    effect(factory: () => () => void) { dispose = factory(); },
  };
  await plugin.apply(ctx, {
    remoteControl: { enabled: true },
    gatewayMode: 'persistent',
    deviceFile: path.join(directory, 'devices.json'),
    tlsCertificateDir: path.join(directory, 'tls'),
    lanEnabled: true,
    lanHost: '127.0.0.1',
    lanPort: 0,
    // requireHostApproval left at its default (true): the claim goes challenge -> proof -> pending.
    // webPush left unset: the owner switch is OFF.
  });
  const get = async (route: string) => (await fetch(`${base}${route}`)).json() as Promise<any>;
  const post = async (route: string, body: unknown) => {
    const response = await fetch(`${base}${route}`, {
      method: 'POST', headers: { 'Content-Type': 'application/json', Origin: base }, body: JSON.stringify(body ?? {}),
    });
    return { status: response.status, body: await response.json() as any };
  };
  let url = '';
  for (let attempt = 0; attempt < 200 && url === ''; attempt += 1) {
    const status = await get('/mgw/status');
    if (status.lan?.listening && status.lan.urls.length > 0) url = status.lan.urls[0];
    else await delay(20);
  }
  assert.ok(url !== '', 'real gateway TLS listener did not come up');
  return {
    name: 'real',
    url,
    async newPairingCode(scopes) {
      const created = await post('/mgw/pair', { scopes });
      assert.ok(created.status >= 200 && created.status < 300, JSON.stringify(created.body));
      return created.body.payload.pairingCode as string;
    },
    async approvePending() {
      let pending: any[] = [];
      for (let attempt = 0; attempt < 200 && pending.length === 0; attempt += 1) {
        pending = (await get('/mgw/pending')).pending;
        if (pending.length === 0) await delay(10);
      }
      assert.equal(pending.length, 1, 'one pending pairing request');
      const approved = await post(`/mgw/pending/${encodeURIComponent(pending[0].id)}/approve`, {});
      assert.equal(approved.status, 200, JSON.stringify(approved.body));
    },
    raiseApproval(callId) {
      listeners['session/event']({ id: SESSION }, {
        type: 'tool/call', seq: ++seq, time: Date.now(),
        data: { turn: 1, step: 0, callId, name: 'bash', arguments: '{"command":"ls"}' },
      });
      void listeners['approval/request']({ agent: { id: SESSION }, toolName: 'bash', callId, reason: 'contract suite' },
        () => new Promise(() => {}));
    },
    async stop() {
      dispose();
      await new Promise((resolve) => server.close(resolve));
      fs.rmSync(directory, { recursive: true, force: true });
    },
  };
}

/** The comparable part of one frame: discriminators plus which of the required fields exist. */
function shape(frame: Frame, required: string[]): Record<string, unknown> {
  const out: Record<string, unknown> = { kind: frame.kind };
  for (const key of ['code', 'reason', 'accepted', 'locked', 'requestType', 'authenticated']) {
    if (frame[key] !== undefined) out[key] = frame[key];
  }
  out.missing = required.filter((field) => frame[field] === undefined);
  return out;
}

let requestCounter = 0;
const rid = (label: string) => `${label}-${++requestCounter}`;

async function request(client: Client, body: Frame, label: string): Promise<Frame> {
  const requestId = rid(label);
  client.ws.send(JSON.stringify({ requestId, ...body }));
  return client.take((f) => f.requestId === requestId && f.kind !== 'progress', `${label} reply`);
}

/** The shared script. Returns one normalized shape per step, keyed by step name. */
async function runScript(makeMain: () => Promise<Host>, makeWeb: () => Promise<Host>): Promise<Record<string, unknown>> {
  const steps: Record<string, unknown> = {};
  const main = await makeMain();
  const opened: Client[] = [];
  try {
    // --- pairing claim ------------------------------------------------------------------------
    const code = await main.newPairingCode(['sessions:read', 'prompt:send', 'approval:respond']);
    const pairing = await openClient(main.url, ['dsh-mobile-v1', `dsh-pair.${code}`], { 'X-DSH-Device-ID': 'contract-device-0001' });
    opened.push(pairing);
    steps['pairing-challenge'] = shape(await pairing.take((f) => f.kind === 'pairing-challenge', 'challenge'), ['serverNonce', 'certSha256', 'otpRequired']);
    pairing.ws.send(JSON.stringify({ type: 'pairing-proof', clientNonce: randomBytes(18).toString('base64url') }));
    steps['pairing-pending'] = shape(await pairing.take((f) => f.kind === 'pairing-pending', 'pending'), ['verificationCode', 'requestId', 'expiresAt']);
    await main.approvePending();
    const paired = await pairing.take((f) => f.kind === 'paired', 'paired');
    steps.paired = shape(paired, ['token', 'device', 'gatewayId', 'gatewayName']);
    steps['paired.device'] = shape({ kind: 'device', ...paired.device }, ['id', 'name', 'createdAt', 'kind', 'scopes']);
    pairing.close();

    // --- hello + client-hello on a bearer connection ------------------------------------------
    const client = await openClient(main.url, ['dsh-mobile-v1'], { Authorization: `Bearer ${paired.token}` });
    opened.push(client);
    const hello = await client.take((f) => f.kind === 'hello', 'hello');
    steps.hello = shape(hello, ['protocol', 'companionProtocol', 'minClientVersion', 'capabilities', 'authenticated', 'device', 'gatewayId', 'certSha256']);
    steps['hello.device'] = shape({ kind: 'device', ...hello.device }, ['id', 'name', 'kind', 'scopes']);
    steps['client-hello'] = shape(await request(client, { type: 'client-hello', companionProtocol: hello.companionProtocol, appVersion: 'contract', platform: 'ios' }, 'ch'), ['requestId', 'accepted']);

    // --- sessions list -------------------------------------------------------------------------
    const sessions = await request(client, { type: 'sessions' }, 'sessions');
    steps.sessions = shape(sessions, ['requestId', 'items']);
    const row = Array.isArray(sessions.items) ? sessions.items.find((r: Frame) => r.sessionId === SESSION) : undefined;
    steps['sessions.row'] = row === undefined ? 'no row for the session' : shape({ kind: 'row', ...row }, ['sessionId', 'state', 'updatedAt', 'projections']);

    // --- send message ------------------------------------------------------------------------
    steps.message = shape(await request(client, { type: 'message', sessionId: SESSION, clientMsgId: 'cm-contract-1', text: 'hi' }, 'msg'), ['requestId', 'sessionId']);

    // --- approval: hash-mismatch, decision, duplicate -----------------------------------------
    steps.subscribe = shape(await request(client, { type: 'subscribe', sessionId: SESSION }, 'sub'), ['requestId', 'sessionId']);
    main.raiseApproval('call-contract-1');
    const live = await client.take((f) => f.kind === 'approval-requested', 'approval-requested');
    steps['approval-requested'] = shape(live, ['rpcId', 'sessionId', 'approvalId', 'toolName', 'argsHash', 'argsPreview']);
    const decide = (argsHash: unknown, label: string) => request(client, {
      type: 'approval-response', rpcId: live.rpcId, sessionId: live.sessionId, approvalId: live.approvalId, argsHash, outcome: 'rejected',
    }, label);
    const receiptFields = ['requestId', 'rpcId', 'sessionId', 'approvalId', 'outcome', 'accepted'];
    steps['approval.hash-mismatch'] = shape(await decide('f'.repeat(64), 'mismatch'), [...receiptFields, 'reason']);
    steps['approval.accepted'] = shape(await decide(live.argsHash, 'accept'), receiptFields);
    steps['approval.not-pending'] = shape(await decide(live.argsHash, 'dup'), [...receiptFields, 'reason']);

    // --- push-subscribe while web push is off ------------------------------------------------
    steps['push-subscribe.off'] = shape(await request(client, {
      type: 'push-subscribe', endpoint: 'https://push.example.test/sub/1',
      keys: { p256dh: randomBytes(65).toString('base64url'), auth: randomBytes(16).toString('base64url') },
    }, 'push'), ['requestId', 'code', 'requestType', 'message']);
  } finally {
    opened.forEach((c) => c.close());
    await main.stop();
  }

  // --- passkey-lock on a web:unlock device (its own host instance, starts locked) ------------
  const web = await makeWeb();
  const webOpened: Client[] = [];
  try {
    const code = await web.newPairingCode(['sessions:read', 'web:unlock']);
    const pairing = await openClient(web.url, ['dsh-mobile-v1', `dsh-pair.${code}`], { 'X-DSH-Device-ID': 'contract-device-0002' });
    webOpened.push(pairing);
    await pairing.take((f) => f.kind === 'pairing-challenge', 'challenge');
    pairing.ws.send(JSON.stringify({ type: 'pairing-proof', clientNonce: randomBytes(18).toString('base64url') }));
    await pairing.take((f) => f.kind === 'pairing-pending', 'pending');
    await web.approvePending();
    const paired = await pairing.take((f) => f.kind === 'paired', 'paired');
    pairing.close();
    const client = await openClient(web.url, ['dsh-mobile-v1'], { Authorization: `Bearer ${paired.token}` });
    webOpened.push(client);
    const hello = await client.take((f) => f.kind === 'hello', 'hello');
    steps['web.hello'] = shape(hello, ['webLock']);
    steps['web.hello.webLock'] = hello.webLock;
    await request(client, { type: 'client-hello', companionProtocol: hello.companionProtocol, appVersion: 'contract', platform: 'web' }, 'ch');
    steps['passkey-lock'] = shape(await request(client, { type: 'passkey-lock' }, 'lock'), ['requestId', 'locked']);
  } finally {
    webOpened.forEach((c) => c.close());
    await web.stop();
  }
  return steps;
}

// P1-9 divergences (session row `id`, `sent` clientMsgId echo) were fixed in the fake fixture.
const KNOWN_DIVERGENCES: string[] = [];

test('fake gateway and real gateway answer the same scripted frames with the same shapes', async (t) => {
  const fake = await runScript(
    () => fakeHost(['sessions:read', 'prompt:send', 'approval:respond']),
    () => fakeHost(['sessions:read', 'web:unlock'], 'unregistered'),
  );
  const real = await runScript(realHost, realHost);
  const divergences: string[] = [];
  for (const step of new Set([...Object.keys(fake), ...Object.keys(real)])) {
    const a = JSON.stringify(fake[step]);
    const b = JSON.stringify(real[step]);
    if (a !== b) divergences.push(`${step}: fake=${a} real=${b}`);
  }
  for (const line of divergences) t.diagnostic(`DIVERGENCE ${line}`);
  // Any divergence fails the test.
  assert.deepEqual(divergences, KNOWN_DIVERGENCES, `fake/real gateway divergences changed:\n${divergences.join('\n')}`);
});
