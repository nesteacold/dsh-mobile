# Clarklevis dsh-mobile vs DSH Companion — parity gap (2026-11-11)

Reference: `_upstream/Clarklevis1995__dsh-mobile` @ `3ec49d6` (MIT, "Whaleness"), Android UI in
`androidApp/src/main/kotlin/com/clarklevis/dsh/android/ui/*.kt`, feature list in its `README.md`.
Ours: `apps/mobile-companion` (screens `app/pair.tsx`, `app/(tabs)/index.tsx`, `app/session/[id].tsx`,
`app/settings.tsx`), gateway `plugins/mobile-gateway`.

Labels: (a) measured/run, (b) read from source, (c) inferred. Our UI inventory and the Kotlin
composable names were enumerated with a file listing + `fun [A-Z]\w+(` grep (a). The gateway column
comes from `plugins/mobile-gateway/lib/allowlist.mjs:71-102` (`ADMIN_ONLY_TYPES`) and `:110-120`
(`COMPANION_DENIED_HOST_ENDPOINTS`) (b): every message type listed there is refused to a device token
today unless a scope lifts it (only `sessions:author` lifts `session-create`, `models`,
`select-model`, `workspaces`, spec 011).

Risk: **low** = read-only display; **med** = mutates session state; **high** = touches files, shell,
host configuration, plugins or auth. Effort: S < 1 day, M 1–3 days, L > 3 days (app + gateway + tests
+ reviewer where required) (c).

## 1. List and navigation

| Feature (Kotlin source) | Behaviour | Ours | Gateway needs | Risk | Effort |
|---|---|---|---|---|---|
| Session list grouped by workspace (`DshProductApp.kt` `WorkspaceScreen`, `WorkspaceSessionSections.kt`) | sections per workspace, collapsible, recent vs all | **have** (this round; needs gateway reload) | `workspaceId`/`workspaceLabel` on rows — done, rev 9 | low | — |
| Gateway switcher (`GatewaySwitcherUi.kt`) | multiple hosts, edit/delete, drag panel | **differs**: chips per paired gateway, no edit panel | none (client-side) | low | M |
| Session search (`DshProductApp.kt` `SessionSearch`, `LocalChatSearchContent`) | filter by title; offline search of cached chats | **missing** | none for title filter; local cache for offline | low | S (filter) / L (offline cache) |
| Workspace drawer / sidebar (`WorkspaceDrawer.kt`, `ConversationSidebar.kt`) | swipe drawer; wide-screen persistent sidebar | **missing** | none | low | M |
| Tablet / foldable layouts (`AdaptiveLayout.kt`) | columns, reading width, hinge | **missing** | none | low | L |
| Session context menu: rename / archive (`SessionContextMenu.kt`, `RenameSessionDialog.kt`) | long-press row | **missing** | `session-rename`, `session-archive` — admin-only (`allowlist.mjs:92`) | med | M |
| Animated background, whale mark (`HarnessAnimatedBackground.kt`, `OceanMeshBackground.kt`) | brand visuals | **missing** (deliberately plain) | none | low | M |

## 2. Conversation

