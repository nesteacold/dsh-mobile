// Spec 032 — build configuration for the store-screenshot build.
//
// `app.json` stays the product configuration; this file adds exactly one build-time decision:
//
//   DSH_SCREENSHOT_MODE=1   ->  expo.extra.screenshotMode = true   (plus the EAS profile label)
//   ENVIRONMENT=production  ->  extra.screenshotMode = false, EVEN IF the flag leaked into the shell
//
// The resolved value reaches the app through `Constants.expoConfig.extra`, i.e. it is FROZEN INTO
// the bundle at build time (`src/core/screenshot-mode.ts` is the whole gate, and it also requires an
// iOS SIMULATOR — a compile-time native fact — and a non-production profile; Android is always the
// normal gate). It is never a runtime toggle, and no release build can carry it.
//
// RELEASE SAFETY, two layers:
//   * a production profile (`EAS_BUILD_PROFILE`/`extra.eas.buildProfile`) or `ENVIRONMENT=production`
//     FORCES `screenshotMode: false`, whatever `DSH_SCREENSHOT_MODE` says, so a leaked env var
//     cannot bake the mode into a store build;
//   * the one case where env-labelling can be wrong — the flag set while this build has no profile
//     label at all, so there is no production fact to force it off — fails fast instead of guessing.
//     `mac/ios-build.sh` and the Windows driver refuse `DSH_SCREENSHOT_MODE=1` with a production
//     profile even earlier; `test/screenshot-mode.test.ts` asserts all of it.
//
// The resolver is restated here (not imported) because `expo config` loads this file OUTSIDE the
// app's TypeScript graph, where `src/core` may not resolve. `test/screenshot-mode.test.ts` pins the
// two copies to the same profile list.

import type { ConfigContext, ExpoConfig } from 'expo/config';

type AppConfigContext = ConfigContext & { config: Record<string, unknown> };

/** Profile names that are store/release builds (mirrors `PRODUCTION_PROFILES` in src/core). */
const PRODUCTION_PROFILES = ['production', 'release', 'release-apk', 'store', 'app-store', 'app-store-connect'];

/** The EAS profile of this build, or `''` when it is not an EAS profile build. */
function resolveProfile(context: Partial<AppConfigContext> | undefined): string {
  const fromEnv = typeof process.env.EAS_BUILD_PROFILE === 'string' ? process.env.EAS_BUILD_PROFILE.trim() : '';
  if (fromEnv !== '') return fromEnv;
  const extra = context?.config?.extra as Record<string, unknown> | undefined;
  const eas = extra?.eas;
  const profile = typeof eas === 'object' && eas !== null ? (eas as Record<string, unknown>).buildProfile : undefined;
  return typeof profile === 'string' ? profile.trim() : '';
}

function isProductionProfile(profile: string): boolean {
  const normalised = profile.trim().toLowerCase();
  return PRODUCTION_PROFILES.includes(normalised) || normalised.startsWith('prod');
}

/** `ENVIRONMENT`, Expo's own build variable: `production`, `development`, `preview` or unset. */
function environmentLabel(): string {
  return (process.env.ENVIRONMENT ?? '').trim().toLowerCase();
}

/** True when the build DECLARES itself a release/store build. */
function isProductionEnvironment(): boolean {
  return environmentLabel() === 'production';
}

/** True when the build declares itself a NON-production build (`development` / `preview`). */
function isDevelopmentEnvironment(): boolean {
  return environmentLabel() === 'development' || environmentLabel() === 'preview';
}
export default ({ config }: AppConfigContext): ExpoConfig => {
  const flag = process.env.DSH_SCREENSHOT_MODE === '1';
  const profile = resolveProfile({ config } as AppConfigContext);
  const release = isProductionProfile(profile) || isProductionEnvironment();
  const labelled = profile !== '' || environmentLabel() !== '';
  // Fail fast only where the configuration proves NOTHING: the flag is set and the build carries
  // no label at all, so it can neither be shown an iOS-simulator build nor a store build.
  if (flag && !labelled) {
    throw new Error(
      'DSH_SCREENSHOT_MODE is set but this build declares no profile or environment, so it cannot ' +
        'be proven a development build: label it (EAS_BUILD_PROFILE=development or ' +
        'ENVIRONMENT=development) or unset DSH_SCREENSHOT_MODE.',
    );
  }
  // The one value the app acts on: `false` in every release configuration, flag or no flag, and
  // `true` only for a labelled development build with the flag.
  const screenshotMode = flag && !release;
  const extra = (config.extra ?? {}) as Record<string, unknown>;
  const eas = typeof extra.eas === 'object' && extra.eas !== null ? (extra.eas as Record<string, unknown>) : {};
  return {
    ...config,
    extra: {
      ...extra,
      screenshotMode,
      // Only recorded in a screenshot build: a normal build keeps `extra` exactly as app.json has it.
      ...(screenshotMode ? { eas: { ...eas, buildProfile: profile !== '' ? profile : environmentLabel() } } : {}),
    },
  } as ExpoConfig;
};