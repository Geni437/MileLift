import React from 'react';
import { StyleSheet, Text, View } from 'react-native';

import { theme } from '../../theme';
import { formatPrDelta, formatPrHeadline, formatPrValue } from '../../features/activity/prDisplay';
import type { PrMetric, UnitDistanceSnapshot } from '../../db/types';

export type PrCalloutItem = {
  metric: PrMetric;
  value: number;
  previousValue: number | null;
  isFirstEver: boolean;
};

type Props = {
  activityTypeName: string;
  items: PrCalloutItem[];
  unit: UnitDistanceSnapshot;
};

/**
 * PrCallout — the save-time "New best" flare (CORE-04). No confetti, no
 * medal, no trophy burst — the flare is `feedback.success` + the specific
 * number, per tokens.md §7's anti-generic-ledger rule. Multiple PRs in one
 * activity stack as multiple lines.
 */
export function PrCallout({ activityTypeName, items, unit }: Props) {
  if (items.length === 0) return null;

  return (
    <View style={[styles.container, { backgroundColor: theme.color.feedback.successTint }]}>
      {items.map((item) => {
        const headline = formatPrHeadline(activityTypeName, item.metric, item.isFirstEver);
        const value = formatPrValue(item.metric, item.value, unit);
        const delta = formatPrDelta(item.metric, item.value, item.previousValue, unit);
        return (
          <View key={item.metric} style={styles.row}>
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
  container: {
    borderRadius: theme.radius.lg,
    padding: theme.space.md,
    gap: theme.space.sm,
  },
  row: {
    gap: theme.space.xxs,
  },
  tag: {
    alignSelf: 'flex-start',
    borderRadius: theme.radius.sm,
    paddingHorizontal: theme.space.xs,
    paddingVertical: 2,
  },
});
