import React from 'react';
import { Pressable, StyleSheet, Text, View } from 'react-native';

import { theme } from '../../theme';
import { formatDuration, formatRelativeDateTime, formatVolumeValue } from '../../lib/format';
import { MetricBar } from '../activity/MetricBar';
import { PrBadge } from '../activity/PrBadge';
import { SyncStatusPill } from '../SyncStatusPill';
import { LiftStack, type LiftStackSegment } from './LiftStack';
import type { LocalWorkoutSession, UnitWeightSnapshot } from '../../db/types';

type Props = {
  session: LocalWorkoutSession;
  unitWeight: UnitWeightSnapshot;
  segments: LiftStackSegment[];
  hasPr: boolean;
  onPress: () => void;
  onRetrySync?: () => void;
};

/** WorkoutRow — one session in the Lift history timeline (CORE-15), the vertical-cyan counterpart to ActivityRow. */
export function WorkoutRow({ session, unitWeight, segments, hasPr, onPress, onRetrySync }: Props) {
  const title = session.title ?? 'Workout';
  return (
    <Pressable
      onPress={onPress}
      accessibilityRole="button"
      accessibilityLabel={`${title}, ${formatRelativeDateTime(session.occurredAt)}${hasPr ? ', set a personal record' : ''}`}
      style={({ pressed }) => [styles.row, pressed && { opacity: theme.opacity.pressed }]}
    >
      <View style={styles.content}>
        <View style={styles.header}>
          <View style={styles.titleColumn}>
            <Text style={[theme.type.bodyStrong, { color: theme.color.text.primary }]} numberOfLines={1} maxFontSizeMultiplier={1.8}>
              {title}
            </Text>
            <Text style={[theme.type.caption, { color: theme.color.text.secondary }]} maxFontSizeMultiplier={2}>
              {formatRelativeDateTime(session.occurredAt)}
            </Text>
          </View>
          {session.syncStatus !== 'synced' && <SyncStatusPill status={session.syncStatus} onRetry={onRetrySync} />}
        </View>

        {hasPr && (
          <View style={styles.tagsRow}>
            <PrBadge />
          </View>
        )}

        <MetricBar
          size="inline"
          items={[
            { key: 'volume', value: formatVolumeValue(session.totalVolumeKg, unitWeight), unit: unitWeight, label: 'Volume' },
            { key: 'sets', value: String(session.totalSets ?? 0), label: 'Sets' },
            { key: 'duration', value: formatDuration(session.durationSeconds), label: 'Duration' },
          ]}
        />
      </View>

      <LiftStack variant="static" segments={segments} height={56} />
    </Pressable>
  );
}

const styles = StyleSheet.create({
  row: {
    flexDirection: 'row',
    gap: theme.space.sm,
    paddingVertical: theme.space.sm,
  },
  content: {
    flex: 1,
    gap: theme.space.xs,
  },
  header: {
    flexDirection: 'row',
    justifyContent: 'space-between',
    alignItems: 'flex-start',
    gap: theme.space.sm,
  },
  titleColumn: {
    flex: 1,
    gap: 2,
  },
  tagsRow: {
    flexDirection: 'row',
    gap: theme.space.xs,
  },
});
