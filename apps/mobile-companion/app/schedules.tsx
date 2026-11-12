// Spec 018 item 3 — the READ-ONLY scheduled-tasks screen (scope `schedule:read`).
//
// HIDDEN, NOT DISABLED, without the grant: `schedule:read` is an explicit-only scope that is in
// `NEVER_DEFAULT_SCOPES`, and the gateway advertises no `hello` capability for the schedule reads
// (contract §3.5 names none). So Settings draws NO row unless `controller.hasReadScope('schedule:read')`
// is true — and the accessors refuse the same way (absent scopes = no grant, fail closed). A Host that
// never granted it is therefore never sent a frame it would refuse.
//
// Nothing here writes: the only frames are `schedule-catalog`, `schedule-list` and `schedule-view`,
// and the module that sends them (`src/core/schedules.ts`) has no path to a mutating type. The detail
// sheet says the task is read-only here so the user knows where to change it.
//
// The Host's `error.message` is never rendered: a thrown `CoreError` is reduced to its CODE and one
// fixed sentence (`scheduleErrorCopy` → `tr`).

import { useCallback, useEffect, useState } from 'react';
import { ActivityIndicator, Pressable, ScrollView, StyleSheet, Text, View } from 'react-native';

import { useApp } from './_layout';
import { Card, Divider, Screen, SectionLabel } from '../src/ui/components/ui';
import { space, useTheme } from '../src/ui/theme';
import type { ScheduledTask, ScheduleViewResult } from '../src/core/schedules';
import {
  formatRunTime,
  scheduleErrorCopy,
  scheduleStatusKey,
  taskDetailRows,
  toTaskRow,
  type ScheduledTaskRow,
} from '../src/ui/read-only-views';
import type { MessageKey } from '../i18n';

type DetailState =
  | { status: 'closed' }
  | { status: 'loading'; id: string }
  | { status: 'ready'; id: string; task: ScheduledTask }
  | { status: 'not-found'; id: string }
  | { status: 'failed'; id: string; copy: MessageKey };

