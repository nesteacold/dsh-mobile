// A021 — pair screen (US1): scan the QR with expo-camera or paste the code, then pair.
//
// Error states required by spec 002 US1 + edge cases, each mapped from a typed core code:
//   * remote control off on the host      -> "turn on remote control on your computer"
//   * expired / reused code               -> show a new code
//   * certificate mismatch                -> not that computer, nothing was sent
//   * unreachable host                    -> same network / gateway running
//   * protocol mismatch                   -> update app / update host
//   * camera permission denied            -> paste instead
//
// The pairing code is never displayed, logged or put in a URL (FR-011).
//
// Lives here (not only in `app/pair.tsx`) because the web bootstrap of the root layout renders it
// before any route mounts: a browser whose passkey cannot be asserted yet has no navigator, and the
// pair screen is the one screen a fresh install needs. The route file stays a thin wrapper, so both
// entry points share one implementation instead of duplicating the pairing rules.

import { useCallback, useEffect, useMemo, useState } from 'react';
import { ActivityIndicator, Platform, ScrollView, StyleSheet, Text, TextInput, TouchableOpacity, View } from 'react-native';
import { CameraView, useCameraPermissions } from 'expo-camera';

import type { AppController, AppStateSnapshot } from '../app-state';
import { GATEWAY_WS_PATH, planOtpAddress, planPairSubmit } from '../core/gateway-address';
import { pairFailureDetail, pairFailureStageFromCode } from '../core/pair-failure';
import { normalizeOtp, OTP_DIGITS } from '../core/pairing-otp';
import { readWebLocation } from '../platform/web-location';
import { consumePairHash } from '../platform/pair-hash';
import { parsePairLinkUrl, type PairLink } from '../core/pair-link';
import { pairErrorFromCode, pairErrorFromQr, type Interpolate, type MessageKey } from '../../i18n';
// UI ported from Clarklevis1995/dsh-mobile androidApp/.../ui/GatewayAuthenticationUi.kt (MIT).
import { useTheme } from './theme';
import type { Palette } from './theme';

/**
 * How this phone is being paired:
 *  - `code`: the Host shows a QR (or a pasteable long string) — scanned or pasted here;
 *  - `otp`: the Host user pressed "Generate pairing code", so the phone is given an 8-digit code
 *    and the Host's address. Two screens' worth of state, one component, because both end in the
 *    same approval wait and share the failure mapping.
 */
type PairMode = 'code' | 'otp';

