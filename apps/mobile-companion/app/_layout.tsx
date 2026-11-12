// A020 — unlock gate root layout.
//
// The whole app sits behind a biometric / device-passcode gate: the credential is only read
// from the secure store after `unlock()` (FR-003, US1 §3). The gate also handles the
// "no screen lock configured" case explicitly instead of silently skipping protection, and
// routes a notification tap (deep link) to the right session/card after unlock (US6 §2).

import { createContext, useCallback, useContext, useEffect, useMemo, useRef, useState, type ReactNode } from 'react';
import { AppState, Platform, StyleSheet, Text, TouchableOpacity, View, useColorScheme } from 'react-native';
import { Stack, useRouter } from 'expo-router';
import { StatusBar } from 'expo-status-bar';
import * as Linking from 'expo-linking';
import { SafeAreaProvider } from 'react-native-safe-area-context';

import { AppController, type AppStateSnapshot, type WebLockSnapshot } from '../src/app-state';
import { parseSessionDeepLink, type UpdateRequired } from '../src/core';
import { StartupSequence } from '../src/core/startup';
import { UnlockAttempts } from '../src/core/unlock-attempt';
import { lockAction, unlockCopyKey } from '../src/core/web-lock';
import { authenticate, initialNotificationUrl, unlockCapability, unlockUnavailableKey } from '../src/platform';
import { detectLocale, t, type Interpolate, type Locale, type MessageKey } from '../i18n';
import { PairPanel } from '../src/ui/pair-panel';
// UI ported from Clarklevis1995/dsh-mobile androidApp/.../ui/DshTheme.kt (MIT).
// The gate and the update screen sit outside the Stack, so they read the scheme directly; the
// screens under the Stack read the same palette through `ThemeProvider` / `useTheme()`.
import { ThemeProvider, paletteFor } from '../src/ui/theme';
import { loadFontScale } from '../src/ui/font-scale-store';

type GateStatus = 'checking' | 'locked' | 'unlocked' | 'unavailable';

