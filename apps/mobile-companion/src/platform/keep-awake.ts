// Spec 062 — native keep-awake adapter.
//
// One tag for the whole app. `expo-keep-awake` is reference-counted by tag on native; this wrapper
// adds a local active flag so a failed deactivate (e.g. Android AppContextLost) cannot leave a
// stale "active" belief, and so repeated calls never emit duplicate native operations.

import { activateKeepAwakeAsync, deactivateKeepAwake } from 'expo-keep-awake';

export const KEEP_AWAKE_TAG = 'dsh-running-session';

export interface KeepAwakeAdapter {
  activate(tag?: string): Promise<void>;
  deactivate(tag?: string): Promise<void>;
}

export function createKeepAwakeAdapter(options: {
  activate?: (tag: string) => Promise<void>;
  deactivate?: (tag: string) => Promise<void>;
} = {}): KeepAwakeAdapter {
  const activateNative = options.activate ?? activateKeepAwakeAsync;
  const deactivateNative = options.deactivate ?? deactivateKeepAwake;
  let active = false;
  let nativeClaimUnknown = false;
  let chain: Promise<void> = Promise.resolve();

  const enqueue = (task: () => Promise<void>): Promise<void> => {
    chain = chain.catch(() => {}).then(task).catch(() => {});
    return chain;
  };

  return {
    activate(tag = KEEP_AWAKE_TAG) {
      return enqueue(async () => {
        if (active) return;
        // A previous deactivate can fail inside expo-keep-awake before it removes its own tag
        // (Android AppContextLost). Only then clear the native tag first, so a fresh activate
        // does not get skipped as "already active" on a new activity.
        if (nativeClaimUnknown) {
          try { await deactivateNative(tag); } catch { /* no activity or no tag */ }
          nativeClaimUnknown = false;
        }
        try {
          await activateNative(tag);
          active = true;
        } catch {
          // Unsupported/failed lock is not an app error. Retry on the next transition.
          active = false;
        }
      });
    },
    deactivate(tag = KEEP_AWAKE_TAG) {
      return enqueue(async () => {
        if (!active) return;
        try {
          await deactivateNative(tag);
        } catch {
          // Android can answer AppContextLost when the activity is gone; the OS releases the
          // window flag on teardown, but its tag set may still hold ours. Remember that so the
          // next activate clears it before re-arming the new activity's window.
          nativeClaimUnknown = true;
        } finally {
          active = false;
        }
      });
    },
  };
}

export const keepAwakeAdapter: KeepAwakeAdapter = createKeepAwakeAdapter();
