# 062 — Keep screen awake while a Host session is running

Status: **specified — coder route; reviewer mandatory before any store upload**.

Owner request: PWA and native mobile must not let the screen sleep while a DSH Host session is running. The feature is called "Always on" in Settings; it must be safe by default and must never keep a stale or disconnected device awake.

## Problem and evidence

- `SessionSummary.state` is `'running' | 'idle' | 'archived'` (`src/core/sessions.ts`, `src/core/protocol.ts`); `needsDecision` is separate and is NOT a running state.
- `snapshot.sessions` is global and refreshed by `sessions` list responses. It is NOT cleared on connection teardown; a stale `'running'` row can remain after a drop.
- `snapshot.connection === 'ready'` is the live-socket truth. Workspaces/models are also blanked unless the client is ready; keep-awake must apply the same discipline.
- On native, the app is credential-locked on background (`app/_layout.tsx`); on web/PWA it stays unlocked but is hidden. A wake lock must be released in both cases.
- `expo-keep-awake@58.0.3` is installed transitively under Expo SDK 58 but is not a direct dependency. Its native modules exist; the web implementation uses `navigator.wakeLock` but has no visibility-change reacquire and can throw on unsupported/duplicate releases. Do not rely on the stock web module.
- `expo-secure-store` is empty on web; `src/ui/font-scale-store.web.ts` is the existing preference pattern (`localStorage` for non-secret UI preferences).

## Requirements

### 1. Runtime gating (all platforms)

Create a pure predicate (preferably `src/core/keep-awake.ts`, with no `expo:*`/`react-native` imports so `check:core` passes) that returns true only when **all** hold:

- the saved preference is enabled;
- the app is locally unlocked (`gate === 'unlocked'` or equivalent);
- the app is foreground/visible;
- `snapshot.connection === 'ready'`;
- at least one row in `snapshot.sessions` has `state === 'running'`.

No wake lock on: locked gate, background/inactive, connecting/reconnecting/idle client, no running session, stale running row with no live socket, unsupported platform/browser, or a failed lock request. The default preference is ON; an unavailable/blocked wake lock must not break the app or show an error screen.

### 2. Platform adapter

Add `src/platform/keep-awake.ts` and `src/platform/keep-awake.web.ts` with a tiny API:

```ts
export interface KeepAwakeAdapter {
  activate(tag: string): Promise<void>;
  deactivate(tag: string): Promise<void>;
  isSupported?(): Promise<boolean>;
}
```

Native:
- add `expo-keep-awake@58.0.3` as a direct dependency in `package.json` and update `package-lock.json` from the already-installed tree (no network install hang);
- use a single stable tag, e.g. `dsh-running-session`;
- guard `activate`/`deactivate` in try/catch; `expo-keep-awake` Android can throw `AppContextLost` when the activity is gone;
- deactivate exactly once for the tag; never leave a tag active if the lock request/activation fails.

Web/PWA:
- implement directly against the Screen Wake Lock API (`navigator.wakeLock.request('screen')`) with one sentinel/tag;
- do not import `expo-keep-awake` on web;
- on `visibilitychange` back to visible, re-acquire only if the runtime predicate is still true (the adapter may expose a reacquire helper or the layout effect may re-run);
- release on `deactivate`, on sentinel `release`, on page hide/unload, and after a failed request; no duplicate release;
- if the API is unavailable or the request is rejected, silently remain unlocked (no crash, no noisy UI).

### 3. Preference and Settings UI

- Add `src/ui/keep-awake-preference.ts` and `src/ui/keep-awake-preference.web.ts` following the font-scale store pattern:
  - key `ui.keepAwakeWhileRunning`, default `true`;
  - native SecureStore, web localStorage;
  - failure-tolerant read/write; normalize arbitrary values to boolean.
- Add a Settings row in `app/settings.tsx` under the existing grouped-row design:
  - label "Always on" / "Luôn sáng";
  - value "On"/"Off" or "Bật"/"Tắt";
  - hint: keeps the screen awake only while a session is running and the connection is live;
  - `testID` values for label/value/row, consistent with existing IDs;
  - load once on mount, save on press; do not block UI.
- Add en/vi i18n keys in `i18n/index.ts`; no untranslated strings in the UI.

### 4. Root layout integration

- Wire a single effect in `app/_layout.tsx` (inside the existing `useApp()` tree) that:
  - loads the preference;
  - tracks foreground/visibility (reuse `foregroundRef`/AppState listener where possible);
  - computes the pure predicate from `gate`, foreground, and `snapshot`;
  - calls the platform adapter activate/deactivate without races (generation/sequence guard or cancel flag so an out-of-order async result cannot leave a lock on).
- Do not put any wake-lock call in `src/core/`.
- On unlock/gate changes, reconnect drops, host switch, forget/revoke, background, and unmount, the lock must be released or never acquired.

### 5. Test runner

- Add `expo-keep-awake` stub in `test/support/stub-platform.ts` if any imported module would otherwise fail under Node. Stub must record calls deterministically.
- Pure tests for:
  - predicate true/false for each gate condition;
  - stale `running` row with connection not ready => false;
  - preference normalize/default/load/save fallback;
  - adapter activate/deactivate sequencing (with injected fake backend where practical).
- Keep `npm run check:core` green; no `expo:*` imports under `src/core/`.

### 6. Scope

Files expected: `apps/mobile-companion/package.json`, `package-lock.json`, `src/core/keep-awake.ts`, `src/platform/keep-awake.ts`, `src/platform/keep-awake.web.ts`, `src/ui/keep-awake-preference.ts`, `src/ui/keep-awake-preference.web.ts`, `app/_layout.tsx`, `app/settings.tsx`, `i18n/index.ts`, `test/support/stub-platform.ts`, focused tests, this spec. No gateway/plugin/contract change. No commit/push/store upload.

## Acceptance

- With a live paired Host and one `running` session, screen stays awake on Android, iOS, and PWA; on web the sentinel is re-acquired after returning to a visible tab.
- With no running session, a stale session row after disconnect, locked/background app, or preference off, no wake lock is held.
- Toggling "Always on" persists across restarts/reloads.
- Gates run and are reported literally: `npm run typecheck`, `npm run check:core`, focused new test file, full `npm test`, `npm run build:web`, `node tools/scan-pii.mjs`, `node tools/verify-publish.mjs`.
- Reviewer APPROVE before any store upload. Store deployment is NOT part of this spec.
