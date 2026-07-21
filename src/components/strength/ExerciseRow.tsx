import React from 'react';
import { Pressable, StyleSheet, Text, View } from 'react-native';

import { theme } from '../../theme';
import { MeridianMark } from '../MeridianMark';
import { MuscleTag, EquipmentTag } from './MuscleTag';
import type { EquipmentType, MuscleGroup } from '../../db/types';

type Props = {
  name: string;
  primaryMuscle: MuscleGroup | null;
  equipment: EquipmentType | null;
  onPress: () => void;
  selected?: boolean;
};

/** ExerciseRow — one library movement in a list (CORE-13). A scannable list row, never a card grid. Offline: name + a MeridianMark:glyph placeholder if no image is loadable (§10). */
export function ExerciseRow({ name, primaryMuscle, equipment, onPress, selected }: Props) {
  return (
    <Pressable
      onPress={onPress}
      accessibilityRole="button"
      accessibilityState={{ selected: !!selected }}
      accessibilityLabel={`${name}${primaryMuscle ? `, ${primaryMuscle}` : ''}`}
      style={({ pressed }) => [styles.row, selected && { backgroundColor: theme.color.bg.inset }, pressed && { opacity: theme.opacity.pressed }]}
    >
      <MeridianMark variant="glyph" size={32} />
      <View style={styles.content}>
        <Text style={[theme.type.bodyStrong, { color: theme.color.text.primary }]} numberOfLines={1} maxFontSizeMultiplier={1.8}>
          {name}
        </Text>
        <View style={styles.tagsRow}>
          {primaryMuscle && <MuscleTag muscle={primaryMuscle} />}
          {equipment && <EquipmentTag equipment={equipment} />}
        </View>
      </View>
    </Pressable>
  );
}

const styles = StyleSheet.create({
  row: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: theme.space.sm,
    minHeight: theme.touchTarget.comfortable,
    paddingVertical: theme.space.xs,
    paddingHorizontal: theme.space.xs,
    borderRadius: theme.radius.md,
  },
  content: {
    flex: 1,
    gap: theme.space.xxs,
  },
  tagsRow: {
    flexDirection: 'row',
    gap: theme.space.xs,
  },
});
