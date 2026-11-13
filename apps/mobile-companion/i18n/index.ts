// i18n (A024): a tiny typed dictionary, no external library. Vietnamese is the default; the
// English table must cover exactly the same keys (type-checked through `Messages`).

import type { ClientErrorCode, ContractErrorCode, QrRejectReason } from '../src/core';

export type Locale = 'vi' | 'en';

export const LOCALES: readonly Locale[] = ['vi', 'en'];
export const DEFAULT_LOCALE: Locale = 'vi';

export type MessageKey =
  // unlock gate
  | 'unlock.title'
  | 'unlock.subtitle'
  | 'unlock.prompt'
  | 'unlock.button'
  | 'unlock.cancelled'
  | 'unlock.failed'
  | 'unlock.lockedOut'
  | 'unlock.unavailable'
  | 'unlock.passcodeOnly'
  // Spec 021 — web passkey unlock (the reasons in `src/core/web-lock.ts#LOCK_COPY`).
  | 'unlock.passkeyLocked'
  | 'unlock.passkeyRegister'
  | 'unlock.passkeyRateLimited'
  | 'unlock.passkeyExpired'
  | 'unlock.passkeyFailed'
  | 'unlock.passkeyNotRegistered'
  | 'unlock.passkeyApproval'
  | 'unlock.passkeyUnsupported'
  | 'unlock.passkeyHostVersion'
  // Spec 021 — the web bootstrap's cold start (a failure blocks pairing until it is retried).
  | 'startup.failed'
  | 'startup.retry'
  | 'startup.starting'
  // tabs / sessions
  | 'tabs.running'
  | 'tabs.idle'
  | 'tabs.archived'
  // Bottom tab bar + workspace home + conversations + settings (spec 011 P1-A port).
  | 'tabs.workspace'
  | 'tabs.conversations'
  | 'tabs.settings'
  | 'list.title'
  | 'list.all'
  | 'list.more'
  | 'list.groupBy'
  | 'list.groupDate'
  | 'list.groupStatus'
  | 'list.date.any'
  | 'list.date.today'
  | 'list.date.week'
  | 'list.date.older'
  | 'list.status.any'
  | 'list.status.running'
  | 'list.status.idle'
  | 'list.status.decision'
  | 'list.filterArchived'
  | 'list.filterOnline'
  | 'list.search'
  | 'list.searchPlaceholder'
  | 'list.noMatches'
  | 'list.other'
  | 'list.ungrouped'
  | 'list.composerPlaceholder'
  | 'home.hero'
  | 'home.heroSubtitle'
  | 'home.recent'
  | 'home.seeAll'
  | 'home.emptyTitle'
  | 'home.emptyBody'
  | 'conversations.title'
  | 'settings.title'
  | 'settings.computer'
  | 'settings.paired'
  | 'settings.pairAnother'
  // Spec 021 (web only): send `passkey-lock` and show the lock screen again.
  | 'settings.lockNow'
  | 'settings.fontSize'
  | 'settings.fontSizeHint'
  // Session authoring: workspace picker, new session, model/mode row (spec 011 revision 7).
  | 'authoring.connecting'
  | 'authoring.reconnecting'
  | 'home.loadingSessions'
  | 'authoring.scopeUnknown'
  | 'authoring.modelSubagent'
  | 'home.showSubagents'
  | 'home.hideSubagents'
  | 'authoring.modelsUnavailable'
  | 'authoring.createFailed'
  | 'authoring.needScope'
  | 'authoring.needWorkspace'
  | 'authoring.loadingWorkspaces'
  | 'authoring.workspacesError'
  | 'authoring.workspacesEmpty'
  | 'authoring.workspaceTitle'
  | 'authoring.workspacePlaceholder'
  | 'authoring.retry'
  | 'authoring.close'
  | 'authoring.newSession'
  | 'authoring.mode'
  | 'authoring.model'
  | 'sessions.search'
  | 'sessions.empty'
  | 'sessions.emptySearch'
  | 'sessions.needsDecision'
  | 'sessions.updatedAgo'
  | 'sessions.hiddenOlder'
  | 'sessions.pair'
  | 'sessions.forget'
  | 'sessions.forgetConfirm'
  | 'sessions.settings'
  | 'sessions.refresh'
  // pairing
  | 'pair.title'
  | 'pair.scan'
  | 'pair.cameraPermission'
  | 'pair.cameraPermissionButton'
  | 'pair.manual'
  | 'pair.manualPlaceholder'
  | 'pair.webAddress'
  | 'pair.submit'
  | 'pair.connecting'
  | 'pair.waitingApproval'
  | 'pair.success'
  // Contract revision 5 — the one-time-code flow ("Generate pairing code" on the Host).
  | 'pair.modeCode'
  | 'pair.modeOtp'
  | 'pair.otpAddress'
  | 'pair.otpAddressPlaceholder'
  | 'pair.otpCode'
  | 'pair.otpPlaceholder'
  | 'pair.errorTitle'
  | 'pair.error.remoteDisabled'
  | 'pair.error.expired'
  | 'pair.error.rejected'
  | 'pair.error.timeout'
  | 'pair.error.otpUnsupported'
  | 'pair.error.otpRequired'
  | 'pair.error.otpBadLength'
  | 'pair.error.badAddress'
  | 'pair.error.pinMismatch'
  // An 8-digit code cannot carry the computer's certificate, and a phone cannot pin an unpinned
  // socket — so the code flow is refused here, before any connection, with the alternative.
  | 'pair.error.otpNative'
  // The Host's own identity could not be trusted: it stated none, or it claimed another known one.
  | 'pair.error.noHostId'
  | 'pair.error.hostConflict'
  // The stored host list had not loaded yet, so the identity check could not run at all.
  | 'pair.error.notReady'
  | 'pair.error.unavailable'
  | 'pair.error.appUpdate'
  | 'pair.error.hostUpdate'
  | 'pair.error.generic'
  // session screen
  | 'session.loading'
  | 'session.untitled'
  | 'session.untitledAgo'
  | 'session.empty'
  | 'session.composerPlaceholder'
  | 'session.mic'
  | 'session.micHint'
  | 'team.title'
  | 'team.members'
  | 'team.tasks'
  | 'team.blocked'
  | 'team.subagents'
  | 'team.unavailable'
  | 'team.migrationRequired'
  | 'team.retry'
  | 'team.errorNotFound'
  | 'team.errorAuth'
  | 'team.errorGeneric'
  // Spec 018: session metrics (`stats:read`) — labels over the Host's own numbers.
  | 'stats.title'
  | 'stats.tokens'
  | 'stats.context'
  | 'stats.turns'
  | 'stats.steps'
  | 'stats.input'
  | 'stats.output'
  | 'stats.cacheRead'
  | 'stats.cacheWrite'
  | 'stats.reasoning'
  | 'stats.contextWindow'
  | 'stats.contextUsed'
  | 'stats.unavailable'
  | 'stats.noData'
  | 'stats.errorAuth'
  | 'stats.errorGeneric'
  // Spec 018 item 3: read-only scheduled tasks (`schedule:read`).
  | 'schedules.title'
  | 'schedules.open'
  | 'schedules.refresh'
  | 'schedules.unavailable'
  | 'schedules.notNow'
  | 'schedules.empty'
  | 'schedules.emptyActive'
  | 'schedules.status.active'
  | 'schedules.status.paused'
  | 'schedules.status.ended'
  | 'schedules.status.unknown'
  | 'schedules.nextRun'
  | 'schedules.none'
  | 'schedules.detailTitle'
  | 'schedules.readOnly'
  | 'schedules.field.rule'
  | 'schedules.field.status'
  | 'schedules.field.nextRun'
  | 'schedules.field.time'
  | 'schedules.field.timeZone'
  | 'schedules.field.weekdays'
  | 'schedules.field.everySeconds'
  | 'schedules.field.expression'
  | 'schedules.field.target'
  | 'schedules.notFound'
  | 'schedules.errorAuth'
  | 'schedules.errorGeneric'
  | 'common.loading'
  | 'sessionActions.rename'
  | 'sessionActions.archive'
  | 'sessionActions.renameTitle'
  | 'sessionActions.renameEmpty'
  | 'sessionActions.renameTooLong'
  | 'sessionActions.save'
  | 'sessionActions.archiveConfirm'
  | 'sessionActions.archiveConfirmBody'
  | 'sessionActions.errorNotFound'
  | 'sessionActions.errorAuth'
  | 'sessionActions.errorGeneric'
  | 'session.send'
  | 'session.cancel'
  | 'session.cancelConfirmTitle'
  | 'session.cancelConfirmBody'
  | 'session.cancelConfirm'
  | 'session.cancelled'
  | 'session.historyFailed'
  | 'session.historyOlder'
  | 'session.pendingUnconfirmed'
  | 'session.pending'
  | 'session.failed'
  | 'session.retry'
  | 'session.linkOpenTitle'
  | 'session.linkOpenBody'
  | 'session.linkOpen'
  | 'session.role.tool'
  | 'session.role.system'
  | 'session.role.other'
  | 'session.share'
  | 'session.expandTable'
  | 'session.reply'
  | 'session.scrollBottom'
  | 'session.toolsCollapsed'
  | 'session.chooseModel'
  | 'session.more'
  | 'session.sendOffline'
  | 'session.sendNotReady'
  // Spec 019 — permission chip + lower-only sheet. Every refusal sentence is fixed here; the
  // Host's own `message` is internal text and is never rendered.
  | 'session.permissionChip'
  | 'session.permissionTitle'
  | 'session.permissionCurrent'
  | 'session.permissionEmpty'
  | 'session.permissionUnavailable'
  | 'session.permissionLoadFailed'
  | 'session.permissionConfirmTitle'
  | 'session.permissionConfirmBody'
  | 'session.permissionConfirm'
  | 'session.permissionApplied'
  | 'session.permissionPair'
  | 'session.permissionNotStricter'
  | 'session.permissionCustomCurrent'
  | 'session.permissionRaced'
  | 'session.permissionError'
  // Spec 018 — the session's agent preset, view only (the phone never sets it).
  | 'session.agentPreset'
  // Spec 018 item 5 — read-only goal line and task checklist (the Host's `goal` / `todos`).
  | 'session.goal'
  | 'session.goalPhase'
  | 'session.tasksTitle'
  | 'session.tasksDone'
  | 'session.tasksMore'
  | 'session.taskStatus.pending'
  | 'session.taskStatus.in-progress'
  | 'session.taskStatus.completed'
  | 'session.taskStatus.unknown'
  // approvals
  | 'approval.title'
  | 'approval.approve'
  | 'approval.reject'
  | 'approval.decideOnComputer'
  | 'approval.changed'
  | 'approval.reviewAgain'
  | 'approval.alreadyDecided'
  | 'approval.retry'
  | 'approval.approved'
  | 'approval.rejected'
  | 'approval.cancelledElsewhere'
  | 'approval.unavailableElsewhere'
  // banners / notifications
  | 'banner.reconnecting'
  | 'banner.offline'
  | 'banner.gatewayOff'
  | 'banner.revoked'
  | 'banner.reauth'
  | 'banner.cleanupFailed'
  | 'banner.pinnedTransportMissing'
  // protocol update (N7)
  | 'update.appTitle'
  | 'update.appBody'
  | 'update.hostTitle'
  | 'update.hostBody'
  | 'update.details'
  | 'update.retry'
  | 'update.pairAnother'
  | 'notice.notification.title'
  | 'notice.notification.body'
  // common
  | 'common.ok'
  | 'common.cancel'
  | 'common.back'
  | 'common.host'
  | 'authoring.workspaceGone'
  | 'session.reasoning'
  | 'storage.title'
  | 'storage.total'
  | 'storage.clear'
  | 'storage.clearAll'
  | 'storage.clearAllConfirm'
  | 'storage.empty'
  | 'storage.cleared'
  | 'storage.hint'
  | 'storage.category.logs'
  | 'storage.category.images'
  | 'storage.category.documents'
  | 'storage.category.other'
  | 'privacy.title'
  | 'privacy.updated'
  | 'privacy.p1'
  | 'privacy.p2'
  | 'privacy.p3'
  | 'privacy.p4'
  | 'privacy.p5'
  | 'privacy.p6';

