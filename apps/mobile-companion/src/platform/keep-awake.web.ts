// Spec 062 — web/PWA keep-awake adapter.
//
// Deliberately NOT `expo-keep-awake`'s web module: that implementation throws on duplicate
// deactivate and never re-acquires a WakeLockSentinel after the browser releases it on tab hide.
// This one keeps one sentinel, re-acquires on visibility only while the app still wants it, and
// releases on pagehide/unload. Unsupported or rejected requests are silent no-ops.

import type { KeepAwakeAdapter } from './keep-awake';

export const KEEP_AWAKE_TAG = 'dsh-running-session';

interface WakeLockSentinelLike {
  released?: boolean;
  release?: () => Promise<void> | void;
  addEventListener?: (type: 'release', listener: () => void) => void;
  removeEventListener?: (type: 'release', listener: () => void) => void;
}

interface WakeLockLike {
  request(type: 'screen'): Promise<WakeLockSentinelLike>;
}

interface WebKeepAwakeEnvironment {
  wakeLock?: WakeLockLike | null;
  doc?: {
    visibilityState?: string;
    addEventListener?: (type: string, listener: () => void) => void;
    removeEventListener?: (type: string, listener: () => void) => void;
  } | null;
  win?: {
    addEventListener?: (type: string, listener: () => void) => void;
    removeEventListener?: (type: string, listener: () => void) => void;
  } | null;
}

function defaultWakeLock(): WakeLockLike | null {
  try {
    const nav = typeof navigator === 'undefined' ? null : (navigator as Navigator & { wakeLock?: WakeLockLike });
    return nav?.wakeLock ?? null;
  } catch {
    return null;
  }
}

function defaultDocument(): WebKeepAwakeEnvironment['doc'] {
  try {
    return typeof document === 'undefined' ? null : document;
  } catch {
    return null;
  }
}

function defaultWindow(): WebKeepAwakeEnvironment['win'] {
  try {
    return typeof window === 'undefined' ? null : window;
  } catch {
    return null;
  }
}

export function createWebKeepAwakeAdapter(env: WebKeepAwakeEnvironment = {}): KeepAwakeAdapter {
  const doc = env.doc === undefined ? defaultDocument() : env.doc;
  const win = env.win === undefined ? defaultWindow() : env.win;
  const getLock = (): WakeLockLike | null => (env.wakeLock === undefined ? defaultWakeLock() : env.wakeLock);
  let desired = false;
  let sentinel: WakeLockSentinelLike | null = null;
  let bound = false;
  let chain: Promise<void> = Promise.resolve();

  const visible = (): boolean => doc?.visibilityState !== 'hidden';

  const releaseOne = async (target: WakeLockSentinelLike | null): Promise<void> => {
    if (target === null) return;
    try {
      if (!target.released) await target.release?.();
    } catch {
      // Browser already released it; nothing to report.
    }
    try {
      target.removeEventListener?.('release', onRelease);
    } catch {
      /* ignore */
    }
  };

  function onRelease(): void {
    sentinel = null;
    if (desired && visible()) void enqueue(acquire);
  }

  function onVisibility(): void {
    if (!desired) return;
    if (visible()) void enqueue(acquire);
    else void enqueue(async () => { await releaseOne(sentinel); sentinel = null; });
  }

  function onPageHide(): void {
    desired = false;
    void enqueue(async () => { await releaseOne(sentinel); sentinel = null; });
  }

  function bind(): void {
    if (bound) return;
    bound = true;
    try { doc?.addEventListener?.('visibilitychange', onVisibility); } catch { /* ignore */ }
    try { win?.addEventListener?.('pagehide', onPageHide); } catch { /* ignore */ }
  }

  async function acquire(): Promise<void> {
    if (!desired || sentinel !== null && sentinel.released !== true) return;
    const lock = getLock();
    if (lock === null) return;
    try {
      const next = await lock.request('screen');
      if (!desired || !visible()) {
        await releaseOne(next);
        return;
      }
      sentinel = next;
      try { next.addEventListener?.('release', onRelease); } catch { /* ignore */ }
    } catch {
      // Unsupported/insecure context/permission refusal: simply stay unlocked.
      sentinel = null;
    }
  }

  function enqueue(task: () => Promise<void>): Promise<void> {
    chain = chain.catch(() => {}).then(task).catch(() => {});
    return chain;
  }

  return {
    activate() {
      bind();
      desired = true;
      return enqueue(acquire);
    },
    deactivate() {
      desired = false;
      return enqueue(async () => {
        await releaseOne(sentinel);
        sentinel = null;
      });
    },
  };
}

export const keepAwakeAdapter: KeepAwakeAdapter = createWebKeepAwakeAdapter();
