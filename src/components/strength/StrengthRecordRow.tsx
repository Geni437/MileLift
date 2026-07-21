import React from 'react';
import { Pressable, StyleSheet, Text, View } from 'react-native';

import { theme } from '../../theme';
import { formatRelativeDateTime, formatVolumeValue, formatWeightValue } from '../../lib/format';
import type { LocalStrengthRecord, UnitWeightSnapshot } from '../../db/types';

const METRIC_LABEL: Record<LocalStrengthRecord['metric'], string> = {
  heaviest_weight: 'Heaviest',
  estimated_1rm: 'Est. 1RM',
  best_set_volume: 'Best set volume',
  max_reps: 'Max reps',
};

type Props = {
  record: LocalStrengthRecord;
  unitWeight: UnitWeightSnapshot;
  onPress: () => void;
};

/** StrengthRecordRow — one cumulative strength PR (CORE-15), the vertical Lift-axis counterpart to activity's RecordRow. */
export function StrengthRecordRow({ record, unitWeight, onPress }: Props) {
  const valueText = record.metric === 'max_reps' ? String(record.value) : formatWeightValue(record.value, unitWeight);
  const unit = record.metric === 'max_reps' ? 'reps' : record.metric === 'best_set_volume' ? `${unitWeight}` : unitWeight;
  const dateText = formatRelativeDateTime(record.achievedAt);

  return (
    <Pressable
      onPress={onPress}
      accessibilityRole="button"
      accessibilityLabel={`${METRIC_LABEL[record.metric]}: ${valueText} ${unit}, ${dateText}. View session.`}
      style={({ pressed }) => [styles.row, pressed && { opacity: theme.opacity.pressed }]}
    >
      <View style={[styles.bar, { backgroundColor: theme.color.accent.dataTint }]} />
      <View style={styles.content}>
        <Text style={[theme.type.overline, { color: theme.color.text.secondary }]} maxFontSizeMultiplier={1.8}>
          {METRIC_LABEL[record.metric].toUpperCase()}
        </Text>
        <Text style={[theme.type.metricLg, theme.fontVariation.metric, { color: theme.color.text.primary }]} maxFontSizeMultiplier={1.6}>
          {record.metric === 'best_set_volume' ? formatVolumeValue(record.value, unitWeight) : valueText}
          {record.metric !== 'max_reps' ? ` ${unit}` : ' reps'}
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
    flexDirection: 'row',
    minHeight: theme.touchTarget.comfortable,
    paddingVertical: theme.space.sm,
    gap: theme.space.sm,
  },
  bar: {
    width: 4,
    borderRadius: 2,
  },
  content: {
    gap: 2,
  },
});