type MessageFunction = (params: Record<string, string | number>) => string;
export type Messages = Record<MessageKey, string | MessageFunction>;

const PLACEHOLDER_RE = /\{(\w+)\}/g;

function format(template: string, params: Record<string, string | number> | undefined): string {
  if (params === undefined) return template;
  return template.replace(PLACEHOLDER_RE, (match, key: string) => {
    const value = params[key];
    return value === undefined ? match : String(value);
  });
}

export type Interpolate = (key: MessageKey, params?: Record<string, string | number>) => string;

// ---------------------------------------------------------------------------
// English
// ---------------------------------------------------------------------------

const en = {
  'unlock.title': 'DSH Companion',
  'unlock.subtitle': 'Unlock to reach your paired computer.',
  'unlock.prompt': 'Unlock DSH Companion',
  'unlock.button': 'Unlock',
  'unlock.cancelled': 'Unlock cancelled. Your credential stays locked.',
  'unlock.failed': 'Could not verify you. Try again.',
  'unlock.lockedOut': 'Too many attempts. Unlock your phone, then retry.',
  'unlock.unavailable': 'Set up a screen lock (passcode, PIN or biometrics) to protect the paired credential.',
  'unlock.passcodeOnly': 'Biometrics are not set up; using your device passcode.',
  'unlock.passkeyLocked': 'This device is locked. Use its passkey to continue.',
  'unlock.passkeyRegister': 'Create a passkey for this browser to unlock this device.',
  'unlock.passkeyRateLimited': 'Too many passkey attempts. Wait a few minutes, then try again.',
  'unlock.passkeyExpired': 'The passkey request expired. Try again.',
  'unlock.passkeyFailed': 'That passkey did not verify. Try again.',
  'unlock.passkeyNotRegistered': 'This device has no passkey yet. Create one to continue.',
  'unlock.passkeyApproval': 'A passkey already exists. Ask the owner to approve replacing it on the computer, then create it again.',
  'unlock.passkeyUnsupported': 'This browser cannot use a passkey. Open the page in a recent browser over https.',
  'unlock.passkeyHostVersion': 'Your computer does not support passkey unlock yet. Update it, then try again.',
  'startup.failed': 'This app could not finish starting, so pairing is unavailable until it does.',
  'startup.retry': 'Retry',
  'startup.starting': 'Starting…',
  'tabs.running': 'Running',
  'tabs.idle': 'Idle',
  'tabs.archived': 'Archived',
  'tabs.workspace': 'Workspace',
  'tabs.conversations': 'Conversations',
  'tabs.settings': 'Settings',
  // Spec 011 parity (reference 01/02/03): the single list screen.
  'list.title': 'All Tasks',
  'list.all': 'All',
  'list.more': 'More options',
  'list.groupBy': 'Group by',
  'list.groupDate': 'Date',
  'list.groupStatus': 'Status',
  'list.date.any': 'Any date',
  'list.date.today': 'Today',
  'list.date.week': 'Last 7 days',
  'list.date.older': 'Older',
  'list.status.any': 'Any status',
  'list.status.running': 'Running',
  'list.status.idle': 'Idle',
  'list.status.decision': 'Needs a decision',
  // Present but NOT rendered today: `listFilterCapabilities` keeps these out of the menu until the
  // data exists (archived needs the `session-archives` frame; the wire carries no per-session
  // "online"). Translated now so unhiding them later is a one-line change, not a copy task.
  'list.filterArchived': 'Archived only',
  'list.filterOnline': 'Online only',
  'list.search': 'Search',
  'list.searchPlaceholder': 'Search sessions…',
  'list.noMatches': 'No session matches that search.',
  'list.other': 'Other',
  'list.ungrouped': 'All sessions',
  'list.composerPlaceholder': 'Type an instruction…',
  'home.hero': 'Explore further',
  'home.heroSubtitle': 'DeepSeek Harness companion',
  'home.recent': 'Recent sessions',
  'home.seeAll': 'See all conversations',
  'home.emptyTitle': 'No sessions yet',
  'home.emptyBody': 'Start a session on your computer and it appears here.',
  'conversations.title': 'Conversations',
  'settings.title': 'Settings',
  'settings.computer': 'Paired computer',
  'settings.paired': 'Paired',
  'settings.pairAnother': 'Pair another computer',
  'settings.lockNow': 'Lock now',
  'settings.fontSize': 'Text size',
  'settings.fontSizeHint': 'Applies to this app only.',
  // While the socket is not `ready` the app must say so — never diagnose a permission problem it
  // cannot know about yet (the Vietnamese/light review caught it accusing the host mid-connect).
  'authoring.connecting': 'Connecting to this computer…',
  'authoring.reconnecting': 'Reconnecting to this computer…',
  'home.loadingSessions': 'Loading sessions…',
  'authoring.scopeUnknown': 'This computer did not report its permissions, so creating a session is unavailable.',
  'authoring.modelSubagent': 'Sub-agent session: its model cannot be changed from this phone.',
  'home.showSubagents': 'Show {count} sub-agent sessions',
  'home.hideSubagents': 'Hide sub-agent sessions',
  'session.historyFailed': 'Could not load earlier messages.',
  'authoring.modelsUnavailable': 'Could not load the model list from this computer.',
  'authoring.createFailed': 'Could not create the session. Try again.',
  'authoring.needScope': 'This phone was not granted permission to create sessions. Ask for it when you pair.',
  'authoring.needWorkspace': 'Choose a workspace first.',
  'authoring.loadingWorkspaces': 'Loading workspaces…',
  'authoring.workspacesError': 'Could not load workspaces. Tap to retry.',
  'authoring.workspacesEmpty': 'This computer has no workspaces.',
  'authoring.workspaceTitle': 'Workspace',
  'authoring.workspacePlaceholder': 'Choose a workspace',
  'authoring.retry': 'Retry',
  'authoring.close': 'Close',
  'authoring.newSession': 'New session',
  'authoring.mode': 'Mode',
  'authoring.model': 'Model',
  'sessions.search': 'Search sessions',
  'sessions.empty': 'No sessions in this tab yet.',
  'sessions.emptySearch': 'No session matches your search.',
  'sessions.needsDecision': 'Needs your decision',
  'sessions.updatedAgo': 'updated {when}',
  'sessions.hiddenOlder': '{count} older sessions are outside the 30-day window.',
  'sessions.pair': 'Pair a computer',
  'sessions.forget': 'Forget this computer',
  'sessions.forgetConfirm': 'Remove the stored credential and pair again later?',
  'sessions.settings': 'Settings',
  'sessions.refresh': 'Refresh',
  'pair.title': 'Pair your computer',
  'pair.scan': 'Point the camera at the QR code on your computer',
  'pair.cameraPermission': 'Camera access is needed to scan the pairing QR code.',
  'pair.cameraPermissionButton': 'Allow camera',
  'pair.manual': 'Or paste the code shown on your computer',
  'pair.manualPlaceholder': 'Paste the pairing code',
  'pair.webAddress': 'This browser reaches your computer at {url}',
  'pair.submit': 'Pair',
  'pair.connecting': 'Connecting to {host}…',
  'pair.waitingApproval': 'Approve this phone on your computer. Check the code: {code}',
  'pair.success': 'Paired with {host}',
  // Contract revision 5: the Host has two buttons ("Show QR code" and "Generate pairing code"), so
  // the app asks which secret the user was given instead of guessing.
  'pair.modeCode': 'QR or code',
  'pair.modeOtp': '8-digit code',
  'pair.otpAddress': 'Your computer’s address',
  'pair.otpAddressPlaceholder': '192.168.1.20:3081',
  'pair.otpCode': 'Pairing code from your computer',
  'pair.otpPlaceholder': '8 digits',
  'pair.errorTitle': 'Could not pair',
  'pair.error.remoteDisabled': 'Remote control is off on your computer. Turn it on in DSH, then scan a new code.',
  'pair.error.expired': 'This pairing code expired or was already used. Show a new one on your computer.',
  'pair.error.rejected': 'Your computer refused this pairing. Check the approval prompt on your computer and try again with a new code.',
  'pair.error.timeout': 'The approval window ran out before the pairing finished. Show a new code on your computer and try again.',
  'pair.error.otpUnsupported': 'This computer asks for a one-time code, which this app version cannot enter. Update DSH Companion, or pair with the QR code instead.',
  'pair.error.otpRequired': 'This computer is waiting for its 8-digit pairing code. Generate one on your computer and type it here.',
  'pair.error.otpBadLength': 'The pairing code is 8 digits. Check it on your computer and type it again.',
  'pair.error.badAddress': 'Type your computer’s address, for example 192.168.1.20:3081.',
  'pair.error.pinMismatch': 'That computer is not the one the code belongs to. Nothing was sent. If its certificate changed, pair again with a fresh code.',
  'pair.error.otpNative': 'On a phone, use the QR code or the long pairing string instead of the 8-digit code: a code carries no certificate for the phone to verify the computer against. Tap “QR or code” above.',
  'pair.error.noHostId': 'This computer did not identify itself, so this phone cannot remember it. Show a new code on your computer and try again.',
  'pair.error.hostConflict': 'This phone already has a different computer saved under that identity, so the pairing was refused. Forget that computer first if it really was replaced.',
  'pair.error.notReady': 'Pairing is not ready yet. Wait a moment, then tap pair again.',
  'pair.error.unavailable': 'Could not reach that computer. Check you are on the same network and the gateway is running.',
  'pair.error.appUpdate': 'Your computer needs a newer DSH Companion. Update the app.',
  'pair.error.hostUpdate': 'Your computer runs an older protocol. Update DSH on the desktop.',
  'pair.error.generic': 'Pairing failed. Show a new code and try again.',
  'session.loading': 'Loading conversation…',
  // A session the Host has not titled yet: a human label + when it started, never the wire id.
  'session.untitled': 'New session',
  'session.untitledAgo': 'New session · {when}',
  'session.empty': 'No messages yet.',
  'session.composerPlaceholder': 'Send an instruction…',
  'session.mic': 'Dictate',
  'session.micHint': 'Use the microphone key on your keyboard to dictate.',
  'team.title': 'Agent team',
  'team.members': 'Members',
  'team.tasks': 'Tasks',
  'team.blocked': 'blocked',
  'team.subagents': 'Sub-agents',
  'team.unavailable': 'This session has no team yet (the Host has not projected one).',
  'team.migrationRequired': 'This session is still being migrated; its team will appear after that.',
  'team.retry': 'Try again',
  'team.errorNotFound': 'This session no longer exists on the Host.',
  'team.errorAuth': 'The Host refused the read — check this device is still paired.',
  'team.errorGeneric': 'Could not read the team.',
  'stats.title': 'Session stats',
  'stats.tokens': 'Tokens',
  'stats.context': 'Context',
  'stats.turns': 'Turns',
  'stats.steps': 'Steps',
  'stats.input': 'Input',
  'stats.output': 'Output',
  'stats.cacheRead': 'Cache read',
  'stats.cacheWrite': 'Cache write',
  'stats.reasoning': 'Reasoning',
  'stats.contextWindow': 'Window',
  'stats.contextUsed': 'In use',
  'stats.unavailable': 'Stats need the stats:read permission on this pairing. Pair this phone again with it ticked.',
  'stats.noData': 'This session has no stats yet.',
  'stats.errorAuth': 'The Host refused the stats read — check this device is still paired.',
  'stats.errorGeneric': 'Could not read the session stats.',
  'schedules.title': 'Scheduled tasks',
  'schedules.open': 'Scheduled tasks',
  'schedules.refresh': 'Refresh',
  'schedules.unavailable': 'Scheduled tasks need the schedule:read permission on this pairing. Pair this phone again with it ticked.',
  'schedules.notNow': 'Scheduled tasks are not available right now. Try again when connected.',
  'schedules.empty': 'No scheduled tasks on this computer.',
  'schedules.emptyActive': 'No active scheduled tasks on this computer.',
  'schedules.status.active': 'Active',
  'schedules.status.paused': 'Paused',
  'schedules.status.ended': 'Ended',
  'schedules.status.unknown': 'Unknown',
  'schedules.nextRun': 'Next run: {when}',
  'schedules.none': 'Not scheduled',
  'schedules.detailTitle': 'Scheduled task',
  'schedules.readOnly': 'Read-only here: change it on your computer.',
  'schedules.field.rule': 'Rule',
  'schedules.field.status': 'Status',
  'schedules.field.nextRun': 'Next run',
  'schedules.field.time': 'Time',
  'schedules.field.timeZone': 'Time zone',
  'schedules.field.weekdays': 'Days',
  'schedules.field.everySeconds': 'Every',
  'schedules.field.expression': 'Schedule',
  'schedules.field.target': 'Runs in',
  'schedules.notFound': 'This task no longer exists on the computer.',
  'schedules.errorAuth': 'The Host refused the read — check this device is still paired.',
  'schedules.errorGeneric': 'Could not read the scheduled tasks.',
  'common.loading': 'Loading…',
  'sessionActions.rename': 'Rename',
  'sessionActions.archive': 'Archive',
  'sessionActions.renameTitle': 'Session name',
  'sessionActions.renameEmpty': 'A name is required.',
  'sessionActions.renameTooLong': 'Use at most 200 characters.',
  'sessionActions.save': 'Save',
  'sessionActions.archiveConfirm': 'Archive this session?',
  'sessionActions.archiveConfirmBody': 'It leaves the session list on this phone. The conversation is kept on the computer.',
  'sessionActions.errorNotFound': 'This session no longer exists on the Host.',
  'sessionActions.errorAuth': 'The Host refused — check this device is still paired.',
  'sessionActions.errorGeneric': 'That did not work.',
  'session.send': 'Send',
  'session.cancel': 'Stop session',
  'session.cancelConfirmTitle': 'Stop this session?',
  'session.cancelConfirmBody': 'The agent stops working on the computer.',
  'session.cancelConfirm': 'Stop',
  'session.cancelled': 'Session stopped.',
  'session.historyOlder': 'Load earlier messages',
  'session.pendingUnconfirmed': 'Not confirmed by the computer',
  'session.pending': 'sending…',
  'session.failed': 'not sent',
  'session.retry': 'Retry',
  'session.linkOpenTitle': 'Open this link outside the app?',
  'session.linkOpenBody': '{url}',
  'session.linkOpen': 'Open',
  'session.role.tool': 'Tool',
  'session.role.system': 'System',
  'session.role.other': 'Activity',
  'session.share': 'Share',
  'session.expandTable': 'Expand table',
  'session.reply': 'Reply',
  'session.scrollBottom': 'Jump to latest',
  'session.toolsCollapsed': '{count} steps',
  'session.chooseModel': 'Choose model',
  'session.more': 'More actions',
  'session.sendOffline': 'Offline — reconnect to send',
  'session.sendNotReady': 'Connecting… you can type meanwhile',
  'session.permissionChip': 'Permission: {preset}',
  'session.agentPreset': 'Agent: {preset}',
  'session.permissionTitle': 'Stricter permissions',
  'session.permissionCurrent': 'Current: {preset}',
  'session.permissionEmpty': 'This computer offers no stricter preset.',
  'session.permissionUnavailable': 'This computer cannot change the permission preset right now.',
  'session.permissionLoadFailed': 'Could not read the preset list. Tap to try again.',
  // A lowering narrows what the agent may do: it asks first, and says so plainly. Nothing here
  // widens a preset — the sheet only ever offers stricter ones.
  'session.permissionConfirmTitle': 'Switch to {preset}?',
  'session.permissionConfirmBody': 'The agent on this computer will be restricted by this preset from now on.',
  'session.permissionConfirm': 'Switch',
  'session.permissionApplied': 'Now: {preset}',
  'session.permissionPair': 'sandbox {sandbox} · approval {approval}',
  'session.permissionNotStricter': 'That preset is not stricter than the current one. Nothing changed.',
  'session.permissionCustomCurrent': 'This session uses a custom permission setting, so it cannot be compared with a preset. Nothing changed.',
  'session.permissionRaced': 'The preset changed before this phone could confirm the switch. Check it on your computer.',
  'session.permissionError': 'The computer did not confirm the change. Check the preset on your computer.',
  'session.goal': 'Goal',
  'session.goalPhase': '{phase}',
  'session.tasksTitle': 'Tasks',
  'session.tasksDone': '{done}/{total}',
  'session.tasksMore': '+{count} more',
  'session.taskStatus.pending': 'Pending',
  'session.taskStatus.in-progress': 'In progress',
  'session.taskStatus.completed': 'Done',
  'session.taskStatus.unknown': 'Unknown',
  'approval.title': 'Approval needed: {tool}',
  'approval.approve': 'Allow once',
  'approval.reject': 'Reject',
  'approval.decideOnComputer': 'Decide on your computer',
  'approval.changed': 'This request changed since you opened it. Review again.',
  'approval.reviewAgain': 'Review again',
  'approval.alreadyDecided': 'Already decided.',
  'approval.retry': 'Try again',
  'approval.approved': 'Allowed once',
  'approval.rejected': 'Rejected',
  'approval.cancelledElsewhere': 'Cancelled on another device.',
  'approval.unavailableElsewhere': 'No longer available.',
  'banner.reconnecting': 'Reconnecting…',
  'banner.offline': 'Offline — showing the last known state.',
  'banner.gatewayOff': 'Remote control is off on your computer. Auto-reconnect is paused.',
  'banner.revoked': 'This device was removed from the computer. Pair again to continue.',
  'banner.reauth': 'The computer asks to re-authenticate. Reconnecting…',
  'banner.cleanupFailed':
    'This phone could not finish deleting the stored credential. This device stays unpaired and the credential will not be used — restart the app and forget the computer again.',
  'banner.pinnedTransportMissing':
    'This build has no pinned TLS transport (Expo Go / web). Install a dev build to connect; the app will not fall back to an unpinned socket.',
  'update.appTitle': 'Update DSH Companion',
  'update.appBody': 'Your computer needs a newer version of this app. Install the new build, then tap Retry.',
  'update.hostTitle': 'Update DSH on your computer',
  'update.hostBody': 'Your computer speaks an older protocol than this app. Update DSH on the desktop, then tap Retry.',
  'update.details': 'Protocol version {version}',
  'update.retry': 'Retry',
  'update.pairAnother': 'Pair a different computer',
  'notice.notification.title': 'DSH needs your decision',
  'notice.notification.body': (params) => `A ${String(params.tool ?? 'tool')} call is waiting.`,
  'common.ok': 'OK',
  'common.cancel': 'Cancel',
  'common.back': 'Back',
  'common.host': 'Computer',
  'authoring.workspaceGone': 'That workspace is no longer on this computer — pick another one.',
  'session.reasoning': 'Reasoning',
  'storage.title': 'Storage',
  'storage.total': 'Used by this app',
  'storage.clear': 'Clear by category',
  'storage.clearAll': 'Clear everything',
  'storage.clearAllConfirm': 'Delete every cached file this app keeps on this phone? Your pairing stays.',
  'storage.empty': 'Nothing cached on this phone.',
  'storage.cleared': 'Removed {count} file(s).',
  'storage.hint': 'Only files this app stores on this phone are counted. Your pairing and credentials are not cache and are never touched here.',
  'storage.category.logs': 'Logs',
  'storage.category.images': 'Images',
  'storage.category.documents': 'Documents',
  'storage.category.other': 'Other',
  'privacy.title': 'Privacy',
  'privacy.updated': 'Applies to this version of the app.',
  'privacy.p1': 'DSH Companion talks only to a DeepSeek Harness computer that you pair yourself. There is no account, no sign-in and no vendor server, so there is nowhere else for your data to go.',
  'privacy.p2': 'Everything that leaves this phone goes to that one computer, over the connection you set up. Session titles, messages and approvals travel between this phone and your own machine. Nobody else receives them.',
  'privacy.p3': 'The pairing credential is kept in this device’s encrypted storage (Android Keystore). It is never written to a log, never put in a notification and never sent anywhere except to your computer.',
  'privacy.p4': 'The app contains no analytics, no crash reporting and no advertising SDK. Nothing is collected about how you use it, and nothing is sold or shared.',
  'privacy.p5': 'On this phone the app can store an optional debug log (only in builds that switch it on) and the cached files listed on the storage screen. You can delete both from Settings, and deleting them does not unpair the device.',
  'privacy.p6': 'Pairing a computer, or revoking this device on the computer, adds or removes the credential. Notifications carry only short text and identifiers, never message bodies from other sessions.',
} satisfies Messages;

