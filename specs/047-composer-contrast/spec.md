# 047 — PWA composer text contrast

Status: **proposed**. UI-only; no auth/wire change.

Owner screenshot 2026-11-19 (iPhone PWA, 1170x2532): the session composer is a light gray capsule,
but the typed/placeholder text and the model pill label are near-white, barely readable. The send
and plus controls remain legible, so this is a text/background pairing defect, not a layout issue.

## Problem

Source in `app/session/[id].tsx:1363-1383` sets the TextInput color from `colors.text` and
placeholder from `colors.textMuted`; `GlassSurface` (`src/ui/components/ui.tsx:103-122`) uses
`expo-blur` with `tint={scheme === 'dark' ? 'dark' : 'light'}` and `colors.glass`. On iOS Safari PWA
the blur/glass surface can render light while the inherited text color comes from a different
scheme, so the two are mismatched. Chrome computed styles can be correct, so the fix must not rely
on the desktop browser only.

## Goal

The composer field, placeholder and model pill must have a deterministic contrast pair in both
light and dark schemes on web/iOS. Native behaviour is unchanged.

## Design

1. Add a web-safe composer surface/token pair derived from the SAME `resolveColorScheme()` used by
   the app shell: a resolved background (not translucent blur-only) and resolved text/muted text.
2. On web, `GlassSurface` may keep the blur visual, but MUST set an explicit same-scheme
   backgroundColor and border that matches the text palette. Do not rely on `expo-blur` tint as the
   authority for text contrast.
3. In `session/[id].tsx`, set TextInput `color` and `placeholderTextColor` from the resolved palette
   used for its surface; apply the same to the model pill label/border inside the composer.
4. Keep native Brightness/BlurView behaviour unchanged; no permanent dark/light override on native.
5. Tests: pure palette/contrast tests for both schemes; web composition test with the resolved
   palette (input text, placeholder, surface); native unchanged; existing theme fallback tests.

## Acceptance

- Light scheme: ink text on light composer surface, muted placeholder >= 4.5:1.
- Dark scheme: light text on dark composer surface, muted placeholder >= 4.5:1.
- iPhone PWA screenshot/manual check: composer text and model label readable; send/plus unchanged.
- Gates: typecheck, check:core, focused tests, full app suite, e2e/check-flows.