export default function RootLayout() {
  /**
   * The font scale is a saved preference (src/ui/font-scale-store.ts): read once at startup and handed
   * to the theme, which applies it to every screen. `undefined` until it arrives, so the first frame
   * renders at the default scale instead of waiting on storage.
   */
  const [fontScale, setFontScale] = useState<number | undefined>(undefined);
  useEffect(() => {
    let alive = true;
    void loadFontScale().then((saved) => {
      if (alive) setFontScale(saved);
    });
    return () => {
      alive = false;
    };
  }, []);
  const locale = useMemo<Locale>(() => detectLocale(localeTag()), []);
  const tr = useCallback<Interpolate>((key, params) => t(locale, key, params), [locale]);
  /**
   * Spec 021 — a web (PWA) install has no OS biometric, and its passkey can only be asserted on a
   * socket the Host has already paired: the platform gate below would call `authenticate()` before
   * any socket exists and refuse itself (`passkey.web.ts` answers `locked` without a ready client),
   * so the browser never reached the pairing screen at all. On web the Host's passkey lock IS the
   * gate, and it renders from the bootstrap state below instead.
   */
  const isWeb = Platform.OS === 'web';
  const controller = useMemo(() => new AppController({ locale: () => locale }), [locale]);
  const [snapshot, setSnapshot] = useState<AppStateSnapshot>(() => controller.snapshot());
  const [gate, setGate] = useState<GateStatus>('checking');
  const [gateMessage, setGateMessage] = useState<string | null>(null);
  const router = useRouter();
  const unlocking = useRef(false);
  /**
   * A020/M5 — identity of the unlock prompt in flight. Backgrounding, a newer prompt and an
   * unmount invalidate it (see `UnlockAttempts`), so a platform prompt that answers late can
   * neither re-open the gate nor connect the socket while the app is in the background.
   */
  const attemptsRef = useRef<UnlockAttempts | null>(null);
  if (attemptsRef.current === null) attemptsRef.current = new UnlockAttempts();
  const attempts = attemptsRef.current;
  /**
   * Cold start: `controller.start()` loads the stored host asynchronously and `unlock()` only
   * connects a host that is already installed, so an unlock that races the start reads the
   * credential with `host === null` and connects nothing (the app looks unlocked and stays
   * offline). Both paths await this one attempt; a failed start stays behind the gate and is
   * retryable instead of becoming an unhandled rejection.
   */
  const startup = useMemo(
    () => new StartupSequence({ start: () => controller.start(), reset: () => controller.stop() }),
    [controller],
  );

  useEffect(() => {
    // A020/M5: an unlock prompt that outlives the layout must not touch state or the controller.
    attempts.setMounted(true);
    return () => attempts.setMounted(false);
  }, [attempts]);

  useEffect(() => {
    const unsubscribe = controller.subscribe(setSnapshot);
    // One attempt, shared with the unlock path below: the gate may run before the host list is
    // loaded. `ensure()` records a failure (it never rejects); the unlock path reports it.
    void startup.ensure();
    return () => {
      unsubscribe();
      controller.stop();
    };
  }, [controller, startup]);

  const attemptUnlock = useCallback(
    async (auto: boolean) => {
      if (unlocking.current) return;
      unlocking.current = true;
      /** This prompt's identity; every post-await step is a no-op once it is superseded. */
      const attempt = attempts.begin();
      try {
        // A020/M5: never unlock before the stored host is loaded (`start()`), or the credential
        // is read with no active host and the app stays unlocked but unconnected. The same guard
        // covers the trip through the start: a background lock or unmount makes this attempt
        // stale, so its answer can neither open the gate nor connect.
        const started = await startup.ensure();
        if (!attempts.isCurrent(attempt)) return;
        if (!started) {
          // Startup failed (secure store / notification setup). Stay behind the gate and let the
          // button retry: the next `ensure()` runs `stop()` + `start()` again.
          setGate('locked');
          setGateMessage(tr('unlock.failed'));
          return;
        }
        const capability = await unlockCapability();
        if (!attempts.isCurrent(attempt)) return;
        if (capability === 'unavailable') {
          setGate('unavailable');
          // Platform-chosen copy: native points at the OS screen lock, web (which has none) points
          // at signing in on the computer. See `src/platform/unlock-copy*.ts`.
          setGateMessage(tr(unlockUnavailableKey()));
          return;
        }
        const result = await authenticate(tr('unlock.prompt'), controller.passkeyConnection);
        // A020/M5: the platform prompt outlives a background lock, a newer attempt or an
        // unmount, so its answer is only usable while this attempt is still current. Acting on
        // a stale success would open the gate and read the credential in the background.
        if (!attempts.isCurrent(attempt)) return;
        if (!result.ok) {
          setGate('locked');
          setGateMessage(unlockFailureCopy(result.reason, tr));
          return;
        }
        setGateMessage(result.capability === 'passcode' ? tr('unlock.passcodeOnly') : null);
        setGate('unlocked');
        await controller.unlock();
        // A web device is still LOCKED on its socket while the passkey asserts; the Host's `webLock`
        // decides that, and the gate above it renders the lock screen (`WebLockGate`). A successful
        // passkey assertion clears it in the snapshot, which re-renders this tree unstuck.
        if (!attempts.isCurrent(attempt)) return;
        const pending = controller.takeDeepLink() ?? (await initialNotificationUrl().then(parseLink));
        if (pending !== null && attempts.isCurrent(attempt)) {
          router.push(`/session/${encodeURIComponent(pending.sessionId)}${pending.approvalId === null ? '' : `?a=${encodeURIComponent(pending.approvalId)}`}`);
        }
      } finally {
        unlocking.current = false;
      }
    },
    [attempts, controller, router, startup, tr],
  );

  // Re-lock whenever the app leaves the foreground (the credential must not stay usable).
  useEffect(() => {
    const subscription = AppState.addEventListener('change', (next) => {
      // A020/M5: only `background` is a credential boundary. Reporting `inactive` would cancel
      // the attempt while the system biometric/passcode sheet is open (iOS reports it there).
      if (next === 'active') {
        attempts.setForeground(true);
        return;
      }
      if (next !== 'background') return;
      attempts.setForeground(false);
      // M5: locking is a credential boundary, not only a visual one — the controller stops
      // the reconnect loop and closes the socket (its token-bearing closure is released).
      controller.lock();
      // 'checking' is included: an auto-prompt abandoned by this lock must not leave the gate
      // spinning — a superseded attempt no longer sets 'locked' itself.
      setGate((current) => (current === 'unlocked' || current === 'checking' ? 'locked' : current));
    });
    return () => subscription.remove();
  }, [attempts, controller]);

  useEffect(() => {
    if (gate === 'checking' && !isWeb) void attemptUnlock(true);
  }, [gate, attemptUnlock, isWeb]);

  /**
   * Spec 021 — on web the Host's confirmed assertion is what opens the gate.
   *
   * `snapshot.unlocked` is set by the controller only after `passkey-assert` came back unlocked
   * (§14.1), so this mirrors a Host decision rather than a local one; the platform-gate copy is
   * skipped because there is no OS prompt to explain (`unlock.passcodeOnly` would be a lie).
   */
  useEffect(() => {
    if (!isWeb || !snapshot.unlocked || gate === 'unlocked') return;
    attempts.setForeground(true);
    setGateMessage(null);
    setGate('unlocked');
  }, [attempts, gate, isWeb, snapshot.unlocked]);

  /**
   * Spec 021 — a reloaded web page needs a LIVE socket before it can assert anything (§14.2), and
   * the Host locks every new connection, so one is opened here, locked: nothing is read through it
   * until the assertion is confirmed. No-op on native.
   */
  useEffect(() => {
    if (!isWeb || snapshot.activeHost === null || snapshot.unlocked) return;
    void controller.startWebLockSession();
  }, [controller, isWeb, snapshot.activeHost, snapshot.unlocked]);

  useEffect(() => {
    const subscription = Linking.addEventListener('url', (event) => {
      void controller.handleDeepLink(event.url);
    });
    return () => subscription.remove();
  }, [controller]);

  useEffect(() => {
    controller.setNotificationCopy({
      title: tr('notice.notification.title'),
      body: (toolName) => tr('notice.notification.body', { tool: toolName }),
    });
  }, [controller, tr]);

  // Themed chrome from the first frame: the scheme is resolved before anything renders, so neither
  // the gate nor the stack can flash a white screen (spec 011 P1-A item 2).
  const palette = paletteFor(useColorScheme() === 'light' ? 'light' : 'dark');
  const locked = gate === 'checking' || gate === 'locked' || gate === 'unavailable';
  const updateRequired = snapshot.updateRequired;
  /**
   * Spec 021 (contract §14.2): the HOST's passkey lock, above the platform gate. A web device that
   * has paired but not asserted its passkey on this socket may see nothing else — no session list,
   * no conversation — even though the credential is already readable.
   */
  const webLock = snapshot.webLock;

  return (
    <SafeAreaProvider>
      <ThemeProvider initialFontScale={fontScale}>
      <StatusBar style={palette.isDark ? 'light' : 'dark'} />
      {locked ? (
        isWeb ? (
          /*
            Spec 021 — on web the Host's passkey lock IS the gate. `authenticate()` cannot answer
            before a paired socket exists (`passkey.web.ts` refuses without a ready client), so the
            platform gate below kept a fresh install shut forever, and the passkey screen inside the
            unlocked branch was never reached. This bootstrap renders pairing / register / assert
            from a state that needs no prior unlock and exposes no Host data; `snapshot.unlocked`
            flips (and the gate opens, see the effect above) only when the Host confirms.
          */
          <WebBootstrap
            controller={controller}
            snapshot={snapshot}
            tr={tr}
            onRegister={() => void controller.registerAndUnlockWebPasskey()}
            onUnlock={() => void controller.unlockWithPasskey()}
          />
        ) : (
          <View style={[styles.gate, { backgroundColor: palette.bg }]}>
            <Text style={[styles.title, { color: palette.text }]}>{tr('unlock.title')}</Text>
            <Text style={[styles.subtitle, { color: palette.textMuted }]}>{tr('unlock.subtitle')}</Text>
            {gateMessage !== null ? <Text style={[styles.message, { color: palette.warning }]}>{gateMessage}</Text> : null}
            {gate === 'checking' ? null : (
              <TouchableOpacity
                style={[styles.button, { backgroundColor: palette.accent }]}
                accessibilityRole="button"
                accessibilityLabel={gate === 'unavailable' ? tr('common.ok') : tr('unlock.button')}
                onPress={() => {
                  setGate('locked');
                  setGateMessage(null);
                  void attemptUnlock(false);
                }}
              >
                <Text style={[styles.buttonText, { color: palette.onAccent }]}>{gate === 'unavailable' ? tr('common.ok') : tr('unlock.button')}</Text>
              </TouchableOpacity>
            )}
          </View>
        )
      ) : webLock !== null && webLock.state !== 'unlocked' ? (
        // Spec 021 (contract §14.2): the HOST's passkey lock, inside the unlocked branch and above
        // the navigator. The platform gate has opened, but a web socket that has not asserted its
        // passkey may see nothing else — no session list, no conversation. Rendering it here (not
        // before the gate) keeps the A020 rule that no route mounts until the platform unlock.
        <WebLockGate
          lock={webLock}
          tr={tr}
          // A registration opens no socket (§14.1), so the create action asserts in the same step:
          // a device that has just made its passkey must not be left locked with only that button.
          onRegister={() => void controller.registerAndUnlockWebPasskey()}
          onUnlock={() => void controller.unlockWithPasskey()}
        />
      ) : (
        <AppProvider controller={controller} snapshot={snapshot} tr={tr} locale={locale}>
          <Stack
            screenOptions={{
              headerShown: true,
              headerStyle: { backgroundColor: palette.bg },
              headerTintColor: palette.text,
              headerShadowVisible: false,
              contentStyle: { backgroundColor: palette.bg },
            }}
          >
            <Stack.Screen name="(tabs)" options={{ headerShown: false }} />
        {/* Spec 011 parity: Settings is pushed from the ⋯ menu, not a tab. */}
        <Stack.Screen name="settings" options={{ title: tr('settings.title') }} />
        <Stack.Screen name="storage" options={{ title: tr('storage.title') }} />
        <Stack.Screen name="privacy" options={{ title: tr('privacy.title') }} />
        {/* Spec 018 item 3: read-only scheduled tasks; the row that opens it is drawn only with the grant. */}
        <Stack.Screen name="schedules" options={{ title: tr('schedules.title') }} />
            <Stack.Screen name="pair" options={{ title: tr('pair.title') }} />
            <Stack.Screen name="session/[id]" options={{ title: tr('common.host') }} />
            <Stack.Screen name="s/[id]" options={{ headerShown: false }} />
            <Stack.Screen name="s/index" options={{ headerShown: false }} />
          </Stack>
          {updateRequired !== null ? (
            // N7: a protocol mismatch is terminal for this connection, so it gets an actionable
            // screen (what to update, retry, and a way to pair a different computer) instead of a
            // silent failure or a stale session list. It overlays the stack so "pair another
            // computer" can still navigate.
            <UpdateRequiredScreen
              update={updateRequired}
              tr={tr}
              onRetry={() => void controller.retryConnection()}
              onPairAnother={() => {
                controller.dismissUpdateRequired();
                router.replace('/pair');
              }}
            />
          ) : null}
        </AppProvider>
      )}
      </ThemeProvider>
    </SafeAreaProvider>
  );
}

