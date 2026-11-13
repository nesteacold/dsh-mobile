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
import { GATEWAY_WS_PATH, sameOriginGatewayUrl } from '../core/gateway-address';
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
  const [otpAddress, setOtpAddress] = useState('');
  const [busy, setBusy] = useState(false);
  const [scanLocked, setScanLocked] = useState(false);
  const [failure, setFailure] = useState<MessageKey | null>(null);
  const [connectingTo, setConnectingTo] = useState<string | null>(null);
  // The same-origin gateway address this page will use (spec 020), or null on native / a page that
  // is not served from a tailnet HTTPS origin. Computed once: the origin cannot change under a
  // mounted screen (`tailscale serve` never rewrites the page), and reading it per render would
  // make the hint depend on a global this component does not own.
  const webGatewayUrl = useMemo(() => (Platform.OS === 'web' ? sameOriginGatewayUrl(readWebLocation()) : null), []);

  // The pairing-code link (`/pair#a=…&c=…`, the desktop dialog's QR). Read once on mount; the web
  // adapter strips the fragment from the address bar before anything else sees it. The form is only
  // PRE-FILLED: nothing is dialled until the user taps Pair, and the Host still approves.
  const [prefilled, setPrefilled] = useState(false);
  const applyPairLink = useCallback((link: PairLink) => {
    setMode('otp');
    setOtpAddress(link.address);
    setOtpCode(link.otp);
    setFailure(null);
    setPrefilled(true);
  }, []);
  useEffect(() => {
    const link = consumePairHash();
    if (link !== null) applyPairLink(link);
  }, [applyPairLink]);

  const submit = useCallback(
    async (raw: string) => {
      if (busy || raw.trim() === '') return;
      // A scanned/pasted pairing-code link is not a pairing string. The web pre-fills the code form;
      // a phone app keeps its rule (no OTP on native: a code carries no pin) and says so plainly.
      const link = parsePairLinkUrl(raw);
      if (link !== null) {
        setScanLocked(false);
        if (Platform.OS === 'web') applyPairLink(link);
        else setFailure('pair.error.otpLinkNative');
        return;
      }
      setBusy(true);
      setFailure(null);
      const parsed = controller.parsePairPayload(raw);
      if (!parsed.ok) {
        setFailure(errorKey(pairErrorFromQr(parsed.code as never)));
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
      setScanLocked(false);
    },
    [busy, controller, onPaired, applyPairLink],
  );

  /**
   * Submit the one-time-code form (contract revision 5). The code is validated locally FIRST, so a
   * typo never opens a socket or spends one of the Host's three proof attempts; the address is
   * normalized to a `wss://…/ws/mobile` URL the transport will accept.
   */
  const submitOtp = useCallback(async () => {
    if (busy) return;
    setFailure(null);
    const normalized = normalizeOtp(otpCode);
    if (!normalized.ok) {
      setFailure(normalized.reason === 'otp/empty' ? 'pair.error.otpRequired' : 'pair.error.otpBadLength');
      return;
    }
    // A phone cannot complete this flow at all: an 8-digit code carries no certificate, and the
    // native transport refuses an unpinned socket outright (see `createPinnedTransport` —
    // `PinnedTrustManager` has no code path that returns success without a pin). Attempting it
    // would spend one of the Host's three proof attempts before the transport refused. Refuse here
    // and point at the flow that does work on a device; the browser keeps the code flow because it
    // cannot pin by construction either (spec 020) and relies on the CA store instead.
    if (Platform.OS !== 'web') {
      setFailure('pair.error.otpNative');
      return;
    }
    const url = otpGatewayUrl(otpAddress, webGatewayUrl);
    if (url === null) {
      setFailure('pair.error.badAddress');
      return;
    }
    setBusy(true);
    setConnectingTo(otpAddress.trim());
    // The pin is deliberately NOT supplied here: the OTP offer carries the fingerprint and the
    // challenge states the leaf the proof is keyed to, which is the contract's trust-on-first-use
    // for a code that cannot carry one. The controller stores what it adopted.
    const result = await controller.pair('', { otp: { otp: normalized.otp, url, gatewayName: otpAddress.trim() } });
    setBusy(false);
    // The code was spent either way; keep the field empty so a retry cannot resubmit it by accident.
    setOtpCode('');
    if (result.ok) {
      onPaired?.();
      return;
    }
    setConnectingTo(null);
    setFailure(errorKey(pairErrorFromCode(result.code)));
  }, [busy, controller, onPaired, otpAddress, otpCode, webGatewayUrl]);

  // A pairing failure the controller recorded outside `pair()` (close 4004, version gate).
  useEffect(() => {
    if (snapshot.pairing === null) return;
    setFailure(errorKey(pairErrorFromCode(snapshot.pairing.code)));
  }, [snapshot.pairing]);

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
          onPress={() => { setMode('code'); setFailure(null); }}
        >
          <Text style={[styles.modeText, mode === 'code' && styles.modeTextActive]}>{tr('pair.modeCode')}</Text>
        </TouchableOpacity>
        <TouchableOpacity
          style={[styles.modeTab, mode === 'otp' && styles.modeTabActive]}
          testID="pair-mode-otp"
          accessibilityRole="tab"
          accessibilityState={{ selected: mode === 'otp' }}
          onPress={() => { setMode('otp'); setFailure(null); }}
        >
          <Text style={[styles.modeText, mode === 'otp' && styles.modeTextActive]}>{tr('pair.modeOtp')}</Text>
        </TouchableOpacity>
      </View>

      {mode === 'otp' ? (
        <>
          {prefilled ? (
            <Text style={styles.addressHint}>{tr('pair.linkPrefilled')}</Text>
          ) : null}
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
          {webGatewayUrl !== null ? (
            <Text style={styles.addressHint}>{tr('pair.webAddress', { url: webGatewayUrl })}</Text>
          ) : null}
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

          <Text style={styles.section}>{tr('pair.manual')}</Text>
          {/* Spec 020: on the web the app reaches the gateway through the origin it was served from
              (`tailscale serve` routes `/ws/mobile` there), not the self-signed address inside the QR —
              a browser refuses that one before any frame moves. Say which address will be used, so the
              owner is never surprised by what the app dials. Native reads `null` here, so this line
              never appears on a phone. */}
          {webGatewayUrl !== null ? (
            <Text style={styles.addressHint}>{tr('pair.webAddress', { url: webGatewayUrl })}</Text>
          ) : null}
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
 * The gateway address a one-time-code pairing dials.
 *
 * The Host dialog shows `host:port` (its `lan.urls` host list), which is not a URL: the scheme, the
 * `/ws/mobile` path and `wss` are ours to add. On the WEB build the page's own origin wins outright
 * (spec 020 — `tailscale serve` already routes `/ws/mobile` there, and a browser cannot trust the
 * Host's self-signed listener), so an empty or partial typed address still reaches the gateway.
 *
 * Returns null when the result is not a `wss://` URL with a host: a caller must not hand the
 * transport something it will refuse with `client/bad-url` after opening a screen.
 */
export function otpGatewayUrl(typed: string, sameOrigin: string | null): string | null {
  const raw = typed.trim();
  if (sameOrigin !== null && raw === '') return sameOrigin;
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
  // On the web the page's origin is the one address the browser can actually reach.
  return sameOrigin !== null ? sameOrigin : candidate.toString();
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
