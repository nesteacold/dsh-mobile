// Spec 032 — the platform half of store-screenshot mode: the build flag and the simulator fact.
//
// The DECISION lives in `src/core/screenshot-mode.ts` (pure, fully unit-tested); this file only
// reports what it needs, so the security rules stay in one reviewable place.
//
//   * `flagBakedIn` — `expo.extra.screenshotMode`, written by `app.config.ts` from the build-time
//     `DSH_SCREENSHOT_MODE` env var. It requires the value to be exactly `true`: a missing
//     `expoConfig`, an older manifest or a string value keeps the normal gate. This is a build
//     decision; no user action can change it.
//   * `isSimulator` — the COMPILE-TIME iOS simulator fact of the native `pinned-ws` module
//     (`Constants { simulator: Bool }` is `#if targetEnvironment(simulator)`; Android and every
//     device build answer `false`). Read LAZILY (and only when the flag is baked in): a normal build
//     never touches that module. A module that cannot load, a module without a `simulator` property
//     and a value that is not exactly `true` all mean "unknown", and unknown keeps the normal gate.
//
// THE INVERTED-FACT DEFECT THIS FILE FIXED: an earlier version read `expo-device`
// `Device.isDevice === false` and then passed it as a field NAMED `isDevice` into a decision that
// compared `isDevice !== false`. A physical phone (isDevice true) therefore read as a simulator and
// a simulator (isDevice false) kept the gate. There is now no "is a device" fact at all: the input
// is named `isSimulator` and only exactly `true` unlocks the demo gate.

import Constants from 'expo-constants';
import { Platform } from 'react-native';

import {
  decideScreenshotMode,
  resolveBuildProfile,
  SCREENSHOT_MODE_EXTRA_KEY,
  type ScreenshotDecision,
  type ScreenshotModeInput,
} from '../core/screenshot-mode';
import { getPinnedWsModule, type PinnedWsAdapter } from '../../modules/pinned-ws';

/**
 * The adapter's inputs, so the decision can be exercised in Node (no native runtime, no React).
 * Every field is optional; an absent value is "unknown" and keeps the normal gate.
 */
export interface ScreenshotFacts {
  /** `Constants.expoConfig.extra` (the baked build config). */
  readonly extra?: Record<string, unknown> | undefined;
  /** `Platform.OS`. */
  readonly platform: string;
  /** The native `pinned-ws` module, or `null` when this build has none. */
  readonly nativeModule?: PinnedWsAdapter | null;
}

/**
 * The native module lookup, swapped by tests only (`test/screenshot-mode.test.ts`). App code never
 * calls `setScreenshotNativeModuleForTests`; production reads the real Expo module once.
 */
let nativeModuleForTests: PinnedWsAdapter | null | undefined;

/** Test-only: use `module` as this build's native module (`undefined` restores the real lookup). */
export function setScreenshotNativeModuleForTests(module: PinnedWsAdapter | null | undefined): void {
  nativeModuleForTests = module;
}

function flagBakedIn(extra: Record<string, unknown> | undefined): boolean {
  return extra?.[SCREENSHOT_MODE_EXTRA_KEY] === true;
}

/**
 * The compile-time iOS simulator fact from the native module's exported `simulator` constant, or
 * `null` when it cannot be read: no native module, a module without that property, or a value that
 * is not exactly `true` (anything but `true` is "unknown" and the decision keeps the normal gate).
 */
export function simulatorFact(nativeModule: PinnedWsAdapter | null | undefined): boolean | null {
  const constants = nativePinnedWsConstants(nativeModule);
  return constants.simulator === true ? true : null;
}

/**
 * The native build constants as far as they can be read: `{ simulator: true }` only when the module
 * exports `simulator === true`, `{}` otherwise (no module, no exported property, a value of any
 * other type). The demo transport receives this so it can never conclude "simulator" from an
 * unreadable module.
 *
 * WHY A PROPERTY AND NOT `constants()`: an Expo module's legacy `Constants { ... }` block is merged
 * into a dictionary and decorated onto the module OBJECT (iOS
 * `expo-modules-core/ios/Core/Objects/ObjectDefinition.swift:111-118` `setProperty`, Android
 * `JSDecoratorsBridgingObject.kt:111-121` `registerConstants`), so JS reads `module.simulator`.
 * There is no `constants()` function on the module object; reading one answered `undefined` for
 * every real build, which is "unknown" and therefore the ordinary gate.
 */
export function nativePinnedWsConstants(
  nativeModule: PinnedWsAdapter | null | undefined = getPinnedWsModule(),
): { readonly simulator?: boolean } {
  if (nativeModule === null || nativeModule === undefined) return {};
  let value: unknown;
  try {
    value = (nativeModule as { simulator?: unknown }).simulator;
  } catch {
    // A property read that throws proves nothing about the runtime.
    return {};
  }
  return value === true ? { simulator: true } : {};
}

/** The decision input for this build, from the facts (pure: no I/O, no module loads). */
export function screenshotModeInput(facts: ScreenshotFacts): ScreenshotModeInput {
  return {
    flagBakedIn: flagBakedIn(facts.extra),
    platform: facts.platform,
    isSimulator: simulatorFact(facts.nativeModule),
    profile: resolveBuildProfile(undefined, facts.extra),
  };
}

/**
 * The profile baked into this build, for display in the mode's own status screen. It can only ever
 * NARROW the decision (`decideScreenshotMode`); a missing profile shows `development`, which the
 * decision itself treats as non-production.
 */
export function buildProfileLabel(): string {
  const profile = resolveBuildProfile(undefined, Constants.expoConfig?.extra as Record<string, unknown> | undefined);
  return profile === '' ? 'development' : profile;
}

/** The switch a Mac capture script flips in the installed `.app` to prove the build is a demo build. */
export const SCREENSHOT_BUILD_PLIST_KEY = 'DSHScreenshotMode';

/**
 * The gate decision for this build on this device.
 *
 * The native module is loaded only when the flag is baked in AND the platform is iOS: a normal
 * build, web and Android never touch it (Android is `normal` unconditionally, see the core).
 */
export async function screenshotDecision(): Promise<ScreenshotDecision> {
  const platform = Platform.OS;
  const extra = Constants.expoConfig?.extra as Record<string, unknown> | undefined;
  const nativeModule = flagBakedIn(extra) && platform === 'ios'
    ? (nativeModuleForTests !== undefined ? nativeModuleForTests : getPinnedWsModule())
    : null;
  return decideScreenshotMode(screenshotModeInput({ extra, platform, nativeModule }));
}
