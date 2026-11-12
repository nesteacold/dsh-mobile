// Spec 018 item 5 — the goal / task-list projections the gateway broadcasts (`projection-baseline`,
// `tasks-updated`, `goal-updated`). Shapes pinned from the authoritative text
// (`plugins/mobile-gateway/PROTOCOL.md:939-1021`, `:1197-1201`) and the Host builder
// (`plugins/mobile-gateway/lib/index.mjs:7004-7047`).
//
// The rule under test is tolerance, not validation: the Host decides what a projection contains, so
// every odd shape here must decode to something drawable or to "nothing" — never throw, never invent
// a task or a goal, and never let an older `asOfSeq` overwrite a newer value (per key, per session).

import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import {
  EMPTY_SESSION_PANEL,
  panelFromBaseline,
  panelFromUpdate,
  parseGoal,
  parseProjectionBaseline,
  parseTodo,
  parseTodos,
  projectionUpdateKind,
} from '../src/core';

describe('parseTodo / parseTodos', () => {
  it('reads the documented todo record: text and the three statuses', () => {
    const rows = parseTodos([
      { content: 'Check the Android SDK', status: 'completed' },
      { content: 'Create the project', status: 'in_progress' },
      { content: 'Build the APK', status: 'pending' },
    ]);
    assert.deepEqual(rows, [
      { text: 'Check the Android SDK', status: 'completed' },
      { text: 'Create the project', status: 'in_progress' },
      { text: 'Build the APK', status: 'pending' },
    ]);
  });

  it('keeps a status it does not know as `unknown` instead of guessing one of the three', () => {
    assert.equal(parseTodo({ content: 'x', status: 'rejected' })?.status, 'unknown');
    assert.equal(parseTodo({ content: 'x' })?.status, 'unknown');
    assert.equal(parseTodo({ content: 'x', status: 7 })?.status, 'unknown');
  });

  it('drops a record with no usable text (no invented "(untitled)" row)', () => {
    assert.equal(parseTodo({ status: 'pending' }), null);
    assert.equal(parseTodo({ content: '', status: 'pending' }), null);
    assert.equal(parseTodo({ content: '   ', status: 'pending' }), null);
    assert.equal(parseTodo(null), null);
    assert.equal(parseTodo('a string todo'), null);
    assert.equal(parseTodo(['not', 'a', 'record']), null);
    assert.deepEqual(parseTodos([{ status: 'pending' }, { content: 'ok', status: 'pending' }]), [
      { text: 'ok', status: 'pending' },
    ]);
  });

  it('keeps text verbatim — no trimming, no truncation (the Host owns the wording)', () => {
    const long = 'x'.repeat(500);
    assert.equal(parseTodo({ content: long, status: 'pending' })?.text, long);
    assert.equal(parseTodo({ content: '  padded  ', status: 'pending' })?.text, '  padded  ');
  });

  it('distinguishes an absent list (null) from an empty one the Host sent ([])', () => {
    assert.equal(parseTodos(null), null);
    assert.equal(parseTodos(undefined), null);
    assert.equal(parseTodos({}), null);
    assert.equal(parseTodos('nope'), null);
    assert.deepEqual(parseTodos([]), []);
  });
});

describe('parseGoal', () => {
  const documentGoal = {
    goal: { id: 'goal-opaque-id', revision: 7, objective: 'Initialise an Android app', phase: 'active', maxGoalRounds: 12 },
    roundsStarted: 3,
    createdAt: 1_787_111_700_000,
    updatedAt: 1_787_111_800_000,
  };

  it('reads the documented goal projection (objective + phase under the re-used `goal` key)', () => {
    assert.deepEqual(parseGoal(documentGoal), { objective: 'Initialise an Android app', phase: 'active' });
  });

  it('reads a bare goal record too, rather than calling a readable objective "no goal"', () => {
    assert.deepEqual(parseGoal({ objective: 'Ship the PWA', phase: 'paused' }), { objective: 'Ship the PWA', phase: 'paused' });
  });

  it('answers null when there is no current goal or nothing usable to show', () => {
    assert.equal(parseGoal(null), null);
    assert.equal(parseGoal(undefined), null);
    assert.equal(parseGoal({}), null);
    assert.equal(parseGoal({ goal: null }), null);
    assert.equal(parseGoal({ goal: { objective: '' } }), null);
    assert.equal(parseGoal({ goal: { objective: 42 } }), null);
    assert.equal(parseGoal('a goal string'), null);
    // The wrapper present but without an objective: not drawn, never guessed from other fields.
    assert.equal(parseGoal({ roundsStarted: 3, createdAt: 1 }), null);
  });

  it('keeps a phase it does not know (a phase word is data, not a fixed enum)', () => {
    assert.deepEqual(parseGoal({ goal: { objective: 'x', phase: 'blocked' } })?.phase, 'blocked');
    assert.equal(parseGoal({ goal: { objective: 'x' } })?.phase, null);
  });
});

