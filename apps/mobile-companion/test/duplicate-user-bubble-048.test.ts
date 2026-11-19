// Spec 048 item 3 — exactly ONE user bubble through the REAL socket path.
//
// These tests pair a controller with FakeGateway, send through the outbox (`sent` receipt included)
// and push live `event` frames with `FakeGateway.pushEvent()`. No private `onEvent`, no hand-made ack.

import assert from 'node:assert/strict';
import { afterEach, beforeEach, describe, it } from 'node:test';

import { AppController } from '../src/app-state';
import { coerceHistoryEvent, HistoryStore } from '../src/core/history';
import { encodePairingPayload, type PairingPayload } from '../src/core';
import { FakeGateway } from './support/fake-gateway';
import { NodePinnedTransport } from './support/node-pinned-transport';
import { waitFor } from './support/wait';
import { resetAppState } from './support/stubs/react-native.stub';
import { resetLocalAuthentication } from './support/stubs/expo-local-authentication.stub';
import { resetNotifications } from './support/stubs/expo-notifications.stub';
import { resetSecureStore } from './support/stubs/expo-secure-store.stub';

const SESSION = 'session-048';
const PROMPT = 'So sánh benchmark trên PWA';
const CODE = 'A'.repeat(43);

function pairingPayload(gateway: FakeGateway): string {
  const payload: PairingPayload = {
    version: 3,
    publicUrl: gateway.endpoint,
    pairingCode: CODE,
    expiresAt: Date.now() + 240_000,
    certSha256: gateway.certSha256,
    gatewayId: '0f8fad5b-d9cb-469f-a165-70867728950e',
    gatewayName: 'my-pc',
    endpoints: [gateway.endpoint],
  };
  return encodePairingPayload(payload);
}

function sentClientMsgId(gateway: FakeGateway): string {
  const frames = gateway.allReceivedFrames
    .map((raw) => JSON.parse(raw) as { type?: unknown; clientMsgId?: unknown })
    .filter((frame) => frame.type === 'message' && typeof frame.clientMsgId === 'string');
  const last = frames.at(-1);
  assert.ok(last && typeof last.clientMsgId === 'string', 'a message frame was really sent');
  return last.clientMsgId;
}

function pushUserEvent(gateway: FakeGateway, seq: number, text: string, clientMsgId?: string): void {
  gateway.pushEvent({
    sessionId: SESSION,
    seq,
    time: 1_700_000_000_000 + seq,
    event: { type: 'user/message', text, ...(clientMsgId === undefined ? {} : { clientMsgId }) },
  });
}

