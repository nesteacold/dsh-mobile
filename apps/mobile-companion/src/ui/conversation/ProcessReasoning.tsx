// UI ported from Clarklevis1995/dsh-mobile
//   androidApp/src/main/kotlin/com/clarklevis/dsh/android/ui/ProcessReasoningDisclosure.kt (MIT)
//
// The agent's thinking, folded away under the answer. Clarklevis keeps the reasoning collapsed by
// default and expands it in place: it is context for a curious reader, never part of the reply, so it
// must not push the conversation down until asked.
//
// Collapsed shows one muted row ("Suy nghĩ · <one-line teaser>"); tapping expands the full text in a
// bordered, slightly recessed block.

import { useState } from 'react';
import { Pressable, StyleSheet, Text, View } from 'react-native';

import type { Interpolate } from '../../../i18n';
import { useTheme } from '../theme';

/** The one-line teaser shown while collapsed: whitespace-flattened, word-bounded, never a wall. */
export function reasoningPreview(reasoning: string, maxChars = 90): string {
  const flat = reasoning.replace(/\s+/g, ' ').trim();
  if (flat.length <= maxChars) return flat;
  const cut = flat.slice(0, maxChars);
  const lastSpace = cut.lastIndexOf(' ');
  return `${(lastSpace > maxChars * 0.6 ? cut.slice(0, lastSpace) : cut).trimEnd()}…`;
}

export function ProcessReasoning({ reasoning, tr }: { reasoning: string; tr: Interpolate }) {
  const [open, setOpen] = useState(false);
  const theme = useTheme();
  const { colors, type, space, radius, hit } = theme;

  return (
    <View style={{ gap: space.xxs }}>
      <Pressable
        accessibilityRole="button"
        accessibilityLabel={tr('session.reasoning')}
        accessibilityState={{ expanded: open }}
        onPress={() => setOpen((value) => !value)}
        testID="session-reasoning"
        style={[styles.toggle, { minHeight: hit, gap: space.xs }]}
      >
        <Text style={[type.captionSmall, { color: colors.textMuted }]}>{open ? '⌃' : '⌄'}</Text>
        <Text style={[type.captionSmall, { color: colors.textMuted, flexShrink: 1 }]} numberOfLines={1}>
          {open ? tr('session.reasoning') : `${tr('session.reasoning')} · ${reasoningPreview(reasoning)}`}
        </Text>
      </Pressable>
      {open ? (
        <View
          style={[
            styles.body,
            {
              backgroundColor: colors.surface,
              borderColor: colors.border,
              borderRadius: radius.md,
              padding: space.md,
            },
          ]}
        >
          <Text style={[type.bodySmall, { color: colors.textMuted }]} selectable>
            {reasoning}
          </Text>
        </View>
      ) : null}
    </View>
  );
}

const styles = StyleSheet.create({
  toggle: { flexDirection: 'row', alignItems: 'center', alignSelf: 'flex-start' },
  body: { borderWidth: StyleSheet.hairlineWidth },
});