// ---------------------------------------------------------------------------
// Vietnamese
// ---------------------------------------------------------------------------

const vi = {
  'unlock.title': 'DSH Companion',
  'unlock.subtitle': 'Mở khoá để kết nối máy tính đã ghép đôi.',
  'unlock.prompt': 'Mở khoá DSH Companion',
  'unlock.button': 'Mở khoá',
  'unlock.cancelled': 'Đã huỷ mở khoá. Thông tin đăng nhập vẫn được giữ kín.',
  'unlock.failed': 'Không xác minh được. Vui lòng thử lại.',
  'unlock.lockedOut': 'Đã thử quá nhiều lần. Mở khoá điện thoại rồi thử lại.',
  'unlock.unavailable': 'Hãy đặt khoá màn hình (mã PIN hoặc sinh trắc học) để bảo vệ thông tin đã ghép đôi.',
  'unlock.passcodeOnly': 'Chưa đặt sinh trắc học; đang dùng mã mở khoá thiết bị.',
  'unlock.passkeyLocked': 'Thiết bị này đang khoá. Dùng passkey của nó để tiếp tục.',
  'unlock.passkeyRegister': 'Tạo passkey cho trình duyệt này để mở khoá thiết bị.',
  'unlock.passkeyRateLimited': 'Đã thử passkey quá nhiều lần. Chờ vài phút rồi thử lại.',
  'unlock.passkeyExpired': 'Yêu cầu passkey đã hết hạn. Vui lòng thử lại.',
  'unlock.passkeyFailed': 'Passkey đó không xác minh được. Vui lòng thử lại.',
  'unlock.passkeyNotRegistered': 'Thiết bị này chưa có passkey. Hãy tạo một cái để tiếp tục.',
  'unlock.passkeyApproval': 'Đã có passkey. Hãy nhờ chủ máy duyệt thay thế trên máy tính rồi tạo lại.',
  'unlock.passkeyUnsupported': 'Trình duyệt này không dùng được passkey. Mở trang bằng trình duyệt mới qua https.',
  'unlock.passkeyHostVersion': 'Máy tính chưa hỗ trợ mở khoá bằng passkey. Hãy cập nhật rồi thử lại.',
  'startup.failed': 'Ứng dụng chưa khởi động xong nên chưa thể ghép đôi.',
  'startup.retry': 'Thử lại',
  'startup.starting': 'Đang khởi động…',
  'tabs.running': 'Đang chạy',
  // Session state, not a queue: "Chờ" (= waiting) mislabelled an idle session; "Rảnh" = free/idle.
  'tabs.idle': 'Rảnh',
  'tabs.archived': 'Lưu trữ',
  'tabs.workspace': 'Không gian',
  'tabs.conversations': 'Hội thoại',
  'tabs.settings': 'Cài đặt',
  'list.title': 'Tất cả tác vụ',
  'list.all': 'Tất cả',
  'list.more': 'Tùy chọn khác',
  'list.groupBy': 'Nhóm theo',
  'list.groupDate': 'Ngày',
  'list.groupStatus': 'Trạng thái',
  'list.date.any': 'Mọi ngày',
  'list.date.today': 'Hôm nay',
  'list.date.week': '7 ngày qua',
  'list.date.older': 'Cũ hơn',
  'list.status.any': 'Mọi trạng thái',
  'list.status.running': 'Đang chạy',
  'list.status.idle': 'Rảnh',
  'list.status.decision': 'Chờ duyệt',
  'list.filterArchived': 'Chỉ đã lưu trữ',
  'list.filterOnline': 'Chỉ online',
  'list.search': 'Tìm kiếm',
  'list.searchPlaceholder': 'Tìm phiên theo tiêu đề…',
  'list.noMatches': 'Không có phiên nào khớp tìm kiếm.',
  'list.other': 'Khác',
  'list.ungrouped': 'Tất cả phiên',
  'list.composerPlaceholder': 'Nhập chỉ dẫn…',
  // "chưa tới" read as "explore has not arrived yet"; "thêm" = "further/more".
  'home.hero': 'Khám phá thêm',
  'home.heroSubtitle': 'Ứng dụng đồng hành DeepSeek Harness',
  'home.recent': 'Phiên gần đây',
  'home.seeAll': 'Xem tất cả hội thoại',
  'home.emptyTitle': 'Chưa có phiên nào',
  'home.emptyBody': 'Hãy bắt đầu một phiên trên máy tính, phiên đó sẽ hiện ở đây.',
  'conversations.title': 'Hội thoại',
  'settings.title': 'Cài đặt',
  'settings.computer': 'Máy tính đã ghép đôi',
  'settings.paired': 'Đã ghép đôi',
  'settings.pairAnother': 'Ghép đôi máy tính khác',
  'settings.lockNow': 'Khoá ngay',
  'settings.fontSize': 'Cỡ chữ',
  'settings.fontSizeHint': 'Chỉ áp dụng cho ứng dụng này.',
  'authoring.connecting': 'Đang kết nối tới máy tính…',
  'authoring.reconnecting': 'Đang kết nối lại tới máy tính…',
  'home.loadingSessions': 'Đang tải phiên…',
  'authoring.scopeUnknown': 'Máy tính này không báo quyền của thiết bị, nên chưa thể tạo phiên.',
  'authoring.modelSubagent': 'Phiên tác tử con: không thể đổi model từ điện thoại này.',
  'home.showSubagents': 'Hiện {count} phiên tác tử con',
  'home.hideSubagents': 'Ẩn các phiên tác tử con',
  'session.historyFailed': 'Không tải được tin nhắn trước.',
  'authoring.modelsUnavailable': 'Không tải được danh sách model từ máy tính này.',
  'authoring.createFailed': 'Không tạo được phiên. Hãy thử lại.',
  'authoring.needScope': 'Điện thoại này chưa được cấp quyền tạo phiên. Hãy yêu cầu khi ghép đôi.',
  'authoring.needWorkspace': 'Hãy chọn một không gian làm việc trước.',
  'authoring.loadingWorkspaces': 'Đang tải không gian làm việc…',
  'authoring.workspacesError': 'Không tải được không gian làm việc. Chạm để thử lại.',
  'authoring.workspacesEmpty': 'Máy tính này chưa có không gian làm việc nào.',
  'authoring.workspaceTitle': 'Không gian làm việc',
  'authoring.workspacePlaceholder': 'Chọn không gian làm việc',
  'authoring.retry': 'Thử lại',
  'authoring.close': 'Đóng',
  'authoring.newSession': 'Phiên mới',
  'authoring.mode': 'Chế độ',
  'authoring.model': 'Model',
  'sessions.search': 'Tìm phiên',
  'sessions.empty': 'Chưa có phiên nào trong mục này.',
  'sessions.emptySearch': 'Không có phiên nào khớp tìm kiếm.',
  'sessions.needsDecision': 'Cần bạn quyết định',
  'sessions.updatedAgo': 'cập nhật {when}',
  // "cửa sổ 30 ngày" was a literal calque of "30-day window"; plain Vietnamese is clearer.
  'sessions.hiddenOlder': '{count} phiên cũ hơn 30 ngày nên không hiển thị.',
  'sessions.pair': 'Ghép đôi máy tính',
  'sessions.forget': 'Quên máy tính này',
  'sessions.forgetConfirm': 'Xoá thông tin đăng nhập đã lưu và ghép đôi lại sau?',
  'sessions.settings': 'Cài đặt',
  'sessions.refresh': 'Làm mới',
  'pair.title': 'Ghép đôi máy tính',
  'pair.scan': 'Hướng camera vào mã QR trên máy tính',
  'pair.cameraPermission': 'Cần quyền camera để quét mã QR ghép đôi.',
  'pair.cameraPermissionButton': 'Cho phép camera',
  'pair.manual': 'Hoặc dán mã hiển thị trên máy tính',
  'pair.manualPlaceholder': 'Dán mã ghép đôi',
  'pair.webAddress': 'Trình duyệt này kết nối tới máy tính qua {url}',
  'pair.submit': 'Ghép đôi',
  'pair.connecting': 'Đang kết nối tới {host}…',
  'pair.waitingApproval': 'Hãy phê duyệt điện thoại này trên máy tính. Đối chiếu mã: {code}',
  'pair.success': 'Đã ghép đôi với {host}',
  'pair.modeCode': 'Mã QR hoặc mã chuỗi',
  'pair.modeOtp': 'Mã 8 số',
  'pair.otpAddress': 'Địa chỉ máy tính của bạn',
  'pair.otpAddressPlaceholder': '192.168.1.20:3081',
  'pair.otpCode': 'Mã ghép đôi trên máy tính',
  'pair.otpPlaceholder': '8 chữ số',
  'pair.errorTitle': 'Không ghép đôi được',
  'pair.error.remoteDisabled': 'Điều khiển từ xa đang tắt trên máy tính. Hãy bật trong DSH và quét mã mới.',
  'pair.error.expired': 'Mã ghép đôi đã hết hạn hoặc đã dùng. Hãy hiển thị mã mới trên máy tính.',
  'pair.error.rejected': 'Máy tính đã từ chối lần ghép đôi này. Hãy kiểm tra hộp thoại phê duyệt trên máy tính rồi thử lại bằng mã mới.',
  'pair.error.timeout': 'Hết thời gian chờ phê duyệt trước khi ghép đôi xong. Hãy hiển thị mã mới trên máy tính và thử lại.',
  'pair.error.otpUnsupported': 'Máy tính yêu cầu mã dùng một lần, phiên bản ứng dụng này chưa nhập được. Hãy cập nhật DSH Companion, hoặc ghép đôi bằng mã QR.',
  'pair.error.otpRequired': 'Máy tính đang chờ mã ghép đôi 8 số. Hãy tạo mã trên máy tính rồi nhập vào đây.',
  'pair.error.otpBadLength': 'Mã ghép đôi gồm 8 chữ số. Hãy kiểm tra lại trên máy tính và nhập lại.',
  'pair.error.badAddress': 'Hãy nhập địa chỉ máy tính, ví dụ 192.168.1.20:3081.',
  'pair.error.pinMismatch': 'Máy tính này không khớp với mã. Không có dữ liệu nào được gửi. Nếu chứng chỉ vừa đổi, hãy ghép đôi lại bằng mã mới.',
  'pair.error.otpNative': 'Trên điện thoại, hãy dùng mã QR hoặc chuỗi ghép đôi dài thay cho mã 8 số: mã này không mang chứng chỉ để điện thoại xác minh máy tính. Nhấn “Mã QR hoặc mã chuỗi” ở trên.',
  'pair.error.noHostId': 'Máy tính này không cho biết danh tính nên điện thoại không thể ghi nhớ. Hãy hiển thị mã mới trên máy tính và thử lại.',
  'pair.error.hostConflict': 'Điện thoại đã lưu một máy tính khác dưới cùng danh tính đó, nên lần ghép đôi này bị từ chối. Nếu máy tính thật sự đã được thay, hãy xoá máy tính cũ trước.',
  'pair.error.notReady': 'Ứng dụng vẫn đang khởi động. Hãy đợi một chút rồi nhấn ghép đôi lại.',
  'pair.error.unavailable': 'Không kết nối được máy tính. Kiểm tra cùng mạng và gateway đang chạy.',
  'pair.error.appUpdate': 'Máy tính cần bản DSH Companion mới hơn. Hãy cập nhật ứng dụng.',
  'pair.error.hostUpdate': 'Máy tính dùng giao thức cũ hơn. Hãy cập nhật DSH trên máy tính.',
  'pair.error.generic': 'Ghép đôi thất bại. Hãy hiển thị mã mới và thử lại.',
  'session.loading': 'Đang tải hội thoại…',
  'session.untitled': 'Phiên mới',
  'session.untitledAgo': 'Phiên mới · {when}',
  'session.empty': 'Chưa có tin nhắn.',
  'session.composerPlaceholder': 'Gửi chỉ dẫn…',
  'session.mic': 'Đọc bằng bàn phím',
  'session.micHint': 'Dùng nút micro trên bàn phím để đọc.',
  'team.title': 'Đội agent',
  'team.members': 'Thành viên',
  'team.tasks': 'Công việc',
  'team.blocked': 'bị chặn',
  'team.subagents': 'Sub-agent',
  'team.unavailable': 'Phiên này chưa có đội (Host chưa chiếu dữ liệu đội).',
  'team.migrationRequired': 'Phiên đang được chuyển đổi; đội sẽ hiện sau khi xong.',
  'team.retry': 'Thử lại',
  'team.errorNotFound': 'Phiên này không còn trên Host.',
  'team.errorAuth': 'Host từ chối đọc — kiểm tra thiết bị này còn ghép nối không.',
  'team.errorGeneric': 'Không đọc được đội agent.',
  'stats.title': 'Số liệu phiên',
  'stats.tokens': 'Token',
  'stats.context': 'Ngữ cảnh',
  'stats.turns': 'Lượt',
  'stats.steps': 'Bước',
  'stats.input': 'Đầu vào',
  'stats.output': 'Đầu ra',
  'stats.cacheRead': 'Đọc cache',
  'stats.cacheWrite': 'Ghi cache',
  'stats.reasoning': 'Suy luận',
  'stats.contextWindow': 'Cửa sổ',
  'stats.contextUsed': 'Đang dùng',
  'stats.unavailable': 'Số liệu cần quyền stats:read cho lần ghép đôi này. Hãy ghép đôi lại điện thoại với quyền đó.',
  'stats.noData': 'Phiên này chưa có số liệu.',
  'stats.errorAuth': 'Host từ chối đọc số liệu — kiểm tra thiết bị này còn ghép nối không.',
  'stats.errorGeneric': 'Không đọc được số liệu phiên.',
  'schedules.title': 'Tác vụ hẹn giờ',
  'schedules.open': 'Tác vụ hẹn giờ',
  'schedules.refresh': 'Làm mới',
  'schedules.unavailable': 'Tác vụ hẹn giờ cần quyền schedule:read cho lần ghép đôi này. Hãy ghép đôi lại điện thoại với quyền đó.',
  'schedules.notNow': 'Hiện chưa xem được tác vụ hẹn giờ. Hãy thử lại khi đã kết nối.',
  'schedules.empty': 'Máy tính này không có tác vụ hẹn giờ nào.',
  'schedules.emptyActive': 'Máy tính này không có tác vụ hẹn giờ nào đang bật.',
  'schedules.status.active': 'Đang bật',
  'schedules.status.paused': 'Tạm dừng',
  'schedules.status.ended': 'Đã kết thúc',
  'schedules.status.unknown': 'Không rõ',
  'schedules.nextRun': 'Lần chạy tới: {when}',
  'schedules.none': 'Chưa hẹn giờ',
  'schedules.detailTitle': 'Tác vụ hẹn giờ',
  'schedules.readOnly': 'Chỉ đọc ở đây: hãy sửa trên máy tính.',
  'schedules.field.rule': 'Quy tắc',
  'schedules.field.status': 'Trạng thái',
  'schedules.field.nextRun': 'Lần chạy tới',
  'schedules.field.time': 'Giờ',
  'schedules.field.timeZone': 'Múi giờ',
  'schedules.field.weekdays': 'Thứ',
  'schedules.field.everySeconds': 'Mỗi',
  'schedules.field.expression': 'Lịch',
  'schedules.field.target': 'Chạy trong',
  'schedules.notFound': 'Tác vụ này không còn trên máy tính.',
  'schedules.errorAuth': 'Host từ chối đọc — kiểm tra thiết bị này còn ghép nối không.',
  'schedules.errorGeneric': 'Không đọc được tác vụ hẹn giờ.',
  'common.loading': 'Đang tải…',
  'sessionActions.rename': 'Đổi tên',
  'sessionActions.archive': 'Lưu trữ',
  'sessionActions.renameTitle': 'Tên phiên',
  'sessionActions.renameEmpty': 'Cần nhập tên.',
  'sessionActions.renameTooLong': 'Tối đa 200 ký tự.',
  'sessionActions.save': 'Lưu',
  'sessionActions.archiveConfirm': 'Lưu trữ phiên này?',
  'sessionActions.archiveConfirmBody': 'Phiên sẽ rời khỏi danh sách trên điện thoại này. Nội dung hội thoại vẫn được giữ trên máy tính.',
  'sessionActions.errorNotFound': 'Phiên này không còn trên Host.',
  'sessionActions.errorAuth': 'Host từ chối — kiểm tra thiết bị này còn ghép nối không.',
  'sessionActions.errorGeneric': 'Thao tác không thành công.',
  'session.send': 'Gửi',
  'session.cancel': 'Dừng phiên',
  'session.cancelConfirmTitle': 'Dừng phiên này?',
  'session.cancelConfirmBody': 'Agent sẽ dừng làm việc trên máy tính.',
  'session.cancelConfirm': 'Dừng',
  'session.cancelled': 'Đã dừng phiên.',
  'session.historyOlder': 'Tải tin nhắn cũ hơn',
  'session.pendingUnconfirmed': 'Máy tính chưa xác nhận',
  'session.pending': 'đang gửi…',
  'session.failed': 'chưa gửi',
  'session.retry': 'Gửi lại',
  'session.linkOpenTitle': 'Mở liên kết này bên ngoài ứng dụng?',
  'session.linkOpenBody': '{url}',
  'session.linkOpen': 'Mở',
  'session.role.tool': 'Công cụ',
  'session.role.system': 'Hệ thống',
  'session.role.other': 'Hoạt động',
  'session.share': 'Chia sẻ',
  'session.expandTable': 'Xem bảng toàn màn hình',
  'session.reply': 'Trả lời',
  'session.scrollBottom': 'Xuống tin mới nhất',
  'session.toolsCollapsed': '{count} bước',
  'session.chooseModel': 'Chọn model',
  'session.more': 'Thao tác khác',
  'session.sendOffline': 'Đang ngoại tuyến — kết nối lại để gửi',
  'session.sendNotReady': 'Đang kết nối… bạn có thể soạn trước',
  'session.permissionChip': 'Quyền: {preset}',
  'session.agentPreset': 'Agent: {preset}',
  'session.permissionTitle': 'Quyền chặt hơn',
  'session.permissionCurrent': 'Hiện tại: {preset}',
  'session.permissionEmpty': 'Máy tính này không có preset nào chặt hơn.',
  'session.permissionUnavailable': 'Máy tính này hiện không đổi được preset quyền.',
  'session.permissionLoadFailed': 'Không đọc được danh sách preset. Chạm để thử lại.',
  'session.permissionConfirmTitle': 'Chuyển sang {preset}?',
  'session.permissionConfirmBody': 'Từ giờ agent trên máy tính sẽ bị giới hạn theo preset này.',
  'session.permissionConfirm': 'Chuyển',
  'session.permissionApplied': 'Hiện tại: {preset}',
  'session.permissionPair': 'sandbox {sandbox} · duyệt {approval}',
  'session.permissionNotStricter': 'Preset đó không chặt hơn preset hiện tại. Không có gì thay đổi.',
  'session.permissionCustomCurrent': 'Phiên này dùng thiết lập quyền tuỳ chỉnh nên không so được với preset. Không có gì thay đổi.',
  'session.permissionRaced': 'Preset đã đổi trước khi điện thoại xác nhận được. Hãy kiểm tra trên máy tính.',
  'session.permissionError': 'Máy tính chưa xác nhận thay đổi. Hãy kiểm tra preset trên máy tính.',
  'session.goal': 'Mục tiêu',
  'session.goalPhase': '{phase}',
  'session.tasksTitle': 'Việc cần làm',
  'session.tasksDone': '{done}/{total}',
  'session.tasksMore': '+{count} việc nữa',
  'session.taskStatus.pending': 'Chờ làm',
  'session.taskStatus.in-progress': 'Đang làm',
  'session.taskStatus.completed': 'Xong',
  'session.taskStatus.unknown': 'Không rõ',
  'approval.title': 'Cần phê duyệt: {tool}',
  'approval.approve': 'Cho phép một lần',
  'approval.reject': 'Từ chối',
  'approval.decideOnComputer': 'Quyết định trên máy tính',
  'approval.changed': 'Yêu cầu đã thay đổi kể từ khi bạn mở. Hãy xem lại.',
  'approval.reviewAgain': 'Xem lại',
  'approval.alreadyDecided': 'Đã được quyết định.',
  'approval.retry': 'Thử lại',
  'approval.approved': 'Đã cho phép một lần',
  'approval.rejected': 'Đã từ chối',
  'approval.cancelledElsewhere': 'Đã huỷ trên thiết bị khác.',
  'approval.unavailableElsewhere': 'Không còn hiệu lực.',
  'banner.reconnecting': 'Đang kết nối lại…',
  'banner.offline': 'Ngoại tuyến — đang hiển thị trạng thái gần nhất.',
  'banner.gatewayOff': 'Điều khiển từ xa đang tắt trên máy tính. Tự kết nối lại đã tạm dừng.',
  'banner.revoked': 'Thiết bị này đã bị xoá khỏi máy tính. Hãy ghép đôi lại để tiếp tục.',
  'banner.reauth': 'Máy tính yêu cầu xác thực lại. Đang kết nối lại…',
  'banner.cleanupFailed':
    'Điện thoại chưa xoá xong thông tin đăng nhập đã lưu. Thiết bị này vẫn ở trạng thái chưa ghép đôi và thông tin đó sẽ không được dùng — hãy khởi động lại ứng dụng và xoá máy tính một lần nữa.',
  'banner.pinnedTransportMissing':
    'Bản này không có kênh TLS ghim chứng chỉ (Expo Go / web). Hãy cài bản dev build để kết nối; ứng dụng không bao giờ chuyển sang kết nối không ghim.',
  'update.appTitle': 'Cập nhật DSH Companion',
  'update.appBody': 'Máy tính cần bản ứng dụng mới hơn. Hãy cài bản mới rồi nhấn Thử lại.',
  'update.hostTitle': 'Cập nhật DSH trên máy tính',
  'update.hostBody': 'Máy tính dùng giao thức cũ hơn ứng dụng này. Hãy cập nhật DSH trên máy tính rồi nhấn Thử lại.',
  'update.details': 'Phiên bản giao thức {version}',
  'update.retry': 'Thử lại',
  'update.pairAnother': 'Ghép đôi máy tính khác',
  'notice.notification.title': 'DSH cần bạn quyết định',
  'notice.notification.body': (params) => `Lời gọi ${String(params.tool ?? 'công cụ')} đang chờ.`,
  'common.ok': 'OK',
  'common.cancel': 'Huỷ',
  'common.back': 'Quay lại',
  'common.host': 'Máy tính',
  'authoring.workspaceGone': 'Workspace này không còn trên máy tính — hãy chọn workspace khác.',
  'session.reasoning': 'Suy luận',
  'storage.title': 'Bộ nhớ đệm',
  'storage.total': 'Ứng dụng này đang dùng',
  'storage.clear': 'Xoá theo loại',
  'storage.clearAll': 'Xoá tất cả',
  'storage.clearAllConfirm': 'Xoá toàn bộ tệp đệm ứng dụng giữ trên máy này? Ghép đôi vẫn giữ nguyên.',
  'storage.empty': 'Trên máy này chưa có gì trong bộ nhớ đệm.',
  'storage.cleared': 'Đã xoá {count} tệp.',
  'storage.hint': 'Chỉ tệp do ứng dụng lưu trên máy này được tính. Thông tin ghép đôi và khoá truy cập không phải bộ nhớ đệm và không bao giờ bị đụng tới ở đây.',
  'storage.category.logs': 'Nhật ký',
  'storage.category.images': 'Hình ảnh',
  'storage.category.documents': 'Tài liệu',
  'storage.category.other': 'Khác',
  'privacy.title': 'Quyền riêng tư',
  'privacy.updated': 'Áp dụng cho phiên bản ứng dụng này.',
  'privacy.p1': 'DSH Companion chỉ kết nối tới máy tính DeepSeek Harness do chính bạn ghép đôi. Không có tài khoản, không có đăng nhập, không có máy chủ của nhà phát triển, nên dữ liệu của bạn không có chỗ nào khác để đi.',
  'privacy.p2': 'Mọi thứ rời khỏi điện thoại đều đi tới đúng máy tính đó, qua kết nối do bạn thiết lập. Tiêu đề phiên, tin nhắn và yêu cầu phê duyệt chỉ đi giữa điện thoại và máy của bạn. Không ai khác nhận được.',
  'privacy.p3': 'Thông tin ghép đôi được lưu trong vùng mã hoá của thiết bị (Android Keystore). Nó không bao giờ bị ghi vào nhật ký, không đưa vào thông báo và không gửi đi đâu ngoài máy tính của bạn.',
  'privacy.p4': 'Ứng dụng không có phân tích hành vi, không có báo cáo sự cố, không có SDK quảng cáo. Không thu thập gì về cách bạn dùng app, không bán và không chia sẻ cho bên thứ ba.',
  'privacy.p5': 'Trên máy này ứng dụng có thể lưu một tệp nhật ký gỡ lỗi (chỉ bản build bật tính năng đó) và các tệp đệm liệt kê ở màn Bộ nhớ đệm. Bạn xoá được cả hai trong Cài đặt, và xoá không làm mất ghép đôi.',
  'privacy.p6': 'Ghép đôi máy tính, hoặc thu hồi thiết bị này trên máy tính, sẽ thêm hoặc xoá thông tin truy cập. Thông báo chỉ mang văn bản ngắn và mã định danh, không mang nội dung tin nhắn của phiên khác.',
} satisfies Messages;

