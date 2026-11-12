// Read-on-demand agent-team / subagent-catalog reads for one session (spec 018 item 2, revision 11).
//
// CONTRACT (authoritative text: `packages/mobile-protocol/src/index.mjs:623-637`; Host side:
// `plugins/mobile-gateway/lib/index.mjs:1612-1636`):
//
//   request  { type: 'agent-team' | 'subagents', requestId, sessionId }
//   reply    { kind: 'agent-team' | 'subagents', sessionId, requestId?, projectionState,
//              asOfSeq?,            // ONLY when the Host's projection is `sequenced`
//              agentTeam? | subagentCatalog? }
//
// `projectionState` is one of exactly three values, and each means something different to the UI:
//   ready               — the projection is present (`agentTeam` / `subagentCatalog` filled)
//   unavailable         — the Host has no such projection for this session yet (value is null);
//                         this is NOT an error and NOT empty data: show "nothing yet", don't invent
//   migration-required  — the Host still has to migrate this session's projections; the value is
//                         also null. Reading again later is the only correct action.
//
// These are NOT contract §4 operations (`OPS` is unchanged) — `TEAM_READ_CLIENT_TYPES` — so they go
// through an explicit `allowNonOpType` opt-in, never a loosened allowlist: the
// allowlist. Scope is the ordinary {@link TEAM_READ_SCOPE} = `sessions:read`, and the Host still
// applies its own "may this device see this session" rule per item.
//
// SHAPE, NOT GUESSWORK: `agentTeam` is `{ members, tasks }` (both arrays) and `subagentCatalog` is an
// array; anything else is a contract violation and is rejected rather than handed to the UI.

import { TEAM_READ_CLIENT_TYPES, type Op } from '@dsh-ext/mobile-protocol';

import type { CompanionClient } from './client';
import { CoreError } from './errors';

/** The two read types. Derived from the contract so a new one cannot be silently forgotten. */
export type TeamReadType = (typeof TEAM_READ_CLIENT_TYPES)[number];

/** `projectionState` exactly as the Host reports it. */
export type ProjectionState = 'ready' | 'unavailable' | 'migration-required';

/** One member of a session's agent team. Fields are passed through: the contract does not fix them. */
export type AgentTeamMember = Record<string, unknown>;

/** A task the team is working on. Passed through like the members. */
export type AgentTeamTask = Record<string, unknown>;

export interface AgentTeamProjection {
  members: AgentTeamMember[];
  tasks: AgentTeamTask[];
}

export interface SubagentCatalogEntry {
  [key: string]: unknown;
}

/**
 * One read's result. Discriminated by `state` so the UI must handle all three cases:
 * only `ready` carries a value, and `migration-required` is never mistaken for "empty".
 */
export type TeamRead<T> =
  | { state: 'ready'; asOfSeq?: number; value: T }
  | { state: 'unavailable'; asOfSeq?: number }
  | { state: 'migration-required'; asOfSeq?: number };

function asSeq(reply: Record<string, unknown>): number | undefined {
  return typeof reply.asOfSeq === 'number' && Number.isSafeInteger(reply.asOfSeq) ? reply.asOfSeq : undefined;
}

/** Shared request path: send the type, validate the envelope, return the raw reply. */
async function requestTeamRead(
  client: CompanionClient,
  type: TeamReadType,
  sessionId: string,
): Promise<Record<string, unknown>> {
  if (sessionId.trim() === '') {
    // Refused before the wire: the Host would answer `bad-request`, and a blank id is our bug.
    throw new CoreError({ code: 'client/bad-state', message: 'A session id is required to read the team' });
  }
  const reply = await client.request(
    type as Op,
    { sessionId },
    { allowNonOpType: true },
  );
  if (reply.kind === 'error') {
    // Keep the Host's code (session/not-found, auth/…): the caller decides what to show, but the
    // generic `message` is not user copy, so it is only kept for diagnostics.
    throw new CoreError({
      code: typeof reply.code === 'string' ? (reply.code as never) : 'internal',
      message: typeof reply.message === 'string' ? reply.message : 'The computer refused the team read',
      details: { type, sessionId },
    });
  }
  if (reply.kind !== type) {
    throw new CoreError({
      code: 'client/bad-message',
      message: `Expected a ${type} reply`,
      details: { type, sessionId, kind: reply.kind },
    });
  }
  if (typeof reply.sessionId !== 'string' || reply.sessionId !== sessionId) {
    // A reply about another session would be attached to the wrong screen.
    throw new CoreError({ code: 'client/bad-message', message: 'The reply was for a different session', details: { type, sessionId } });
  }
  return reply;
}

/** Read the session's agent team (`agentTeam`, scope `sessions:read`). */
export async function readAgentTeam(client: CompanionClient, sessionId: string): Promise<TeamRead<AgentTeamProjection>> {
  const reply = await requestTeamRead(client, 'agent-team', sessionId);
  const asOfSeq = asSeq(reply);
  const state = reply.projectionState;
  if (state === 'unavailable') return { state: 'unavailable', ...(asOfSeq === undefined ? {} : { asOfSeq }) };
  if (state === 'migration-required') return { state: 'migration-required', ...(asOfSeq === undefined ? {} : { asOfSeq }) };
  if (state !== 'ready') {
    throw new CoreError({
      code: 'client/bad-message',
      message: 'The computer reported an unknown projection state',
      details: { projectionState: state },
    });
  }
  const team = reply.agentTeam;
  if (typeof team !== 'object' || team === null) {
    throw new CoreError({ code: 'client/bad-message', message: 'The agent team was missing from the reply' });
  }
  const { members, tasks } = team as { members?: unknown; tasks?: unknown };
  if (!Array.isArray(members) || !Array.isArray(tasks)) {
    throw new CoreError({ code: 'client/bad-message', message: 'The agent team had an unexpected shape' });
  }
  return {
    state: 'ready',
    ...(asOfSeq === undefined ? {} : { asOfSeq }),
    value: { members: members as AgentTeamMember[], tasks: tasks as AgentTeamTask[] },
  };
}

/** Read the session's subagent catalog (`subagentCatalog`, scope `sessions:read`). */
export async function readSubagents(
  client: CompanionClient,
  sessionId: string,
): Promise<TeamRead<SubagentCatalogEntry[]>> {
  const reply = await requestTeamRead(client, 'subagents', sessionId);
  const asOfSeq = asSeq(reply);
  const state = reply.projectionState;
  if (state === 'unavailable') return { state: 'unavailable', ...(asOfSeq === undefined ? {} : { asOfSeq }) };
  if (state === 'migration-required') return { state: 'migration-required', ...(asOfSeq === undefined ? {} : { asOfSeq }) };
  if (state !== 'ready') {
    throw new CoreError({
      code: 'client/bad-message',
      message: 'The computer reported an unknown projection state',
      details: { projectionState: state },
    });
  }
  if (!Array.isArray(reply.subagentCatalog)) {
    throw new CoreError({ code: 'client/bad-message', message: 'The subagent catalog had an unexpected shape' });
  }
  return {
    state: 'ready',
    ...(asOfSeq === undefined ? {} : { asOfSeq }),
    value: reply.subagentCatalog as SubagentCatalogEntry[],
  };
}
