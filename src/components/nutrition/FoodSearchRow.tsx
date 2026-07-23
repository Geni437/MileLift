import React from 'react';
import { Pressable, StyleSheet, Text, View } from 'react-native';

import { theme } from '../../theme';
import { SourceTag } from './SourceTag';
import { DataQualityTag } from './DataQualityTag';
import { SyncStatusPill } from '../SyncStatusPill';
import type { FoodDataQuality, FoodSource, SyncStatus } from '../../db/types';

type Props = {
  name: string;
  brand: string | null;
  source: FoodSource | 'custom';
  dataQuality: FoodDataQuality | null;
  /** Per-default-serving kcal/P/C/F, already resolved (search/barcode response's `default_serving`). */
  defaultServingLabel: string | null;
  energyKcal: number | null;
  proteinG: number | null;
  carbG: number | null;
  fatG: number | null;
  /** Only set for the user's own `custom_foods` rows (design doc §CORE-Sync: custom-food rows carry sync legibility; catalog search results, a server mirror, never do). */
  syncStatus?: SyncStatus;
  onPress: () => void;
};

/** FoodSearchRow — one `search_foods_v1` result (design doc §A). A scannable list row, not a card grid. */
export function FoodSearchRow({ name, brand, source, dataQuality, defaultServingLabel, energyKcal, proteinG, carbG, fatG, syncStatus, onPress }: Props) {
  const macroLine =
    energyKcal != null
      ? `${Math.round(energyKcal)} kcal${proteinG != null ? ` · P ${Math.round(proteinG)}g` : ''}${carbG != null ? ` · C ${Math.round(carbG)}g` : ''}${fatG != null ? ` · F ${Math.round(fatG)}g` : ''}${defaultServingLabel ? ` (${defaultServingLabel})` : ''}`
      : null;

  return (
    <Pressable
      onPress={onPress}
      accessibilityRole="button"
      accessibilityLabel={`${name}${brand ? `, ${brand}` : ''}${macroLine ? `, ${macroLine}` : ''}`}
      style={({ pressed }) => [styles.row, pressed && { opacity: theme.opacity.pressed }]}
    >
      <View style={styles.textCol}>
        <Text style={[theme.type.bodyStrong, { color: theme.color.text.primary }]} maxFontSizeMultiplier={1.8} numberOfLines={1}>
          {name}
        </Text>
        {brand && (
          <Text style={[theme.type.caption, { color: theme.color.text.secondary }]} maxFontSizeMultiplier={1.8} numberOfLines={1}>
            {brand}
          </Text>
        )}
        {macroLine && (
          <Text style={[theme.type.metricSm, theme.fontVariation.metric, { color: theme.color.text.secondary }]} maxFontSizeMultiplier={1.6} numberOfLines={1}>
            {macroLine}
          </Text>
        )}
        <View style={styles.tagRow}>
          <SourceTag source={source} linkToCredits />
          <DataQualityTag dataQuality={dataQuality} />
          {syncStatus && syncStatus !== 'synced' && <SyncStatusPill status={syncStatus} />}
        </View>
      </View>
    </Pressable>
  );
}

const styles = StyleSheet.create({
  row: {
    minHeight: theme.touchTarget.comfortable,
    paddingVertical: theme.space.xs,
    borderBottomWidth: theme.border.hairline,
    borderBottomColor: theme.color.border.subtle,
    gap: 2,
  },
  textCol: {
    gap: 2,
  },
  tagRow: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: theme.space.xs,
    marginTop: 2,
  },
});