/**
 * Spec 021 — the web bootstrap: what a browser may see BEFORE the Host has confirmed its passkey.
 *
 * Three states, and no Host data in any of them (a locked web socket sees no title, count or id):
 *   * no paired host        -> the pair screen, so a fresh install can start at all;
 *   * paired, lock reported -> the passkey register / assert / approval screen;
 *   * paired, no socket yet -> the same action, which opens the locked socket it needs first.
 *
 * Nothing here reads the session list, and none of it waits on the platform gate: on web the
 * Host's assertion is the gate. `snapshot.unlocked` flips only when the Host confirms (§14.1), at
 * which point the root layout renders the navigator instead.
 */
function WebBootstrap(props: {
  controller: AppController;
  snapshot: AppStateSnapshot;
  tr: Interpolate;
  onRegister: () => void;
  onUnlock: () => void;
}) {
  const { controller, snapshot, tr, onRegister, onUnlock } = props;
  const palette = paletteFor(useColorScheme() === 'light' ? 'light' : 'dark');
  if (snapshot.activeHost === null) {
    // The pair panel takes the controller through props, so the bootstrap needs no `useApp` context
    // (there is no navigator it could belong to) and the pairing rules stay in one place.
    return <PairPanel controller={controller} snapshot={snapshot} tr={tr} />;
  }
  const lock: WebLockSnapshot = snapshot.webLock ?? {
    // Paired but no `hello` yet (no socket): a web install waits for its passkey, which is the same
    // state the Host reports on a fresh connection. Without this the screen would have no action
    // and the install would deadlock on "unlocked but locked".
    state: 'locked',
    reason: 'locked',
    approval: null,
    error: null,
  };
  return <WebLockGate lock={lock} tr={tr} onRegister={onRegister} onUnlock={onUnlock} />;
}

