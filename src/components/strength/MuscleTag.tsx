import React from 'react';
import { StyleSheet, Text, View } from 'react-native';

import { theme } from '../../theme';
import type { EquipmentType, MuscleGroup } from '../../db/types';

const MUSCLE_LABEL: Record<MuscleGroup, string> = {
  chest: 'Chest',
  back: 'Back',
  lats: 'Lats',
  traps: 'Traps',
  shoulders: 'Shoulders',
  biceps: 'Biceps',
  triceps: 'Triceps',
  forearms: 'Forearms',
  abs: 'Abs',
  obliques: 'Obliques',
  quadriceps: 'Quads',
  hamstrings: 'Hamstrings',
  glutes: 'Glutes',
  calves: 'Calves',
  adductors: 'Adductors',
  abductors: 'Abductors',
  neck: 'Neck',
  full_body: 'Full body',
  cardio: 'Cardio',
};

const EQUIPMENT_LABEL: Record<EquipmentType, string> = {
  barbell: 'Barbell',
  dumbbell: 'Dumbbell',
  machine: 'Machine',
  cable: 'Cable',
  bodyweight: 'Bodyweight',
  kettlebell: 'Kettlebell',
  band: 'Band',
  other: 'Other',
};

/** MuscleTag — component vocabulary §A: `type.overline` pill (`bg.inset`, `text.secondary`) for `primary_muscle`. Metadata, not status — never brand-colored. */
export function MuscleTag({ muscle }: { muscle: MuscleGroup }) {
  return <Tag label={MUSCLE_LABEL[muscle]} />;
}

/** EquipmentTag — same treatment as MuscleTag, for `equipment`. */
export function EquipmentTag({ equipment }: { equipment: EquipmentType }) {
  return <Tag label={EQUIPMENT_LABEL[equipment]} />;
}

function Tag({ label }: { label: string }) {
  return (
    <View style={[styles.pill, { backgroundColor: theme.color.bg.inset }]}>
      <Text style={[theme.type.overline, { color: theme.color.text.secondary }]} maxFontSizeMultiplier={1.8}>
        {label.toUpperCase()}
      </Text>
    </View>
  );
}

const styles = StyleSheet.create({
  pill: {
    alignSelf: 'flex-start',
    borderRadius: theme.radius.pill,
    paddingHorizontal: theme.space.xs,
    paddingVertical: 2,
  },
});
