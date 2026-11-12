// UI ported from Clarklevis1995/dsh-mobile androidApp/src/main/kotlin/com/clarklevis/dsh/android/ui/
// WorkspaceDirectoryUi.kt (workspace selector + directory rows), DshProductApp.kt (the "新建会话"
// primary action) and ComposerMorphLayout.kt / AgentPresetLabels.kt (the composer's leading
// model + mode row) (MIT).
//
// Spec 011 (mobile session authoring) — the APP half, **props driven**. These components own no
// state and fetch nothing: the workspace list, the model catalog and the device grant arrive from
// `AppStateSnapshot` (`workspaces` / `workspacesState` / `models` / `currentModel` /
// `grantedScopes`) once the wiring follow-up lands, so prop-drilling cannot duplicate fetching.
//
// Two states are load-bearing and easy to get wrong:
//   * `grantedScopes === []` means **unknown, not denied** (an older gateway that reports no scopes);
//     a neutral reason is shown, never "you lack permission".
//   * `workspaces`/`models` may legitimately be empty with state `ready`; empty is not an error.

import { useState, type ReactNode } from 'react';
import { Modal, Pressable, ScrollView, StyleSheet, Text, View } from 'react-native';

import type { MessageKey } from '../../../i18n';
import { isAuthoringRefusal } from '../../app-state';
import type { ClientState } from '../../core';
import { elevation, radius, space, useTheme } from '../theme';

/** One workspace, as the Host's `workspace/list` returns it (names/paths as-is, contract revision 7). */
export interface WorkspaceItem {
  /** Opaque Host id, passed to `session-create` as `workspaceId`. */
  readonly id: string;
  /** Display name; falls back to the path's last segment, then the id. */
  readonly name?: string;
  /** Absolute path, shown as the secondary line when present. */
  readonly path?: string;
}

/** One entry of the model catalog (`models` frame). */
export interface ModelItem {
  readonly id: string;
  readonly label: string;
  /** Provider half of `select-model`'s `provider` + `model` pair, when the Host splits them. */
  readonly provider?: string;
}

export type LoadState =
  | { readonly status: 'idle' }
  | { readonly status: 'loading' }
  | { readonly status: 'ready' }
  | { readonly status: 'error'; readonly code?: string };

/** The scope that gates all four authoring ops (contract: `SCOPE_BY_TYPE`). */
export const AUTHORING_SCOPE = 'sessions:author';

export type GrantState = 'granted' | 'denied' | 'unknown';

/**
 * `hello.device.scopes` → what the UI may claim. An empty list is **unknown** (older gateway), not
 * denied: the app must not accuse the user of lacking a permission the Host never reported.
 */
export function grantState(grantedScopes: readonly string[]): GrantState {
  if (grantedScopes.length === 0) return 'unknown';
  return grantedScopes.includes(AUTHORING_SCOPE) ? 'granted' : 'denied';
}

/**
 * Why the "New session" action may not run, as a pure function so it is testable without a
 * renderer and so the UI can never show an enabled button with no path to the Host. The grant is
 * the outermost reason: a missing workspace is only actionable once the device may author at all.
 */
export function newSessionAvailability(input: {
  grantedScopes: readonly string[];
  workspaceId: string | null;
  state: LoadState;
  /** `workspaces.length` once loaded; distinguishes "none on this Host" from "not chosen yet". */
  workspaceCount?: number;
  busy?: boolean;
  /**
   * The socket's state. Anything other than `ready` means the app simply does not know yet, so it must
   * report "connecting", NEVER a permission problem: on device the home screen accused the Host of not
   * reporting scopes during the first seconds after launch, then settled once `hello` arrived.
   */
  connection?: ClientState;
  /** True while the controller is between reconnect attempts (its own copy beats "connecting"). */
  reconnecting?: boolean;
}): { readonly enabled: boolean; readonly reason: MessageKey | null } {
  // Connection state comes FIRST: it is the only thing known for certain before `hello`. A reconnect
  // is only ever reported while the socket is NOT ready — a stale flag can never disable the action,
  // because `ready` wins here (defence in depth on top of the snapshot guarantee).
  if ((input.connection ?? 'ready') !== 'ready') {
    return { enabled: false, reason: input.reconnecting === true ? 'authoring.reconnecting' : 'authoring.connecting' };
  }
  const grant = grantState(input.grantedScopes);
  // `scopeUnknown` is now reachable ONLY with a ready socket whose `hello` carried no scopes.
  if (grant === 'unknown') return { enabled: false, reason: 'authoring.scopeUnknown' };
  if (grant === 'denied') return { enabled: false, reason: 'authoring.needScope' };
  if (input.busy === true) return { enabled: false, reason: null };
  if (input.state.status === 'loading' || input.state.status === 'idle') {
    return { enabled: false, reason: 'authoring.loadingWorkspaces' };
  }
  if (input.state.status === 'error') return { enabled: false, reason: 'authoring.workspacesError' };
  // `ready` with zero workspaces is a legitimate state, not a failure.
  if (input.workspaceCount === 0) return { enabled: false, reason: 'authoring.workspacesEmpty' };
  if (input.workspaceId === null) return { enabled: false, reason: 'authoring.needWorkspace' };
  return { enabled: true, reason: null };
}

