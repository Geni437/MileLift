import React from 'react';
import { StyleSheet, Text, View } from 'react-native';

import { theme } from '../../theme';
import { TextButton } from '../TextButton';
import { SyncStatusPill } from '../SyncStatusPill';
import { FoodLogItemRow } from './FoodLogItemRow';
import type { LocalFoodLogEntry, LocalFoodLogItem, MealType } from '../../db/types';

type Props = {
  entry: LocalFoodLogEntry;
  items: LocalFoodLogItem[];
  onAddFood: () => void;
  onPress?: () => void;
  onRetrySync?: () => void;
};

const MEAL_TYPE_LABEL: Record<MealType, string> = {
  breakfast: 'Breakfast',
  lunch: 'Lunch',
  dinner: 'Dinner',
  snack: 'Snack',
  other: 'Other',
};

/** MealCard — one eating occasion grouped by `meal_type` (design doc §A). */
export function MealCard({ entry, items, onAddFood, onPress, onRetrySync }: Props) {
  const time = new Date(entry.occurredAt).toLocaleTimeString(undefined, { hour: 'numeric', minute: '2-digit' });

  return (
    <View style={[styles.card, { backgroundColor: theme.color.bg.raised }]}>
      <View style={styles.header}>
        <View>
          <Text style={[theme.type.heading, { color: theme.color.text.primary }]} maxFontSizeMultiplier={1.8}>
            {entry.title || MEAL_TYPE_LABEL[entry.mealType]}
          </Text>
          <Text style={[theme.type.caption, { color: theme.color.text.secondary }]} maxFontSizeMultiplier={1.8}>
            {entry.title ? `${MEAL_TYPE_LABEL[entry.mealType]} · ` : ''}
            {time}
          </Text>
        </View>
        {entry.syncStatus !== 'synced' && <SyncStatusPill status={entry.syncStatus} onRetry={onRetrySync} />}
      </View>

      {items.map((item) => (
        <FoodLogItemRow key={item.id} item={item} />
      ))}

      <View style={styles.totalsRow}>
        <Text style={[theme.type.metricMd, theme.fontVariation.metric, { color: theme.color.text.primary }]} maxFontSizeMultiplier={1.6}>
          {Math.round(entry.totalEnergyKcal)} kcal
        </Text>
        <Text style={[theme.type.caption, { color: theme.color.text.secondary }]} maxFontSizeMultiplier={1.8}>
          {entry.totalProteinG != null ? `P ${Math.round(entry.totalProteinG)}g` : ''}
          {entry.totalCarbG != null ? ` · C ${Math.round(entry.totalCarbG)}g` : ''}
          {entry.totalFatG != null ? ` · F ${Math.round(entry.totalFatG)}g` : ''}
        </Text>
      </View>

      <View style={styles.actionsRow}>
        <TextButton label="＋ Add food" onPress={onAddFood} />
        {onPress && <TextButton label="Open" onPress={onPress} />}
      </View>
    </View>
  );
}

const styles = StyleSheet.create({
  card: {
    borderRadius: theme.radius.lg,
    padding: theme.space.md,
    gap: theme.space.xs,
  },
  header: {
    flexDirection: 'row',
    justifyContent: 'space-between',
    alignItems: 'flex-start',
  },
  totalsRow: {
    flexDirection: 'row',
    justifyContent: 'space-between',
    alignItems: 'baseline',
    borderTopWidth: theme.border.hairline,
    borderTopColor: theme.color.border.subtle,
    paddingTop: theme.space.xs,
    marginTop: theme.space.xxs,
  },
  actionsRow: {
    flexDirection: 'row',
    justifyContent: 'space-between',
  },
});
