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
  AccessibilityInfo,
  ActivityIndicator,
  Alert,
  Animated,
  Easing,
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
import * as DocumentPicker from 'expo-document-picker';
// Spec 044 — platform-resolved byte reader. On web this resolves to `picked-file.web.ts` (the real
// DOM File, no expo-file-system); native keeps the existing File/info/arrayBuffer path.
import {
  isPickerObjectUrl,
  readPickedFile,
  revokePickerObjectUrl,
  WEB_PICKED_FILE_READ_TIMEOUT_MS,
} from '../../src/platform/picked-file';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import Svg, { Circle } from 'react-native-svg';
import {
  ArrowUp,
  Check,
  ChevronLeft,
  Ellipsis,
  Monitor,
  Plus,
  RotateCcw,
  Shield,
  ShieldCheck,
  X,
} from 'lucide-react-native';

import type { ApprovalCardView, QuestionCardView } from '../../src/app-state';
import type { QuestionAnswer } from '../../src/core/questions';
import { ATTACHMENTS_WRITE_SCOPE, admitClientUploadSize } from '../../src/core';
import { isSubagentSession } from '../../src/core/sessions';
import { isCurrentUpload, ownsUpload, shouldClearReceipt, type UploadIdentity } from '../../src/ui/conversation/upload-lifecycle';
import { sessionDisplayTitle } from '../../src/ui/session-title';
import { promptSendLabel, promptSendState } from '../../src/ui/prompt-state';
import { redactArgsPreview } from '../../src/core';
import type { ClientState, HistoryMessage } from '../../src/core';
import { composerPalette, elevation, monoFont, sessionChromePalette, useTheme } from '../../src/ui/theme';
import { MicHintButton, MicHintLine } from '../../src/ui/conversation/MicHintButton';
import { AgentTeamPanel } from '../../src/ui/conversation/AgentTeamPanel';
import { SessionStatsPanel } from '../../src/ui/components/stats-panel';
import { contextRingRatio, statsErrorCopy, toSessionPanelView, toStatsView, type StatsView } from '../../src/ui/read-only-views';
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
import { GlassSurface } from '../../src/ui/components/ui';
import { MeshBackdrop } from '../../src/ui/components/ocean-mesh';
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

/** How close to the top a reader must be before older history is fetched on scroll. */
const OLDER_HISTORY_TOP_PX = 100;

/** Safety net for platforms that never emit onContentSizeChange; generation-guarded, no stale height. */
const INITIAL_SCROLL_FALLBACK_MS = 800;

/**
 * Pure viewport maths for a prepend: keep the SAME row under the finger. `oldHeight` is the content
 * height measured before the older page arrived, `newHeight` the one reported by the layout after.
 * Clamped at 0 — a prepend can never ask for a negative offset.
 */
export function prependViewportOffset(oldOffset: number, oldHeight: number, newHeight: number): number {
  return Math.max(0, oldOffset + newHeight - oldHeight);
}

/**
 * Spec 044 — register the once-only release of a picker-created object URL on the transfer that
 * owns it. Pure so the cleanup can be exercised behaviourally in Node tests; the screen calls it
 * IMMEDIATELY after receiving an asset and BEFORE the stale guard, otherwise a picker that resolves
 * after a session switch would leak its blob URL.
 */
export function registerPickedObjectUrl(
  owner: { releaseObjectUrl: () => void },
  uri: unknown,
  isObjectUrl: (uri: unknown) => boolean,
  revoke: (uri: string) => void,
): void {
  if (!isObjectUrl(uri)) return;
  const objectUrl = uri as string;
  let revoked = false;
  owner.releaseObjectUrl = () => {
    if (revoked) return;
    revoked = true;
    revoke(objectUrl);
  };
}

// ---------------------------------------------------------------------------
// Spec 048 — pure UI helpers (no renderer, no wire): web batch admission, receipt snapshots and
// the non-blocking progress phase. Kept HERE (screen scope) so the other agents' core work stays
// untouched and the Node tests exercise the same functions the screen calls.
// ---------------------------------------------------------------------------

/** PWA image picks are capped: six files, 64 MiB TOTAL, admitted before any byte is read. */
export const MAX_BATCH_IMAGES = 6;

export interface AttachmentReceipt {
  sessionId: string;
  name: string;
  receiptId: string;
}

function batchError(code: string): Error {
  const error = new Error('attachment-batch');
  (error as { code?: string }).code = code;
  return error;
}

/** Fail closed on the WHOLE batch before the first read; missing/NaN/negative sizes are refused. */
export function admitImageBatch(assets: readonly { size?: number; fileSize?: number }[]): void {
  if (assets.length > MAX_BATCH_IMAGES) throw batchError('too-many-files');
  let total = 0;
  for (const asset of assets) {
    if (asset.size === undefined || !Number.isFinite(asset.size) || asset.size < 0) {
      throw batchError('file-too-large');
    }
    // Spec 044 parity: the DOM File's own size is authoritative on web and is admitted for EVERY
    // asset BEFORE the first read — not left until that file's turn in the sequential loop.
    if (asset.fileSize !== undefined && (!Number.isFinite(asset.fileSize) || asset.fileSize < 0)) {
      throw batchError('file-too-large');
    }
    const effective = asset.fileSize ?? asset.size;
    if (!Number.isFinite(effective) || effective < 0) throw batchError('file-too-large');
    total += effective;
  }
  admitClientUploadSize(total);
}

/** Only receipts of THIS session may be shown or sent with this session's prompt. */
export function receiptsForSession(receipts: readonly AttachmentReceipt[], sessionId: string): AttachmentReceipt[] {
  return receipts.filter((receipt) => receipt.sessionId === sessionId);
}

/** Add a Host receipt once, without disturbing receipts of other sessions. */
export function addReceipt(receipts: readonly AttachmentReceipt[], receipt: AttachmentReceipt): AttachmentReceipt[] {
  if (receipts.some((item) => item.sessionId === receipt.sessionId && item.receiptId === receipt.receiptId)) {
    return receipts as AttachmentReceipt[];
  }
  return [...receipts, receipt];
}

/**
 * On a successful ack clear EXACTLY the snapshotted receiptIds of that session. A refusal/timeout
 * never calls this, so the receipts stay for retry; a receipt added during the send is untouched.
 */
export function clearSnapshottedReceipts(
  current: readonly AttachmentReceipt[],
  sessionId: string,
  receiptIds: readonly string[],
): AttachmentReceipt[] {
  const sent = new Set(receiptIds);
  return current.filter((receipt) => !(receipt.sessionId === sessionId && sent.has(receipt.receiptId)));
}

/** Web header must be an opaque, same-scheme fill; native keeps the floating translucent look. */
export function resolveHeaderBackground(colors: { bg: string; glassSolid: string }, web: boolean): string {
  return web ? colors.glassSolid : translucent(colors.bg);
}

export type ProgressPhase = 'sending' | 'processing' | null;