/** Label for a workspace row/selection: name, else the path's last segment, else the id. */
export function workspaceLabel(item: WorkspaceItem): string {
  const name = item.name?.trim();
  if (name !== undefined && name !== '') return name;
  const path = item.path?.trim();
  if (path !== undefined && path !== '') {
    const segments = path.split('/').filter((segment) => segment !== '');
    const last = segments[segments.length - 1];
    return last ?? path;
  }
  return item.id;
}

/** Secondary line under a workspace name: the path, unless it merely repeats the name. */
export function workspaceDetail(item: WorkspaceItem): string | null {
  const path = item.path?.trim();
  if (path === undefined || path === '') return null;
  return path === workspaceLabel(item) ? null : path;
}

// ---------------------------------------------------------------------------
// Workspace picker — the dark rounded selector under the hero (reference: left phone)
// ---------------------------------------------------------------------------

export function WorkspacePicker(props: {
  items: readonly WorkspaceItem[];
  selectedId: string | null;
  state: LoadState;
  onSelect: (workspaceId: string) => void;
  onRetry: () => void;
  labels: {
    placeholder: string;
    title: string;
    retry: string;
    empty: string;
    loading: string;
    error: string;
    close: string;
  };
}) {
  const { colors, type } = useTheme();
  const [open, setOpen] = useState(false);
  const selected = props.items.find((item) => item.id === props.selectedId) ?? null;
  const summary = selected === null ? props.labels.placeholder : workspaceLabel(selected);

  return (
    <>
      <Pressable
        accessibilityRole="button"
        accessibilityLabel={`${props.labels.title}: ${summary}`}
        accessibilityState={{ expanded: open, busy: props.state.status === 'loading' }}
        onPress={() => setOpen(true)}
        style={({ pressed }) => [
          styles.selector,
          { backgroundColor: colors.surfaceRaised, borderColor: colors.border, borderRadius: radius.md },
          pressed && styles.pressed,
        ]}
      >
        <Text numberOfLines={1} style={[type.subheading, styles.flex, { color: selected === null ? colors.textMuted : colors.text }]}>
          {summary}
        </Text>
        <Text style={[type.caption, { color: colors.textMuted }]}>▾</Text>
      </Pressable>

      <Modal visible={open} transparent animationType="fade" onRequestClose={() => setOpen(false)}>
        <Pressable
          style={[styles.scrim, { backgroundColor: colors.overlay }]}
          accessibilityRole="button"
          accessibilityLabel={props.labels.close}
          onPress={() => setOpen(false)}
        >
          <View style={[styles.sheet, { backgroundColor: colors.surfaceRaised, borderRadius: radius.lg, ...elevation(colors, 'sheet') }]}>
            <SheetTitle>{props.labels.title}</SheetTitle>
            <PickerBody state={props.state} itemCount={props.items.length}
              loadingLabel={props.labels.loading} emptyLabel={props.labels.empty}
              errorLabel={props.labels.error} retryLabel={props.labels.retry} onRetry={props.onRetry}>
              <ScrollView style={{ maxHeight: 320 }}>{props.items.map((item) => {
                const active = item.id === props.selectedId;
                const detail = workspaceDetail(item);
                return (
                  <Pressable
                    key={item.id}
                    accessibilityRole="button"
                    accessibilityLabel={workspaceLabel(item)}
                    accessibilityState={{ selected: active }}
                    onPress={() => {
                      props.onSelect(item.id);
                      setOpen(false);
                    }}
                    style={({ pressed }) => [styles.sheetRow, pressed && styles.pressed]}
                  >
                    <View style={styles.flex}>
                      <Text style={[type.body, { color: colors.text }]} numberOfLines={1}>{workspaceLabel(item)}</Text>
                      {detail === null ? null : (
                        <Text style={[type.captionSmall, { color: colors.textFaint }]} numberOfLines={1}>{detail}</Text>
                      )}
                    </View>
                    {active ? <Text style={[type.body, { color: colors.accent }]}>✓</Text> : null}
                  </Pressable>
                );
              })}</ScrollView>
            </PickerBody>
          </View>
        </Pressable>
      </Modal>
    </>
  );
}

