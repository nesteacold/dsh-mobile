// Agent-team / subagent-catalog reads (spec 018 item 2, revision 11).
//
// The three `projectionState` values are the whole point of this module: `unavailable` and
// `migration-required` both arrive with a null value, so a client that only checks "did I get data"
// would show an empty team when the Host is really saying "not yet". Every case is asserted here,
// including the wire frame the Host actually receives.

import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import type { CompanionClient } from '../src/core/client';
import { CoreError } from '../src/core/errors';
import { readAgentTeam, readSubagents, type TeamRead } from '../src/core/team';

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

describe('readAgentTeam', () => {
  it('sends the documented frame through the non-op opt-in and returns the members and tasks', async () => {
    const team = { members: [{ id: 'lead' }, { id: 'm1' }], tasks: [{ id: 't1', state: 'running' }] };
    const { client, sent } = clientAnswering({
      kind: 'agent-team',
      sessionId: SESSION,
      requestId: 'r1',
      projectionState: 'ready',
      asOfSeq: 42,
      agentTeam: team,
    });

    const result = await readAgentTeam(client, SESSION);

    assert.deepEqual(sent[0], { op: 'agent-team', params: { sessionId: SESSION }, options: { allowNonOpType: true } });
    assert.deepEqual(result, { state: 'ready', asOfSeq: 42, value: team });
  });

  it('reports `unavailable` (NOT empty data, NOT an error) when the Host has no projection yet', async () => {
    const { client } = clientAnswering({
      kind: 'agent-team',
      sessionId: SESSION,
      projectionState: 'unavailable',
      agentTeam: null,
    });

    assert.deepEqual(await readAgentTeam(client, SESSION), { state: 'unavailable' });
  });

  it('reports `migration-required` as its own state, never as unavailable', async () => {
    const { client } = clientAnswering({
      kind: 'agent-team',
      sessionId: SESSION,
      projectionState: 'migration-required',
      agentTeam: null,
    });

    const result = await readAgentTeam(client, SESSION);
    assert.equal(result.state, 'migration-required');
    assert.notEqual(result.state, 'unavailable');
  });

  it('keeps `asOfSeq` when the Host sends one, and omits it otherwise', async () => {
    const withSeq = clientAnswering({ kind: 'agent-team', sessionId: SESSION, projectionState: 'unavailable', asOfSeq: 7 });
    assert.deepEqual(await readAgentTeam(withSeq.client, SESSION), { state: 'unavailable', asOfSeq: 7 });

    const withoutSeq = clientAnswering({ kind: 'agent-team', sessionId: SESSION, projectionState: 'unavailable' });
    assert.deepEqual(await readAgentTeam(withoutSeq.client, SESSION), { state: 'unavailable' });
  });

  it('rejects a ready reply whose payload is malformed instead of handing it to the UI', async () => {
    for (const agentTeam of [{ members: [], tasks: 'no' }, { members: {} }, null, 'x']) {
      const { client } = clientAnswering({ kind: 'agent-team', sessionId: SESSION, projectionState: 'ready', agentTeam });
      await assert.rejects(readAgentTeam(client, SESSION), (error: unknown) => {
        assert.ok(error instanceof CoreError);
        assert.equal((error as CoreError).code, 'client/bad-message');
        return true;
      }, JSON.stringify(agentTeam));
    }
  });

  it('rejects an unknown projectionState rather than treating it as ready', async () => {
    const { client } = clientAnswering({ kind: 'agent-team', sessionId: SESSION, projectionState: 'something-new', agentTeam: { members: [], tasks: [] } });
    await assert.rejects(readAgentTeam(client, SESSION), /unknown projection state/);
  });

  it('rejects a reply about a DIFFERENT session (it would render on the wrong screen)', async () => {
    const { client } = clientAnswering({
      kind: 'agent-team',
      sessionId: 'sess-other',
      projectionState: 'ready',
      agentTeam: { members: [], tasks: [] },
    });
    await assert.rejects(readAgentTeam(client, SESSION), /different session/);
  });

  it('turns a Host error frame into a typed error that keeps the Host code', async () => {
    const { client } = clientAnswering({ kind: 'error', code: 'session/not-found', message: 'session not found', requestType: 'agent-team' });
    await assert.rejects(readAgentTeam(client, SESSION), (error: unknown) => {
      assert.ok(error instanceof CoreError);
      assert.equal((error as CoreError).code, 'session/not-found');
      return true;
    });
  });

  it('refuses a blank session id before sending anything', async () => {
    const { client, sent } = clientAnswering({ kind: 'agent-team', sessionId: '', projectionState: 'unavailable' });
    await assert.rejects(readAgentTeam(client, '  '), (error: unknown) => {
      assert.equal((error as CoreError).code, 'client/bad-state');
      return true;
    });
    assert.equal(sent.length, 0, 'nothing reached the socket');
  });
});

describe('readSubagents', () => {
  it('reads the catalog with the same envelope rules', async () => {
    const catalog = [{ name: 'scout' }, { name: 'reviewer' }];
    const { client, sent } = clientAnswering({
      kind: 'subagents',
      sessionId: SESSION,
      projectionState: 'ready',
      asOfSeq: 3,
      subagentCatalog: catalog,
    });

    const result = await readSubagents(client, SESSION);

    assert.deepEqual(sent[0], { op: 'subagents', params: { sessionId: SESSION }, options: { allowNonOpType: true } });
    assert.deepEqual(result, { state: 'ready', asOfSeq: 3, value: catalog });
  });

  it('reports unavailable and migration-required as distinct states', async () => {
    const unavailable = clientAnswering({ kind: 'subagents', sessionId: SESSION, projectionState: 'unavailable', subagentCatalog: null });
    assert.equal((await readSubagents(unavailable.client, SESSION)).state, 'unavailable');

    const migration = clientAnswering({ kind: 'subagents', sessionId: SESSION, projectionState: 'migration-required', subagentCatalog: null });
    assert.equal((await readSubagents(migration.client, SESSION)).state, 'migration-required');
  });

  it('rejects a catalog that is not an array', async () => {
    const { client } = clientAnswering({ kind: 'subagents', sessionId: SESSION, projectionState: 'ready', subagentCatalog: { entries: [] } });
    await assert.rejects(readSubagents(client, SESSION), /unexpected shape/);
  });

  it('a transport failure surfaces as itself (the caller decides about retrying)', async () => {
    const { client } = clientAnswering(new CoreError({ code: 'client/disconnected', message: 'Socket closed', retryable: true }));
    await assert.rejects(readSubagents(client, SESSION), (error: unknown) => {
      assert.equal((error as CoreError).code, 'client/disconnected');
      return true;
    });
  });
});

describe('TeamRead type', () => {
  it('only the ready variant carries a value (checked at compile time, asserted here for readers)', () => {
    const results: TeamRead<number>[] = [{ state: 'ready', value: 1 }, { state: 'unavailable' }, { state: 'migration-required' }];
    assert.deepEqual(results.map((r) => r.state), ['ready', 'unavailable', 'migration-required']);
    assert.equal('value' in results[0]!, true);
    assert.equal('value' in results[1]!, false);
  });
});
