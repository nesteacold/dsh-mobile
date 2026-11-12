// Spec 018 item 5 — the session header's two read-only projections: the current goal (one line) and
// the Host's task list (a checklist that opens and closes).
//
// It is pinned under the session header, OUTSIDE the transcript's scroller: as the first row of that
// scroller it sat above "load older", so on a long session it was never on screen. Collapsed it stays
// one goal line + one disclosure; opened, its rows scroll inside their own capped window.
//
// Read-only by construction: the phone never writes a `goal`/`todos` projection, and the Host refuses
// every goal write without `{id, revision}` (PROTOCOL.md:985), so there is nothing here to tap but
// the disclosure. A status is drawn as an icon + its own word, so the state is not carried by colour
// alone; an unknown Host status keeps its own row and says "unknown" instead of being guessed.
//
// Both surfaces hide when the Host projected nothing (`src/ui/read-only-views.ts`), which is the
// documented answer for an absent projection — never an empty card.

import { useState } from 'react';
import { ScrollView, StyleSheet, Text, TouchableOpacity, View } from 'react-native';

import type { Interpolate } from '../../../i18n';
import { useTheme } from '../theme';
import type { PanelTaskRow, SessionPanelView } from '../read-only-views';

/** The most of the screen an OPEN checklist may take; the rest stays with the transcript. */
export const PANEL_EXPANDED_SCREEN_SHARE = 0.4;
/** The smallest cap an open checklist gets, so a clipped window still scrolls a sane number of rows. */
export const PANEL_EXPANDED_MIN_HEIGHT = 96;

/**
 * The height cap of the open checklist: a share of the measured screen, floored so it stays usable on
 * a short window. A window not measured yet (0) gets the floor, never a zero-height list.
 */
export function panelExpandedHeight(windowHeight: number): number {
  return Math.max(PANEL_EXPANDED_MIN_HEIGHT, windowHeight * PANEL_EXPANDED_SCREEN_SHARE);
}

/** The leading mark of one status. Plain glyphs the app already draws (no icon font is shipped). */
export function taskStatusMark(status: PanelTaskRow['status']): string {
  switch (status) {
    case 'pending':
      return '○';
    case 'in_progress':
      return '◐';
    case 'completed':
      return '✓';
    default:
      return '·';
  }
}

export function SessionPanelStrip(props: {
  view: SessionPanelView;
  tr: Interpolate;
  /** Checklist open state, owned by the screen so it survives re-renders of the transcript. */
  tasksOpen: boolean;
  onToggleTasks: () => void;
}) {
  const { view, tr, tasksOpen, onToggleTasks } = props;
  const { colors, type, space, radius, hit } = useTheme();
  // The strip is pinned under the header, so an open checklist must not grow into the transcript it
  // sits over: it scrolls inside its own capped window instead.
  const [windowHeight, setWindowHeight] = useState(0);

  return (
    <View
      style={[
        styles.card,
        {
          backgroundColor: colors.surface,
          borderColor: colors.border,
          borderRadius: radius.lg,
          paddingHorizontal: space.md,
          paddingVertical: space.sm,
          gap: space.xs,
        },
      ]}
      onLayout={(event) => setWindowHeight(event.nativeEvent.layout.height)}
      testID="session-panel"
    >
      {view.goal === null ? null : (
        <View style={{ gap: space.xxs }} testID="session-goal">
          <View style={[styles.row, { gap: space.xs }]}>
            <Text style={[type.captionSmall, { color: colors.textFaint }]}>{tr('session.goal')}</Text>
            {view.goalPhase === null ? null : (
              <Text style={[type.captionSmall, { color: colors.textMuted }]} testID="session-goal-phase">
                {tr('session.goalPhase', { phase: view.goalPhase })}
              </Text>
            )}
          </View>
          <Text style={[type.bodySmall, { color: colors.text }]} numberOfLines={2} testID="session-goal-text">
            {view.goal}
          </Text>
        </View>
      )}

      {view.tasks.length === 0 ? null : (
        <View style={{ gap: tasksOpen ? space.xs : 0 }} testID="session-tasks">
          <TouchableOpacity
            style={[styles.row, { gap: space.xs, minHeight: hit }]}
            accessibilityRole="button"
            accessibilityLabel={tr('session.tasksTitle')}
            accessibilityState={{ expanded: tasksOpen }}
            onPress={onToggleTasks}
            testID="session-tasks-toggle"
          >
            <Text style={[type.captionSmall, { color: colors.textMuted }]}>{tasksOpen ? '▾' : '▸'}</Text>
            <Text style={[type.captionSmall, { color: colors.textMuted, flexShrink: 1 }]}>
              {tr('session.tasksTitle')}
            </Text>
            <Text style={[type.captionSmall, { color: colors.textFaint }]} testID="session-tasks-count">
              {tr('session.tasksDone', { done: view.tasksDone, total: view.tasksTotal })}
            </Text>
          </TouchableOpacity>
          {tasksOpen ? (
            <ScrollView
              style={{ maxHeight: panelExpandedHeight(windowHeight) }}
              contentContainerStyle={{ gap: space.xs }}
              nestedScrollEnabled
              testID="session-tasks-scroll"
            >
              {view.tasks.map((task, index) => (
                <View
                  key={`${index.toString()}-${task.text}`}
                  style={[styles.row, { gap: space.sm }]}
                  testID="session-task"
                >
                  <Text
                    style={[type.caption, { color: task.status === 'completed' ? colors.success : colors.textMuted }]}
                  >
                    {taskStatusMark(task.status)}
                  </Text>
                  <View style={{ flexDirection: 'row', flexShrink: 1, gap: space.xs }}>
                    <Text
                      style={[
                        type.bodySmall,
                        { color: task.status === 'completed' ? colors.textMuted : colors.text, flexShrink: 1 },
                        task.status === 'completed' ? styles.done : null,
                      ]}
                      // The Host owns the text; a long one must not turn the strip into a wall.
                      numberOfLines={3}
                    >
                      {task.text}
                    </Text>
                    <Text style={[type.captionSmall, { color: colors.textFaint }]}>{tr(task.statusLabel)}</Text>
                  </View>
                </View>
              ))}
              {view.tasksHidden > 0 ? (
                // Hidden rows are counted, never silently dropped: the Host's own total stays above.
                <Text style={[type.captionSmall, { color: colors.textFaint }]} testID="session-tasks-more">
                  {tr('session.tasksMore', { count: view.tasksHidden })}
                </Text>
              ) : null}
            </ScrollView>
          ) : null}
        </View>
      )}
    </View>
  );
}

const styles = StyleSheet.create({
  card: { borderWidth: 1 },
  row: { flexDirection: 'row', alignItems: 'center' },
  done: { textDecorationLine: 'line-through' },
});