// ---------------------------------------------------------------------------
// Composer model row
// ---------------------------------------------------------------------------
//
// Spec 011 — the composer's leading row, deliberately ONE pill:
//
//   * There is NO mode/agent-preset pill. A companion has no wire source for it (the agent-preset
//     ops stay admin-only), so the slot is intentionally absent from the tree rather than rendered
//     disabled or with a placeholder label. See the "intentionally absent" note in the report.
//
//   * The model pill's visible text is always DATA — the model's label, else its id — and it is not
//     rendered at all when the current selection or the catalog is unavailable.
//
// WHY this is spelled out: device screenshot `e1-session.png` showed two pills whose text was
// literally "Mode" and "Model". Cause was here — the row substituted the i18n LABEL for the VALUE
// whenever the data was absent, which a user reads as "the current mode is called Mode". A label is
// never a value; the fix deletes the substitution instead of hiding it.

/**
 * Why the model catalog could not be read — as the ONE honest line the composer shows.
 *
 * MEASURED: a per-session `models` request for a SUBAGENT session fails with
 * `code: 'session/agent-busy'` ("subagent Sessions require their durable parent address") because the
 * gateway's adapter hard-codes a root address for that path (`lib/dsh-host-adapter.mjs:367`). That is
 * not a permission problem, so it must never be reported as "you were not granted access" — the split
 * here is exactly that. A twin gateway task will resolve the parent address; until then this is the
 * frame we get, and it gets its own message.
 */
export function modelUnavailableReasonKey(code: string | null): MessageKey {
  if (code === 'session/agent-busy') return 'authoring.modelSubagent';
  if (code !== null && isAuthoringRefusal(code)) return 'authoring.needScope';
  return 'authoring.modelsUnavailable';
}

/** The pill's text: the model's own label, else its id, else nothing. Never an i18n label. */
export function composerModelLabel(currentModel: { id: string; label?: string } | null): string | null {
  if (currentModel === null) return null;
  const label = currentModel.label?.trim();
  if (label !== undefined && label !== '') return label;
  const id = currentModel.id.trim();
  return id === '' ? null : id;
}

/**
 * Is there anything honest to show? Both a known current selection AND a loaded, non-empty catalog
 * are required: without a catalog the pill would have nothing to open, and the current value is not
 * something the Host reported for this session yet.
 */
export function shouldShowModelPill(input: {
  currentModel: { id: string; label?: string } | null;
  hasCatalog: boolean;
}): boolean {
  return input.hasCatalog && composerModelLabel(input.currentModel) !== null;
}

export function ComposerModelRow(props: {
  /** The session's current selection as the snapshot exposes it (label may be absent). */
  currentModel: { id: string; label?: string } | null;
  /** True only when the catalog is loaded and non-empty. */
  hasCatalog: boolean;
  onOpenModel: () => void;
  /** Localised noun for the accessibility label only — never rendered as the value. */
  hint: string;
}) {
  const { colors, type, radius } = useTheme();
  if (!shouldShowModelPill({ currentModel: props.currentModel, hasCatalog: props.hasCatalog })) return null;
  const label = composerModelLabel(props.currentModel);
  if (label === null) return null;
  return (
    <View style={styles.modeRow}>
      {/* Without a catalogue there is nothing to open, so the pill is a STATIC LABEL: no "▾" (a
          chevron promises a sheet) and no press. The ▾ appears only when the sheet has rows. */}
      <Pressable
        accessibilityRole={props.hasCatalog ? 'button' : 'text'}
        accessibilityLabel={props.hasCatalog ? `${props.hint}: ${label}` : label}
        accessibilityState={props.hasCatalog ? undefined : { disabled: true }}
        disabled={!props.hasCatalog}
        onPress={props.hasCatalog ? props.onOpenModel : undefined}
        style={({ pressed }) => [
          props.hasCatalog ? styles.pill : styles.pillStatic,
          props.hasCatalog ? { borderRadius: radius.sm, borderColor: colors.border } : null,
          pressed && props.hasCatalog && styles.pressed,
        ]}
      >
        <Text style={[type.caption, { color: props.hasCatalog ? colors.text : colors.textMuted }]} numberOfLines={1}>
          {label}
          {props.hasCatalog ? '  ▾' : ''}
        </Text>
      </Pressable>
    </View>
  );
}

