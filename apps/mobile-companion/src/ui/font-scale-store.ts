// Persistence for the font-scale setting (reference: `FontSizeSettingsScreen.kt`).
//
// The theme already owns the scale at runtime (`ThemeProvider` + `useTheme().setFontScale`); this adds
// the missing half — remembering the choice across restarts.
//
// Storage choice: the app has **no AsyncStorage dependency**, only `expo-secure-store`, and adding a
// package is not mine to decide. A font scale is not a secret, but storing it in the encrypted store
// costs one read at startup and keeps the dependency list unchanged; if a general preferences store is
// added later this module is the single place to switch.
//
// Every path here is failure-tolerant: a broken/unavailable store must never blank the UI or throw
// during startup, it just falls back to the default scale.

import * as SecureStore from 'expo-secure-store';

import { FONT_SCALES } from './theme';

/** Non-secret preference key. Deliberately namespaced so it cannot collide with credential keys. */
const FONT_SCALE_KEY = 'ui.fontScale';

export const DEFAULT_FONT_SCALE = 1;

/**
 * Coerce anything read from storage into one of the offered steps.
 *
 * Unknown values fall back to the default instead of being clamped to the nearest step: a stale or
 * corrupted value should not silently change how the app looks.
 */
export function normalizeFontScale(raw: unknown): number {
  if (typeof raw === 'number' && Number.isFinite(raw)) {
    const exact = FONT_SCALES.find((step) => Math.abs(step - raw) < 0.001);
    if (exact !== undefined) return exact;
  }
  if (typeof raw === 'string') {
    const parsed = Number.parseFloat(raw);
    if (Number.isFinite(parsed)) {
      const exact = FONT_SCALES.find((step) => Math.abs(step - parsed) < 0.001);
      if (exact !== undefined) return exact;
    }
  }
  return DEFAULT_FONT_SCALE;
}

/** Read the saved scale, or the default when nothing (usable) was saved. Never throws. */
export async function loadFontScale(): Promise<number> {
  try {
    const raw = await SecureStore.getItemAsync(FONT_SCALE_KEY);
    return normalizeFontScale(raw);
  } catch {
    // A locked/unavailable keystore must not stop the app from starting.
    return DEFAULT_FONT_SCALE;
  }
}

/** Save the scale. Never throws: a failed write only means the choice is not remembered. */
export async function saveFontScale(scale: number): Promise<void> {
  try {
    await SecureStore.setItemAsync(FONT_SCALE_KEY, String(normalizeFontScale(scale)));
  } catch {
    /* deliberately ignored, see above */
  }
}
