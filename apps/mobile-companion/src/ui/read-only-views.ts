// Spec 018 — presentation for the two read-only surfaces whose data the Host sends as numbers or
// loosely-typed records: session metrics (`session-stats`) and scheduled tasks (`schedule:*`).
//
// Why a mapping layer: the core deliberately passes `null` through for every field the Host did not
// report (see `src/core/stats.ts` / `src/core/schedules.ts`), so the screen must never draw
// `undefined`, must never turn an absent number into `0`, and must never show the Host's
// `error.message`. Everything here is pure, which is why it is testable without a renderer.
//
// Rule/next-run times are NOT computed here: the Host sends `nextRunAt` and the UI only formats it.

import type { ContextPressure, SessionStats, SessionStatsRead, TokenUsage } from '../core/stats';
import type { ScheduledTask } from '../core/schedules';
import type { SessionPanel, TodoStatusView } from '../core/projections';
import type { MessageKey } from '../../i18n';

export type Interpolate = (key: MessageKey, params?: Record<string, string | number>) => string;

/** What the stats sheet renders: a read, the two "nothing to show" answers, or a fixed failure. */
export type StatsViewState = 'ready' | 'unavailable' | 'loading' | 'failed';

export interface StatsRow {
  /** Stable i18n label slot. */
  readonly label: MessageKey;
  /** Already formatted (a count, a percentage or a duration); never a raw `undefined`. */
  readonly value: string;
}

export interface StatsSection {
  readonly title: MessageKey;
  readonly testID: string;
  readonly rows: StatsRow[];
}

export interface StatsView {
  readonly state: StatsViewState;
  readonly sections: StatsSection[];
  /** Mapped sentence for `failed`; never the Host's message. */
  readonly errorText?: string;
}

/** `1_234` → `1 234`-style grouping, without depending on `Intl` (Hermes variants differ). */
export function formatCount(value: number): string {
  if (!Number.isFinite(value)) return '–';
  const whole = Math.floor(Math.abs(value));
  const sign = value < 0 ? '-' : '';
  return sign + whole.toString().replace(/\B(?=(\d{3})+(?!\d))/g, ' ');
}

/** Big numbers in the app's two units: k (thousands), M (millions) — past 100 the decimals go. */
export function formatCompact(value: number): string {
  if (!Number.isFinite(value)) return '–';
  const abs = Math.abs(value);
  if (abs >= 1_000_000) return `${trimDecimal(value / 1_000_000, 1)}M`;
  if (abs >= 1_000) return `${trimDecimal(value / 1_000, 1)}k`;
  return formatCount(value);
}

function trimDecimal(value: number, digits: number): string {
  const fixed = value.toFixed(digits);
  return fixed.endsWith('.0') ? fixed.slice(0, -2) : fixed;
}

/** A percentage with one decimal at most: `52.3%`. `null` when the window is unknown or zero. */
export function contextPercent(pressure: ContextPressure | null): string | null {
  if (pressure === null) return null;
  const window = pressure.contextWindow;
  const used = pressure.pressureTokens;
  if (window === null || used === null || window <= 0) return null;
  // Never report more than a full window: the Host's own reading is the source, and a >100% bar
  // would look like our bug.
  const percent = Math.min(100, (used / window) * 100);
  return `${trimDecimal(percent, 1)}%`;
}

function tokenRows(usage: TokenUsage | null): StatsRow[] {
  const totals = usage?.totals ?? null;
  if (totals === null) return [];
  const rows: StatsRow[] = [];
  const push = (label: MessageKey, value: number | null): void => {
    if (value !== null) rows.push({ label, value: formatCompact(value) });
  };
  push('stats.input', totals.inputTokens);
  push('stats.output', totals.outputTokens);
  push('stats.cacheRead', totals.cacheReadTokens);
  push('stats.cacheWrite', totals.cacheWriteTokens);
  push('stats.reasoning', totals.reasoningTokens);
  return rows;
}

function statRows(stats: SessionStats | null): StatsRow[] {
  if (stats === null) return [];
  const rows: StatsRow[] = [];
  if (stats.turns !== null) rows.push({ label: 'stats.turns', value: formatCount(stats.turns) });
  if (stats.steps !== null) rows.push({ label: 'stats.steps', value: formatCount(stats.steps) });
  return rows;
}

function contextRows(pressure: ContextPressure | null): StatsRow[] {
  if (pressure === null) return [];
  const rows: StatsRow[] = [];
  if (pressure.contextWindow !== null) rows.push({ label: 'stats.contextWindow', value: formatCompact(pressure.contextWindow) });
  const percent = contextPercent(pressure);
  const pressureTokens = pressure.pressureTokens;
  if (pressureTokens === null) {
    if (percent !== null) rows.push({ label: 'stats.contextUsed', value: percent });
  } else {
    const amount = formatCompact(pressureTokens);
    rows.push({ label: 'stats.contextUsed', value: percent === null ? amount : `${amount} (${percent})` });
  }
  return rows;
}

