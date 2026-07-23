import React, { useState } from 'react';
import { Pressable, StyleSheet, Text, TextInput, View } from 'react-native';

import { theme } from '../../theme';
import { TextButton } from '../TextButton';
import type { UnitVolumeSnapshot } from '../../db/types';

type Props = {
  totalMl: number;
  unit: UnitVolumeSnapshot;
  onLogMl: (volumeMl: number) => void;
  canUndo: boolean;
  onUndo: () => void;
};

const ML_PER_FL_OZ = 29.5735;
/** D2 (design doc §Decisions): 250/500/750 ml presets, fl-oz equivalents on imperial. */
const PRESETS_ML = [250, 500, 750];

function toDisplay(ml: number, unit: UnitVolumeSnapshot): number {
  return unit === 'fl_oz' ? Math.round(ml / ML_PER_FL_OZ) : ml;
}

function displayToMl(value: number, unit: UnitVolumeSnapshot): number {
  return unit === 'fl_oz' ? value * ML_PER_FL_OZ : value;
}

/**
 * WaterQuickAdd — CORE-09, the fastest, lowest-friction surface (design doc
 * §A/§CORE-09). One-tap preset chips log IMMEDIATELY (no confirm sheet); a
 * custom chip opens a tiny inline numeric entry. The running total renders
 * as a slim cyan accretion, deliberately off the energy beam (water is not
 * `energy_kcal`) and with no goal target (§12 decision 5).
 */
export function WaterQuickAdd({ totalMl, unit, onLogMl, canUndo, onUndo }: Props) {
  const [customOpen, setCustomOpen] = useState(false);
  const [customValue, setCustomValue] = useState('');
  const unitLabel = unit === 'fl_oz' ? 'fl oz' : 'ml';
  // A day rarely exceeds a few liters — this is a self-normalizing display
  // scale (the same documented-simplification class as LiftStack/MeridianBalance),
  // not a goal target: the accretion has no fill-to-100% ceiling meaning.
  const scaleMl = Math.max(totalMl, 2000);
  const fillRatio = Math.min(1, totalMl / scaleMl);

  const handleCustomSubmit = () => {
    const parsed = Number(customValue);
    if (Number.isFinite(parsed) && parsed > 0) {
      onLogMl(Math.round(displayToMl(parsed, unit)));
    }
    setCustomValue('');
    setCustomOpen(false);
  };

  return (
    <View style={styles.container}>
      <View style={styles.chipRow}>
        {PRESETS_ML.map((ml) => {
          const displayValue = toDisplay(ml, unit);
          return (
            <Pressable
              key={ml}
              onPress={() => onLogMl(ml)}
              accessibilityRole="button"
              accessibilityLabel={`Log ${displayValue} ${unitLabel} of water`}
              style={[styles.chip, { backgroundColor: theme.color.bg.inset }]}
            >
              <Text style={[theme.type.metricSm, theme.fontVariation.metric, { color: theme.color.text.primary }]} maxFontSizeMultiplier={1.6}>
                {displayValue}
              </Text>
              <Text style={[theme.type.caption, { color: theme.color.text.secondary }]} maxFontSizeMultiplier={1.8}>
                {' '}
                {unitLabel}
              </Text>
            </Pressable>
          );
        })}
        <Pressable
          onPress={() => setCustomOpen((v) => !v)}
          accessibilityRole="button"
          accessibilityLabel="Log a custom water amount"
          style={[styles.chip, { backgroundColor: theme.color.bg.inset }]}
        >
          <Text style={[theme.type.label, { color: theme.color.text.primary }]} maxFontSizeMultiplier={1.6}>
            Custom
          </Text>
        </Pressable>
      </View>

      {customOpen && (
        <View style={styles.customRow}>
          <TextInput
            value={customValue}
            onChangeText={setCustomValue}
            keyboardType="decimal-pad"
            placeholder={`Amount (${unitLabel})`}
            placeholderTextColor={theme.color.text.tertiary}
            accessibilityLabel={`Custom water amount in ${unitLabel}`}
            style={[styles.customInput, theme.type.metricMd, theme.fontVariation.metric, { color: theme.color.text.primary, backgroundColor: theme.color.bg.inset }]}
            onSubmitEditing={handleCustomSubmit}
            autoFocus
          />
          <TextButton label="Log" onPress={handleCustomSubmit} />
        </View>
      )}

      <View style={styles.totalRow}>
        <View style={[styles.accretionTrack, { backgroundColor: theme.color.bg.inset }]}>
          <View style={[styles.accretionFill, { width: `${fillRatio * 100}%`, backgroundColor: theme.color.energyBalance.water }]} />
        </View>
        <Text style={[theme.type.metricSm, theme.fontVariation.metric, { color: theme.color.text.primary }]} maxFontSizeMultiplier={1.6}>
          {toDisplay(totalMl, unit)} {unitLabel}
        </Text>
      </View>

      {canUndo && <TextButton label="Undo last glass" onPress={onUndo} />}
    </View>
  );
}

const styles = StyleSheet.create({
  container: {
    gap: theme.space.sm,
  },
  chipRow: {
    flexDirection: 'row',
    flexWrap: 'wrap',
    gap: theme.space.xs,
  },
  chip: {
    flexDirection: 'row',
    alignItems: 'center',
    minHeight: theme.touchTarget.min,
    borderRadius: theme.radius.pill,
    paddingHorizontal: theme.space.md,
    justifyContent: 'center',
  },
  customRow: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: theme.space.sm,
  },
  customInput: {
    flex: 1,
    minHeight: theme.touchTarget.min,
    borderRadius: theme.radius.sm,
    paddingHorizontal: theme.space.sm,
  },
  totalRow: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: theme.space.sm,
  },
  accretionTrack: {
    flex: 1,
    height: 8,
    borderRadius: theme.radius.sm,
    overflow: 'hidden',
  },
  accretionFill: {
    height: '100%',
    borderRadius: theme.radius.sm,
  },
});
