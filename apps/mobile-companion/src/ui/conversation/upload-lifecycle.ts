// Spec 041 review — pure identity rules for one composer attachment transfer. No renderer, no
// React: the screen owns a monotonically increasing generation and one unique token per transfer.
// Every post-await state update is gated by BOTH, so a picker/read/upload started in session A can
// never paint progress, a receipt, an error, or unlock Send after the reader moved to session B.

/** The slot the screen currently regards as live. Mutated only by session-change/unmount effects. */
export interface UploadSlot {
  readonly generation: number;
  readonly token: object | null;
}

/** One transfer's immutable identity plus its own cancellation flag. */
export interface UploadIdentity {
  readonly generation: number;
  readonly token: object;
  readonly cancelled: boolean;
}

/**
 * Ownership is generation + unique token ONLY. Cleanup/release always uses this: a user-cancelled
 * transfer still OWNS its slot and must release it, even though its result may never be published.
 * A stale token/generation never releases a newer transfer's slot.
 */
export function ownsUpload(slot: UploadSlot, identity: UploadIdentity): boolean {
  return slot.generation === identity.generation && slot.token === identity.token;
}

/** A completion may be PUBLISHED only to the exact, still-current, NON-cancelled transfer. */
export function isCurrentUpload(slot: UploadSlot, identity: UploadIdentity): boolean {
  return ownsUpload(slot, identity) && !identity.cancelled;
}

export interface ReceiptIdentity {
  readonly sessionId: string;
  readonly receiptId: string;
}

/** Functional-set guard: clear a chip only when the same session still owns the same Host receipt. */
export function shouldClearReceipt(
  current: ReceiptIdentity | null,
  expected: ReceiptIdentity,
): boolean {
  return current !== null && current.sessionId === expected.sessionId && current.receiptId === expected.receiptId;
}
