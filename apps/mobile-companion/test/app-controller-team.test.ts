// AppController.readTeam / readSubagents — the narrow public accessor the UI uses instead of
// reaching for the client object itself.
//
// Why this exists: `app/session/[id].tsx` was reading the client through
// `(controller as unknown as { client?: CompanionClient }).client` to call the team reads. That cast
// defeats the controller's encapsulation (the UI could then call ANY client method) and would break
// silently the day the field is renamed. The controller now exposes exactly two reads.
//
// The documented policy under test:
//   * no usable connection (no client, or not `ready`) => resolves `{ state: 'unavailable' }`,
//     it does NOT throw (a screen must be able to render "nothing yet" without a try/catch);
//   * a protocol/host problem => REJECTS with the CoreError from `src/core/team.ts`, because that is
//     a defect, not an empty result.

import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import { AppController } from '../src/app-state';
import type { CompanionClient } from '../src/core/client';
import { CoreError } from '../src/core/errors';
import { resetAppState } from './support/stubs/react-native.stub';

const SESSION = 'sess-team';

/** Build a controller and (test-only) give it a stand-in client in a chosen state. */
function controllerWith(client: unknown): AppController {
  resetAppState('active');
  const controller = new AppController({ locale: () => 'en' });
  // The field is private on purpose; the TEST is allowed to reach in — the UI is not.
  (controller as unknown as { client: unknown }).client = client;
  return controller;
}

function fakeClient(state: string, reply: unknown): CompanionClient {
  return {
    state,
    // `stop()`/`close()` on the controller drives the client's own teardown; the double needs those
    // so the accessor test never exercises the real socket stack.
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

describe('AppController team reads (the UI accessor)', () => {
  it('with NO client it resolves `unavailable` instead of throwing', async () => {
    resetAppState('active');
    const controller = new AppController({ locale: () => 'en' });
    try {
      assert.deepEqual(await controller.readTeam(SESSION), { state: 'unavailable' });
      assert.deepEqual(await controller.readSubagents(SESSION), { state: 'unavailable' });
    } finally {
      controller.stop();
    }
  });

  it('with a client that is not ready it also resolves `unavailable` (no throw)', async () => {
    const controller = controllerWith(fakeClient('closed', null));
    try {
      assert.deepEqual(await controller.readTeam(SESSION), { state: 'unavailable' });
      assert.deepEqual(await controller.readSubagents(SESSION), { state: 'unavailable' });
    } finally {
      controller.stop();
    }
  });

  it('with a ready client it returns the projection from the core read', async () => {
    const team = { members: [{ id: 'lead' }], tasks: [] as unknown[] };
    const controller = controllerWith(
      fakeClient('ready', { kind: 'agent-team', sessionId: SESSION, projectionState: 'ready', asOfSeq: 9, agentTeam: team }),
    );
    try {
      assert.deepEqual(await controller.readTeam(SESSION), { state: 'ready', asOfSeq: 9, value: team });
    } finally {
      controller.stop();
    }
  });

  it('with a ready client it passes the catalog through unchanged', async () => {
    const catalog = [{ name: 'scout' }];
    const controller = controllerWith(
      fakeClient('ready', { kind: 'subagents', sessionId: SESSION, projectionState: 'ready', subagentCatalog: catalog }),
    );
    try {
      assert.deepEqual(await controller.readSubagents(SESSION), { state: 'ready', value: catalog });
    } finally {
      controller.stop();
    }
  });

  it('keeps `migration-required` distinct from `unavailable` through the accessor', async () => {
    const controller = controllerWith(
      fakeClient('ready', { kind: 'agent-team', sessionId: SESSION, projectionState: 'migration-required', agentTeam: null }),
    );
    try {
      const result = await controller.readTeam(SESSION);
      assert.equal(result.state, 'migration-required');
    } finally {
      controller.stop();
    }
  });

  it('a protocol problem still REJECTS (it is a defect, not an empty team)', async () => {
    const controller = controllerWith(
      fakeClient('ready', { kind: 'agent-team', sessionId: 'other-session', projectionState: 'ready', agentTeam: { members: [], tasks: [] } }),
    );
    try {
      await assert.rejects(controller.readTeam(SESSION), (error: unknown) => {
        assert.ok(error instanceof CoreError);
        assert.equal((error as CoreError).code, 'client/bad-message');
        return true;
      });
    } finally {
      controller.stop();
    }
  });

  it('a Host error frame surfaces its own code through the accessor', async () => {
    const controller = controllerWith(
      fakeClient('ready', { kind: 'error', code: 'session/not-found', message: 'session not found', requestType: 'subagents' }),
    );
    try {
      await assert.rejects(controller.readSubagents(SESSION), (error: unknown) => {
        assert.equal((error as CoreError).code, 'session/not-found');
        return true;
      });
    } finally {
      controller.stop();
    }
  });

  it('the reads are public methods and need no cast from a screen (encapsulation is a TYPES matter)', () => {
    resetAppState('active');
    const controller = new AppController({ locale: () => 'en' });
    try {
      // `private client` is compile-time only, so it exists at runtime either way. What the screen
      // needed was a TYPED way in; asserting on the runtime property would test the language, not us.
      // What matters: the two reads are on the public surface, and a caller holding the controller
      // as `AppController` can call them with no cast (this file is typechecked by `npm run typecheck`,
      // so the calls below failing to compile IS the assertion).
      const reads: [Promise<unknown>, Promise<unknown>] = [
        controller.readTeam(SESSION),
        controller.readSubagents(SESSION),
      ];
      assert.equal(reads.length, 2);
      assert.equal(typeof controller.readTeam, 'function');
      assert.equal(typeof controller.readSubagents, 'function');
    } finally {
      controller.stop();
    }
  });
});
