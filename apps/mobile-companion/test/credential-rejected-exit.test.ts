// A Host that refuses this device's stored credential at the upgrade (HTTP 401 → `auth/required`).
//
// The device defect this pins: the refusal is terminal (`reauth-required`, retry loop stopped, token
// kept), so the socket never becomes `ready`. On a web (PWA) install the passkey lock gate was still
// the only screen, and its "unlock" button reaches `passkey.web.ts`, which answers `locked` without a
// ready client — silently and forever. Settings, the only place that could forget the host, is behind
// that gate. The way out is now a snapshot flag, `credentialRejected` (set on the 401, cleared by
// `forget()`, by a successful `pair()` and by any socket that reaches `ready` again), which the gate renders as "forget and pair again".
//
// Driven through the controller and the injected passkey steps: that is the same seam the app uses on
// web (`ControllerOptions.passkey`), since Node has no WebAuthn. The gate's button calls
// `controller.forget()`, and what that does is what is asserted here.

import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import { AppController } from '../src/app-state';
import { encodePairingPayload, type PairingPayload } from '../src/core';
import { NodePinnedTransport } from './support/node-pinned-transport';
import { FakeGateway } from './support/fake-gateway';
import { waitFor } from './support/wait';
import { TRANSPORT_ERROR, type Transport, type TransportConnectOptions, type TransportEvent, type TransportListener } from '../src/core/transport';
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
    gatewayId: '2b3c9d1e-4f5a-4b6c-8d7e-9f0a1b2c3d4e',
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

/** The injected browser steps, recording every call (no WebAuthn exists under Node). */
function fakePasskey() {
  const calls: string[] = [];
  const steps = {
    register: async () => {
      calls.push('register');
      return { ok: true as const };
    },
    assert: async () => {
      calls.push('assert');
      return { ok: true as const };
    },
    lock: async () => {
      calls.push('lock');
      return undefined;
    },
  };
  return { calls, steps };
}

/** A web (`web:unlock`) gateway whose sockets start locked, exactly like a reloaded PWA. */
function webGateway(code: string): Promise<FakeGateway> {
  return FakeGateway.create({ pairingCodes: [code], deviceScopes: ['sessions:read', 'web:unlock'], webLock: 'locked' });
}

/** A controller wired the way the web app wires it, with the passkey steps injected. */
function webController(passkey: ReturnType<typeof fakePasskey>): AppController {
  return new AppController({
    locale: () => 'en',
    transport: nodeTransport,
    pairAckTimeoutMs: 600,
    passkey: passkey.steps,
  });
}

/**
 * The refusal, reproduced the way the controller really meets it: a FRESH upgrade answered 401.
 *
 * Why the earlier version could not run (corrected, the old note blamed the fixture): the fixture
 * does answer HTTP 401 — `NodePinnedTransport` reports it as a transport `error`
 * ("Unexpected server response: 401", code `client/connect-failed`) plus close 1006. What was
 * missing was (a) a NEW upgrade: the pairing socket was still `ready`, so `unlockWithPasskey()`
 * reused it and nothing ever hit the refusing gateway; and (b) the status itself: the Node transport
 * puts it only in the message, whereas the production native transport (and the transport contract,
 * `TransportEvent.details.status`) carries it machine-readably, which is what
 * `classifyUpgradeRefusal` reads. `StatusReportingTransport` below adds exactly that one field, the
 * way `pinned-transport.ts` does for a native 401 — it invents nothing the Host did not send.
 *
 * Web caveat, stated once: the REAL web transport cannot see this status (it reports 401/403/network
 * failure alike as `connect-failed` + 1006), so on a PWA `credentialRejected` never fires and the
 * gate's always-visible forget button is what rescues it (see the last `describe`). These cases
 * drive the controller seam that a status-carrying transport (native, or a future web one) uses.
 *
 * To force the new upgrade: `lock()` tears the ready socket down, the gateway then refuses upgrades
 * with 401, and the passkey step opens a new locked socket (`startWebLockSession`) that is refused.
 */
