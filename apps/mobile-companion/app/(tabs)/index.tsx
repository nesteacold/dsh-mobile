// Spec 011 parity — the single list screen (references 01/02/03 in specs/011-*/reference/).
//
// Ported from Clarklevis1995/dsh-mobile (MIT): DshProductApp.kt (list + composer),
// GatewaySwitcherUi.kt (source sheet, ref 02), WorkspaceDirectoryUi.kt (grouped sections, ref 01),
// SessionStatusUi.kt (status dot) and the group/filter menu (ref 03).
//
// What changed from the P1-A shell: ONE screen, no bottom tab bar. The list IS the app —
// header ("All Tasks" + source chevron, circular ⋯), a chip row of sources, collapsible
// workspace sections of dot+title rows, and a floating pill composer that creates a session.
// Settings is a pushed screen (from the ⋯ menu), not a tab.
//
// KNOWN DATA GAP (reported to the lead): the gateway projects session rows to title-only, so a row
// carries NO workspace identity today. Grouping therefore renders one honest "All sessions" section
// unless rows start reporting a workspace; the code already groups by `workspaceId` the moment the
// store exposes it. Nothing is invented to fake the reference's per-workspace sections.

import { useCallback, useEffect, useMemo, useState } from 'react';
import { ActivityIndicator, Modal, Pressable, StyleSheet, Text, TextInput, View } from 'react-native';
import { FlashList } from '@shopify/flash-list';
import { useRouter } from 'expo-router';
import { useSafeAreaInsets } from 'react-native-safe-area-context';

import { reconnectInProgress } from '../../src/app-state';
import { isSubagentSession, type SessionSummary } from '../../src/core/sessions';
import { sessionDisplayTitle } from '../../src/ui/session-title';
import {
  MAX_TITLE_CHARS,
  canArchiveSession,
  canRenameSession,
  sessionActionErrorKey,
  titleProblem,
} from '../../src/ui/conversation/session-actions';
import { groupSessionsByWorkspace } from '../../src/ui/workspace-groups';
import { filterSessionsByTitle } from '../../src/ui/session-search';
import {
  applyListFilters,
  DATE_FILTERS,
  DEFAULT_LIST_FILTERS,
  hasActiveFilters,
  LIST_FILTER_CAPABILITIES,
  STATUS_FILTERS,
  type ListDateFilter,
  type ListFilters,
  type ListStatusFilter,
} from '../../src/ui/list-filters';
import { grantState, newSessionAvailability, type LoadState } from '../../src/ui/components/authoring';
import { elevation, hit, radius, space, useTheme } from '../../src/ui/theme';
import { useApp } from '../_layout';
import { t, type MessageKey } from '../../i18n';

/** One row of the flat list: a collapsible section header, or a session. */
type ListItem =
  | { kind: 'section'; id: string; title: string; count: number; collapsed: boolean }
  | { kind: 'session'; id: string; session: SessionSummary };

type GroupMode = 'workspace' | 'none';

