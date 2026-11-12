// UI ported from Clarklevis1995/dsh-mobile
//   androidApp/src/main/kotlin/com/clarklevis/dsh/android/ui/ConversationScreen.kt (MIT)
//
// A collapsed run of activity rows: one compact line ("3 steps") that opens into the individual
// tool pills on tap. Clarklevis folds a turn's tool traffic into a single expandable row instead of
// stacking a pill per call, which is what keeps the transcript readable next to agent prose.

import { useState } from 'react';
import { Pressable, StyleSheet, Text, View } from 'react-native';

import type { HistoryMessage } from '../../core/history';
import type { Interpolate } from '../../../i18n';
import { useTheme } from '../theme';
import { ToolRow } from './ToolRow';

/** The one-line label of an activity row (our rows carry no tool name — see ToolRow's header). */
function labelFor(message: HistoryMessage, tr: Interpolate): string {
  if (message.role === 'tool') return tr('session.role.tool');
  if (message.role === 'system') return tr('session.role.system');
  return tr('session.role.other');
}

export function ToolGroup({ rows, tr }: { rows: HistoryMessage[]; tr: Interpolate }) {
  const [open, setOpen] = useState(false);
  const theme = useTheme();
  const { colors, type, space, radius, hit } = theme;

  // A single activity row is just a pill — an expand control for one item would be noise.
  if (rows.length === 1) {
    const only = rows[0];
    if (only === undefined) return null;
    return <ToolRow label={labelFor(only, tr)} text={only.text} />;
  }

  if (!open) {
    const summary = tr('session.toolsCollapsed', { count: rows.length });
    return (
      <Pressable
        accessibilityRole="button"
        accessibilityLabel={summary}
        accessibilityState={{ expanded: false }}
        onPress={() => setOpen(true)}
        style={[
          styles.collapsed,
          {
            backgroundColor: colors.surface,
            borderRadius: radius.pill,
            paddingHorizontal: space.md,
            minWidth: hit,
            minHeight: hit,
            gap: space.xs,
          },
        ]}
      >
        <Text style={[type.captionSmall, { color: colors.textFaint }]}>⋯</Text>
        <Text style={[type.caption, { color: colors.textMuted }]} numberOfLines={1}>{summary}</Text>
        <Text style={[type.caption, { color: colors.textFaint }]}>⌄</Text>
      </Pressable>
    );
  }

  return (
    <View style={{ gap: space.xs }}>
      {rows.map((row) => (
        <ToolRow key={row.id} label={labelFor(row, tr)} text={row.text} />
      ))}
      <Pressable
        accessibilityRole="button"
        accessibilityLabel={tr('common.cancel')}
        accessibilityState={{ expanded: true }}
        onPress={() => setOpen(false)}
        style={{ minHeight: hit, justifyContent: 'center', paddingHorizontal: space.sm }}
      >
        <Text style={[type.caption, { color: colors.textMuted }]}>⌃</Text>
      </Pressable>
    </View>
  );
}

const styles = StyleSheet.create({
  collapsed: { flexDirection: 'row', alignItems: 'center', alignSelf: 'flex-start' },
});
