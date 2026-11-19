// Lazy conversation history — behavioural tests (no source regex).
//
// The PWA defect: opening ANY session showed “No message yet” while the app walked up to five older
// pages looking for a user prompt. The gateway already returns the newest suffix when no cursor is
// given, so one bounded request must render immediately; older pages are requested only by the
// reader (scroll-to-top or the explicit button).

import assert from 'node:assert/strict';
import { beforeEach, describe, it } from 'node:test';

import { AppController } from '../src/app-state';
import {
  prependViewportOffset,
  shouldScrollToNewestOnOpen,
  shouldShowNoMessage,
} from '../app/session/[id]';
import { resetAppState } from './support/stubs/react-native.stub';
import { resetLocalAuthentication } from './support/stubs/expo-local-authentication.stub';
import { resetNotifications } from './support/stubs/expo-notifications.stub';
import { resetSecureStore } from './support/stubs/expo-secure-store.stub';
import { waitFor } from './support/wait';

const MAX_MESSAGES = 60;
const MAX_BYTES = 96 * 1024;
const SESSION = 'session-lazy';

interface RequestCall {
  op: string;
  params: Record<string, unknown>;
}

/** A scripted client standing in for CompanionClient: only the history answers matter here. */
class ScriptedClient {
  readonly state = 'ready';
  readonly hello = { historyFormatVersion: 4 };
  readonly requests: RequestCall[] = [];
  private readonly answers: Array<Record<string, unknown>>;

  constructor(answers: Array<Record<string, unknown>>) {
    this.answers = [...answers];
  }

  async request(op: string, params: Record<string, unknown> = {}): Promise<Record<string, unknown>> {
    this.requests.push({ op, params });
    if (op === 'subscribe') return { kind: 'subscribed', sessionId: params.sessionId };
    if (op === 'history') {
      const answer = this.answers.shift();
      if (answer === undefined) throw new Error('the fixture ran out of history answers');
      return answer;
    }
    return {};
  }
}

function historyPage(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    kind: 'history',
    sessionId: SESSION,
    historyFormatVersion: 4,
    hasMore: false,
    items: [],
    ...overrides,
  };
}

function newController(client: ScriptedClient): AppController {
  const controller = new AppController({ locale: () => 'en', transport: () => { throw new Error('no socket needed'); } });
  // The private field is deliberately replaced: these tests exercise the controller's history logic
  // without a TLS gateway, and the public surface has no client injection point.
  Object.assign(controller, { client });
  return controller;
}

beforeEach(() => {
  resetSecureStore();
  resetAppState('active');
  resetLocalAuthentication();
  resetNotifications(true);
});

describe('opening a conversation', () => {
  it('sends exactly one newest-first history request and renders its page', async () => {
    const client = new ScriptedClient([
      historyPage({
        items: [{ seq: 20, id: 'm20', role: 'assistant', text: 'newest answer' }],
        hasMore: true,
        nextBeforeSeq: 12,
      }),
    ]);
    const controller = newController(client);

    controller.openSession(SESSION);
    await waitFor(() => controller.snapshot().historyLoaded, { label: 'opening page answered' });
    // Give any hypothetical follow-up loop a chance to issue a second request.
    await new Promise((resolve) => setTimeout(resolve, 25));

    const historyCalls = client.requests.filter((call) => call.op === 'history');
    assert.equal(historyCalls.length, 1, 'no prompt hunt, no five-page loop');
    assert.deepEqual(historyCalls[0]?.params, {
      sessionId: SESSION,
      view: 'conversation',
      maxMessages: MAX_MESSAGES,
      maxBytes: MAX_BYTES,
    });
    const snapshot = controller.snapshot();
    assert.deepEqual(snapshot.history.map((row) => row.text), ['newest answer']);
    assert.equal(snapshot.historyHasEarlier, true, 'older pages are still advertised');
    assert.equal(snapshot.historyLoading, false);
    assert.equal(client.requests.filter((call) => call.op === 'history' && 'beforeSeq' in call.params).length, 0);
  });

  it('an empty first page with older pages does not earn a “No message yet”', async () => {
    const client = new ScriptedClient([
      historyPage({ items: [], hasMore: true, nextBeforeSeq: 12 }),
    ]);
    const controller = newController(client);
    controller.openSession(SESSION);
    await waitFor(() => controller.snapshot().historyLoaded, { label: 'empty opening page answered' });

    const snapshot = controller.snapshot();
    assert.equal(snapshot.history.length, 0);
    assert.equal(snapshot.historyHasMore, true);
    assert.equal(snapshot.historyHasEarlier, true);
    // The screen is rendered on an online socket in the reported PWA case; the scripted fixture does
    // not run a transport, so state the readiness explicitly instead of deriving it from `snapshot`.
    assert.equal(shouldShowNoMessage({
      connectionReady: true,
      historyLoaded: snapshot.historyLoaded,
      historyLoading: snapshot.historyLoading,
      historyHasMore: snapshot.historyHasMore,
      historyHasEarlier: snapshot.historyHasEarlier,
    }), false, 'the screen keeps its loader / “load earlier” affordance instead');
  });
});

