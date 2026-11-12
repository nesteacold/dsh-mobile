// Spec 018 item 5 — the session's task list (`todos`) and current goal (`goal`), READ ONLY.
//
// CONTRACT (authoritative text: `plugins/mobile-gateway/PROTOCOL.md:939-1021`; Host side:
// `plugins/mobile-gateway/lib/index.mjs:7004-7047` — `projectionKinds` + `installProjectionBaseline`):
//
//   baseline { kind: 'projection-baseline',
//              projections: { '<sessionId>': { asOfSeq, values: { todos, goal, turnOutline, ... } } } }
//   update   { kind: 'tasks-updated', sessionId, asOfSeq, todos: [...] | null }
//   update   { kind: 'goal-updated',  sessionId, asOfSeq, goal:  {...} | null }
//
// Both already travel to every device holding `sessions:read` in `projection-baseline` (`allowlist.mjs:303-317`
// documents exactly that for the team projections, and the baseline carries these two as well), so
// this module only DECODES; it never sends a frame, and the app has no write path for either.
//
// `asOfSeq` is a projection cut point, not a notification sequence (PROTOCOL.md:763), and it is
// compared PER (sessionId, key): a newer `tasks-updated` may never overwrite a newer `goal-updated`.
//
// Tolerance (the contract fixes neither the frame encoder nor the todo record beyond
// `{content, status}`, and PROTOCOL.md:952-954 shows a bare string `completed`): a missing field,
// an unknown status, or a record from another session is dropped or kept as an unknown value —
// never thrown, never invented.
//
// Goal shape as read (PROTOCOL.md:970-981): `{ goal: { id, revision, objective, phase, maxGoalRounds },
// roundsStarted, createdAt, updatedAt }` — the projection's value re-uses the key `goal` for itself.

/** The three todo statuses the Host documents. Anything else is kept as `unknown`, never guessed. */
export const TODO_STATUSES = ['pending', 'in_progress', 'completed'] as const;
export type TodoStatus = (typeof TODO_STATUSES)[number];

/** The todo statuses this app draws; a Host value outside the list is reported as none of them. */
export type TodoStatusView = TodoStatus | 'unknown';

/** One checklist row: the Host's own text and its status, unchanged. */
export interface TodoListItem {
  readonly text: string;
  readonly status: TodoStatusView;
}

/** The one goal line the header draws. */
export interface GoalView {
  /** `goal.goal.objective` — the only non-empty part of the goal the header shows. */
  readonly objective: string;
  /** `goal.goal.phase` (`active`, …) when the Host sent a non-empty string; `null` when it did not. */
  readonly phase: string | null;
}

/**
 * One session's two read-only projections plus the cut point each was last seen at.
 *
 * `todos: null` means the Host has not written a task list for this session (PROTOCOL.md:959), which
 * is NOT the same as `[]` — an empty list it did send. The screen hides the checklist in both cases,
 * but the distinction is kept so a future surface can tell them apart.
 */
export interface SessionPanel {
  readonly todos: readonly TodoListItem[] | null;
  readonly goal: GoalView | null;
  readonly todosAsOfSeq: number | null;
  readonly goalAsOfSeq: number | null;
}

/** A session with no projections heard yet. */
export const EMPTY_SESSION_PANEL: SessionPanel = {
  todos: null,
  goal: null,
  todosAsOfSeq: null,
  goalAsOfSeq: null,
};

function record(value: unknown): Record<string, unknown> | null {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
    ? value as Record<string, unknown>
    : null;
}

function seq(value: unknown): number | null {
  return typeof value === 'number' && Number.isSafeInteger(value) && value >= 0 ? value : null;
}

function text(value: unknown): string | null {
  return typeof value === 'string' && value.trim() !== '' ? value : null;
}

/**
 * One todo record → the row the checklist draws, or `null`.
 *
 * `content` is required: a record without usable text has nothing to show and becomes no row
 * (inventing "(untitled)" would put our words into the Host's list).
 */
export function parseTodo(value: unknown): TodoListItem | null {
  const raw = record(value);
  if (raw === null) return null;
  const content = typeof raw.content === 'string' ? raw.content : '';
  if (content.trim() === '') return null;
  const status = raw.status;
  return {
    text: content,
    status: typeof status === 'string' && (TODO_STATUSES as readonly string[]).includes(status)
      ? status as TodoStatus
      : 'unknown',
  };
}

