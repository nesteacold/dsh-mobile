// Spec 018 item 5 — the controller's per-session store for the goal / task-list projections.
//
// The gateway pushes these as ordinary server frames (`projection-baseline`, `tasks-updated`,
// `goal-updated`) with no `requestId` (PROTOCOL.md:1197-1201), and it sends the baseline ONCE, right
// after `hello` (`plugins/mobile-gateway/lib/index.mjs:6073`) — before any session can be opened.
// This exercises the whole path — real socket, real fixture, real client — so the routing
// (`src/core/client.ts`) and the store (`src/app-state.ts`) are pinned together:
//   * the baseline is folded for EVERY session it names, and opening one seeds the panel from it;
//   * an update for a session that is not open is kept, and shown when that session opens;
//   * an update folded into a cache that already has a baseline is compared against IT;
//   * an older `asOfSeq` never overwrites a newer value, per key;
//   * closing the session empties the panel, so the next one never inherits it.

import assert from 'node:assert/strict';
import { afterEach, beforeEach, describe, it } from 'node:test';

import { AppController } from '../src/app-state';
import { encodePairingPayload, type PairingPayload } from '../src/core';
import { toSessionPanelView } from '../src/ui/read-only-views';
import { resetAppState } from './support/stubs/react-native.stub';
import { resetLocalAuthentication } from './support/stubs/expo-local-authentication.stub';
import { resetNotifications } from './support/stubs/expo-notifications.stub';
import { resetSecureStore } from './support/stubs/expo-secure-store.stub';
import { FakeGateway } from './support/fake-gateway';
import { NodePinnedTransport } from './support/node-pinned-transport';
import { waitFor } from './support/wait';

const NOW = Date.now();
const SESSION = 's-running';
const OTHER = 's-idle';

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

