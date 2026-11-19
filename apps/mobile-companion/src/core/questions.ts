// Human question cards (spec 018 item 4), contract §5: a paired device with
// `approval:respond` receives `question-requested`, answers with `question-answer`
// / `question-cancel`, and closes the card on `question-resolved`.
//
// Question text lives here in memory only: never logged, never persisted. The
// store is bounded and keyed by (sessionId, rpcId), so a replay of the subscribe
// backlog cannot fork a card the user is already looking at.

import type { QuestionRequestedFrame, QuestionResolvedFrame } from '@dsh-ext/mobile-protocol';

/** Maximum number of question cards kept in memory across all sessions. */
export const MAX_QUESTION_CARDS = 64;

export interface QuestionAnswer {
  id: string;
  selected: string[];
  custom?: string;
}

export type QuestionCardStatus = 'pending' | 'answering' | 'settled' | 'already-decided';

export interface QuestionCardState {
  rpcId: string;
  sessionId: string;
  callId?: string;
  questions: Array<Record<string, unknown>>;
  status: QuestionCardStatus;
  /** `true` when the frame arrived as a replay of the subscribe backlog. */
  replay: boolean;
  /** Visible, ids-only explanation of a refused answer. Never carries question text. */
  notice?: string;
}

export type QuestionResponder = (
  type: 'question-answer' | 'question-cancel',
  params: Record<string, unknown>,
) => Promise<Record<string, unknown>>;

/** One question card; refuses a second decision unless it is still pending. */
export class QuestionCard {
  private state: QuestionCardState;

  constructor(frame: QuestionRequestedFrame) {
    this.state = {
      rpcId: frame.rpcId,
      sessionId: frame.sessionId,
      ...(frame.callId === undefined ? {} : { callId: frame.callId }),
      // Copy the array so a later mutation of the parsed frame cannot change the card.
      questions: frame.questions.map((question) => ({ ...question })),
      status: 'pending',
      replay: frame.replay === true,
    };
  }

  get snapshot(): QuestionCardState {
    return { ...this.state, questions: this.state.questions.map((question) => ({ ...question })) };
  }

  get pending(): boolean {
    return this.state.status === 'pending';
  }

  /** Merge a replay of the same question without replacing what the user is seeing. */
  mergeReplay(frame: QuestionRequestedFrame): void {
    if (frame.rpcId !== this.state.rpcId || frame.sessionId !== this.state.sessionId) return;
    if (frame.replay === true) this.state = { ...this.state, replay: true };
  }

  /**
   * Send one answer/cancel. Refusal receipts keep the card visible with a notice:
   * a socket or policy refusal must never silently drop a decision the user made.
   */
  async decide(answers: QuestionAnswer[], respond: QuestionResponder, cancel = false): Promise<QuestionCardState> {
    if (this.state.status !== 'pending') return this.snapshot;
    this.state = { ...this.state, status: 'answering', notice: undefined };
    const type = cancel ? 'question-cancel' : 'question-answer';
    try {
      const receipt = await respond(type, {
        rpcId: this.state.rpcId,
        sessionId: this.state.sessionId,
        ...(this.state.callId === undefined ? {} : { callId: this.state.callId }),
        ...(cancel ? {} : { answers }),
      });
      if (receipt.accepted === true) {
        this.state = { ...this.state, status: 'settled', notice: undefined };
      } else {
        const reason = typeof receipt.reason === 'string' ? receipt.reason : '';
        this.state = {
          ...this.state,
          status: reason === 'not-pending' ? 'already-decided' : 'pending',
          notice: reason === 'not-pending' ? 'Already decided on another device.' : 'Question was not accepted. Try again.',
        };
      }
    } catch {
      // A transport failure or an error frame is a refusal too: keep the card retryable.
      this.state = { ...this.state, status: 'pending', notice: 'Question was not sent. Try again.' };
    }
    return this.snapshot;
  }

  /** The gateway closed the question elsewhere; the card is done. */
  settle(outcome?: QuestionResolvedFrame['outcome']): void {
    if (this.state.status === 'settled') return;
    this.state = {
      ...this.state,
      status: outcome === undefined ? 'settled' : 'already-decided',
      notice: undefined,
    };
  }
}

/** Bounded registry of question cards, keyed by (sessionId, rpcId). */
export class QuestionCards {
  private readonly cards = new Map<string, QuestionCard>();

  private key(sessionId: string, rpcId: string): string {
    return `${sessionId}\u0000${rpcId}`;
  }

  /** Idempotent: a replay returns the existing card instead of forking state. */
  upsert(frame: QuestionRequestedFrame): QuestionCard {
    const key = this.key(frame.sessionId, frame.rpcId);
    const existing = this.cards.get(key);
    if (existing) {
      existing.mergeReplay(frame);
      return existing;
    }
    const card = new QuestionCard(frame);
    this.cards.set(key, card);
    while (this.cards.size > MAX_QUESTION_CARDS) {
      this.cards.delete(this.cards.keys().next().value as string);
    }
    return card;
  }

  get(sessionId: string, rpcId: string): QuestionCard | undefined {
    return this.cards.get(this.key(sessionId, rpcId));
  }

  forSession(sessionId: string): QuestionCard[] {
    return [...this.cards.values()].filter((card) => card.snapshot.sessionId === sessionId);
  }

  applyResolved(frame: QuestionResolvedFrame): boolean {
    const card = this.get(frame.sessionId, frame.rpcId);
    if (!card) return false;
    const before = card.snapshot.status;
    card.settle(frame.outcome);
    return card.snapshot.status !== before;
  }

  remove(sessionId: string, rpcId: string): void {
    this.cards.delete(this.key(sessionId, rpcId));
  }

  removeSession(sessionId: string): void {
    for (const [key, card] of [...this.cards]) {
      if (card.snapshot.sessionId === sessionId) this.cards.delete(key);
    }
  }

  clear(): void {
    this.cards.clear();
  }
}
