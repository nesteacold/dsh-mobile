// List filters in the `⋯` menu (Clarklevis parity): Date and Status.
//
// The rule under test is not only "does the predicate work" but "is the menu allowed to offer it".
// A filter with no data behind it must not appear at all — a dead menu row is worse than an absent
// one, and this app already shipped one dead affordance (a "load older" button that always failed).

import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { describe, it } from 'node:test';
import { fileURLToPath } from 'node:url';

import type { SessionSummary } from '../src/core/sessions';
import {
  applyListFilters,
  DATE_FILTERS,
  DEFAULT_LIST_FILTERS,
  detectArchiveCapability,
  filterByDate,
  filterByStatus,
  hasActiveFilters,
  LIST_FILTER_CAPABILITIES,
  STATUS_FILTERS,
} from '../src/ui/list-filters';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const SCREEN = readFileSync(path.join(ROOT, 'app', '(tabs)', 'index.tsx'), 'utf8');
const I18N = readFileSync(path.join(ROOT, 'i18n', 'index.ts'), 'utf8');
const MODULE = readFileSync(path.join(ROOT, 'src', 'ui', 'list-filters.ts'), 'utf8');

const NOW = new Date(2026, 10, 11, 19, 0, 0).getTime(); // 2026-11-11 19:00 local
const HOUR = 60 * 60 * 1000;
const DAY = 24 * HOUR;

function session(over: Partial<SessionSummary> & { id: string }): SessionSummary {
  return {
    title: over.id,
    state: 'idle',
    updatedAt: NOW - HOUR,
    needsDecision: false,
    ...over,
  } as SessionSummary;
}

const TODAY = session({ id: 'today', updatedAt: NOW - 2 * HOUR });
const YESTERDAY = session({ id: 'yesterday', updatedAt: NOW - 1 * DAY });
const THREE_DAYS = session({ id: 'three', updatedAt: NOW - 3 * DAY });
const LONG_AGO = session({ id: 'old', updatedAt: NOW - 30 * DAY });

describe('date buckets', () => {
  it('"today" means the calendar day, not the last 24 hours', () => {
    // 19:00 now; a session from 02:00 today is still "today" even though it is 17 h old, and one
    // from 23:00 yesterday is NOT — that is what a person means by the word.
    const earlyToday = session({ id: 'early', updatedAt: new Date(2026, 10, 11, 2, 0, 0).getTime() });
    const lateYesterday = session({ id: 'late', updatedAt: new Date(2026, 10, 10, 23, 0, 0).getTime() });
    const kept = filterByDate([earlyToday, lateYesterday], 'today', NOW).map((s) => s.id);
    assert.deepEqual(kept, ['early']);
  });

  it('"week" is today plus the 6 preceding days', () => {
    const kept = filterByDate([TODAY, YESTERDAY, THREE_DAYS, LONG_AGO], 'week', NOW).map((s) => s.id);
    assert.deepEqual(kept, ['today', 'yesterday', 'three']);
  });

  it('"older" is everything before that window', () => {
    const kept = filterByDate([TODAY, YESTERDAY, THREE_DAYS, LONG_AGO], 'older', NOW).map((s) => s.id);
    assert.deepEqual(kept, ['old']);
  });

  it('"any" keeps every row and does not mutate the input', () => {
    const input = [TODAY, LONG_AGO];
    const kept = filterByDate(input, 'any', NOW);
    assert.equal(kept.length, 2);
    assert.notEqual(kept, input, 'a fresh array, so callers cannot alias the store');
  });

  it('a row with no timestamp is dropped from dated buckets, never bucketed by guess', () => {
    const broken = session({ id: 'broken', updatedAt: Number.NaN });
    for (const filter of ['today', 'week', 'older'] as const) {
      assert.deepEqual(filterByDate([broken], filter, NOW).map((s) => s.id), [], filter);
    }
    assert.deepEqual(filterByDate([broken], 'any', NOW).map((s) => s.id), ['broken']);
  });
});

describe('status buckets', () => {
  it('splits running / idle by `state`, and `decision` by `needsDecision`', () => {
    const running = session({ id: 'r', state: 'running' });
    const idle = session({ id: 'i', state: 'idle' });
    const waiting = session({ id: 'd', state: 'running', needsDecision: true });
    assert.deepEqual(filterByStatus([running, idle, waiting], 'running').map((s) => s.id), ['r', 'd']);
    assert.deepEqual(filterByStatus([running, idle, waiting], 'idle').map((s) => s.id), ['i']);
    assert.deepEqual(filterByStatus([running, idle, waiting], 'decision').map((s) => s.id), ['d']);
  });

  it('"needs a decision" is its own axis, not a third state', () => {
    // An idle session can still be waiting for an approval; it must appear under `decision` and NOT
    // be relabelled as running.
    const idleWaiting = session({ id: 'iw', state: 'idle', needsDecision: true });
    assert.deepEqual(filterByStatus([idleWaiting], 'decision').map((s) => s.id), ['iw']);
    assert.deepEqual(filterByStatus([idleWaiting], 'running').map((s) => s.id), []);
  });
});

