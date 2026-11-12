// UI ported from Clarklevis1995/dsh-mobile androidApp/src/main/kotlin/com/clarklevis/dsh/android/ui/
// SettingsScreen.kt + SettingsTypography.kt + FontSizeSettingsScreen.kt (grouped rows, 17/22 item
// type, inset dividers) (MIT).
//
// Spec 011 P1-A item 6 — ONLY rows that work today. Clarklevis's Settings has dozens of entries
// (tailscale tunnel, plugins, storage, logs, appearance, about, ...); every one whose operation the
// companion cannot call yet is omitted rather than rendered dead (spec: "no button without
// something behind it"). Omitted in P1 and listed in the spec's P2 table:
//   theme override (needs a light/dark preference, theme follows the system today),
//   language switch (the locale feeds AppController's lifecycle; changing it at runtime is a
//   controller change, not a UI change — P2), storage/logs/plugins/tailscale/about.

import { useState } from 'react';
import { Alert, Platform, Pressable, StyleSheet, Text, View } from 'react-native';
import { useRouter } from 'expo-router';

import { useApp } from './_layout';
import { Card, Divider, Screen, SectionLabel, StatusDot } from '../src/ui/components/ui';
import { FONT_SCALES, space, useTheme } from '../src/ui/theme';
import { saveFontScale } from '../src/ui/font-scale-store';

