// Spec 062 — pure keep-awake gating.
//
// This module deliberately has no expo/react-native imports so it stays usable by `check:core`
// and unit tests. A stale `running` row is NOT enough: the socket must be ready and the app
// visible/unlocked, otherwise a disconnect or background page could keep the device awake.

export interface KeepAwakeSession {
  state: string;
}

export interface KeepAwakeDecisionInput {
  enabled: boolean;
  gateUnlocked: boolean;
  foreground: boolean;
  connection: string;
  sessions: readonly KeepAwakeSession[];
}

export function shouldKeepAwake(input: KeepAwakeDecisionInput): boolean {
  return (
    input.enabled &&
    input.gateUnlocked &&
    input.foreground &&
    input.connection === 'ready' &&
    input.sessions.some((session) => session.state === 'running')
  );
}