/**
 * Spec 021 — the passkey lock screen of a web (PWA) device.
 *
 * While locked the Host answers nothing but hello/ping and the passkey frames, so this screen is the
 * only thing the browser can do anyway; showing it is the honest rendering of that server-side lock.
 * The action comes from the lock state: `unregistered`/`not-registered` create a passkey,
 * `already-registered` waits for the owner, everything else asserts.
 */
function WebLockGate(props: {
  lock: WebLockSnapshot;
  tr: Interpolate;
  onRegister: () => void;
  onUnlock: () => void;
}) {
  const { lock, tr, onRegister, onUnlock } = props;
  const palette = paletteFor(useColorScheme() === 'light' ? 'light' : 'dark');
  const action = lockAction(lock.state);
  const copyKey = unlockCopyKey({ state: lock.state, error: lock.error });
  const approval = lock.approval;
  return (
    <View style={styles.gate} testID="web-lock-gate">
      <Text style={[styles.title, { color: palette.text }]}>{tr('unlock.title')}</Text>
      <Text style={[styles.subtitle, { color: palette.textMuted }]} accessibilityLabel={copyKey === null ? undefined : 'web-lock-reason'}>
        {copyKey === null ? tr('unlock.passkeyLocked') : tr(copyKey as MessageKey)}
      </Text>
      {approval === null ? null : (
        <Text style={[styles.message, { color: palette.textMuted }]}>
          {tr(approval.action === 'approve' ? 'unlock.passkeyApproval' : 'unlock.passkeyLocked')}
        </Text>
      )}
      <TouchableOpacity
        style={[styles.button, { backgroundColor: palette.accent }]}
        accessibilityRole="button"
        testID="web-lock-action"
        accessibilityLabel={tr(action === 'register' || action === 'approve' ? 'unlock.passkeyRegister' : 'unlock.button')}
        // The owner decides `already-registered` on the Host: pressing again re-asks for options,
        // which is what reports whether the approval has landed (contract §14.3).
        onPress={action === 'unlock' ? onUnlock : onRegister}
      >
        <Text style={[styles.buttonText, { color: palette.onAccent }]}>
          {tr(action === 'unlock' ? 'unlock.button' : 'unlock.passkeyRegister')}
        </Text>
      </TouchableOpacity>
    </View>
  );
}

