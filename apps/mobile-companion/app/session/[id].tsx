// A023 / A024 — session screen (US3, US4, US6): history, approval cards (≤ 3 taps), floating
// composer with a stable clientMsgId, stop-with-confirm, and the reconnect/offline banners.
//
// Shell, header and composer ported from Clarklevis1995/dsh-mobile
//   androidApp/src/main/kotlin/com/clarklevis/dsh/android/ui/ConversationScreen.kt,
//   SessionStatusUi.kt and HumanQuestionCard.kt (MIT).
//
// Approval rules (contract §5, FR-006) — UNCHANGED by the restyle:
//   * buttons only when `argsHash` is present  -> "decide on your computer" otherwise;
//   * a decision echoes the exact hash shown;
//   * `reason: hash-mismatch` reopens the card for review, `reason: not-pending` says
//     "already decided";
//   * an `approval-resolved` push closes the card.
// Taps to decide from fully visible content: 1 tap = single-approver decision (scroll position
// is preserved and the card is above the composer, never next to Send).
//
// Why the native stack header is hidden: Clarklevis draws the conversation header itself (back,
// one-line title, live status pill, "more"), and two stacked headers would waste the phone's
// shortest dimension. `headerShown: false` is set here, for this screen only.

import { useCallback, useEffect, useMemo, useRef, useState, type ComponentRef } from 'react';
import {
  ActivityIndicator,
  Alert,
  KeyboardAvoidingView,
  Linking,
  Modal,
  Platform,
  Pressable,
  ScrollView,
  Share,
  StyleSheet,
  Text,
  TextInput,
  TouchableOpacity,
  View,
} from 'react-native';
import { useLocalSearchParams, useNavigation, useRouter } from 'expo-router';
import { useSafeAreaInsets } from 'react-native-safe-area-context';

import type { ApprovalCardView } from '../../src/app-state';
import { isSubagentSession } from '../../src/core/sessions';
import { sessionDisplayTitle } from '../../src/ui/session-title';
import { promptSendLabel, promptSendState } from '../../src/ui/prompt-state';
import { redactArgsPreview } from '../../src/core';
import type { ClientState, HistoryMessage } from '../../src/core';
import { elevation, monoFont, useTheme } from '../../src/ui/theme';
import { MicHintButton, MicHintLine } from '../../src/ui/conversation/MicHintButton';
import { AgentTeamPanel } from '../../src/ui/conversation/AgentTeamPanel';
import { SessionStatsPanel } from '../../src/ui/components/stats-panel';
import { statsErrorCopy, toSessionPanelView, toStatsView, type StatsView } from '../../src/ui/read-only-views';
// Spec 018 item 5 — the Host's goal line and task checklist, read-only.
import { SessionPanelStrip } from '../../src/ui/conversation/SessionPanel';
import {
  teamErrorCopy,
  toCatalogView,
  toTeamView,
  type CatalogView,
  type TeamView,
} from '../../src/ui/conversation/team-view';
import { ProcessReasoning } from '../../src/ui/conversation/ProcessReasoning';
import { ScrollToBottomButton } from '../../src/ui/conversation/ScrollToBottomButton';
import { isAwayFromBottom } from '../../src/ui/conversation/scroll-threshold';
import { buildQuotePrompt, quotePreview } from '../../src/ui/conversation/reply-quote';
import { SessionStatusPill } from '../../src/ui/conversation/SessionStatusPill';
import { ToolGroup } from '../../src/ui/conversation/ToolGroup';
import { groupTranscript } from '../../src/ui/conversation/tool-groups';
import { ToolRow } from '../../src/ui/conversation/ToolRow';
import { Markdown } from '../../src/ui/markdown/Markdown';
// Spec 011 — the composer's leading model/mode row (ported from Clarklevis's ComposerMorphLayout).
import { ComposerModelRow, ModelPicker, modelUnavailableReasonKey } from '../../src/ui/components/authoring';
// Spec 019 — permission chip + lower-only sheet (see specs/019-parity-wave3-high-risk-design).
import { canLowerPermission, chipView, optionRows } from '../../src/ui/permission-lower';
import { PermissionChip, PermissionSheetBody } from '../../src/ui/components/permission-lower';
import type { PermissionLowerOutcome, PermissionOptionsResult } from '../../src/core/permission-lower';
import type { MessageKey } from '../../i18n';
import { type Interpolate } from '../../i18n';
import { useApp } from '../_layout';

/** Composer growth: five body lines then it scrolls internally (Clarklevis caps at ~5). */
const COMPOSER_MAX_LINES = 5;

/** Height of the floating header, so the transcript can start below it and scroll behind it. */
const HEADER_BASE_HEIGHT = 52;

/**
 * Reference 04's header is translucent paper, not opaque: let the transcript blur through it. The
 * theme token may be a hex colour or already carry alpha, so anything else is passed through.
 */
