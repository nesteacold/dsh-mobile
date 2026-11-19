// The confirm step in front of "forget this computer and pair again" (the lock gate's escape hatch).
//
// Why this is its own module and not an inline `Alert.alert(...)`:
//   * `react-native-web`'s `Alert.alert` is a NO-OP (`static alert() {}`), so on a PWA the button did
//     nothing at all — and the PWA is exactly where the gate has no other way out. Web therefore
//     asks with the browser's own `confirm()`; native keeps the destructive `Alert`.
//   * The decision "ask, and only on yes call forget() once" is pure, so it can be executed in the
//     Node suite (the layout itself has no render harness there).
//
// It never forgets without an explicit yes: a dismissed dialog (web `false`, native cancel/backdrop)
// leaves the pairing untouched.

export interface ConfirmForgetCopy {
  /** Dialog title; also the destructive button's label on native. */
  title: string;
  /** What is removed and what is not (kept honest by `unlock.forgetRepairConfirm`). */
  message: string;
  cancel: string;
}

/** The `Alert.alert` button shape this module relies on (a structural subset of RN's). */
export interface ForgetAlertButton {
  text: string;
  style?: 'default' | 'cancel' | 'destructive';
  onPress?: () => void;
}

export interface ConfirmForgetDeps {
  /** `Platform.OS`; only the literal `'web'` takes the browser confirm path. */
  platform: string;
  /** The browser's synchronous `confirm` (web only). Returning `true` means "yes, forget". */
  confirm: (message: string) => boolean;
  /** RN's `Alert.alert` (native only). */
  alert: (title: string, message: string, buttons: ForgetAlertButton[]) => void;
  /** The controller's `forget()`: runs at most once per call, and only after a yes. */
  forget: () => void | Promise<void>;
  copy: ConfirmForgetCopy;
}

export function confirmAndForget(deps: ConfirmForgetDeps): void {
  const { platform, confirm, alert, forget, copy } = deps;
  if (platform === 'web') {
    // `confirm()` has no title slot, so the title leads the message to keep the same two-part copy.
    if (confirm(`${copy.title}\n\n${copy.message}`)) void forget();
    return;
  }
  alert(copy.title, copy.message, [
    { text: copy.cancel, style: 'cancel' },
    { text: copy.title, style: 'destructive', onPress: () => void forget() },
  ]);
}

/**
 * The browser's `confirm`, or a refusing stand-in when there is none.
 *
 * "No dialog available" must read as "not confirmed": silently forgetting a pairing because the
 * environment cannot ask would be the destructive failure mode.
 */
export function browserConfirm(): (message: string) => boolean {
  const g = globalThis as { confirm?: (message?: string) => boolean };
  return typeof g.confirm === 'function' ? (message) => g.confirm?.(message) === true : () => false;
}