export default function ListScreen() {
  const { controller, snapshot, tr, locale } = useApp();
  /** The Host's own capability statement; drives whether a row offers rename/archive at all. */
  const capabilities = snapshot.capabilities ?? [];
  const renameOffered = canRenameSession(capabilities);
  const archiveOffered = canArchiveSession(capabilities);
  const router = useRouter();
  const insets = useSafeAreaInsets();
  const { colors, type } = useTheme();

  const [menuOpen, setMenuOpen] = useState(false);
  // Filters from the ⋯ menu. Only Date and Status are offered: archived and online have no data
  // behind them yet (see LIST_FILTER_CAPABILITIES), so their rows stay out of the menu entirely.
  const [filters, setFilters] = useState<ListFilters>(DEFAULT_LIST_FILTERS);
  const [sourceOpen, setSourceOpen] = useState(false);
  const [groupMode, setGroupMode] = useState<GroupMode>('workspace');
  const [showSubagents, setShowSubagents] = useState(false);
  const [collapsed, setCollapsed] = useState<ReadonlySet<string>>(new Set());
  const [draft, setDraft] = useState('');
  const [creating, setCreating] = useState(false);
  const [createError, setCreateError] = useState<{ code: string; message?: string } | null>(null);
  const [workspaceId, setWorkspaceId] = useState<string | null>(null);
  /** Session title search (reference `SessionSearch`); matching rules live in src/ui/session-search.ts. */
  const [query, setQuery] = useState('');
  /**
   * Measured height of the floating composer. The list is padded by exactly this much, so the last
   * row can never sit underneath the pill (on device the final row rendered through it).
   */
  const [composerHeight, setComposerHeight] = useState(0);
  /**
   * Spec 011 P2 item 4: rename / archive of one row, opened by a long press.
   *
   * The controls only EXIST when the Host advertised the op (`snapshot.capabilities`), so today — with
   * the contract still lacking `session-rename`/`session-archive` — a long press does nothing and no
   * menu is drawn. That is the spec's "no button without something behind it", not a missing feature.
   */
  const [rowActions, setRowActions] = useState<{ sessionId: string; title: string } | null>(null);
  const [renameDraft, setRenameDraft] = useState('');
  const [rowBusy, setRowBusy] = useState(false);
  const [rowError, setRowError] = useState<string | null>(null);
  /** `null` means the draft is savable; otherwise it names the problem shown beside the field. */
  const renameProblem = titleProblem(renameDraft);

  /**
   * Rename the open row. A refusal REJECTS with `CoreError` from the accessor (never a silent no-op),
   * so this catches it and shows the CODE-mapped sentence — never the Host's raw message.
   */
  const submitRename = async () => {
    if (rowActions === null || renameProblem !== null) return;
    setRowBusy(true);
    setRowError(null);
    try {
      const outcome = await controller.renameSession(rowActions.sessionId, renameDraft);
      if (!outcome.ok) setRowError(tr(sessionActionErrorKey(outcome.code)));
      else setRowActions(null);
    } catch (error) {
      setRowError(tr(sessionActionErrorKey((error as { code?: string } | null)?.code)));
    } finally {
      setRowBusy(false);
    }
  };

  const submitArchive = async () => {
    if (rowActions === null) return;
    setRowBusy(true);
    setRowError(null);
    try {
      const outcome = await controller.archiveSession(rowActions.sessionId);
      if (!outcome.ok) setRowError(tr(sessionActionErrorKey(outcome.code)));
      else setRowActions(null);
    } catch (error) {
      setRowError(tr(sessionActionErrorKey((error as { code?: string } | null)?.code)));
    } finally {
      setRowBusy(false);
    }
  };

  const grant = grantState(snapshot.grantedScopes);
  const banner = snapshot.banner !== 'none' ? t(locale, bannerKey(snapshot.banner)) : null;
  const bannerWarn = snapshot.banner === 'offline' || snapshot.banner === 'gateway-off'
    || snapshot.banner === 'cleanup-failed';
  const workspacesState: LoadState = snapshot.workspacesState === 'error'
    ? { status: 'error', ...(snapshot.workspacesError === null ? {} : { code: snapshot.workspacesError }) }
    : { status: snapshot.workspacesState };
  const availability = newSessionAvailability({
    grantedScopes: snapshot.grantedScopes,
    workspaceId,
    state: workspacesState,
    workspaceCount: snapshot.workspaces.length,
    busy: creating,
    connection: snapshot.connection,
    reconnecting: reconnectInProgress(snapshot.reconnect),
  });

  // Load the workspace list once per connection, only when the device may author at all.
  useEffect(() => {
    if (snapshot.connection !== 'ready' || grant !== 'granted') return;
    if (snapshot.workspacesState !== 'idle') return;
    void controller.listWorkspaces();
  }, [controller, grant, snapshot.connection, snapshot.workspacesState]);

  // Preselect the first host-reported workspace so the composer is usable immediately.
  useEffect(() => {
    if (workspaceId !== null) return;
    const first = snapshot.workspaces[0];
    if (first !== undefined) setWorkspaceId(first.id);
  }, [snapshot.workspaces, workspaceId]);

  const visible = useMemo(
    () => snapshot.sessions.filter((session) => showSubagents || !isSubagentSession(session)),
    [showSubagents, snapshot.sessions],
  );
  const subagentCount = useMemo(
    () => snapshot.sessions.filter(isSubagentSession).length,
    [snapshot.sessions],
  );

  /**
   * Flat array of section headers + rows (FlashList renders sections without a section-list API).
   *
   * Order: subagent visibility → ⋯ menu filters (date, status) → title search. Filters come before the
   * search so the search never resurrects a row the filter dropped.
   */
  const searched = useMemo(
    () => filterSessionsByTitle(
      applyListFilters(visible, filters, Date.now()),
      query,
      tr,
      locale,
    ),
    [visible, filters, query, tr, locale],
  );

  const items = useMemo<readonly ListItem[]>(() => {
    // Grouping names come from `groupSessionsByWorkspace`: session `workspaceLabel` first, then the
    // paired workspaces entry, then ONE trailing "Other" bucket — the raw id is never a header.
    const groups = groupMode === 'none'
      ? [{
          key: '\u0000all',
          label: tr('list.ungrouped'),
          isOther: false,
          sessions: [...searched].sort((left, right) => right.updatedAt - left.updatedAt),
        }]
      : groupSessionsByWorkspace(searched, snapshot.workspaces);
    const flat: ListItem[] = [];
    for (const group of groups) {
      const title = group.label ?? tr('list.other');
      flat.push({
        kind: 'section',
        id: `section-${group.key}`,
        title,
        count: group.sessions.length,
        collapsed: collapsed.has(group.key),
      });
      if (!collapsed.has(group.key)) {
        for (const session of group.sessions) flat.push({ kind: 'session', id: session.id, session });
      }
    }
    return flat;
  }, [collapsed, groupMode, snapshot.workspaces, tr, searched]);

  const toggleSection = useCallback((key: string) => {
    setCollapsed((current) => {
      const next = new Set(current);
      if (next.has(key)) next.delete(key);
      else next.add(key);
      return next;
    });
  }, []);

  const canSend = availability.enabled && draft.trim() !== '' && !creating;

  const send = useCallback(async () => {
    const text = draft.trim();
    if (text === '' || !availability.enabled || workspaceId === null) return;
    setCreating(true);
    setCreateError(null);
    const created = await controller.createSession({ workspaceId });
    if (!created.ok) {
      setCreating(false);
      // Show WHY, not just "failed": on device a silent no-op is indistinguishable from a dead button.
      // The Host's own message is carried through when it supplied one.
      setCreateError({ code: created.code, ...(created.message === undefined ? {} : { message: created.message }) });
      return;
    }
    // The typed text IS the first prompt: the old code created an empty session and dropped it.
    // `sendPrompt` targets the OPEN session, and `createSession` does not open one, so the new
    // session is opened here first. `openSession` is idempotent — the session screen calls it again
    // on mount with the same id.
    controller.openSession(created.value);
    try {
      await controller.sendPrompt(text);
    } catch {
      // The prompt is queued in the outbox, so it is not lost; navigation below still shows the session.
    }
    setCreating(false);
    setDraft('');
    router.push(`/session/${encodeURIComponent(created.value)}`);
  }, [availability.enabled, controller, draft, router, workspaceId]);

  return (
    <View testID="workspace-home" style={[styles.root, { backgroundColor: colors.bg, paddingTop: insets.top }]}>
      {/* Header: source switcher (ref 02) + the ⋯ menu (ref 03). */}
      <View style={styles.header}>
        <Pressable
          testID="list-source"
          accessibilityRole="button"
          accessibilityLabel={tr('list.title')}
          onPress={() => setSourceOpen(true)}
          style={styles.headerTitle}
        >
          {/* Drawn 2×2 grid: the APK ships NO font files, so an icon-font glyph would be invisible.
              Views always render. */}
          <View style={styles.gridGlyph}>
            {[0, 1, 2, 3].map((cell) => (
              <View key={cell} style={[styles.gridCell, { backgroundColor: colors.text }]} />
            ))}
          </View>
          <Text style={[type.title, { color: colors.text }]}>{tr('list.title')}</Text>
          {/* Centred so the glyph cannot sit on the baseline. */}
          <View style={styles.chevronSlot}>
            <Text style={[type.caption, { color: colors.textMuted }]}>⌄</Text>
          </View>
        </Pressable>
        <Pressable
          testID="list-menu"
          accessibilityRole="button"
          accessibilityLabel={tr('list.more')}
          onPress={() => setMenuOpen(true)}
          style={[styles.menuButton, { backgroundColor: colors.surfaceRaised, minWidth: hit, minHeight: hit }]}
        >
          <Text style={[type.subheading, { color: colors.text }]}>⋯</Text>
        </Pressable>
      </View>

      {/* Chips: All + one per paired gateway (ref 01). */}
      <View style={styles.chips}>
        <View style={[styles.chip, { backgroundColor: colors.text, borderRadius: radius.pill }]}>
          <Text style={[type.caption, { color: colors.bg }]}>{tr('list.all')}</Text>
        </View>
        {snapshot.hosts.map((host) => (
          <View
            key={host.gatewayId}
            testID={`chip-${host.gatewayId}`}
            style={[styles.chip, { backgroundColor: colors.surfaceRaised, borderRadius: radius.pill }]}
          >
            {/* Drawn monitor: same reason as the grid — no font assets in the APK. */}
            <View style={[styles.monitorGlyph, { borderColor: colors.textMuted }]}>
              <View style={[styles.monitorStand, { backgroundColor: colors.textMuted }]} />
            </View>
            <Text numberOfLines={1} style={[type.caption, { color: colors.text }]}>{host.name}</Text>
          </View>
        ))}
      </View>

      {/* Reconnect / offline / revoked banner — restored after the tab-bar removal dropped it. The
          list is where a user notices a dead link, so the reason must be visible here, not just in
          the conversation screen. */}
      <Banner banner={banner} warn={bannerWarn} />

      {/* Title search (reference: SessionSearch). Locale-independent testID for maestro. */}
      {snapshot.activeHost === null ? null : (
        <TextInput
          testID="list-search"
          accessibilityLabel={tr('list.search')}
          placeholder={tr('list.searchPlaceholder')}
          placeholderTextColor={colors.textMuted}
          value={query}
          onChangeText={setQuery}
          autoCorrect={false}
          autoCapitalize="none"
          returnKeyType="search"
          style={[
            styles.search,
            {
              color: colors.text,
              backgroundColor: colors.surface,
              borderColor: colors.border,
              // Text glyphs only: no icon font exists in the APK, so the clear control is text.
            },
          ]}
        />
      )}

      {snapshot.activeHost === null ? (
        <View style={styles.center}>
          <Text style={[type.subheading, { color: colors.text }]}>{tr('home.emptyTitle')}</Text>
          <Pressable
            accessibilityRole="button"
            accessibilityLabel={tr('sessions.pair')}
            onPress={() => router.push('/pair')}
            style={{ minHeight: hit, justifyContent: 'center' }}
          >
            <Text style={[type.caption, { color: colors.accent }]}>{tr('sessions.pair')}</Text>
          </Pressable>
        </View>
      ) : query.trim() !== '' && searched.length === 0 ? (
        <View style={styles.center}>
          <Text style={[type.body, { color: colors.textMuted }]} testID="list-no-matches">
            {tr('list.noMatches')}
          </Text>
        </View>
      ) : (
        // The list VIEWPORT ends above the floating composer. Scroll padding alone was not enough:
        // the composer is absolutely positioned, so rows kept rendering in the strip beside and below
        // the capsule and the last row stayed visible underneath it when scrolled to the end.
        // `overflow: 'hidden'` makes the viewport actually CLIP: without it, on Android a row's text
        // was drawn above the list's top edge, over the search field's margin (a background colour
        // cannot mask that — children paint over their parent, and the list renders after the search).
        //
        // `marginTop: 12` is the breathing room between the search field and the first row. It sits on
        // the clipping box, not on the list's content, so it is OUTSIDE the region that clips: the gap
        // shows the screen background and the clip still starts at the list's own top edge.
        <View
          style={{
            flex: 1,
            marginTop: 12,
            paddingBottom: composerHeight,
            backgroundColor: colors.bg,
            overflow: 'hidden',
          }}
        >
        <FlashList
          data={items as ListItem[]}
          keyExtractor={(item) => `${item.kind}:${item.id}`}
          // Tapping Send while the keyboard is up must reach the button, not just dismiss the keyboard.
          keyboardShouldPersistTaps="handled"
          contentContainerStyle={{ paddingBottom: space.lg }}
          renderItem={({ item }) =>
            item.kind === 'section' ? (
              <Pressable
                testID={item.id}
                accessibilityRole="button"
                accessibilityLabel={item.title}
                accessibilityState={{ expanded: !item.collapsed }}
                onPress={() => toggleSection(item.id.replace(/^section-/, ''))}
                style={[styles.section, { minHeight: hit }]}
              >
                {/* Folder drawn with Views (reference 01): no font assets exist in the APK, so a
                    glyph would be tofu — same approach as the monitor chip. */}
                <View style={[styles.folderGlyph, { borderColor: colors.textMuted }]}>
                  <View style={[styles.folderTab, { backgroundColor: colors.textMuted }]} />
                </View>
                <Text style={[type.subheading, { color: colors.text, flex: 1 }]} numberOfLines={1}>{item.title}</Text>
                <View style={styles.chevronSlot}>
                  <Text style={[type.caption, { color: colors.textMuted }]}>{item.collapsed ? '⌄' : '⌃'}</Text>
                </View>
              </Pressable>
            ) : (
              <Pressable
                testID={`session-row-${item.session.id}`}
                accessibilityRole="button"
                accessibilityLabel={sessionDisplayTitle(item.session, tr, locale)}
                onPress={() => router.push(`/session/${encodeURIComponent(item.session.id)}`)}
                onLongPress={
                  renameOffered || archiveOffered
                    ? () => {
                        const title = sessionDisplayTitle(item.session, tr, locale);
                        setRenameDraft(title);
                        setRowError(null);
                        setRowActions({ sessionId: item.session.id, title });
                      }
                    : undefined
                }
                delayLongPress={500}
                style={[styles.row, { minHeight: hit }]}
              >
                <View
                  style={[styles.dot, {
                    backgroundColor: item.session.state === 'running' || item.session.needsDecision
                      ? colors.accent
                      : colors.textFaint,
                  }]}
                />
                <Text numberOfLines={1} style={[type.body, { color: colors.text, flex: 1 }]}>
                  {sessionDisplayTitle(item.session, tr, locale)}
                </Text>
              </Pressable>
            )
          }
          ListFooterComponent={
            <>
              {subagentCount === 0 ? null : (
                <Pressable
                  testID="list-subagents-reveal"
                  accessibilityRole="button"
                  accessibilityLabel={showSubagents
                    ? tr('home.hideSubagents')
                    : tr('home.showSubagents', { count: subagentCount })}
                  onPress={() => setShowSubagents((current) => !current)}
                  style={[styles.reveal, { minHeight: hit }]}
                >
                  <Text style={[type.caption, { color: colors.accent }]}>
                    {showSubagents
                      ? tr('home.hideSubagents')
                      : tr('home.showSubagents', { count: subagentCount })}
                  </Text>
                </Pressable>
              )}
            </>
          }
        />
        </View>
      )}

      {/* Floating pill composer: + / placeholder / send. No mic (the app has no voice feature). */}
      <View
        onLayout={(event) => setComposerHeight(event.nativeEvent.layout.height)}
        style={[styles.composerWrap, { paddingBottom: insets.bottom + space.sm }]}
      >
        <View style={[styles.composer, { backgroundColor: colors.surfaceRaised, borderRadius: radius.pill }]}>
          <Pressable
            testID="list-composer-plus"
            accessibilityRole="button"
            accessibilityLabel={tr('authoring.workspacePlaceholder')}
            onPress={() => setSourceOpen(true)}
            style={[styles.plus, { minWidth: hit, minHeight: hit }]}
          >
            <Text style={[type.subheading, { color: colors.text }]}>+</Text>
          </Pressable>
          <TextInput
            testID="list-composer-input"
            style={[type.body, { color: colors.text, flex: 1 }]}
            value={draft}
            onChangeText={setDraft}
            placeholder={tr('list.composerPlaceholder')}
            placeholderTextColor={colors.textFaint}
            accessibilityLabel={tr('list.composerPlaceholder')}
            onSubmitEditing={() => void send()}
            editable={availability.enabled && !creating}
          />
          {/* Legacy hook kept on the create action so the authoring flows (15–18) and the maestro
              subflows keep working without edits: this button IS "New session" now. */}
          {/* Round 44pt send, same kind as the conversation composer: accent disc with an arrow
              glyph, quiet disc + muted arrow when it cannot send. */}
          <Pressable
            testID="new-session"
            accessibilityRole="button"
            accessibilityLabel={tr('session.send')}
            accessibilityState={{ disabled: !canSend, busy: creating }}
            disabled={!canSend}
            onPress={() => void send()}
            style={[styles.send, {
              backgroundColor: canSend ? colors.accent : colors.disabledFill,
              width: hit,
              height: hit,
              borderRadius: radius.pill,
            }]}
          >
            {creating ? <ActivityIndicator color={colors.onAccent} /> : (
              <Text style={[type.subheading, { color: canSend ? colors.onAccent : colors.disabledLabel }]}>↑</Text>
            )}
          </Pressable>
        </View>
        {/* The reason the composer is inert, in the same honest style as before. */}
        {availability.enabled ? null : (
          <Text testID="new-session-reason" style={[type.captionSmall, { color: colors.textMuted, paddingTop: space.xs, paddingHorizontal: space.sm }]}>
            {tr(availability.reason ?? 'authoring.needWorkspace')}
          </Text>
        )}
        {createError === null ? null : (
          <Text testID="new-session-error" style={[type.captionSmall, { color: colors.danger, paddingTop: space.xs, paddingHorizontal: space.sm }]}>
            {createError.code === 'remote/argument-denied'
              // The Host no longer has that workspace: say what to do, not just what failed. The list is
              // refreshed by the controller, so reopening "+" offers real workspaces.
              ? tr('authoring.workspaceGone')
              : `${tr('authoring.createFailed')} (${createError.code})`}
            {createError.message === undefined ? '' : ` — ${createError.message}`}
          </Text>
        )}
      </View>

      {/* Source switcher (ref 02) */}
      <Modal visible={sourceOpen} transparent animationType="fade" onRequestClose={() => setSourceOpen(false)}>
        <Pressable style={styles.backdrop} accessibilityRole="button" accessibilityLabel={tr('authoring.close')} onPress={() => setSourceOpen(false)}>
          <View style={[styles.sheet, { backgroundColor: colors.surfaceRaised, borderRadius: radius.lg }]}>
            <Text style={[type.captionSmall, { color: colors.textMuted }]}>{tr('authoring.workspaceTitle')}</Text>
            {snapshot.workspaces.length === 0 ? (
              <Text style={[type.caption, { color: colors.textMuted }]}>{tr('authoring.workspacesEmpty')}</Text>
            ) : snapshot.workspaces.map((workspace) => (
              <Pressable
                key={workspace.id}
                testID={`workspace-option-${workspace.id}`}
                accessibilityRole="button"
                accessibilityLabel={workspace.name ?? workspace.id}
                onPress={() => {
                  setWorkspaceId(workspace.id);
                  setSourceOpen(false);
                }}
                style={[styles.sheetRow, { minHeight: hit }]}
              >
                <Text style={[type.body, { color: colors.text, flex: 1 }]} numberOfLines={1}>
                  {workspace.name ?? workspace.path ?? workspace.id}
                </Text>
                {workspaceId === workspace.id ? (
                  <Text style={[type.caption, { color: colors.accent }]}>✓</Text>
                ) : null}
              </Pressable>
            ))}
          </View>
        </Pressable>
      </Modal>

      {/* ⋯ menu (ref 03). Items with no real data behind them (Archived, Online-only) are OMITTED. */}
      <Modal visible={menuOpen} transparent animationType="fade" onRequestClose={() => setMenuOpen(false)}>
        <Pressable style={styles.backdrop} accessibilityRole="button" accessibilityLabel={tr('authoring.close')} onPress={() => setMenuOpen(false)}>
          <View style={[styles.sheet, { backgroundColor: colors.surfaceRaised, borderRadius: radius.lg }]}>
            <Text style={[type.captionSmall, { color: colors.textMuted }]}>{tr('list.groupBy')}</Text>
            {(['workspace', 'none'] as const).map((mode) => (
              <Pressable
                key={mode}
                testID={`menu-group-${mode}`}
                accessibilityRole="button"
                accessibilityLabel={mode === 'workspace' ? tr('authoring.workspaceTitle') : tr('list.ungrouped')}
                onPress={() => {
                  setGroupMode(mode);
                  setCollapsed(new Set());
                  setMenuOpen(false);
                }}
                style={[styles.sheetRow, { minHeight: hit }]}
              >
                {groupMode === mode ? (
                  <Text style={[type.caption, { color: colors.text, width: 20 }]}>✓</Text>
                ) : <View style={{ width: 20 }} />}
                <Text style={[type.body, { color: colors.text, flex: 1 }]}>
                  {mode === 'workspace' ? tr('authoring.workspaceTitle') : tr('list.ungrouped')}
                </Text>
              </Pressable>
            ))}
            <Pressable
              testID="menu-subagents"
              accessibilityRole="button"
              accessibilityLabel={showSubagents ? tr('home.hideSubagents') : tr('home.showSubagents', { count: subagentCount })}
              onPress={() => setShowSubagents((current) => !current)}
              style={[styles.sheetRow, { minHeight: hit }]}
            >
              {showSubagents ? (
                <Text style={[type.caption, { color: colors.text, width: 20 }]}>✓</Text>
              ) : <View style={{ width: 20 }} />}
              <Text style={[type.body, { color: colors.text, flex: 1 }]}>
                {tr('home.showSubagents', { count: subagentCount })}
              </Text>
            </Pressable>
            <View style={[styles.divider, { backgroundColor: colors.border }]} />
            {/* Date / Status: every value here is backed by a measured field (`updatedAt`, `state`,
                `needsDecision`). The two rows below them are conditional — see
                LIST_FILTER_CAPABILITIES — so the menu never shows a filter that cannot work. */}
            <Text style={[type.captionSmall, { color: colors.textMuted }]}>{tr('list.groupDate')}</Text>
            {/* Hooks are STATIC literals, one per value, enumerated on purpose: a template literal
                like `menu-date-${value}` made the hook depend on a variable, which the hook-shape
                guard forbids (and rightly — a flow must be able to name the row it taps). */}
            <FilterRow
              testID="menu-date-any"
              label={tr('list.date.any')}
              selected={filters.date === 'any'}
              onPress={() => setFilters((current) => ({ ...current, date: 'any' }))}
            />
            <FilterRow
              testID="menu-date-today"
              label={tr('list.date.today')}
              selected={filters.date === 'today'}
              onPress={() => setFilters((current) => ({ ...current, date: 'today' }))}
            />
            <FilterRow
              testID="menu-date-week"
              label={tr('list.date.week')}
              selected={filters.date === 'week'}
              onPress={() => setFilters((current) => ({ ...current, date: 'week' }))}
            />
            <FilterRow
              testID="menu-date-older"
              label={tr('list.date.older')}
              selected={filters.date === 'older'}
              onPress={() => setFilters((current) => ({ ...current, date: 'older' }))}
            />
            <Text style={[type.captionSmall, { color: colors.textMuted }]}>{tr('list.groupStatus')}</Text>
            <FilterRow
              testID="menu-status-any"
              label={tr('list.status.any')}
              selected={filters.status === 'any'}
              onPress={() => setFilters((current) => ({ ...current, status: 'any' }))}
            />
            <FilterRow
              testID="menu-status-running"
              label={tr('list.status.running')}
              selected={filters.status === 'running'}
              onPress={() => setFilters((current) => ({ ...current, status: 'running' }))}
            />
            <FilterRow
              testID="menu-status-idle"
              label={tr('list.status.idle')}
              selected={filters.status === 'idle'}
              onPress={() => setFilters((current) => ({ ...current, status: 'idle' }))}
            />
            <FilterRow
              testID="menu-status-decision"
              label={tr('list.status.decision')}
              selected={filters.status === 'decision'}
              onPress={() => setFilters((current) => ({ ...current, status: 'decision' }))}
            />
            {LIST_FILTER_CAPABILITIES.archived ? (
              <Text style={[type.body, { color: colors.textMuted, paddingHorizontal: space.sm }]}>
                {tr('list.filterArchived')}
              </Text>
            ) : null}
            {LIST_FILTER_CAPABILITIES.online ? (
              <Text style={[type.body, { color: colors.textMuted, paddingHorizontal: space.sm }]}>
                {tr('list.filterOnline')}
              </Text>
            ) : null}
            {hasActiveFilters(filters) ? (
              <Pressable
                testID="menu-clear-filters"
                accessibilityRole="button"
                accessibilityLabel={tr('list.groupDate')}
                onPress={() => setFilters(DEFAULT_LIST_FILTERS)}
                style={[styles.sheetRow, { minHeight: hit }]}
              >
                <Text style={[type.body, { color: colors.accent, flex: 1 }]}>✕</Text>
              </Pressable>
            ) : null}
            <View style={[styles.divider, { backgroundColor: colors.border }]} />
            <Pressable
              testID="tab-settings"
              accessibilityRole="button"
              accessibilityLabel={tr('settings.title')}
              onPress={() => {
                setMenuOpen(false);
                router.push('/settings');
              }}
              style={[styles.sheetRow, { minHeight: hit }]}
            >
              <Text style={[type.body, { color: colors.text }]}>{tr('settings.title')}</Text>
            </Pressable>
          </View>
        </Pressable>
      </Modal>

      {/* Spec 011 P2 item 4: rename / archive one session, from a long press on its row.
          Only reachable when the Host advertised the op — see `renameOffered`/`archiveOffered`. */}
      <Modal
        visible={rowActions !== null}
        transparent
        animationType="fade"
        onRequestClose={() => setRowActions(null)}
      >
        <Pressable
          style={styles.backdrop}
          onPress={() => (rowBusy ? undefined : setRowActions(null))}
          accessibilityRole="button"
          accessibilityLabel={tr('common.cancel')}
        >
          <View
            style={[
              styles.sheet,
              { backgroundColor: colors.surfaceRaised, borderColor: colors.border, padding: space.lg, gap: space.md },
            ]}
          >
            {renameOffered ? (
              <View style={{ gap: space.sm }} testID="session-rename-block">
                <Text style={[type.caption, { color: colors.textMuted }]}>{tr('sessionActions.renameTitle')}</Text>
                <TextInput
                  testID="session-rename-input"
                  value={renameDraft}
                  onChangeText={setRenameDraft}
                  maxLength={MAX_TITLE_CHARS + 40}
                  editable={!rowBusy}
                  autoFocus
                  style={[
                    type.body,
                    {
                      color: colors.text,
                      backgroundColor: colors.surface,
                      borderColor: colors.border,
                      borderWidth: StyleSheet.hairlineWidth,
                      borderRadius: radius.md,
                      paddingHorizontal: space.md,
                      paddingVertical: space.sm,
                      minHeight: hit,
                    },
                  ]}
                />
                {/* The problem is stated inline and Save is withheld while it exists, so the dialog
                    cannot hand the accessor a title it would have to refuse. */}
                {renameProblem === null ? null : (
                  <Text style={[type.captionSmall, { color: colors.danger }]} testID="session-rename-problem">
                    {tr(renameProblem === 'empty' ? 'sessionActions.renameEmpty' : 'sessionActions.renameTooLong')}
                  </Text>
                )}
                <Pressable
                  testID="session-rename-save"
                  accessibilityRole="button"
                  accessibilityLabel={tr('sessionActions.save')}
                  accessibilityState={{ disabled: renameProblem !== null || rowBusy }}
                  disabled={renameProblem !== null || rowBusy}
                  onPress={() => void submitRename()}
                  style={[
                    styles.sheetRow,
                    { minHeight: hit, backgroundColor: colors.accent, borderRadius: radius.md, justifyContent: 'center' },
                  ]}
                >
                  <Text style={[type.body, { color: colors.onAccent }]}>{tr('sessionActions.save')}</Text>
                </Pressable>
              </View>
            ) : null}

            {archiveOffered ? (
              <View style={{ gap: space.sm }} testID="session-archive-block">
                <Text style={[type.body, { color: colors.text }]}>{tr('sessionActions.archiveConfirm')}</Text>
                <Text style={[type.captionSmall, { color: colors.textMuted }]}>
                  {tr('sessionActions.archiveConfirmBody')}
                </Text>
                <Pressable
                  testID="session-archive-confirm"
                  accessibilityRole="button"
                  accessibilityLabel={tr('sessionActions.archive')}
                  accessibilityState={{ disabled: rowBusy }}
                  disabled={rowBusy}
                  onPress={() => void submitArchive()}
                  style={[
                    styles.sheetRow,
                    { minHeight: hit, borderRadius: radius.md, borderColor: colors.border, borderWidth: StyleSheet.hairlineWidth, justifyContent: 'center' },
                  ]}
                >
                  <Text style={[type.body, { color: colors.danger }]}>{tr('sessionActions.archive')}</Text>
                </Pressable>
              </View>
            ) : null}

            {rowError === null ? null : (
              <Text style={[type.captionSmall, { color: colors.danger }]} testID="session-action-error">
                {rowError}
              </Text>
            )}
          </View>
        </Pressable>
      </Modal>
    </View>
  );
}

