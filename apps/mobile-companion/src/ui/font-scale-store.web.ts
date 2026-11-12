// Web font-scale preference (spec 020) — the `*.web.ts` sibling of `font-scale-store.ts`.
//
// The native build stores this non-secret UI preference in SecureStore. On web `expo-secure-store`
// is an empty stub (`export default {}`), so it throws; a display preference is not a credential
// and does not belong behind credential encryption, so it lives in `localStorage`.
// Every read/write is guarded: a denied store must never stop the app from starting.

export const DEFAULT_FONT_SCALE = 1;

/** Non-secret preference key. Deliberately namespaced so it cannot collide with credential keys. */
const FONT_SCALE_KEY = 'ui.fontScale';

const MIN_FONT_SCALE = 0.85;
const MAX_FONT_SCALE = 1.6;

export function normalizeFontScale(raw: unknown): number {
  const value = typeof raw === 'string' ? Number.parseFloat(raw) : typeof raw === 'number' ? raw : Number.NaN;
  if (!Number.isFinite(value)) return DEFAULT_FONT_SCALE;
  return Math.min(MAX_FONT_SCALE, Math.max(MIN_FONT_SCALE, value));
}

export async function loadFontScale(): Promise<number> {
  try {
    return normalizeFontScale(localStorage.getItem(FONT_SCALE_KEY));
  } catch {
    // A blocked/absent localStorage must not stop the app from starting.
    return DEFAULT_FONT_SCALE;
  }
}

export async function saveFontScale(scale: number): Promise<void> {
  try {
    localStorage.setItem(FONT_SCALE_KEY, String(normalizeFontScale(scale)));
  } catch {
    // Best effort: the preference simply is not remembered across reloads.
  }
}
