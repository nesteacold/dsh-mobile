// Spec 018 — AppController.readSessionStats / readScheduleCatalog / readSchedules / readSchedule
// and the `hasReadScope` gate behind them.
//
// The documented policy, the same one `test/app-controller-team.test.ts` pins for the team reads:
//   * no usable connection, or a device NOT paired with the never-default read scope (`stats:read` /
//     `schedule:read`) ⇒ resolves `{ state: 'unavailable' }`, it does NOT throw (the gateway would
//     refuse the frame before the Host is called, and a screen must render that as "not available");
//   * a protocol/host problem ⇒ REJECTS with the CoreError from `src/core`, because that is a defect.
//
// `hasReadScope` is the SAME question the screens ask before drawing a control; an absent scope list
// grants nothing (fail closed), so an older pairing hides the surface instead of promising a read.

import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import { AppController } from '../src/app-state';
import type { CompanionClient } from '../src/core/client';
import { CoreError } from '../src/core/errors';
import { resetAppState } from './support/stubs/react-native.stub';

const SESSION = 'sess-stats';

function controllerWith(client: unknown): AppController {
  resetAppState('active');
  const controller = new AppController({ locale: () => 'en' });
  // The field is private on purpose; the TEST is allowed to reach in — the UI is not.
  (controller as unknown as { client: unknown }).client = client;
  return controller;
}

/** A ready double with the given granted scopes (absent when `scopes === undefined`). */
function fakeClient(state: string, reply: unknown, scopes?: string[]): CompanionClient {
  return {
    state,
    device: { id: 'dev-1', name: 'phone', ...(scopes === undefined ? {} : { scopes }) },
    close: () => {},
    stop: () => {},
    on: () => {},
    off: () => {},
    request: async () => {
      if (reply instanceof Error) throw reply;
      return reply as Record<string, unknown>;
    },
  } as unknown as CompanionClient;
}

const STATS_REPLY = {
  kind: 'session-stats',
  sessionId: SESSION,
  asOfSeq: 7,
  sessionStats: { turns: 2 },
  tokenUsage: null,
  contextPressure: null,
};

describe('AppController.hasReadScope (the gate the screens draw with)', () => {
  it('with NO client it grants nothing', () => {
    resetAppState('active');
    const controller = new AppController({ locale: () => 'en' });
    try {
      assert.equal(controller.hasReadScope('stats:read'), false);
      assert.equal(controller.hasReadScope('schedule:read'), false);
    } finally {
      controller.stop();
    }
  });

  it('grants each scope only when the device record names it', () => {
    const controller = controllerWith(fakeClient('ready', STATS_REPLY, ['sessions:read', 'stats:read']));
    try {
      assert.equal(controller.hasReadScope('stats:read'), true);
      assert.equal(controller.hasReadScope('schedule:read'), false, 'one never-default scope never implies the other');
    } finally {
      controller.stop();
    }
  });

  it('fails closed when the Host reported no scope list at all', () => {
    const controller = controllerWith(fakeClient('ready', STATS_REPLY, undefined));
    try {
      assert.equal(controller.hasReadScope('stats:read'), false);
      assert.equal(controller.hasReadScope('schedule:read'), false);
    } finally {
      controller.stop();
    }
  });
});