| Feature | Behaviour | Ours | Gateway needs | Risk | Effort |
|---|---|---|---|---|---|
| Markdown, code, tables (`DshMarkdownText.kt`, `DshMarkdownCodeCard.kt`, `DshMarkdownTable.kt`) | rich render; code card with copy; table full-screen, rotate, copy, CSV | **differs**: markdown + scrolling table grid; no code card actions, no full-screen table | none | low | M |
| Reasoning / tool process rows (`ConversationScreen.kt` `ProcessReasoningDisclosure`, `ProcessToolBundle`) | collapsible reasoning and tool bundles with icons | **differs**: "N bước" collapsed tool group; no reasoning disclosure | reasoning events already in history (c) | low | S |
| Text selection page, copy button (`DshMarkdownSelectionPage.kt`, `CopyButton`) | dedicated select/copy screen | **differs**: `selectable` text + Share | none; Clipboard needs native build | low | S |
| Image attachments / preview (`UserAttachmentPreview`, `ConversationImagePreviewDialog`) | view, zoom, save | **missing** | `session/attachment` read — denied (`allowlist.mjs:118`) | med | M |
| Scroll-to-bottom, pinned tail (`ScrollToBottomButton`) | jump to latest | **missing** (c) | none | low | S |
| Session stats (`SessionStatusUi.kt` `SessionStatsSheet`) | tokens, TTFT, throughput, cache hit | **missing** | `session-stats`, `context-usage` — admin-only (`:99`) | low | M |
| Context usage ring (`ContextUsageRing`) | context fill indicator | **missing** | `context-usage` — admin-only | low | S |
| Agent traces (`TrajectoryUi.kt`, `TrajectoryDetailUi.kt`) | timeline of user/assistant/tool events with args, schema, usage | **missing** | events in history (b: rev 9.2); tool schema/usage maybe not (c) | low | L |
| Human questions (`HumanQuestionCard.kt`) | answer / cancel agent questions | **missing** (we only do tool approvals) | `question-answer`, `question-cancel` — admin-only (`:101`) | med | M |
| Tool approvals (`ApprovalRequestCard.kt`) | approve / reject | **have** | `approval-response` | med | — |
| Task / goal panels (`TaskGoalUi.kt`) | show tasks, edit/pause goal | **missing** | `tasks`, `goal*` — admin-only (`:98-99`) | med | M |
| Agent team (`TeamUi.kt`) | members, switch member conversation, shared tasks | **missing** | `agent-team`, `subagents` — admin-only (`:93`) | low | M |

## 3. Composer

| Feature | Behaviour | Ours | Gateway needs | Risk | Effort |
|---|---|---|---|---|---|
| Model picker (`ModelControl`, `currentModel*`) | provider groups + reasoning effort | **differs**: provider groups; no reasoning effort | `select-model` (author scope) has effort field? (c) | med | S |
| Agent preset control (`SessionAgentPresetControl`, `AgentPresetLabels.kt`) | choose preset per session | **missing** | `agent-presets`, `session-agent-preset` — admin-only (`:82`) | med | S |
| Permission control (`PermissionControl`) | read-only / workspace-write / danger-full-access | **missing** | `permission*` — admin-only (`:80`) | **high** | M + reviewer |
| Queue dock (`QueueDock`, `QueueAction`) | view/edit queued messages | **missing** | `queue-update` — admin-only (`:92`) | med | M |
| Slash commands (`SlashCommandMenus`) | host commands | **missing** | `commands`, `command-execute` — admin-only (`:88`) | **high** | M + reviewer |
| Reply / quote (`ComposerReplyPreview.kt`, `SentReplyBubble.kt`) | quote a message | **missing** | none (client formats prompt) (c) | low | S |
| File upload (`PendingFileCard.kt`) | attach, progress, retry | **missing** for phone (desktop-only `attachments:write`, rev 8) | extend rev 8 to mobile kind | **high** | L + reviewer |
| Voice input (`VoiceInputPanel.kt`) | hold to talk, host transcribes | **missing** | `speech-*` — admin-only (`:89-90`) | med | L |

## 4. Workspace and files

| Feature | Behaviour | Ours | Gateway needs | Risk | Effort |
|---|---|---|---|---|---|
| Workspace selection / create (`WorkspaceDirectoryUi.kt`) | pick, browse directories, create workspace | **differs**: pick only | `directories`, `workspace-create` — admin-only; `workspace/create` denied endpoint (`:114`) | **high** | M + reviewer |
| File browser (`WorkspaceFilesUi.kt`) | list, download verified chunks, open externally | **missing** | `file-list`, `file-download-*` — admin-only (`:85`) | **high** | L + reviewer |
| Previews: code, markdown, PDF, image, video (`WorkspaceCodePreviewUi.kt`, `WorkspaceFilePreviewUi.kt`, `WorkspaceMediaPreviewUi.kt`) | in-app preview | **missing** | same as file browser | **high** | L |