/**
 * The sentence one failed platform-gate attempt shows. Native reasons keep their own copy; a web
 * passkey reason goes through `LOCK_COPY`, so no reason is ever shown as the generic failure.
 */
function unlockFailureCopy(reason: string | undefined, tr: Interpolate): string {
  switch (reason) {
    case 'user-cancel':
      return tr('unlock.cancelled');
    case 'locked-out':
      return tr('unlock.lockedOut');
    case 'unavailable':
      return tr(unlockUnavailableKey());
    case 'not-supported':
      return tr('unlock.passkeyUnsupported');
    case 'rate-limited':
      return tr('unlock.passkeyRateLimited');
    case 'challenge-expired':
      return tr('unlock.passkeyExpired');
    case 'verification-failed':
      return tr('unlock.passkeyFailed');
    case 'not-registered':
      return tr('unlock.passkeyNotRegistered');
    case 'already-registered':
      return tr('unlock.passkeyApproval');
    case 'unregistered':
      return tr('unlock.passkeyRegister');
    case 'locked':
      return tr('unlock.passkeyLocked');
    default:
      return tr('unlock.failed');
  }
}

/** N7 — the app and the host cannot talk until one side updates: say which, and offer a retry. */function UpdateRequiredScreen(props: {
  update: UpdateRequired;
  tr: Interpolate;
  onRetry: () => void;
  onPairAnother: () => void;
}) {
  const { update, tr, onRetry, onPairAnother } = props;
  const palette = paletteFor(useColorScheme() === 'light' ? 'light' : 'dark');
  const appSide = update.side === 'app';
  const version = update.minClientVersion ?? update.hostCompanionProtocol;
  return (
    <View style={[styles.overlay, { backgroundColor: palette.bg }]} accessibilityViewIsModal>
      <View style={styles.gate}>
        <Text style={[styles.title, { color: palette.text }]}>{tr(appSide ? 'update.appTitle' : 'update.hostTitle')}</Text>
        <Text style={[styles.subtitle, { color: palette.textMuted }]}>{tr(appSide ? 'update.appBody' : 'update.hostBody')}</Text>
        {version === undefined ? null : <Text style={[styles.message, { color: palette.warning }]}>{tr('update.details', { version })}</Text>}
        <TouchableOpacity style={[styles.button, { backgroundColor: palette.accent }]} accessibilityRole="button" onPress={onRetry}>
          <Text style={[styles.buttonText, { color: palette.onAccent }]}>{tr('update.retry')}</Text>
        </TouchableOpacity>
        <TouchableOpacity style={[styles.secondary, { backgroundColor: palette.surface }]} accessibilityRole="button" onPress={onPairAnother}>
          <Text style={[styles.secondaryText, { color: palette.text }]}>{tr('update.pairAnother')}</Text>
        </TouchableOpacity>
      </View>
    </View>
  );
}

