// Test-only stub of `expo-keep-awake`; records the exact tag operations without touching a device.

const calls: string[] = [];
let failActivate = false;
let failDeactivate = false;

export const ExpoKeepAwakeTag = 'ExpoKeepAwakeDefaultTag';

export async function isAvailableAsync(): Promise<boolean> {
  return true;
}

export async function activateKeepAwakeAsync(tag: string = ExpoKeepAwakeTag): Promise<void> {
  calls.push(`activate:${tag}`);
  if (failActivate) throw new Error('stub keep-awake activation failure');
}

export async function deactivateKeepAwake(tag: string = ExpoKeepAwakeTag): Promise<void> {
  calls.push(`deactivate:${tag}`);
  if (failDeactivate) throw new Error('stub keep-awake deactivation failure');
}

export function keepAwakeCalls(): string[] {
  return [...calls];
}

export function resetKeepAwakeStub(): void {
  calls.length = 0;
  failActivate = false;
  failDeactivate = false;
}

export function failKeepAwakeActivate(fail = true): void {
  failActivate = fail;
}

export function failKeepAwakeDeactivate(fail = true): void {
  failDeactivate = fail;
}
