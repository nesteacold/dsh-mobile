// Spec 018 item 3 — the READ-ONLY schedule frames (`schedule:read`).
//
// What must hold, and is asserted here: only the three read types are ever put on the wire; the
// app-wide list carries its bounded page; a Host error frame rejects with its code; a
// `schedule_not_found` answer is a structured `not-found`, not a fault; and the scope gate fails
// closed (an absent grant never lets a frame out).

import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import type { CompanionClient } from '../src/core/client';
import { CoreError } from '../src/core/errors';
import {
  SCHEDULE_PAGE_LIMIT,
  hasScheduleReadScope,
  parseScheduledTask,
  readScheduleCatalog,
  readScheduleList,
  readScheduleView,
  toCatalog,
  toScheduleList,
  toScheduleView,
} from '../src/core/schedules';

interface Sent {
  op: unknown;
  params: Record<string, unknown>;
  options?: { allowNonOpType?: boolean };
}

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

/** The record the gateway forwards verbatim (measured, `session-authoring-adversarial.test.mjs:1930`). */
const TASK = {
  id: 'task-1',
  kind: 'daily',
  title: 'nightly',
  active: true,
  status: 'active',
  time: '3:00',
  timeZone: 'UTC',
  weekdays: [1, 2],
  nextRunAt: 1_763_000_000_000,
  target: { sessionId: 's1' },
  updatedAt: 'rev-1',
  someUnknownRuleField: { kept: true },
};

describe('readScheduleList (host-wide)', () => {
  it('sends bounds with the page, and never a sessionId', async () => {
    const { client, sent } = clientAnswering({ kind: 'schedule-list', items: [TASK], shown: 1, total: 1, limit: 5, offset: 0 });
    const list = await readScheduleList(client, { limit: 5 });

    assert.deepEqual(sent[0], {
      op: 'schedule-list',
      params: { limit: 5, offset: 0 },
      options: { allowNonOpType: true },
    });
    assert.equal(list.state, 'ready');
    assert.equal(list.items.length, 1);
    assert.equal(list.total, 1);
    assert.equal(list.limit, 5);
  });

  it('asks for the gateway maximum by default and forwards `active` only as a boolean', async () => {
    const { client, sent } = clientAnswering({ kind: 'schedule-list', items: [] });
    await readScheduleList(client);
    assert.equal(sent[0]?.params.limit, SCHEDULE_PAGE_LIMIT);
    assert.equal('active' in (sent[0]?.params ?? {}), false);

    const second = clientAnswering({ kind: 'schedule-list', items: [] });
    await readScheduleList(second.client, { active: true });
    assert.equal(second.sent[0]?.params.active, true);
  });

  it('parses a task into the fields the UI draws, and keeps the Host rule fields', async () => {
    const { client } = clientAnswering({ kind: 'schedule-list', items: [TASK] });
    const list = await readScheduleList(client);
    const task = list.items[0];
    assert.ok(task);
    assert.deepEqual(task, {
      id: 'task-1',
      kind: 'daily',
      title: 'nightly',
      status: 'active',
      active: true,
      everySeconds: null,
      time: '3:00',
      timeZone: 'UTC',
      weekdays: [1, 2],
      expression: null,
      scheduledAt: null,
      nextRunAt: 1_763_000_000_000,
      updatedAt: 'rev-1',
      targetSessionId: 's1',
    });
  });

  it('drops a row without an id (it could never be opened) and an unusable weekday', () => {
    const list = toScheduleList({
      kind: 'schedule-list',
      items: [{ title: 'no id' }, { id: 'ok', weekdays: [0, 8, '1', 3] }],
    });
    assert.deepEqual(list.items.map((task) => task.id), ['ok']);
    assert.deepEqual(list.items[0]?.weekdays, [3]);
  });

  it('rejects an out-of-range page before the wire', async () => {
    const { client, sent } = clientAnswering({ kind: 'schedule-list', items: [] });
    await assert.rejects(readScheduleList(client, { limit: 0 }), (error: unknown) => error instanceof CoreError && error.code === 'client/bad-state');
    await assert.rejects(readScheduleList(client, { limit: 501 }), (error: unknown) => error instanceof CoreError && error.code === 'client/bad-state');
    await assert.rejects(readScheduleList(client, { offset: -1 }), (error: unknown) => error instanceof CoreError && error.code === 'client/bad-state');
    assert.deepEqual(sent, [], 'nothing was sent');
  });

  it('rejects a missing items array as a contract violation', async () => {
    const { client } = clientAnswering({ kind: 'schedule-list' });
    await assert.rejects(readScheduleList(client), (error: unknown) => error instanceof CoreError && error.code === 'client/bad-message');
  });

  it('rejects a scope refusal with the Host code (fail closed, never an empty list)', async () => {
    const { client } = clientAnswering({ kind: 'error', requestType: 'schedule-list', code: 'auth/forbidden-scope', scope: 'schedule:read', message: 'internal text' });
    await assert.rejects(readScheduleList(client), (error: unknown) => error instanceof CoreError && error.code === 'auth/forbidden-scope');
  });
});

