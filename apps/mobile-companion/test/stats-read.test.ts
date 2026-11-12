// Spec 018 — the read-only session-metric frame (`session-stats`, scope `stats:read`).
//
// The three "no number" answers must stay distinguishable, because the UI shows a different sentence
// for each: a `null` FIELD means "this Host has no projection yet", an UNSENT request (no socket, no
// `stats:read` grant) means "not available to this pairing", and a REFUSAL rejects with the Host's
// code. Every case is asserted here, including the wire frame the Host actually receives.

import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import type { CompanionClient } from '../src/core/client';
import { CoreError } from '../src/core/errors';
import {
  hasStatsReadScope,
  parseContextPressure,
  parseSessionStats,
  parseTokenUsage,
  readSessionStats,
  toStatsRead,
} from '../src/core/stats';

const SESSION = 'sess-1';

interface Sent {
  op: unknown;
  params: Record<string, unknown>;
  options?: { allowNonOpType?: boolean };
}

/** A fake ready client that records the frame and answers with `reply` (or throws it). */
function clientAnswering(reply: unknown): { client: CompanionClient; sent: Sent[] } {
  const sent: Sent[] = [];
  const client = {
    request: async (op: unknown, params: Record<string, unknown>, options?: { allowNonOpType?: boolean }) => {
      sent.push({ op, params, options });
      if (reply instanceof Error) throw reply;
      return reply as Record<string, unknown>;
    },
  };
  return { client: client as CompanionClient, sent };
}

/** The PROTOCOL.md:925-936 example. */
const EXAMPLE = {
  kind: 'session-stats',
  sessionId: SESSION,
  asOfSeq: 42,
  sessionStats: {
    turns: 6, steps: 69, llmMs: 2_280_000, toolMs: 41_400,
    ttftMs: 2_600, ttftSteps: 1, decodeMs: 5_000, decodeTokens: 385,
    lastTurn: 6, openStep: null, pendingCalls: {},
  },
  tokenUsage: { totals: { inputTokens: 10, outputTokens: 5, cacheReadTokens: 1, cacheWriteTokens: 0, reasoningTokens: 0 } },
  contextPressure: { contextWindow: 128_000, pressureTokens: 1_500, surfaceTokens: 2_000 },
};

