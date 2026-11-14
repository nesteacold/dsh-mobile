// Privacy policy (reference: `PrivacyPolicySheet.kt`).
//
// This text describes what THIS app actually does — it is not a copy of another product's policy.
// Every claim below is checkable in the source: the app talks only to the Host the user paired, it has
// no analytics/telemetry SDK, it stores the pairing token in the device's encrypted store, and its only
// local files are the opt-in debug trace and any cached data the storage screen lists.
//
// The NATIVE text and the WEB build differ in what protects the stored credential and how the
// connection is trusted, so the statements are separated per platform rather than merged
// (`privacy.p7` web store + `.ts.net` CA trust, `privacy.p8` web push metadata, `.p3` Keychain
// reinstall behaviour). The full policy (EN/VI) lives in `docs/privacy-policy-en.md` /
// `docs/privacy-policy-vi.md`; this screen is the in-app notice and must not claim more than it.
//
// Keep it true: if a dependency ever adds analytics, this page must change in the same commit.

import { Pressable, StyleSheet, Text, View } from 'react-native';
import { useRouter } from 'expo-router';

import { useApp } from './_layout';
import { Card, Screen } from '../src/ui/components/ui';
import { space, useTheme } from '../src/ui/theme';

/** One paragraph of the policy, in reading order (`.p10` is the version + contact line). */
const PARAGRAPHS = [
  'privacy.p1',
  'privacy.p2',
  'privacy.p3',
  'privacy.p4',
  'privacy.p5',
  'privacy.p6',
  'privacy.p7',
  'privacy.p8',
  'privacy.p9',
  'privacy.p10',
] as const;

export default function PrivacyScreen() {
  const { tr } = useApp();
  const router = useRouter();
  const { colors, type, settingsType, hit } = useTheme();

  return (
    <Screen scroll testID="privacy-screen">
      <Text style={[type.title, { color: colors.text, paddingHorizontal: space.xl, paddingTop: space.md }]}>
        {tr('privacy.title')}
      </Text>
      <Text style={[settingsType.description, { color: colors.textFaint, paddingHorizontal: space.xl, paddingTop: space.xs }]}>
        {tr('privacy.updated')}
      </Text>

      <View style={{ paddingHorizontal: space.xl, paddingTop: space.md }}>
        <Card>
          {PARAGRAPHS.map((key) => (
            <Text
              key={key}
              style={[settingsType.description, { color: colors.text, paddingHorizontal: space.lg, paddingVertical: space.sm }]}
            >
              {tr(key)}
            </Text>
          ))}
        </Card>
      </View>

      <Pressable
        accessibilityRole="button"
        accessibilityLabel={tr('common.back')}
        onPress={() => router.back()}
        style={[styles.back, { minHeight: hit }]}
      >
        <Text style={[settingsType.item, { color: colors.accent }]}>{tr('common.back')}</Text>
      </Pressable>
    </Screen>
  );
}

const styles = StyleSheet.create({
  back: { justifyContent: 'center', paddingHorizontal: space.xl, paddingTop: space.lg },
});
