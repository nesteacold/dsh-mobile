// Spec 017 Đợt 2 (item 2) — the UI half of the agent-team screen.
//
// The client half (`src/core/team.ts`, `test/team-read.test.ts`) belongs to another agent and is not
// re-tested here. What IS pinned here is the presentation contract:
//   * `ready` / `unavailable` / `migration-required` / `failed` must stay distinguishable — a session
//     whose Host has not projected a team must never render as a team of zero members;
//   * the Host's pass-through records are untyped, so a missing or wrongly-typed field must degrade to
//     empty, never to `undefined` in the UI or a crash;
//   * a task's bulky `description` is collapsed to two lines and only expands on tap;
//   * a failure shows copy derived from the CODE, never the Host's internal message.

import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { describe, it } from 'node:test';

import {
  groupMembersByPhase,
  normalizeMember,
  normalizeSubagent,
  normalizeTask,
  taskTally,
  teamErrorCopy,
  toCatalogView,
  toTeamView,
} from '../src/ui/conversation/team-view';

const MEASURED_TEAM = {
  members: [
    { id: 'lead', name: 'lead', role: 'lead', phase: 'active' },
    { id: 'scout', name: 'footage-scout', role: 'teammate', phase: 'active' },
  ],
  tasks: [
    {
      id: 'task-1',
      revision: 2,
      subject: '素材勘察',
      description: '逐帧分析',
      status: 'in_progress',
      ownerName: 'footage-scout',
      blockedBy: [],
      writeScopes: ['promo/analysis'],
      ready: false,
      writeScopeWarnings: [],
    },
  ],
};

describe('team view — the three states stay distinguishable', () => {
  it('ready carries the members and tasks', () => {
    const view = toTeamView({ state: 'ready', asOfSeq: 7, value: MEASURED_TEAM });
    assert.equal(view.state, 'ready');
    assert.equal(view.asOfSeq, 7);
    assert.deepEqual(view.members.map((member) => member.name), ['lead', 'footage-scout']);
    assert.equal(view.tasks.length, 1, 'the measured task survives');
  });

  it('unavailable is NOT an empty team', () => {
    const view = toTeamView({ state: 'unavailable' });
    assert.equal(view.state, 'unavailable');
    assert.equal(view.members.length, 0);
    assert.notEqual(view.state, 'ready', 'a screen must be able to tell these apart');
  });

  it('migration-required is NOT unavailable', () => {
    const view = toTeamView({ state: 'migration-required', asOfSeq: 3 });
    assert.equal(view.state, 'migration-required');
    assert.notEqual(view.state, 'unavailable');
    assert.equal(view.asOfSeq, 3, 'asOfSeq is passed through when the Host sent one');
  });

  it('a catalog read uses the same three states', () => {
    assert.equal(toCatalogView({ state: 'ready', value: [{ id: 'scout', mode: 'continuable' }] }).entries.length, 1);
    assert.equal(toCatalogView({ state: 'unavailable' }).state, 'unavailable');
    assert.equal(toCatalogView({ state: 'migration-required' }).state, 'migration-required');
  });
});

describe('team view — untyped Host records degrade safely', () => {
  it('a member missing every field still yields stable keys and empty strings', () => {
    const member = normalizeMember({}, 3);
    assert.equal(member.id, 'member-3', 'synthesised id keeps React keys stable');
    assert.equal(member.name, '');
    assert.equal(member.role, '');
    assert.equal(member.phase, '');
  });

  it('wrongly-typed fields are ignored instead of leaking through', () => {
    const member = normalizeMember({ id: 42, name: { a: 1 }, role: null, phase: ['x'] } as never, 0);
    assert.equal(member.id, 'member-0');
    assert.equal(member.name, '');
    assert.equal(member.role, '');
    assert.equal(member.phase, '');
  });

  it('a task with no status is blocked only when the Host says so', () => {
    // No `status`, so these land in the unknown-status branch: the Host's blocker signals decide.
    assert.equal(normalizeTask({ ready: false }, 0).blocked, true, 'ready:false is blocked');
    assert.equal(normalizeTask({ blockedBy: ['t0'] }, 0).blocked, true, 'a blocker list is blocked');
    assert.equal(normalizeTask({ ready: true, blockedBy: [] }, 0).blocked, false);
    assert.equal(normalizeTask({}, 0).blocked, false, 'an absent flag is not a block');
    assert.equal(normalizeTask({ ready: 'no' }, 0).blocked, false, 'only a boolean false counts');
  });

  it('non-string blockers are dropped', () => {
    const task = normalizeTask({ blockedBy: ['a', 2, null] }, 0);
    assert.deepEqual(task.blockedBy, ['a']);
  });

  it('a sub-agent entry falls back to its id when it has no label', () => {
    assert.equal(normalizeSubagent({ id: 'scout' }, 0).label, undefined);
    assert.equal(normalizeSubagent({ id: 'scout', label: '分析' }, 0).label, '分析');
    assert.equal(normalizeSubagent({}, 2).id, 'subagent-2');
  });
});

