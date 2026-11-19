// Spec 053 — pure decisions for QR decoding from a picked photo. No renderer, no Expo imports:
// the panel owns the picker and the expo-camera decoder, and this module only makes the outcomes
// testable in Node. Nothing here logs, sends, or accepts a pairing payload itself.

/** One decoded QR candidate, already ordered by the decoder. */
export type QrCandidates = readonly string[];

export type QrCandidateDecision =
  | { readonly kind: 'none' }
  | { readonly kind: 'one'; readonly value: string }
  /** More than one DISTINCT payload: never pair arbitrarily. */
  | { readonly kind: 'multiple'; readonly count: number };

/**
 * Deterministic choice from local decoder results. Empty text is ignored; the SAME payload repeated
 * by a decoder is one candidate, while two distinct payloads refuse the pick. The first distinct
 * value is then chosen, so a deterministic decoder order gives a deterministic result.
 */
export function chooseQrCandidate(candidates: QrCandidates): QrCandidateDecision {
  const values = candidates
    .filter((value): value is string => typeof value === 'string' && value.trim() !== '')
    .map((value) => value.trim());
  const distinct = [...new Set(values)];
  if (distinct.length === 0) return { kind: 'none' };
  if (distinct.length > 1) return { kind: 'multiple', count: distinct.length };
  return { kind: 'one', value: distinct[0] as string };
}

/** A completion from an older attempt (or an unmounted screen) must never reach submit(). */
export function isStaleImageAttempt(token: number, current: number, mounted: boolean): boolean {
  return !mounted || token !== current;
}

export type AcquisitionOwner = 'camera' | 'photo' | 'manual';

/** A synchronous lease. Generation is unique, so a released lease can never own a later attempt. */
export type AcquisitionLease = { readonly token: number; readonly owner: AcquisitionOwner };

/**
 * Reviewer 053: ONE synchronous gate for every QR/pairing submit entry point. State flags alone let
 * a camera callback and a photo tap in the same tick both pass; this does not. acquire() is the only
 * way in, and it is synchronous — no await between the check and taking ownership.
 */
export interface AcquisitionGate {
  acquire(owner: AcquisitionOwner): AcquisitionLease | null;
  owns(lease: AcquisitionLease): boolean;
  release(lease: AcquisitionLease): boolean;
  /** Newer attempt (mode change, retry, link prefill): the old lease is no longer current. */
  invalidate(): void;
  /** Effect setup: the gate accepts leases again after a StrictMode cleanup/setup replay. */
  activate(): void;
  /** Effect cleanup: deactivate and make every older lease stale; generations never reset. */
  deactivate(): void;
}

export function createAcquisitionGate(): AcquisitionGate {
  let generation = 0;
  let active: AcquisitionLease | null = null;
  let mounted = true;
  return {
    acquire(owner) {
      if (!mounted || active !== null) return null;
      const lease = { token: ++generation, owner };
      active = lease;
      return lease;
    },
    owns(lease) {
      return mounted && active !== null && active.token === lease.token;
    },
    release(lease) {
      if (!mounted || active === null || active.token !== lease.token) return false;
      active = null;
      return true;
    },
    invalidate() {
      generation += 1;
      active = null;
    },
    activate() {
      // No generation reset: a StrictMode replay keeps every older lease stale.
      mounted = true;
    },
    deactivate() {
      mounted = false;
      generation += 1;
      active = null;
    },
  };
}

/**
 * The system Photos picker is launched directly (no media-library read preflight on modern iOS /
 * Android PickVisualMedia). A real permission refusal reaches the caller as an error code; only
 * those become the localized permission copy — every other failure stays a generic decode error.
 */
export function imagePickerFailureKey(error: unknown): 'pair.imagePermission' | 'pair.imageError' {
  const code = typeof error === 'object' && error !== null
    ? String((error as { code?: unknown; name?: unknown }).code ?? (error as { name?: unknown }).name ?? '')
    : '';
  return /permission|denied|unauthori[sz]ed|not.?allowed|security/i.test(code)
    ? 'pair.imagePermission'
    : 'pair.imageError';
}