/** Model sheet for the composer's leading row; same sheet language as the workspace picker. */
/**
 * Group a model catalogue by provider for the sheet (reference 07: one section per provider).
 *
 * Optional by design: when NO item carries a provider (an older Host, or a flat reply), this returns a
 * single unnamed group and the sheet renders exactly as before — same order, no headers. Providers
 * keep the order the catalogue listed them in, and an item without a provider lands in a trailing
 * unnamed group rather than being dropped.
 */
export function groupModelsByProvider(
  items: readonly ModelItem[],
): Array<{ provider: string | null; items: readonly ModelItem[] }> {
  const groups = new Map<string | null, ModelItem[]>();
  for (const item of items) {
    const key = item.provider === undefined || item.provider.trim() === '' ? null : item.provider.trim();
    const bucket = groups.get(key);
    if (bucket === undefined) groups.set(key, [item]);
    else bucket.push(item);
  }
  if (![...groups.keys()].some((key) => key !== null)) {
    const only = groups.get(null);
    return [{ provider: null, items: only ?? [] }];
  }
  // Named providers first (catalogue order), the unnamed bucket last.
  return [...groups.entries()]
    .sort(([left], [right]) => (left === null ? 1 : right === null ? -1 : 0))
    .map(([provider, grouped]) => ({ provider, items: grouped }));
}

export function ModelPicker(props: {
  visible: boolean;
  items: readonly ModelItem[];
  currentId: string | null;
  state: LoadState;
  onSelect: (model: ModelItem) => void;
  onClose: () => void;
  onRetry: () => void;
  labels: { title: string; retry: string; empty: string; loading: string; error: string; close: string };
}) {
  const { colors, type } = useTheme();
  return (
    // Reference 07: a sheet that SLIDES UP from the bottom edge, with a grab handle, a centred
    // title and a ✕ on the right — not the floating centred card this used to be.
    <Modal visible={props.visible} transparent animationType="slide" onRequestClose={props.onClose}>
      <View style={styles.sheetRoot}>
        <Pressable
          style={[StyleSheet.absoluteFill, { backgroundColor: colors.overlay }]}
          accessibilityRole="button"
          accessibilityLabel={props.labels.close}
          onPress={props.onClose}
        />
        <View
          style={[
            styles.bottomSheet,
            {
              backgroundColor: colors.surfaceRaised,
              borderTopLeftRadius: radius.xl,
              borderTopRightRadius: radius.xl,
              ...elevation(colors, 'sheet'),
            },
          ]}
        >
          <View style={[styles.grabber, { backgroundColor: colors.border }]} />
          <View style={styles.sheetHeader}>
            {/* Equal-width sides keep the title optically centred whatever the ✕'s glyph width. */}
            <View style={styles.headerSide} />
            <Text style={[type.heading, styles.sheetHeaderTitle, { color: colors.text }]} numberOfLines={1}>
              {props.labels.title}
            </Text>
            <Pressable
              onPress={props.onClose}
              accessibilityRole="button"
              accessibilityLabel={props.labels.close}
              hitSlop={8}
              style={styles.headerSide}
            >
              <Text style={[type.heading, { color: colors.textMuted }]}>✕</Text>
            </Pressable>
          </View>
          <PickerBody state={props.state} itemCount={props.items.length}
            loadingLabel={props.labels.loading} emptyLabel={props.labels.empty}
            errorLabel={props.labels.error} retryLabel={props.labels.retry} onRetry={props.onRetry}>
            <ScrollView style={styles.sheetList}>
              {groupModelsByProvider(props.items).map((group) => (
                <View key={group.provider ?? '\u0000none'}>
                  {group.provider === null ? null : (
                    <Text style={[type.captionSmall, styles.providerHeader, { color: colors.textMuted }]}>
                      {group.provider}
                    </Text>
                  )}
                  {group.items.map((item) => {
                    const active = item.id === props.currentId;
                    return (
                      <Pressable
                        key={item.id}
                        accessibilityRole="button"
                        accessibilityLabel={item.label}
                        accessibilityState={{ selected: active }}
                        onPress={() => props.onSelect(item)}
                        style={({ pressed }) => [styles.sheetRow, pressed && styles.pressed]}
                      >
                        <Text style={[type.body, styles.flex, { color: colors.text }]} numberOfLines={1}>{item.label}</Text>
                        {active ? <Text style={[type.body, { color: colors.accent }]}>✓</Text> : null}
                      </Pressable>
                    );
                  })}
                </View>
              ))}
            </ScrollView>
          </PickerBody>
        </View>
      </View>
    </Modal>
  );
}