export default function SchedulesScreen() {
  const { controller, tr } = useApp();
  // `space` is destructured as `gap` for the inline paddings; `styles` below still reads the theme.
  const { colors, type, settingsType, space: gap, radius, hit } = useTheme();
  const allowed = controller.hasReadScope('schedule:read');

  const [rows, setRows] = useState<readonly ScheduledTaskRow[]>([]);
  const [loading, setLoading] = useState(true);
  /** `null` while the list is fine; a fixed sentence after a refused read. */
  const [listError, setListError] = useState<MessageKey | null>(null);
  const [detail, setDetail] = useState<DetailState>({ status: 'closed' });

  const loadList = useCallback(async () => {
    setLoading(true);
    setListError(null);
    try {
      const answer = await controller.readSchedules({ active: true });
      if (answer.state === 'unavailable') {
        // `unavailable` = no ready socket or no `schedule:read` grant: "not available right now",
        // never the permission sentence (that is only for the locked screen at the bottom) and
        // never an empty list that reads as "no tasks".
        setListError('schedules.notNow');
        setRows([]);
      } else {
        setRows(answer.items.map((task) => toTaskRow(task, tr)));
      }
    } catch (error) {
      // A refusal is explained by its CODE, never by the Host's message.
      setListError(scheduleErrorCopy((error as { code?: string } | null)?.code));
      setRows([]);
    } finally {
      setLoading(false);
    }
  }, [controller, tr]);

  useEffect(() => {
    if (!allowed) return;
    void loadList();
  }, [allowed, loadList]);

  const openDetail = useCallback(async (id: string) => {
    setDetail({ status: 'loading', id });
    try {
      const answer: ScheduleViewResult | { state: 'unavailable' } = await controller.readSchedule(id);
      if (answer.state === 'ready') setDetail({ status: 'ready', id, task: answer.task });
      else if (answer.state === 'not-found') setDetail({ status: 'not-found', id });
      else setDetail({ status: 'failed', id, copy: 'schedules.notNow' });
    } catch (error) {
      setDetail({ status: 'failed', id, copy: scheduleErrorCopy((error as { code?: string } | null)?.code) });
    }
  }, [controller]);

  if (!allowed) {
    // Hidden by design: no grant ⇒ no screen and no request. Told plainly instead of an empty page.
    return (
      <Screen testID="schedules-hidden">
        <View style={{ padding: gap.xl }}>
          <Text style={[type.body, { color: colors.textMuted }]}>{tr('schedules.unavailable')}</Text>
        </View>
      </Screen>
    );
  }

  return (
    <Screen scroll testID="schedules-screen">
      <View style={{ paddingHorizontal: gap.xl, paddingTop: gap.md, flexDirection: 'row', alignItems: 'center', gap: gap.sm }}>
        <Text style={[type.title, { color: colors.text, flex: 1 }]}>{tr('schedules.title')}</Text>
        <Pressable
          accessibilityRole="button"
          accessibilityLabel={tr('schedules.refresh')}
          onPress={() => void loadList()}
          testID="schedules-refresh"
          style={{ minWidth: hit, minHeight: hit, alignItems: 'center', justifyContent: 'center' }}
        >
          <Text style={[type.body, { color: colors.accent }]}>{tr('schedules.refresh')}</Text>
        </Pressable>
      </View>

      {loading ? (
        <View style={{ paddingHorizontal: gap.xl, paddingTop: gap.lg }} testID="schedules-loading">
          <ActivityIndicator color={colors.accent} />
        </View>
      ) : null}

      {!loading && listError !== null ? (
        <View style={{ paddingHorizontal: gap.xl, paddingTop: gap.lg, gap: gap.sm }} testID="schedules-error">
          <Text style={[type.caption, { color: colors.textMuted }]}>{tr(listError)}</Text>
          <Pressable accessibilityRole="button" accessibilityLabel={tr('team.retry')} onPress={() => void loadList()} testID="schedules-retry">
            <Text style={[type.caption, { color: colors.accent }]}>{tr('team.retry')}</Text>
          </Pressable>
        </View>
      ) : null}

      {!loading && listError === null && rows.length === 0 ? (
        <View style={{ paddingHorizontal: gap.xl, paddingTop: gap.lg }} testID="schedules-empty">
          <Text style={[type.caption, { color: colors.textMuted }]}>{tr('schedules.emptyActive')}</Text>
        </View>
      ) : null}

      {!loading && listError === null && rows.length > 0 ? (
        <View style={{ paddingHorizontal: gap.xl, paddingTop: gap.lg }}>
          <SectionLabel style={{ paddingBottom: gap.xs }}>{tr('schedules.status.active')}</SectionLabel>
          <Card>
            {rows.map((row, index) => (
              <View key={row.id}>
                {index > 0 ? <Divider inset={0} /> : null}
                <Pressable
                  accessibilityRole="button"
                  accessibilityLabel={row.title}
                  onPress={() => void openDetail(row.id)}
                  style={({ pressed }) => [styles.row, pressed && styles.pressed]}
                  testID={`schedules-row-${row.id}`}
                >
                  <View style={{ flex: 1, gap: 2 }}>
                    <Text style={[settingsType.item, { color: colors.text }]} numberOfLines={1}>
                      {row.title}
                    </Text>
                    <Text style={[settingsType.description, { color: colors.textMuted }]} numberOfLines={1}>
                      {tr(row.statusKey)} · {row.rule}
                    </Text>
                  </View>
                  <Text style={[settingsType.description, { color: colors.textFaint }]} numberOfLines={1}>
                    {(() => {
                      const when = formatRunTime(row.nextRunAt);
                      return when === null ? tr('schedules.none') : tr('schedules.nextRun', { when });
                    })()}
                  </Text>
                </Pressable>
              </View>
            ))}
          </Card>
        </View>
      ) : null}

      {detail.status === 'closed' ? null : (
        <View
          style={[
            styles.detail,
            { backgroundColor: colors.surfaceRaised, borderColor: colors.border, borderRadius: radius.xl },
          ]}
          testID="schedules-detail"
        >
          <View style={{ flexDirection: 'row', alignItems: 'center', gap: gap.sm }}>
            <Text style={[type.heading, { color: colors.text, flex: 1 }]} numberOfLines={1}>
              {detail.status === 'ready' ? detail.task.title ?? tr('schedules.detailTitle') : tr('schedules.detailTitle')}
            </Text>
            <Pressable
              accessibilityRole="button"
              accessibilityLabel={tr('common.back')}
              onPress={() => setDetail({ status: 'closed' })}
              testID="schedules-detail-close"
              style={{ minWidth: hit, minHeight: 32, alignItems: 'center', justifyContent: 'center' }}
            >
              <Text style={[type.heading, { color: colors.textMuted }]}>✕</Text>
            </Pressable>
          </View>
          {detail.status === 'loading' ? <ActivityIndicator color={colors.accent} /> : null}
          {detail.status === 'not-found' ? (
            <Text style={[type.caption, { color: colors.textMuted }]} testID="schedules-detail-notfound">
              {tr('schedules.notFound')}
            </Text>
          ) : null}
          {detail.status === 'failed' ? (
            <Text style={[type.caption, { color: colors.textMuted }]} testID="schedules-detail-failed">
              {tr(detail.copy)}
            </Text>
          ) : null}
          {detail.status === 'ready' ? (
            <ScrollView contentContainerStyle={{ gap: gap.xs }} style={{ maxHeight: 320 }}>
              <Text style={[type.captionSmall, { color: colors.textFaint }]}>{tr('schedules.readOnly')}</Text>
              {taskDetailRows(detail.task, tr).map((row) => (
                <View key={row.label} style={styles.fieldRow}>
                  <Text style={[type.caption, { color: colors.textMuted, flexShrink: 1 }]}>{tr(row.label)}</Text>
                  <Text style={[type.bodySmall, { color: colors.text }]} numberOfLines={2}>
                    {row.value}
                  </Text>
                </View>
              ))}
            </ScrollView>
          ) : null}
        </View>
      )}

      <View style={{ height: gap.xxxl }} />
    </Screen>
  );
}

// Static style sheet: the theme's dynamic colors/radius go inline, only the fixed spacing lives here.
const styles = StyleSheet.create({
  row: { flexDirection: 'row', alignItems: 'center', gap: 12, minHeight: 56, paddingVertical: 8, paddingHorizontal: 16 },
  pressed: { opacity: 0.7 },
  detail: { marginHorizontal: 20, marginTop: 20, padding: 16, gap: 8, borderWidth: StyleSheet.hairlineWidth },
  fieldRow: { flexDirection: 'row', justifyContent: 'space-between', alignItems: 'baseline', gap: 12 },
});