describe('AppController goal / task-list projections', () => {
  let gateway: FakeGateway;
  let controller: AppController;
  const CODE = 'A'.repeat(42) + 'A';

  beforeEach(async () => {
    resetSecureStore();
    resetAppState('active');
    resetLocalAuthentication();
    resetNotifications(true);
    gateway = await FakeGateway.create({ deviceScopes: ['sessions:read'] });
    gateway.addPairingCode(CODE);
    controller = new AppController({ locale: () => 'en', transport: nodeTransport });
    await controller.start();
    const result = await controller.pair(pairingPayload(gateway, CODE));
    assert.equal(result.ok, true, JSON.stringify(result));
    await controller.unlock();
    await waitFor(() => controller.snapshot().connection === 'ready', { label: 'ready' });
    await waitFor(() => controller.snapshot().sessions.length >= 3, { label: 'sessions listed' });
  });

  afterEach(async () => {
    controller.stop();
    await gateway.close();
  });

  it('starts empty: no projection has arrived for any session yet', () => {
    const panel = controller.snapshot().openSessionPanel;
    assert.equal(panel.goal, null);
    assert.equal(panel.todos, null);
    assert.deepEqual(toSessionPanelView(panel), {
      goal: null,
      goalPhase: null,
      tasks: [],
      tasksDone: 0,
      tasksTotal: 0,
      tasksHidden: 0,
    });
  });

  it('keeps the baseline of a session that is not open yet, and seeds the panel when it opens', async () => {
    // The Host's one baseline arrives while no session is open (that is when the gateway sends it).
    assert.equal(controller.snapshot().openSessionId, null);
    gateway.pushProjection({
      kind: 'projection-baseline',
      projections: {
        [SESSION]: {
          asOfSeq: 40,
          values: {
            todos: [
              { content: 'Check the Android SDK', status: 'completed' },
              { content: 'Create the project', status: 'in_progress' },
            ],
            goal: { goal: { id: 'goal-1', revision: 7, objective: 'Initialise an Android app', phase: 'active' } },
          },
        },
      },
    });
    // Let the frame land (nothing to observe on screen while nothing is open).
    await new Promise((resolve) => setTimeout(resolve, 50));

    controller.openSession(SESSION);
    const view = toSessionPanelView(controller.snapshot().openSessionPanel);
    assert.equal(view.goal, 'Initialise an Android app', 'the baseline is not dropped for a not-yet-open session');
    assert.equal(view.goalPhase, 'active');
    assert.deepEqual(view.tasks.map((task) => [task.text, task.status]), [
      ['Check the Android SDK', 'completed'],
      ['Create the project', 'in_progress'],
    ]);

    // Negative control: a session the baseline never named still starts empty.
    controller.openSession(OTHER);
    const other = toSessionPanelView(controller.snapshot().openSessionPanel);
    assert.equal(other.goal, null);
    assert.deepEqual(other.tasks, []);
  });

  it('keeps an update for a session that is not open, and shows it when that session opens', async () => {
    gateway.pushProjection({ kind: 'tasks-updated', sessionId: OTHER, asOfSeq: 12, todos: [{ content: 'other session task', status: 'pending' }] });
    await new Promise((resolve) => setTimeout(resolve, 50));
    // Nothing is open, so the frame reached the controller and changed no drawn panel.
    assert.equal(controller.snapshot().openSessionPanel.todos, null);

    controller.openSession(OTHER);
    assert.deepEqual(controller.snapshot().openSessionPanel.todos?.map((todo) => todo.text), ['other session task']);

    // And a later update for that session is compared against the kept copy: seq 11 is older.
    controller.openSession(SESSION);
    gateway.pushProjection({ kind: 'tasks-updated', sessionId: OTHER, asOfSeq: 11, todos: [{ content: 'stale', status: 'pending' }] });
    await new Promise((resolve) => setTimeout(resolve, 50));
    controller.openSession(OTHER);
    assert.deepEqual(
      controller.snapshot().openSessionPanel.todos?.map((todo) => todo.text),
      ['other session task'],
      'a stale frame for a closed session is still refused',
    );
  });

  it('compares an update against the kept baseline of a session that is not open', async () => {
    gateway.pushProjection({
      kind: 'projection-baseline',
      projections: { [SESSION]: { asOfSeq: 30, values: { todos: [{ content: 'from baseline', status: 'pending' }] } } },
    });
    // The baseline must have landed first, or the store has no cut point to compare against.
    await new Promise((resolve) => setTimeout(resolve, 50));
    gateway.pushProjection({ kind: 'tasks-updated', sessionId: SESSION, asOfSeq: 29, todos: [{ content: 'stale', status: 'pending' }] });
    await new Promise((resolve) => setTimeout(resolve, 50));
    controller.openSession(SESSION);
    assert.deepEqual(
      controller.snapshot().openSessionPanel.todos?.map((todo) => todo.text),
      ['from baseline'],
      'the baseline cut point still outranks the older update',
    );
  });

  it('takes this session out of a projection-baseline that names several sessions', () => {
    controller.openSession(SESSION);
    gateway.pushProjection({
      kind: 'projection-baseline',
      projections: {
        [SESSION]: {
          asOfSeq: 40,
          values: {
            todos: [
              { content: 'Check the Android SDK', status: 'completed' },
              { content: 'Create the project', status: 'in_progress' },
              { content: 'Build the APK', status: 'pending' },
            ],
            goal: { goal: { id: 'goal-1', revision: 7, objective: 'Initialise an Android app', phase: 'active' } },
            turnOutline: null,
            agentTeam: null,
          },
        },
        [OTHER]: { asOfSeq: 41, values: { todos: [{ content: 'other session task', status: 'pending' }] } },
      },
    });
    return waitFor(() => controller.snapshot().openSessionPanel.goal !== null, { label: 'baseline applied' }).then(() => {
      const view = toSessionPanelView(controller.snapshot().openSessionPanel);
      assert.equal(view.goal, 'Initialise an Android app');
      assert.equal(view.goalPhase, 'active');
      assert.deepEqual(view.tasks.map((task) => [task.text, task.status]), [
        ['Check the Android SDK', 'completed'],
        ['Create the project', 'in_progress'],
        ['Build the APK', 'pending'],
      ]);
      assert.equal(view.tasksDone, 1);
      assert.equal(view.tasksTotal, 3, 'the other session\'s task never leaks into this one');
    });
  });

  it('applies live tasks-updated / goal-updated frames, and ignores older cut points', async () => {
    controller.openSession(SESSION);
    gateway.pushProjection({
      kind: 'tasks-updated',
      sessionId: SESSION,
      asOfSeq: 43,
      todos: [{ content: 'Run the gates', status: 'pending' }],
    });
    gateway.pushProjection({
      kind: 'goal-updated',
      sessionId: SESSION,
      asOfSeq: 44,
      goal: { goal: { id: 'goal-1', revision: 8, objective: 'Land spec 018 item 5', phase: 'active' } },
    });
    await waitFor(() => controller.snapshot().openSessionPanel.goal?.objective === 'Land spec 018 item 5', {
      label: 'goal update applied',
    });
    assert.deepEqual(controller.snapshot().openSessionPanel.todos?.map((todo) => todo.text), ['Run the gates']);

    // A stale task frame (seq below the one already held) and a frame for another session change nothing.
    gateway.pushProjection({ kind: 'tasks-updated', sessionId: SESSION, asOfSeq: 42, todos: [{ content: 'stale', status: 'pending' }] });
    gateway.pushProjection({ kind: 'tasks-updated', sessionId: OTHER, asOfSeq: 99, todos: [{ content: 'other', status: 'pending' }] });
    await new Promise((resolve) => setTimeout(resolve, 50));
    assert.deepEqual(controller.snapshot().openSessionPanel.todos?.map((todo) => todo.text), ['Run the gates']);
    // The other session's frame was kept anyway (not dropped for not being open)…
    controller.openSession(OTHER);
    assert.deepEqual(controller.snapshot().openSessionPanel.todos?.map((todo) => todo.text), ['other']);
    controller.openSession(SESSION);
    // …but reopening the first session shows its own list, not the one just drawn.
    assert.deepEqual(controller.snapshot().openSessionPanel.todos?.map((todo) => todo.text), ['Run the gates']);

    // A null goal is the Host saying the goal went away.
    gateway.pushProjection({ kind: 'goal-updated', sessionId: SESSION, asOfSeq: 45, goal: null });
    await waitFor(() => controller.snapshot().openSessionPanel.goal === null, { label: 'goal cleared' });
  });

  it('draws nothing for a session the baseline did not name, then its own late baseline', async () => {
    gateway.pushProjection({
      kind: 'projection-baseline',
      projections: { [OTHER]: { asOfSeq: 10, values: { todos: [{ content: 'other session task', status: 'pending' }] } } },
    });
    // The frame travels on a real socket: let it land before reading what the store holds.
    await new Promise((resolve) => setTimeout(resolve, 50));
    controller.openSession(SESSION);
    await waitFor(() => controller.snapshot().openSessionId === SESSION, { label: 'session open' });
    assert.equal(controller.snapshot().openSessionPanel.todos, null, 'nothing is inherited from another session');
    controller.openSession(OTHER);
    assert.deepEqual(
      controller.snapshot().openSessionPanel.todos?.map((todo) => todo.text),
      ['other session task'],
      'the session the baseline DID name shows its own list',
    );
    controller.openSession(SESSION);
    assert.equal(controller.snapshot().openSessionPanel.todos, null);

    // The Host rebuilds the control set later and now includes this session (PROTOCOL.md:761).
    gateway.pushProjection({
      kind: 'projection-baseline',
      projections: { [SESSION]: { asOfSeq: 20, values: { todos: [{ content: 'fresh', status: 'pending' }] } } },
    });
    await waitFor(() => controller.snapshot().openSessionPanel.todos !== null, { label: 'late baseline applied' });
    assert.deepEqual(controller.snapshot().openSessionPanel.todos?.map((todo) => todo.text), ['fresh']);
  });

  it('closing the session empties the panel', () => {
    controller.openSession(SESSION);
    gateway.pushProjection({ kind: 'tasks-updated', sessionId: SESSION, asOfSeq: 30, todos: [{ content: 'x', status: 'pending' }] });
    return waitFor(() => controller.snapshot().openSessionPanel.todos !== null, { label: 'tasks applied' }).then(() => {
      controller.closeSession();
      const panel = controller.snapshot().openSessionPanel;
      assert.equal(panel.todos, null);
      assert.equal(panel.goal, null);
    });
  });
});
