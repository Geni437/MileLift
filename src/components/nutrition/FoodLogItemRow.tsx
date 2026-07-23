import React from 'react';
import { Pressable, StyleSheet, Text, View } from 'react-native';

import { theme } from '../../theme';
import { TextButton } from '../TextButton';
import type { LocalFoodLogItem } from '../../db/types';

type Props = {
  item: LocalFoodLogItem;
  editable?: boolean;
  onRemove?: () => void;
};

/** FoodLogItemRow — one logged food inside a meal (design doc §A). Reads its OWN snapshot, never a live food lookup (§3) — the CORE-06 gate rule. */
export function FoodLogItemRow({ item, editable, onRemove }: Props) {
  const macroLine = `${item.servingLabelSnapshot} × ${item.quantity}`;

  return (
    <View style={styles.row}>
      <View style={styles.textCol}>
        <Text style={[theme.type.body, { color: theme.color.text.primary }]} maxFontSizeMultiplier={1.8} numberOfLines={1}>
          {item.foodNameSnapshot}
        </Text>
        <Text style={[theme.type.caption, { color: theme.color.text.secondary }]} maxFontSizeMultiplier={1.8}>
          {macroLine}
        </Text>
      </View>
      <View style={styles.rightCol}>
        <Text style={[theme.type.metricSm, theme.fontVariation.metric, { color: theme.color.text.primary }]} maxFontSizeMultiplier={1.6}>
          {Math.round(item.energyKcal)} kcal
        </Text>
        {editable && onRemove && (
          <Pressable onPress={onRemove} accessibilityRole="button" accessibilityLabel={`Remove ${item.foodNameSnapshot}`} hitSlop={8} style={styles.removeButton}>
            <TextButton label="Remove" onPress={onRemove} danger />
          </Pressable>
        )}
      </View>
    </View>
  );
}

const styles = StyleSheet.create({
  row: {
    flexDirection: 'row',
    justifyContent: 'space-between',
    alignItems: 'flex-start',
    minHeight: theme.touchTarget.min,
    paddingVertical: theme.space.xxs,
  },
  textCol: {
    flexShrink: 1,
    gap: 2,
  },
  rightCol: {
    alignItems: 'flex-end',
    gap: 2,
  },
  removeButton: {
    minHeight: theme.touchTarget.min,
    justifyContent: 'center',
  },
});
