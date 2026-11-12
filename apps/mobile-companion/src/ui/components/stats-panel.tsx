// Spec 018 — the read-only body of the session-stats sheet (op `session-stats`, scope `stats:read`).
//
// Every state is drawn differently, and the three "nothing to show" answers never look alike:
//   loading      → one busy line (the sheet opened, the answer is in flight)
//   ready        → the sections `toStatsView` built (tokens, context, turns/steps)
//   unavailable  → this device was not paired with `stats:read`, or no socket is open
//   failed       → a mapped sentence for the error CODE (`stats.noData` included); never the Host's
//                  `message`, which is internal text.
// A number the Host did not report is simply absent from the rows: it is never drawn as `0`.

import { ActivityIndicator, StyleSheet, Text, View } from 'react-native';

import type { Interpolate } from '../../../i18n';
import { useTheme } from '../theme';
import type { StatsView } from '../read-only-views';

export function SessionStatsPanel(props: {
  view: StatsView;
  tr: Interpolate;
  onRetry: () => void;
}) {
  const { view, tr, onRetry } = props;
  const { colors, type, space } = useTheme();

  if (view.state === 'loading') {
    return (
      <View style={{ flexDirection: 'row', alignItems: 'center', gap: space.sm }} testID="session-stats-loading">
        <ActivityIndicator color={colors.accent} />
        <Text style={[type.caption, { color: colors.textMuted }]}>{tr('common.loading')}</Text>
      </View>
    );
  }
  if (view.state === 'unavailable' || view.state === 'failed') {
    return (
      <View style={{ gap: space.sm }} testID={view.state === 'unavailable' ? 'session-stats-unavailable' : 'session-stats-failed'}>
        <Text style={[type.caption, { color: colors.textMuted }]}>
          {view.state === 'unavailable' ? tr('stats.unavailable') : view.errorText ?? tr('stats.errorGeneric')}
        </Text>
        {view.state === 'failed' ? (
          <Text
            accessibilityRole="button"
            accessibilityLabel={tr('team.retry')}
            onPress={onRetry}
            style={[type.caption, { color: colors.accent }]}
            testID="session-stats-retry"
          >
            {tr('team.retry')}
          </Text>
        ) : null}
      </View>
    );
  }
  return (
    <View style={{ gap: space.lg }} testID="session-stats-ready">
      {view.sections.map((section) => (
        <View key={section.testID} style={{ gap: space.xs }} testID={section.testID}>
          <Text style={[type.caption, { color: colors.textMuted, textTransform: 'uppercase', letterSpacing: 1 }]}>
            {tr(section.title)}
          </Text>
          {section.rows.map((row) => (
            <View key={row.label} style={styles.row}>
              <Text style={[type.caption, { color: colors.textMuted, flexShrink: 1 }]} numberOfLines={1}>
                {tr(row.label)}
              </Text>
              <Text style={[type.bodySmall, { color: colors.text }]} numberOfLines={1}>
                {row.value}
              </Text>
            </View>
          ))}
        </View>
      ))}
    </View>
  );
}

const styles = StyleSheet.create({
  row: { flexDirection: 'row', alignItems: 'baseline', justifyContent: 'space-between', gap: 12, minHeight: 20 },
});
