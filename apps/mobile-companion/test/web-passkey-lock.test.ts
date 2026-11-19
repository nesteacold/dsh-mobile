// Spec 021 (contract revision 14) — the controller's web passkey lock.
//
// What is asserted here is the WIRING, because the security decision is the Host's (it verifies the
// challenge, origin, signature and sign counter) and the browser half is covered against a fake
// WebAuthn in `test/web-unlock*.test.ts`:
//
//   * a `hello.webLock` of `locked` keeps the session list unrequested (a locked socket may only use
//     hello/ping and the passkey frames — a resync would be refused `auth/locked`);
//   * `unregistered` asks for a passkey, `already-registered` waits for the owner;
//   * "Lock now" sends `passkey-lock` and closes the socket;
//   * a native device (no `webLock`) is completely unaffected.
//
// The browser steps are INJECTED (`ControllerOptions.passkey`), exactly like `transport`: Node has no
// WebAuthn at all, so a real module call here would be testing the absence of a browser.

import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import { AppController } from '../src/app-state';
import { CoreError, encodePairingPayload, type PairingPayload } from '../src/core';
import type { TransportListener } from '../src/core/transport';
import { NodePinnedTransport } from './support/node-pinned-transport';
import { FakeGateway } from './support/fake-gateway';
import { waitFor } from './support/wait';
import { resetSecureStore } from './support/stubs/expo-secure-store.stub';

const NOW = Date.now();
const nodeTransport = () => new NodePinnedTransport({ handshakeTimeoutMs: 4_000 });

function pairingPayload(gateway: FakeGateway, code: string): string {
  const payload: PairingPayload = {
    version: 3,
    publicUrl: gateway.endpoint,
    pairingCode: code,
    expiresAt: NOW + 240_000,
    certSha256: gateway.certSha256,
    gatewayId: '0f8fad5b-d9cb-469f-a165-70867728950e',
    gatewayName: 'my-pc',
    endpoints: [gateway.endpoint],
  };
  return encodePairingPayload(payload);
}

function pairCode(letter: string): string {
  const canonical = ['A', 'E', 'I', 'M', 'Q', 'U', 'Y', 'c', 'g', 'k', 'o', 's', 'w', '0', '4', '8'];
  const index = Math.abs(letter.charCodeAt(0) - 'A'.charCodeAt(0)) % canonical.length;
  return 'A'.repeat(42) + (canonical[index] as string);
}

/** The injected browser steps: record the call and refuse with `codes[step]` when one is set. */
function fakePasskey(codes: { register?: string; assert?: string; lock?: string } = {}) {
  const calls: string[] = [];
  const steps = {
    register: async () => {
      calls.push('register');
      if (codes.register !== undefined) throw new CoreError({ code: codes.register, message: codes.register });
      return { ok: true as const };
    },
    assert: async () => {
      calls.push('assert');
      if (codes.assert !== undefined) throw new CoreError({ code: codes.assert, message: codes.assert });
      return { ok: true as const };
    },
    lock: async () => {
      calls.push('lock');
      if (codes.lock !== undefined) throw new CoreError({ code: codes.lock, message: codes.lock });
      return undefined;
    },
  };
  return { calls, steps };
}