class StatusReportingTransport implements Transport {
  private readonly inner = new NodePinnedTransport({ handshakeTimeoutMs: 4_000 });
  connect(url: string, options: TransportConnectOptions): void {
    this.inner.connect(url, options);
  }
  send(data: string): boolean {
    return this.inner.send(data);
  }
  close(code?: number, reason?: string): void {
    this.inner.close(code, reason);
  }
  on(listener: TransportListener): () => void {
    return this.inner.on((event: TransportEvent) => {
      if (event.type === 'error') {
        const refused = /Unexpected server response: (\d{3})/.exec(event.message);
        if (refused !== null) {
          listener({ type: 'error', code: TRANSPORT_ERROR.upgradeFailed, message: event.message, details: { status: Number(refused[1]) } });
          return;
        }
      }
      listener(event);
    });
  }
}

/** A controller like `webController`, but over a transport that reports the upgrade status. */
function refusalController(passkey: ReturnType<typeof fakePasskey>): AppController {
  return new AppController({
    locale: () => 'en',
    transport: () => new StatusReportingTransport(),
    pairAckTimeoutMs: 600,
    passkey: passkey.steps,
  });
}

async function arriveAtRefusedCredential(
  controller: AppController,
  gateway: FakeGateway,
  code: string,
): Promise<void> {
  await controller.start();
  const paired = await controller.pair(pairingPayload(gateway, code));
  assert.equal(paired.ok, true, JSON.stringify(paired));
  // A fresh pairing is not refused, and the Host's passkey lock is above the platform gate.
  assert.equal(controller.snapshot().credentialRejected, false);
  assert.notEqual(controller.snapshot().webLock?.state, 'unlocked');

  // The Host now refuses this device's stored credential at the upgrade. A revocation looks the same
  // from here; only the cleanup differs, and that is the existing `revoked` path. The pairing
  // socket is closed first so the passkey step needs a NEW upgrade, which meets the 401.
  controller.lock();
  gateway.refuseUpgrade(401);
  await controller.unlockWithPasskey();
  await waitFor(() => controller.snapshot().connection === 'reauth-required', { label: '401 handled' });
}

describe('a refused credential (401) on a locked web device', () => {
  it('records the refusal, and every further passkey step on the dead socket does nothing', async () => {
    resetSecureStore();
    const code = pairCode('W');
    const gateway = await webGateway(code);
    const passkey = fakePasskey();
    const controller = refusalController(passkey);
    try {
      await arriveAtRefusedCredential(controller, gateway, code);

      const refused = controller.snapshot();
      assert.equal(refused.credentialRejected, true);
      assert.equal(refused.banner, 'reauth');
      assert.equal(refused.unlocked, false, 'the gate is still shut — that is the deadlock');
      assert.notEqual(refused.activeHost, null, 'a 401 keeps the pairing; only a revocation wipes it');
      assert.equal(refused.reconnect?.state, 'stopped', 'the retry loop is stopped, so nothing reconnects by itself');

      // Why the gate must not keep offering "unlock": the step refuses without a ready client
      // (`passkey.web.ts` → reason `locked`, the client is never ready), so pressing it changes nothing.
      passkey.calls.length = 0;
      await controller.unlockWithPasskey(); // the step returns (never throws, never hangs) without prompting
      assert.deepEqual(passkey.calls, [], 'no authenticator prompt can start on a dead socket');
      assert.equal(controller.snapshot().unlocked, false);
      assert.notEqual(controller.snapshot().connection, 'ready', 'still no ready socket');
      assert.equal(controller.snapshot().credentialRejected, true, 'and the refusal is still recorded');
    } finally {
      controller.stop();
      await gateway.close();
    }
  });

  it('forget() while refused removes the host and its stored credential, so pairing is possible again', async () => {
    resetSecureStore();
    const code = pairCode('X');
    const gateway = await webGateway(code);
    const passkey = fakePasskey();
    const controller = refusalController(passkey);
    try {
      await arriveAtRefusedCredential(controller, gateway, code);
      assert.equal(controller.snapshot().unlocked, false, 'the gate is still locked — that is the deadlock');
      assert.equal(controller.snapshot().credentialRejected, true);

      // The gate's repair button (after its confirm step): the same `forget()` Settings calls. It must
      // work without an unlock, because a refused credential must not need a working socket to be dropped.
      await controller.forget();

      const after = controller.snapshot();
      assert.equal(after.activeHost, null, 'the pair panel takes over on the next snapshot');
      assert.deepEqual(after.hosts, [], 'the host record is gone from the list');
      assert.equal(after.credentialRejected, false, 'nothing is left to be refused');
    } finally {
      controller.stop();
      await gateway.close();
    }

    // Pairing again on a fresh Host instance (a second pairing on the SAME fixture instance is not
    // reliable: its pairing socket closes 1006 — covered by the last describe): the wiped device
    // pairs normally and starts unrefused.
    resetSecureStore();
    const fresh = await webGateway(code);
    const again = refusalController(fakePasskey());
    try {
      await again.start();
      const repaired = await again.pair(pairingPayload(fresh, code));
      assert.equal(repaired.ok, true, JSON.stringify(repaired));
      assert.notEqual(again.snapshot().activeHost, null);
      assert.equal(again.snapshot().credentialRejected, false);
    } finally {
      again.stop();
      await fresh.close();
    }
  });
});