/**
 * A `session-stats` read → the sheet. A `ready` reply whose three projections are all `null` is the
 * Host saying "no metrics for this session yet" — `stats.noData`, never an empty set of rows.
 */
export function toStatsView(read: SessionStatsRead, tr: Interpolate): StatsView {
  const tokenSection = tokenRows(read.tokenUsage);
  const statsSection = statRows(read.sessionStats);
  const contextSection = contextRows(read.contextPressure);
  if (tokenSection.length === 0 && statsSection.length === 0 && contextSection.length === 0) {
    return { state: 'failed', sections: [], errorText: tr('stats.noData') };
  }
  const sections: StatsSection[] = [];
  if (tokenSection.length > 0) sections.push({ title: 'stats.tokens', testID: 'stats-tokens', rows: tokenSection });
  if (contextSection.length > 0) sections.push({ title: 'stats.context', testID: 'stats-context', rows: contextSection });
  if (statsSection.length > 0) sections.push({ title: 'stats.title', testID: 'stats-session', rows: statsSection });
  return { state: 'ready', sections };
}

/** A thrown `CoreError` code → fixed copy. `auth/*` is the device's grant; anything else is generic. */
export function statsErrorCopy(code: string | null | undefined): MessageKey {
  return typeof code === 'string' && code.startsWith('auth/') ? 'stats.errorAuth' : 'stats.errorGeneric';
}

/** A thrown `CoreError` code → fixed copy for the schedule screen. Never the Host's message. */
export function scheduleErrorCopy(code: string | null | undefined): MessageKey {
  return typeof code === 'string' && code.startsWith('auth/') ? 'schedules.errorAuth' : 'schedules.errorGeneric';
}

// ---------------------------------------------------------------------------
// Session goal + task checklist (spec 018 item 5, read-only)
// ---------------------------------------------------------------------------

export interface PanelTaskRow {
  /** The Host's own text, unchanged; the strip caps how many lines of it it draws. */
  readonly text: string;
  readonly status: TodoStatusView;
  /** Fixed i18n label for the status. */
  readonly statusLabel: MessageKey;
}

/**
 * How many task rows the checklist draws before it collapses the rest into a "+N more" line: the Host
 * owns the list's length, and a 300-row list would push the transcript off the screen.
 */
export const PANEL_TASK_ROWS_MAX = 50;

/** What the session header draws from the Host's `goal` / `todos` projections. Both may be absent. */
export interface SessionPanelView {
  readonly goal: string | null;
  /** The goal's own phase word, when the Host sent one; `null` hides it. */
  readonly goalPhase: string | null;
  /** At most `PANEL_TASK_ROWS_MAX` rows, in the Host's order. */
  readonly tasks: PanelTaskRow[];
  /** Checklist summary: how many of the Host's rows are `completed`. */
  readonly tasksDone: number;
  /** The Host's whole list, drawn or not — the summary counts what it sent, not what fits. */
  readonly tasksTotal: number;
  /** Rows the Host sent beyond the cap and the checklist does not draw; `0` when all fit. */
  readonly tasksHidden: number;
}

/** Status → its label. The Host's key `in_progress` and the app's `in-progress` key must not drift. */
export function taskStatusLabel(status: TodoStatusView): MessageKey {
  switch (status) {
    case 'pending':
      return 'session.taskStatus.pending';
    case 'in_progress':
      return 'session.taskStatus.in-progress';
    case 'completed':
      return 'session.taskStatus.completed';
    default:
      return 'session.taskStatus.unknown';
  }
}

/**
 * The two projections → the header's view. A session with neither hides both surfaces (the screen
 * draws nothing), which is the documented answer for an absent projection (PROTOCOL.md:959, 985).
 * An empty task list (`todos: []`) also hides the checklist: there is no row to show and no data
 * to offer, and a zero-of-zero counter is a promise of work that does not exist.
 */
export function toSessionPanelView(panel: SessionPanel): SessionPanelView {
  const all: PanelTaskRow[] = (panel.todos ?? []).map((item) => ({
    text: item.text,
    status: item.status,
    statusLabel: taskStatusLabel(item.status),
  }));
  return {
    goal: panel.goal === null ? null : panel.goal.objective,
    goalPhase: panel.goal?.phase ?? null,
    tasks: all.slice(0, PANEL_TASK_ROWS_MAX),
    // The Host's own count: hiding a row is a layout decision, not a claim that it is done.
    tasksDone: all.filter((task) => task.status === 'completed').length,
    tasksTotal: all.length,
    tasksHidden: Math.max(0, all.length - PANEL_TASK_ROWS_MAX),
  };
}

// ---------------------------------------------------------------------------
// Scheduled tasks
// ---------------------------------------------------------------------------

