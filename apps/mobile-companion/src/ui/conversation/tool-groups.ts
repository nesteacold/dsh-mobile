// Grouping for the transcript: consecutive tool/system rows collapse into one line (parity A/D).
//
// WHY: once agent prose is correctly classified (see `coerceHistoryEvent`), the transcript is mostly
// prose with runs of tool activity between turns. Clarklevis shows such a run as ONE compact row that
// opens on tap, not as N stacked pills — the reference conversation screenshot has a single collapsed
// activity line under the answer. Keeping this pure means the grouping rule is unit-tested without a
// renderer (this repo has none).

import type { HistoryMessage } from '../../core/history';

/** One rendered transcript entry: a real message, or a collapsed run of tool-ish rows. */
export type TranscriptEntry =
  | { kind: 'message'; key: string; message: HistoryMessage }
  | { kind: 'tools'; key: string; rows: HistoryMessage[] };

/** Rows that are activity rather than conversation (tool calls/results, system notices). */
export function isActivityRow(message: HistoryMessage): boolean {
  return message.role === 'tool' || message.role === 'system' || message.role === 'other';
}

/**
 * Collapse each consecutive run of activity rows into one entry, leaving user/assistant rows alone
 * and in order.
 *
 * A single activity row stays an entry of its own (`rows.length === 1`) so the caller can render it
 * as a plain pill rather than an expandable group; two or more become a group. The key of a group is
 * its first row's id, which is stable across re-renders (ids are host ids or `seq-<n>`).
 */
export function groupTranscript(messages: readonly HistoryMessage[]): TranscriptEntry[] {
  const entries: TranscriptEntry[] = [];
  let run: HistoryMessage[] = [];

  const flush = (): void => {
    const first = run[0];
    if (first !== undefined) entries.push({ kind: 'tools', key: first.id, rows: run });
    run = [];
  };

  for (const message of messages) {
    if (isActivityRow(message)) {
      run.push(message);
      continue;
    }
    flush();
    entries.push({ kind: 'message', key: message.id, message });
  }
  flush();
  return entries;
}