const TABLES: Record<Locale, Messages> = { en, vi };

/** Every table, for completeness tests (both locales must cover the same keys). */
export const MESSAGES: Readonly<Record<Locale, Messages>> = TABLES;

/** The set of keys (`t()` accepts exactly these). */
export const MESSAGE_KEYS: readonly MessageKey[] = Object.keys(en) as MessageKey[];

/** Interpolator for one locale (`{name}` placeholders). */
export function t(locale: Locale, key: MessageKey, params?: Record<string, string | number>): string {
  const table = TABLES[locale] ?? TABLES[DEFAULT_LOCALE];
  const value = table[key] ?? TABLES[DEFAULT_LOCALE][key];
  if (typeof value === 'function') return value(params ?? {});
  return format(value, params);
}

/** The device locale, falling back to Vietnamese (spec: vi + en). */
export function detectLocale(languageTag: string | null | undefined): Locale {
  const tag = (languageTag ?? '').toLowerCase();
  if (tag.startsWith('vi')) return 'vi';
  if (tag.startsWith('en')) return 'en';
  return DEFAULT_LOCALE;
}

/**
 * Pairing failures are typed by the core (QrRejectReason, CoreError codes); this maps them to
 * user-facing copy covering every spec-002 US1 / edge-case state.
 */