describe('combined filters and "is anything narrowing?"', () => {
  it('applies date and status together', () => {
    const runningToday = session({ id: 'rt', state: 'running', updatedAt: NOW - HOUR });
    const idleToday = session({ id: 'it', state: 'idle', updatedAt: NOW - HOUR });
    const runningOld = session({ id: 'ro', state: 'running', updatedAt: NOW - 30 * DAY });
    const kept = applyListFilters(
      [runningToday, idleToday, runningOld],
      { date: 'today', status: 'running' },
      NOW,
    ).map((s) => s.id);
    assert.deepEqual(kept, ['rt']);
  });

  it('reports when a filter is narrowing, so the menu can offer a clear', () => {
    assert.equal(hasActiveFilters(DEFAULT_LIST_FILTERS), false);
    assert.equal(hasActiveFilters({ date: 'today', status: 'any' }), true);
    assert.equal(hasActiveFilters({ date: 'any', status: 'running' }), true);
  });

  it('offers every value the predicates understand', () => {
    assert.deepEqual([...DATE_FILTERS], ['any', 'today', 'week', 'older']);
    assert.deepEqual([...STATUS_FILTERS], ['any', 'running', 'idle', 'decision']);
  });
});

describe('the menu only offers filters that have data', () => {
  it('archived and online are OFF today', () => {
    // archived needs `session-archives` / `archivedSessionIds` consumed (the gateway sends them,
    // index.mjs:123-125, this app does not read the frame yet); the wire has no per-session "online".
    assert.equal(LIST_FILTER_CAPABILITIES.archived, false);
    assert.equal(LIST_FILTER_CAPABILITIES.online, false);
  });

  it('the screen renders those two rows CONDITIONALLY, so nothing dead is shown', () => {
    assert.match(SCREEN, /LIST_FILTER_CAPABILITIES\.archived \?/);
    assert.match(SCREEN, /LIST_FILTER_CAPABILITIES\.online \?/);
    // The rows must sit inside a ternary on the capability, never as unconditional children.
    assert.equal(/testID="menu-(archived|online)"/.test(SCREEN), false,
      'no always-on archived/online menu row');
  });

  it('archive capability is detectable, so unhiding is a data change not a code rewrite', () => {
    assert.equal(detectArchiveCapability([TODAY]), false);
    assert.equal(detectArchiveCapability([session({ id: 'a', state: 'archived' })]), true);
  });

  it('the two hidden labels are translated in both locales already', () => {
    for (const key of ['list.filterArchived', 'list.filterOnline']) {
      const hits = (I18N.match(new RegExp(`'${key}':`, 'g')) ?? []).length;
      assert.equal(hits, 2, `${key} must exist in en AND vi`);
    }
  });
});

describe('every menu value is translated and reachable', () => {
  it('renders a row per Date and Status value with a STATIC literal testID', () => {
    // Static literals, not `menu-date-${value}`: the hook must not depend on a variable, so a flow
    // can name the row it taps and the hook-shape guard stays strict.
    for (const value of ['any', 'today', 'week', 'older']) {
      assert.match(SCREEN, new RegExp(`testID="menu-date-${value}"`), `menu-date-${value}`);
    }
    for (const value of ['any', 'running', 'idle', 'decision']) {
      assert.match(SCREEN, new RegExp(`testID="menu-status-${value}"`), `menu-status-${value}`);
    }
    // And no template-literal hook is left behind.
    assert.equal(/testID=\{`menu-(date|status)/.test(SCREEN), false, 'no dynamic filter hook');
  });

  it('all option keys exist in en and vi', () => {
    const keys = [
      'list.date.any', 'list.date.today', 'list.date.week', 'list.date.older',
      'list.status.any', 'list.status.running', 'list.status.idle', 'list.status.decision',
    ];
    for (const key of keys) {
      const hits = (I18N.match(new RegExp(`'${key}':`, 'g')) ?? []).length;
      assert.equal(hits, 2, `${key} must exist in en AND vi`);
    }
  });

  it('the filters run BEFORE the title search, so a search cannot resurrect a filtered row', () => {
    const searchedAt = SCREEN.indexOf('filterSessionsByTitle(');
    const applyAt = SCREEN.indexOf('applyListFilters(visible, filters');
    assert.notEqual(searchedAt, -1);
    assert.notEqual(applyAt, -1);
    assert.ok(applyAt > searchedAt, 'applyListFilters is the argument of filterSessionsByTitle');
  });

  it('the menu documents why the two rows are absent rather than leaving a silent gap', () => {
    // The reason must live in the code, not in someone's memory: both unlock conditions, named.
    assert.match(MODULE, /session-archives/);
    assert.match(MODULE, /per-session reachability field/);
    assert.match(MODULE, /stay OUT of the menu until the data lands/);
  });
});