/** One selectable filter row in the ⋯ menu. Static `testID` only: see the call sites. */
function FilterRow(props: {
  testID: string;
  label: string;
  selected: boolean;
  onPress: () => void;
}) {
  const { testID, label, selected, onPress } = props;
  const { colors, type, space } = useTheme();
  return (
    <Pressable
      testID={testID}
      accessibilityRole="button"
      accessibilityLabel={label}
      accessibilityState={{ selected }}
      onPress={onPress}
      // 44 pt minimum target, same as every other sheet row.
      style={[styles.sheetRow, { minHeight: Math.max(44, space.xxl) }]}
    >
      {selected ? (
        <Text style={[type.caption, { color: colors.text, width: 20 }]}>✓</Text>
      ) : <View style={{ width: 20 }} />}
      <Text style={[type.body, { color: colors.text, flex: 1 }]}>{label}</Text>
    </Pressable>
  );
}

/** Why the link is degraded, in one line. Warn-toned for states that need the user's attention. */
function Banner(props: { banner: string | null; warn: boolean }) {
  const { banner, warn } = props;
  const { colors, type } = useTheme();
  if (banner === null) return null;
  return (
    <View
      style={[styles.banner, { backgroundColor: warn ? colors.surfaceRaised : colors.surface }]}
      testID="banner"
      accessibilityLabel={banner}
    >
      <Text style={[type.caption, { color: warn ? colors.warning : colors.accent }]}>{banner}</Text>
    </View>
  );
}