describe('duplicate user bubble — real outbox + real event listener', () => {
  let gateway: FakeGateway;
  let controller: AppController;

  beforeEach(() => {
    resetSecureStore();
    resetAppState('active');
    resetLocalAuthentication();
    resetNotifications(true);
  });

  afterEach(async () => {
    controller?.stop();
    await gateway?.close();
  });

  async function connected(requestDelayMs = 0): Promise<void> {
    gateway = await FakeGateway.create({ deviceScopes: ['sessions:read'], requestDelayMs });
    gateway.addPairingCode(CODE);
    controller = new AppController({
      locale: () => 'en',
      transport: () => new NodePinnedTransport({ handshakeTimeoutMs: 4_000 }),
    });
    await controller.start();
    const paired = await controller.pair(pairingPayload(gateway));
    assert.equal(paired.ok, true, JSON.stringify(paired));
    await controller.unlock();
    await waitFor(() => controller.snapshot().connection === 'ready', { label: 'socket ready' });
    controller.openSession(SESSION);
    await waitFor(() => controller.snapshot().historyLoaded, { label: 'opening page' });
  }

  const promptRows = (): ReturnType<AppController['snapshot']>['history'] =>
    controller.snapshot().history.filter((row) => row.text.trim() === PROMPT);

  it('ack first, then echo: the ack row is updated, not duplicated', async () => {
    await connected();
    await controller.sendPrompt(PROMPT);
    await waitFor(() => promptRows().length === 1 && promptRows()[0]?.pending === false, { label: 'sent receipt' });
    const clientMsgId = sentClientMsgId(gateway);

    pushUserEvent(gateway, 71, PROMPT, clientMsgId);
    await waitFor(() => promptRows()[0]?.id === 'seq-71', { label: 'live echo folded' });

    const rows = promptRows();
    assert.equal(rows.length, 1, 'one bubble after echo');
    assert.equal(rows[0]?.clientMsgId, clientMsgId, 'correlation survived the id change');
    assert.equal(rows[0]?.pending, false);
  });

  it('ack first, then a text-only echo (no clientMsgId) still folds into one bubble', async () => {
    await connected();
    await controller.sendPrompt(PROMPT);
    await waitFor(() => promptRows().length === 1 && promptRows()[0]?.pending === false, { label: 'sent receipt' });

    // The real gateway does not echo clientMsgId on user/message; the awaitingEcho flag is the link.
    pushUserEvent(gateway, 81, PROMPT);
    await waitFor(() => promptRows()[0]?.id === 'seq-81', { label: 'text-only echo folded' });

    const rows = promptRows();
    assert.equal(rows.length, 1, 'no second bubble');
    assert.equal(rows[0]?.awaitingEcho, false);
  });

  it('echo first, then ack: merge sees the pending row and the late receipt keeps it', async () => {
    await connected();
    const sending = controller.sendPrompt(PROMPT);
    // `sendPrompt` installs the optimistic row synchronously before its first await; pushing here
    // puts the echo ahead of the `sent` receipt without a delayed gateway (which would trigger retries).
    const clientMsgId = controller.snapshot().outgoing.find((item) => item.text === PROMPT)?.clientMsgId;
    assert.ok(clientMsgId, 'the optimistic row carries a stable clientMsgId');
    pushUserEvent(gateway, 72, PROMPT, clientMsgId);
    await sending;
    await waitFor(() => promptRows()[0]?.pending === false, { label: 'sent receipt after echo' });

    const rows = promptRows();
    assert.equal(rows.length, 1, 'one bubble after both events');
    assert.equal(rows[0]?.id, 'seq-72', 'the host row kept its authoritative id');
    assert.equal(rows[0]?.clientMsgId, clientMsgId);
  });

  it('a replayed echo does not fork the folded row', async () => {
    await connected();
    await controller.sendPrompt(PROMPT);
    await waitFor(() => promptRows().length === 1 && promptRows()[0]?.pending === false, { label: 'sent receipt' });
    const clientMsgId = sentClientMsgId(gateway);

    pushUserEvent(gateway, 73, PROMPT, clientMsgId);
    await waitFor(() => promptRows()[0]?.id === 'seq-73', { label: 'first echo' });
    pushUserEvent(gateway, 73, PROMPT, clientMsgId);
    await new Promise((resolve) => setTimeout(resolve, 30));

    assert.equal(promptRows().length, 1, 'replay is deduped by id/seq and correlation');
  });
});

