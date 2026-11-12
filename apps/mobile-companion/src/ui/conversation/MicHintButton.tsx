// Spec 019 (Đợt 3): dictation through the OS keyboard.
//
// WHY a button that only focuses the field: the phone's own keyboard already owns speech input
// (Gboard's mic key transcribes into whatever `TextInput` has focus). Adding a recording library would
// mean a new native module, a microphone permission and a second audio pipeline on a device that
// already transcribes correctly — so this control deliberately does NOT record. It focuses the
// composer and explains where the mic is, which is all a user needs and all we can honestly promise.
//
// The mic is DRAWN from Views rather than glyph/emoji: this bundle carries no icon font (measured —
// zero `.ttf`/`.otf` entries in the APK), and geometric text glyphs like ▢ have rendered as tofu on
// this AVD before.

import { Pressable, StyleSheet, Text, View } from 'react-native';

import { useTheme } from '../theme';

export function MicHintButton({
  label,
  onPress,
  testID = 'session-mic-hint',
}: {
  /** Accessibility label, localised by the caller. */
  label: string;
  onPress: () => void;
  testID?: string;
}) {
  const theme = useTheme();
  const { colors, hit } = theme;

  return (
    <Pressable
      accessibilityRole="button"
      accessibilityLabel={label}
      onPress={onPress}
      hitSlop={8}
      testID={testID}
      style={({ pressed }) => [
        styles.button,
        { minWidth: hit, minHeight: hit, opacity: pressed ? 0.6 : 1 },
      ]}
    >
      {/* Capsule body, stand and base: three Views, no font involved. */}
      <View style={[styles.micBody, { borderColor: colors.textMuted }]} />
      <View style={[styles.micStem, { backgroundColor: colors.textMuted }]} />
      <View style={[styles.micBase, { backgroundColor: colors.textMuted }]} />
    </Pressable>
  );
}

/** The line shown after tapping: says where dictation actually lives. */
export function MicHintLine({ text }: { text: string }) {
  const theme = useTheme();
  return (
    <Text style={[theme.type.captionSmall, { color: theme.colors.textMuted, paddingHorizontal: theme.space.xs }]}>
      {text}
    </Text>
  );
}

const styles = StyleSheet.create({
  button: { alignItems: 'center', justifyContent: 'center' },
  micBody: { width: 8, height: 12, borderRadius: 4, borderWidth: 1.5 },
  micStem: { width: 1.5, height: 3, marginTop: 1 },
  micBase: { width: 7, height: 1.5, borderRadius: 1 },
});
