// Workspace grouping for the list screen (reference 01: one collapsible section per workspace).
//
// The group NAME has a strict priority, because the app must never invent a workspace name:
//   1. `workspaceLabel` on the session — the gateway sends the basename next to the id;
//   2. the paired `workspaces` list's `name` (or its last path segment) for that id;
//   3. otherwise the row is "unknown" and falls into ONE trailing group the caller titles "Other".
//
// Rows whose workspace cannot be named are merged into that single trailing group rather than
// repeated as several identical "Other" headers. Rows with no `workspaceId` at all go there too —
// which is what the current wire does until the gateway ships the field.

import type { SessionSummary } from '../core/sessions';

/** Trailing bucket for rows with no resolvable workspace name. */
export const OTHER_WORKSPACE_KEY = '\u0000other';

export interface WorkspaceGroup {
  /** `workspaceId`, or {@link OTHER_WORKSPACE_KEY}. */
  readonly key: string;
  /** The resolved group name, or `null` when the caller must supply its own "Other" copy. */
  readonly label: string | null;
  readonly isOther: boolean;
  readonly sessions: readonly SessionSummary[];
}

/** A workspace row as the picker/list exposes it (only the fields the label needs). */
export interface WorkspaceLabelSource {
  readonly id: string;
  readonly name?: string;
  readonly path?: string;
}

/** Last path segment, used only when the Host sent a path and no name. Never returns the whole path. */
function basename(path: string | undefined): string | null {
  if (path === undefined) return null;
  const trimmed = path.replace(/[\\/]+$/, '');
  const segment = trimmed.split(/[\\/]/).filter((part) => part !== '').pop();
  return segment === undefined || segment === '' ? null : segment;
}

/** Priority 1 → 3 for one group: session label, then the paired workspaces entry, then null. */
export function resolveWorkspaceLabel(
  workspaceId: string,
  sessions: readonly SessionSummary[],
  workspaces: readonly WorkspaceLabelSource[],
): string | null {
  for (const session of sessions) {
    const fromSession = session.workspaceLabel?.trim();
    if (fromSession !== undefined && fromSession !== '') return fromSession;
  }
  const workspace = workspaces.find((candidate) => candidate.id === workspaceId);
  const fromWorkspace = workspace?.name?.trim();
  if (fromWorkspace !== undefined && fromWorkspace !== '') return fromWorkspace;
  return basename(workspace?.path);
}

/**
 * Group sessions by workspace, newest-first inside each group.
 *
 * Named groups are sorted by label; the "Other" bucket is always last. Returns `[]` for no sessions.
 */
export function groupSessionsByWorkspace(
  sessions: readonly SessionSummary[],
  workspaces: readonly WorkspaceLabelSource[],
): WorkspaceGroup[] {
  const buckets = new Map<string, SessionSummary[]>();
  for (const session of sessions) {
    const key = session.workspaceId === undefined || session.workspaceId === ''
      ? OTHER_WORKSPACE_KEY
      : session.workspaceId;
    const bucket = buckets.get(key);
    if (bucket === undefined) buckets.set(key, [session]);
    else bucket.push(session);
  }

  const groups: WorkspaceGroup[] = [];
  const mergeIntoOther = (rows: readonly SessionSummary[]): void => {
    const index = groups.findIndex((group) => group.isOther);
    if (index === -1) {
      groups.push({ key: OTHER_WORKSPACE_KEY, label: null, isOther: true, sessions: [...rows] });
      return;
    }
    const existing = groups[index] as WorkspaceGroup;
    const merged = [...existing.sessions, ...rows]
      .sort((left, right) => right.updatedAt - left.updatedAt);
    groups[index] = { key: OTHER_WORKSPACE_KEY, label: null, isOther: true, sessions: merged };
  };

  for (const [key, rows] of buckets) {
    const sorted = [...rows].sort((left, right) => right.updatedAt - left.updatedAt);
    if (key === OTHER_WORKSPACE_KEY) {
      mergeIntoOther(sorted);
      continue;
    }
    const label = resolveWorkspaceLabel(key, sorted, workspaces);
    if (label === null) {
      // A workspace id with no name anywhere is still not a name: fold it into "Other" so the user
      // never sees a raw id as a section header, and never sees two "Other" headers either.
      mergeIntoOther(sorted);
      continue;
    }
    groups.push({ key, label, isOther: false, sessions: sorted });
  }

  return groups.sort((left, right) => {
    if (left.isOther) return 1;
    if (right.isOther) return -1;
    return (left.label ?? '').localeCompare(right.label ?? '');
  });
}
