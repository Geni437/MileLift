import React from 'react';
import { StyleSheet, Text, View } from 'react-native';

import { theme } from '../../theme';
import { formatStrengthPrDelta, formatStrengthPrHeadline, formatStrengthPrValue } from '../../features/strength/strengthPrDisplay';
import type { StrengthPrEvaluation } from '../../features/strength/strengthPrEngine';
import type { UnitWeightSnapshot } from '../../db/types';

type Props = {
  items: StrengthPrEvaluation[];
  exerciseNamesByRef: Map<string, string>;
  unit: UnitWeightSnapshot;
};

/** StrengthPrCallout — the CORE-12 Save-sheet "New best" flare, strength variant. No confetti/medal/trophy (tokens.md §7) — the LiftStack flare + the specific number is the reward. */
export function StrengthPrCallout({ items, exerciseNamesByRef, unit }: Props) {
  if (items.length === 0) return null;

  return (
    <View style={[styles.container, { backgroundColor: theme.color.feedback.successTint }]}>
      {items.map((item) => {
        const ref = item.exerciseId ?? `custom:${item.customExerciseId}`;
        const exerciseName = exerciseNamesByRef.get(ref) ?? 'Exercise';
        const headline = formatStrengthPrHeadline(exerciseName, item.metric, item.isFirstEver);
        const value = formatStrengthPrValue(item.metric, item.value, unit);
        const delta = formatStrengthPrDelta(item.metric, item.value, item.previousValue, unit);
        return (
          <View key={`${ref}-${item.metric}`} style={styles.row}>
            <View style={[styles.tag, { backgroundColor: theme.color.feedback.success }]}>
              <Text style={[theme.type.overline, { color: theme.color.text.onAccent }]} maxFontSizeMultiplier={1.6}>
                NEW BEST
              </Text>
            </View>
            <Text style={[theme.type.bodyStrong, { color: theme.color.text.primary }]} maxFontSizeMultiplier={2}>
              {headline} — {value}
              {delta ? `, ${delta}` : ''}
            </Text>
          </View>
        );
      })}
    </View>
  );
}

const styles = StyleSheet.create({
  container: { borderRadius: theme.radius.lg, padding: theme.space.md, gap: theme.space.sm },
  row: { gap: theme.space.xxs },
  tag: { alignSelf: 'flex-start', borderRadius: theme.radius.sm, paddingHorizontal: theme.space.xs, paddingVertical: 2 },
});
