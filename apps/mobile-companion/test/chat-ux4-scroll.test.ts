// chat-ux4 — PWA conversation UX fixes.
//   * the opening "jump to newest" is driven by a PURE state machine: a resolved history page only
//     schedules it; only a later transcript layout (or a generation-guarded fallback) lands it;
//   * the jump-down chevron is drawn with borders, not a font glyph, and keeps its button contract.
// The jump sequence is exercised behaviourally with a spy on the machine's commands (no source regex).

import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { describe, it } from 'node:test';
import { fileURLToPath } from 'node:url';

import {
  createInitialScrollState,
  initialScrollStep,
  type InitialScrollCommand,
  type InitialScrollEvent,
  type InitialScrollState,
} from '../app/session/[id]';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const BUTTON = readFileSync(path.join(ROOT, 'src', 'ui', 'conversation', 'ScrollToBottomButton.tsx'), 'utf8');

/** Drive the actual machine and record the side effects a screen would carry out for its commands. */
function driver() {
  let state: InitialScrollState = createInitialScrollState();
  const calls: string[] = [];
  const send = (event: InitialScrollEvent): InitialScrollCommand => {
    const step = initialScrollStep(state, event);
    state = step.state;
    if (step.command.kind === 'scroll-to-end') calls.push('scrollToEnd');
    return step.command;
  };
  return {
    send,
    calls,
    get state(): InitialScrollState { return state; },
    /** The prependRestore branch's own imperative scroll (never a scrollToEnd). */
    prependRestore(): void { calls.push('scrollTo'); },
  };
}

