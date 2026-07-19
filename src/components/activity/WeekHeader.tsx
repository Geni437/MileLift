import React from 'react';
import { StyleSheet, Text, View } from 'react-native';

import { theme } from '../../theme';
import { formatDistanceValue, formatWeekLabel } from '../../lib/format';
import { MetricBar } from './MetricBar';
import type { UnitDistanceSnapshot } from '../../db/types';

type Props = {
  weekKey: string;
  totalDistanceM: number;
  activityCount: number;
  unit: UnitDistanceSnapshot;
};

/** WeekHeader — timeline week grouping with the week's aggregate (the "training adds up" thesis, CORE-02). */
export function WeekHeader({ weekKey, totalDistanceM, activityCount, unit }: Props) {
  return (
    <View style={styles.container}>
      <Text style={[theme.type.heading, { color: theme.color.text.primary }]} maxFontSizeMultiplier={1.8}>{formatWeekLabel(weekKey)}</Text>
      <MetricBar
        size="inline"
        items={[
          { key: 'distance', value: formatDistanceValue(totalDistanceM, unit), unit, label: 'Distance' },
          { key: 'count', value: String(activityCount), label: activityCount === 1 ? 'Activity' : 'Activities' },
        ]}
      />
    </View>
  );
}

const styles = StyleSheet.create({
  container: {
    gap: theme.space.xs,
    paddingTop: theme.space.md,
  },
});
