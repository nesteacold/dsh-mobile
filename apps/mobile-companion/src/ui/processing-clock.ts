// Spec 050 amendment: the observed processing start belongs to the CONTROLLER, not the screen.
// The session screen remounts on navigation; a screen-local start made the elapsed timer reset
// every time the user left and came back while the same turn was still processing.
//
// The clock only records when THIS client FIRST SAW processing for a session. It never claims the
// Host's own start time. A non-processing phase ends the observation; the next processing phase
// gets a fresh start.

export type ProcessingPhase = 'sending' | 'processing' | null;

/** One client's observation per session; bounded so a long-lived app cannot grow without limit. */
export const MAX_PROCESSING_CLOCKS = 64;

type Entry = { since: number };

export class ProcessingClock {
  private readonly entries = new Map<string, Entry>();

  /**
   * Return the timestamp of this client's first observation of the current processing phase,
   * or `null` when the phase is not processing. `now` is injected so tests are deterministic.
   */
  observe(sessionId: string, phase: ProcessingPhase, now = Date.now()): number | null {
    if (phase !== 'processing' || sessionId === '') {
      this.entries.delete(sessionId);
      return null;
    }
    const existing = this.entries.get(sessionId);
    if (existing) {
      // Refresh LRU order without moving the start: a remount must not restart the clock.
      this.entries.delete(sessionId);
      this.entries.set(sessionId, existing);
      return existing.since;
    }
    const entry = { since: now };
    this.entries.set(sessionId, entry);
    while (this.entries.size > MAX_PROCESSING_CLOCKS) {
      this.entries.delete(this.entries.keys().next().value as string);
    }
    return entry.since;
  }

  forget(sessionId: string): void {
    this.entries.delete(sessionId);
  }

  clear(): void {
    this.entries.clear();
  }
}
