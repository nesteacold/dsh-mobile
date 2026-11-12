// Spec 018 — presentation of the two read-only surfaces (`src/ui/read-only-views.ts`).
//
// The core passes `null` for every field the Host did not report, so this layer must not print
// `undefined`, must not turn an absent number into `0`, and must never surface Host text. The rule
// and next-run values are the Host's own; only their formatting happens here.

import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import { t, type Locale } from '../i18n';
import type { SessionStatsRead } from '../src/core/stats';
import type { ScheduledTask } from '../src/core/schedules';
import {
  contextPercent,
  formatCompact,
  formatCount,
  formatRunTime,
  ruleSummary,
  scheduleErrorCopy,
  scheduleStatusKey,
  statsErrorCopy,
  taskDetailRows,
  toStatsView,
  toTaskRow,
} from '../src/ui/read-only-views';

const tr = (key: Parameters<typeof t>[1], params?: Record<string, string | number>): string => t('en' as Locale, key, params);

const READY: SessionStatsRead = {
  state: 'ready',
  asOfSeq: 42,
  sessionStats: { turns: 6, steps: 69, llmMs: 2_280_000, toolMs: 41_400, ttftMs: 2_600, ttftSteps: 1, decodeMs: 5_000, decodeTokens: 385, lastTurn: 6, openStep: null },
  tokenUsage: { totals: { inputTokens: 1_234_567, outputTokens: 5, cacheReadTokens: 0, cacheWriteTokens: null, reasoningTokens: 385 } },
  contextPressure: { contextWindow: 128_000, pressureTokens: 1_500, surfaceTokens: 2_000 },
};

describe('number formatting', () => {
  it('groups whole counts without depending on Intl', () => {
    assert.equal(formatCount(6), '6');
    assert.equal(formatCount(69), '69');
    assert.equal(formatCount(1_234_567), '1 234 567');
    assert.equal(formatCount(-1_234), '-1 234');
    assert.equal(formatCount(Number.NaN), '–');
  });

  it('compacts past a thousand and keeps sub-thousands whole', () => {
    assert.equal(formatCompact(999), '999');
    assert.equal(formatCompact(1_500), '1.5k');
    assert.equal(formatCompact(2_000), '2k');
    assert.equal(formatCompact(1_234_567), '1.2M');
    assert.equal(formatCompact(0), '0');
  });

  it('reports context use as a percentage of the Host window, capped at 100%', () => {
    assert.equal(contextPercent({ contextWindow: 128_000, pressureTokens: 1_500, surfaceTokens: 2_000 }), '1.2%');
    assert.equal(contextPercent({ contextWindow: 100, pressureTokens: 250, surfaceTokens: null }), '100%');
    assert.equal(contextPercent({ contextWindow: 0, pressureTokens: 10, surfaceTokens: null }), null);
    assert.equal(contextPercent(null), null);
  });

  it('prints a next-run time as local HH:mm and refuses a non-time', () => {
    const stamp = new Date(2026, 10, 12, 9, 5, 0).getTime();
    assert.equal(formatRunTime(stamp), '09:05');
    assert.equal(formatRunTime(null), null);
    assert.equal(formatRunTime(0), null);
    assert.equal(formatRunTime(Number.NaN), null);
  });
});

describe('toStatsView', () => {
  it('builds the token, context and session sections from reported values only', () => {
    const view = toStatsView(READY, tr);
    assert.equal(view.state, 'ready');
    const sections = view.sections.map((section) => section.testID);
    assert.deepEqual(sections, ['stats-tokens', 'stats-context', 'stats-session']);

    const tokens = view.sections.find((section) => section.testID === 'stats-tokens');
    assert.deepEqual(tokens?.rows.map((row) => row.label), ['stats.input', 'stats.output', 'stats.cacheRead', 'stats.reasoning']);
    assert.deepEqual(tokens?.rows.map((row) => row.value), ['1.2M', '5', '0', '385'], 'an absent cache-write count is OMITTED, a reported 0 is shown');

    const context = view.sections.find((section) => section.testID === 'stats-context');
    assert.deepEqual(context?.rows.map((row) => row.value), ['128k', '1.5k (1.2%)']);

    const session = view.sections.find((section) => section.testID === 'stats-session');
    assert.deepEqual(session?.rows.map((row) => row.value), ['6', '69']);
  });

  it('skips a section whose projection is null rather than drawing an empty one', () => {
    const view = toStatsView({ state: 'ready', sessionStats: null, tokenUsage: null, contextPressure: READY.contextPressure }, tr);
    assert.deepEqual(view.sections.map((section) => section.testID), ['stats-context']);
  });

  it('a ready reply with all three projections null says "no data", not an empty sheet', () => {
    const view = toStatsView({ state: 'ready', sessionStats: null, tokenUsage: null, contextPressure: null }, tr);
    assert.equal(view.state, 'failed');
    assert.equal(view.errorText, tr('stats.noData'));
    assert.deepEqual(view.sections, []);
  });

  it('a usage whose totals are null contributes no token rows', () => {
    const view = toStatsView({ state: 'ready', sessionStats: READY.sessionStats, tokenUsage: { totals: null }, contextPressure: null }, tr);
    assert.deepEqual(view.sections.map((section) => section.testID), ['stats-session']);
  });
});

