import React from 'react';
import { Pressable, ScrollView, StyleSheet, Text, TextInput, View } from 'react-native';

import { theme } from '../../theme';
import { resolveServingMacros, type PerBasisMacros } from '../../lib/nutritionMath';
import type { FoodServing } from '../../db/types';

type Props = {
  perBasisMacros: PerBasisMacros;
  servings: FoodServing[];
  selectedServingId: string | null;
  onSelectServing: (servingId: string) => void;
  quantity: number;
  onChangeQuantity: (quantity: number) => void;
};

const QUANTITY_STEP = 0.5;

/**
 * ServingControl — the log-ergonomics core (design doc §A/§CORE-06): a
 * serving picker + a quantity stepper, live-recomputing the resolved kcal +
 * P/C/F ON-DEVICE from the snapshot math as the user adjusts. These are the
 * exact numbers that get snapshotted on save (`SAVE §2.3` — client-supplied,
 * never server-recomputed).
 */
export function ServingControl({ perBasisMacros, servings, selectedServingId, onSelectServing, quantity, onChangeQuantity }: Props) {
  const selected = servings.find((s) => s.id === selectedServingId) ?? servings[0] ?? null;
  const resolved = selected ? resolveServingMacros(perBasisMacros, selected.gramOrMlWeight, quantity) : null;

  return (
    <View style={styles.container}>
      {servings.length > 0 && (
        <ScrollView horizontal showsHorizontalScrollIndicator={false} contentContainerStyle={styles.servingRow}>
          {servings.map((serving) => {
            const isSelected = serving.id === selected?.id;
            return (
              <Pressable
                key={serving.id}
                onPress={() => onSelectServing(serving.id)}
                accessibilityRole="radio"
                accessibilityState={{ selected: isSelected }}
                accessibilityLabel={serving.label}
                style={[styles.servingChip, { backgroundColor: isSelected ? theme.color.accent.primary : theme.color.bg.inset }]}
              >
                <Text style={[theme.type.label, { color: isSelected ? theme.color.text.onAccent : theme.color.text.primary }]} maxFontSizeMultiplier={1.8}>
                  {serving.label}
                </Text>
              </Pressable>
            );
          })}
        </ScrollView>
      )}

      <View style={styles.stepperRow}>
        <Pressable
          onPress={() => onChangeQuantity(Math.max(QUANTITY_STEP, Math.round((quantity - QUANTITY_STEP) * 100) / 100))}
          accessibilityRole="button"
          accessibilityLabel="Decrease quantity"
          style={[styles.stepperButton, { backgroundColor: theme.color.bg.inset }]}
        >
          <Text style={[theme.type.title, { color: theme.color.text.primary }]}>−</Text>
        </Pressable>
        <TextInput
          value={String(quantity)}
          onChangeText={(text) => {
            const parsed = Number(text);
            if (Number.isFinite(parsed) && parsed > 0) onChangeQuantity(parsed);
          }}
          keyboardType="decimal-pad"
          accessibilityLabel="Quantity"
          style={[styles.quantityInput, theme.type.metricLg, theme.fontVariation.metric, { color: theme.color.text.primary }]}
        />
        <Pressable
          onPress={() => onChangeQuantity(Math.round((quantity + QUANTITY_STEP) * 100) / 100)}
          accessibilityRole="button"
          accessibilityLabel="Increase quantity"
          style={[styles.stepperButton, { backgroundColor: theme.color.bg.inset }]}
        >
          <Text style={[theme.type.title, { color: theme.color.text.primary }]}>＋</Text>
        </Pressable>
      </View>

      {resolved && (
        <View style={styles.resolvedRow} accessible accessibilityLabel={`Resolved: ${Math.round(resolved.energyKcal)} kilocalories`}>
          <Text style={[theme.type.metricXl, theme.fontVariation.metric, { color: theme.color.text.primary }]} maxFontSizeMultiplier={1.4}>
            {Math.round(resolved.energyKcal)}
          </Text>
          <Text style={[theme.type.label, { color: theme.color.text.secondary }]} maxFontSizeMultiplier={1.8}>
            {' '}
            kcal
          </Text>
        </View>
      )}
      {resolved && (
        <Text style={[theme.type.metricSm, theme.fontVariation.metric, { color: theme.color.text.secondary }]} maxFontSizeMultiplier={1.8}>
          {resolved.proteinG != null ? `P ${Math.round(resolved.proteinG)}g` : ''}
          {resolved.carbG != null ? ` · C ${Math.round(resolved.carbG)}g` : ''}
          {resolved.fatG != null ? ` · F ${Math.round(resolved.fatG)}g` : ''}
        </Text>
      )}
    </View>
  );
}

const styles = StyleSheet.create({
  container: {
    gap: theme.space.sm,
  },
  servingRow: {
    gap: theme.space.xs,
  },
  servingChip: {
    minHeight: theme.touchTarget.min,
    borderRadius: theme.radius.pill,
    paddingHorizontal: theme.space.md,
    justifyContent: 'center',
  },
  stepperRow: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: theme.space.sm,
  },
  stepperButton: {
    width: theme.touchTarget.comfortable,
    height: theme.touchTarget.comfortable,
    borderRadius: theme.radius.md,
    alignItems: 'center',
    justifyContent: 'center',
  },
  quantityInput: {
    flex: 1,
    textAlign: 'center',
    minHeight: theme.touchTarget.comfortable,
  },
  resolvedRow: {
    flexDirection: 'row',
    alignItems: 'baseline',
  },
});