/** A `todos` projection → its rows; `null` when the Host sent nothing that is a list. */
export function parseTodos(value: unknown): TodoListItem[] | null {
  if (!Array.isArray(value)) return null;
  const items: TodoListItem[] = [];
  for (const entry of value) {
    const item = parseTodo(entry);
    if (item !== null) items.push(item);
  }
  return items;
}

/**
 * A `goal` projection → the one line the header draws, or `null` when there is no current goal.
 *
 * A projection that is a bare goal record (`{ objective, … }`) is read too: the image belongs to the
 * Host, and the app must not turn a readable objective into "no goal" over one wrapping level.
 */
export function parseGoal(value: unknown): GoalView | null {
  const raw = record(value);
  if (raw === null) return null;
  const source = record(raw.goal) ?? raw;
  const objective = text(source.objective);
  if (objective === null) return null;
  return { objective, phase: text(source.phase) };
}

/** Every session id → its panel, from a `projection-baseline` frame; `null` when not a map of maps. */
export function parseProjectionBaseline(projections: unknown): Map<string, SessionPanel> | null {
  const raw = record(projections);
  if (raw === null) return null;
  const out = new Map<string, SessionPanel>();
  for (const [sessionId, baseline] of Object.entries(raw)) {
    if (sessionId === '') continue;
    const entry = record(baseline);
    const values = record(entry?.values);
    // One malformed session never voids the others.
    if (entry === null || values === null) continue;
    const asOfSeq = seq(entry.asOfSeq);
    out.set(sessionId, {
      todos: parseTodos(values.todos),
      goal: parseGoal(values.goal),
      todosAsOfSeq: asOfSeq,
      goalAsOfSeq: asOfSeq,
    });
  }
  return out;
}

/** Which projection one update frame carries; `null` when the kind is neither update. */
export function projectionUpdateKind(kind: unknown): 'todos' | 'goal' | null {
  if (kind === 'tasks-updated') return 'todos';
  if (kind === 'goal-updated') return 'goal';
  return null;
}

/**
 * A `projection-baseline` frame → this session's panel (the empty one when the Host control set does
 * not include this session), or `null` when the frame is not a baseline at all.
 */
export function panelFromBaseline(frame: Record<string, unknown>, sessionId: string): SessionPanel | null {
  if (frame.kind !== 'projection-baseline') return null;
  if (typeof sessionId !== 'string' || sessionId === '') return null;
  const panels = parseProjectionBaseline(frame.projections);
  return panels === null ? null : (panels.get(sessionId) ?? EMPTY_SESSION_PANEL);
}

/**
 * One update frame (`tasks-updated` / `goal-updated`) → the panel it REPLACES, or `null` when the
 * frame is not one of those, names another session, or is OLDER than what we already hold.
 *
 * `previous` is only needed for the stale check. A frame with no usable `asOfSeq` is applied: the
 * Host always sends one (PROTOCOL.md:1017-1018), and dropping a value because our own copy of its
 * cut point is missing would be the worse answer.
 */
export function panelFromUpdate(
  frame: Record<string, unknown>,
  sessionId: string,
  previous: SessionPanel | undefined,
): SessionPanel | null {
  const kind = projectionUpdateKind(frame.kind);
  if (kind === null) return null;
  if (typeof frame.sessionId !== 'string' || frame.sessionId === '' || frame.sessionId !== sessionId) return null;
  const cut = seq(frame.asOfSeq);
  const base = previous ?? EMPTY_SESSION_PANEL;
  if (kind === 'todos') {
    if (cut !== null && base.todosAsOfSeq !== null && cut < base.todosAsOfSeq) return null;
    return { ...base, todos: parseTodos(frame.todos), todosAsOfSeq: cut ?? base.todosAsOfSeq };
  }
  if (cut !== null && base.goalAsOfSeq !== null && cut < base.goalAsOfSeq) return null;
  return { ...base, goal: parseGoal(frame.goal), goalAsOfSeq: cut ?? base.goalAsOfSeq };
}