function localeTag(): string | null {
  // Hermes' Intl is complete in RN 0.88; guard anyway so a missing Intl never breaks the gate.
  try {
    return Intl.DateTimeFormat().resolvedOptions().locale ?? null;
  } catch {
    return null;
  }
}

function parseLink(url: string | null): { sessionId: string; approvalId: string | null } | null {
  return url === null ? null : parseSessionDeepLink(url);
}

// ---------------------------------------------------------------------------
// Context handed to the screens
// ---------------------------------------------------------------------------

interface AppContextValue {
  controller: AppController;
  snapshot: AppStateSnapshot;
  tr: Interpolate;
  locale: Locale;
}

const AppContext = createContext<AppContextValue | null>(null);

export function AppProvider({ controller, snapshot, tr, locale, children }: AppContextValue & { children: ReactNode }) {
  return <AppContext.Provider value={{ controller, snapshot, tr, locale }}>{children}</AppContext.Provider>;
}

export function useApp(): AppContextValue {
  const value = useContext(AppContext);
  if (value === null) throw new Error('useApp() outside the unlock gate');
  return value;
}

// Colours are supplied per-render from the theme palette (spec 011: no hex literal outside
// src/ui/theme.ts); these styles carry layout/typography only.
const styles = StyleSheet.create({
  overlay: { position: 'absolute', top: 0, left: 0, right: 0, bottom: 0 },
  gate: { flex: 1, alignItems: 'center', justifyContent: 'center', padding: 32, gap: 12 },
  title: { fontSize: 26, fontWeight: '700' },
  subtitle: { fontSize: 15, textAlign: 'center' },
  message: { fontSize: 14, textAlign: 'center', marginTop: 8 },
  button: { marginTop: 16, paddingHorizontal: 28, paddingVertical: 14, borderRadius: 12, minHeight: 44, justifyContent: 'center' },
  buttonText: { fontSize: 16, fontWeight: '600' },
  secondary: { marginTop: 4, paddingHorizontal: 20, paddingVertical: 12, borderRadius: 10, minHeight: 44, justifyContent: 'center' },
  secondaryText: { fontSize: 15, fontWeight: '600' },
});