export function PairPanel(props: {
  controller: AppController;
  snapshot: AppStateSnapshot;
  tr: Interpolate;
  /**
   * Called after a successful pairing. The route passes a navigation here; the web bootstrap passes
   * nothing, because there is no navigator yet and the controller's snapshot re-renders the tree.
   */
  onPaired?: () => void;
}) {
  const { controller, snapshot, tr, onPaired } = props;
  const { colors } = useTheme();
  const styles = makeStyles(colors);
  const [permission, requestPermission] = useCameraPermissions();
  const [mode, setMode] = useState<PairMode>('code');
  const [manual, setManual] = useState('');
  const [otpCode, setOtpCode] = useState('');
  // Native only: the supported-page branch never renders a typeable address (spec 031 §8).
  const [otpAddress, setOtpAddress] = useState('');
  const [busy, setBusy] = useState(false);
  const [scanLocked, setScanLocked] = useState(false);
  const [failure, setFailure] = useState<MessageKey | null>(null);
  // Spec 032: the code behind a generic failure, and the stage `pair()` recorded for it. Demo mode
  // only (see `pairFailureDetail`); in a normal build `controller.demoMode` is false, `detail` stays
  // null and nothing below renders — the shipped screen is unchanged.
  const [failureCode, setFailureCode] = useState<{ code: string; stage: ReturnType<typeof pairFailureStageFromCode> } | null>(null);
  const [connectingTo, setConnectingTo] = useState<string | null>(null);
  // The gateway address this page dials (spec 020), or null on native / a page that is not served
  // from a tailnet HTTPS origin. Computed once: the origin cannot change under a mounted screen
  // (`tailscale serve` never rewrites the page), and reading it per render would make the hint
  // depend on a global this component does not own.
  //
  // Spec 031 §8: the PAGE's own origin is the sole authority for the browser. It is shown as
  // read-only text (never a field that could be typed over and ignored), and a foreign page refuses
  // the one-time-code flow here instead of falling back to an address someone typed.
  const web = useMemo(() => planOtpAddress(Platform.OS === 'web' ? readWebLocation() : null), []);
  const webOrigin = web.kind === 'same-origin' ? web.origin : null;
  const webGatewayUrl = web.kind === 'same-origin' ? web.url : null;
  const webUnsupportedKey: MessageKey | null = web.kind === 'unsupported'
    ? (web.reason === 'insecure' ? 'pair.webUnsupportedInsecure' : 'pair.webUnsupported')
    : null;
  // The code form needs a reason to hide when an unsupported page is opened with a pairing link.
  const otpBlocked = web.kind === 'unsupported';

  // The copy for a submit the seam blocked. Both forms read the same decision, so neither can
  // disagree with the other about a foreign page.
  const refusalKey = useCallback(
    (decision: Extract<ReturnType<typeof planPairSubmit>, { kind: 'blocked' }>): MessageKey => {
      switch (decision.reason) {
        case 'insecure':
          return 'pair.webUnsupportedInsecure';
        case 'otpNative':
          return 'pair.error.otpNative';
        case 'otpLinkNative':
          return 'pair.error.otpLinkNative';
        default:
          // `not-tailnet`: the host/HTTPS guidance already shown for this page.
          return webUnsupportedKey ?? 'pair.webUnsupported';
      }
    },
    [webUnsupportedKey],
  );

  // The pairing-code link (`/pair#a=…&c=…`, the desktop dialog's QR). Read once on mount; the web
  // adapter strips the fragment from the address bar before anything else sees it. The form is only
  // PRE-FILLED: nothing is dialled until the user taps Pair, and the Host still approves.
  //
  // Only the CODE is taken from it. The link's `a=` address is never adopted: on a supported page
  // the address is the page's own origin, so a link cannot redirect the app to another host.
  const [prefilled, setPrefilled] = useState(false);
  const applyPairLink = useCallback((link: PairLink) => {
    setMode('otp');
    setOtpCode(link.otp);
    setFailure(null);
    setPrefilled(true);
    // Spec 032: the previous failure's diagnosis goes with the failure it described.
    setFailureCode(null);
  }, []);
  useEffect(() => {
    const link = consumePairHash();
    if (link !== null) applyPairLink(link);
  }, [applyPairLink]);

  const submit = useCallback(
    async (raw: string) => {
      if (busy || raw.trim() === '') return;
      setFailure(null);
      // A scanned/pasted pairing-code link is not a pairing string. The web pre-fills the code form;
      // a phone app keeps its rule (no OTP on native: a code carries no pin) and says so plainly.
      const link = parsePairLinkUrl(raw);
      // Spec 031 §8: one seam decides both flows, before any controller or socket exists. A page
      // that is not the gateway's tailnet HTTPS origin has no verified route, so a QR address or a
      // pasted long string is refused here too — not only the 8-digit code form.
      const decision = planPairSubmit(web, Platform.OS === 'web', link !== null);
      if (decision.kind === 'blocked') {
        setScanLocked(false);
        // A phone explains a code link; the web pre-fills it. Anything blocked is refused, with the
        // copy that already exists for its reason.
        if (decision.reason === 'otpNative' && link !== null) applyPairLink(link);
        else setFailure(refusalKey(decision));
        return;
      }
      if (link !== null) {
        // The web adopts only the link's CODE; its `a=` address never reaches the connect.
        applyPairLink(link);
        return;
      }
      setBusy(true);
      // Spec 032: and the previous failure's diagnosis goes with the failure it described.
      setFailureCode(null);
      const parsed = controller.parsePairPayload(raw);
      if (!parsed.ok) {
        setFailure(errorKey(pairErrorFromQr(parsed.code as never)));
        // Spec 032: the panel refused before `pair()` ran, so the stage is the payload's own.
        setFailureCode({ code: parsed.code, stage: pairFailureStageFromCode(parsed.code) });
        setBusy(false);
        setScanLocked(false);
        return;
      }
      setConnectingTo(parsed.payload.gatewayName);
      const result = await controller.pair(raw);
      setBusy(false);
      if (result.ok) {
        onPaired?.();
        return;
      }
      setConnectingTo(null);
      setFailure(errorKey(pairErrorFromCode(result.code)));
      // The controller logged the stage it refused at; `pair()` does not return it, so the code's
      // own family decides it here (a `qr/*` refusal is the payload parse, anything else the attempt).
      setFailureCode({ code: result.code, stage: pairFailureStageFromCode(result.code) });
      setScanLocked(false);
    },
    [busy, controller, onPaired, applyPairLink, web, refusalKey],
  );

  /**
   * Submit the one-time-code form (contract revision 5). The code is validated locally FIRST, so a
   * typo never opens a socket or spends one of the Host's three proof attempts; a supported page
   * dials its OWN origin, which `planOtpAddress` already derived.
   */
  const submitOtp = useCallback(async () => {
    if (busy) return;
    setFailure(null);
    setFailureCode(null);
    const normalized = normalizeOtp(otpCode);
    if (!normalized.ok) {
      setFailure(normalized.reason === 'otp/empty' ? 'pair.error.otpRequired' : 'pair.error.otpBadLength');
      return;
    }
    // Spec 031 §8: a page that is not served from the gateway's tailnet HTTPS origin has no verified
    // route to it, and no typed address is accepted as a fallback. Refuse before any socket exists.
    // The same seam decides both forms: on an unsupported page nothing dials, and a phone cannot
    // complete this flow at all — an 8-digit code carries no certificate, and the native transport
    // refuses an unpinned socket outright (see `createPinnedTransport`). Attempting it would spend
    // one of the Host's three proof attempts before the transport refused.
    const decision = planPairSubmit(web, Platform.OS === 'web', false);
    if (decision.kind === 'blocked') {
      setFailure(refusalKey(decision));
      return;
    }
    if (decision.kind !== 'otp') {
      // Native lands here (the seam answers `qr` off the web): an 8-digit code has no pin, refuse.
      setFailure('pair.error.otpNative');
      return;
    }
    const { url, origin } = decision;
    setBusy(true);
    setConnectingTo(origin);
    // The pin is deliberately NOT supplied here: the OTP offer carries the fingerprint and the
    // challenge states the leaf the proof is keyed to, which is the contract's trust-on-first-use
    // for a code that cannot carry one. The controller stores what it adopted.
    const result = await controller.pair('', { otp: { otp: normalized.otp, url, gatewayName: origin } });
    setBusy(false);
    // The code was spent either way; keep the field empty so a retry cannot resubmit it by accident.
    setOtpCode('');
    if (result.ok) {
      onPaired?.();
      return;
    }
    setConnectingTo(null);
    setFailure(errorKey(pairErrorFromCode(result.code)));
    setFailureCode({ code: result.code, stage: pairFailureStageFromCode(result.code) });
  }, [busy, controller, onPaired, otpCode, web, refusalKey]);

  // A pairing failure the controller recorded outside `pair()` (close 4004, version gate).
  useEffect(() => {
    if (snapshot.pairing === null) return;
    setFailure(errorKey(pairErrorFromCode(snapshot.pairing.code)));
    setFailureCode({ code: snapshot.pairing.code, stage: pairFailureStageFromCode(snapshot.pairing.code) });
  }, [snapshot.pairing]);

  /**
   * Spec 032 — the demo-only diagnosis line, or `null`.
   *
   * `controller.demoMode` is the same fact the controller refuses every non-loopback pairing on, and
   * it is the ONLY switch here: a normal build gets `null`, so the pair screen is unchanged. It is
   * computed at render (not stored) so it can never outlive a controller swap, and only a GENERIC
   * failure shows it — a code with its own copy already says what went wrong.
   */
  const failureDetail = failureCode === null || failure === null || failure !== 'pair.error.generic'
    ? null
    : pairFailureDetail({ demo: controller.demoMode, code: failureCode.code, stage: failureCode.stage });

  return (
    <ScrollView contentContainerStyle={styles.container} keyboardShouldPersistTaps="handled">
      <Text style={styles.heading}>{tr('pair.title')}</Text>

      {snapshot.pairingPending ? (
        // Contract §3.8: the proof was accepted and the desktop user must approve. The code the
        // desktop shows is the only thing that proves both ends are talking to each other, so it is
        // rendered large and centred (ported from GatewayAuthenticationUi.kt's approval state).
        <View style={styles.codeCard} accessibilityRole="summary" accessibilityLabel={tr('pair.waitingApproval', { code: snapshot.pairingPending.verificationCode })}>
          <ActivityIndicator color={colors.textMuted} />
          <Text style={styles.code}>{snapshot.pairingPending.verificationCode}</Text>
          <Text style={styles.codeHint}>{tr('pair.waitingApproval', { code: snapshot.pairingPending.verificationCode })}</Text>
        </View>
      ) : connectingTo !== null ? (
        <View style={styles.notice}>
          <ActivityIndicator />
          <Text style={styles.noticeText}>{tr('pair.connecting', { host: connectingTo })}</Text>
        </View>
      ) : null}

      {failure !== null ? (
        <View style={styles.error} accessibilityRole="alert">
          <Text style={styles.errorTitle}>{tr('pair.errorTitle')}</Text>
          <Text style={styles.errorText}>{tr(failure)}</Text>
          {/*
            Spec 032 — DEMO ONLY. Every cause above collapses into `pair.error.generic`, so a
            capture run (docs/remote-ios-build.md §4.9a) cannot tell a garbled fixture payload from a
            socket that never opened. This line names the code and the stage `pair()` refused at, in
            monospace so it is readable in a screenshot; `pairFailureDetail` returns null in a normal
            build, so a shipped screen renders exactly what it did before. Display text only: no
            gate, refusal or transport option reads it.
          */}
          {failureDetail !== null ? (
            <Text style={styles.failureDetail} testID="pair-failure-detail">{failureDetail}</Text>
          ) : null}
        </View>
      ) : null}

      {/* Which secret the Host handed over decides the form below. Both are offered because the
          Host has two buttons; the user should never have to guess which one the app wants. */}
      <View style={styles.modeRow}>
        <TouchableOpacity
          style={[styles.modeTab, mode === 'code' && styles.modeTabActive]}
          testID="pair-mode-code"
          accessibilityRole="tab"
          accessibilityState={{ selected: mode === 'code' }}
          onPress={() => { setMode('code'); setFailure(null); setFailureCode(null); }}
        >
          <Text style={[styles.modeText, mode === 'code' && styles.modeTextActive]}>{tr('pair.modeCode')}</Text>
        </TouchableOpacity>
        <TouchableOpacity
          style={[styles.modeTab, mode === 'otp' && styles.modeTabActive]}
          testID="pair-mode-otp"
          accessibilityRole="tab"
          accessibilityState={{ selected: mode === 'otp' }}
          onPress={() => { setMode('otp'); setFailure(null); setFailureCode(null); }}
        >
          <Text style={[styles.modeText, mode === 'otp' && styles.modeTextActive]}>{tr('pair.modeOtp')}</Text>
        </TouchableOpacity>
      </View>

      {mode === 'otp' ? (
        <>
          {/* Spec 031 §8: a page that is not the gateway's origin has no verified route, so the code
              flow is refused here with the host/HTTPS guidance — never an address to type instead.
              The box sits where the form would be, so a pairing link cannot hide the reason. */}
          {otpBlocked ? (
            <View style={styles.error} accessibilityRole="alert">
              <Text style={styles.errorTitle}>{tr('pair.errorTitle')}</Text>
              {webOrigin !== null ? <Text style={styles.errorText}>{tr('pair.webOrigin', { origin: webOrigin })}</Text> : null}
              <Text style={styles.errorText} testID="pair-web-unsupported">{tr(webUnsupportedKey ?? 'pair.webUnsupported')}</Text>
            </View>
          ) : (
            <>
              {prefilled ? (
                <Text style={styles.addressHint}>{tr('pair.linkPrefilled')}</Text>
              ) : null}
              {webGatewayUrl !== null ? (
                <>
                  {/* Read-only on purpose: this is the address the page really dials, and a field
                      here was editable while its input was ignored (spec 031 §8). */}
                  <Text style={styles.section}>{tr('pair.webAddressLabel')}</Text>
                  <Text style={styles.addressHint} testID="pair-otp-origin">{tr('pair.webOrigin', { origin: webOrigin ?? '' })}</Text>
                  <Text style={styles.addressHint}>{tr('pair.webOriginFixed', { url: webGatewayUrl })}</Text>
                </>
              ) : (
                <>
                  {/* Native: the form is typeable, but the code itself is refused before any
                      connection (a code carries no certificate to pin), as it always was. */}
                  <Text style={styles.section}>{tr('pair.otpAddress')}</Text>
                  <TextInput
                    style={styles.input}
                    testID="pair-otp-address"
                    value={otpAddress}
                    onChangeText={setOtpAddress}
                    placeholder={tr('pair.otpAddressPlaceholder')}
                    autoCapitalize="none"
                    autoCorrect={false}
                    editable={!busy}
                    textContentType="none"
                    importantForAutofill="no"
                  />
                </>
              )}
              <Text style={styles.section}>{tr('pair.otpCode')}</Text>
              <TextInput
                style={styles.otpInput}
                testID="pair-otp-input"
                value={otpCode}
                onChangeText={setOtpCode}
                placeholder={tr('pair.otpPlaceholder')}
                // `number-pad` on a phone; the code is 8 digits, and a letter cannot be typed into it.
                keyboardType="number-pad"
                autoCapitalize="none"
                autoCorrect={false}
                editable={!busy}
                maxLength={12}
                // The one-time code stays on screen only while typing; it is never persisted.
                textContentType="oneTimeCode"
                importantForAutofill="no"
              />
              <TouchableOpacity
                style={[styles.primary, (busy || otpCode.trim() === '') && styles.disabled]}
                testID="pair-otp-submit"
                accessibilityRole="button"
                disabled={busy || otpCode.trim() === ''}
                onPress={() => void submitOtp()}
              >
                <Text style={styles.primaryText}>{tr('pair.submit')}</Text>
              </TouchableOpacity>
            </>
          )}
        </>
      ) : (
        <>
          {permission?.granted === false ? (
            <View style={styles.notice}>
              <Text style={styles.noticeText}>{tr('pair.cameraPermission')}</Text>
              <TouchableOpacity style={styles.secondary} onPress={() => void requestPermission()}>
                <Text style={styles.secondaryText}>{tr('pair.cameraPermissionButton')}</Text>
              </TouchableOpacity>
            </View>
          ) : permission?.granted ? (
            <View style={styles.cameraFrame}>
              <CameraView
                style={StyleSheet.absoluteFill}
                facing="back"
                barcodeScannerSettings={{ barcodeTypes: ['qr'] }}
                onBarcodeScanned={
                  scanLocked || busy
                    ? undefined
                    : (scan) => {
                        setScanLocked(true);
                        void submit(scan.data);
                      }
                }
              />
              <View style={styles.scanHint}>
                <Text style={styles.scanHintText}>{tr('pair.scan')}</Text>
              </View>
            </View>
          ) : (
            <View style={styles.notice}>
              <ActivityIndicator />
            </View>
          )}

          {/* Spec 020: on the web the app reaches the gateway through the origin it was served from
              (`tailscale serve` routes `/ws/mobile` there), not the self-signed address inside the QR —
              a browser refuses that one before any frame moves. Say which address will be used, so the
              owner is never surprised by what the app dials. Native reads `null` here, so this line
              never appears on a phone.
              Spec 031 §8: the same page origin is also the OTP target, so the unsupported-host
              guidance is shown up front instead of only under the code tab. */}
          {webGatewayUrl !== null ? (
            <Text style={styles.addressHint}>{tr('pair.webAddress', { url: webGatewayUrl })}</Text>
          ) : webUnsupportedKey !== null ? (
            <View style={styles.notice}>
              {webOrigin !== null ? <Text style={styles.noticeText}>{tr('pair.webOrigin', { origin: webOrigin })}</Text> : null}
              <Text style={styles.noticeText}>{tr(webUnsupportedKey)}</Text>
            </View>
          ) : null}
          <Text style={styles.section}>{tr('pair.manual')}</Text>
          <TextInput
            style={styles.input}
            testID="pair-manual-input"
            value={manual}
            onChangeText={setManual}
            placeholder={tr('pair.manualPlaceholder')}
            autoCapitalize="none"
            autoCorrect={false}
            multiline
            numberOfLines={3}
            editable={!busy}
            // The pasted code stays on screen only while typing; it is never persisted.
            textContentType="none"
            importantForAutofill="no"
          />
          <TouchableOpacity
            style={[styles.primary, (busy || manual.trim() === '') && styles.disabled]}
            testID="pair-submit"
            accessibilityRole="button"
            disabled={busy || manual.trim() === ''}
            onPress={() => void submit(manual)}
          >
            <Text style={styles.primaryText}>{tr('pair.submit')}</Text>
          </TouchableOpacity>
        </>
      )}
    </ScrollView>
  );
}