describe('opening jump — pure coordinator behaviour (chat-ux4)', () => {
  it('a spinner height never lands the jump; only the late transcript layout does, exactly once', () => {
    const d = driver();
    // While the page is loading, a spinner/old view reports a positive height.
    d.send({ kind: 'history', sessionId: 's1', loaded: false, loading: true });
    d.send({ kind: 'layout', sessionId: 's1', generation: d.state.generation, height: 240 });
    assert.deepEqual(d.calls, [], 'no scroll before a complete history page');
    assert.equal(d.state.pending === null, true, 'no pending jump was scheduled by the spinner');
    assert.equal(d.state.doneFor, null);

    // The opening page resolves: SCHEDULE only. No imperative scroll, no done mark.
    const scheduled = d.send({ kind: 'history', sessionId: 's1', loaded: true, loading: false });
    assert.equal(scheduled.kind, 'schedule-fallback');
    assert.deepEqual(d.calls, [], 'resolving history must not scroll yet');
    assert.equal(d.state.doneFor, null, 'still not done before layout');
    const pending = d.state.pending;
    assert.ok(pending, 'a pending jump now exists');

    // The transcript layout arrives late, carrying the pending generation.
    d.send({ kind: 'layout', sessionId: 's1', generation: pending.generation, height: 900 });
    assert.deepEqual(d.calls, ['scrollToEnd'], 'exactly one jump');
    assert.equal(d.state.pending, null, 'pending cleared');
    assert.equal(d.state.doneFor, 's1', 'marked done only after the layout');

    // A duplicate layout event, a live-message re-render and a new history event cannot re-jump.
    d.send({ kind: 'layout', sessionId: 's1', generation: pending.generation, height: 1200 });
    d.send({ kind: 'history', sessionId: 's1', loaded: true, loading: false });
    assert.deepEqual(d.calls, ['scrollToEnd'], 'still exactly one');
  });

  it('a prepend only scrolls to the restored anchor, never to the end', () => {
    const d = driver();
    const scheduled = d.send({ kind: 'history', sessionId: 's1', loaded: true, loading: false });
    assert.equal(scheduled.kind, 'schedule-fallback');
    const gen = d.state.pending!.generation;
    d.send({ kind: 'layout', sessionId: 's1', generation: gen, height: 900 });
    assert.deepEqual(d.calls, ['scrollToEnd']);

    // An older page grows the content; the screen takes the prependRestore branch, whose layout
    // event has NO pending jump to consume and therefore emits no scroll-to-end command.
    const layoutAfterPrepend = d.send({ kind: 'layout', sessionId: 's1', generation: gen + 1, height: 1400 });
    assert.equal(layoutAfterPrepend.kind, 'none', 'no opening jump during a prepend');
    d.prependRestore();
    assert.deepEqual(d.calls, ['scrollToEnd', 'scrollTo'], 'only the anchor restore scrolls');
  });

  it('a new session resets pending and rejects the old generation and its stale fallback', () => {
    const d = driver();
    d.send({ kind: 'history', sessionId: 's1', loaded: true, loading: false });
    const oldGen = d.state.pending!.generation;
    assert.equal(d.send({ kind: 'fallback', sessionId: 's1', generation: oldGen }).kind, 'scroll-to-end');
    assert.deepEqual(d.calls, ['scrollToEnd']);

    // Opening s2 invalidates any pending jump / fallback from s1.
    d.send({ kind: 'session', sessionId: 's2' });
    assert.equal(d.state.pending, null);
    const scheduled = d.send({ kind: 'history', sessionId: 's2', loaded: true, loading: false });
    assert.equal(scheduled.kind, 'schedule-fallback');
    const newGen = d.state.pending!.generation;
    assert.ok(newGen > oldGen, 'a fresh generation guards the new session');

    // A stale fallback / layout carrying the previous generation cannot complete s2.
    assert.equal(d.send({ kind: 'fallback', sessionId: 's2', generation: oldGen }).kind, 'none');
    assert.equal(d.send({ kind: 'layout', sessionId: 's2', generation: oldGen, height: 800 }).kind, 'none');
    assert.deepEqual(d.calls, ['scrollToEnd'], 'no stale jump');

    // The current generation's fallback lands s2 once when no layout event ever arrives.
    assert.equal(d.send({ kind: 'fallback', sessionId: 's2', generation: newGen }).kind, 'scroll-to-end');
    assert.deepEqual(d.calls, ['scrollToEnd', 'scrollToEnd']);
    assert.equal(d.state.doneFor, 's2');
  });

  it('ignores zero-height layouts so a not-yet-laid-out view cannot consume the pending jump', () => {
    const d = driver();
    d.send({ kind: 'history', sessionId: 's1', loaded: true, loading: false });
    const gen = d.state.pending!.generation;
    assert.equal(d.send({ kind: 'layout', sessionId: 's1', generation: gen, height: 0 }).kind, 'none');
    assert.ok(d.state.pending, 'still pending after a zero-height layout');
    assert.deepEqual(d.calls, []);
    assert.equal(d.send({ kind: 'layout', sessionId: 's1', generation: gen, height: 480 }).kind, 'scroll-to-end');
    assert.deepEqual(d.calls, ['scrollToEnd']);
  });
});

describe('scroll-to-bottom chevron is drawn, not typed (chat-ux4)', () => {
  it('uses no font glyph and no Text node', () => {
    assert.ok(!BUTTON.includes('⌄'), 'the off-centre unicode glyph is gone');
    assert.ok(!/\bText\b/.test(BUTTON), 'no Text import / node');
    assert.match(BUTTON, /import \{ Pressable, StyleSheet, View \} from 'react-native';/);
  });

  it('draws a down chevron from two borders rotated 45deg', () => {
    assert.match(BUTTON, /borderRightWidth:\s*2/);
    assert.match(BUTTON, /borderBottomWidth:\s*2/);
    assert.match(BUTTON, /transform:\s*\[\{\s*rotate:\s*'45deg'\s*\}\]/);
  });

  it('centres with flex and preserves the control contract', () => {
    assert.match(BUTTON, /chevronWrap:\s*\{[^}]*alignItems:\s*'center'[^}]*justifyContent:\s*'center'/);
    assert.match(BUTTON, /testID="session-scroll-bottom"/);
    assert.match(BUTTON, /accessibilityRole="button"/);
    assert.match(BUTTON, /accessibilityLabel=\{label\}/);
    assert.match(BUTTON, /hitSlop=\{8\}/);
    assert.match(BUTTON, /width: hit/);
    assert.match(BUTTON, /height: hit/);
    assert.match(BUTTON, /borderRadius: radius\.circle/);
  });
});
