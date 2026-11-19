# 050 — PWA processing indicator with elapsed time and motion

Status: **proposed**. UI/i18n only; no auth/wire change.

Owner screenshot of DSH desktop shows a live “Deep diving for 3m 24s …” footer with subtle motion so
the user can tell the Host is still processing. The PWA currently has only a static “Đang xử lý…”
pill (`app/session/[id].tsx:1447-1467`), driven by `progressPhase()` from existing state. It does not
show elapsed time and does not move, so a long turn still looks stalled.

## Design

1. Keep `progressPhase()` exactly as the source of truth: `sending` wins over `processing`; terminal
   `failed` prompts never keep it alive. No new wire frame or session field.
2. Add a pure elapsed formatter and a bounded hook in the session screen:
   - start counting when `phase` first becomes `processing` for a given `sessionId`;
   - reset on `null`, `sending`, session switch, ack/failure/turn end/reload;
   - format `12s`, `3m 24s`, `1h 2m` (at most hours in normal use).
   - The elapsed value is "since this PWA observed the running state", not a claim about the Host's
     internal start time.
3. Show the elapsed value in the existing pill with a localized label, e.g.
   vi `Đang xử lý… {elapsed}` / en `Processing… {elapsed}`. Keep `testID="session-progress-indicator"`
   and set `accessibilityLabel` to the same visible string.
4. Add a subtle looping opacity animation (approx. 1.0s period, 0.55–1.0) on the pill or an ellipsis
   while `processing`, so the user sees liveness. Do not animate `sending` differently beyond the
   existing spinner. Respect reduced motion when the platform exposes it; a static label remains if
   animation is unavailable.
5. Use the fixed web chrome palette from spec 049 for the pill so it stays readable on the dark
   composer/header. Native styling may reuse the same tokens but must keep existing behaviour.

## Non-goals

- No change to reasoning disclosure: private reasoning text is never shown inline in the pill.
- No new protocol field, no Host query, no persistent timer across reloads.

## Acceptance

- Pure/format tests: 0/59s/224s/3724s.
- Behavioural tests: phase `processing` starts elapsed, resets on session switch/phase null/sending,
  label localization, animation loop only while processing, `sending` unchanged.
- Existing progress/regression tests stay green.
- Live PWA: a running session shows a moving “Đang xử lý… 12s” pill that increments and disappears
  when the turn ends.
