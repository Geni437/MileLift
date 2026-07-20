import React from 'react';
import { Pressable, StyleSheet, Text, View } from 'react-native';

import { theme } from '../../theme';
import { formatDistanceValue, formatDuration, formatPace, formatRelativeDateTime } from '../../lib/format';
import { MetricBar } from './MetricBar';
import { MeridianTrace } from './MeridianTrace';
import { PrBadge } from './PrBadge';
import { SyncStatusPill } from '../SyncStatusPill';
import type { ActivityType, LocalActivity } from '../../db/types';

type Props = {
  activity: LocalActivity;
  activityType: ActivityType | null;
  hasPr: boolean;
  onPress: () => void;
  onRetrySync?: () => void;
};

/** ActivityRow — one activity in the Log timeline (CORE-02/05). */
export function ActivityRow({ activity, activityType, hasPr, onPress, onRetrySync }: Props) {
  const isDistanceBased = activityType?.isDistanceBased ?? activity.distanceM != null;
  const isManual = !activity.hasGpsRoute;
  const isFromWatch = activity.source === 'wearable';

  const metricItems = isDistanceBased
    ? [
        { key: 'distance', value: formatDistanceValue(activity.distanceM, activity.unitDistanceSnapshot), unit: activity.unitDistanceSnapshot, label: 'Distance' },
        { key: 'time', value: formatDuration(activity.movingTimeSeconds ?? activity.durationSeconds), label: 'Time' },
        { key: 'pace', value: formatPace(activity.averageSpeedMps, activity.unitDistanceSnapshot), label: 'Avg pace' },
      ]
    : [{ key: 'time', value: formatDuration(activity.durationSeconds), label: 'Duration' }];

  const title = activity.title ?? activity.activityTypeNameSnapshot;

  return (
    <Pressable
      onPress={onPress}
      accessibilityRole="button"
      accessibilityLabel={`${activity.activityTypeNameSnapshot} — ${title}, ${formatRelativeDateTime(activity.occurredAt)}${hasPr ? ', set a personal record' : ''}`}
      style={({ pressed }) => [styles.row, pressed && { opacity: theme.opacity.pressed }]}
    >
      <View style={styles.header}>
        <View style={styles.titleColumn}>
          <Text style={[theme.type.bodyStrong, { color: theme.color.text.primary }]} numberOfLines={1} maxFontSizeMultiplier={1.8}>
            {activity.activityTypeNameSnapshot} · {title}
          </Text>
          <Text style={[theme.type.caption, { color: theme.color.text.secondary }]} maxFontSizeMultiplier={2}>
            {formatRelativeDateTime(activity.occurredAt)}
          </Text>
        </View>
        {activity.syncStatus !== 'synced' && <SyncStatusPill status={activity.syncStatus} onRetry={onRetrySync} />}
      </View>

      <View style={styles.tagsRow}>
        {hasPr && <PrBadge />}
        {isManual && (
          <Text style={[theme.type.overline, { color: theme.color.text.secondary }]} maxFontSizeMultiplier={1.8}>
            MANUAL
          </Text>
        )}
        {isFromWatch && (
          <Text style={[theme.type.overline, { color: theme.color.accent.data }]} maxFontSizeMultiplier={1.8}>
            FROM WATCH
          </Text>
        )}
      </View>

      <MetricBar items={metricItems} size="inline" />

      <MeridianTrace variant={isManual ? 'empty' : 'static'} compact height={20} />
    </Pressable>
  );
}

const styles = StyleSheet.create({
  row: {
    paddingVertical: theme.space.sm,
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
    minHeight: 16,
  },
});