## 5. Settings, gateway, device

| Feature | Behaviour | Ours | Gateway needs | Risk | Effort |
|---|---|---|---|---|---|
| Pairing: QR + manual (`GatewayAuthenticationUi.kt`) | scan QR, paste details | **have** (own design) | — | high (done, reviewed) | — |
| Settings: appearance, language, font size (`SettingsScreen.kt`, `FontSizeSettingsScreen.kt`, `AppearanceSettings.kt`) | theme, language, text scale, reduced effects | **differs**: theme follows system, language; no font scale | none | low | S |
| Default model / agent preset (`SettingsScreen.kt` `DefaultModelSelectionScreen`, `AgentPresetSelectionScreen`) | host defaults | **missing** | `default-model`, `save-default-model`, `agent-presets` — admin-only | **high** (host config) | M + reviewer |
| Tailscale tunnel (`TailscaleTunnelScreen.kt`) | embedded tunnel accounts | **missing** | none (client) but embeds a network stack (c) | high | L |
| Network diagnostics (`NetworkDiagnosticsPanel.kt`) | RTT/throughput charts | **missing** | none | low | M |
| Storage space (`StorageSpaceScreen.kt`) | cache usage, clear by category | **missing** | none | low | S |
| Log export (`LogExportScreen.kt`) | export app logs for a range | **missing** | none; must respect redaction | med | M |
| In-app update (`AppUpdateDialogs.kt`) | check & install APK | **missing** (store-distributed later) | none | med | — (skip) |
| Privacy policy (`PrivacyPolicySheet.kt`) | sheet | **missing** | none | low | S |

## 6. Scheduled tasks and plugins

| Feature | Behaviour | Ours | Gateway needs | Risk | Effort |
|---|---|---|---|---|---|
| Scheduled tasks (`ScheduledTasksScreen.kt`, `ScheduledTaskEditSheet.kt`, `Schedule*.kt`) | list, search, history, edit, delete, create | **missing** | `schedule-*` — admin-only (`:95-97`); `schedule/*` denied endpoint | med (read) / **high** (edit) | L |
| Plugins (`PluginsScreen.kt`) | catalog, details, install, enable, configure | **missing** | `plugin-*` — admin-only (`:73-77`) | **high** | L + reviewer |

## 7. Platform

| Feature | Behaviour | Ours | Notes | Risk | Effort |
|---|---|---|---|---|---|
| iOS Live Activities / notifications | lock-screen progress | **missing** | push is owner-gated (APNs/FCM) | med | L |
| Haptics, liquid-glass menus (`ClickHapticFeedback.kt`, `DshLiquidGlass.kt`, `DshMenu*.kt`) | polish | **missing** | haptics need native module | low | M |
| Vector icons | icon font | **missing**: glyph/View icons only | bundle-swap cannot add fonts; needs a real gradle/EAS build (a, this round) | low | S once native build exists |

## Proposed order (c)

1. **Wave 1 — high value, low risk, no new gateway surface:** session search (title filter),
   scroll-to-bottom, reasoning disclosure, code-card copy + full-screen table, reply/quote, font size,
   storage space, privacy sheet, one real native build to get vector icons + clipboard.
2. **Wave 2 — read-only gateway surface (new scopes, reviewer on each):** session stats + context
   usage, agent team / subagents view, task/goal panels (read), human questions (answer/cancel),
   scheduled tasks (read), session rename/archive, agent preset per session.
3. **Wave 3 — high risk, owner decision per item:** file browser + previews, phone file upload,
   slash commands, permission control, default model/preset, workspace create, plugins, voice,
   Tailscale tunnel.