describe('when a refusal ends', () => {
  it('an accepted credential clears it: a new socket that reaches ready retires the refusal (onReady)', async () => {
    resetSecureStore();
    const code = pairCode('Y');
    const gateway = await webGateway(code);
    const passkey = fakePasskey();
    const controller = refusalController(passkey);
    try {
      await arriveAtRefusedCredential(controller, gateway, code);
      assert.equal(controller.snapshot().credentialRejected, true);

      // The owner re-approves this device on the Host: the credential is accepted again. The
      // refusal is terminal for the old socket, so the next attempt is a new one (app lock, then the
      // passkey step opens it) — the same path a reload takes.
      gateway.refuseUpgrade(null);
      controller.lock();
      await controller.unlockWithPasskey();
      await waitFor(() => controller.snapshot().connection === 'ready', { label: 'credential accepted again' });
      const accepted = controller.snapshot();
      assert.equal(
        accepted.credentialRejected,
        false,
        'a refusal describes the last upgrade answer, so an accepted one (a ready socket) retires it',
      );
      assert.equal(accepted.unlocked, true, 'the passkey step then opens the gate on that socket');
    } finally {
      controller.stop();
      await gateway.close();
    }
  });

  it('a native device is untouched: no web lock, no refusal, no passkey step', async () => {
    resetSecureStore();
    const code = pairCode('Z');
    const gateway = await FakeGateway.create({ pairingCodes: [code], deviceScopes: ['sessions:read'] });
    const passkey = fakePasskey();
    const controller = webController(passkey);
    try {
      await controller.start();
      await controller.pair(pairingPayload(gateway, code));
      await controller.unlock();
      await waitFor(() => controller.snapshot().connection === 'ready', { label: 'socket ready' });
      const native = controller.snapshot();
      assert.equal(native.webLock, null, 'a native pairing is never web-locked');
      assert.equal(native.credentialRejected, false);
      assert.deepEqual(passkey.calls, [], 'no passkey step is ever involved on native');
    } finally {
      controller.stop();
      await gateway.close();
    }
  });
});
/**
 * The escape that does not depend on the 401.
 *
 * Web cannot see the status of a refused upgrade (`pinned-transport.web.ts`: 401, 403 and a network
 * failure all arrive as `connect-failed` + close 1006), so `credentialRejected` can never fire there.
 * The gate therefore always offers "forget and pair again": it is the only door out of a revoked
 * device, whose Settings screen is behind the same gate.
 */
