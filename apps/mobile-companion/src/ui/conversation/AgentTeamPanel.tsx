// Spec 017 Đợt 2 (item 2, UI side): the agent team of a session, read-only.
//
// Three states come from the client (`src/core/team.ts`) and all three are drawn DIFFERENTLY:
//   ready               → members, tasks, sub-agent catalog
//   unavailable         → "this session has no team yet"
//   migration-required  → "the Host must migrate this session first" (+ retry)
//   failed              → a mapped sentence for the error code (never the Host's raw message)
// A zero-length list is only ever shown for `ready`, so "not projected yet" can never masquerade as
// "a team of nobody".
//
// The bulky field is a task's `description`: two lines by default, tapping the task opens it. That is
// presentation only — the text is verbatim once opened.

import { useState } from 'react';
import { Pressable, StyleSheet, Text, View } from 'react-native';

import type { Interpolate } from '../../../i18n';
import { useTheme } from '../theme';
import {
  groupMembersByPhase,
  taskTally,
  type CatalogView,
  type TeamMemberView,
  type TeamTaskView,
  type TeamView,
  type TeamViewState,
} from './team-view';

function StateNotice({
  state,
  asOfSeq,
  errorText,
  tr,
}: {
  state: TeamViewState;
  asOfSeq?: number;
  /** Already code-mapped by the caller (`teamErrorCopy` → `tr`); never the Host's raw message. */
  errorText?: string;
  tr: Interpolate;
}) {
  const theme = useTheme();
  const { colors, type } = theme;
  // The caller maps the failure CODE to copy, so a specific code (`session/not-found`, `auth/*`) gets
  // its own sentence; the generic one is only the fallback for a missing/empty mapping.
  const copy =
    state === 'migration-required'
      ? tr('team.migrationRequired')
      : state === 'failed'
        ? errorText !== undefined && errorText !== ''
          ? errorText
          : tr('team.errorGeneric')
        : tr('team.unavailable');
  return (
    <Text style={[type.caption, { color: colors.textMuted }]} testID={`agent-team-state-${state}`}>
      {asOfSeq === undefined ? copy : `${copy} · #${asOfSeq}`}
    </Text>
  );
}

function MemberList({ members, tr }: { members: TeamMemberView[]; tr: Interpolate }) {
  const theme = useTheme();
  const { colors, type, space } = theme;
  return (
    <View style={{ gap: space.xxs }} testID="agent-team-members">
      <Text style={[type.caption, { color: colors.textMuted, textTransform: 'uppercase', letterSpacing: 1 }]}>
        {`${tr('team.members')} · ${members.length}`}
      </Text>
      {groupMembersByPhase(members).map((group) => (
        <View key={group.phase} style={{ gap: space.xxs }}>
          <Text style={[type.captionSmall, { color: colors.textFaint }]}>{group.phase}</Text>
          {group.members.map((member) => (
            <View
              key={member.id}
              style={[styles.row, { gap: space.sm }]}
              testID={`agent-team-member-${member.id}`}
            >
              <View style={[styles.dot, { backgroundColor: colors.accent }]} />
              <Text style={[type.bodySmall, { color: colors.text, flexShrink: 1 }]} numberOfLines={1}>
                {member.name}
              </Text>
              {member.role === '' ? null : (
                <Text style={[type.captionSmall, { color: colors.textMuted }]} numberOfLines={1}>
                  {member.role}
                </Text>
              )}
            </View>
          ))}
        </View>
      ))}
    </View>
  );
}