/** Derived ONLY from existing state: no new wire, no private reasoning text in the indicator. */
export function progressPhase(input: {
  sending: boolean; outgoing: readonly { status: string }[]; running: boolean;
}): ProgressPhase {
  // Only the outbox's non-terminal statuses mean "still sending". A REJECTED ('failed') item is
  // terminal and must not keep the indicator up forever after a refusal.
  const active = input.outgoing.some((item) => item.status === 'queued' || item.status === 'sent');
  if (input.sending || active) return 'sending';
  if (input.running) return 'processing';
  return null;
}

/**
 * Spec 050 — "since this PWA observed the running state". Never a claim about the Host's own start
 * time; no persistent timer across reloads. Whole seconds, at most hours in normal use.
 */
export function formatProcessingElapsed(ms: number): string {
  const total = Math.max(0, Math.floor(ms / 1000));
  if (total < 60) return `${total}s`;
  const minutes = Math.floor(total / 60);
  const seconds = total % 60;
  if (minutes < 60) return `${minutes}m ${seconds}s`;
  return `${Math.floor(minutes / 60)}h ${minutes % 60}m`;
}

/** Exactly one "jump to newest" per opened session id, fired by the FIRST page — never by a prepend. */
export function shouldScrollToNewestOnOpen(state: {
  doneFor: string | null;
  sessionId: string;
  historyLoaded: boolean;
  historyLoading: boolean;
}): boolean {
  return state.sessionId !== ''
    && state.doneFor !== state.sessionId
    && state.historyLoaded
    && !state.historyLoading;
}

/**
 * Opening-jump coordinator — a PURE state machine the screen only drives and obeys.
 *
 * A native ScrollView has no layout on the first render, so the effect must NOT call `scrollToEnd`
 * or mark the jump done: a spinner / previous page's height is not proof that the transcript landed.
 * The effect only SCHEDULES a pending jump (with a generation token); ONLY a later transcript layout
 * (or the generation-guarded fallback) completes it. `prependRestore` is a separate branch and never
 * completes an opening jump. Kept pure so the whole sequence is testable without a renderer.
 */
export interface InitialScrollState {
  /** Bumped on every new schedule / session change; stale fallbacks carry an older generation. */
  generation: number;
  /** Session whose opening jump already landed (at most one per opened id). */
  doneFor: string | null;
  /** The single jump waiting for a real transcript layout. */
  pending: { sessionId: string; generation: number } | null;
}

export type InitialScrollEvent =
  | { kind: 'session'; sessionId: string }
  | { kind: 'history'; sessionId: string; loaded: boolean; loading: boolean }
  | { kind: 'layout'; sessionId: string; generation: number; height: number }
  | { kind: 'fallback'; sessionId: string; generation: number };

export type InitialScrollCommand =
  | { kind: 'none' }
  | { kind: 'schedule-fallback'; sessionId: string; generation: number }
  | { kind: 'scroll-to-end'; sessionId: string };

export function createInitialScrollState(): InitialScrollState {
  return { generation: 0, doneFor: null, pending: null };
}

export function initialScrollStep(
  state: InitialScrollState,
  event: InitialScrollEvent,
): { state: InitialScrollState; command: InitialScrollCommand } {
  const noChange = { state, command: { kind: 'none' } as const };
  switch (event.kind) {
    case 'session':
      // A new session invalidates any pending jump and any fallback armed for the old one.
      return { state: { ...state, generation: state.generation + 1, pending: null }, command: { kind: 'none' } };
    case 'history':
      // Only a COMPLETE opening page schedules. Loading/spinner frames never schedule or complete.
      if (event.sessionId === '' || !event.loaded || event.loading
        || state.pending !== null || state.doneFor === event.sessionId) return noChange;
      {
        const generation = state.generation + 1;
        return {
          state: { ...state, generation, pending: { sessionId: event.sessionId, generation } },
          command: { kind: 'schedule-fallback', sessionId: event.sessionId, generation },
        };
      }
    case 'layout':
    case 'fallback': {
      const pending = state.pending;
      if (pending === null || pending.sessionId !== event.sessionId || pending.generation !== event.generation
        || (event.kind === 'layout' && event.height <= 0)) return noChange;
      return {
        state: { generation: state.generation, doneFor: pending.sessionId, pending: null },
        command: { kind: 'scroll-to-end', sessionId: pending.sessionId },
      };
    }
  }
}

