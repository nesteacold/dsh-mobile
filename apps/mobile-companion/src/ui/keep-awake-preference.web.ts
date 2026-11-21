// Spec 062 — web persistence for the "Always on" preference.
// `expo-secure-store` has no web implementation here; localStorage is the established pattern
// (see `font-scale-store.web.ts`). Failures never change app behaviour.

export const KEEP_AWAKE_KEY = 'ui.keepAwakeWhileRunning';
export const DEFAULT_KEEP_AWAKE = true;

const listeners = new Set<(enabled: boolean) => void>();

/** Notify mounted consumers (the root-layout bridge) immediately when Settings changes the choice. */
export function subscribeKeepAwakePreference(listener: (enabled: boolean) => void): () => void {
  listeners.add(listener);
  return () => { listeners.delete(listener); };
}

function notify(enabled: boolean): void {
  for (const listener of [...listeners]) listener(enabled);
}

export function normalizeKeepAwake(raw: unknown): boolean {
  if (typeof raw === 'boolean') return raw;
  if (typeof raw === 'string') {
    const value = raw.trim().toLowerCase();
    if (value === 'true' || value === '1' || value === 'on') return true;
    if (value === 'false' || value === '0' || value === 'off') return false;
  }
  return DEFAULT_KEEP_AWAKE;
}

export async function loadKeepAwakePreference(): Promise<boolean> {
  try {
    return normalizeKeepAwake(localStorage.getItem(KEEP_AWAKE_KEY));
  } catch {
    return DEFAULT_KEEP_AWAKE;
  }
}

export async function saveKeepAwakePreference(enabled: boolean): Promise<void> {
  try {
    localStorage.setItem(KEEP_AWAKE_KEY, enabled ? 'true' : 'false');
  } catch {
    /* best effort only */
  } finally {
    // Even a failed write should stop a lock already held in this session.
    notify(enabled);
  }
}