describe('parseProjectionBaseline', () => {
  it('maps every session to its cut point and its two projections', () => {
    const panels = parseProjectionBaseline({
      's1': { asOfSeq: 40, values: { todos: [{ content: 'a', status: 'pending' }], goal: { goal: { objective: 'o', phase: 'active' } }, turnOutline: null } },
      's2': { asOfSeq: 7, values: { todos: null, goal: null } },
    });
    assert.ok(panels !== null);
    assert.equal(panels.get('s1')?.todos?.[0]?.text, 'a');
    assert.equal(panels.get('s1')?.goal?.objective, 'o');
    assert.equal(panels.get('s1')?.todosAsOfSeq, 40);
    assert.equal(panels.get('s1')?.goalAsOfSeq, 40, 'a baseline names ONE cut point for both keys');
    assert.deepEqual(panels.get('s2'), {
      todos: null,
      goal: null,
      todosAsOfSeq: 7,
      goalAsOfSeq: 7,
    });
  });

  it('skips one malformed session without voiding the others', () => {
    const panels = parseProjectionBaseline({
      bad: { values: null },
      worse: 'not an object',
      'no-seq': { values: { todos: [] } },
      good: { asOfSeq: 3, values: { todos: [] } },
    });
    assert.ok(panels !== null);
    assert.deepEqual([...panels.keys()].sort(), ['good', 'no-seq']);
    assert.equal(panels.get('no-seq')?.todosAsOfSeq, null, 'an unsafe asOfSeq is unknown, not zero');
    assert.deepEqual(panels.get('good')?.todos, []);
  });

  it('answers null for something that is not a session map — never throws', () => {
    for (const value of [null, undefined, 'x', 42, [], [{ asOfSeq: 1 }]]) {
      assert.equal(parseProjectionBaseline(value), null, JSON.stringify(value));
    }
  });

  it('reads a deeper `values` only through the documented shape (an absent `goal` key is no goal)', () => {
    const panels = parseProjectionBaseline({ s1: { asOfSeq: 1, values: {} } });
    assert.deepEqual(panels?.get('s1'), { todos: null, goal: null, todosAsOfSeq: 1, goalAsOfSeq: 1 });
  });
});

describe('panelFromBaseline', () => {
  it('picks this session out of a whole control set', () => {
    const frame = {
      kind: 'projection-baseline',
      projections: {
        'sess-alpha': { asOfSeq: 12, values: { todos: [{ content: 'deploy', status: 'in_progress' }], goal: { goal: { objective: 'release', phase: 'active' } } } },
        'sess-beta': { asOfSeq: 9, values: { todos: null, goal: null } },
      },
    };
    const panel = panelFromBaseline(frame, 'sess-alpha');
    assert.equal(panel?.todos?.[0]?.status, 'in_progress');
    assert.equal(panel?.goal?.objective, 'release');
  });

  it('answers the empty panel when the control set does not include this session', () => {
    // PROTOCOL.md:761 — the baseline covers the Host's control set only; a cold session is missing
    // from it and that is NOT a deletion, so the screen must read "nothing projected yet".
    const frame = { kind: 'projection-baseline', projections: { 'sess-beta': { asOfSeq: 9, values: {} } } };
    assert.deepEqual(panelFromBaseline(frame, 'sess-alpha'), EMPTY_SESSION_PANEL);
  });

  it('answers null for another frame kind or an unusable session id', () => {
    const frame = { kind: 'projection-baseline', projections: {} };
    assert.equal(panelFromBaseline({ kind: 'tasks-updated', sessionId: 's1', todos: [] }, 's1'), null);
    assert.equal(panelFromBaseline(frame, ''), null);
    const broken = { kind: 'projection-baseline', projections: 'not a map' };
    assert.equal(panelFromBaseline(broken, 's1'), null);
  });
});