describe('readScheduleCatalog', () => {
  it('reads the rule catalog with no arguments', async () => {
    const { client, sent } = clientAnswering({ kind: 'schedule-catalog', items: [{ kind: 'daily', label: 'daily' }] });
    const catalog = await readScheduleCatalog(client);
    assert.deepEqual(sent[0], { op: 'schedule-catalog', params: {}, options: { allowNonOpType: true } });
    assert.deepEqual(catalog.items, [{ kind: 'daily', label: 'daily' }]);
  });

  it('drops entries without a rule kind', () => {
    assert.deepEqual(toCatalog({ kind: 'schedule-catalog', items: [{ label: 'x' }, { kind: 'cron' }] }).items, [{ kind: 'cron', label: null }]);
  });
});

/** The gateway answers `{ ...identity, kind: msg.type, id, ...task }` (`schedule-management.mjs:96`):
 *  it spreads the task record AFTER the frame envelope, so on the wire the task's own rule `kind`
 *  overwrites the envelope's. Built in that order — the reply shape the Host actually sends.
 *  (TS2783 flags this deliberate overwrite; it is the measured shape and the case under test.) */
function viewReply(): Record<string, unknown> {
  return { kind: 'schedule-view', ...(TASK as Record<string, unknown>) };
}

describe('readScheduleView', () => {
  it('returns the task for this id', async () => {
    const { client, sent } = clientAnswering(viewReply());
    const result = await readScheduleView(client, 'task-1');
    assert.deepEqual(sent[0], { op: 'schedule-view', params: { id: 'task-1' }, options: { allowNonOpType: true } });
    assert.equal(result.state, 'ready');
    if (result.state === 'ready') assert.equal(result.task.id, 'task-1');
  });

  it('turns schedule_not_found into `not-found`, not an error', () => {
    assert.deepEqual(toScheduleView({ kind: 'schedule-view', id: 'task-1', code: 'schedule_not_found' }, 'task-1'), { state: 'not-found' });
  });

  it('rejects a reply about another task', async () => {
    const { client } = clientAnswering({ kind: 'schedule-view', id: 'task-2' });
    await assert.rejects(readScheduleView(client, 'task-1'), (error: unknown) => error instanceof CoreError && error.code === 'client/bad-message');
  });

  it('rejects an unknown structured code', () => {
    assert.throws(() => toScheduleView({ kind: 'schedule-view', id: 'task-1', code: 'schedule_conflict' }, 'task-1'), (error: unknown) => error instanceof CoreError && error.code === 'schedule_conflict');
  });

  it('refuses a blank id before the wire', async () => {
    const { client, sent } = clientAnswering(viewReply());
    await assert.rejects(readScheduleView(client, '  '), (error: unknown) => error instanceof CoreError && error.code === 'client/bad-state');
    assert.deepEqual(sent, []);
  });
});

describe('parseScheduledTask', () => {
  it('requires an id and never invents a missing field', () => {
    assert.equal(parseScheduledTask({ title: 'x' }), null);
    assert.equal(parseScheduledTask([]), null);
    const task = parseScheduledTask({ id: 'a' });
    assert.equal(task?.title, null);
    assert.equal(task?.nextRunAt, null);
    assert.equal(task?.targetSessionId, null);
  });
});

describe('hasScheduleReadScope', () => {
  it('grants only an explicit schedule:read entry', () => {
    assert.equal(hasScheduleReadScope(['sessions:read', 'schedule:read']), true);
  });

  it('fails closed for absent, empty or malformed grants', () => {
    assert.equal(hasScheduleReadScope(undefined), false);
    assert.equal(hasScheduleReadScope(null), false);
    assert.equal(hasScheduleReadScope([]), false);
    assert.equal(hasScheduleReadScope(['schedule:write']), false);
  });
});