describe('AppController.readSessionStats', () => {
  it('with no client resolves `unavailable` instead of throwing', async () => {
    resetAppState('active');
    const controller = new AppController({ locale: () => 'en' });
    try {
      assert.deepEqual(await controller.readSessionStats(SESSION), { state: 'unavailable' });
    } finally {
      controller.stop();
    }
  });

  it('with a client that is not ready it also resolves `unavailable`', async () => {
    const controller = controllerWith(fakeClient('closed', STATS_REPLY, ['stats:read']));
    try {
      assert.deepEqual(await controller.readSessionStats(SESSION), { state: 'unavailable' });
    } finally {
      controller.stop();
    }
  });

  it('with a ready client but NO stats:read it never sends the frame', async () => {
    let asked = 0;
    const client = fakeClient('ready', STATS_REPLY, ['sessions:read']);
    (client as unknown as { request: () => Promise<unknown> }).request = async () => {
      asked += 1;
      return STATS_REPLY;
    };
    const controller = controllerWith(client);
    try {
      assert.deepEqual(await controller.readSessionStats(SESSION), { state: 'unavailable' });
      assert.equal(asked, 0, 'a read the gateway would refuse is never offered');
    } finally {
      controller.stop();
    }
  });

  it('with a ready client and stats:read it returns the parsed projection', async () => {
    const controller = controllerWith(fakeClient('ready', STATS_REPLY, ['stats:read']));
    try {
      const read = await controller.readSessionStats(SESSION);
      assert.equal(read.state, 'ready');
      if (read.state === 'ready') {
        assert.equal(read.asOfSeq, 7);
        assert.equal(read.sessionStats?.turns, 2);
        assert.equal(read.sessionStats?.steps, null);
      }
    } finally {
      controller.stop();
    }
  });

  it('a Host refusal still REJECTS with its own code', async () => {
    const controller = controllerWith(
      fakeClient('ready', { kind: 'error', code: 'session-not-found', requestType: 'session-stats', message: 'x' }, ['stats:read']),
    );
    try {
      await assert.rejects(controller.readSessionStats(SESSION), (error: unknown) => {
        assert.ok(error instanceof CoreError);
        assert.equal((error as CoreError).code, 'session-not-found');
        return true;
      });
    } finally {
      controller.stop();
    }
  });
});

describe('AppController schedule reads', () => {
  it('with no client each one resolves `unavailable`', async () => {
    resetAppState('active');
    const controller = new AppController({ locale: () => 'en' });
    try {
      assert.deepEqual(await controller.readScheduleCatalog(), { state: 'unavailable' });
      assert.deepEqual(await controller.readSchedules(), { state: 'unavailable' });
      assert.deepEqual(await controller.readSchedule('task-1'), { state: 'unavailable' });
    } finally {
      controller.stop();
    }
  });

  it('without schedule:read it never sends a schedule frame', async () => {
    let asked = 0;
    const client = fakeClient('ready', { kind: 'schedule-list', items: [] }, ['sessions:read', 'stats:read']);
    (client as unknown as { request: () => Promise<unknown> }).request = async () => {
      asked += 1;
      return { kind: 'schedule-list', items: [] };
    };
    const controller = controllerWith(client);
    try {
      assert.deepEqual(await controller.readScheduleCatalog(), { state: 'unavailable' });
      assert.deepEqual(await controller.readSchedules(), { state: 'unavailable' });
      assert.deepEqual(await controller.readSchedule('task-1'), { state: 'unavailable' });
      assert.equal(asked, 0);
    } finally {
      controller.stop();
    }
  });

  it('with schedule:read it returns the list, the catalog and one task', async () => {
    const listReply = { kind: 'schedule-list', items: [{ id: 'task-1', kind: 'daily', title: 'nightly' }], total: 1 };
    const controller = controllerWith(fakeClient('ready', listReply, ['schedule:read']));
    try {
      const list = await controller.readSchedules();
      assert.equal(list.state, 'ready');
      if (list.state === 'ready') assert.deepEqual(list.items.map((task) => task.id), ['task-1']);
    } finally {
      controller.stop();
    }

    const catalogController = controllerWith(fakeClient('ready', { kind: 'schedule-catalog', items: [{ kind: 'daily' }] }, ['schedule:read']));
    try {
      const catalog = await catalogController.readScheduleCatalog();
      assert.equal(catalog.state, 'ready');
    } finally {
      catalogController.stop();
    }

    const viewController = controllerWith(fakeClient('ready', { kind: 'schedule-view', id: 'task-1', title: 'nightly' }, ['schedule:read']));
    try {
      const view = await viewController.readSchedule('task-1');
      assert.equal(view.state, 'ready');
    } finally {
      viewController.stop();
    }
  });

  it('a scope refusal REJECTS with the Host code instead of a quiet empty list', async () => {
    const controller = controllerWith(
      fakeClient('ready', { kind: 'error', code: 'auth/forbidden-scope', scope: 'schedule:read', requestType: 'schedule-list', message: 'x' }, ['schedule:read']),
    );
    try {
      await assert.rejects(controller.readSchedules(), (error: unknown) => {
        assert.equal((error as CoreError).code, 'auth/forbidden-scope');
        return true;
      });
    } finally {
      controller.stop();
    }
  });
});