describe('panelFromUpdate', () => {
  const previous = {
    todos: [{ text: 'old', status: 'pending' as const }],
    goal: { objective: 'old goal', phase: 'active' },
    todosAsOfSeq: 10,
    goalAsOfSeq: 10,
  };

  it('replaces the task list only, keeping the goal it does not carry', () => {
    const next = panelFromUpdate(
      { kind: 'tasks-updated', sessionId: 's1', asOfSeq: 43, todos: [{ content: 'new', status: 'completed' }] },
      's1',
      previous,
    );
    assert.deepEqual(next?.todos, [{ text: 'new', status: 'completed' }]);
    assert.deepEqual(next?.goal, previous.goal);
    assert.equal(next?.todosAsOfSeq, 43);
    assert.equal(next?.goalAsOfSeq, 10, 'the goal was not re-projected');
  });

  it('replaces the goal only, and a null goal clears it', () => {
    const next = panelFromUpdate(
      { kind: 'goal-updated', sessionId: 's1', asOfSeq: 44, goal: { goal: { objective: 'new goal', phase: 'active' } } },
      's1',
      previous,
    );
    assert.equal(next?.goal?.objective, 'new goal');
    assert.deepEqual(next?.todos, previous.todos);
    const cleared = panelFromUpdate({ kind: 'goal-updated', sessionId: 's1', asOfSeq: 45, goal: null }, 's1', next ?? undefined);
    assert.equal(cleared?.goal, null);
    assert.equal(cleared?.goalAsOfSeq, 45);
  });

  it('ignores a frame that is older than what we hold — per key', () => {
    // An older tasks frame loses even though it names a newer seq than the GOAL's cut point: the
    // compare is per (sessionId, key), exactly what PROTOCOL.md:763 warns about.
    const stale = panelFromUpdate({ kind: 'tasks-updated', sessionId: 's1', asOfSeq: 5, todos: [] }, 's1', previous);
    assert.equal(stale, null);
    const fresh = panelFromUpdate({ kind: 'goal-updated', sessionId: 's1', asOfSeq: 11, goal: null }, 's1', previous);
    assert.equal(fresh?.goal, null, 'a newer goal cut point is newer than the shared baseline point');
    // Equal cut point: applied (the Host re-sent the same point; the value is authoritative).
    const equal = panelFromUpdate({ kind: 'tasks-updated', sessionId: 's1', asOfSeq: 10, todos: [] }, 's1', previous);
    assert.deepEqual(equal?.todos, []);
  });

  it('ignores an update for another session — a panel is per session', () => {
    assert.equal(
      panelFromUpdate({ kind: 'tasks-updated', sessionId: 's2', asOfSeq: 99, todos: [] }, 's1', previous),
      null,
    );
    assert.equal(
      panelFromUpdate({ kind: 'tasks-updated', sessionId: '', asOfSeq: 99, todos: [] }, 's1', previous),
      null,
    );
    assert.equal(panelFromUpdate({ kind: 'question-requested', sessionId: 's1' }, 's1', previous), null);
  });

  it('still applies a value when the frame carries no usable asOfSeq (the Host never does this)', () => {
    const next = panelFromUpdate({ kind: 'tasks-updated', sessionId: 's1', todos: [] }, 's1', undefined);
    assert.deepEqual(next?.todos, []);
    assert.equal(next?.todosAsOfSeq, null);
    assert.deepEqual(next?.goal, null);
  });

  it('treats an unknown todos value as "nothing projected", never as a task list', () => {
    const next = panelFromUpdate({ kind: 'tasks-updated', sessionId: 's1', asOfSeq: 50, todos: { nope: true } }, 's1', previous);
    assert.equal(next?.todos, null);
  });
});

describe('projectionUpdateKind', () => {
  it('names only the two documented update kinds', () => {
    assert.equal(projectionUpdateKind('tasks-updated'), 'todos');
    assert.equal(projectionUpdateKind('goal-updated'), 'goal');
    for (const other of ['projection-baseline', 'turn-outline-updated', 'agent-team-updated', 'event', null, 42]) {
      assert.equal(projectionUpdateKind(other), null, String(other));
    }
  });
});