describe('HistoryStore correlation rules', () => {
  it('echoed clientMsgId wins over identical text and is kept for a late ack', () => {
    const store = new HistoryStore();
    store.addPendingPrompt('client-1', PROMPT);
    store.addPendingPrompt('client-2', PROMPT);
    const incoming = coerceHistoryEvent({
      type: 'user/message', seq: 9, text: 'host-normalised text', clientMsgId: 'client-2',
    });
    assert.notEqual(incoming, null);
    assert.equal(store.mergePendingUserEvent({ clientMsgId: 'client-2' }, incoming as NonNullable<typeof incoming>), true);
    assert.deepEqual(store.items.map((row) => [row.id, row.clientMsgId, row.pending]), [
      ['client-1', 'client-1', true],
      ['seq-9', 'client-2', false],
    ], 'the second pending row was selected by id, not by text');
    store.confirmPending('client-2', { id: 'client-2', role: 'user', text: PROMPT });
    assert.equal(store.items.length, 2, 'the late ack updated the same row');
  });

  it('never folds an assistant row or an unrelated user row', () => {
    const store = new HistoryStore();
    store.addPendingPrompt('client-1', PROMPT);
    const assistant = coerceHistoryEvent({ type: 'assistant/message', seq: 3, text: PROMPT });
    assert.notEqual(assistant, null);
    assert.equal(store.mergePendingUserEvent({}, assistant as NonNullable<typeof assistant>), false);
    const other = coerceHistoryEvent({ type: 'user/message', seq: 4, text: 'unrelated' });
    assert.notEqual(other, null);
    assert.equal(store.mergePendingUserEvent({}, other as NonNullable<typeof other>), false);
    assert.equal(store.items.length, 1);
  });

  it('a replayed seq never consumes a NEW prompt that merely shares the text', () => {
    const store = new HistoryStore();
    store.addPendingPrompt('client-A', PROMPT);
    store.confirmPending('client-A', { id: 'client-A', role: 'user', text: PROMPT });
    const echo = coerceHistoryEvent({ type: 'user/message', seq: 7, text: PROMPT });
    assert.notEqual(echo, null);
    assert.equal(store.mergePendingUserEvent({}, echo as NonNullable<typeof echo>), true);
    assert.equal(store.items[0]?.awaitingEcho, false);

    // User sends prompt B with the SAME text; the Host replays seq 7 (no clientMsgId).
    store.addPendingPrompt('client-B', PROMPT);
    const replay = coerceHistoryEvent({ type: 'user/message', seq: 7, text: PROMPT });
    assert.notEqual(replay, null);
    assert.equal(store.mergePendingUserEvent({}, replay as NonNullable<typeof replay>), false);
    assert.deepEqual(store.items.map((row) => [row.id, row.pending]), [
      ['seq-7', false],
      ['client-B', true],
    ], 'prompt B stays pending and visible');
  });

  it('an unrelated event before the echo does not lose awaitingEcho', () => {
    const store = new HistoryStore();
    store.addPendingPrompt('client-1', PROMPT);
    store.confirmPending('client-1', { id: 'client-1', role: 'user', text: PROMPT });
    const progress = coerceHistoryEvent({ type: 'assistant/message', seq: 5, text: 'working on it' });
    assert.notEqual(progress, null);
    assert.equal(store.mergePendingUserEvent({}, progress as NonNullable<typeof progress>), false);
    assert.equal(store.items[0]?.awaitingEcho, true, 'a non-user event must not consume the echo link');

    const echo = coerceHistoryEvent({ type: 'user/message', seq: 6, text: PROMPT });
    assert.notEqual(echo, null);
    assert.equal(store.mergePendingUserEvent({}, echo as NonNullable<typeof echo>), true);
    assert.equal(store.items.length, 1);
  });

  it('a failed prompt never wins the text-only echo of a later identical prompt', () => {
    const store = new HistoryStore();
    store.addPendingPrompt('client-A', PROMPT);
    store.markPromptFailed('client-A', 'message/refused');
    store.addPendingPrompt('client-B', PROMPT);
    const echo = coerceHistoryEvent({ type: 'user/message', seq: 12, text: PROMPT });
    assert.notEqual(echo, null);
    assert.equal(store.mergePendingUserEvent({}, echo as NonNullable<typeof echo>), true);

    const rows = store.items;
    assert.equal(rows.length, 2);
    assert.equal(rows[0]?.id, 'client-A', 'the failed row kept its own id and reason');
    assert.equal(rows[0]?.failed, 'message/refused');
    assert.equal(rows[0]?.awaitingEcho, false);
    assert.equal(rows[1]?.id, 'seq-12', 'only prompt B was folded by the echo');
    assert.equal(rows[1]?.clientMsgId, 'client-B');
  });
});
