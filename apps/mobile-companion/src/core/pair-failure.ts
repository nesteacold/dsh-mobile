// Spec 032 amendment — WHERE a demo pairing failed, as a diagnosable fact.
//
// WHY THIS EXISTS: a demo pairing that fails on the iOS simulator shows the same sentence for every
// cause. `pairErrorFromCode` maps `client/bad-message`, `client/bad-url`, `client/insecure-url`,
// `client/connect-failed`, `client/upgrade-failed` and `client/store-unavailable` all to
// `pair.error.generic`, so the capture run cannot tell "the fixture's payload is garbled" from "the
// socket never opened". The controller therefore records a `stage` next to the code it already logs
// (`src/app-state.ts` `pair()`), and the demo-only detail line below renders `code · stage=<stage>`.
//
// SECURITY BAR (a reviewer reads this function first):
//   * it is DISPLAY TEXT and nothing else: no gate, refusal, transport option or stored value reads
//     it, so it cannot weaken a rule (the two refusals it describes are unchanged, and the demo mode
//     still pairs only a loopback endpoint);
//   * it renders only when `demo` is true, and in demo mode every field it can print is already in
//     the demo controller's own log line (a throwaway loopback fixture, host URLs with no secret);
//     a normal build gets `null` and its screen is byte-identical to what it was;
//   * the text is redacted on the way out (`redactString`), so even a demo line cannot print a
//     `dsh-pair.<code>` subprotocol, a token in a URL, a bearer value or a 43-char pairing code.
//
// Pure and React-free (no react-native/expo import: `npm run check:core` enforces that).

import { redactString } from './redact';

/**
 * The step of `pair()` that refused. Only the two early refusals name a stage explicitly; the rest
 * are derived from the code that came back, so a code this build does not know still renders.
 */
export type PairFailureStage =
  /** The scanned/pasted text was not a readable pairing payload (`parsePairingQr`). */
  | 'parse'
  /** Demo mode: the payload is readable but is not the loopback fixture. */
  | 'demo-loopback'
  /** A socket was attempted, or the pairing failed after one existed. */
  | 'connect';

/** The stage vocabulary, shared by the controller (which logs it) and the panel (which shows it). */
export const PAIR_FAILURE_STAGE = {
  parse: 'parse',
  demoLoopback: 'demo-loopback',
  connect: 'connect',
} as const satisfies Record<string, PairFailureStage>;

/**
 * The stage a failure reached when only its code is known.
 *
 * The two early refusals are logged with their own stage (a `stage` the caller passes wins), so this
 * is the fallback for a code that came back from one of the later steps. It never claims more than
 * the code says: `qr/*` is a payload refusal, anything else means the attempt got past parsing into
 * the socket and store work.
 */
export function pairFailureStageFromCode(code: string): PairFailureStage {
  return code.startsWith('qr/') ? PAIR_FAILURE_STAGE.parse : PAIR_FAILURE_STAGE.connect;
}

/**
 * The demo-only diagnosis line: `<code> · stage=<stage>`.
 *
 * `null` in a normal build — the caller must render nothing at all, not an empty line, because the
 * pair screen of a shipped app is not the place for a diagnostic.
 *
 * Long codes are kept whole (they are short constants like `client/connect-failed`); the line is
 * monospace so a capture run can read it, never copy: the redaction above is what makes that safe.
 */
export function pairFailureDetail(input: {
  readonly demo: boolean;
  readonly code: string;
  readonly stage: PairFailureStage;
}): string | null {
  if (!input.demo) return null;
  const code = redactString(input.code.trim());
  if (code === '') return null;
  return `${code} · stage=${input.stage}`;
}