// ---------------------------------------------------------------------------
// Shared sheet pieces
// ---------------------------------------------------------------------------

function SheetTitle(props: { children: string }) {
  const { colors, type } = useTheme();
  return <Text style={[type.captionSmall, styles.sheetTitle, { color: colors.textMuted }]}>{props.children}</Text>;
}

/**
 * The three non-list branches of a sheet. `ready` with zero items is a normal state ("this computer
 * has no workspaces"), so it is shown as an empty message and never as an error.
 */
function PickerBody(props: {
  state: LoadState;
  itemCount: number;
  loadingLabel: string;
  emptyLabel: string;
  errorLabel: string;
  retryLabel: string;
  onRetry: () => void;
  children: ReactNode;
}) {
  const { colors, type } = useTheme();
  // ITEMS FIRST: a catalogue that already has rows must paint them, whatever the load state says.
  // The loading message is only for "there is nothing to show yet" — a refresh in flight must never
  // blank a list the user is looking at, which is exactly how the model sheet came up with no rows.
  if (props.itemCount > 0) return <>{props.children}</>;
  if (props.state.status === 'error') {
    return (
      <Pressable accessibilityRole="button" accessibilityLabel={props.retryLabel} onPress={props.onRetry} style={styles.sheetMessage}>
        <Text style={[type.body, { color: colors.danger }]}>{props.errorLabel}</Text>
      </Pressable>
    );
  }
  if (props.state.status === 'loading' || props.state.status === 'idle') {
    return <View style={styles.sheetMessage}><Text style={[type.body, { color: colors.textMuted }]}>{props.loadingLabel}</Text></View>;
  }
  return <View style={styles.sheetMessage}><Text style={[type.body, { color: colors.textMuted }]}>{props.emptyLabel}</Text></View>;
}

const styles = StyleSheet.create({
  flex: { flex: 1 },
  pressed: { opacity: 0.7 },
  selector: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: space.sm,
    minHeight: 48,
    paddingHorizontal: space.lg,
    borderWidth: StyleSheet.hairlineWidth,
  },
  scrim: { flex: 1, justifyContent: 'center', paddingHorizontal: space.lg },
  // Bottom sheet (reference 07): the root pins the sheet to the bottom edge and the scrim fills the
  // rest of the screen behind it.
  sheetRoot: { flex: 1, justifyContent: 'flex-end' },
  bottomSheet: { paddingBottom: space.lg, paddingTop: space.xs },
  grabber: { alignSelf: 'center', width: 40, height: 4, borderRadius: 2, marginBottom: space.xs },
  sheetHeader: { flexDirection: 'row', alignItems: 'center', paddingHorizontal: space.md, paddingVertical: space.sm },
  sheetHeaderTitle: { flex: 1, textAlign: 'center' },
  headerSide: { width: 32, alignItems: 'center', justifyContent: 'center', minHeight: 32 },
  sheetList: { maxHeight: 440 },
  sheet: { paddingVertical: space.sm, paddingHorizontal: space.sm, gap: space.xxs },
  sheetTitle: { paddingHorizontal: space.md, paddingVertical: space.sm, textTransform: 'uppercase', letterSpacing: 0.6 },
  providerHeader: { paddingHorizontal: space.sm, paddingTop: space.sm, paddingBottom: space.xxs, textTransform: 'uppercase', letterSpacing: 0.6 },
  sheetRow: { flexDirection: 'row', alignItems: 'center', gap: space.sm, minHeight: 48, paddingHorizontal: space.md },
  sheetMessage: { minHeight: 48, justifyContent: 'center', paddingHorizontal: space.md, paddingVertical: space.sm },
  modeRow: { flexDirection: 'row', gap: space.sm },
  pill: { minHeight: 32, justifyContent: 'center', paddingHorizontal: space.sm, borderWidth: StyleSheet.hairlineWidth },
  // Static label variant: no border, no chevron, no touch affordance.
  pillStatic: { minHeight: 32, justifyContent: 'center', paddingHorizontal: 0 },
});