describe('team view — grouping and counts', () => {
  it('groups members by phase in Host order', () => {
    const groups = groupMembersByPhase([
      { id: 'a', name: 'a', role: '', phase: 'active' },
      { id: 'b', name: 'b', role: '', phase: 'done' },
      { id: 'c', name: 'c', role: '', phase: 'active' },
    ]);
    assert.deepEqual(groups.map((group) => group.phase), ['active', 'done'], 'first-seen order');
    assert.deepEqual(groups[0]?.members.map((member) => member.id), ['a', 'c']);
  });

  it('an empty phase is grouped under unknown instead of a blank heading', () => {
    const groups = groupMembersByPhase([{ id: 'a', name: 'a', role: '', phase: '' }]);
    assert.equal(groups[0]?.phase, 'unknown');
  });

  it('counts blocked tasks for the collapsed header', () => {
    const tasks = [normalizeTask({ ready: false }, 0), normalizeTask({ ready: true }, 1)];
    assert.deepEqual(taskTally(tasks), { total: 2, blocked: 1 });
  });

  it('the tally counts only tasks that are pending and not ready', () => {
    // The contract decides each card, not `ready` in isolation (agent-team-app-integration.md):
    //   task-1 completed,   ready:false          → never blocked (line 291: finished is ready:false)
    //   task-2 completed,   ready:false, blocker → never blocked (line 291)
    //   task-3 in_progress, ready:false          → never blocked (line 291: started is ready:false)
    //   task-4 pending,     ready:false          → BLOCKED (line 291: pending && !ready)
    //   task-5 pending,     ready:false, blocker → BLOCKED (line 291)
    //   task-6 pending,     ready:true,  blocker → not blocked (line 217: a finished dependency stays
    //                                              listed and the task is still ready)
    //   task-7 pending,     ready:false          → BLOCKED (line 291)
    const tasks = [
      normalizeTask({ id: 'task-1', status: 'completed', ready: false, blockedBy: [] }, 0),
      normalizeTask({ id: 'task-2', status: 'completed', ready: false, blockedBy: ['task-1'] }, 1),
      normalizeTask({ id: 'task-3', status: 'in_progress', ready: false, blockedBy: [] }, 2),
      normalizeTask({ id: 'task-4', status: 'pending', ready: false, blockedBy: [] }, 3),
      normalizeTask({ id: 'task-5', status: 'pending', ready: false, blockedBy: ['task-2'] }, 4),
      normalizeTask({ id: 'task-6', status: 'pending', ready: true, blockedBy: ['task-1'] }, 5),
      normalizeTask({ id: 'task-7', status: 'pending', ready: false, blockedBy: [] }, 6),
    ];
    assert.deepEqual(
      tasks.map((task) => task.blocked),
      [false, false, false, true, true, false, true],
      'per-task verdicts, in Host order',
    );
    assert.deepEqual(
      taskTally(tasks),
      { total: 7, blocked: 3 },
      'blocked: task-4, task-5, task-7 only; task-3 (started) and task-6 (ready) are not',
    );
  });
});

