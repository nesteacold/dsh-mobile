# Spec 011 — Port the Clarklevis frontend to React Native + Expo

**Packages**: `apps/mobile-companion` (UI), `plugins/mobile-gateway` (companion surface), `packages/mobile-protocol`
(contract) · **Status**: in progress · **Owner decision 2026-11-10**:

> "viết lại bằng RN-Expo nhưng dùng lại toàn bộ frontend của Clarklevis, tái sử dụng backend của Clarklevis nhưng
> custom lại để tương thích với plugin gateway @dsh-ext/devices"

An earlier draft of this spec (a Qoder-style redesign) was a misreading and is withdrawn. The Qoder screenshots
kept in `reference/` are no longer the target.

## Source of truth

- **Frontend**: Clarklevis1995/dsh-mobile ("Whaleness"), MIT, Copyright (c) 2026 Chaofan Li. Read-only clone at
  `../../../_upstream/Clarklevis1995__dsh-mobile` (commit `3ec49d6`). Android Compose UI under
  `androidApp/src/main/kotlin/com/clarklevis/dsh/android/ui/`, iOS SwiftUI under `DeepSeekHarnessMobile/`,
  shared logic under `shared/`, design notes and renders under `Design/` (`design-spec.md`,
  `deepseek-harness-ios-ui.png`, `conversation-dark-mode.png`, `trajectory-dark-mode.png`).
- **Backend**: our fork of Clarklevis's gateway, `plugins/mobile-gateway` (already shares
  `@dsh-ext/devices` when that plugin is installed).

"Reuse the frontend" means: **reproduce Clarklevis's screens, layout, visual language, interaction flow and copy
structure in React Native**, screen by screen, reading their Compose/SwiftUI code. Kotlin/Swift cannot be
copied verbatim into RN. Assets (icons, SVG/PNG) may be copied as files with attribution.

## What we keep from our app (already verified on hardware)

`src/core/**` and `src/platform/**`: pinned TLS transport, pairing challenge/proof (§3.8), credential lock gate,
secure store wipe, `argsHash`-bound approvals, reconnect/revoke handling. The port replaces the **screens**
(`app/**`) and adds a UI layer (`src/ui/**`); it must not weaken any of the above.

## Attribution

`apps/mobile-companion/UPSTREAM-UI.md` records the source repo, commit and MIT licence text; every ported file
carries a one-line header `// UI ported from Clarklevis1995/dsh-mobile <path> (MIT)`.

## Phases

**Owner directive 2026-11-10 (supersedes the "P1 has no workspace data" constraint below): build the COMPLETE
mobile functionality.** "tôi đã kiểm tra gateway có đủ backend mà gateway cần" — upstream v0.12.0 already implements
`workspaces`, `session-create`, `models`, `select-model`; our own hardening refuses them at the contract and the
allowlist, which is ours to lift. The API half is specified in `specs/011-mobile-session-authoring/spec.md`
(owner-approved, written by the parallel session: new scope `sessions:author`, four wire types, hard blocklist
untouched) and is implemented under shared task `task-19`; the app half is `task-20`. So P1's "omit the workspace
picker and the New-session button" applies only until that API lands — after it, they are required, and the
screens must match the reference app.

Division with the parallel session, to avoid two leads building the same thing: **it owns spec 012** (remote parity,
emptying `DESKTOP_ONLY_SCOPES`, reorganising the blocklist); **this session owns spec 011's API surface
(`task-19`) plus the whole RN app.** The hard blocklist in 012 rule 2 (workspace create/rename, session
rename/archive/fork/queue/attachments, commands, settings, plugins, schedules, goals) is permanent: the ported UI
must never render those controls, at any time, in any phase.

### P1 — Core screens, using data the companion already receives (no gateway change)

| Clarklevis source | RN target |
|---|---|
| `DshTheme.kt`, `SettingsTypography.kt`, `Design/design-spec.md` | `src/ui/theme.ts` (tokens for both their light and dark schemes) |
| `DshProductApp.kt` (routes, bottom bar: Workspace / Conversations / Settings) | `app/_layout.tsx` + tab routes |
| Workspace home (hero, recent sessions, new-session button) | `app/(tabs)/index.tsx` — recent sessions only until P2 |
| `ConversationScreen.kt`, `DshMarkdownText.kt`, `SessionStatusUi.kt`, `HumanQuestionCard.kt` | `app/session/[id].tsx` + `src/ui/markdown/**` + tool cards |
| `GatewayAuthenticationUi.kt`, `GatewaySwitcherUi.kt` | `app/pair.tsx` + unlock gate |
| `SettingsScreen.kt` (only items that work: paired computer, forget, language, font size) | `app/(tabs)/settings.tsx` |

Rule: **no button without something behind it.** A Clarklevis control whose operation the companion cannot
call yet is omitted in P1 and listed in the phase-2 table, never rendered disabled-without-reason.

### P2 — Gateway companion surface, so the remaining screens have data