describe('error codes → fixed copy', () => {
  it('maps auth/* to the pairing sentence and anything else to the generic one', () => {
    assert.equal(statsErrorCopy('auth/forbidden-scope'), 'stats.errorAuth');
    assert.equal(statsErrorCopy('session-not-found'), 'stats.errorGeneric');
    assert.equal(statsErrorCopy(undefined), 'stats.errorGeneric');
    assert.equal(scheduleErrorCopy('auth/revoked'), 'schedules.errorAuth');
    assert.equal(scheduleErrorCopy('client/bad-message'), 'schedules.errorGeneric');
  });
});

const DAILY: ScheduledTask = {
  id: 'task-1', kind: 'daily', title: 'nightly', status: 'active', active: true, everySeconds: null,
  time: '3:00', timeZone: 'UTC', weekdays: [], expression: null, scheduledAt: null,
  nextRunAt: 1_763_000_000_000, updatedAt: 'rev-1', targetSessionId: 's1',
};

describe('scheduled tasks → rows', () => {
  it('maps the Host status to one of the three documented states, or unknown', () => {
    assert.equal(scheduleStatusKey('active'), 'schedules.status.active');
    assert.equal(scheduleStatusKey('paused'), 'schedules.status.paused');
    assert.equal(scheduleStatusKey('ended'), 'schedules.status.ended');
    assert.equal(scheduleStatusKey('weird'), 'schedules.status.unknown');
    assert.equal(scheduleStatusKey(null), 'schedules.status.unknown');
  });

  it('summarises each rule kind from the Host fields, never re-deriving times', () => {
    assert.equal(ruleSummary(DAILY, tr), 'daily 03:00');
    assert.equal(ruleSummary({ ...DAILY, kind: 'weekly', time: '9:00', weekdays: [1, 3] }, tr), 'weekly 1,3 09:00');
    assert.equal(ruleSummary({ ...DAILY, kind: 'every', time: null, everySeconds: 3_600 }, tr), 'every 1 h');
    assert.equal(ruleSummary({ ...DAILY, kind: 'after', time: null, everySeconds: 90 }, tr), 'after 1.5 min'.replace('1.5 min', '90 s'));
    assert.equal(ruleSummary({ ...DAILY, kind: 'cron', time: null, expression: '0 9 * * 1-5' }, tr), 'cron 0 9 * * 1-5');
    assert.equal(ruleSummary({ ...DAILY, kind: 'custom', time: null }, tr), 'custom', 'an unknown rule names only itself');
  });

  it('falls back to the rule (not a blank row) for an untitled task', () => {
    const row = toTaskRow({ ...DAILY, title: null }, tr);
    assert.equal(row.title, 'daily 03:00');
    assert.equal(row.nextRunAt, 1_763_000_000_000);
  });

  it('lists only the fields the Host sent in the detail sheet', () => {
    const rows = taskDetailRows(DAILY, tr);
    assert.deepEqual(rows.map((row) => row.label), ['schedules.field.status', 'schedules.field.rule', 'schedules.field.nextRun', 'schedules.field.time', 'schedules.field.timeZone', 'schedules.field.target']);
    assert.equal(rows[0]?.value, 'Active');

    const bare = taskDetailRows({ ...DAILY, time: null, timeZone: null, targetSessionId: null, nextRunAt: null }, tr);
    assert.deepEqual(bare.map((row) => row.label), ['schedules.field.status', 'schedules.field.rule', 'schedules.field.nextRun']);
    assert.equal(bare[2]?.value, tr('schedules.none'));
  });
});