describe('team view — a finished task is never blocked', () => {
  it('completed with ready:false is not blocked', () => {
    const task = normalizeTask({ status: 'completed', ready: false, blockedBy: [] }, 0);
    assert.equal(task.blocked, false, 'ready:false on a finished task means "cannot start", not "blocked"');
  });

  it('completed with outstanding blockers is still not blocked', () => {
    const task = normalizeTask({ status: 'completed', ready: false, blockedBy: ['task-9'] }, 0);
    assert.equal(task.blocked, false);
    assert.deepEqual(task.blockedBy, ['task-9'], 'the Host facts stay visible in the detail view');
  });

  it('an in_progress task is never blocked, even though it is ready:false', () => {
    // Line 285/291: `ready` is true only for a claimable pending task, so every started task is
    // `ready:false` BY DESIGN. Reading that as blocked would mark every running task.
    assert.equal(normalizeTask({ status: 'in_progress', ready: false, blockedBy: [] }, 0).blocked, false);
    assert.equal(normalizeTask({ status: 'in_progress', blockedBy: [] }, 1).blocked, false);
    assert.equal(normalizeTask({ status: 'in_progress', ready: true, blockedBy: [] }, 2).blocked, false);
    assert.equal(
      normalizeTask({ status: 'in_progress', ready: false, blockedBy: ['task-1'] }, 3).blocked,
      false,
      'a blocker left over from before the task started does not make a running task blocked',
    );
  });

  it('pending with ready:false is blocked', () => {
    assert.equal(normalizeTask({ status: 'pending', ready: false, blockedBy: [] }, 0).blocked, true);
    assert.equal(normalizeTask({ status: 'pending', ready: false, blockedBy: ['task-1'] }, 1).blocked, true);
  });

  it('pending with ready:true is not blocked, even with a non-empty blockedBy', () => {
    // Line 217: an empty-looking dependency list is not the signal — `ready` is. A pending task may
    // list dependencies that already finished and still be ready; counting `blockedBy.length` here
    // would mark a task the Host says can be claimed.
    const task = normalizeTask({ status: 'pending', ready: true, blockedBy: ['task-1'] }, 0);
    assert.equal(task.blocked, false);
    assert.deepEqual(task.blockedBy, ['task-1'], 'the Host facts stay visible in the detail view');
    assert.equal(normalizeTask({ status: 'pending', ready: true, blockedBy: [] }, 1).blocked, false);
  });

  it('pending without a ready flag is blocked', () => {
    // `ready` is required (line 285); a record missing it is malformed, and the safe read of
    // "the Host did not say this can be claimed" is blocked.
    assert.equal(normalizeTask({ status: 'pending', blockedBy: [] }, 0).blocked, true);
  });

  it('an unknown or future status keeps the Host signals instead of hiding a blocker', () => {
    // Outside the contract's statuses (line 281 asks decoders to tolerate `deleted` and future
    // values), so this is our choice: show a possible blocker rather than clear it.
    assert.equal(normalizeTask({ status: 'deleted', ready: false }, 0).blocked, true);
    assert.equal(normalizeTask({ status: 'awaiting_review', ready: false }, 0).blocked, true);
    assert.equal(normalizeTask({ status: 'awaiting_review', blockedBy: ['task-1'] }, 1).blocked, true);
    const untyped = normalizeTask({ ready: false }, 0);
    assert.equal(untyped.blocked, true, 'a missing status is not evidence of completion');
    assert.equal(
      normalizeTask({ status: 'awaiting_review', ready: true, blockedBy: [] }, 0).blocked,
      false,
      'with no Host blocker signal an unknown status is not marked blocked — the signal decides',
    );
  });
});

describe('team view — failures are explained by CODE, never by the Host message', () => {
  it('maps the codes the client can throw', () => {
    assert.equal(teamErrorCopy('session/not-found'), 'team.errorNotFound');
    assert.equal(teamErrorCopy('auth/revoked'), 'team.errorAuth');
    assert.equal(teamErrorCopy('client/bad-state'), 'team.errorGeneric');
    assert.equal(teamErrorCopy(undefined), 'team.errorGeneric');
  });

  it('the screen never renders a raw Host message', () => {
    const screen = readFileSync(new URL('../app/session/[id].tsx', import.meta.url), 'utf8');
    assert.doesNotMatch(screen, /error\.message/, 'the Host message is not shown');
    assert.match(screen, /teamErrorCopy\(code\)/, 'the code is mapped to copy');
  });

  it('the panel draws the mapped errorText, not a hard-coded generic sentence', () => {
    // A source read, not a render: the repo has no renderer. It pins the wiring that regressed —
    // `StateNotice` used to ignore `errorText`, so a specific code never reached the screen.
    const panel = readFileSync(new URL('../src/ui/conversation/AgentTeamPanel.tsx', import.meta.url), 'utf8');
    assert.match(panel, /errorText=\{team\.errorText\}/, 'the mapped copy is passed through');
    assert.match(panel, /\? errorText\s*: tr\('team\.errorGeneric'\)/, 'errorText wins, generic is the fallback');
    assert.doesNotMatch(panel, /error\.message/, 'the Host message still never leaks');
    // The state line is what the panel draws for `failed`, so `copy` (now errorText-aware) is reached.
    assert.match(panel, /\{asOfSeq === undefined \? copy :/, 'the selected copy is what gets drawn');
  });
});

describe('team screen — the description is collapsed, not dumped', () => {
  const panel = readFileSync(new URL('../src/ui/conversation/AgentTeamPanel.tsx', import.meta.url), 'utf8');

  it('a task description is limited to two lines and expands on tap', () => {
    assert.match(panel, /numberOfLines=\{expanded \? undefined : 2\}/, 'two lines by default');
    assert.match(panel, /onPress=\{\(\) => setOpenTask\(expanded \? null : task\.id\)\}/, 'tap toggles it');
    assert.match(panel, /accessibilityState=\{\{ expanded \}\}/, 'the state is announced');
  });

  it('members, tasks and the catalog have stable test hooks', () => {
    for (const hook of ['agent-team-members', 'agent-team-tasks', 'agent-team-catalog']) {
      assert.match(panel, new RegExp(`testID="${hook}"`), `${hook} exists`);
    }
  });
});
