// Spec 019 Wave 3 — the session header's permission chip and the lower-only sheet. PROPS DRIVEN:
// the screen owns the reads and the writes (through `AppController.readPermissionOptions` /
// `.lowerPermission`), and these components only render what the snapshot and a reply say.
//
// Two rules that are device lessons, not style:
//   * the chip's text is the Host's own preset name — never an i18n label standing in for it;
//   * an option row's second line is FIXED local copy naming the resolved pair, because the
//     desktop preset table has no description member at all (0.2.2-rc.1; see src/ui/permission-lower.ts).
//   * the receipt line is composed by the SCREEN from the reply's code and the fixed i18n copy; the
//     Host's own `message` is internal text and never reaches this component.
//
// static testIDs (`permission-chip`, `permission-sheet`, `permission-option-<preset>`,
// `permission-receipt`) are what `e2e/check-flows.mjs` resolves against the app source.

import { Pressable, ScrollView, StyleSheet, Text, View } from 'react-native';

import type { OptionRowView } from '../permission-lower';
import { radius, space, useTheme } from '../theme';

/**
 * The header chip. It is drawn ONLY when the caller already applied `shouldShowPermissionChip`,
 * so its text is always a preset name the Host reported — there is no "unknown preset" pill.
 */
export function PermissionChip(props: {
  preset: string;
  /** `session.permissionChip` with `{preset}` — the announcement; the visible text is the preset. */
  hint: string;
  onPress: () => void;
}) {
  const { colors, type } = useTheme();
  return (
    <Pressable
      accessibilityRole="button"
      accessibilityLabel={props.hint}
      onPress={props.onPress}
      hitSlop={8}
      style={({ pressed }) => [styles.chip, { borderColor: colors.border }, pressed && styles.pressed]}
      testID="permission-chip"
    >
      <Text style={[type.caption, { color: colors.text }]} numberOfLines={1}>{props.preset}</Text>
      <Text style={[type.caption, { color: colors.textMuted }]}>▾</Text>
    </Pressable>
  );
}

/**
 * The sheet's body: the preset in effect, the last receipt's sentence, then exactly the rows the
 * caller passes (already filtered by `optionRows`) — or one honest line saying why there are none.
 */
export function PermissionSheetBody(props: {
  state: 'loading' | 'ready' | 'unavailable' | 'error';
  currentValue: string | null;
  rows: readonly OptionRowView[];
  /** The composed receipt sentence (fixed i18n copy), or null when nothing was answered yet. */
  receipt: string | null;
  /** True while a switch is in flight: the rows are locked so two taps cannot race each other. */
  busy?: boolean;
  labels: { current: string; empty: string; unavailable: string; failed: string };
  onRetry: () => void;
  /** Tapping a row: the screen asks its confirmation dialog before sending anything. */
  onChoose: (preset: string) => void;
}) {
  const { colors, type } = useTheme();
  return (
    <View style={styles.sheetBody} testID="permission-sheet">
      {props.currentValue === null ? null : (
        <Text style={[type.caption, styles.inset]} numberOfLines={1} testID="permission-current">
          {props.labels.current}
        </Text>
      )}
      {props.receipt === null ? null : (
        <Text style={[type.bodySmall, styles.inset, { color: colors.textMuted }]} testID="permission-receipt">
          {props.receipt}
        </Text>
      )}
      {props.state === 'unavailable' ? (
        <Text style={[type.bodySmall, styles.line, { color: colors.textMuted }]}>{props.labels.unavailable}</Text>
      ) : props.state === 'error' ? (
        <Pressable accessibilityRole="button" accessibilityLabel={props.labels.failed} onPress={props.onRetry} style={styles.line}>
          <Text style={[type.bodySmall, { color: colors.danger }]}>{props.labels.failed}</Text>
        </Pressable>
      ) : props.state === 'loading' ? (
        <Text style={[type.bodySmall, styles.line, { color: colors.textMuted }]}>…</Text>
      ) : props.rows.length === 0 ? (
        // `ready` with nothing stricter is a legitimate state of the Host's table, not an error.
        <Text style={[type.bodySmall, styles.line, { color: colors.textMuted }]}>{props.labels.empty}</Text>
      ) : (
        <ScrollView style={styles.list}>
          {props.rows.map((row) => (
            <Pressable
              key={row.preset}
              accessibilityRole="button"
              accessibilityLabel={row.preset}
              accessibilityState={{ disabled: props.busy === true }}
              disabled={props.busy === true}
              onPress={() => props.onChoose(row.preset)}
              style={({ pressed }) => [styles.row, pressed && styles.pressed]}
              testID={`permission-option-${row.preset}`}
            >
              <Text style={[type.body, { color: colors.text }]} numberOfLines={1}>{row.preset}</Text>
              <Text style={[type.captionSmall, { color: colors.textFaint }]} numberOfLines={2}>{row.description}</Text>
            </Pressable>
          ))}
        </ScrollView>
      )}
    </View>
  );
}

const styles = StyleSheet.create({
  pressed: { opacity: 0.7 },
  chip: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: space.xxs,
    minHeight: 24,
    paddingHorizontal: space.sm,
    borderWidth: StyleSheet.hairlineWidth,
    borderRadius: radius.sm,
  },
  sheetBody: { gap: space.sm, paddingHorizontal: space.md, paddingBottom: space.md },
  inset: { paddingHorizontal: space.sm },
  line: { paddingHorizontal: space.sm, paddingVertical: space.sm },
  list: { maxHeight: 360 },
  row: { gap: space.xxs, minHeight: 48, justifyContent: 'center', paddingHorizontal: space.sm },
});