/**
 * The gateway address a one-time-code pairing dials ON NATIVE.
 *
 * The Host dialog shows `host:port` (its `lan.urls` host list), which is not a URL: the scheme, the
 * `/ws/mobile` path and `wss` are ours to add. A phone refuses the code before it gets here anyway
 * (a code carries no certificate to pin, see `submitOtp`); the form stays for the flow's shape.
 *
 * Spec 031 §8: the browser has no use for this — its only address is the page's own origin
 * (`planOtpAddress`), and a typed fallback is exactly the override that used to be ignored.
 *
 * Returns null when the result is not a `wss://` URL with a host: a caller must not hand the
 * transport something it will refuse with `client/bad-url` after opening a screen.
 */
export function otpGatewayUrl(typed: string): string | null {
  const raw = typed.trim();
  if (raw === '') return null;
  let candidate: URL;
  try {
    candidate = new URL(/^[a-z][a-z0-9+.-]*:\/\//i.test(raw) ? raw : `wss://${raw}`);
  } catch {
    return null;
  }
  if (candidate.protocol !== 'wss:' || candidate.hostname === '') return null;
  if (candidate.username !== '' || candidate.password !== '') return null;
  // A typed host:port has no path; give it the gateway's.
  if (candidate.pathname === '/' || candidate.pathname === '') candidate.pathname = GATEWAY_WS_PATH;
  return candidate.toString();
}

function errorKey(kind: ReturnType<typeof pairErrorFromCode>): MessageKey {
  switch (kind) {
    case 'remoteDisabled':
      return 'pair.error.remoteDisabled';
    case 'expired':
      return 'pair.error.expired';
    // Contract §3.8 outcomes.
    case 'rejected':
      return 'pair.error.rejected';
    case 'timeout':
      return 'pair.error.timeout';
    case 'otpUnsupported':
      return 'pair.error.otpUnsupported';
    case 'otpRequired':
      return 'pair.error.otpRequired';
    case 'otpBadLength':
      return 'pair.error.otpBadLength';
    case 'badAddress':
      return 'pair.error.badAddress';
    case 'pinMismatch':
      return 'pair.error.pinMismatch';
    // Refused locally, before any connection: the code flow on a phone, and an untrustworthy
    // statement of the Host's own identity.
    case 'otpNative':
      return 'pair.error.otpNative';
    case 'noHostId':
      return 'pair.error.noHostId';
    case 'hostConflict':
      return 'pair.error.hostConflict';
    case 'notReady':
      return 'pair.error.notReady';
    case 'unavailable':
      return 'pair.error.unavailable';
    case 'appUpdate':
      return 'pair.error.appUpdate';
    case 'hostUpdate':
      return 'pair.error.hostUpdate';
    default:
      return 'pair.error.generic';
  }
}

// Every colour comes from the theme palette (spec 011 U1: no hex literal outside src/ui/theme.ts).
function makeStyles(palette: Palette) {
  return StyleSheet.create({
    container: { padding: 20, gap: 14 },
    heading: { fontSize: 24, fontWeight: '700', color: palette.text },
    cameraFrame: { height: 280, borderRadius: 18, overflow: 'hidden', backgroundColor: palette.atmosphere },
    scanHint: { position: 'absolute', left: 0, right: 0, bottom: 0, padding: 10, backgroundColor: palette.overlay },
    scanHintText: { color: palette.onAtmosphere, textAlign: 'center', fontSize: 13 },
    codeCard: { paddingVertical: 24, borderRadius: 18, backgroundColor: palette.surface, alignItems: 'center', gap: 8, borderWidth: StyleSheet.hairlineWidth, borderColor: palette.border },
    code: { fontSize: 40, lineHeight: 46, fontWeight: '700', letterSpacing: 6, color: palette.text, textAlign: 'center' },
    codeHint: { fontSize: 13, color: palette.textMuted, textAlign: 'center', paddingHorizontal: 16 },
    notice: { padding: 14, borderRadius: 14, backgroundColor: palette.surface, gap: 8 },
    noticeText: { fontSize: 15, color: palette.text },
    error: { padding: 14, borderRadius: 14, backgroundColor: palette.surface, gap: 4, borderWidth: StyleSheet.hairlineWidth, borderColor: palette.danger },
    errorTitle: { fontWeight: '700', color: palette.danger },
    errorText: { fontSize: 14, color: palette.text },
    // Spec 032: the demo-only diagnosis (code · stage=…). Monospace and muted so it reads as a
    // machine fact beside the human copy, never as the explanation itself.
    failureDetail: { fontSize: 12, color: palette.textMuted, fontFamily: Platform.select({ ios: 'Menlo', android: 'monospace', default: 'monospace' }) },
    section: { fontSize: 13, color: palette.textMuted, marginTop: 6 },
    addressHint: { fontSize: 12, color: palette.textMuted },
    modeRow: { flexDirection: 'row', gap: 8 },
    modeTab: { flex: 1, paddingVertical: 10, borderRadius: 999, alignItems: 'center', minHeight: 44, backgroundColor: palette.surface, borderWidth: StyleSheet.hairlineWidth, borderColor: palette.border },
    modeTabActive: { backgroundColor: palette.accent, borderColor: palette.accent },
    modeText: { fontSize: 14, fontWeight: '600', color: palette.text },
    modeTextActive: { color: palette.onAccent },
    otpInput: { borderWidth: StyleSheet.hairlineWidth, borderColor: palette.border, borderRadius: 14, padding: 12, fontSize: 26, letterSpacing: 6, fontVariant: ['tabular-nums'], color: palette.text, backgroundColor: palette.surface, textAlign: 'center' },
    input: { borderWidth: StyleSheet.hairlineWidth, borderColor: palette.border, borderRadius: 14, padding: 12, fontSize: 15, minHeight: 64, color: palette.text, backgroundColor: palette.surface },
    primary: { backgroundColor: palette.accent, paddingVertical: 14, borderRadius: 999, alignItems: 'center', minHeight: 52 },
    primaryText: { color: palette.onAccent, fontWeight: '600', fontSize: 17 },
    disabled: { opacity: 0.5 },
    secondary: { alignSelf: 'flex-start', paddingVertical: 10, paddingHorizontal: 14, borderRadius: 12, backgroundColor: palette.surface, minHeight: 44 },
    secondaryText: { fontWeight: '600', color: palette.text },
  });
}
