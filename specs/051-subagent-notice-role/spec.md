# 051 — Subagent completion notice is a system note, not a user bubble

Status: **proposed**. UI/history mapping only; no auth/wire change.

Owner observed in PWA: DSH’s background-subagent completion notice appeared as a normal user bubble:

> Background subagent coder-app-nolock finished and will do no further work unless you send it more.
> It sent you a message just before finishing, so its closing message is omitted.

That text is a harness completion notification injected into the parent session as a user-role event.
It is not the owner’s prompt and should not look like one.

## Design

1. Add a strict classifier in `apps/mobile-companion/src/core/history.ts`, e.g.
   `isSubagentCompletionNotice(text: string): boolean`. Match only when the text contains
   **both** `background subagent` and one of the harness footers
   (`finished and will do no further work`, `closing message is omitted`), case-insensitive.
2. In `coerceHistoryEvent`:
   - contract shape (`{role:'user', text}`): when classified, return a row with `role:'system'` and
     the original text preserved (not silent-drop);
   - live/history `user/message` shape: when classified, override the mapped user role with
     `role:'system'` before building the row.
3. Do not add this text to `HOST_INJECTED_MARKERS` (which drops rows). The notice remains visible for
   audit, but through the existing muted `ToolRow` path in `app/session/[id].tsx:2043-2049`.
4. Do not change gateway/contract, i18n, or native screen code. Existing host-injected user text
   filtering stays unchanged.

## Acceptance

- Pure tests: both measured shapes map to `role:'system'`; a real prompt that merely mentions
  “background subagent” without the harness footer stays `user`; empty/unrelated text unchanged.
- Render contract remains: `system` rows use `ToolRow`, not `bubbleUser`.
- Existing history/dedupe/duplicate-message tests stay green.
- Live PWA after deploy: the completion notice renders as a muted activity/system row, not as the
  owner’s purple/blue user bubble.
