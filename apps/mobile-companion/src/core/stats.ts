// Spec 018 — the read-only session-metric frames (`session-stats`, scope `stats:read`).
//
// CONTRACT (authoritative text: `packages/mobile-protocol/src/index.mjs:659-673`; Host side:
// `plugins/mobile-gateway/lib/index.mjs:2206-2220`, reply example in
// `plugins/mobile-gateway/PROTOCOL.md:925-936`):
//
//   request  { type: 'session-stats', requestId, sessionId }
//   reply    { kind: 'session-stats', sessionId, asOfSeq?,
//              sessionStats | null, tokenUsage | null, contextPressure | null }
//
// Three different "no number" answers, and the UI owes each one its own sentence:
//   * a FIELD is `null` — this Host/session has no such projection yet (not zero, not an error);
//   * the REQUEST was never sent — the controller answers `{ state: 'unavailable' }` when there is no
//     usable connection or the device was not paired with `stats:read` (that scope is never a
//     default, so an older pairing simply does not have it);
//   * a REFUSAL — the Host's `{ kind: 'error' }` frame (or a malformed reply) REJECTS with a
//     `CoreError` carrying the Host's code, so a defect is never drawn as "nothing yet".
//
// These are not contract §4 operations (`OPS` is unchanged), so they go through the client's explicit
// `allowNonOpType` opt-in like `team.ts`, never a loosened allowlist. No reply value is ever sent
// back: nothing here mutates anything.

import { STATS_READ_CLIENT_TYPES, STATS_READ_SCOPE, type Op } from '@dsh-ext/mobile-protocol';

import type { CompanionClient } from './client';
import { CoreError } from './errors';

export { STATS_READ_CLIENT_TYPES, STATS_READ_SCOPE };

/** The read type this module owns. Derived from the contract so it cannot silently drift. */
export type SessionStatsType = Extract<(typeof STATS_READ_CLIENT_TYPES)[number], 'session-stats'>;

/** Non-negative integer counters as the Host reports them; `null` when a number is absent. */
export interface SessionStats {
  readonly turns: number | null;
  readonly steps: number | null;
  readonly llmMs: number | null;
  readonly toolMs: number | null;
  readonly ttftMs: number | null;
  readonly ttftSteps: number | null;
  readonly decodeMs: number | null;
  readonly decodeTokens: number | null;
  readonly lastTurn: number | null;
  readonly openStep: number | null;
}

/** `tokenUsage.totals` (PROTOCOL.md:932). Every member is `null` when the Host omitted it. */
export interface TokenTotals {
  readonly inputTokens: number | null;
  readonly outputTokens: number | null;
  readonly cacheReadTokens: number | null;
  readonly cacheWriteTokens: number | null;
  readonly reasoningTokens: number | null;
}

export interface TokenUsage {
  readonly totals: TokenTotals | null;
}

/** `contextPressure` (PROTOCOL.md:933): the window size and how much of it is in use. */
export interface ContextPressure {
  readonly contextWindow: number | null;
  readonly pressureTokens: number | null;
  readonly surfaceTokens: number | null;
}

/** One read's answer. `ready` always carries the three fields; each may be `null` on its own. */
export interface SessionStatsRead {
  readonly state: 'ready';
  readonly asOfSeq?: number;
  readonly sessionStats: SessionStats | null;
  readonly tokenUsage: TokenUsage | null;
  readonly contextPressure: ContextPressure | null;
}

function asSeq(reply: Record<string, unknown>): number | undefined {
  return typeof reply.asOfSeq === 'number' && Number.isSafeInteger(reply.asOfSeq) ? reply.asOfSeq : undefined;
}

/** A counter: a non-negative finite number, or `null`. Never rounds or guesses. */
function count(value: unknown): number | null {
  return typeof value === 'number' && Number.isFinite(value) && value >= 0 ? value : null;
}

function record(value: unknown): Record<string, unknown> | null {
  return typeof value === 'object' && value !== null && !Array.isArray(value) ? value as Record<string, unknown> : null;
}

