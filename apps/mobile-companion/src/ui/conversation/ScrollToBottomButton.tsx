// Spec 017 wave 1 (Clarklevis parity): the "jump to newest" control.
//
// The transcript opens on the newest message and lets the reader scroll up freely; once they are far
// enough from the bottom that a new message would arrive off-screen, a circular button appears above
// the composer. Tapping it returns to the bottom. Whether it should show at all is decided by
// `isAwayFromBottom` (pure, unit-tested), so the threshold is not tuned by eye.

import { Pressable, StyleSheet, Text } from 'react-native';

import { useTheme } from '../theme';

export function ScrollToBottomButton({ onPress, label }: { onPress: () => void; label: string }) {
  const theme = useTheme();
  const { colors, type, radius, hit } = theme;

  return (
    <Pressable
      accessibilityRole="button"
      accessibilityLabel={label}
      onPress={onPress}
      hitSlop={8}
      testID="session-scroll-bottom"
      style={({ pressed }) => [
        styles.button,
        {
          backgroundColor: colors.surfaceRaised,
          borderColor: colors.border,
          borderRadius: radius.circle,
          width: hit,
          height: hit,
          minWidth: hit,
          minHeight: hit,
          opacity: pressed ? 0.7 : 1,
        },
      ]}
    >
      <Text style={[type.heading, { color: colors.text }]}>⌄</Text>
    </Pressable>
  );
}

const styles = StyleSheet.create({
  /**
   * NOT absolutely positioned on purpose: the screen already wraps this in an absolutely positioned
   * `styles.scrollBottom` row that owns `bottom`/`left`/`right`. Nesting a second `position:'absolute'`
   * inside a zero-width wrapper put the button off-screen, which is why the first capture showed the
   * reader far from the newest message with no control at all.
   */
  button: { alignItems: 'center', justifyContent: 'center', borderWidth: StyleSheet.hairlineWidth },
});
