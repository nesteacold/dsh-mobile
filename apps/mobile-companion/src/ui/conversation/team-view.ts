// Presentation layer for the agent-team screen: turn the client's pass-through records into the few
// fields the UI actually draws, and turn a failure CODE into a sentence a person can read.
//
// Why a normaliser instead of trusting the shapes: `src/core/team.ts` deliberately passes the Host's
// records through untyped (`Record<string, unknown>`) because the contract does not fix the fields.
// So the UI must not assume a field exists, must not render `undefined`, and must not invent a value.
// Everything here is pure, which is why it is testable without a renderer (like the rest of this
// suite) and why the screen stays thin.
//
// NOTE: the Host's `error.message` is NEVER shown — it is an internal string (this session has already
// paid for that lesson three times). Only a mapped code produces copy.

import type { TeamRead, AgentTeamProjection, SubagentCatalogEntry } from '../../core/team';

export interface TeamMemberView {
  id: string;
  name: string;
  role: string;
  phase: string;
}

export interface TeamTaskView {
  id: string;
  subject: string;
  status: string;
  owner?: string;
  description?: string;
  blocked: boolean;
  blockedBy: string[];
}

export interface SubagentView {
  id: string;
  label?: string;
  mode?: string;
}

/** The three outcomes, flattened into what a view renders. `absent` is not `empty`. */
export type TeamViewState = 'ready' | 'unavailable' | 'migration-required' | 'failed';

export interface TeamView {
  state: TeamViewState;
  /** Only meaningful when `state === 'ready'`; never drawn otherwise. */
  members: TeamMemberView[];
  tasks: TeamTaskView[];
  /** Host projection sequence, when it said one. Not a freshness promise. */
  asOfSeq?: number;
  /** Mapped sentence for `state === 'failed'`; never the Host's raw message. */
  errorText?: string;
}

export interface CatalogView {
  state: TeamViewState;
  entries: SubagentView[];
  asOfSeq?: number;
  errorText?: string;
}

const text = (record: Record<string, unknown>, key: string): string => {
  const value = record[key];
  return typeof value === 'string' ? value : '';
};

const optionalText = (record: Record<string, unknown>, key: string): string | undefined => {
  const value = text(record, key);
  return value === '' ? undefined : value;
};

const strings = (value: unknown): string[] =>
  Array.isArray(value) ? value.filter((item): item is string => typeof item === 'string') : [];

/** One member. An id is required to keep React keys stable; a missing one is synthesised from name. */
export function normalizeMember(record: Record<string, unknown>, index: number): TeamMemberView {
  const name = text(record, 'name');
  const id = text(record, 'id');
  return {
    id: id === '' ? name === '' ? `member-${index}` : name : id,
    name: name === '' ? id : name,
    role: text(record, 'role'),
    phase: text(record, 'phase'),
  };
}

/**
 * "blocked" is decided by `status` first, because `ready` alone cannot carry it: the Host sets
 * `ready:false` on every started or finished task, not only on waiting ones
 * (`plugins/mobile-gateway/docs/agent-team-app-integration.md:285`, `:291`).
 *
 *   pending                     → blocked = `ready !== true` (`:291`). An absent `ready` counts as
 *                                 blocked: the field is required (`:285`), so its absence is a
 *                                 malformed record and the safe reading is "cannot be claimed".
 *                                 `blockedBy` does NOT decide this — a pending task may list a
 *                                 dependency that already finished and still be `ready:true` (`:217`).
 *   in_progress | completed     → never blocked (`:291`: started/finished are `ready:false` by
 *                                 design, and that must not read as blocked).
 *   deleted, missing, or a value the contract does not name yet (`:281` asks decoders to tolerate
 *                                 both) → outside the contract's known statuses, so this is OUR
 *                                 choice, not the contract's: keep the Host's blocker signals
 *                                 (`ready === false` or a non-empty `blockedBy`) rather than clear
 *                                 the mark and hide a possible blocker behind an unknown status.
 *
 * `blockedBy` is always kept on the view: the detail lists the Host's facts whatever the status is.
 */
export function normalizeTask(record: Record<string, unknown>, index: number): TeamTaskView {
  const blockedBy = strings(record.blockedBy);
  const id = text(record, 'id');
  const status = text(record, 'status');
  let blocked: boolean;
  if (status === 'pending') blocked = record.ready !== true;
  else if (status === 'in_progress' || status === 'completed') blocked = false;
  else blocked = record.ready === false || blockedBy.length > 0;
  return {
    id: id === '' ? `task-${index}` : id,
    subject: text(record, 'subject'),
    status,
    owner: optionalText(record, 'ownerName'),
    description: optionalText(record, 'description'),
    blocked,
    blockedBy,
  };
}

export function normalizeSubagent(record: SubagentCatalogEntry, index: number): SubagentView {
  const id = text(record, 'id');
  return {
    id: id === '' ? `subagent-${index}` : id,
    label: optionalText(record, 'label'),
    mode: optionalText(record, 'mode'),
  };
}

/**
 * Map a client failure to copy. The client throws `CoreError` carrying the Host's code; only codes we
 * can explain become specific sentences, everything else says "could not load" — never the raw message.
 */
export function teamErrorCopy(code: string | null | undefined): 'team.errorNotFound' | 'team.errorAuth' | 'team.errorGeneric' {
  if (code === 'session/not-found') return 'team.errorNotFound';
  if (typeof code === 'string' && code.startsWith('auth/')) return 'team.errorAuth';
  return 'team.errorGeneric';
}

/** `agent-team` read → view. `unavailable` and `migration-required` never look like an empty team. */
export function toTeamView(read: TeamRead<AgentTeamProjection>): TeamView {
  if (read.state === 'unavailable') return { state: 'unavailable', members: [], tasks: [], asOfSeq: read.asOfSeq };
  if (read.state === 'migration-required') {
    return { state: 'migration-required', members: [], tasks: [], asOfSeq: read.asOfSeq };
  }
  const projection: AgentTeamProjection = read.value;
  return {
    state: 'ready',
    members: projection.members.map(normalizeMember),
    tasks: projection.tasks.map(normalizeTask),
    asOfSeq: read.asOfSeq,
  };
}

export function toCatalogView(read: TeamRead<SubagentCatalogEntry[]>): CatalogView {
  if (read.state === 'unavailable') return { state: 'unavailable', entries: [], asOfSeq: read.asOfSeq };
  if (read.state === 'migration-required') {
    return { state: 'migration-required', entries: [], asOfSeq: read.asOfSeq };
  }
  return { state: 'ready', entries: read.value.map(normalizeSubagent), asOfSeq: read.asOfSeq };
}

/** Members grouped by phase, in the Host's order, so the list does not reshuffle between renders. */
export function groupMembersByPhase(members: TeamMemberView[]): { phase: string; members: TeamMemberView[] }[] {
  const groups: { phase: string; members: TeamMemberView[] }[] = [];
  for (const member of members) {
    const phase = member.phase === '' ? 'unknown' : member.phase;
    const existing = groups.find((group) => group.phase === phase);
    if (existing === undefined) groups.push({ phase, members: [member] });
    else existing.members.push(member);
  }
  return groups;
}

/** Collapsed header counts: total and blocked, so the summary is actionable at a glance. */
export function taskTally(tasks: TeamTaskView[]): { total: number; blocked: number } {
  return { total: tasks.length, blocked: tasks.filter((task) => task.blocked).length };
}