/** `sessionStats` → the ten counters the input-bar formula reads. */
export function parseSessionStats(value: unknown): SessionStats | null {
  const raw = record(value);
  if (raw === null) return null;
  return {
    turns: count(raw.turns),
    steps: count(raw.steps),
    llmMs: count(raw.llmMs),
    toolMs: count(raw.toolMs),
    ttftMs: count(raw.ttftMs),
    ttftSteps: count(raw.ttftSteps),
    decodeMs: count(raw.decodeMs),
    decodeTokens: count(raw.decodeTokens),
    lastTurn: count(raw.lastTurn),
    openStep: count(raw.openStep),
  };
}

/** `tokenUsage` → `{ totals }`; a usage without a totals object is "no numbers", not a zero. */
export function parseTokenUsage(value: unknown): TokenUsage | null {
  const raw = record(value);
  if (raw === null) return null;
  const totals = record(raw.totals);
  return {
    totals: totals === null
      ? null
      : {
          inputTokens: count(totals.inputTokens),
          outputTokens: count(totals.outputTokens),
          cacheReadTokens: count(totals.cacheReadTokens),
          cacheWriteTokens: count(totals.cacheWriteTokens),
          reasoningTokens: count(totals.reasoningTokens),
        },
  };
}

/** `contextPressure` → the window and its two usage numbers. */
export function parseContextPressure(value: unknown): ContextPressure | null {
  const raw = record(value);
  if (raw === null) return null;
  return {
    contextWindow: count(raw.contextWindow),
    pressureTokens: count(raw.pressureTokens),
    surfaceTokens: count(raw.surfaceTokens),
  };
}

/**
 * One `session-stats` reply, validated. Anything that is not exactly this frame for this session is a
 * contract violation and rejects: a reply about another session would paint the wrong numbers.
 */
export function toStatsRead(reply: Record<string, unknown>, sessionId: string): SessionStatsRead {
  if (reply.kind !== 'session-stats') {
    throw new CoreError({ code: 'client/bad-message', message: 'Expected a session-stats reply', details: { kind: reply.kind } });
  }
  if (typeof reply.sessionId !== 'string' || reply.sessionId !== sessionId) {
    throw new CoreError({ code: 'client/bad-message', message: 'The stats reply was for a different session', details: { sessionId } });
  }
  const asOfSeq = asSeq(reply);
  return {
    state: 'ready',
    ...(asOfSeq === undefined ? {} : { asOfSeq }),
    sessionStats: parseSessionStats(reply.sessionStats),
    tokenUsage: parseTokenUsage(reply.tokenUsage),
    contextPressure: parseContextPressure(reply.contextPressure),
  };
}

/** Read one session's metrics (`session-stats`). The caller checks the scope/capability first. */
export async function readSessionStats(client: CompanionClient, sessionId: string): Promise<SessionStatsRead> {
  if (typeof sessionId !== 'string' || sessionId.trim() === '') {
    // Refused before the wire: the Host would answer `bad-request`, and a blank id is our bug.
    throw new CoreError({ code: 'client/bad-state', message: 'A session id is required to read the stats' });
  }
  const reply = await client.request('session-stats' as Op, { sessionId }, { allowNonOpType: true });
  if (reply.kind === 'error') {
    // Keep the Host's code (`auth/forbidden-scope`, `remote-access/denied`, `session-not-found`); the
    // message is only kept for diagnostics and is never rendered.
    throw new CoreError({
      code: typeof reply.code === 'string' ? (reply.code as never) : 'internal',
      message: typeof reply.message === 'string' ? reply.message : 'The computer refused the stats read',
      details: { type: 'session-stats', sessionId },
    });
  }
  return toStatsRead(reply, sessionId);
}

/**
 * The Host metric frames are lifted by `stats:read`, which is never granted by default. The gateway
 * advertises NO hello capability for them (contract §3.5's `OPTIONAL_CAPABILITIES` has none), so the
 * device's own granted `hello.device.scopes` is the only signal the app has. An absent/malformed
 * scope list grants nothing (fail closed) — the accessor then never sends the frame.
 */
export function hasStatsReadScope(scopes: readonly string[] | null | undefined): boolean {
  return Array.isArray(scopes) && scopes.includes(STATS_READ_SCOPE);
}