function bannerKey(banner: Exclude<ReturnType<typeof useApp>['snapshot']['banner'], 'none'>): MessageKey {
  switch (banner) {
    case 'reconnecting':
      return 'banner.reconnecting';
    case 'offline':
      return 'banner.offline';
    case 'gateway-off':
      return 'banner.gatewayOff';
    case 'revoked':
      return 'banner.revoked';
    case 'reauth':
      return 'banner.reauth';
    case 'cleanup-failed':
      return 'banner.cleanupFailed';
  }
}

const styles = StyleSheet.create({
  search: {
    marginHorizontal: space.xl,
    marginTop: space.md,
    borderWidth: StyleSheet.hairlineWidth,
    borderRadius: 14,
    paddingHorizontal: space.md,
    minHeight: hit,
  },
  banner: { paddingVertical: space.sm, paddingHorizontal: space.lg },
  root: { flex: 1 },
  header: { flexDirection: 'row', alignItems: 'center', paddingHorizontal: space.lg, paddingVertical: space.md },
  headerTitle: { flexDirection: 'row', alignItems: 'center', gap: space.sm, flex: 1, minHeight: hit },
  gridGlyph: { flexDirection: 'row', flexWrap: 'wrap', width: 14, gap: 2 },
  gridCell: { width: 5, height: 5, borderRadius: 1 },
  chevronSlot: { height: 16, justifyContent: 'center' },
  monitorGlyph: { width: 12, height: 9, borderWidth: StyleSheet.hairlineWidth, borderRadius: 2 },
  monitorStand: { position: 'absolute', bottom: -3, left: 3, width: 5, height: 2 },
  // NOTE: the list footer holds the composer spacer AND the sub-agent reveal. The spacer is a real
  // footer ROW because FlashList does not reliably re-render `contentContainerStyle` when the measured
  // composer height arrives after first paint — that is why the last row sat under the capsule.
  folderGlyph: { width: 15, height: 11, borderWidth: StyleSheet.hairlineWidth, borderRadius: 2 },
  // Folder tab: a plain rectangle. No per-corner radius anywhere in this screen (an Android outline
  // with per-corner radii rendered asymmetrically once already), so its corners stay square.
  folderTab: { position: 'absolute', top: -3, left: -1, width: 7, height: 3 },
  menuButton: { alignItems: 'center', justifyContent: 'center', borderRadius: 999 },
  chips: { flexDirection: 'row', gap: space.sm, paddingHorizontal: space.lg, paddingBottom: space.md, flexWrap: 'wrap' },
  chip: { flexDirection: 'row', alignItems: 'center', gap: space.xs, paddingHorizontal: space.lg, minHeight: 36 },
  section: { flexDirection: 'row', alignItems: 'center', gap: space.sm, paddingHorizontal: space.lg, paddingTop: space.lg },
  row: { flexDirection: 'row', alignItems: 'center', gap: space.md, paddingHorizontal: space.lg, paddingVertical: space.sm },
  dot: { width: 7, height: 7, borderRadius: 999 },
  reveal: { paddingHorizontal: space.lg, paddingVertical: space.md, justifyContent: 'center' },
  center: { flex: 1, alignItems: 'center', justifyContent: 'center', gap: space.sm },
  composerWrap: { position: 'absolute', left: 0, right: 0, bottom: 0, paddingHorizontal: space.lg, paddingTop: space.sm },
  composer: { flexDirection: 'row', alignItems: 'center', gap: space.sm, paddingHorizontal: space.sm, paddingVertical: space.xs },
  plus: { alignItems: 'center', justifyContent: 'center' },
  send: { alignItems: 'center', justifyContent: 'center' },
  backdrop: { flex: 1, backgroundColor: 'rgba(0,0,0,0.45)', paddingTop: 96, paddingHorizontal: space.lg },
  sheet: { padding: space.md, gap: space.xs },
  sheetRow: { flexDirection: 'row', alignItems: 'center', gap: space.sm, paddingHorizontal: space.sm },
  divider: { height: StyleSheet.hairlineWidth, marginVertical: space.xs },
});
