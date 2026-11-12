// Spec 018 item 5 — the session screen's goal line and task checklist, and the pure view that feeds
// them.
//
// There is no component renderer in this repo (see `test/ui-test-hooks.test.ts`), so the screen half
// is a **source** test: it reads `src/ui/conversation/SessionPanel.tsx` and
// `app/session/[id].tsx` and pins what a refactor would silently lose —
//   * the strip is drawn from `snapshot.openSessionPanel` (the Host's projections), never from a
//     local guess or a refetch;
//   * absent data hides the surface instead of drawing an empty card;
//   * the checklist is READ-ONLY: one disclosure control and nothing that writes;
//   * the strip is PINNED under the header, outside the transcript's scroller, so it does not scroll
//     away on a long session; opened, it scrolls inside its own capped window;
//   * every hook is static (no host text in a testID), and every string is i18n in both locales —
//     the Host's raw `message` never reaches the screen.

import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { describe, it } from 'node:test';
import { fileURLToPath } from 'node:url';

import { MESSAGES, LOCALES } from '../i18n';
import { EMPTY_SESSION_PANEL, type SessionPanel } from '../src/core';
import { PANEL_TASK_ROWS_MAX, taskStatusLabel, toSessionPanelView } from '../src/ui/read-only-views';
import { taskStatusMark, PANEL_EXPANDED_MIN_HEIGHT, PANEL_EXPANDED_SCREEN_SHARE, panelExpandedHeight } from '../src/ui/conversation/SessionPanel';

const APP_DIR = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const STRIP = readFileSync(path.join(APP_DIR, 'src', 'ui', 'conversation', 'SessionPanel.tsx'), 'utf8');
const SCREEN = readFileSync(path.join(APP_DIR, 'app', 'session', '[id].tsx'), 'utf8');

function count(haystack: string, needle: string): number {
  return haystack.split(needle).length - 1;
}