/** “No message yet” is only honest after a complete opening page with no older pages behind it. */
export function shouldShowNoMessage(state: {
  connectionReady: boolean;
  historyLoaded: boolean;
  historyLoading: boolean;
  historyHasMore: boolean;
  historyHasEarlier: boolean;
}): boolean {
  return state.connectionReady
    && state.historyLoaded
    && !state.historyLoading
    && !state.historyHasMore
    && !state.historyHasEarlier;
}

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
  // Spec 049: on web the header/composer use a FIXED dark pair; native keeps the scheme palette.
  const isWeb = Platform.OS === 'web';
  const chrome = sessionChromePalette(isWeb, colors);
  const composer = isWeb
    ? { surface: chrome.surface, border: chrome.border, text: chrome.text, textMuted: chrome.textMuted }
    : composerPalette(theme.scheme);
  const headerHeight = insets.top + HEADER_BASE_HEIGHT;
  /**
   * The header's MEASURED height. `HEADER_BASE_HEIGHT` is only an estimate: the subline carries the
   * status pill, the agent preset and the permission chip, so the real header grows with the content
   * and with the safe-area inset. The "⋯" menu is anchored to this, not to a fixed offset, or it
   * starts inside the header on a device with a tall notch and covers the status line.
   */
  const [headerMeasured, setHeaderMeasured] = useState(0);

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
  /** Pure opening-jump state machine; the screen only dispatches events and obeys its command. */
  const initialScroll = useRef<InitialScrollState>(createInitialScrollState());
  /** Safety net when a platform never fires onContentSizeChange; guarded by generation, no stale height. */
  const initialScrollFallback = useRef<ReturnType<typeof setTimeout> | null>(null);
  const initialScrollFallbackGen = useRef<number | null>(null);
  /** Last measured scroll position, captured BEFORE an older page prepends rows above it. */
  const scrollMetrics = useRef({ offsetY: 0, contentHeight: 0 });
  /** Set when an older page is requested; consumed by `onContentSizeChange` after the layout grows. */
  const prependRestore = useRef<{ offsetY: number; oldHeight: number } | null>(null);
  /** Stops repeated near-top scroll events from queueing the same older page before `historyLoading` flips. */
  const olderAutoRequest = useRef(false);
  /** Đợt 3: the composer's field, so the mic control can focus it for the keyboard's own dictation. */
  const composerRef = useRef<ComponentRef<typeof TextInput>>(null);
  const [micHint, setMicHint] = useState(false);

  // Spec 041 FR-2: one transfer at a time, never bytes in the prompt text. The scope is a DEVICE
  // grant (not a hello capability), so an older pairing keeps a visible button that explains itself.
  const [attachSheetOpen, setAttachSheetOpen] = useState(false);
  const [attachMessage, setAttachMessage] = useState<string | null>(null);
  const [attachTransfer, setAttachTransfer] = useState<{
    name: string; sent: number; total: number; index: number; count: number;
  } | null>(null);
  // Per-BATCH identity: a generation bumped on session change/unmount and a UNIQUE token per batch.
  // Every post-await update checks all three; one batch may contain up to six sequential uploads.
  const uploadGen = useRef(0);
  const activeUpload = useRef<{
    generation: number; token: object; cancelled: boolean; uploadId: string | null;
    /** ALL picker object URLs (including unread assets) and read aborts, released exactly once. */
    releaseObjectUrl: () => void;
    abortRead: () => void;
  } | null>(null);
  // Synchronous single-flight: React state lags a tap burst, so the guard must be a ref set BEFORE
  // the picker opens. It also guards Send in the handler (not only the button's disabled prop).
  const attachInFlight = useRef(false);
  // Spec 048: a batch produces several Host receipts. Only THIS session's receipts are sendable.
  const [attachReceipts, setAttachReceipts] = useState<AttachmentReceipt[]>([]);
  const canAttach = controller.hasScope(ATTACHMENTS_WRITE_SCOPE);

  /** Invalidate the live transfer and cancel a reserved gateway slot, if one was named yet. */
  const invalidateUpload = useCallback(() => {
    uploadGen.current += 1;
    const active = activeUpload.current;
    activeUpload.current = null;
    attachInFlight.current = false;
    if (active === null) return;
    active.cancelled = true;
    // Spec 044: a session switch/unmount during a read must stop it and release the PICKER's own
    // object URL once; the transfer's `finally` closure is idempotent for the same reason.
    active.abortRead();
    active.releaseObjectUrl();
    if (active.uploadId !== null) void controller.cancelRemoteUpload(active.uploadId).catch(() => {});
  }, [controller]);

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

  /** Advance the pure machine and carry out only the command it returns (never from stale height). */
  const dispatchInitialScroll = (event: InitialScrollEvent): InitialScrollCommand => {
    const step = initialScrollStep(initialScroll.current, event);
    initialScroll.current = step.state;
    if (step.command.kind === 'schedule-fallback') {
      const { sessionId: target, generation } = step.command;
      if (initialScrollFallback.current !== null) clearTimeout(initialScrollFallback.current);
      initialScrollFallbackGen.current = generation;
      initialScrollFallback.current = setTimeout(() => {
        initialScrollFallback.current = null;
        // Stale timers are rejected by the generation guard inside the pure machine.
        dispatchInitialScroll({ kind: 'fallback', sessionId: target, generation });
      }, INITIAL_SCROLL_FALLBACK_MS);
    } else if (step.command.kind === 'scroll-to-end') {
      if (initialScrollFallback.current !== null) clearTimeout(initialScrollFallback.current);
      initialScrollFallback.current = null;
      initialScrollFallbackGen.current = null;
      scrollRef.current?.scrollToEnd({ animated: false });
      setAwayFromBottom(false);
    }
    return step.command;
  };

  useEffect(() => {
    if (sessionId !== '') controller.openSession(sessionId);
    olderAutoRequest.current = false;
    prependRestore.current = null;
    // Invalidate any pending jump / fallback from the previous session (pure 'session' event).
    if (initialScrollFallback.current !== null) clearTimeout(initialScrollFallback.current);
    initialScrollFallback.current = null;
    initialScrollFallbackGen.current = null;
    dispatchInitialScroll({ kind: 'session', sessionId });
    return () => controller.closeSession();
  }, [controller, sessionId]);

  // Spec 041: an upload receipt belongs to ONE session. Never carry it (or a stale transfer/error)
  // into another session's composer — the gateway would reject a receipt from a different session.
  useEffect(() => {
    invalidateUpload();
    // Spec 048: a session switch drops EVERY receipt, including partial batch successes.
    setAttachReceipts([]);
    setAttachTransfer(null);
    setAttachMessage(null);
    setAttachSheetOpen(false);
  }, [invalidateUpload, sessionId]);

  useEffect(() => () => invalidateUpload(), [invalidateUpload]);

  // Lazy history: a COMPLETE opening page only SCHEDULES the jump. No scrollToEnd here, and no done
  // mark: a spinner/previous-page height is not proof the transcript has laid out.
  useEffect(() => {
    dispatchInitialScroll({
      kind: 'history',
      sessionId,
      loaded: snapshot.historyLoaded,
      loading: snapshot.historyLoading,
    });
  }, [sessionId, snapshot.historyLoaded, snapshot.historyLoading]);

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
  // Spec 048 §4: derived from state the app ALREADY has. No new frame, no reasoning text inline;
  // ack/failure/turn end/history reload all clear it through these same existing fields.
  const phase = progressPhase({
    sending,
    outgoing: snapshot.outgoing,
    running: session?.state === 'running',
  });
  // Spec 050: the start belongs to the CONTROLLER, so leaving and reopening this session while
  // the same turn is still processing does not restart the clock. A non-processing phase ends it.
  const [elapsedMs, setElapsedMs] = useState(0);
  useEffect(() => {
    const since = controller.processingSince(sessionId, phase);
    if (since === null) {
      setElapsedMs(0);
      return;
    }
    const tick = () => setElapsedMs(Date.now() - since);
    tick();
    const timer = setInterval(tick, 1_000);
    return () => clearInterval(timer);
  }, [controller, phase, sessionId]);

  // Subtle liveness pulse only while processing; a static label remains when motion is reduced.
  const [reduceMotion, setReduceMotion] = useState(false);
  useEffect(() => {
    let alive = true;
    void AccessibilityInfo.isReduceMotionEnabled?.().then((value) => {
      if (alive) setReduceMotion(value === true);
    }).catch(() => undefined);
    return () => { alive = false; };
  }, []);
  const pulse = useRef(new Animated.Value(1)).current;
  useEffect(() => {
    if (phase !== 'processing' || reduceMotion) {
      pulse.setValue(1);
      return;
    }
    const loop = Animated.loop(Animated.sequence([
      Animated.timing(pulse, { toValue: 0.7, duration: 900, easing: Easing.inOut(Easing.ease), useNativeDriver: true }),
      Animated.timing(pulse, { toValue: 1, duration: 900, easing: Easing.inOut(Easing.ease), useNativeDriver: true }),
    ]));
    loop.start();
    return () => loop.stop();
  }, [phase, reduceMotion, pulse]);

  const phaseLabel = phase === 'sending' ? tr('session.sending')
    : phase === 'processing' ? tr('session.processingElapsed', { elapsed: formatProcessingElapsed(elapsedMs) }) : null;

  const send = useCallback(async () => {
    const value = text.trim();
    // Spec 041: the handler itself refuses a transfer in flight (the ref is synchronous), and a
    // receipt is only consumed when the Host confirms this exact prompt.
    if (value === '' || sending || attachInFlight.current) return;
    // Spec 048: snapshot the EXACT receipt set of this session. A receipt added while the send is
    // in flight is not part of this prompt and must survive; a refusal/timeout keeps them all.
    const receipts = receiptsForSession(attachReceipts, sessionId);
    const receiptIds = receipts.map((receipt) => receipt.receiptId);
    setSending(true);
    // Wave 1 (ComposerReplyPreview.kt): a reply carries the quoted excerpt to the Host as a markdown
    // blockquote, so the model sees what is being answered. The quote is cleared with the draft.
    const payload = replyTo === null ? value : buildQuotePrompt(replyTo.text, value);
    setText('');
    setReplyTo(null);
    try {
      const sent = await controller.sendPrompt(payload, {
        ...(receiptIds.length === 0 ? {} : { files: receiptIds.map((receiptId) => ({ receiptId })) }),
      });
      if (sent && receiptIds.length > 0) {
        setAttachReceipts((current) => clearSnapshottedReceipts(current, sessionId, receiptIds));
      }
    } finally {
      setSending(false);
    }
  }, [attachReceipts, controller, replyTo, sending, sessionId, text]);

  /**
   * Spec 041 FR-2: pick one item, read its bytes through expo-file-system, then hand those exact
   * bytes to the controller's contract upload. The picker is opened ONLY with the scope present;
   * without it the sheet stays open with an honest refusal and no frame is sent. A permission or
   * picker failure keeps the sheet open so the reason is readable rather than a silent no-op.
   */
  const pickAndUpload = useCallback(async (kind: 'file' | 'image') => {
    // Claim the single slot SYNCHRONOUSLY, before any picker or file read can be awaited.
    if (attachInFlight.current) return;
    attachInFlight.current = true;
    setAttachSheetOpen(false);
    if (!canAttach) {
      setAttachMessage(tr('session.attachUnavailable'));
      setAttachSheetOpen(true);
      attachInFlight.current = false;
      return;
    }
    // One identity for THIS transfer. Session change/unmount bumps the generation, sets `cancelled`
    // and clears the active slot; every post-await update below is gated by the pure identity rule.
    // Every picker asset owns an independent once-only release, including assets never read.
    const releases: Array<() => void> = [];
    const readAborts: Array<() => void> = [];
    const active = {
      generation: uploadGen.current,
      token: {} as object,
      cancelled: false,
      uploadId: null as string | null,
      releaseObjectUrl: () => { for (const release of releases) release(); },
      abortRead: () => { for (const abort of readAborts) abort(); },
    };
    activeUpload.current = active;
    const current = (): boolean => isCurrentUpload(
      { generation: uploadGen.current, token: activeUpload.current?.token ?? null },
      active,
    );
    const fail = (copy: string): void => {
      if (!current()) return;
      setAttachMessage(copy);
      setAttachSheetOpen(true);
    };
    try {
      // Spec 048: multi-pick is PWA + images ONLY. Native and the generic File picker stay single.
      const multi = kind === 'image' && Platform.OS === 'web';
      const picked = await DocumentPicker.getDocumentAsync({
        type: kind === 'image' ? 'image/*' : '*/*',
        multiple: multi,
        base64: false,
        copyToCacheDirectory: true,
      });
      if (picked.canceled || picked.assets.length === 0) {
        // No asset means no picker object URL to own. A stale cancel publishes nothing.
        if (!current()) return;
        fail(tr('session.attachNoFile'));
        return;
      }
      const assets = picked.assets as Array<(typeof picked.assets)[number]>;
      // Expo's WEB picker creates an object URL for EVERY asset. Register all releases BEFORE the
      // stale guard so a late picker result after a session switch still revokes all of them,
      // including the ones this batch will never read.
      if (Platform.OS === 'web') {
        for (const asset of assets) {
          const owner = { releaseObjectUrl: () => {} };
          registerPickedObjectUrl(owner, asset.uri, isPickerObjectUrl, revokePickerObjectUrl);
          releases.push(owner.releaseObjectUrl);
        }
      }
      if (!current()) return;
      // WHOLE-batch admission before ANY read: at most 6 images, finite nonnegative sizes, total
      // <= the client ceiling. The server's per-upload maxBytes still applies after open.
      if (multi) admitImageBatch(assets.map((asset) => ({
        size: asset.size,
        fileSize: (asset as { file?: { size?: number } }).file?.size,
      })));
      for (const asset of assets) {
        if (kind === 'image' && asset.mimeType !== undefined && !asset.mimeType.startsWith('image/')) {
          fail(tr('session.attachFailed'));
          return;
        }
      }
      for (let index = 0; index < assets.length; index += 1) {
        // One batch, sequential reads: only the CURRENT image's bytes are held in memory.
        if (!current() || active.cancelled) return;
        const asset = assets[index] as (typeof assets)[number];
        if (!multi && asset.size !== undefined) admitClientUploadSize(asset.size);
        const readOptions = Platform.OS === 'web'
          ? (() => {
              const readController = new AbortController();
              readAborts.push(() => readController.abort());
              return { signal: readController.signal, timeoutMs: WEB_PICKED_FILE_READ_TIMEOUT_MS };
            })()
          : undefined;
        const read = await readPickedFile(asset, readOptions);
        if (!current() || active.cancelled) return;
        // Metadata is untrusted on both sides; never infer MIME from a data URL or an extension.
        if (kind === 'image' && read.mediaType !== undefined && !read.mediaType.startsWith('image/')) {
          fail(tr('session.attachFailed'));
          return;
        }
        if (read.bytes.length === 0) {
          fail(tr('session.attachNoFile'));
          return;
        }
        admitClientUploadSize(read.bytes.length);
        setAttachTransfer({
          name: read.name, sent: 0, total: read.bytes.length, index: index + 1, count: assets.length,
        });
        setAttachMessage(null);
        const receipt = await controller.uploadAttachment({
          sessionId,
          kind,
          bytes: read.bytes,
          name: read.name,
          ...(kind === 'image' && read.mediaType !== undefined ? { mediaType: read.mediaType } : {}),
        }, {
          progress: (sent, total) => {
            if (current()) setAttachTransfer({
              name: read.name, sent, total, index: index + 1, count: assets.length,
            });
          },
          cancelled: () => active.cancelled,
          onUploadId: (uploadId) => { if (current()) active.uploadId = uploadId; },
        });
        if (!current()) return;
        // Publish each successful receipt immediately: a later failure/cancel keeps what already
        // succeeded, so the user can send those files or retry the rest. A session switch drops all.
        setAttachReceipts((list) => addReceipt(list, {
          sessionId, name: read.name, receiptId: receipt.receiptId,
        }));
      }
    } catch (error) {
      if (!current()) return;
      // ONLY stable codes reach copy. Never stringify the error, its message, a path/URI/data URL,
      // bytes or a Host message (spec 044 reviewer).
      const code = (error as { code?: string } | null)?.code;
      if (code === 'too-many-files') fail(tr('session.attachTooMany'));
      else if (code === 'file-too-large') fail(tr('session.attachTooLarge'));
      else if (code === 'no-file') fail(tr('session.attachNoFile'));
      else if (code === 'read-failed' || code === 'read-timeout') fail(tr('session.attachReadFailed'));
      else fail(tr('session.attachFailed'));
    } finally {
      // The PICKER's object URL is released once for EVERY path, including a stale completion that
      // may not publish UI or release a newer transfer's slot. No asset means this is a no-op.
      active.abortRead();
      active.releaseObjectUrl();
      // Cleanup is an OWNERSHIP act, not a publishing act: a user-cancelled upload still owns its
      // slot and MUST release it (otherwise Send stays locked and progress is stuck). A stale
      // transfer (old generation/token) still may not release a newer transfer's slot.
      if (ownsUpload({ generation: uploadGen.current, token: activeUpload.current?.token ?? null }, active)) {
        setAttachTransfer(null);
        attachInFlight.current = false;
        if (activeUpload.current === active) activeUpload.current = null;
      }
    }
  }, [canAttach, controller, sessionId, tr]);

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
  // Spec 041 FR-2: Send is withheld while a transfer is live, otherwise a prompt could race an
  // unfinished upload and the Host would never see the receipt it needs to resolve the attachment.
  // The existing `canSend` expression is kept verbatim: its source shape is pinned by the suite.
  const uploadInFlight = attachTransfer !== null;
  const deliveryImpossible = isDeliveryImpossible(snapshot.connection) || uploadInFlight;
  const sendReason = uploadInFlight
    ? tr('session.attachBusy')
    : ready ? null : sendUnavailableCopy(tr, snapshot.connection);
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

  // Spec 041 FR-3: the header ring reads the SAME `session-stats` reply the sheet does, through the
  // same scoped accessor. `null` is the truthful "no reading yet" state — it is never drawn as 0%.
  const [contextFill, setContextFill] = useState<number | null>(null);
  // A fire-and-forget read can resolve after a session change or unmount. The generation token is
  // the ONLY authority for applying its answer; failures restore the neutral ring, never a guess.
  const contextRingGen = useRef(0);
  const loadContextRing = useCallback(async () => {
    const generation = contextRingGen.current;
    try {
      const read = await controller.readSessionStats(sessionId);
      if (contextRingGen.current !== generation) return;
      setContextFill(read.state === 'ready' ? contextRingRatio(read.contextPressure) : null);
    } catch {
      if (contextRingGen.current === generation) setContextFill(null);
    }
  }, [controller, sessionId]);

  useEffect(() => {
    contextRingGen.current += 1;
    setContextFill(null);
    if (canReadStats && sessionId !== '') void loadContextRing();
  }, [canReadStats, sessionId, loadContextRing]);

  useEffect(() => () => { contextRingGen.current += 1; }, []);

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
      style={[styles.container, { position: 'relative', backgroundColor: colors.screenBackground }]}
      behavior={Platform.OS === 'ios' ? 'padding' : undefined}
    >
      <MeshBackdrop />
      <View
        onLayout={(event) => setHeaderMeasured(event.nativeEvent.layout.height)}
        style={[
          styles.header,
          {
            paddingTop: insets.top + space.xs,
            paddingHorizontal: space.md,
            paddingBottom: space.sm,
            borderBottomColor: colors.border,
            // Spec 048: the header still FLOATS (shadow/border/layout unchanged), but on web the
            // fill is the opaque same-scheme token so scrolled transcript text cannot bleed through
            // the title. Native keeps the original translucent paper look.
            backgroundColor: isWeb ? chrome.surface : resolveHeaderBackground(colors, false),
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
          <ChevronLeft size={24} color={chrome.text} accessibilityLabel={tr('common.back')} />
        </TouchableOpacity>

        {/* Three zones like upstream ConversationTopBar: navigation | flexible title | actions.
            The actions are flexShrink:0 so a long title/subline can never overlap a button. */}
        <View style={[styles.headerTitles, { marginHorizontal: space.sm }]}>
          <Text
            style={[type.subheading, { color: chrome.text }]}
            numberOfLines={1}
            ellipsizeMode="tail"
            accessibilityRole="header"
            testID="session-title"
          >
            {session === undefined ? tr('common.host') : sessionDisplayTitle(session, tr, locale)}
          </Text>
          <View style={[styles.subline, { gap: space.xs }]}>
            <Monitor
              size={20}
              color={chrome.textMuted}
              accessibilityLabel={snapshot.activeHost?.name ?? tr('common.host')}
            />
            <Text style={[type.captionSmall, { color: chrome.textMuted, flexShrink: 1 }]} numberOfLines={1}>
              {snapshot.activeHost?.name ?? tr('common.host')}
            </Text>
            {session === undefined ? null : (
              <>
                <Text style={[type.captionSmall, { color: chrome.textFaint }]}>·</Text>
                <SessionStatusPill state={session.state} label={statusWord(tr, session.state)} plain />
              </>
            )}
            {/* Spec 018: the agent preset this session runs — text only, never a control. The
                phone cannot choose or change a preset. Absent (older gateway or unknown preset)
                hides the label instead of showing an empty one. */}
            {agentPresetLabel === null ? null : (
              <>
                <Text style={[type.captionSmall, { color: chrome.textFaint }]}>·</Text>
                <Text
                  style={[type.captionSmall, { color: chrome.textMuted, flexShrink: 1 }]}
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
              <View style={styles.headerChip} testID="session-permission-chip">
                <PermissionChip preset={permissionChip.preset} hint={permissionChip.label} onPress={() => setPermissionSheetOpen(true)} />
              </View>
            )}
          </View>
        </View>

        <View style={styles.headerActions}>
        {/* Spec 041 FR-3: a small context-usage ring beside "more". The value comes from the
            scoped `session-stats` read; with no reading it stays a neutral track, and a tap opens
            the stats sheet (which states the honest "unavailable" reason when the scope is absent). */}
        <TouchableOpacity
          style={[
            styles.roundButton,
            { minWidth: hit, minHeight: hit, alignItems: 'center', justifyContent: 'center' },
          ]}
          accessibilityRole="button"
          accessibilityLabel={tr('session.contextUsage')}
          hitSlop={8}
          onPress={() => {
            setStatsOpen(true);
            if (canReadStats) void loadContextRing();
          }}
          testID="session-context-ring"
        >
          <Svg width={20} height={20} viewBox="0 0 20 20" accessibilityLabel={tr('session.contextUsage')}>
            <Circle cx={10} cy={10} r={8} stroke={colors.text} strokeOpacity={0.22} strokeWidth={3} fill="none" />
            {contextFill === null ? null : (
              <Circle
                cx={10}
                cy={10}
                r={8}
                stroke={colors.accent}
                strokeWidth={3}
                strokeLinecap="round"
                fill="none"
                strokeDasharray={`${(2 * Math.PI * 8) * contextFill} ${2 * Math.PI * 8}`}
                transform="rotate(-90 10 10)"
              />
            )}
          </Svg>
        </TouchableOpacity>

        {/* Spec 041 FR-1: a dedicated permission control. It stays visible without the
            `permission-lower` capability — the sheet then says why it cannot change anything. */}
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
          accessibilityLabel={tr('session.permissionPicker')}
          hitSlop={8}
          onPress={() => setPermissionSheetOpen(true)}
          testID="session-permission-picker"
        >
          <Shield size={22} color={colors.text} accessibilityLabel={tr('session.permissionPicker')} />
        </TouchableOpacity>

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
          <Ellipsis size={22} color={colors.text} accessibilityLabel={tr('session.more')} />
        </TouchableOpacity>
        </View>
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
        onContentSizeChange={(_width, height) => {
          scrollMetrics.current.contentHeight = height;
          // PREPEND BRANCH wins: an older page grew content above the reader. Restore the same visual
          // anchor and NEVER complete an opening jump here (no scrollToEnd, no done mark).
          const prepend = prependRestore.current;
          if (prepend !== null) {
            prependRestore.current = null;
            scrollRef.current?.scrollTo({
              y: prependViewportOffset(prepend.offsetY, prepend.oldHeight, height),
              animated: false,
            });
            return;
          }
          // TRANSCRIPT LAYOUT BRANCH: only a pending jump scheduled by the history effect may land,
          // and only with the current generation and a real (>0) height. A spinner/old height before
          // scheduling cannot land the jump (there is no pending event to complete it).
          const pending = initialScroll.current.pending;
          if (pending === null) return;
          dispatchInitialScroll({
            kind: 'layout', sessionId: pending.sessionId, generation: pending.generation, height,
          });
        }}
        onScroll={(event) => {
          const { contentOffset, contentSize, layoutMeasurement } = event.nativeEvent;
          scrollMetrics.current = { offsetY: contentOffset.y, contentHeight: contentSize.height };
          setAwayFromBottom(
            isAwayFromBottom({
              offsetY: contentOffset.y,
              contentHeight: contentSize.height,
              viewportHeight: layoutMeasurement.height,
            }),
          );
          // Lazy load: reaching the top asks for the PREVIOUS page, if one exists. One request per
          // gesture; the controller's lock and this ref both stop a scroll burst from queueing more.
          if (contentOffset.y <= OLDER_HISTORY_TOP_PX
            && snapshot.historyHasEarlier
            && !snapshot.historyLoading
            && !olderAutoRequest.current) {
            olderAutoRequest.current = true;
            prependRestore.current = { offsetY: contentOffset.y, oldHeight: contentSize.height };
            void controller.loadOlderHistory().finally(() => { olderAutoRequest.current = false; });
          }
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
            onPress={() => {
              prependRestore.current = {
                offsetY: scrollMetrics.current.offsetY,
                oldHeight: scrollMetrics.current.contentHeight,
              };
              void controller.loadOlderHistory();
            }}
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

        {snapshot.openQuestions.map((card) => (
          <QuestionCardView
            key={`${card.sessionId}:${card.rpcId}`}
            card={card}
            tr={tr}
            onSubmit={(answers) => void controller.decideQuestion(card.rpcId, answers)}
            onSkip={() => void controller.decideQuestion(card.rpcId, [], true)}
          />
        ))}

        {snapshot.history.length === 0 ? (
          <View style={[styles.centerArea, { padding: space.xxxl }]}>
            {shouldShowNoMessage({
              connectionReady: snapshot.connection === 'ready',
              historyLoaded: snapshot.historyLoaded,
              historyLoading: snapshot.historyLoading,
              historyHasMore: snapshot.historyHasMore,
              historyHasEarlier: snapshot.historyHasEarlier,
            }) ? (
              <Text style={[type.bodySmall, { color: colors.textMuted }]}>{tr('session.empty')}</Text>
            ) : (
              // A first page may be EMPTY while older pages still exist (`view:'conversation'` crops
              // chatter). Showing “No message yet” there was the PWA defect: the transcript was not
              // empty, it just had not been paged yet.
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
        {phaseLabel === null ? null : (
          <View
            accessible
            accessibilityRole="text"
            accessibilityLabel={phaseLabel}
            pointerEvents="none"
            testID="session-progress-indicator"
            style={{
              alignSelf: 'flex-start',
              flexDirection: 'row',
              alignItems: 'center',
              gap: space.xs,
              // Spec 050: fixed web chrome pair stays readable over the dark header/composer.
              backgroundColor: isWeb ? chrome.surface : colors.surface,
              borderColor: isWeb ? chrome.border : colors.border,
              borderWidth: StyleSheet.hairlineWidth,
              borderRadius: radius.pill,
              marginHorizontal: space.xs,
              marginBottom: space.xxs,
              paddingHorizontal: space.sm,
              paddingVertical: space.xxs,
            }}
          >
            {/* Only this dot breathes; the label stays steady so the elapsed seconds never flicker. */}
            <Animated.View style={{
              width: 6,
              height: 6,
              borderRadius: radius.circle,
              backgroundColor: colors.accent,
              opacity: phase === 'processing' && !reduceMotion ? pulse : 1,
            }} />
            <Text style={[type.captionSmall, { color: isWeb ? chrome.textMuted : colors.textMuted }]}>{phaseLabel}</Text>
          </View>
        )}
        <GlassSurface
          style={[
            styles.composer,
            {
              borderRadius: radius.xxl,
              backgroundColor: composer.surface,
              borderColor: composer.border,
              paddingHorizontal: space.md,
              paddingVertical: space.sm,
              gap: space.sm,
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
                <Text style={[type.captionSmall, { color: isWeb ? chrome.text : colors.accent, flex: 1 }]} numberOfLines={1}>
                  {tr('session.reply')}
                </Text>
                <TouchableOpacity
                  accessibilityRole="button"
                  accessibilityLabel={tr('common.cancel')}
                  hitSlop={8}
                  onPress={() => setReplyTo(null)}
                  testID="session-reply-cancel"
                  style={{ minWidth: hit, minHeight: hit, alignItems: 'center', justifyContent: 'center' }}
                >
                  <X size={20} color={chrome.textMuted} accessibilityLabel={tr('common.cancel')} />
                </TouchableOpacity>
              </View>
              <Text style={[type.captionSmall, { color: chrome.textMuted }]} numberOfLines={2}>
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
                color: composer.text,
                maxHeight: COMPOSER_MAX_LINES * (type.body.lineHeight ?? 22) + space.md,
                paddingVertical: space.xs,
              },
            ]}
            testID="session-composer"
            value={text}
            onChangeText={setText}
            placeholder={tr('session.composerPlaceholder')}
            placeholderTextColor={composer.textMuted}
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
              <Text style={[type.captionSmall, { color: chrome.textMuted, flexShrink: 1 }]} numberOfLines={1}>
                {tr('authoring.modelSubagent')}
              </Text>
            ) : (
              <ComposerModelRow
                currentModel={snapshot.currentModel}
                hasCatalog={snapshot.models.length > 0}
                onOpenModel={() => setModelPickerOpen(true)}
                hint={tr('authoring.model')}
                palette={isWeb ? chrome : undefined}
              />
            )}
            <View style={{ flex: 1 }} />
            {/* Spec 041 FR-2: the attach control is always visible; a missing `attachments:write`
                grant is explained by the sheet instead of hiding the button. */}
            <TouchableOpacity
              style={[
                styles.sendRound,
                {
                  backgroundColor: colors.surface,
                  borderColor: colors.border,
                  borderWidth: StyleSheet.hairlineWidth,
                  minWidth: hit,
                  minHeight: hit,
                  width: hit,
                  height: hit,
                  borderRadius: radius.circle,
                },
              ]}
              accessibilityRole="button"
              accessibilityLabel={tr('session.attach')}
              accessibilityState={{ disabled: uploadInFlight }}
              disabled={uploadInFlight}
              hitSlop={8}
              onPress={() => {
                // No scope ⇒ the sheet opens with the honest refusal, never a blank or dead sheet.
                setAttachMessage(canAttach ? null : tr('session.attachUnavailable'));
                setAttachSheetOpen(true);
              }}
              testID="session-attach"
            >
              <Plus size={22} color={colors.text} accessibilityLabel={tr('session.attach')} />
            </TouchableOpacity>
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
                <ArrowUp
                  size={22}
                  color={canSend ? colors.onAccent : colors.disabledLabel}
                  accessibilityLabel={tr('session.send')}
                />
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
          {/* One transfer at a time: progress and cancel live in the composer, not in the prompt. */}
          {attachTransfer === null ? null : (
            <View style={{ flexDirection: 'row', alignItems: 'center', gap: space.xs }} testID="session-attach-progress">
              <Text style={[type.captionSmall, { color: colors.textMuted, flexShrink: 1 }]} numberOfLines={1}>
                {tr('session.attachProgress', {
                  name: attachTransfer.name,
                  percent: attachTransfer.total === 0 ? 0 : Math.round((attachTransfer.sent / attachTransfer.total) * 100),
                })}
              </Text>
              <TouchableOpacity
                accessibilityRole="button"
                accessibilityLabel={tr('session.attachCancel')}
                hitSlop={8}
                onPress={() => {
                  const active = activeUpload.current;
                  if (active === null) return;
                  active.cancelled = true;
                  if (active.uploadId !== null) void controller.cancelRemoteUpload(active.uploadId).catch(() => {});
                }}
                testID="session-attach-cancel"
                style={{ minWidth: hit, minHeight: hit, alignItems: 'center', justifyContent: 'center' }}
              >
                <X size={20} color={colors.danger} accessibilityLabel={tr('session.attachCancel')} />
              </TouchableOpacity>
            </View>
          )}
          {/* Host receipts, not bytes: every receipt of THIS session names one pending attachment. */}
          {receiptsForSession(attachReceipts, sessionId).length === 0 ? null : (
            <View
              style={{
                backgroundColor: colors.surface,
                borderColor: colors.border,
                borderWidth: StyleSheet.hairlineWidth,
                borderRadius: radius.pill,
                paddingHorizontal: space.sm,
                paddingVertical: space.xxs,
              }}
              testID="session-attach-receipt"
            >
              {receiptsForSession(attachReceipts, sessionId).map((receipt) => (
                <View key={receipt.receiptId}>
                  <Text style={[type.captionSmall, { color: colors.text }]} numberOfLines={1}>
                    {tr('session.attachReceipt', { name: receipt.name })}
                  </Text>
                  <Text style={[type.captionSmall, { color: colors.textFaint }]} numberOfLines={1}>
                    {receipt.receiptId}
                  </Text>
                </View>
              ))}
            </View>
          )}
        </GlassSurface>
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
                // Below the header it drops from: the measured height once the header has laid out,
                // the same `headerHeight` the transcript and the panel use before that first frame.
                marginTop: (headerMeasured > 0 ? headerMeasured : headerHeight) + space.xs,
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
              <X size={22} color={colors.textMuted} accessibilityLabel={tr('common.cancel')} />
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
              <X size={22} color={colors.textMuted} accessibilityLabel={tr('common.cancel')} />
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
              <X size={22} color={colors.textMuted} accessibilityLabel={tr('common.cancel')} />
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
              // Spec 041 FR-1: without the capability the sheet must say THAT, not just
              // "not right now" — the button stays visible either way.
              unavailable: tr(canLowerPermission(snapshot.capabilities) ? 'session.permissionUnavailable' : 'session.permissionDisabled'),
              failed: tr('session.permissionLoadFailed'),
            }}
            onRetry={() => void loadPermissionOptions()}
            onChoose={confirmPermissionLower}
          />
        </View>
      </Modal>
      {/* Spec 041 FR-2: the attach action sheet. With no scope it shows only the refusal sentence —
          there are no dead Image/File rows that would promise an upload the gateway would refuse.
          Placement: a bottom sheet like the other sheets, NOT a native popover under the Dynamic
          Island — the top-anchored menu clipped its heading and overlapped the status bar. */}
      <Modal visible={attachSheetOpen} transparent animationType="slide" onRequestClose={() => setAttachSheetOpen(false)}>
        <Pressable
          style={[styles.scrim, { backgroundColor: colors.overlay, justifyContent: 'flex-end', alignItems: 'stretch' }]}
          onPress={() => setAttachSheetOpen(false)}
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
                marginHorizontal: space.lg,
                marginBottom: insets.bottom + space.lg,
                ...elevation(colors, 'sheet'),
              },
            ]}
            testID="session-attach-sheet"
          >
            <View style={{ flexDirection: 'row', alignItems: 'center', paddingHorizontal: space.lg, paddingVertical: space.sm }}>
              <Text style={[type.subheading, { color: colors.text, flex: 1 }]}>{tr('session.attachTitle')}</Text>
              <TouchableOpacity
                accessibilityRole="button"
                accessibilityLabel={tr('common.cancel')}
                onPress={() => setAttachSheetOpen(false)}
                testID="session-attach-close"
                style={{ minWidth: hit, minHeight: hit, alignItems: 'center', justifyContent: 'center' }}
              >
                <X size={22} color={colors.textMuted} accessibilityLabel={tr('common.cancel')} />
              </TouchableOpacity>
            </View>
            {attachMessage === null && canAttach ? null : (
              <Text
                style={[type.bodySmall, { color: colors.textMuted, paddingHorizontal: space.lg, paddingBottom: space.sm }]}
                testID="session-attach-message"
              >
                {attachMessage ?? tr('session.attachUnavailable')}
              </Text>
            )}
            {canAttach && attachMessage === null ? (
              <>
                <TouchableOpacity
                  style={[styles.menuItem, { minHeight: hit, paddingHorizontal: space.lg }]}
                  accessibilityRole="button"
                  accessibilityLabel={tr('session.attachImage')}
                  onPress={() => void pickAndUpload('image')}
                  testID="session-attach-image"
                >
                  <Text style={[type.body, { color: colors.text }]}>{tr('session.attachImage')}</Text>
                </TouchableOpacity>
                <TouchableOpacity
                  style={[styles.menuItem, { minHeight: hit, paddingHorizontal: space.lg }]}
                  accessibilityRole="button"
                  accessibilityLabel={tr('session.attachFile')}
                  onPress={() => void pickAndUpload('file')}
                  testID="session-attach-file"
                >
                  <Text style={[type.body, { color: colors.text }]}>{tr('session.attachFile')}</Text>
                </TouchableOpacity>
              </>
            ) : null}
          </View>
        </Pressable>
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

function QuestionCardView(props: {
  card: QuestionCardView;
  tr: Interpolate;
  onSubmit: (answers: QuestionAnswer[]) => void;
  onSkip: () => void;
}) {
  const { card, tr, onSubmit, onSkip } = props;
  const { colors, type, space, radius } = useTheme();
  const [selected, setSelected] = useState<Record<string, string[]>>({});
  const [custom, setCustom] = useState('');
  const busy = card.status === 'answering';
  const decidable = card.status === 'pending';
  const questions = card.questions;
  const toggle = (id: string, label: string, multi: boolean) => {
    setSelected((before) => {
      const current = before[id] ?? [];
      const next = current.includes(label) ? current.filter((item) => item !== label)
        : (multi ? [...current, label] : [label]);
      return { ...before, [id]: next };
    });
  };
  const submit = () => {
    const answers: QuestionAnswer[] = questions.map((question) => {
      const id = String(question.id ?? '');
      const labels = selected[id] ?? [];
      return { id, selected: labels, ...(custom.trim() === '' ? {} : { custom: custom.trim() }) };
    });
    onSubmit(answers);
  };
  return (
    <View
      style={[
        styles.card,
        {
          backgroundColor: colors.surfaceRaised,
          borderColor: colors.accent,
          borderWidth: StyleSheet.hairlineWidth,
          borderRadius: radius.lg,
          padding: space.lg,
          gap: space.sm,
          ...elevation(colors, 'card'),
        },
      ]}
      testID={`question-card-${card.rpcId}`}
    >
      <Text style={[type.subheading, { color: colors.text }]}>{tr('question.title')}</Text>
      {questions.map((question) => {
        const id = String(question.id ?? '');
        const header = typeof question.header === 'string' ? question.header : id;
        const options = Array.isArray(question.options) ? question.options : [];
        const multi = question.multiSelect === true;
        return (
          <View key={id} style={{ gap: space.xs }}>
            <Text style={[type.bodySmall, { color: colors.text }]}>{tr('question.header', { header })}</Text>
            {options.map((option, optionIndex) => {
              const label = typeof (option as Record<string, unknown>)?.label === 'string'
                ? String((option as Record<string, unknown>).label) : '';
              if (label === '') return null;
              const on = (selected[id] ?? []).includes(label);
              return (
                <TouchableOpacity
                  key={label}
                  style={[styles.decision, { borderRadius: radius.sm, minHeight: 44, paddingHorizontal: space.md,
                    backgroundColor: on ? colors.accent : colors.surface, borderWidth: StyleSheet.hairlineWidth, borderColor: colors.border }]}
                  disabled={!decidable || busy}
                  onPress={() => toggle(id, label, multi)}
                  accessibilityRole="checkbox"
                  accessibilityState={{ checked: on, disabled: !decidable || busy }}
                  accessibilityLabel={label}
                  testID={`question-option-${card.rpcId}-${optionIndex}`}
                >
                  <Text style={[type.caption, { color: on ? colors.onAccent : colors.text }]}>{label}</Text>
                </TouchableOpacity>
              );
            })}
          </View>
        );
      })}
      <TextInput
        style={[type.bodySmall, { color: colors.text, borderColor: colors.border, borderWidth: StyleSheet.hairlineWidth,
          borderRadius: radius.sm, paddingHorizontal: space.sm, minHeight: 44 }]}
        value={custom}
        onChangeText={setCustom}
        placeholder={tr('question.custom')}
        editable={decidable && !busy}
        accessibilityLabel={tr('question.custom')}
        testID={`question-custom-${card.rpcId}`}
      />
      {card.notice !== undefined ? (
        <Text style={[type.caption, { color: colors.danger }]} testID={`question-notice-${card.rpcId}`}>{card.notice}</Text>
      ) : null}
      {card.status === 'settled' ? (
        <Text style={[type.caption, { color: colors.success }]}>{tr('question.sent')}</Text>
      ) : null}
      {card.status === 'already-decided' ? (
        <Text style={[type.caption, { color: colors.textMuted }]}>{tr('question.resolved')}</Text>
      ) : null}
      {decidable ? (
        <View style={{ flexDirection: 'row', gap: space.sm }}>
          <TouchableOpacity
            style={[styles.decision, { backgroundColor: colors.accent, borderRadius: radius.md, minHeight: 48, paddingHorizontal: space.lg }]}
            disabled={busy}
            onPress={submit}
            accessibilityRole="button"
            accessibilityLabel={tr('question.submit')}
            testID={`question-submit-${card.rpcId}`}
          >
            <Text style={[type.button, { color: colors.onAccent }]}>{tr('question.submit')}</Text>
          </TouchableOpacity>
          <TouchableOpacity
            style={[styles.decision, { backgroundColor: colors.surface, borderColor: colors.danger, borderWidth: StyleSheet.hairlineWidth,
              borderRadius: radius.md, minHeight: 48, paddingHorizontal: space.lg }]}
            disabled={busy}
            onPress={onSkip}
            accessibilityRole="button"
            accessibilityLabel={tr('question.skip')}
            testID={`question-skip-${card.rpcId}`}
          >
            <Text style={[type.button, { color: colors.danger }]}>{tr('question.skip')}</Text>
          </TouchableOpacity>
        </View>
      ) : null}
    </View>
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
      <View style={{ flexDirection: 'row', alignItems: 'center', gap: space.sm }}>
        <ShieldCheck size={22} color={colors.accent} accessibilityLabel={tr('approval.title', { tool: card.toolName })} />
        <Text style={[type.subheading, { color: colors.text, flexShrink: 1 }]}>
          {tr('approval.title', { tool: card.toolName })}
        </Text>
      </View>
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
            <Check size={20} color={colors.onAccent} accessibilityLabel={tr('approval.approve')} />
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
            <X size={20} color={colors.danger} accessibilityLabel={tr('approval.reject')} />
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
          <RotateCcw size={20} color={colors.accent} accessibilityLabel={tr('approval.reviewAgain')} />
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
  banner: 'reconnecting' | 'offline' | 'gateway-off' | 'revoked' | 'reauth' | 'cleanup-failed' | 'connect-failed',
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
    case 'connect-failed':
      return tr('banner.connectFailed');
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
  headerTitles: { flex: 1, minWidth: 0 },
  headerActions: { flexDirection: 'row', alignItems: 'center', flexShrink: 0 },
  headerChip: { maxWidth: 132, flexShrink: 1, overflow: 'hidden' },
  subline: { flexDirection: 'row', alignItems: 'center', minWidth: 0 },
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