export type PairErrorKind =
  | 'remoteDisabled'
  | 'expired'
  | 'rejected'
  | 'timeout'
  | 'otpUnsupported'
  // Contract revision 5: the OTP flow itself (no code, a code of the wrong shape, a flow mismatch).
  | 'otpRequired'
  | 'otpBadLength'
  | 'badAddress'
  | 'pinMismatch'
  // The one-time-code form on a phone, and the Host's own identity: both are refused locally.
  | 'otpNative'
  | 'noHostId'
  | 'hostConflict'
  // The stored host list was not loaded yet, so the identity check could not run.
  | 'notReady'
  | 'unavailable'
  | 'appUpdate'
  | 'hostUpdate'
  | 'generic';

export function pairErrorFromQr(reason: QrRejectReason): PairErrorKind {
  switch (reason) {
    case 'qr/expired':
      return 'expired';
    case 'qr/invalid-json':
    case 'qr/unsupported-version':
    case 'qr/bad-endpoint':
    case 'qr/bad-gateway-id':
    case 'qr/bad-host-name':
    case 'qr/bad-cert-sha256':
    case 'qr/bad-pairing-code':
    case 'qr/bad-expires-at':
      return 'generic';
  }
}

export function pairErrorFromCode(code: ClientErrorCode | ContractErrorCode | string): PairErrorKind {
  switch (code) {
    case 'remote/disabled':
    case 'client/remote-disabled':
      return 'remoteDisabled';
    case 'pairing/expired':
    case 'auth/required':
      return 'expired';
    // Contract §3.8: the pairing connection's own outcomes.
    case 'client/pairing-rejected':
      return 'rejected';
    case 'client/pairing-expired':
      return 'expired';
    case 'client/pairing-timeout':
      return 'timeout';
    case 'client/pairing-otp-unsupported':
      return 'otpUnsupported';
    // Contract revision 5: the two flows disagree, so nothing could be proved.
    case 'client/pairing-otp-required':
      return 'otpRequired';
    case 'otp/empty':
      return 'otpRequired';
    case 'otp/bad-length':
      return 'otpBadLength';
    case 'client/pin-mismatch':
      return 'pinMismatch';
    // The Host's identity could not be trusted, so nothing was stored (`AppController.pair`).
    case 'client/pairing-no-host-id':
      return 'noHostId';
    case 'client/pairing-host-conflict':
      return 'hostConflict';
    // The stored host list had not loaded, so the identity check could not run: the attempt was
    // refused before a socket existed, and the same tap works once startup has finished.
    case 'client/bad-state':
      return 'notReady';
    case 'client/update-app-required':
      return 'appUpdate';
    case 'client/update-host-required':
      return 'hostUpdate';
    case 'client/pinned-transport-unavailable':
    case 'client/disconnected':
    case 'client/timeout':
    case 'auth/revoked':
      return 'unavailable';
    default:
      return 'generic';
  }
}

/** Relative "2 min ago" copy for the session rows (kept tiny on purpose). */
export function relativeTime(locale: Locale, ms: number): string {
  const seconds = Math.max(0, Math.round(ms / 1000));
  if (seconds < 60) return locale === 'vi' ? `${seconds}s` : `${seconds}s`;
  const minutes = Math.round(seconds / 60);
  if (minutes < 60) return locale === 'vi' ? `${minutes} phút` : `${minutes} min`;
  const hours = Math.round(minutes / 60);
  if (hours < 24) return locale === 'vi' ? `${hours} giờ` : `${hours} h`;
  const days = Math.round(hours / 24);
  return locale === 'vi' ? `${days} ngày` : `${days} d`;
}