function TaskList({
  tasks,
  tr,
}: {
  tasks: TeamTaskView[];
  tr: Interpolate;
}) {
  const theme = useTheme();
  const { colors, type, space, radius } = theme;
  const [openTask, setOpenTask] = useState<string | null>(null);
  const tally = taskTally(tasks);

  return (
    <View style={{ gap: space.xxs }} testID="agent-team-tasks">
      <Text style={[type.caption, { color: colors.textMuted, textTransform: 'uppercase', letterSpacing: 1 }]}>
        {`${tr('team.tasks')} · ${tally.total}${tally.blocked === 0 ? '' : ` · ${tally.blocked} ${tr('team.blocked')}`}`}
      </Text>
      {tasks.map((task) => {
        const expanded = openTask === task.id;
        return (
          <Pressable
            key={task.id}
            testID={`agent-team-task-${task.id}`}
            accessibilityRole="button"
            accessibilityState={{ expanded }}
            accessibilityLabel={task.subject}
            onPress={() => setOpenTask(expanded ? null : task.id)}
            style={[
              styles.task,
              {
                backgroundColor: colors.surface,
                borderColor: task.blocked ? colors.warning : colors.border,
                borderRadius: radius.sm,
                padding: space.sm,
                gap: space.xxs,
              },
            ]}
          >
            <View style={[styles.row, { gap: space.xs }]}>
              {task.blocked ? (
                <Text style={[type.captionSmall, { color: colors.warning }]}>⛔</Text>
              ) : (
                <View style={[styles.dot, { backgroundColor: colors.textFaint }]} />
              )}
              <Text style={[type.bodySmall, { color: colors.text, flex: 1 }]} numberOfLines={1}>
                {task.subject}
              </Text>
              {task.status === '' ? null : (
                <Text style={[type.captionSmall, { color: colors.textMuted }]} numberOfLines={1}>
                  {task.status}
                </Text>
              )}
            </View>
            {task.owner === undefined ? null : (
              <Text style={[type.captionSmall, { color: colors.textFaint }]} numberOfLines={1}>
                {task.owner}
              </Text>
            )}
            {task.description === undefined ? null : (
              <Text
                style={[type.captionSmall, { color: colors.textMuted }]}
                numberOfLines={expanded ? undefined : 2}
                testID={`agent-team-task-description-${task.id}`}
              >
                {task.description}
              </Text>
            )}
          </Pressable>
        );
      })}
    </View>
  );
}

function CatalogList({ entries, tr }: { entries: CatalogView['entries']; tr: Interpolate }) {
  const theme = useTheme();
  const { colors, type, space } = theme;
  return (
    <View style={{ gap: space.xxs }} testID="agent-team-catalog">
      <Text style={[type.caption, { color: colors.textMuted, textTransform: 'uppercase', letterSpacing: 1 }]}>
        {`${tr('team.subagents')} · ${entries.length}`}
      </Text>
      {entries.map((entry) => (
        <View key={entry.id} style={[styles.row, { gap: space.sm }]}>
          <View style={[styles.dot, { backgroundColor: colors.textFaint }]} />
          <Text style={[type.bodySmall, { color: colors.text, flexShrink: 1 }]} numberOfLines={1}>
            {entry.label ?? entry.id}
          </Text>
          {entry.mode === undefined ? null : (
            <Text style={[type.captionSmall, { color: colors.textMuted }]} numberOfLines={1}>
              {entry.mode}
            </Text>
          )}
        </View>
      ))}
    </View>
  );
}

export function AgentTeamPanel({
  team,
  catalog,
  tr,
  onRetry,
}: {
  team: TeamView;
  catalog: CatalogView | null;
  tr: Interpolate;
  /** Shown only for the recoverable states; a `ready` team needs no retry. */
  onRetry?: () => void;
}) {
  const theme = useTheme();
  const { colors, type, space, radius } = theme;
  const showTeam = team.state === 'ready';
  const catalogUsable = catalog !== null && catalog.state === 'ready';

  return (
    <View style={{ gap: space.lg }}>
      {showTeam ? (
        <>
          <MemberList members={team.members} tr={tr} />
          <TaskList tasks={team.tasks} tr={tr} />
        </>
      ) : (
        <StateNotice state={team.state} asOfSeq={team.asOfSeq} errorText={team.errorText} tr={tr} />
      )}

      {catalogUsable ? <CatalogList entries={catalog.entries} tr={tr} /> : null}

      {/* A failed or half-projected read is recoverable by asking again; say so instead of leaving a
          dead screen. Only offered when the caller can actually re-read. */}
      {onRetry !== undefined && (team.state !== 'ready' || (catalog !== null && catalog.state !== 'ready')) ? (
        <Pressable
          accessibilityRole="button"
          accessibilityLabel={tr('team.retry')}
          onPress={onRetry}
          testID="agent-team-retry"
          style={[styles.retry, { borderColor: colors.border, borderRadius: radius.sm, minHeight: 44, paddingHorizontal: space.md }]}
        >
          <Text style={[type.bodySmall, { color: colors.accent }]}>{tr('team.retry')}</Text>
        </Pressable>
      ) : null}
    </View>
  );
}

const styles = StyleSheet.create({
  row: { flexDirection: 'row', alignItems: 'center' },
  dot: { width: 6, height: 6, borderRadius: 3 },
  task: { borderWidth: StyleSheet.hairlineWidth },
  retry: { borderWidth: StyleSheet.hairlineWidth, alignItems: 'center', justifyContent: 'center' },
});
