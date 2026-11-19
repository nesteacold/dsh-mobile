import assert from 'node:assert/strict';
import test from 'node:test';

import { MAX_QUESTION_CARDS, QuestionCard, QuestionCards } from '../src/core/questions';
import type { QuestionRequestedFrame } from '@dsh-ext/mobile-protocol';

const frame = (over: Partial<QuestionRequestedFrame> = {}): QuestionRequestedFrame => ({
  kind: 'question-requested',
  rpcId: 'q-1',
  sessionId: 's1',
  questions: [{ id: 'a1', header: 'Pick one', options: [{ label: 'yes' }, { label: 'no' }] }],
  callId: 'call-1',
  ...over,
});

test('a question card dedupes replays by (sessionId, rpcId) and keeps the first state', () => {
  const cards = new QuestionCards();
  const first = cards.upsert(frame());
  const replay = cards.upsert(frame({ replay: true, questions: [] }));
  assert.equal(first, replay, 'a replay is the same card, not a fork');
  assert.equal(replay.snapshot.replay, true);
  assert.equal(replay.snapshot.questions.length, 1, 'the original question list survives the replay');
  assert.equal(cards.forSession('s1').length, 1);
  assert.equal(cards.forSession('s2').length, 0);
});

test('an accepted answer settles the card; a refused receipt keeps it visible', async () => {
  const card = new QuestionCard(frame());
  const accepted = await card.decide([{ id: 'a1', selected: ['yes'] }], async () => ({ accepted: true }));
  assert.equal(accepted.status, 'settled');
  assert.equal(card.pending, false);

  const refused = new QuestionCard(frame({ rpcId: 'q-2' }));
  const state = await refused.decide([{ id: 'a1', selected: ['yes'] }],
    async () => ({ accepted: false, reason: 'bad-response' }));
  assert.equal(state.status, 'pending', 'a refusal must not silently drop the card');
  assert.match(String(state.notice), /not accepted/);
  assert.equal(refused.pending, true, 'the user can retry');
});

test('question-resolved settles a known card and the registry is bounded/clearable', () => {
  const cards = new QuestionCards();
  cards.upsert(frame());
  assert.equal(cards.applyResolved({ kind: 'question-resolved', rpcId: 'q-1', sessionId: 's1', outcome: 'answered' }), true);
  assert.equal(cards.get('s1', 'q-1')?.snapshot.status, 'already-decided');
  for (let i = 0; i < MAX_QUESTION_CARDS + 5; i += 1) cards.upsert(frame({ rpcId: `q-${i}` }));
  assert.ok(cards.forSession('s1').length <= MAX_QUESTION_CARDS, 'the store is bounded');
  cards.clear();
  assert.equal(cards.forSession('s1').length, 0);
});