Clarklevis's client uses operations that our gateway keeps **admin-only** (`lib/allowlist.mjs`, never served to a
device token): `workspaces`, `session-create`, `session-rename`, `session-archive`, `models`, `select-model`,
`agent-presets`, `file-list`/`file-download-*`/`file-upload-*`, `subagents`, `agent-team`, `schedule-*`,
`commands`, `speech-*`, `question-answer`. Each one opened to companions is a **network-exposure change**:
it needs a contract revision (`specs/001-gateway-hardening/contracts/mobile-protocol-v1.md`), a scope in the
device's grant, gateway tests, and a **reviewer pass** before merge (repo rule). Order, by user value:

1. `workspaces` + a workspace identity on session rows — enables Clarklevis's workspace grouping and switcher.
2. `session-create` (new session in a workspace) — the home screen's primary action.
3. `models` / `select-model` and `agent-presets` — the composer's mode + model pickers.
4. `session-rename` / `session-archive`.
5. Trajectory (`TrajectoryUi.kt`) — check whether `history` already carries enough; if not, specify the frame.
6. Files, agent team, scheduled tasks, plugins, voice — later, each its own slice.

`@dsh-ext/devices` compatibility: when it is installed it owns the shared gateway and the Settings → Devices
UI; every new companion op must be served through that same gateway and appear in its device-scope editor.

## Non-negotiables

- Native render only, no WebView (Clarklevis's `DshMenuWebView.kt` is not ported).
- en + vi complete for every user-facing string (`test/i18n.test.ts`); Clarklevis's Chinese copy is a source
  for meaning, not shipped text.
- `testID`s used by e2e (`banner`, `pair-manual-input`, `pair-submit`, `session-composer`, `session-send`) keep
  working; `test/ui-test-hooks.test.ts`, `test/sessions-screen.test.ts` and `e2e/check-flows.mjs` pin the list
  screen's structure — a slice that changes that structure updates all three together and says so.
- Accessibility: role + label on every tappable, ≥44 pt targets, system font scale respected.
- No new npm dependency without the lead's approval (name, size, licence).

## Acceptance (per slice)

`npm run typecheck`, `npm run check:core`, `npm test` green in `apps/mobile-companion` (baseline 550 / 0 / 0);
gateway slices also `npm test` in `plugins/mobile-gateway` and a reviewer verdict. Device screenshots of each
ported screen are placed next to the matching Clarklevis render for the owner, whose judgement closes P1.

---

## Status 2026-11-10 (measured on the emulator against the live gateway)

**Verified working end to end on a real device** — `the Android emulator`, app built from this tree, paired
through the real `pairing-challenge` → `pairing-proof` → owner approval → `paired` → `hello` flow with a
device holding `sessions:author`:

- the Clarklevis shell renders (hero, bottom tabs, themed status bar);
- the session list shows real Host sessions with status dots, `Running` badges and relative times;
- a ROOT session opens with a real model pill (`DeepSeek V4.1 Flash`), the composer, the `⋯` menu and
  the status pill;
- sub-agent sessions are hidden by default in both lists behind one honest reveal
  (`Show 479 sub-agent sessions`), and a sub-agent conversation says why it cannot change its model;
- no dead or placeholder control remains on the home or conversation screens (six real defects were
  found and fixed by looking at, and pressing, the running app — see `docs/COORDINATION.md`).

**Blocked on ONE more gateway reload** (a first reload already landed the workspace bindings; a second is needed because the per-workspace role must also carry `session/create`). Three fixes are landed and tested but the live process predates them,
so the workspace picker still reads "This computer has no workspaces" on a Host that has nine:

1. per-workspace `{kind:'workspace', id}` bindings so DSH's per-item filter admits the rows
   (`docs/arch-notes/dsh-remote-access-and-model-catalog-20261110.md` §1-2);
2. durable-parent resolution so `models`/`select-model` stop being a dead end for sub-agent sessions;
3. the new stable code `subagent/model-inherited` (contract Revision 7).

The reload is the owner's decision: another session has uncommitted work in `plugins/mobile-gateway`,
so reloading loads their bytes too, and restarting the Host ends the live session.

**App follow-ups after that reload** (each a one- or few-line change, no design work):

- delete the sub-agent guard in `app/session/[id].tsx` (`if (subagentSession) return;`) and let the
  model pill render for sub-agent sessions, read-only, with the "inherits its parent's model" note;
- re-shoot the workspace picker and confirm a session can be created and opened.

**Not startable without the owner**: iOS signed build/TestFlight (`DSH_IOS_TEAM_ID` unset), remote push
(APNs/FCM credentials), a physical Android phone (all device evidence is the x86_64 emulator), store
paperwork.

**Gates at this writing**: `packages/mobile-protocol` 25/25; `plugins/mobile-gateway` exit 0
(423 pass / 0 fail / 1 skip) plus `test:package` 1/1 and `check:protocol` OK; `plugins/devices` exit 0;
`apps/mobile-companion` 653 pass / 0 fail / 0 skipped, `tsc --noEmit` clean, `check:core` OK,
`e2e/check-flows.mjs` PASS 17 flows; the iOS JS bundle also builds (`expo export:embed --platform ios`,
2,000,191 B) so the app is not Android-only in its JavaScript.