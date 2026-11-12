// The pairing's `web:unlock` grant — NATIVE: nothing to record.
//
// The passkey unlock is web-only by contract: a native device never carries `web:unlock`, never
// receives `hello.webLock` and never sees a lock (spec 021, revision 14). The real implementation is
// the `*.web.ts` sibling Metro picks on the `web` platform, which is how "only on web" is enforced
// without a `Platform.OS` check in `src/app-state.ts`.
//
// Both files share one signature so shared code can call it unconditionally.

/** No-op on native: nothing carries `web:unlock`, so nothing is remembered. Resolves `false`. */
export async function saveWebUnlockGrant(_scopes: readonly string[]): Promise<boolean> {
  return false;
}

/** No-op on native: there is never a web unlock grant to read. */
export async function readWebUnlockGrant(): Promise<boolean> {
  return false;
}