describe('web passkey lock (spec 021)', () => {
  it('a locked web socket requests NO session list, and the snapshot carries the lock', async () => {
    resetSecureStore();
    const code = pairCode('L');
    const gateway = await FakeGateway.create({
      pairingCodes: [code],
      deviceScopes: ['sessions:read', 'web:unlock'],
      webLock: 'locked',
    });
    const passkey = fakePasskey();
    const controller = new AppController({
      locale: () => 'en',
      transport: nodeTransport,
      pairAckTimeoutMs: 600,
      passkey: passkey.steps,
    });
    try {
      await controller.start();
      // The one-time pairing socket is `web:unlock` too, so it starts locked; the pairing still
      // succeeds on the accepted client-hello and THAT socket is kept for the passkey frames.
      const paired = await controller.pair(pairingPayload(gateway, code));
      assert.equal(paired.ok, true, JSON.stringify(paired));
      // A020: the credential is read only after the platform gate opens. The Host's passkey lock is a
      // SECOND layer on that socket — opening the gate does not unlock it.
      await controller.unlock();
      await waitFor(() => controller.snapshot().connection === 'ready', { label: 'web socket ready' });

      const lock = controller.snapshot().webLock;
      assert.notEqual(lock, null, 'a web:unlock device reports a lock');
      assert.notEqual(lock?.state, 'unlocked');
      // A locked socket may only use hello/ping and the passkey frames: nothing may be resynced.
      assert.equal(gateway.requestCount('sessions'), 0, 'no session list was requested while locked');
      assert.deepEqual(controller.snapshot().sessions, []);
    } finally {
      controller.stop();
      await gateway.close();
    }
  });

  it('register, then assert clears the lock; "Lock now" calls the lock step and closes the socket', async () => {
    resetSecureStore();
    const code = pairCode('N');
    const gateway = await FakeGateway.create({
      pairingCodes: [code],
      deviceScopes: ['sessions:read', 'web:unlock'],
      webLock: 'locked',
    });
    const passkey = fakePasskey();
    const controller = new AppController({
      locale: () => 'en',
      transport: nodeTransport,
      pairAckTimeoutMs: 600,
      passkey: passkey.steps,
    });
    try {
      await controller.start();
      await controller.pair(pairingPayload(gateway, code));
      await controller.unlock();
      await waitFor(() => controller.snapshot().connection === 'ready', { label: 'web socket ready' });

      await controller.registerWebPasskey();
      assert.deepEqual(passkey.calls, ['register']);
      assert.equal(controller.snapshot().webLock?.error, null);

      // The assertion is the only thing that unlocks (the Host decides; the fake says "accepted").
      await controller.unlockWithPasskey();
      assert.deepEqual(passkey.calls, ['register', 'assert']);
      assert.equal(controller.snapshot().webLock?.state, 'unlocked');

      await controller.lockWebDevice();
      assert.deepEqual(passkey.calls, ['register', 'assert', 'lock']);
      await waitFor(() => controller.snapshot().connection !== 'ready', { label: 'locked socket closed' });
      assert.notEqual(controller.snapshot().webLock?.state, 'unlocked', 'the gate is locked again');
    } finally {
      controller.stop();
      await gateway.close();
    }
  });

  it('a refused assertion keeps the gate locked and names the reason (never a success)', async () => {
    resetSecureStore();
    const code = pairCode('R');
    const gateway = await FakeGateway.create({
      pairingCodes: [code],
      deviceScopes: ['sessions:read', 'web:unlock'],
      webLock: 'locked',
    });
    const passkey = fakePasskey({ assert: 'passkey/verification-failed', register: 'passkey/already-registered' });
    const controller = new AppController({
      locale: () => 'en',
      transport: nodeTransport,
      pairAckTimeoutMs: 600,
      passkey: passkey.steps,
    });
    try {
      await controller.start();
      await controller.pair(pairingPayload(gateway, code));
      await controller.unlock();
      await waitFor(() => controller.snapshot().connection === 'ready', { label: 'web socket ready' });

      await controller.unlockWithPasskey();
      assert.equal(controller.snapshot().webLock?.state, 'locked');
      assert.equal(controller.snapshot().webLock?.error, 'verification-failed');

      await controller.registerWebPasskey();
      assert.equal(controller.snapshot().webLock?.error, 'already-registered');
    } finally {
      controller.stop();
      await gateway.close();
    }
  });

  it('spec 036: an unlocked hello skips the passkey prompt and resyncs', async () => {
    resetSecureStore();
    const code = pairCode('U');
    const gateway = await FakeGateway.create({
      pairingCodes: [code],
      deviceScopes: ['sessions:read', 'web:unlock'],
      webLock: 'unlocked',
    });
    const passkey = fakePasskey();
    const controller = new AppController({
      locale: () => 'en',
      transport: nodeTransport,
      pairAckTimeoutMs: 600,
      passkey: passkey.steps,
    });
    try {
      await controller.start();
      await controller.pair(pairingPayload(gateway, code));
      await controller.unlock();
      await waitFor(() => controller.snapshot().connection === 'ready', { label: 'web socket ready' });
      // Host-authoritative: the grant came in `hello.webLock`, so no WebAuthn ceremony at all.
      assert.deepEqual(passkey.calls, [], 'no passkey register/assert prompt for an unlocked hello');
      assert.equal(controller.snapshot().webLock?.state, 'unlocked');
      // Spec 036: the authoritative unlocked hello must open the platform gate too, or the layout's
      // `mayMirrorUnlocked({unlocked: snapshot.unlocked})` keeps WebBootstrap over the live socket.
      assert.equal(controller.snapshot().unlocked, true);
      assert.equal(controller.snapshot().webLock?.error, null);
      // The gate is open, so the normal resync/history path runs (a locked socket skips it).
      await waitFor(() => gateway.requestCount('sessions') > 0, { label: 'resync after unlocked hello' });
    } finally {
      controller.stop();
      await gateway.close();
    }
  });

  it('spec 036: second hello unlocks the controller and real sessions/history load (no passkey prompt)', async () => {
    resetSecureStore();
    const code = pairCode('S');
    const gateway = await FakeGateway.create({
      pairingCodes: [code],
      deviceScopes: ['sessions:read', 'web:unlock'],
      webLock: 'locked',
    });
    const passkey = fakePasskey();
    // Transport wrapper: after the gateway sees our opt-in client-hello, inject the authoritative
    // second hello (unlocked) synchronously, before the gateway's client-hello ACK arrives.
    const secondHelloSource = () => {
        const inner = new NodePinnedTransport({ handshakeTimeoutMs: 4_000 });
        let firstHello: Record<string, unknown> | null = null;
        const listeners: TransportListener[] = [];
        return {
          connect: (url: string, options: Parameters<NodePinnedTransport['connect']>[1]) => inner.connect(url, options),
          send: (data: string) => {
            const frame = JSON.parse(data) as Record<string, unknown>;
            if (frame.type === 'client-hello' && firstHello?.authenticated === true) {
              const update = JSON.stringify({ ...firstHello, webLock: 'unlocked' });
              for (const listener of listeners) listener({ type: 'message', data: update });
            }
            return inner.send(data);
          },
          close: (c?: number, r?: string) => inner.close(c, r),
          on: (listener: TransportListener) => {
            listeners.push(listener);
            const off = inner.on((event) => {
              if (event.type === 'message') {
                try {
                  const parsed = JSON.parse(event.data) as Record<string, unknown>;
                  if (parsed.kind === 'hello' && firstHello === null) firstHello = parsed;
                } catch { /* non-JSON frames are the client's problem, not this test's */ }
              }
              listener(event);
            });
            return () => {
              const index = listeners.indexOf(listener);
              if (index >= 0) listeners.splice(index, 1);
              off();
            };
          },
        };
    };
    const controller = new AppController({
      locale: () => 'en',
      transport: secondHelloSource,
      pairAckTimeoutMs: 600,
      passkey: passkey.steps,
    });
    try {
      await controller.start();
      await controller.pair(pairingPayload(gateway, code));
      await controller.unlock();
      await waitFor(() => controller.snapshot().connection === 'ready', { label: 'web socket ready' });
      // The gate is opened by the Host's SECOND hello, not by a passkey ceremony.
      assert.deepEqual(passkey.calls, [], 'no passkey prompt');
      assert.equal(controller.snapshot().webLock?.state, 'unlocked');
      assert.equal(controller.snapshot().unlocked, true, 'authoritative unlocked hello opened the gate');
      // Real data path: the sessions list is requested and a session from the fixture can be opened.
      // Wait for the PARSED list, not just the gateway-side request count: under full-suite load the
      // response can still be in flight when the request is counted (pre-existing timing race).
      await waitFor(() => gateway.requestCount('sessions') > 0 && controller.snapshot().sessions.length > 0, { label: 'sessions resync after second hello' });
      const sessionId = controller.snapshot().sessions[0]?.id;
      assert.ok(sessionId, 'the fake gateway supplied a session to open');
      await controller.openSession(sessionId);
      await waitFor(() => controller.snapshot().history.length > 0, { label: 'history loaded after second hello' });
    } finally {
      controller.stop();
      await gateway.close();
    }
  });

  it('spec 036: reload opens the gate from the authoritative hello alone (no unlock()/passkey), and explicit Lock closes it', async () => {
    resetSecureStore();
    const code = pairCode('V');
    const gateway = await FakeGateway.create({
      pairingCodes: [code],
      deviceScopes: ['sessions:read', 'web:unlock'],
      webLock: 'locked',
    });
    const passkey = fakePasskey();
    // First visit: pair so the host + token are in the store, then leave (as a tab switch/reload does).
    const first = new AppController({
      locale: () => 'en', transport: nodeTransport, pairAckTimeoutMs: 600, passkey: passkey.steps,
    });
    try {
      await first.start();
      await first.pair(pairingPayload(gateway, code));
    } finally {
      first.stop();
    }

    // Reload: a fresh controller loads the stored host; the stored 24h grant is only a HINT
    // (`webLocked=true`, `unlocked=false`). There is NO unlock()/passkey on this path — the Host's
    // authoritative second hello must open the gate through applyWebLock (spec 036).
    const secondHelloSource = () => {
      const inner = new NodePinnedTransport({ handshakeTimeoutMs: 4_000 });
      let firstHello: Record<string, unknown> | null = null;
      const listeners: TransportListener[] = [];
      return {
        connect: (url: string, options: Parameters<NodePinnedTransport['connect']>[1]) => inner.connect(url, options),
        send: (data: string) => {
          const frame = JSON.parse(data) as Record<string, unknown>;
          if (frame.type === 'client-hello' && firstHello?.authenticated === true) {
            const update = JSON.stringify({ ...firstHello, webLock: 'unlocked' });
            for (const listener of listeners) listener({ type: 'message', data: update });
          }
          return inner.send(data);
        },
        close: (c?: number, r?: string) => inner.close(c, r),
        on: (listener: TransportListener) => {
          listeners.push(listener);
          const off = inner.on((event) => {
            if (event.type === 'message') {
              try {
                const parsed = JSON.parse(event.data) as Record<string, unknown>;
                if (parsed.kind === 'hello' && firstHello === null) firstHello = parsed;
              } catch { /* non-JSON frames are irrelevant here */ }
            }
            listener(event);
          });
          return () => {
            const index = listeners.indexOf(listener);
            if (index >= 0) listeners.splice(index, 1);
            off();
          };
        },
      };
    };
    const controller = new AppController({
      locale: () => 'en',
      transport: secondHelloSource,
      pairAckTimeoutMs: 600,
      passkey: passkey.steps,
      readWebUnlockGrant: () => Promise.resolve(true),
    });
    try {
      await controller.start();
      assert.equal(controller.snapshot().unlocked, false, 'reload starts behind the gate');
      // The reload path: open a lock-pending socket, NOT the platform unlock gate.
      const opened = await controller.startWebLockSession();
      assert.ok(opened, 'a lock-pending socket was opened from the stored grant hint');
      await waitFor(() => controller.snapshot().connection === 'ready', { label: 'lock-pending socket ready' });
      // The Host's authoritative unlocked hello opened the gate — no passkey, no unlock().
      assert.deepEqual(passkey.calls, [], 'no passkey prompt after reload while the grant is valid');
      assert.equal(controller.snapshot().webLock?.state, 'unlocked');
      assert.equal(controller.snapshot().unlocked, true, 'authoritative unlocked hello opened the gate on reload');
      await waitFor(() => gateway.requestCount('sessions') > 0 && controller.snapshot().sessions.length > 0, { label: 'sessions resync after reload' });
      const sessionId = controller.snapshot().sessions[0]?.id;
      assert.ok(sessionId, 'a session from the fixture was loaded');
      await controller.openSession(sessionId);
      await waitFor(() => controller.snapshot().history.length > 0, { label: 'history loaded after reload' });

      // Explicit Lock still closes the gate (spec 036 device-wide lock).
      await controller.lockWebDevice();
      assert.equal(controller.snapshot().unlocked, false, 'explicit Lock still closes the gate');
      await waitFor(() => controller.snapshot().connection !== 'ready', { label: 'locked socket closed' });
    } finally {
      controller.stop();
      await gateway.close();
    }
  });

  it('spec 036: a failed lock never claims success — the gate stays locked and names the unconfirmed Host', async () => {
    resetSecureStore();
    const code = pairCode('F');
    const gateway = await FakeGateway.create({
      pairingCodes: [code],
      deviceScopes: ['sessions:read', 'web:unlock'],
      webLock: 'unlocked',
    });
    // A timeout/offline refusal: no Host receipt for the 24h grant's Lock.
    const passkey = fakePasskey({ lock: 'client/timeout' });
    const controller = new AppController({
      locale: () => 'en',
      transport: nodeTransport,
      pairAckTimeoutMs: 600,
      passkey: passkey.steps,
    });
    try {
      await controller.start();
      await controller.pair(pairingPayload(gateway, code));
      await controller.unlock();
      await waitFor(() => controller.snapshot().connection === 'ready', { label: 'web socket ready' });
      await controller.lockWebDevice();
      assert.deepEqual(passkey.calls, ['lock'], 'the lock step was attempted');
      await waitFor(() => controller.snapshot().connection !== 'ready', { label: 'socket closed after lock' });
      const lock = controller.snapshot().webLock;
      assert.ok(lock, 'the web lock snapshot survives the offline lock');
      assert.notEqual(lock.state, 'unlocked', 'the gate stays locked');
      // Dedicated spec 036 reason -> `unlock.lockUnconfirmed` in both locales.
      assert.equal(lock.error, 'lock-unconfirmed', 'the unconfirmed Host lock is reported, not swallowed');
    } finally {
      controller.stop();
      await gateway.close();
    }
  });

  it('spec 036: a socket dropped mid-lock is unconfirmed even when the step resolves', async () => {
    resetSecureStore();
    const code = pairCode('D');
    const gateway = await FakeGateway.create({
      pairingCodes: [code],
      deviceScopes: ['sessions:read', 'web:unlock'],
      webLock: 'unlocked',
    });
    // The platform helper swallows `client/disconnected`, so the step RESOLVES on a dead socket.
    const passkey = fakePasskey();
    const controller = new AppController({
      locale: () => 'en', transport: nodeTransport, pairAckTimeoutMs: 600, passkey: passkey.steps,
    });
    try {
      await controller.start();
      await controller.pair(pairingPayload(gateway, code));
      await controller.unlock();
      await waitFor(() => controller.snapshot().connection === 'ready', { label: 'web socket ready' });
      controller.passkeyConnection?.close();
      await controller.lockWebDevice();
      assert.equal(controller.snapshot().webLock?.error, 'lock-unconfirmed', 'a dead socket gave no Host receipt');
    } finally {
      controller.stop();
      await gateway.close();
    }
  });

  it('a native pairing (no web:unlock) never reports a web lock and DOES resync', async () => {
    resetSecureStore();
    const code = pairCode('T');
    const gateway = await FakeGateway.create({ pairingCodes: [code], deviceScopes: ['sessions:read'] });
    const controller = new AppController({
      locale: () => 'en',
      transport: nodeTransport,
      pairAckTimeoutMs: 600,
      passkey: fakePasskey().steps,
    });
    try {
      await controller.start();
      await controller.pair(pairingPayload(gateway, code));
      // The platform gate opening is what connects the bearer socket (A020); the Host's passkey lock
      // is a SEPARATE layer on top of it, which is the distinction this suite is about.
      await controller.unlock();
      await waitFor(() => controller.snapshot().connection === 'ready', { label: 'socket ready' });
      assert.equal(controller.snapshot().webLock, null, 'native is never locked');
      await waitFor(() => gateway.requestCount('sessions') > 0, { label: 'native resync ran' });
    } finally {
      controller.stop();
      await gateway.close();
    }
  });
});