describe('readSessionStats', () => {
  it('sends the documented frame through the non-op opt-in and parses every field', async () => {
    const { client, sent } = clientAnswering(EXAMPLE);
    const read = await readSessionStats(client, SESSION);

    assert.deepEqual(sent[0], { op: 'session-stats', params: { sessionId: SESSION }, options: { allowNonOpType: true } });
    assert.equal(read.state, 'ready');
    assert.equal(read.asOfSeq, 42);
    assert.equal(read.sessionStats?.turns, 6);
    assert.equal(read.sessionStats?.steps, 69);
    assert.equal(read.sessionStats?.openStep, null, 'an explicit null is "no open step"');
    assert.equal(read.tokenUsage?.totals?.inputTokens, 10);
    assert.equal(read.tokenUsage?.totals?.cacheWriteTokens, 0, 'zero is a REPORTED value, not "absent"');
    assert.equal(read.contextPressure?.contextWindow, 128_000);
    assert.equal(read.contextPressure?.pressureTokens, 1_500);
  });

  it('keeps each field null independently when the Host has no projection (PROTOCOL.md:1661)', async () => {
    const { client } = clientAnswering({ kind: 'session-stats', sessionId: SESSION, sessionStats: null, tokenUsage: null, contextPressure: null });
    const read = await readSessionStats(client, SESSION);
    assert.equal(read.state, 'ready');
    assert.equal(read.sessionStats, null);
    assert.equal(read.tokenUsage, null);
    assert.equal(read.contextPressure, null);
  });

  it('omits asOfSeq when the Host did not send one', async () => {
    const { client } = clientAnswering({ kind: 'session-stats', sessionId: SESSION, sessionStats: null, tokenUsage: null, contextPressure: null });
    const read = await readSessionStats(client, SESSION);
    assert.equal('asOfSeq' in read, false);
  });

  it('rejects a refusal with the Host code (auth/forbidden-scope is never an empty answer)', async () => {
    const { client } = clientAnswering({ kind: 'error', requestType: 'session-stats', code: 'auth/forbidden-scope', scope: 'stats:read', message: 'internal text' });
    await assert.rejects(readSessionStats(client, SESSION), (error: unknown) => {
      assert.ok(error instanceof CoreError);
      assert.equal(error.code, 'auth/forbidden-scope');
      return true;
    });
  });

  it('rejects a reply for another session instead of painting the wrong numbers', async () => {
    const { client } = clientAnswering({ ...EXAMPLE, sessionId: 'other' });
    await assert.rejects(readSessionStats(client, SESSION), (error: unknown) => error instanceof CoreError && error.code === 'client/bad-message');
  });

  it('rejects a reply of the wrong kind', async () => {
    const { client } = clientAnswering({ kind: 'context-usage', sessionId: SESSION });
    await assert.rejects(readSessionStats(client, SESSION), (error: unknown) => error instanceof CoreError && error.code === 'client/bad-message');
  });

  it('refuses a blank session id before the wire', async () => {
    const { client, sent } = clientAnswering(EXAMPLE);
    await assert.rejects(readSessionStats(client, '   '), (error: unknown) => error instanceof CoreError && error.code === 'client/bad-state');
    assert.deepEqual(sent, [], 'nothing was sent');
  });

  it('propagates a client-level rejection unchanged', async () => {
    const failure = new CoreError({ code: 'client/disconnected', message: 'Socket is not open' });
    const { client } = clientAnswering(failure);
    await assert.rejects(readSessionStats(client, SESSION), (error: unknown) => error === failure);
  });
});

describe('stats parsers', () => {
  it('treat a non-numeric or negative counter as absent, never as zero', () => {
    const stats = parseSessionStats({ turns: '6', steps: -1, llmMs: 12 });
    assert.deepEqual(stats, {
      turns: null, steps: null, llmMs: 12, toolMs: null, ttftMs: null, ttftSteps: null,
      decodeMs: null, decodeTokens: null, lastTurn: null, openStep: null,
    });
  });

  it('accept a usage without totals as "no numbers"', () => {
    assert.deepEqual(parseTokenUsage({}), { totals: null });
    assert.deepEqual(parseTokenUsage({ totals: { inputTokens: 3 } }), {
      totals: { inputTokens: 3, outputTokens: null, cacheReadTokens: null, cacheWriteTokens: null, reasoningTokens: null },
    });
  });

  it('keep an unknown context-pressure member absent', () => {
    assert.deepEqual(parseContextPressure({ contextWindow: 1000 }), { contextWindow: 1000, pressureTokens: null, surfaceTokens: null });
  });

  it('an array is not a record', () => {
    assert.equal(parseSessionStats([]), null);
    assert.equal(parseTokenUsage([]), null);
    assert.equal(parseContextPressure('128000'), null);
  });

  it('toStatsRead is the validated envelope the accessor returns', () => {
    const read = toStatsRead(EXAMPLE, SESSION);
    assert.equal(read.state, 'ready');
    assert.equal(read.sessionStats?.turns, 6);
  });
});

describe('hasStatsReadScope', () => {
  it('grants only an explicit stats:read entry', () => {
    assert.equal(hasStatsReadScope(['sessions:read', 'stats:read']), true);
  });

  it('fails closed for an absent, empty, malformed or differently-cased grant', () => {
    assert.equal(hasStatsReadScope(undefined), false);
    assert.equal(hasStatsReadScope(null), false);
    assert.equal(hasStatsReadScope([]), false);
    assert.equal(hasStatsReadScope(['sessions:read']), false);
    assert.equal(hasStatsReadScope(['STATS:READ']), false);
  });
});