export interface ScheduledTaskRow {
  readonly id: string;
  readonly title: string;
  /** The Host's status, reduced to one of the three it documents, or `unknown`. */
  readonly statusKey: MessageKey;
  /** One summary line: the rule (`daily 09:00`, `every 1 h`, `cron …`) or the fallback. */
  readonly rule: string;
  /** Epoch ms of the next run, as the Host sent it; `null` when it sent none. */
  readonly nextRunAt: number | null;
}

/** `02:00`-style padding for the Host's `time` string ("9:00" and "09:00" both arrive). */
function normalizedTime(value: string): string {
  const match = /^(\d{1,2}):(\d{2})/.exec(value.trim());
  if (match === null) return value.trim();
  return `${(match[1] ?? '').padStart(2, '0')}:${match[2] ?? '00'}`;
}

/** Seconds as a short human duration (the unit words stay out of i18n: they are numerals). */
function duration(seconds: number): string {
  if (seconds % 86_400 === 0) return `${seconds / 86_400} d`;
  if (seconds % 3_600 === 0) return `${seconds / 3_600} h`;
  if (seconds % 60 === 0) return `${seconds / 60} min`;
  return `${seconds} s`;
}

export function scheduleStatusKey(status: string | null): MessageKey {
  switch (status) {
    case 'active':
      return 'schedules.status.active';
    case 'paused':
      return 'schedules.status.paused';
    case 'ended':
      return 'schedules.status.ended';
    default:
      return 'schedules.status.unknown';
  }
}

/**
 * One summary line for the Host's rule. Each branch names its rule kind; a kind this app does not
 * know is shown as the kind itself with its `expression`/`rrule` when present, so an unknown rule is
 * never described as a known one.
 */
export function ruleSummary(task: ScheduledTask, tr: Interpolate): string {
  switch (task.kind) {
    case 'daily':
      return task.time === null ? 'daily' : `daily ${normalizedTime(task.time)}`;
    case 'weekly': {
      const days = task.weekdays.length === 0 ? '' : ` ${task.weekdays.join(',')}`;
      const time = task.time === null ? '' : ` ${normalizedTime(task.time)}`;
      return `weekly${days}${time}`;
    }
    case 'every':
      return task.everySeconds === null ? 'every' : `every ${duration(task.everySeconds)}`;
    case 'after':
      return task.everySeconds === null ? 'after' : `after ${duration(task.everySeconds)}`;
    case 'at':
      return task.scheduledAt === null ? 'at' : `at ${task.scheduledAt}`;
    case 'cron':
      return task.expression === null ? 'cron' : `cron ${task.expression}`;
    case 'rrule':
      return 'rrule';
    default:
      return task.kind === null ? tr('schedules.none') : task.kind;
  }
}

/** Local wall-clock time of an epoch ms, `HH:mm`, or `null` when the value is not a time. */
export function formatRunTime(epochMs: number | null): string | null {
  if (epochMs === null || !Number.isFinite(epochMs) || epochMs <= 0) return null;
  try {
    const date = new Date(epochMs);
    if (Number.isNaN(date.getTime())) return null;
    return `${String(date.getHours()).padStart(2, '0')}:${String(date.getMinutes()).padStart(2, '0')}`;
  } catch {
    return null;
  }
}

export function toTaskRow(task: ScheduledTask, tr: Interpolate): ScheduledTaskRow {
  return {
    id: task.id,
    // A title is Host data; an untitled task is labelled by its rule, never by a blank row.
    title: task.title ?? ruleSummary(task, tr),
    statusKey: scheduleStatusKey(task.status),
    rule: ruleSummary(task, tr),
    nextRunAt: task.nextRunAt,
  };
}

export interface TaskDetailRow {
  readonly label: MessageKey;
  readonly value: string;
}

/** The detail sheet's rows: only the fields the Host actually sent, each under its own label. */
export function taskDetailRows(task: ScheduledTask, tr: Interpolate): TaskDetailRow[] {
  const rows: TaskDetailRow[] = [];
  rows.push({ label: 'schedules.field.status', value: tr(scheduleStatusKey(task.status)) });
  rows.push({ label: 'schedules.field.rule', value: ruleSummary(task, tr) });
  const nextRun = formatRunTime(task.nextRunAt);
  rows.push({ label: 'schedules.field.nextRun', value: nextRun ?? tr('schedules.none') });
  if (task.time !== null) rows.push({ label: 'schedules.field.time', value: normalizedTime(task.time) });
  if (task.timeZone !== null) rows.push({ label: 'schedules.field.timeZone', value: task.timeZone });
  if (task.weekdays.length > 0) rows.push({ label: 'schedules.field.weekdays', value: task.weekdays.join(', ') });
  if (task.everySeconds !== null) rows.push({ label: 'schedules.field.everySeconds', value: duration(task.everySeconds) });
  if (task.expression !== null) rows.push({ label: 'schedules.field.expression', value: task.expression });
  if (task.targetSessionId !== null) rows.push({ label: 'schedules.field.target', value: task.targetSessionId });
  return rows;
}
