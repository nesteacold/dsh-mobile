// Spec 018 item 3 — the wiring of the read-only scheduled-tasks screen (`app/schedules.tsx`).
//
// The repo has no renderer, so this is a SOURCE read (the same technique `team-view.test.ts` uses).
// What is pinned is the sentence each answer maps to:
//   * a `{ state: 'unavailable' }` read — no ready socket or no `schedule:read` grant — is "not
//     available right now" (`schedules.notNow`), never the pairing-permission sentence and never an
//     empty list (`schedules.empty`), which would read as "there are no tasks";
//   * the permission sentence (`schedules.unavailable`) is only the locked screen, drawn when the
//     scope is absent, and costs no request;
//   * a thrown `CoreError` is reduced to its CODE via `scheduleErrorCopy`, with the generic sentence
//     as the fallback for an unknown code.

import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { describe, it } from 'node:test';

import { MESSAGES } from '../i18n';

const screen = readFileSync(new URL('../app/schedules.tsx', import.meta.url), 'utf8');

describe('schedules screen — the list read', () => {
  it('asks for the ACTIVE list only (the heading "Active" matches the request)', () => {
    assert.match(screen, /controller\.readSchedules\(\{ active: true \}\)/);
    assert.match(screen, /tr\('schedules\.status\.active'\)/, 'the heading names exactly what is listed');
  });

  it('an unavailable read says "not available right now", not the permission sentence', () => {
    assert.match(
      screen,
      /answer\.state === 'unavailable'[\s\S]*?setListError\('schedules\.notNow'\)/,
      'unavailable → schedules.notNow',
    );
    assert.doesNotMatch(
      screen,
      /answer\.state === 'unavailable'[\s\S]{0,200}setListError\('schedules\.unavailable'\)/,
      'the permission sentence is not the answer to an unavailable read',
    );
  });

  it('a thrown CoreError is explained by its CODE, generic only as the fallback', () => {
    assert.match(
      screen,
      /catch \(error\) \{\s*\/\/[\s\S]*?setListError\(scheduleErrorCopy\(\(error as \{ code\?: string \} \| null\)\?\.code\)\)/,
      'the catch maps the code through scheduleErrorCopy',
    );
    // `error.message` appears in the header comment only, as a statement that it is never rendered.
    assert.doesNotMatch(screen, /\{\s*error\.message\s*\}|tr\(error\.message\)/, 'the Host message is never rendered');
  });

  it('the detail read uses the same two branches', () => {
    assert.match(screen, /copy: 'schedules\.notNow'/, 'a detail unavailable read is the neutral sentence');
    assert.doesNotMatch(screen, /copy: 'schedules\.unavailable'/, 'and not the permission one');
  });
});

describe('schedules screen — the states that are not a read', () => {
  it('the permission sentence belongs to the locked screen alone', () => {
    assert.match(
      screen,
      /if \(!allowed\) \{[\s\S]*?tr\('schedules\.unavailable'\)/,
      'no grant ⇒ a plain statement, and no request',
    );
    const uses = screen.match(/tr\('schedules\.unavailable'\)/g) ?? [];
    assert.equal(uses.length, 1, 'schedules.unavailable is drawn in exactly one place');
  });

  it('the empty state says no ACTIVE tasks, since only active ones are listed', () => {
    assert.match(
      screen,
      /rows\.length === 0[\s\S]{0,300}tr\('schedules\.emptyActive'\)/,
      'empty → "No active scheduled tasks…"',
    );
    assert.doesNotMatch(screen, /\{tr\('schedules\.empty'\)\}/, 'the unqualified empty sentence is not used here');
  });

  it('the neutral sentence is not a permission claim, in either locale', () => {
    for (const locale of ['en', 'vi'] as const) {
      const copy = MESSAGES[locale]['schedules.notNow'];
      // `schedules.notNow` takes no parameters, so it is a plain string; prove it rather than cast.
      assert.equal(typeof copy, 'string', `${locale}: schedules.notNow is a plain message`);
      if (typeof copy !== 'string') continue;
      assert.ok(copy.trim() !== '', `${locale}: schedules.notNow is set`);
      assert.doesNotMatch(copy, /schedule:read|permission|quyền|ghép đôi|Pair/i, `${locale}: no permission wording`);
    }
  });
});