export default function SettingsScreen() {
  const { controller, snapshot, tr } = useApp();
  const router = useRouter();
  const { colors, type, settingsType, radius, fontScale, setFontScale } = useTheme();
  const [busy, setBusy] = useState(false);

  const host = snapshot.activeHost;
  /**
   * Spec 018 item 3: `schedule:read` is explicit-only (never a default) and no `hello` capability
   * advertises it, so the device's granted scopes are the gate. Without it the row is NOT drawn
   * (the screen itself also refuses), instead of opening a page that could only say "not granted".
   */
  const canReadSchedules = controller.hasReadScope('schedule:read');
  /**
   * Spec 021: "Lock now" only exists where a passkey lock exists. The snapshot's `webLock` is
   * non-null exactly for a device the Host locks (`web:unlock`), so a native install — which is
   * never locked — draws no row for it, and the button is never dead.
   */
  const webLock = snapshot.webLock;

  const forget = (): void => {
    Alert.alert(tr('sessions.forget'), tr('sessions.forgetConfirm'), [
      { text: tr('common.cancel'), style: 'cancel' },
      {
        text: tr('sessions.forget'),
        style: 'destructive',
        onPress: () => {
          setBusy(true);
          void controller.forget().finally(() => setBusy(false));
        },
      },
    ]);
  };

  return (
    <Screen scroll testID="settings-screen">
      <Text style={[type.title, { color: colors.text, paddingHorizontal: space.xl, paddingTop: space.md }]}>
        {tr('settings.title')}
      </Text>

      <View style={styles.group}>
        <SectionLabel style={{ paddingHorizontal: space.xl }}>{tr('settings.computer')}</SectionLabel>
        {/* Spec 018 item 3: read-only scheduled tasks of this computer — only with `schedule:read`. */}
        {canReadSchedules ? (
          <View style={{ paddingHorizontal: space.xl, paddingTop: space.sm }}>
            <Card>
              <Pressable
                testID="settings-schedules"
                accessibilityRole="button"
                accessibilityLabel={tr('schedules.open')}
                onPress={() => router.push('/schedules')}
                style={[styles.row, { minHeight: 48 }]}
              >
                <Text style={[settingsType.item, { color: colors.text, flex: 1 }]}>{tr('schedules.open')}</Text>
                <Text style={[settingsType.item, { color: colors.textMuted }]}>›</Text>
              </Pressable>
            </Card>
          </View>
        ) : null}
        {host === null ? (
          <View style={{ paddingHorizontal: space.xl, paddingTop: space.sm }}>
            <Card>
              <Pressable
                accessibilityRole="button"
                accessibilityLabel={tr('settings.pairAnother')}
                onPress={() => router.push('/pair')}
                style={styles.row}
              >
                <Text style={[settingsType.item, { color: colors.accent }]}>{tr('settings.pairAnother')}</Text>
              </Pressable>
            </Card>
          </View>
        ) : (
          <View style={{ paddingHorizontal: space.xl, paddingTop: space.sm }}>
            <Card>
              <View style={styles.row}>
                <StatusDot kind={snapshot.banner === 'none' && snapshot.reconnect === null ? 'running' : 'idle'} />
                <View style={{ flex: 1 }}>
                  <Text style={[settingsType.item, { color: colors.text }]} numberOfLines={1}>
                    {host.name}
                  </Text>
                  <Text style={[settingsType.description, { color: colors.textMuted }]} numberOfLines={1}>
                    {host.publicUrl}
                  </Text>
                </View>
              </View>
              <Divider inset={0} />
              <Pressable
                accessibilityRole="button"
                accessibilityLabel={tr('settings.pairAnother')}
                onPress={() => router.push('/pair')}
                style={({ pressed }) => [styles.row, pressed && styles.pressed]}
              >
                <Text style={[settingsType.item, { color: colors.accent }]}>{tr('settings.pairAnother')}</Text>
              </Pressable>
              <Divider inset={0} />
              <Pressable
                accessibilityRole="button"
                accessibilityLabel={tr('sessions.forget')}
                disabled={busy}
                onPress={forget}
                style={({ pressed }) => [styles.row, (pressed || busy) && styles.pressed]}
              >
                <Text style={[settingsType.item, { color: colors.danger }]}>{tr('sessions.forget')}</Text>
              </Pressable>
              {/* Spec 021: the web (PWA) "Lock" action — sends `passkey-lock` and closes the socket,
                  so the next frame, reload or tab needs the passkey again. Web only: a native install
                  never carries `web:unlock` and is never locked, so it draws no row. */}
              {Platform.OS === 'web' && webLock !== null ? (
                <>
                  <Divider inset={0} />
                  <Pressable
                    testID="settings-lock-now"
                    accessibilityRole="button"
                    accessibilityLabel={tr('settings.lockNow')}
                    onPress={() => {
                      void controller.lockWebDevice();
                    }}
                    style={({ pressed }) => [styles.row, pressed && styles.pressed]}
                  >
                    <Text style={[settingsType.item, { color: colors.text }]}>{tr('settings.lockNow')}</Text>
                  </Pressable>
                </>
              ) : null}
            </Card>
          </View>
        )}
      </View>

      <View style={styles.group}>
        <SectionLabel style={{ paddingHorizontal: space.xl }}>{tr('storage.title')}</SectionLabel>
        <View style={{ paddingHorizontal: space.xl, paddingTop: space.sm }}>
          <Card>
            <Pressable
              testID="settings-storage"
              accessibilityRole="button"
              accessibilityLabel={tr('storage.title')}
              onPress={() => router.push('/storage')}
              style={[styles.row, { minHeight: 48 }]}
            >
              <Text style={[settingsType.item, { color: colors.text, flex: 1 }]}>{tr('storage.title')}</Text>
              <Text style={[settingsType.item, { color: colors.textMuted }]}>›</Text>
            </Pressable>
            <Divider />
            <Pressable
              testID="settings-privacy"
              accessibilityRole="button"
              accessibilityLabel={tr('privacy.title')}
              onPress={() => router.push('/privacy')}
              style={[styles.row, { minHeight: 48 }]}
            >
              <Text style={[settingsType.item, { color: colors.text, flex: 1 }]}>{tr('privacy.title')}</Text>
              <Text style={[settingsType.item, { color: colors.textMuted }]}>›</Text>
            </Pressable>
          </Card>
        </View>
      </View>

      <View style={styles.group}>
        <SectionLabel style={{ paddingHorizontal: space.xl }}>{tr('settings.fontSize')}</SectionLabel>
        <View style={{ paddingHorizontal: space.xl, paddingTop: space.sm }}>
          <Card>
            <View style={styles.row}>
              {FONT_SCALES.map((scale) => {
                const active = Math.abs(fontScale - scale) < 0.001;
                return (
                  <Pressable
                    key={scale}
                    testID={`settings-font-${Math.round(scale * 100)}`}
                    accessibilityRole="button"
                    accessibilityLabel={`${Math.round(scale * 100)}%`}
                    accessibilityState={{ selected: active }}
                    onPress={() => {
                      setFontScale(scale);
                      // Remembered across restarts (src/ui/font-scale-store.ts); a failed write only
                      // means the choice is not persisted, it never breaks the screen.
                      void saveFontScale(scale);
                    }}
                    style={[
                      styles.scaleChip,
                      { borderColor: colors.border, borderRadius: radius.sm, backgroundColor: active ? colors.accent : 'transparent' },
                    ]}
                  >
                    <Text style={[settingsType.item, { color: active ? colors.onAccent : colors.text }]}>
                      {Math.round(scale * 100)}%
                    </Text>
                  </Pressable>
                );
              })}
            </View>
            <Text style={[settingsType.description, { color: colors.textFaint, paddingHorizontal: space.lg, paddingBottom: space.sm }]}>
              {tr('settings.fontSizeHint')}
            </Text>
          </Card>
        </View>
      </View>
    </Screen>
  );
}

const styles = StyleSheet.create({
  group: { paddingTop: space.xxl },
  row: { flexDirection: 'row', alignItems: 'center', gap: space.md, minHeight: 44, paddingVertical: space.sm },
  pressed: { opacity: 0.7 },
  scaleChip: { flex: 1, alignItems: 'center', justifyContent: 'center', minHeight: 44, borderWidth: StyleSheet.hairlineWidth, marginHorizontal: 2 },
});
