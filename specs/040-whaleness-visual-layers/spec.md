# Spec 040 — Whaleness visual layers for DSH Orbit (no whale mark)

**Package**: `apps/mobile-companion` (UI only) · **Status**: owner-approved 2026-11-18 · **Owner directive**:

> "ocean mesh → liquid glass → vector icon là được, không cần whale mark (logo + splash)"

## Source of truth

- Upstream: `Clarklevis1995/dsh-mobile` @ `3ec49d6` (MIT), read-only clone at
  `_upstream/Clarklevis1995__dsh-mobile`. Attribution already recorded in
  `apps/mobile-companion/UPSTREAM-UI.md`; this slice extends the same port.
- The ported **layout** is already in place. This slice restores three **visual layers** that were
  deliberately omitted in P1 (`UPSTREAM-UI.md:41-51`, `docs/arch-notes/clarklevis-parity-gap-20261111.md:29,96`).

## Scope — three layers, in this order

1. **Ocean mesh background.** Navy base `#07182B` → deep blue, a technical grid (spacing ~42 dp,
   hairline white α≈0.043) and sparse dot squares (white α≈0.085 where
   `(row*11 + column*7) % 13 == 0`), plus a slow dot drift. Source: upstream
   `HarnessAnimatedBackground.kt:116-211`, `OceanMeshBackground.kt:36-53`, palette
   `Design/design-spec.md:11-13`. **No whale silhouette / mascot / logo** — drop the upstream
   `WhaleParticleField` entirely; keep only the grid, dots and drift. Respect reduced motion.
2. **Liquid glass.** Restore the upstream glass construction on the surfaces that already have a
   seam: `GlassSurface` (`src/ui/components/ui.tsx:103-121`), session composers
   (`app/(tabs)/index.tsx:473-521`, `app/session/[id].tsx:891-903`), cards (`ui.tsx:75-100`) and
   settings rows (`app/settings.tsx:102,118,131,190,219,241,248`). Upstream values
   (`DshLiquidGlass.kt:72-87`): blur 4–5 dp, surface alpha 0.005–0.060, border alpha 0.10–0.26,
   shadow radius 12–22 dp, navy tint `#031B3D`. Refraction/lens (API 33+) is **out of scope** —
   no RN equivalent; use real per-view blur where available and the existing `glass`,
   `glassHighlight`, `shadow` tokens (`src/ui/theme.ts:56-109,143-145,176-178`) for the highlight
   and shadow. Keep cards readable in both light and dark schemes.
3. **Vector icons.** Replace the current glyph/View substitutes (`⋯`, `↑`, `‹`, `›`, `⌄`, `✕`,
   drawn grid/monitor/folder Views) with a real icon set on: home workspace card, new-session and
   search affordances, back/chevron, gear, composer add/send, close, approval card. Upstream uses
   Android VectorDrawable XML (~35 functional `ic_*`, licence MIT + Apache 2.0 notices); **do not
   copy those files**. Use a permissive RN icon package (lead-approved dependency) with explicit
   size/colour props and `accessibilityLabel` on every tappable.

## Non-negotiables

- **No whale mark, no mascot, no logo/splash change** (`spec.md:owner directive`). App name and
  bundle id unchanged.
- **No gateway / contract / pairing / TLS / auth change.** Pure UI.
- Preserve every `testID`, `accessibilityLabel` and structure pinned by
  `test/ui-test-hooks.test.ts`, `test/sessions-screen.test.ts` and `e2e/check-flows.mjs`.
- No button without something behind it (spec 011 P1 rule).
- en + vi complete for any new user-facing string.
- New dependencies: lead evaluates name/size/licence before install; record the decision here.
  Preferred: a small SVG-based icon package for RN plus a blur package if the installed Expo SDK
  does not already provide one. No dependency may be added by a coder without the lead's written
  approval in this spec.
- Reduced motion: `AccessibilityInfo.isReduceMotionEnabled()` must disable the drift/animation.

## Dependencies — lead decision (fill before implementation)

_Pending: coder audit reports `expo-blur`, `react-native-svg`, `@expo/vector-icons`, `lucide-react-native`
are all absent from `package.json`. Lead to choose and record exact names/versions/licences here._

## Gates (literal commands, exported staged tree)

- `npm run typecheck`
- `npm run check:core`
- `node e2e/check-flows.mjs`
- `node --import tsx --import ./test/support/resolve.ts --import ./test/support/stub-platform.ts --test "test/*.test.ts"`
- repo `node tools/scan-pii.mjs`, `node tools/verify-publish.mjs`

## Acceptance evidence

- Simulator screenshots on iPhone 17 Pro `9DBA11F5-D54A-4FE4-BE0E-60129682F770` at 1206×2622:
  home, session detail, settings, approval card — each showing the layer it exercises.
- Screenshots placed in `apps/mobile-companion/artifacts/ui-040/` (git-ignored).
- A short visual comparison note against upstream
  `_upstream/Clarklevis1995__dsh-mobile/Design/harness-background-simulator-v2.png` and
  `conversation-dark-mode.png`.
- After merge: new signed builds for TestFlight and Play production, and re-submit both (the
  already-submitted builds contain the old UI). Owner approval for each upload is already on record
  for this product; the lead must still report the exact upload before it happens.

## Status

Implemented and verified on iPhone 17 Pro simulator 2026-11-18. Owner decided to keep the already-reviewing store submissions; signed builds with this UI are prepared for the next submission round (iOS TestFlight build #2 VALID; Android versionCode 2).
