import React from 'react';
import { Pressable, StyleSheet, Text, View } from 'react-native';

import { theme } from '../../theme';
import { formatRelativeDateTime } from '../../lib/format';
import { PR_METRIC_ROW_LABEL, formatPrValue } from '../../features/activity/prDisplay';
import type { LocalPersonalRecord, UnitDistanceSnapshot } from '../../db/types';

type Props = {
  record: LocalPersonalRecord;
  unit: UnitDistanceSnapshot;
  onPress: () => void;
};

/** RecordRow — one cumulative PR on the Records screen (CORE-04), tappable to the activity that holds it. */
export function RecordRow({ record, unit, onPress }: Props) {
  const valueText = formatPrValue(record.metric, record.value, unit);
  const dateText = formatRelativeDateTime(record.achievedAt);

  return (
    <Pressable
      onPress={onPress}
      accessibilityRole="button"
      accessibilityLabel={`${PR_METRIC_ROW_LABEL[record.metric]}: ${valueText}, ${dateText}. View activity.`}
      style={({ pressed }) => [styles.row, pressed && { opacity: theme.opacity.pressed }]}
    >
      <View style={[styles.bar, { backgroundColor: theme.color.accent.primaryTint }]} />
      <View style={styles.content}>
        <Text style={[theme.type.overline, { color: theme.color.text.secondary }]} maxFontSizeMultiplier={1.8}>
          {PR_METRIC_ROW_LABEL[record.metric].toUpperCase()}
        </Text>
        <Text style={[theme.type.metricLg, theme.fontVariation.metric, { color: theme.color.text.primary }]} maxFontSizeMultiplier={1.6}>
          {valueText}
        </Text>
        <Text style={[theme.type.caption, { color: theme.color.text.secondary }]} maxFontSizeMultiplier={2}>
          · {dateText}
        </Text>
      </View>
    </Pressable>
  );
}

const styles = StyleSheet.create({
  row: {
    minHeight: theme.touchTarget.comfortable,
    paddingVertical: theme.space.sm,
    gap: theme.space.xxs,
  },
  bar: {
    height: 4,
    borderRadius: 2,
    marginBottom: theme.space.xxs,
    width: '40%',
  },
  content: {
    gap: 2,
  },
});
