// Public surface of the pure-TS core. Everything here runs unchanged in Node (tests) and in
// the app bundle; nothing may import react-native, expo or Node built-ins
// (`npm run check:core` enforces that).

export * from './protocol';
export * from './errors';
export { parsePairingQr, parsePairingQrOrThrow, qrExpiresInMs, encodePairingPayload, decodeBase64Url, encodeBase64Url, PAIRING_TTL_MS } from './qr';
export type { QrParseResult, QrRejectReason, ParseQrOptions } from './qr';
export * from './transport';
export {
  CompanionClient,
  classifyProtocolUnsupported,
  classifyUpgradeRefusal,
  defaultRequestId,
  DEFAULT_HANDSHAKE_TIMEOUT_MS,
  DEFAULT_PAIR_APPROVAL_TIMEOUT_MS,
  DEFAULT_REQUEST_TIMEOUT_MS,
  NO_AUTO_RECONNECT_CLOSE_CODES,
} from './client';
export type {
  ClientEventMap,
  ClientOptions,
  ClientState,
  ClientTransportSource,
  ConnectOptions,
  ConnectionTarget,
  UpdateRequired,
} from './client';
export { SessionsStore, MAX_SESSIONS, MAX_SESSION_AGE_MS, toEpochMs } from './sessions';
export type { SessionSummary, SessionState, SessionSnapshot, SessionTab } from './sessions';
export {
  ApprovalCard,
  ApprovalCards,
  TERMINAL_STATUSES,
  approvalSourceFromFrame,
} from './approvals';
export type {
  ApprovalCardState,
  ApprovalCardStatus,
  ApprovalDecision,
  ApprovalReceiptOutcome,
  ApprovalResponder,
  ApprovalSource,
} from './approvals';
export { Outbox, defaultClientMsgId } from './outbox';
export type { CancelItem, OutboxDeps, OutboxFrame, OutboxItem, OutboxStatus, PromptItem } from './outbox';
export { HistoryStore, coerceHistoryMessage, coerceHistoryEvent, coerceHistoryEvents, isHostInjectedUserText, SKIPPED_HISTORY_EVENT_TYPES } from './history';
export type { HistoryMessage, HistoryPage, MessageRole } from './history';
export { Reconnector, backoffDelayMs, planResync, realClock, BACKOFF_DELAYS_MS, MAX_BACKOFF_MS, RESTART_DELAY_MS } from './reconnect';
export type { ReconnectClock, ReconnectSnapshot, ReconnectState, ResyncInput } from './reconnect';
export { redactArgsPreview, redactDiagnostic, redactFingerprint, redactString, redactValue, REDACTED } from './redact';
export type { RedactOptions } from './redact';
export { PAIRED_HOST_SCHEMA_VERSION, pairedHostFromPayload, isReconnectable, describeHost } from './host';
export type { PairedHost } from './host';
// Contract revision 5 (§3.8): the OTP first-pairing flow — code normalization and the two derived
// values the Host checks (`otpProof`, `verificationCode`). The SHA-256/HMAC primitives they need
// live in `./hmac` (expo-crypto has no HMAC, and `src/core` may not import it anyway).
export { OTP_DIGITS, OTP_SUBPROTOCOL, normalizeOtp, otpProof, verificationCode } from './pairing-otp';
export type { OtpRejectReason } from './pairing-otp';
export { parseSessionDeepLink, sessionDeepLink } from './deeplink';
export type { SessionDeepLink } from './deeplink';
export { GATEWAY_WS_PATH, sameOriginGatewayUrl, withSameOriginEndpoint } from './gateway-address';
export type { WebLocation } from './gateway-address';
export { DebugLog } from './debug-log';
export type { LogLine, LogSink } from './debug-log';
export { lowerPermission, readPermissionOptions, reasonMessage, toLowerOutcome, toOptionsView } from './permission-lower';
export type {
  PermissionLowerMessage,
  PermissionLowerOutcome,
  PermissionOptionsResult,
  PermissionOptionsView,
} from './permission-lower';
// Spec 018: the read-only session metrics (`session-stats`, scope `stats:read`).
export {
  readSessionStats,
  toStatsRead,
  parseSessionStats,
  parseTokenUsage,
  parseContextPressure,
  hasStatsReadScope,
  STATS_READ_CLIENT_TYPES,
  STATS_READ_SCOPE,
} from './stats';
export type {
  ContextPressure,
  SessionStats,
  SessionStatsRead,
  SessionStatsType,
  TokenTotals,
  TokenUsage,
} from './stats';
// Spec 018 item 3: the read-only schedule frames (`schedule:read`) — never a mutation.
export {
  SCHEDULE_PAGE_LIMIT,
  SCHEDULE_READ_CLIENT_TYPES,
  SCHEDULE_READ_SCOPE,
  hasScheduleReadScope,
  parseScheduledTask,
  readScheduleCatalog,
  readScheduleList,
  readScheduleView,
  toCatalog,
  toScheduleList,
  toScheduleView,
} from './schedules';
export type {
  ScheduleCatalog,
  ScheduleCatalogEntry,
  ScheduleList,
  ScheduleReadType,
  ScheduleViewResult,
  ScheduledTask,
} from './schedules';
// Spec 018 item 5: the session's read-only task list and goal (`projection-baseline` +
// `tasks-updated` / `goal-updated`) — decode only, never a write.
export {
  EMPTY_SESSION_PANEL,
  TODO_STATUSES,
  panelFromBaseline,
  panelFromUpdate,
  parseGoal,
  parseProjectionBaseline,
  parseTodo,
  parseTodos,
  projectionUpdateKind,
} from './projections';
export type { GoalView, SessionPanel, TodoListItem, TodoStatus, TodoStatusView } from './projections';