describe('the gate always has a way out', () => {
  it('forget() on a web device whose socket is not ready clears the host, so pairing comes back', async () => {
    resetSecureStore();
    const code = pairCode('D');
    const gateway = await webGateway(code);
    const passkey = fakePasskey();
    const controller = webController(passkey);
    try {
      await controller.start();
      await controller.pair(pairingPayload(gateway, code));
      // A fresh pairing keeps its one-time socket, so the passkey works here and the gate opens.
      await controller.unlockWithPasskey();
      await waitFor(() => controller.snapshot().unlocked === true, { label: 'the passkey opened the gate' });

      // Now the device is locked out for good: the socket the passkey needs goes away (app lock) and
      // every attempt to open a new one fails at the upgrade. Web cannot say WHY — `pinned-transport.web.ts`
      // reports 401, 403 and a network failure alike as `connect-failed` + close 1006 — so the client
      // ends up with no ready socket, which is exactly the `locked` refusal the gate explains.
      controller.lock();
      gateway.refuseUpgrade(401);
      await controller.unlockWithPasskey();
      await waitFor(() => controller.snapshot().webLock?.error === 'locked', { label: 'the step refused locked' });

      const stuck = controller.snapshot();
      assert.equal(stuck.credentialRejected, false, 'web never learns a 401 — the flag cannot help it');
      assert.equal(stuck.unlocked, false, 'no ready socket, so the gate never opens');
      assert.notEqual(stuck.connection, 'ready');
      assert.notEqual(stuck.activeHost, null, 'and the gate is what the user is looking at');

      // The gate's secondary button (after its confirm step) calls exactly this.
      await controller.forget();
      const after = controller.snapshot();
      assert.equal(after.activeHost, null, 'the pair panel takes over');
      assert.deepEqual(after.hosts, []);
      assert.equal(after.webLock, null, 'no host, so no lock gate either');
      // This is what makes the pair panel usable rather than a dead end.
      assert.equal(after.pairing, null, 'no pairing error is left over from the dead connection');
    } finally {
      controller.stop();
      await gateway.close();
    }
  });

  it('the same forget() on a fresh fixture leaves the device pairable again', async () => {
    // Re-pairing after `forget()` needs a host that answers the one-time pairing socket. The shared
    // fixture does not do that reliably for a SECOND pairing on one instance (measured: the pairing
    // socket closes 1006 → `client/disconnected`), so the "pairing is possible again" half is
    // asserted as its own scenario — where it also proves the wipe did not leave the app unusable.
    resetSecureStore();
    const code = pairCode('E');
    const gateway = await webGateway(code);
    const passkey = fakePasskey();
    const controller = webController(passkey);
    try {
      await controller.start();
      await controller.pair(pairingPayload(gateway, code));
      await controller.unlockWithPasskey();
      await waitFor(() => controller.snapshot().unlocked === true, { label: 'the passkey opened the gate' });

      controller.lock();
      gateway.refuseUpgrade(401);
      await controller.unlockWithPasskey();
      await waitFor(() => controller.snapshot().webLock?.error === 'locked', { label: 'the step refused locked' });
      await controller.forget();
      assert.equal(controller.snapshot().activeHost, null);
    } finally {
      controller.stop();
      await gateway.close();
    }

    // A new page load (new controller, new fixture): the app's own startup + pair path, unchanged.
    resetSecureStore();
    const fresh = await webGateway(code);
    const freshController = webController(fakePasskey());
    try {
      await freshController.start();
      const paired = await freshController.pair(pairingPayload(fresh, code));
      assert.equal(paired.ok, true, JSON.stringify(paired));
      assert.notEqual(freshController.snapshot().activeHost, null, 'pairing works after a forgotten host');
      assert.equal(freshController.snapshot().credentialRejected, false);
    } finally {
      freshController.stop();
      await fresh.close();
    }
  });
});