function hooks(source: string): string[] {
  const found: string[] = [];
  for (const match of source.matchAll(/testID=(?:"([^"]+)"|\{`([^`]+)`\})/g)) found.push(match[1] ?? match[2] ?? '');
  return found;
}

describe('toSessionPanelView', () => {
  const panel: SessionPanel = {
    todos: [
      { text: 'Check the Android SDK', status: 'completed' },
      { text: 'Create the project', status: 'in_progress' },
      { text: 'Build the APK', status: 'pending' },
      { text: 'Odd row', status: 'unknown' },
    ],
    goal: { objective: 'Initialise an Android app', phase: 'active' },
    todosAsOfSeq: 40,
    goalAsOfSeq: 40,
  };

  it('flattens the two projections into the one line and the rows the strip draws', () => {
    const view = toSessionPanelView(panel);
    assert.equal(view.goal, 'Initialise an Android app');
    assert.equal(view.goalPhase, 'active');
    assert.equal(view.tasksTotal, 4);
    assert.equal(view.tasksDone, 1, 'only `completed` counts as done');
    assert.deepEqual(view.tasks.map((task) => task.statusLabel), [
      'session.taskStatus.completed',
      'session.taskStatus.in-progress',
      'session.taskStatus.pending',
      'session.taskStatus.unknown',
    ]);
  });

  it('shows nothing for a session the Host projected nothing for', () => {
    assert.deepEqual(toSessionPanelView(EMPTY_SESSION_PANEL), {
      goal: null,
      goalPhase: null,
      tasks: [],
      tasksDone: 0,
      tasksTotal: 0,
      tasksHidden: 0,
    });
  });

  it('draws at most PANEL_TASK_ROWS_MAX rows, reports the rest, and counts the Host\'s whole list', () => {
    const rows = Array.from({ length: 120 }, (_, index) => ({
      text: `task ${index.toString()}`,
      status: index < 11 ? 'completed' as const : 'pending' as const,
    }));
    const view = toSessionPanelView({ ...EMPTY_SESSION_PANEL, todos: rows });
    assert.equal(view.tasks.length, PANEL_TASK_ROWS_MAX);
    assert.equal(view.tasksHidden, 120 - PANEL_TASK_ROWS_MAX);
    assert.equal(view.tasksTotal, 120, 'the summary reports what the Host sent, not what fits');
    assert.equal(view.tasksDone, 11, 'a done row beyond the cap still counts');
    assert.deepEqual(view.tasks.slice(0, 2).map((task) => task.text), ['task 0', 'task 1'], 'the Host\'s own order');

    // Exactly at the cap: nothing is hidden, so the strip draws no "+0 more" line.
    const exact = toSessionPanelView({ ...EMPTY_SESSION_PANEL, todos: rows.slice(0, PANEL_TASK_ROWS_MAX) });
    assert.equal(exact.tasks.length, PANEL_TASK_ROWS_MAX);
    assert.equal(exact.tasksHidden, 0);
  });

  it('an empty task list draws no checklist and a missing goal line is not invented', () => {
    const view = toSessionPanelView({ ...EMPTY_SESSION_PANEL, todos: [] });
    assert.equal(view.tasksTotal, 0);
    assert.equal(view.goal, null);
    assert.equal(view.tasksDone, 0);
  });

  it('a goal without a phase hides the phase word', () => {
    const view = toSessionPanelView({ ...EMPTY_SESSION_PANEL, goal: { objective: 'x', phase: null } });
    assert.equal(view.goal, 'x');
    assert.equal(view.goalPhase, null);
  });
});

describe('status words', () => {
  it('maps each status to its own key (the Host spelling never leaks into i18n)', () => {
    assert.equal(taskStatusLabel('pending'), 'session.taskStatus.pending');
    assert.equal(taskStatusLabel('in_progress'), 'session.taskStatus.in-progress');
    assert.equal(taskStatusLabel('completed'), 'session.taskStatus.completed');
    assert.equal(taskStatusLabel('unknown'), 'session.taskStatus.unknown');
  });

  it('gives every status its own fixed mark, so the state is not colour-only', () => {
    const marks = new Set(['pending', 'in_progress', 'completed', 'unknown'].map((status) =>
      taskStatusMark(status as Parameters<typeof taskStatusMark>[0])));
    assert.equal(marks.size, 4);
  });

  it('has copy for every status in both locales, all distinct', () => {
    for (const locale of LOCALES) {
      const words = (['pending', 'in_progress', 'completed', 'unknown'] as const).map((status) => {
        const key = taskStatusLabel(status === 'unknown' ? 'unknown' : status) as keyof (typeof MESSAGES)['en'];
        const value = MESSAGES[locale][key];
        assert.equal(typeof value, 'string', `${locale}:${key}`);
        return value as string;
      });
      assert.equal(new Set(words).size, 4, `${locale}: every status reads differently`);
    }
  });

  it('names both surfaces and the counter in both locales', () => {
    for (const locale of LOCALES) {
      for (const key of ['session.goal', 'session.tasksTitle', 'session.tasksDone', 'session.tasksMore'] as const) {
        assert.equal(typeof MESSAGES[locale][key], 'string');
        assert.ok((MESSAGES[locale][key] as string).trim() !== '', `${locale}:${key}`);
      }
    }
  });
});

describe('the strip is read-only and hides when absent', () => {
  it('renders the goal line and the checklist from the view only', () => {
    assert.match(STRIP, /tr\('session\.goal'\)/);
    assert.match(STRIP, /\{view\.goal\}/);
    assert.match(STRIP, /tr\(task\.statusLabel\)/);
    assert.match(STRIP, /numberOfLines=\{2\}/, 'the goal line is capped at two lines');
    assert.match(STRIP, /numberOfLines=\{3\}/, 'a task row is capped at three lines');
    assert.match(STRIP, /view\.tasksHidden > 0 \?/);
    assert.match(STRIP, /tr\('session\.tasksMore', \{ count: view\.tasksHidden \}\)/, 'hidden rows are counted');
  });

  it('draws no control but the disclosure', () => {
    assert.equal(count(STRIP, '<TouchableOpacity'), 1, 'one tappable: the checklist toggle');
    assert.equal(count(STRIP, 'onPress={onToggleTasks}'), 1);
    // Nothing that writes: no goal/tasks op, no approval, no mutation sent from this component.
    for (const forbidden of ['goal-edit', 'goal-pause', 'goal-resume', 'goal-clear', 'todo_write', 'request(', 'controller.']) {
      assert.equal(STRIP.includes(forbidden), false, `the strip must not ${forbidden}`);
    }
  });

  it('renders nothing for the two absent cases (checklist skipped when empty, strip skipped when empty)', () => {
    assert.match(STRIP, /\{view\.tasks\.length === 0 \? null : \(/);
    assert.match(STRIP, /\{view\.goal === null \? null : \(/);
  });

  it('scrolls the open checklist inside its own capped window, collapsed rows not drawn at all', () => {
    assert.equal(count(STRIP, '<ScrollView'), 1, 'one nested scroller: the open checklist');
    assert.match(STRIP, /maxHeight: panelExpandedHeight\(windowHeight\)/, 'the cap is the measured screen');
    assert.match(STRIP, /onLayout=\{\(event\) => setWindowHeight\(event\.nativeEvent\.layout\.height\)\}/);
    // Everything the open checklist draws lives INSIDE that window, the "+N more" line included.
    const scrollAt = STRIP.indexOf('<ScrollView');
    for (const inside of [/view\.tasks\.map\(/, /testID="session-tasks-more"/, /tr\(task\.statusLabel\)/]) {
      assert.ok(scrollAt < STRIP.search(inside), `${inside.toString()} is inside the capped window`);
    }
  });
});

describe('panelExpandedHeight', () => {
  it('caps the open checklist at a share of the measured screen', () => {
    assert.equal(PANEL_EXPANDED_SCREEN_SHARE, 0.4);
    assert.equal(panelExpandedHeight(800), 320);
  });

  it('keeps the cap usable on a short window, and the first frame before it is measured', () => {
    assert.equal(panelExpandedHeight(100), PANEL_EXPANDED_MIN_HEIGHT, 'floored, so a clipped list still scrolls');
    assert.equal(panelExpandedHeight(0), PANEL_EXPANDED_MIN_HEIGHT, 'an unmeasured window is never a zero-height list');
    assert.equal(panelExpandedHeight(300), 120);
  });
});

describe('the session screen wires the strip', () => {
  it('feeds it from the controller snapshot for the open session', () => {
    assert.match(SCREEN, /import \{ SessionPanelStrip \} from '\.\.\/\.\.\/src\/ui\/conversation\/SessionPanel'/);
    assert.match(SCREEN, /toSessionPanelView\(snapshot\.openSessionPanel\)/, 'the Host data, not a local copy');
    assert.match(SCREEN, /\{panelVisible \? \(/);
    assert.equal(count(SCREEN, '<SessionPanelStrip'), 1);
    assert.match(SCREEN, /const \[tasksOpen, setTasksOpen\] = useState\(false\)/, 'collapsed until the reader opens it');
  });

  it('sits pinned under the header, outside the transcript scroller — a long session cannot scroll it away', () => {
    const panelAt = SCREEN.indexOf('<SessionPanelStrip');
    assert.ok(panelAt > SCREEN.indexOf('testID="session-more"'), 'the strip follows the floating header');
    // Pinned: it is a sibling of the transcript's scroller, ahead of it, not a row inside it.
    assert.ok(panelAt < SCREEN.indexOf('<ScrollView\n'), 'the strip is drawn before the transcript scroller');
    const transcriptAt = SCREEN.indexOf('snapshot.historyHasEarlier');
    assert.ok(panelAt < transcriptAt, 'still above the older-history control');
    assert.ok(
      SCREEN.indexOf('testID="session-panel-pin"') < panelAt,
      'the strip is wrapped by the pinned container, which follows the header',
    );
    const transcriptClosed = SCREEN.indexOf('</ScrollView>', SCREEN.indexOf('<ScrollView\n'));
    assert.ok(transcriptClosed > transcriptAt, 'the transcript region is closed before the composer');
    assert.ok(SCREEN.indexOf('{panelVisible ? (') < SCREEN.indexOf('<ScrollView\n'), 'hidden with no projection');
    assert.ok(panelAt < SCREEN.indexOf('snapshot.openApprovals.map'));
    assert.ok(panelAt < SCREEN.indexOf('testID="session-send"'), 'never next to Send');
  });

  it('drops the transcript header band while the pinned panel carries it', () => {
    // The pinned panel's paddingTop already clears the floating header; leaving the transcript's
    // headerHeight+space.sm paddingTop on top of it drew an empty header-height band.
    assert.match(
      SCREEN,
      /paddingTop: panelVisible \? space\.sm : headerHeight \+ space\.sm/,
      'small gap under the panel, header clearance only without it',
    );
    assert.match(
      SCREEN,
      /paddingTop: headerHeight \+ space\.xs, paddingHorizontal: space\.lg \}[\s\S]{0,8}testID="session-panel-pin"/,
      'the pinned panel is what clears the floating header',
    );
  });
});

describe('hook shape', () => {
  it('uses only static hooks, and the ones the device flows can address', () => {
    const ids = hooks(STRIP);
    assert.ok(ids.length > 0);
    for (const id of ids) {
      assert.equal(id.includes('${'), false, `a hook must not embed host data: ${id}`);
      assert.match(id, /^[a-z][a-z0-9-]*$/, `hook ${id} is not a safe literal`);
    }
    for (const id of [
      'session-panel',
      'session-goal',
      'session-goal-text',
      'session-goal-phase',
      'session-tasks',
      'session-tasks-toggle',
      'session-tasks-count',
      'session-tasks-scroll',
      'session-tasks-more',
      'session-task',
    ]) {
      assert.equal(ids.filter((entry) => entry === id).length, 1, `${id} is rendered exactly once`);
    }
    for (const id of ids) {
      assert.equal(id.startsWith('session-'), true, 'the strip owns no other screen\'s hook');
    }
  });
});