describe('older pages', () => {
  it('sends the cursor with the mandatory format, crop and byte budget, then prepends', async () => {
    const client = new ScriptedClient([
      historyPage({
        items: [{ seq: 20, id: 'm20', role: 'assistant', text: 'newest answer' }],
        hasMore: true,
        nextBeforeSeq: 12,
      }),
      historyPage({
        items: [{ seq: 5, id: 'm5', role: 'user', text: 'the real prompt' }],
        hasMore: false,
      }),
    ]);
    const controller = newController(client);
    controller.openSession(SESSION);
    await waitFor(() => controller.snapshot().historyLoaded, { label: 'opening page answered' });

    await controller.loadOlderHistory();

    const historyCalls = client.requests.filter((call) => call.op === 'history');
    assert.equal(historyCalls.length, 2);
    assert.deepEqual(historyCalls[1]?.params, {
      sessionId: SESSION,
      beforeSeq: 12,
      historyFormatVersion: 4,
      view: 'conversation',
      maxMessages: MAX_MESSAGES,
      maxBytes: MAX_BYTES,
    });
    assert.deepEqual(controller.snapshot().history.map((row) => row.id), ['m5', 'm20']);
    assert.equal(controller.snapshot().historyHasEarlier, false);
    assert.equal(controller.snapshot().historyLoading, false);
  });

  it('keeps paging through an empty conversation-cropped page while the cursor advances', async () => {
    const client = new ScriptedClient([
      historyPage({
        items: [{ seq: 20, id: 'm20', role: 'assistant', text: 'newest answer' }],
        hasMore: true,
        nextBeforeSeq: 12,
      }),
      // Every raw event on this page was cropped, but the Host still knows an older page at seq 8.
      historyPage({ items: [], hasMore: true, nextBeforeSeq: 8 }),
      historyPage({
        items: [{ seq: 5, id: 'm5', role: 'user', text: 'prompt from the older page' }],
        hasMore: false,
      }),
    ]);
    const controller = newController(client);
    controller.openSession(SESSION);
    await waitFor(() => controller.snapshot().historyLoaded, { label: 'opening page answered' });

    await controller.loadOlderHistory();
    let snapshot = controller.snapshot();
    assert.equal(snapshot.history.length, 1, 'the cropped page added no rows');
    assert.equal(snapshot.historyHasMore, true, 'but the Host still says there is more');
    assert.equal(snapshot.historyHasEarlier, true, 'and the advanced cursor is usable');

    await controller.loadOlderHistory();
    snapshot = controller.snapshot();
    const historyCalls = client.requests.filter((call) => call.op === 'history');
    assert.equal(historyCalls.length, 3);
    assert.equal(historyCalls[1]?.params.beforeSeq, 12);
    assert.equal(historyCalls[2]?.params.beforeSeq, 8, 'the second request follows the new cursor');
    assert.deepEqual(snapshot.history.map((row) => row.id), ['m5', 'm20']);
    assert.equal(snapshot.historyHasEarlier, false, 'the last page ended the chain');
  });

  it('restores the old viewport after prepend instead of jumping to the newest row', () => {
    // oldOffset 220, content grew 1000 → 1400: the row under the finger stays at y 620.
    assert.equal(prependViewportOffset(220, 1000, 1400), 620);
    assert.equal(prependViewportOffset(0, 500, 900), 400, 'prepended height shifts the anchor down');
    assert.equal(prependViewportOffset(0, 900, 500), 0, 'a shrinking viewport clamps at zero');
  });

  it('jumps to newest once per session id, never again after a prepend', () => {
    const states = [
      { sessionId: SESSION, historyLoaded: false, historyLoading: true },
      { sessionId: SESSION, historyLoaded: true, historyLoading: false }, // first page
      { sessionId: SESSION, historyLoaded: true, historyLoading: false }, // prepend re-render
      { sessionId: SESSION, historyLoaded: true, historyLoading: false }, // later live message
      { sessionId: SESSION + '-2', historyLoaded: true, historyLoading: false }, // another session
    ];
    let doneFor: string | null = null;
    let jumps = 0;
    for (const state of states) {
      if (shouldScrollToNewestOnOpen({ doneFor, ...state })) {
        doneFor = state.sessionId;
        jumps += 1;
      }
    }
    assert.equal(jumps, 2, 'one for each opened id, not one per content change');
    assert.equal(doneFor, SESSION + '-2');
  });
});