function translucent(color: string): string {
  const hex = color.trim();
  if (/^#[0-9a-f]{6}$/i.test(hex)) return `${hex}d9`;
  return color;
}

export default function SessionScreen() {
  const { controller, snapshot, tr, locale } = useApp();
  const params = useLocalSearchParams<{ id?: string; a?: string }>();
  const sessionId = typeof params.id === 'string' ? params.id : '';
  const focusApprovalId = typeof params.a === 'string' ? params.a : null;
  const navigation = useNavigation();
  const router = useRouter();
  const insets = useSafeAreaInsets();
  const theme = useTheme();
  const { colors, type, space, radius, hit } = theme;
  const headerHeight = insets.top + HEADER_BASE_HEIGHT;

  const [text, setText] = useState('');
  const [sending, setSending] = useState(false);
  const [focusedApproval, setFocusedApproval] = useState<string | null>(focusApprovalId);
  const [menuOpen, setMenuOpen] = useState(false);
  /** Spec 017 Đợt 2 item 2: the agent team of this session, read-only. */
  const [teamOpen, setTeamOpen] = useState(false);
  const [teamView, setTeamView] = useState<TeamView>({ state: 'unavailable', members: [], tasks: [] });
  const [catalogView, setCatalogView] = useState<CatalogView | null>(null);
  const [modelPickerOpen, setModelPickerOpen] = useState(false);
  /** Wave 1: the reader scrolled away from the newest message (shows the jump-down control). */
  const [awayFromBottom, setAwayFromBottom] = useState(false);
  /** Wave 1: the message this reply quotes; `null` when composing a plain prompt. */
  const [replyTo, setReplyTo] = useState<HistoryMessage | null>(null);
  const scrollRef = useRef<ComponentRef<typeof ScrollView>>(null);
  /** Đợt 3: the composer's field, so the mic control can focus it for the keyboard's own dictation. */
  const composerRef = useRef<ComponentRef<typeof TextInput>>(null);
  const [micHint, setMicHint] = useState(false);

  const sessionSummary = snapshot.sessions.find((session) => session.id === sessionId) ?? null;
  /** MEASURED: `models` for a subagent session fails with `session/agent-busy`, so never send it. */
  const subagentSession = sessionSummary !== null && isSubagentSession(sessionSummary);

  // Spec 011: fetch the model catalog for this session once a ready socket exists. The per-session
  // reply also carries the current selection, which is what the composer's row shows. Skipped for a
  // subagent session: that request can only fail today (its `models` needs a root address).
  useEffect(() => {
    if (subagentSession) return;
    if (snapshot.connection !== 'ready' || sessionId === '') return;
    if (snapshot.models.length > 0) return;
    void controller.listModels(sessionId);
  }, [controller, sessionId, snapshot.connection, snapshot.models.length, subagentSession]);

  useEffect(() => {
    if (sessionId !== '') controller.openSession(sessionId);
    return () => controller.closeSession();
  }, [controller, sessionId]);

  // One header, drawn below: the native one is hidden for this route only.
  useEffect(() => {
    navigation.setOptions({ headerShown: false });
  }, [navigation]);

  const session = snapshot.sessions.find((entry) => entry.id === sessionId);

  // A deep link / notification carries `a=<approvalId>`: highlight that card and bring the
  // list to the newest content once it has rendered.
  useEffect(() => {
    if (focusApprovalId === null) return;
    setFocusedApproval(focusApprovalId);
  }, [focusApprovalId, snapshot.openApprovals.length]);

  const banner = snapshot.banner !== 'none' ? bannerCopy(tr, snapshot.banner) : null;

  /**
   * Spec 018 item 5 — the task list / goal strip pinned under the header, above the transcript. The
   * data is projected by the gateway (`projection-baseline` + `tasks-updated` / `goal-updated`), read
   * by the controller for this session only, and drawn only when there is something to show: an
   * absent projection hides both rows, an empty list hides the checklist (PROTOCOL.md:959, 985).
   */
  const panelView = toSessionPanelView(snapshot.openSessionPanel);
  const panelVisible = panelView.goal !== null || panelView.tasksTotal > 0;
  /** Screen-owned so it survives the transcript re-rendering under it. */
  const [tasksOpen, setTasksOpen] = useState(false);

  // Consecutive tool/system rows collapse into one expandable line (parity A/D): once agent prose is
  // classified correctly, the transcript is prose with runs of tool activity between turns.
  const transcript = useMemo(() => groupTranscript(snapshot.history), [snapshot.history]);

  const send = useCallback(async () => {
    const value = text.trim();
    if (value === '' || sending) return;
    setSending(true);
    // Wave 1 (ComposerReplyPreview.kt): a reply carries the quoted excerpt to the Host as a markdown
    // blockquote, so the model sees what is being answered. The quote is cleared with the draft.
    const payload = replyTo === null ? value : buildQuotePrompt(replyTo.text, value);
    setText('');
    setReplyTo(null);
    await controller.sendPrompt(payload);
    setSending(false);
  }, [controller, replyTo, sending, text]);

  const confirmCancel = useCallback(() => {
    Alert.alert(
      tr('session.cancelConfirmTitle'),
      tr('session.cancelConfirmBody'),
      [
        { text: tr('common.cancel'), style: 'cancel' },
        {
          text: tr('session.cancelConfirm'),
          style: 'destructive',
          onPress: () => {
            void controller.cancelSession();
          },
        },
      ],
      { cancelable: true },
    );
  }, [controller, tr]);

  // Assistant output is markdown from a remote Host. A link never opens by itself: the target is
  // shown and the user confirms first, which is the one place the transcript can leave the app.
  const openLink = useCallback(
    (href: string, _label: string) => {
      Alert.alert(
        tr('session.linkOpenTitle'),
        tr('session.linkOpenBody', { url: href }),
        [
          { text: tr('common.cancel'), style: 'cancel' },
          {
            text: tr('session.linkOpen'),
            onPress: () => {
              void Linking.openURL(href).catch(() => {
                /* the OS refused to open it; nothing to retry from here */
              });
            },
          },
        ],
        { cancelable: true },
      );
    },
    [tr],
  );

  // Sending is unavailable unless the socket is ready; say WHY instead of a dead button.
  const ready = snapshot.connection === 'ready';
  // Typing is NEVER blocked, and sending is blocked only when delivery cannot happen without the
  // user doing something (revoked device, update required, gateway off, re-auth). Everything else —
  // connecting, reconnecting, a socket that just closed — queues the prompt in the outbox, which
  // keeps it under a stable `clientMsgId` and drains it once the socket is back. Measured defect:
  // the field was `editable` only when `connection === 'ready'`, so while the link was down (and in
  // a session mid-turn on a flaky link) the field took no focus and no keyboard — nothing could be
  // typed or dictated — in direct contradiction of its own copy, "Connecting… you can type meanwhile".
  const deliveryImpossible = isDeliveryImpossible(snapshot.connection);
  const sendReason = ready ? null : sendUnavailableCopy(tr, snapshot.connection);
  const canSend = !deliveryImpossible && text.trim() !== '' && !sending;
  /**
   * Read the team on demand each time the screen opens (op `agent-team` + `subagents`).
   *
   * Goes through the controller's public `readTeam` / `readSubagents`: no connection resolves
   * `{ state: 'unavailable' }` (the screen says "unavailable" instead of drawing an empty team), and a
   * genuine protocol/host error REJECTS with a `CoreError` carrying the Host code. Neither read is
   * swallowed — a rejection from either one becomes the failed state, mapped from its CODE; the Host's
   * raw message is never shown.
   */
  /** The sheet's last read; `null` until the screen's own read answers. */
  const [permissionView, setPermissionView] = useState<PermissionOptionsResult | null>(null);
  /** Reading failed (the accessor rejected): one honest retry line, never a silent empty list. */
  const [permissionReadFailed, setPermissionReadFailed] = useState(false);
  const [permissionBusy, setPermissionBusy] = useState(false);
  /** The last receipt's fixed sentence (never the Host's message), and the preset it names. */
  const [permissionReceipt, setPermissionReceipt] = useState<{ key: MessageKey; preset: string | null } | null>(null);
  const [permissionSheetOpen, setPermissionSheetOpen] = useState(false);

  /**
   * Spec 019 — the preset the header chip shows, from the `permission-options` read this screen
   * issues (see `loadPermissionOptions`). The session row does NOT carry it: `sessions` returns titles
   * only, and the gateway's per-row filter drops `permissions` from both the list and its
   * `projection-baseline`, so a chip fed from the row could never know it. Null hides the chip
   * instead of guessing.
   */
  const permissionChip = chipView({
    connection: snapshot.connection,
    capabilities: snapshot.capabilities,
    preset: permissionView !== null && permissionView.state === 'ready' ? permissionView.value.currentValue : null,
    label: (preset: string) => tr('session.permissionChip', { preset }),
  });

  /**
   * Spec 018 — the agent preset label in the header subline (`projections.values.agentPreset`, parsed
   * by the sessions store). Read-only: there is no control behind it. `null` hides the label.
   */
  const agentPresetLabel =
    sessionSummary?.agentPreset === undefined
      ? null
      : tr('session.agentPreset', { preset: sessionSummary.agentPreset });

  /**
   * Read the presets: `permission-options` through the controller's accessor. Run once when the
   * screen opens (the header chip renders from it) and again each time the sheet opens or a switch
   * lands. No socket or no `permission-lower` capability answers `unavailable`, which hides the chip;
   * any other refusal REJECTS, so the chip stays hidden and becomes the sheet's retry line — never a
   * silent empty list.
   */
  const loadPermissionOptions = useCallback(async () => {
    setPermissionReadFailed(false);
    try {
      setPermissionView(await controller.readPermissionOptions(sessionId));
    } catch {
      setPermissionReadFailed(true);
    }
  }, [controller, sessionId]);

  useEffect(() => {
    if (!permissionSheetOpen) return;
    void loadPermissionOptions();
  }, [permissionSheetOpen, loadPermissionOptions]);

  // Once per screen, as soon as the connection and the Host's capabilities are known: without this
  // read the chip would stay hidden for the whole visit. The accessor itself refuses a Host that
  // does not advertise `permission-lower`, so this asks nothing of one.
  useEffect(() => {
    if (!canLowerPermission(snapshot.capabilities)) return;
    void loadPermissionOptions();
  }, [canLowerPermission(snapshot.capabilities), loadPermissionOptions]);

  /**
   * Confirm, then switch. The confirmation names the preset (data) and says the agent will be
   * restricted; the write goes through the controller, which sends `permission-lower {sessionId,
   * preset}` and applies the receipt to the session row. A refusal is an answer whose `reason`
   * chooses one fixed sentence; a thrown `CoreError` is the same statement, by its code.
   *
   * The rows lock from the TAP, not from the confirm: the Alert is dismissed by a backdrop tap,
   * Android back, or a second tap, and any of those would leave a promised switch unlocked. A
   * cancel releases the lock; only the confirm carries it into the write (which clears it in its
   * `finally`). Android reports backdrop and back dismissal only through `onDismiss`, so that
   * releases the lock too — otherwise the rows would stay locked for the whole visit.
   */
  const confirmPermissionLower = useCallback(
    (preset: string) => {
      setPermissionBusy(true);
      Alert.alert(
        tr('session.permissionConfirmTitle', { preset }),
        tr('session.permissionConfirmBody'),
        [
          { text: tr('common.cancel'), style: 'cancel', onPress: () => setPermissionBusy(false) },
          {
            text: tr('session.permissionConfirm'),
            onPress: () => {
              // Already locked at the tap; the write only keeps holding it.
              void (async () => {
                try {
                  const outcome: PermissionLowerOutcome = await controller.lowerPermission(sessionId, preset);
                  setPermissionReceipt(
                    outcome.accepted
                      ? { key: 'session.permissionConfirm', preset: outcome.currentValue ?? outcome.preset }
                      : { key: outcome.message, preset: null },
                  );
                } catch (error) {
                  setPermissionReceipt({ key: permissionErrorKey((error as { code?: string } | null)?.code), preset: null });
                } finally {
                  setPermissionBusy(false);
                  void loadPermissionOptions();
                }
              })();
            },
          },
        ],
        {
          cancelable: true,
          // Backdrop tap / Android back never reach a button: release the lock like a cancel.
          onDismiss: () => setPermissionBusy(false),
        },
      );
    },
    [controller, loadPermissionOptions, sessionId, tr],
  );

  const loadTeam = useCallback(async () => {
    try {
      const [teamRead, catalogRead] = await Promise.all([
        controller.readTeam(sessionId),
        controller.readSubagents(sessionId),
      ]);
      setTeamView(toTeamView(teamRead));
      setCatalogView(toCatalogView(catalogRead));
    } catch (error) {
      const code = (error as { code?: string } | null)?.code;
      const key = teamErrorCopy(code);
      const copy = tr(key);
      setTeamView({ state: 'failed', members: [], tasks: [], errorText: copy });
      setCatalogView(null);
    }
  }, [controller, sessionId, tr]);

  useEffect(() => {
    if (!teamOpen) return;
    void loadTeam();
  }, [teamOpen, loadTeam]);

  /**
   * Spec 018 — the session-stats sheet (op `session-stats`, scope `stats:read`). Opened from the "⋯"
   * menu only when this device holds the scope: the scope is never a default and no `hello` capability
   * advertises it, so a read the gateway would refuse is never offered. `unavailable` from the accessor
   * renders its own sentence; a thrown `CoreError` becomes a fixed one from its CODE (never the Host's
   * raw message).
   */
  const [statsOpen, setStatsOpen] = useState(false);
  const [statsView, setStatsView] = useState<StatsView>({ state: 'loading', sections: [] });
  const canReadStats = controller.hasReadScope('stats:read');

  const loadStats = useCallback(async () => {
    setStatsView({ state: 'loading', sections: [] });
    try {
      const read = await controller.readSessionStats(sessionId);
      if (read.state === 'unavailable') {
        setStatsView({ state: 'unavailable', sections: [] });
        return;
      }
      setStatsView(toStatsView(read, tr));
    } catch (error) {
      const code = (error as { code?: string } | null)?.code;
      setStatsView({ state: 'failed', sections: [], errorText: tr(statsErrorCopy(code)) });
    }
  }, [controller, sessionId, tr]);

  useEffect(() => {
    if (!statsOpen) return;
    void loadStats();
  }, [statsOpen, loadStats]);

  return (
    <KeyboardAvoidingView
      style={[styles.container, { backgroundColor: colors.bg }]}
      behavior={Platform.OS === 'ios' ? 'padding' : undefined}
    >
      <View
        style={[
          styles.header,
          {
            paddingTop: insets.top + space.xs,
            paddingHorizontal: space.md,
            paddingBottom: space.sm,
            borderBottomColor: colors.border,
            // Reference 04: the header floats OVER the transcript, so the content scrolls behind a
            // translucent bar instead of stopping under an opaque one.
            backgroundColor: translucent(colors.bg),
            position: 'absolute',
            top: 0,
            left: 0,
            right: 0,
            zIndex: 20,
          },
        ]}
      >
        {/* Image 04/05: a ROUND translucent back control, one-line title, the metadata on a second
            line, and a round "⋯". The status pill used to sit inline between title and "⋯", which
            truncated the title on device — it belongs on the subline, next to the computer name. */}
        <TouchableOpacity
          style={[
            styles.roundButton,
            {
              backgroundColor: colors.surface,
              minWidth: hit,
              minHeight: hit,
              width: hit,
              height: hit,
              borderRadius: radius.circle,
            },
          ]}
          accessibilityRole="button"
          accessibilityLabel={tr('common.back')}
          hitSlop={8}
          onPress={() => {
            if (router.canGoBack()) router.back();
            else router.replace('/');
          }}
          testID="session-back"
        >
          <Text style={[type.heading, { color: colors.text }]}>‹</Text>
        </TouchableOpacity>

        <View style={[styles.headerTitles, { marginHorizontal: space.sm }]}>
          <Text
            style={[type.subheading, { color: colors.text }]}
            numberOfLines={1}
            accessibilityRole="header"
            testID="session-title"
          >
            {session === undefined ? tr('common.host') : sessionDisplayTitle(session, tr, locale)}
          </Text>
          <View style={[styles.subline, { gap: space.xs }]}>
            {/* A drawn MONITOR (screen + stand), not the "▢" glyph and not a plain square: this
                device's system font has no U+25A2 (it rendered as tofu) and the APK carries no icon
                font, and a bare square read as a checkbox. Reference 04 shows a small computer. */}
            <View style={{ alignItems: 'center', justifyContent: 'center' }}>
              <View
                style={{
                  width: 12,
                  height: 9,
                  borderRadius: 2,
                  borderWidth: 1,
                  borderColor: colors.textMuted,
                }}
              />
              <View style={{ width: 5, height: 1, backgroundColor: colors.textMuted, marginTop: 1 }} />
              <View style={{ width: 8, height: 1, backgroundColor: colors.textMuted }} />
            </View>
            <Text style={[type.captionSmall, { color: colors.textMuted, flexShrink: 1 }]} numberOfLines={1}>
              {snapshot.activeHost?.name ?? tr('common.host')}
            </Text>
            {session === undefined ? null : (
              <>
                <Text style={[type.captionSmall, { color: colors.textFaint }]}>·</Text>
                <SessionStatusPill state={session.state} label={statusWord(tr, session.state)} plain />
              </>
            )}
            {/* Spec 018: the agent preset this session runs — text only, never a control. The
                phone cannot choose or change a preset. Absent (older gateway or unknown preset)
                hides the label instead of showing an empty one. */}
            {agentPresetLabel === null ? null : (
              <>
                <Text style={[type.captionSmall, { color: colors.textFaint }]}>·</Text>
                <Text
                  style={[type.captionSmall, { color: colors.textMuted, flexShrink: 1 }]}
                  numberOfLines={1}
                  testID="session-agent-preset"
                >
                  {agentPresetLabel}
                </Text>
              </>
            )}
            {/* Spec 019: the preset the Host projects for this session. Hidden — not drawn
                disabled — without the `permission-lower` capability or without a projection. */}
            {permissionChip === null ? null : (
              <>
                <Text style={[type.captionSmall, { color: colors.textFaint }]}>·</Text>
                <PermissionChip preset={permissionChip.preset} hint={permissionChip.label} onPress={() => setPermissionSheetOpen(true)} />
              </>
            )}
          </View>
        </View>

        <TouchableOpacity
          style={[
            styles.roundButton,
            {
              backgroundColor: colors.surface,
              minWidth: hit,
              minHeight: hit,
              width: hit,
              height: hit,
              borderRadius: radius.circle,
            },
          ]}
          accessibilityRole="button"
          accessibilityLabel={tr('session.more')}
          hitSlop={8}
          onPress={() => setMenuOpen(true)}
          testID="session-more"
        >
          <Text style={[type.heading, { color: colors.text }]}>⋯</Text>
        </TouchableOpacity>
      </View>

      {/* Spec 018 item 5: the session's goal and checklist, pinned directly under the header and
          OUTSIDE the transcript's scroller. Inside it, the strip sat above "load older" and a long
          session scrolled it off-screen for good. Collapsed (the default) it is one goal line plus
          the "▸ N/M" disclosure; it hides entirely when the Host projected no goal and no tasks.
          `paddingTop` keeps it clear of the header, which floats over the content.
          Read-only — the phone has no goal or task write, so there is nothing to tap but the rows. */}
      {panelVisible ? (
        <View style={{ paddingTop: headerHeight + space.xs, paddingHorizontal: space.lg }} testID="session-panel-pin">
          <SessionPanelStrip
            view={panelView}
            tr={tr}
            tasksOpen={tasksOpen}
            onToggleTasks={() => setTasksOpen((open) => !open)}
          />
        </View>
      ) : null}

      {/* The transcript region is its own flex child so the jump control can anchor to the BOTTOM OF
          THE TRANSCRIPT instead of the bottom of the screen. Measured: anchoring to the screen put the
          button behind the composer capsule, so it never appeared. */}
      <View style={{ flex: 1 }}>
      <ScrollView
        ref={scrollRef}
        style={{ flex: 1 }}
        contentContainerStyle={[
          styles.list,
          {
            padding: space.lg,
            // The pinned panel above already clears the floating header, so when it is visible the
            // transcript needs only the normal gap under it — not another header-height band.
            paddingTop: panelVisible ? space.sm : headerHeight + space.sm,
            gap: space.md,
          },
        ]}
        keyboardShouldPersistTaps="handled"
        scrollEventThrottle={64}
        onScroll={(event) => {
          const { contentOffset, contentSize, layoutMeasurement } = event.nativeEvent;
          setAwayFromBottom(
            isAwayFromBottom({
              offsetY: contentOffset.y,
              contentHeight: contentSize.height,
              viewportHeight: layoutMeasurement.height,
            }),
          );
        }}
      >
        {/* The banner scrolls WITH the content now that the header floats over it (reference 04):
            an opaque bar pinned under a translucent header would be two stacked chrome rows. */}
        {banner !== null ? (
          <View
            style={[
              styles.banner,
              {
                backgroundColor: snapshot.banner === 'reconnecting' ? colors.surface : colors.surfaceRaised,
                borderLeftColor: snapshot.banner === 'reconnecting' ? colors.warning : colors.danger,
                paddingHorizontal: space.lg,
                paddingVertical: space.sm,
              },
            ]}
            testID="banner"
            accessibilityLabel={banner}
          >
            <Text style={[type.caption, { color: colors.text }]}>{banner}</Text>
          </View>
        ) : null}
        {/* Older history is offered ONLY when the Host reported more AND gave a cursor to page with
            (`historyHasEarlier`). Before this, a `hasMore` with no cursor produced a button that
            visibly did nothing: the request went out without a cursor and the Host re-served the same
            page. While loading it is busy and locked, and a failure is explained instead of swallowed. */}
        {snapshot.historyHasEarlier ? (
          <TouchableOpacity
            style={[
              styles.loadOlder,
              {
                borderRadius: radius.pill,
                paddingHorizontal: space.lg,
                minHeight: hit,
                backgroundColor: colors.surface,
                opacity: snapshot.historyLoading ? 0.6 : 1,
              },
            ]}
            accessibilityRole="button"
            accessibilityLabel={tr('session.historyOlder')}
            accessibilityState={{ busy: snapshot.historyLoading, disabled: snapshot.historyLoading }}
            disabled={snapshot.historyLoading}
            onPress={() => void controller.loadOlderHistory()}
          >
            {snapshot.historyLoading ? (
              <ActivityIndicator color={colors.accent} />
            ) : (
              <Text style={[type.caption, { color: colors.accent }]}>{tr('session.historyOlder')}</Text>
            )}
          </TouchableOpacity>
        ) : null}

        {snapshot.historyError === null ? null : (
          // The CODE goes beside the sentence on purpose. A generic "could not load" hid a refused
          // history request (`{ beforeSeq, historyFormatVersion }` without `sessionId`) through a
          // whole capture round: the line looked like the end of history. With the code visible the
          // failure names itself instead of needing another guess.
          <Text
            style={[type.captionSmall, { color: colors.textMuted, textAlign: 'center' }]}
            testID="session-history-error"
          >
            {`${tr('session.historyFailed')} (${snapshot.historyError})`}
          </Text>
        )}

        {snapshot.openApprovals.map((card) => (
          <ApprovalCardView
            key={card.approvalId}
            card={card}
            tr={tr}
            focused={focusedApproval === card.approvalId}
            busy={card.status === 'approving' || card.status === 'rejecting'}
            onApprove={() => void controller.decideApproval(card.approvalId, 'allowed-once')}
            onReject={() => void controller.decideApproval(card.approvalId, 'rejected')}
            onReload={() => controller.reloadApproval(card.approvalId)}
          />
        ))}

        {snapshot.history.length === 0 ? (
          <View style={[styles.centerArea, { padding: space.xxxl }]}>
            {snapshot.connection === 'ready' ? (
              <Text style={[type.bodySmall, { color: colors.textMuted }]}>{tr('session.empty')}</Text>
            ) : (
              <ActivityIndicator color={colors.textMuted} />
            )}
          </View>
        ) : null}

        {transcript.map((entry) =>
          entry.kind === 'tools' ? (
            <ToolGroup key={entry.key} rows={entry.rows} tr={tr} />
          ) : (
            <MessageRow key={entry.key} message={entry.message} tr={tr} onOpenLink={openLink} onReply={setReplyTo} />
          ),
        )}

        {snapshot.outgoing.map((item) => (
          <View
            key={item.clientMsgId}
            style={[
              styles.bubble,
              styles.bubbleUser,
              { backgroundColor: colors.accentSoft, borderRadius: radius.lg, padding: space.md, gap: space.xxs },
            ]}
          >
            <Text style={[type.body, { color: colors.text }]}>{item.text}</Text>
            <Text style={[type.captionSmall, { color: colors.textMuted }]}>
              {item.status === 'failed' ? `${tr('session.failed')} (${item.lastError ?? ''})` : tr('session.pending')}
            </Text>
            {item.status === 'failed' ? (
              <TouchableOpacity
                style={[styles.retry, { minHeight: hit, paddingHorizontal: space.md }]}
                accessibilityRole="button"
                accessibilityLabel={tr('session.retry')}
                onPress={() => void controller.retryPrompt(item.clientMsgId)}
              >
                <Text style={[type.caption, { color: colors.accent }]}>{tr('session.retry')}</Text>
              </TouchableOpacity>
            ) : null}
          </View>
        ))}
      </ScrollView>

      {/* Wave 1 (ScrollToBottomButton): appears only when the newest message is off-screen. It sits
          just above the composer capsule and above the transcript in z-order. */}
      {awayFromBottom ? (
        <View
          style={[styles.scrollBottom, { bottom: space.md, zIndex: 15 }]}
          pointerEvents="box-none"
          testID="session-scroll-bottom-row"
        >
          <ScrollToBottomButton
            label={tr('session.scrollBottom')}
            onPress={() => {
              scrollRef.current?.scrollToEnd({ animated: true });
              setAwayFromBottom(false);
            }}
          />
        </View>
      ) : null}
      </View>

      {/* Floating composer, Clarklevis style: one rounded capsule of glass above the safe area,
          the send action inside it, and the reason sending is unavailable spelled out. */}
      <View
        style={[
          styles.composerWrap,
          { paddingHorizontal: space.lg, paddingTop: space.sm, paddingBottom: insets.bottom + space.sm },
        ]}
      >
        <ModelPicker
          visible={modelPickerOpen}
          items={snapshot.models}
          currentId={snapshot.currentModel?.id ?? null}
          state={snapshot.models.length > 0 ? { status: 'ready' } : { status: 'idle' }}
          onSelect={(model) => {
            setModelPickerOpen(false);
            void controller.selectModel({ sessionId, modelId: model.id, ...(model.provider === undefined ? {} : { provider: model.provider }) });
          }}
          onClose={() => setModelPickerOpen(false)}
          onRetry={() => void controller.listModels(sessionId)}
          labels={{
            title: tr('session.chooseModel'),
            retry: tr('authoring.retry'),
            empty: tr('authoring.workspacesEmpty'),
            loading: tr('authoring.loadingWorkspaces'),
            error: tr('authoring.workspacesError'),
            close: tr('authoring.close'),
          }}
        />
        {sendReason !== null ? (
          <View
            style={[styles.reason, { paddingBottom: space.xs, paddingHorizontal: space.xs }]}
            accessible
            accessibilityLabel={sendReason}
            testID="session-send-reason"
          >
            <Text style={[type.captionSmall, { color: colors.textMuted }]}>{sendReason}</Text>
          </View>
        ) : null}
        {micHint ? (
          <View style={{ paddingHorizontal: space.xs, paddingBottom: space.xs }} testID="session-mic-hint-line">
            <MicHintLine text={tr('session.micHint')} />
          </View>
        ) : null}
        <View
          style={[
            styles.composer,
            {
              backgroundColor: colors.surfaceRaised,
              borderColor: colors.border,
              borderRadius: radius.xxl,
              paddingHorizontal: space.md,
              paddingVertical: space.sm,
              gap: space.sm,
              ...elevation(colors, 'bar'),
            },
          ]}
        >
          {/* Wave 1 (ComposerReplyPreview.kt): the quoted excerpt sits above the field with its own
              dismiss control; the sent prompt carries the same line as a blockquote. */}
          {replyTo === null ? null : (
            <View
              style={[
                styles.quote,
                {
                  backgroundColor: colors.surface,
                  borderLeftColor: colors.accent,
                  borderRadius: radius.sm,
                  paddingVertical: space.xs,
                  paddingLeft: space.sm,
                  paddingRight: space.xxs,
                  gap: space.xxs,
                },
              ]}
              testID="session-reply-quote"
            >
              <View style={{ flexDirection: 'row', alignItems: 'center', gap: space.xs }}>
                <Text style={[type.captionSmall, { color: colors.accent, flex: 1 }]} numberOfLines={1}>
                  {tr('session.reply')}
                </Text>
                <TouchableOpacity
                  accessibilityRole="button"
                  accessibilityLabel={tr('common.cancel')}
                  hitSlop={8}
                  onPress={() => setReplyTo(null)}
                  testID="session-reply-cancel"
                  style={{ minWidth: hit, minHeight: 24, alignItems: 'center', justifyContent: 'center' }}
                >
                  <Text style={[type.caption, { color: colors.textMuted }]}>✕</Text>
                </TouchableOpacity>
              </View>
              <Text style={[type.captionSmall, { color: colors.textMuted }]} numberOfLines={2}>
                {quotePreview(replyTo.text)}
              </Text>
            </View>
          )}
          <TextInput
            ref={composerRef}
            style={[
              type.body,
              styles.input,
              {
                color: colors.text,
                maxHeight: COMPOSER_MAX_LINES * (type.body.lineHeight ?? 22) + space.md,
                paddingVertical: space.xs,
              },
            ]}
            testID="session-composer"
            value={text}
            onChangeText={setText}
            placeholder={tr('session.composerPlaceholder')}
            placeholderTextColor={colors.textMuted}
            accessibilityLabel={tr('session.composerPlaceholder')}
            multiline
            editable
            textAlignVertical="center"
          />
          {/* Image 06: the model pill lives INSIDE the capsule on its own row, with the send control
              as a round icon button next to it. No "+"/mic: there is nothing behind them yet (P2). */}
          <View style={[styles.composerRow, { gap: space.sm }]}>
            {subagentSession ? (
              // A subagent session's model cannot be changed from here (the `models` request fails
              // with `session/agent-busy`), so there is no pill and no round trip — one honest line.
              <Text style={[type.captionSmall, { color: colors.textMuted, flexShrink: 1 }]} numberOfLines={1}>
                {tr('authoring.modelSubagent')}
              </Text>
            ) : (
              <ComposerModelRow
                currentModel={snapshot.currentModel}
                hasCatalog={snapshot.models.length > 0}
                onOpenModel={() => setModelPickerOpen(true)}
                hint={tr('authoring.model')}
              />
            )}
            <View style={{ flex: 1 }} />
            {/* Đợt 3: does NOT record. It focuses the field so the keyboard's own mic key transcribes
                into it, and says so — no recording library, no microphone permission. */}
            <MicHintButton
              label={tr('session.mic')}
              onPress={() => {
                composerRef.current?.focus();
                setMicHint(true);
              }}
            />
            <TouchableOpacity
              style={[
                styles.sendRound,
                {
                  // Item 3: a disabled control was a ghost (faint arrow on the paper colour). Use the
                  // theme's DEDICATED disabled pair — `disabledFill`/`disabledLabel`, guarded by
                  // test/theme-contrast.test.ts at >= 4.5:1 in both schemes — so the empty state is a
                  // visible grey circle rather than nothing.
                  backgroundColor: canSend ? colors.accent : colors.disabledFill,
                  minWidth: hit,
                  minHeight: hit,
                  width: hit,
                  height: hit,
                  borderRadius: radius.circle,
                },
              ]}
              disabled={!canSend}
              accessibilityRole="button"
              accessibilityLabel={tr('session.send')}
              accessibilityState={{ disabled: !canSend, busy: sending }}
              testID="session-send"
              onPress={() => void send()}
            >
              {sending ? (
                <ActivityIndicator color={colors.onAccent} />
              ) : (
                <Text style={[type.heading, { color: canSend ? colors.onAccent : colors.disabledLabel }]}>↑</Text>
              )}
            </TouchableOpacity>
          </View>
          {/* Honest state instead of silence: a catalog that could not be read says why. The split
              lives in `modelUnavailableReasonKey` so a non-permission refusal (e.g. `session/agent-busy`)
              can never be reported as "not granted permission". */}
          {subagentSession || snapshot.modelsState !== 'error' ? null : (
            <Text style={[type.captionSmall, { color: colors.textMuted }]}>
              {tr(modelUnavailableReasonKey(snapshot.modelsError))}
            </Text>
          )}
        </View>
      </View>

      {/* "More" holds exactly one action today: stopping the session. Rename/archive/pin are
          admin-only operations (P2) and would be a promise the app cannot keep. */}
      <Modal visible={menuOpen} transparent animationType="fade" onRequestClose={() => setMenuOpen(false)}>
        <Pressable
          style={[styles.scrim, { backgroundColor: colors.overlay }]}
          onPress={() => setMenuOpen(false)}
          accessibilityRole="button"
          accessibilityLabel={tr('common.cancel')}
        >
          <View
            style={[
              styles.menu,
              {
                backgroundColor: colors.surfaceRaised,
                borderColor: colors.border,
                borderRadius: radius.xl,
                marginTop: 64,
                marginRight: space.lg,
                ...elevation(colors, 'sheet'),
              },
            ]}
          >
            <TouchableOpacity
              style={[styles.menuItem, { minHeight: hit, paddingHorizontal: space.lg }]}
              accessibilityRole="button"
              accessibilityLabel={tr('team.title')}
              onPress={() => {
                setMenuOpen(false);
                setTeamOpen(true);
              }}
              testID="session-team"
            >
              <Text style={[type.body, { color: colors.text }]}>{tr('team.title')}</Text>
            </TouchableOpacity>
            {canReadStats ? (
              <TouchableOpacity
                style={[styles.menuItem, { minHeight: hit, paddingHorizontal: space.lg }]}
                accessibilityRole="button"
                accessibilityLabel={tr('stats.title')}
                onPress={() => {
                  setMenuOpen(false);
                  setStatsOpen(true);
                }}
                testID="session-stats"
              >
                <Text style={[type.body, { color: colors.text }]}>{tr('stats.title')}</Text>
              </TouchableOpacity>
            ) : null}
            <TouchableOpacity
              style={[styles.menuItem, { minHeight: hit, paddingHorizontal: space.lg }]}
              accessibilityRole="button"
              accessibilityLabel={tr('session.cancel')}
              onPress={() => {
                setMenuOpen(false);
                confirmCancel();
              }}
              testID="session-stop"
            >
              <Text style={[type.body, { color: colors.danger }]}>{tr('session.cancel')}</Text>
            </TouchableOpacity>
          </View>
        </Pressable>
      </Modal>
      {/* Spec 017 Đợt 2 item 2: the agent team of this session. Read-only: members with their
          phase, every task with subject/status/owner and a blocked marker, and the sub-agent
          catalog. The bulk field (a task's description) is collapsed to two lines. */}
      <Modal visible={teamOpen} transparent animationType="slide" onRequestClose={() => setTeamOpen(false)}>
        <View style={[styles.teamScreen, { backgroundColor: colors.bg }]}>
          <View style={[styles.teamHeader, { paddingHorizontal: space.lg, paddingTop: 48, paddingBottom: space.sm, borderBottomColor: colors.border }]}>
            <Text style={[type.heading, { color: colors.text, flex: 1 }]}>{tr('team.title')}</Text>
            <TouchableOpacity
              accessibilityRole="button"
              accessibilityLabel={tr('common.cancel')}
              onPress={() => setTeamOpen(false)}
              testID="session-team-close"
              style={{ minWidth: hit, minHeight: hit, alignItems: 'center', justifyContent: 'center' }}
            >
              <Text style={[type.heading, { color: colors.textMuted }]}>✕</Text>
            </TouchableOpacity>
          </View>
          <ScrollView contentContainerStyle={{ padding: space.lg, gap: space.lg }}>
            <AgentTeamPanel team={teamView} catalog={catalogView} tr={tr} onRetry={() => void loadTeam()} />
          </ScrollView>
        </View>
      </Modal>
      {/* Spec 018: the session's own metrics (tokens, context use, turns/steps), read-only and reachable
          only when this pairing holds `stats:read`. */}
      <Modal visible={statsOpen} transparent animationType="slide" onRequestClose={() => setStatsOpen(false)}>
        <View style={[styles.teamScreen, { backgroundColor: colors.bg }]}>
          <View style={[styles.teamHeader, { paddingHorizontal: space.lg, paddingTop: 48, paddingBottom: space.sm, borderBottomColor: colors.border }]}>
            <Text style={[type.heading, { color: colors.text, flex: 1 }]}>{tr('stats.title')}</Text>
            <TouchableOpacity
              accessibilityRole="button"
              accessibilityLabel={tr('common.cancel')}
              onPress={() => setStatsOpen(false)}
              testID="session-stats-close"
              style={{ minWidth: hit, minHeight: hit, alignItems: 'center', justifyContent: 'center' }}
            >
              <Text style={[type.heading, { color: colors.textMuted }]}>✕</Text>
            </TouchableOpacity>
          </View>
          <ScrollView contentContainerStyle={{ padding: space.lg, gap: space.lg }}>
            <SessionStatsPanel view={statsView} tr={tr} onRetry={() => void loadStats()} />
          </ScrollView>
        </View>
      </Modal>
      {/* Spec 019: the lower-only sheet. Every row is a preset the gateway offered and re-checked
          here; tapping one asks the confirmation Alert before anything is sent. */}
      <Modal
        visible={permissionSheetOpen}
        transparent
        animationType="slide"
        onRequestClose={() => setPermissionSheetOpen(false)}
      >
        <View style={[styles.teamScreen, { backgroundColor: colors.bg }]}>
          <View style={[styles.teamHeader, { paddingHorizontal: space.lg, paddingTop: 48, paddingBottom: space.sm, borderBottomColor: colors.border }]}>
            <Text style={[type.heading, { color: colors.text, flex: 1 }]}>{tr('session.permissionTitle')}</Text>
            <TouchableOpacity
              accessibilityRole="button"
              accessibilityLabel={tr('common.cancel')}
              onPress={() => setPermissionSheetOpen(false)}
              testID="permission-close"
              style={{ minWidth: hit, minHeight: hit, alignItems: 'center', justifyContent: 'center' }}
            >
              <Text style={[type.heading, { color: colors.textMuted }]}>✕</Text>
            </TouchableOpacity>
          </View>
          <PermissionSheetBody
            // A rejected read is its own state (retry line); a still-loading sheet says so only
            // before ANY answer exists, so a reply is never blanked by a follow-up read.
            state={permissionReadFailed ? 'error'
              : permissionView === null ? 'loading'
                : permissionView.state === 'unavailable' ? 'unavailable'
                  : 'ready'}
            currentValue={permissionView !== null && permissionView.state === 'ready'
              ? permissionView.value.currentValue
              : null}
            rows={permissionSheetRows(permissionView, tr)}
            busy={permissionBusy}
            receipt={permissionReceipt === null
              ? null
              : permissionReceipt.key === 'session.permissionConfirm' && permissionReceipt.preset !== null
                ? tr('session.permissionConfirm', { preset: permissionReceipt.preset })
                : tr(permissionReceipt.key)}
            labels={{
              current: tr('session.permissionCurrent', { preset: permissionSheetCurrent(permissionView) }),
              empty: tr('session.permissionEmpty'),
              unavailable: tr('session.permissionUnavailable'),
              failed: tr('session.permissionLoadFailed'),
            }}
            onRetry={() => void loadPermissionOptions()}
            onChoose={confirmPermissionLower}
          />
        </View>
      </Modal>
    </KeyboardAvoidingView>
  );
}

/**
 * A thrown `CoreError` from the switch, as fixed copy. The codes that ARE a receipt reason get
 * that reason's sentence; `auth/*` (the device's grant, routine after a revoke) and anything the
 * app cannot classify get the generic sentence — the Host's own message is never rendered.
 */
function permissionErrorKey(code: string | undefined): MessageKey {
  switch (code) {
    case 'not-stricter':
      return 'session.permissionNotStricter';
    case 'custom-current':
      return 'session.permissionCustomCurrent';
    case 'raced':
      return 'session.permissionRaced';
    case 'unavailable':
      return 'session.permissionUnavailable';
    default:
      return 'session.permissionError';
  }
}

/** The sheet's rows: the gateway's offer, filtered by the pure `optionRows`; none until `ready`. */
function permissionSheetRows(view: PermissionOptionsResult | null, tr: Interpolate) {
  if (view === null || view.state !== 'ready') return [];
  return optionRows(view.value.options, (option) => tr('session.permissionPair', { sandbox: option.sandbox, approval: option.approval }));
}

/** The preset the sheet states as current; empty until a reply named one (the sheet hides that line). */
function permissionSheetCurrent(view: PermissionOptionsResult | null): string {
  return view !== null && view.state === 'ready' ? (view.value.currentValue ?? '') : '';
}

/**
 * One history row. Assistant output is markdown; our own prompts and the host's tool/system rows
 * are not prose, so they get a bubble and a compact muted pill respectively (Clarklevis draws
 * its tool calls the same way).
 */
function MessageRow(props: {
  message: HistoryMessage;
  tr: Interpolate;
  onOpenLink: (href: string, label: string) => void;
  /** Long-press → "reply": the screen turns this row into the composer's quote. */
  onReply: (message: HistoryMessage) => void;
}) {
  const { message, tr, onOpenLink, onReply } = props;
  const { colors, type, space, radius, hit } = useTheme();
  // Hoisted so the `<Markdown …/>` tag stays a single short line: `test/session-title.test.ts` reads
  // that tag to prove the raw source reaches the parser unrewritten, and an inline label object
  // pushed the closing `/>` outside its match window.
  const markdownLabels = {
    share: tr('session.share'),
    expand: tr('session.expandTable'),
    close: tr('common.cancel'),
  };

  if (message.role === 'tool' || message.role === 'system' || message.role === 'other') {
    return (
      <ToolRow
        label={message.role === 'tool' ? tr('session.role.tool') : message.role === 'system' ? tr('session.role.system') : tr('session.role.other')}
        text={message.text}
      />
    );
  }

  if (message.role === 'user') {
    return (
      <Pressable
        onLongPress={() => onReply(message)}
        accessibilityRole="text"
        accessibilityHint={tr('session.reply')}
        style={[
          styles.bubble,
          styles.bubbleUser,
          { backgroundColor: colors.accentSoft, borderRadius: radius.lg, padding: space.md, gap: space.xxs },
        ]}
      >
        <Text style={[type.body, { color: colors.text }]}>{message.text}</Text>
        <PromptSendState message={message} />
      </Pressable>
    );
  }

  return (
    <View style={[styles.assistant, { gap: space.xxs }]}>
      <Pressable onLongPress={() => onReply(message)} accessibilityHint={tr('session.reply')}>
        <Markdown source={message.text} onOpenLink={onOpenLink} labels={markdownLabels} />
      </Pressable>
      {/* Wave 1 (ProcessReasoningDisclosure.kt): the model's thinking stays folded under the answer. */}
      {message.reasoning === undefined ? null : (
        <ProcessReasoning reasoning={message.reasoning} tr={tr} />
      )}
      {/* Image 04: one small action under the answer. Copy would need a clipboard dependency (the
          APK loop only swaps the JS bundle, so no native module may be added); RN's built-in Share
          gives the user the same practical outcome — take the text elsewhere. No like/dislike. */}
      <View style={[styles.messageActions, { gap: space.sm }]}>
        <TouchableOpacity
          style={[styles.messageAction, { minHeight: hit, minWidth: hit, paddingHorizontal: space.sm }]}
          accessibilityRole="button"
          accessibilityLabel={tr('session.share')}
          onPress={() => {
            void Share.share({ message: message.text }).catch(() => {
              /* the sheet was dismissed or unavailable; nothing to retry */
            });
          }}
          testID="session-share"
        >
          <Text style={[type.caption, { color: colors.textMuted }]}>⤴ {tr('session.share')}</Text>
        </TouchableOpacity>
      </View>
      <PromptSendState message={message} />
    </View>
  );
}

/**
 * The one line under a prompt bubble that says what happened to it.
 *
 * Driven by `promptSendState`: "sending" only while the receipt is genuinely outstanding, "not
 * confirmed" once the request timeout has passed, and the refusal reason when the Host said no — a
 * bubble can never sit in "đang gửi…" after the turn is visibly running.
 */
function PromptSendState(props: { message: HistoryMessage }) {
  const { tr } = useApp();
  const { colors, type } = useTheme();
  const { message } = props;
  const now = Date.now();
  const label = promptSendLabel(message, tr, now);
  if (label === null) return null;
  const failed = promptSendState(message, now) === 'failed';
  return (
    <Text style={[type.captionSmall, { color: failed ? colors.danger : colors.textMuted }]}>{label}</Text>
  );
}

function ApprovalCardView(props: {  card: ApprovalCardView;
  tr: Interpolate;
  focused: boolean;
  busy: boolean;
  onApprove: () => void;
  onReject: () => void;
  onReload: () => void;
}) {
  const { card, tr, focused, busy, onApprove, onReject, onReload } = props;
  const { colors, type, space, radius } = useTheme();
  // Defense in depth: the server caps at 2 KB and the card shows a redacted, shorter preview.
  const preview = redactArgsPreview(card.argsPreview, 400);
  const reasonText =
    card.displayReason?.en ?? (Object.values(card.displayReason ?? {})[0] as string | undefined) ?? '';
  // M10: buttons only for a card that may actually be decided. A `review-again` card was
  // refused with `hash-mismatch` and reopens only after a fresh server view (see the
  // "Review again" action below).
  const decidable = card.canApprove && card.argsHash !== null && card.status === 'pending';
  return (
    <View
      style={[
        styles.card,
        {
          backgroundColor: colors.surfaceRaised,
          borderColor: focused ? colors.accent : colors.border,
          borderWidth: focused ? 2 : StyleSheet.hairlineWidth,
          borderRadius: radius.lg,
          padding: space.lg,
          gap: space.sm,
          ...elevation(colors, 'card'),
        },
      ]}
      testID={`approval-card-${card.approvalId}`}
    >
      <Text style={[type.subheading, { color: colors.text }]}>{tr('approval.title', { tool: card.toolName })}</Text>
      {reasonText !== '' ? (
        <Text style={[type.bodySmall, { color: colors.textMuted }]}>{reasonText}</Text>
      ) : null}
      {preview !== '' ? (
        <View style={{ backgroundColor: colors.codeBg, borderRadius: radius.sm, paddingHorizontal: space.sm, paddingVertical: space.xs }}>
          <Text style={[type.mono, { fontFamily: Platform.select(monoFont), color: colors.text }]}>{preview}</Text>
        </View>
      ) : null}

      {card.argsHash === null ? (
        <Text style={[type.caption, { color: colors.textMuted }]} testID={`approval-state-${card.approvalId}`}>
          {tr('approval.decideOnComputer')}
        </Text>
      ) : null}
      {card.status === 'review-again' ? (
        <Text style={[type.caption, { color: colors.danger, fontWeight: '600' }]} testID={`approval-state-${card.approvalId}`}>
          {card.notice ?? tr('approval.changed')}
        </Text>
      ) : null}
      {card.status === 'already-decided' ? (
        <Text style={[type.caption, { color: colors.textMuted }]} testID={`approval-state-${card.approvalId}`}>
          {card.notice ?? tr('approval.alreadyDecided')}
        </Text>
      ) : null}
      {card.status === 'resolved' ? (
        <Text style={[type.caption, { color: colors.success, fontWeight: '600' }]} testID={`approval-state-${card.approvalId}`}>
          {card.outcome === 'rejected' ? tr('approval.rejected') : tr('approval.approved')}
        </Text>
      ) : null}

      {decidable ? (
        <View style={{ flexDirection: 'row', gap: space.sm, marginTop: space.xxs }}>
          <TouchableOpacity
            style={[
              styles.decision,
              { backgroundColor: colors.success, borderRadius: radius.md, minHeight: 48, paddingHorizontal: space.lg },
              busy && styles.disabled,
            ]}
            disabled={busy}
            onPress={onApprove}
            accessibilityRole="button"
            accessibilityLabel={tr('approval.approve')}
            accessibilityState={{ disabled: busy }}
            testID={`approval-approve-${card.approvalId}`}
          >
            <Text style={[type.button, { color: colors.onAccent }]}>{tr('approval.approve')}</Text>
          </TouchableOpacity>
          <TouchableOpacity
            style={[
              styles.decision,
              {
                backgroundColor: colors.surface,
                borderColor: colors.danger,
                borderRadius: radius.md,
                minHeight: 48,
                paddingHorizontal: space.lg,
              },
              busy && styles.disabled,
            ]}
            disabled={busy}
            onPress={onReject}
            accessibilityRole="button"
            accessibilityLabel={tr('approval.reject')}
            accessibilityState={{ disabled: busy }}
            testID={`approval-reject-${card.approvalId}`}
          >
            <Text style={[type.button, { color: colors.danger }]}>{tr('approval.reject')}</Text>
          </TouchableOpacity>
        </View>
      ) : null}
      {card.status === 'review-again' ? (
        <TouchableOpacity
          style={[styles.reload, { borderRadius: radius.pill, minHeight: 44, paddingHorizontal: space.lg, backgroundColor: colors.surface }]}
          accessibilityRole="button"
          accessibilityLabel={tr('approval.reviewAgain')}
          onPress={onReload}
        >
          <Text style={[type.caption, { color: colors.accent }]}>{tr('approval.reviewAgain')}</Text>
        </TouchableOpacity>
      ) : null}
    </View>
  );
}

/** The header pill's word, reusing the session-list vocabulary so both screens agree. */
function statusWord(tr: Interpolate, state: 'running' | 'idle' | 'archived'): string {
  if (state === 'running') return tr('tabs.running');
  if (state === 'archived') return tr('tabs.archived');
  return tr('tabs.idle');
}

/**
 * States in which a prompt can never be delivered until the USER acts: the device was revoked, the
 * app must be updated, the gateway is switched off, or the credential needs re-authorising. Typing
 * stays enabled even then (a draft is not lost); only Send is withheld, because a queued prompt would
 * sit in the outbox forever.
 */
function isDeliveryImpossible(connection: ClientState): boolean {
  return (
    connection === 'revoked' ||
    connection === 'update-required' ||
    connection === 'gateway-disabled' ||
    connection === 'reauth-required'
  );
}

/**
 * Why the socket is not live, in the user's words. Only the terminal states say "offline" (the app
 * will not silently drop the prompt, so it must say the socket is not there); every recoverable state
 * — connecting, handshaking, idle, a just-closed socket that the reconnect loop is already retrying —
 * says "you can type meanwhile", because Send is enabled and queues.
 */
function sendUnavailableCopy(tr: Interpolate, connection: ClientState): string {
  if (isDeliveryImpossible(connection)) return tr('session.sendOffline');
  return tr('session.sendNotReady');
}

function bannerCopy(
  tr: Interpolate,
  banner: 'reconnecting' | 'offline' | 'gateway-off' | 'revoked' | 'reauth' | 'cleanup-failed',
): string {
  switch (banner) {
    case 'reconnecting':
      return tr('banner.reconnecting');
    case 'offline':
      return tr('banner.offline');
    case 'gateway-off':
      return tr('banner.gatewayOff');
    case 'revoked':
      return tr('banner.revoked');
    case 'reauth':
      return tr('banner.reauth');
    case 'cleanup-failed':
      return tr('banner.cleanupFailed');
  }
}

const styles = StyleSheet.create({
  container: { flex: 1 },
  header: { flexDirection: 'row', alignItems: 'center', borderBottomWidth: StyleSheet.hairlineWidth },
  roundButton: { alignItems: 'center', justifyContent: 'center' },
  messageActions: { flexDirection: 'row', alignItems: 'center' },
  messageAction: { flexDirection: 'row', alignItems: 'center' },
  headerTitles: { flex: 1 },
  subline: { flexDirection: 'row', alignItems: 'center' },
  composerRow: { flexDirection: 'row', alignItems: 'center' },
  scrollBottom: { position: 'absolute', left: 0, right: 0, alignItems: 'flex-end', paddingRight: 16 },
  quote: { borderLeftWidth: 3 },
  teamScreen: { flex: 1 },
  teamHeader: { flexDirection: 'row', alignItems: 'center', borderBottomWidth: StyleSheet.hairlineWidth },
  sendRound: { alignItems: 'center', justifyContent: 'center' },
  headerButton: { alignItems: 'center', justifyContent: 'center' },
  title: { flex: 1 },
  list: { paddingBottom: 120 },
  centerArea: { alignItems: 'center' },
  banner: { borderLeftWidth: 3 },
  loadOlder: { alignSelf: 'center', alignItems: 'center', justifyContent: 'center' },
  bubble: { maxWidth: '86%' },
  bubbleUser: { alignSelf: 'flex-end' },
  assistant: { alignSelf: 'stretch' },
  retry: { alignSelf: 'flex-start', justifyContent: 'center' },
  composerWrap: { justifyContent: 'flex-end' },
  reason: { alignItems: 'center' },
  composer: { borderWidth: StyleSheet.hairlineWidth },
  // One line when empty, then it grows to COMPOSER_MAX_LINES: `flex: 1` on a column made the input
  // and the pill row share one row, which squeezed the field into a tall, placeholder-less column.
  input: { paddingHorizontal: 0, minHeight: 26 },
  send: { alignItems: 'center', justifyContent: 'center' },
  card: { borderWidth: StyleSheet.hairlineWidth },
  decision: { flex: 1, alignItems: 'center', justifyContent: 'center', borderWidth: StyleSheet.hairlineWidth },
  reload: { alignSelf: 'flex-start', alignItems: 'center', justifyContent: 'center' },
  scrim: { flex: 1, alignItems: 'flex-end' },
  menu: { borderWidth: StyleSheet.hairlineWidth, overflow: 'hidden' },
  menuItem: { justifyContent: 'center' },
  disabled: { opacity: 0.5 },
});
