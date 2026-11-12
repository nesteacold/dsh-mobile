// Storage space (reference: `StorageSpaceScreen.kt`) — what this app keeps on THIS phone.
//
// Scope, and why it is narrow: only files inside the app's own document directory are counted, and
// clearing goes through `src/ui/storage-space-reader.ts`. Credentials (`expo-secure-store`) are not
// cache: nothing on this screen can read or delete them (asserted in test/storage-space.test.ts).
//
// Every number shown was measured. When there is nothing cached the screen says so instead of drawing
// a zero-byte bar, so it never implies it cleaned something that did not exist.

import { useCallback, useEffect, useState } from 'react';
import { Alert, Pressable, StyleSheet, Text, View } from 'react-native';
import { useRouter } from 'expo-router';

import { useApp } from './_layout';
import { Card, Screen, SectionLabel } from '../src/ui/components/ui';
import { space, useTheme } from '../src/ui/theme';
import {
  formatBytes,
  summarizeStorage,
  totalStorage,
  type StorageCategory,
  type StorageCategoryId,
} from '../src/ui/storage-space';
import { deleteStorageEntries, readStorageEntries } from '../src/ui/storage-space-reader';

/** i18n key for a category label. */
function categoryLabelKey(id: StorageCategoryId) {
  return `storage.category.${id}` as const;
}

export default function StorageScreen() {
  const { tr } = useApp();
  const router = useRouter();
  const { colors, type, settingsType, radius, hit } = useTheme();
  const [categories, setCategories] = useState<readonly StorageCategory[]>([]);
  const [fileNames, setFileNames] = useState<readonly string[]>([]);
  const [notice, setNotice] = useState<string | null>(null);

  const refresh = useCallback(() => {
    const entries = readStorageEntries();
    setFileNames(entries.map((entry) => entry.name));
    setCategories(summarizeStorage(entries));
  }, []);

  useEffect(() => {
    refresh();
  }, [refresh]);

  /** Clear exactly the files of one category, or everything when `id` is null. */
  const clear = useCallback(
    (id: StorageCategoryId | null) => {
      const names = id === null
        ? fileNames
        : fileNames.filter((name) => {
            const entry = readStorageEntries().find((candidate) => candidate.name === name);
            return entry !== undefined && summarizeStorage([entry])[0]?.id === id;
          });
      const removed = deleteStorageEntries(names);
      refresh();
      setNotice(tr('storage.cleared', { count: removed }));
    },
    [fileNames, refresh, tr],
  );

  const total = totalStorage(categories);

  return (
    <Screen scroll testID="storage-screen">
      <Text style={[type.title, { color: colors.text, paddingHorizontal: space.xl, paddingTop: space.md }]}>
        {tr('storage.title')}
      </Text>

      <View style={styles.group}>
        <SectionLabel style={{ paddingHorizontal: space.xl }}>{tr('storage.total')}</SectionLabel>
        <View style={{ paddingHorizontal: space.xl, paddingTop: space.sm }}>
          <Card>
            <View style={[styles.row, { minHeight: hit }]}>
              <Text style={[settingsType.item, { color: colors.text }]} testID="storage-total">
                {formatBytes(total)}
              </Text>
            </View>
            <Text style={[settingsType.description, { color: colors.textFaint, paddingHorizontal: space.lg, paddingBottom: space.sm }]}>
              {tr('storage.hint')}
            </Text>
          </Card>
        </View>
      </View>

      {categories.length === 0 ? (
        <Text
          testID="storage-empty"
          style={[settingsType.description, { color: colors.textMuted, paddingHorizontal: space.xl, paddingTop: space.lg }]}
        >
          {tr('storage.empty')}
        </Text>
      ) : (
        <View style={styles.group}>
          <SectionLabel style={{ paddingHorizontal: space.xl }}>{tr('storage.clear')}</SectionLabel>
          <View style={{ paddingHorizontal: space.xl, paddingTop: space.sm }}>
            <Card>
              {categories.map((category) => (
                <Pressable
                  key={category.id}
                  testID={`storage-clear-${category.id}`}
                  accessibilityRole="button"
                  accessibilityLabel={`${tr(categoryLabelKey(category.id))} — ${formatBytes(category.bytes)}`}
                  onPress={() => clear(category.id)}
                  style={[styles.row, { minHeight: hit }]}
                >
                  <Text style={[settingsType.item, { color: colors.text, flex: 1 }]}>
                    {tr(categoryLabelKey(category.id))}
                  </Text>
                  <Text style={[settingsType.item, { color: colors.textMuted }]}>{formatBytes(category.bytes)}</Text>
                </Pressable>
              ))}
            </Card>
          </View>
          <Pressable
            testID="storage-clear-all"
            accessibilityRole="button"
            accessibilityLabel={tr('storage.clearAll')}
            onPress={() =>
              Alert.alert(tr('storage.clearAll'), tr('storage.clearAllConfirm'), [
                { text: tr('common.cancel'), style: 'cancel' },
                { text: tr('storage.clearAll'), style: 'destructive', onPress: () => clear(null) },
              ])
            }
            style={[styles.row, { minHeight: hit, paddingHorizontal: space.xl }]}
          >
            <Text style={[settingsType.item, { color: colors.danger }]}>{tr('storage.clearAll')}</Text>
          </Pressable>
        </View>
      )}

      {notice === null ? null : (
        <Text
          testID="storage-notice"
          style={[settingsType.description, { color: colors.textMuted, paddingHorizontal: space.xl, paddingTop: space.md }]}
        >
          {notice}
        </Text>
      )}

      <Pressable
        accessibilityRole="button"
        accessibilityLabel={tr('common.back')}
        onPress={() => router.back()}
        style={[styles.row, { minHeight: hit, paddingHorizontal: space.xl, borderRadius: radius.sm }]}
      >
        <Text style={[settingsType.item, { color: colors.accent }]}>{tr('common.back')}</Text>
      </Pressable>
    </Screen>
  );
}

const styles = StyleSheet.create({
  group: { paddingTop: space.lg },
  row: { flexDirection: 'row', alignItems: 'center', gap: space.sm, paddingHorizontal: space.lg },
});
