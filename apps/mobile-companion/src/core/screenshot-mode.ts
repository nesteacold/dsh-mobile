// Spec 032 — store-screenshot mode: the one decision function behind `DSH_SCREENSHOT_MODE`.
//
// WHY THIS EXISTS: on a headless iOS simulator (an ssh-driven capture run) a LocalAuthentication
// prompt cannot be matched — nobody can answer Face ID — so every App Store / Play screenshot
// showed the native unlock gate. Spec 032 bakes a build-time flag into the app so the gate can run
// against the fixture's demo pairing instead. iOS simulator only: Android screenshots need a
// separate, owner-approved design (there is no emulator fact to key on).
//
// SECURITY BAR (a reviewer reads this file first):
//   * the flag is a BUILD decision (`app.config.ts` reads `DSH_SCREENSHOT_MODE` and writes it into
//     `expo.extra.screenshotMode`), never a runtime toggle, deep link, setting or storage value, so
//     a released app cannot be switched into this mode by a user or an attacker;
//   * it takes effect only when EVERY condition holds: the flag is baked in, the runtime is an
//     iOS SIMULATOR (a compile-time fact set by the native module under
//     `#if targetEnvironment(simulator)` — never a JS/runtime heuristic), and the build's profile is
//     not a production/store profile;
//   * Android is ALWAYS `normal`: there is no emulator detection here at all (an Android emulator
//     and a Play machine look identical to JS), so Android screenshots need a separate,
//     owner-approved design;
//   * anything else — flag absent, a physical phone, an unknown simulator fact, an unknown profile,
//     web, Android — falls through to `normal` and the A020 gate runs unchanged;
//   * in `unlocked-demo` the gate still calls the controller's `unlock()`, but the README/DOC
//     contract with `src/app-state.ts` holds the demo pairing to a loopback, source-verified fake
//     gateway and refuses every other pairing, so no real credential can be reached.
//
// Pure and React-free (no react-native/expo import: `npm run check:core` enforces that), so the
// whole matrix is unit-tested; `src/platform/screenshot-mode.ts` supplies the device facts and
// `app/_layout.tsx` only acts on the decision.

/** The value `app.config.ts` writes into `expo.extra.screenshotMode`. */
export const SCREENSHOT_MODE_EXTRA_KEY = 'screenshotMode' as const;

/** What the gate must do. `normal` is the untouched A020 biometric gate. */
export type ScreenshotGate = 'normal' | 'unlocked-demo';

/** Why the decision came out the way it did (logged/diagnosed only; never shown as copy). */
export type ScreenshotDecisionReason =
  /** The flag is not baked into this build (`extra.screenshotMode` is not exactly `true`). */
  | 'flag-off'
  /** Web: no simulator fact and no native gate to skip. */
  | 'web'
  /** Android: no simulator detection exists (see the security bar); spec 032 is iOS-simulator only. */
  | 'android'
  /** A physical phone, or an iOS build whose simulator fact is unknown/unavailable (fail closed). */
  | 'physical-device'
  /** A production/store build must never carry the mode, whatever the flag says. */
  | 'production-profile';

export interface ScreenshotDecision {
  readonly gate: ScreenshotGate;
  /** `null` only for `unlocked-demo`; otherwise the condition that kept the normal gate. */
  readonly reason: ScreenshotDecisionReason | null;
}

/** The platform facts the decision needs, as `src/platform/screenshot-mode.ts` reports them. */
export interface ScreenshotModeInput {
  /** `expo.extra.screenshotMode` — `true` only when the build baked the flag in. */
  readonly flagBakedIn: boolean;
  /** `react-native` `Platform.OS`. */
  readonly platform: string;
  /**
   * `nativePinnedWsConstants().simulator` — `true` only on an iOS simulator, `false` on a device
   * or Android binary, `null`/absent when the fact cannot be read (= unknown, keeps the gate).
   */
  readonly isSimulator: boolean | null;
  /** The build profile (`app.config.ts` `extra.eas.buildProfile`, `process.env.EAS_BUILD_PROFILE`, else development). */
  readonly profile: string;
}

/**
 * Profiles that are store/release builds. `production` is `eas.json`'s store profile and the remote
 * iOS script's default `--profile`; `release-apk` is the Android release-APK build. Case and
 * whitespace are normalised, a missing profile counts as `development`, and anything starting with
 * `prod` is refused, so a future `prod-store` cannot slip through.
 */
const PRODUCTION_PROFILES = new Set(['production', 'release', 'release-apk', 'store', 'app-store', 'app-store-connect']);

/** True for a profile that must never carry screenshot mode. An unknown profile is NOT production. */
export function isProductionProfile(profile: string): boolean {
  const normalised = profile.trim().toLowerCase();
  return PRODUCTION_PROFILES.has(normalised) || normalised.startsWith('prod');
}

/**
 * The one decision. Every condition is checked in order of certainty (what the build is, what the
 * runtime is, what the profile is), and the first one that fails keeps the normal gate. The
 * simulator condition is a POSITIVE fact: anything except exactly `true` (false, null, undefined)
 * keeps the gate, so a missing native module can never unlock a build.
 */
export function decideScreenshotMode(input: ScreenshotModeInput): ScreenshotDecision {
  const normal = (reason: ScreenshotDecisionReason): ScreenshotDecision => ({ gate: 'normal', reason });
  if (input.flagBakedIn !== true) return normal('flag-off');
  if (input.platform === 'android') return normal('android');
  if (input.platform !== 'ios') return normal('web');
  if (input.isSimulator !== true) return normal('physical-device');
  if (isProductionProfile(input.profile)) return normal('production-profile');
  return { gate: 'unlocked-demo', reason: null };
}

/**
 * The EAS build profile of this configuration, or `''` when the build is not an EAS profile build.
 * Declared here (pure) so `app.config.ts` and `src/platform/screenshot-mode.ts` agree on the source.
 */
export function resolveBuildProfile(easProfileEnv: string | undefined, extra: Record<string, unknown> | undefined): string {
  const fromEnv = typeof easProfileEnv === 'string' ? easProfileEnv.trim() : '';
  if (fromEnv !== '') return fromEnv;
  const eas = extra?.eas;
  if (typeof eas === 'object' && eas !== null) {
    const profile = (eas as Record<string, unknown>).buildProfile;
    if (typeof profile === 'string' && profile.trim() !== '') return profile.trim();
  }
  return '';
}
