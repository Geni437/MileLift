import React, { useState } from 'react';
import { Image, Pressable, StyleSheet, Text, View } from 'react-native';

import { theme } from '../../theme';
import { MeridianMark } from '../MeridianMark';
import { MuscleTag, EquipmentTag } from './MuscleTag';
import type { EquipmentType, MuscleGroup } from '../../db/types';

type Props = {
  name: string;
  primaryMuscle: MuscleGroup | null;
  equipment: EquipmentType | null;
  /** Resolved primary `exercise_media` image URL, if this movement has one (design doc: "the real demo images are the differentiator"). */
  imageUrl?: string | null;
  onPress: () => void;
  selected?: boolean;
};

/**
 * ExerciseRow — one library movement in a list (CORE-13). A scannable list
 * row, never a card grid. The real demo image renders whenever one is
 * available; `MeridianMark:glyph` is reserved for the genuinely
 * missing/offline-uncached case (design doc: "the layout stays quiet,"
 * `MeridianMark:glyph` is the degraded fallback, not the default look).
 */
export function ExerciseRow({ name, primaryMuscle, equipment, imageUrl, onPress, selected }: Props) {
  const [imageFailed, setImageFailed] = useState(false);
  const showImage = !!imageUrl && !imageFailed;

  return (
    <Pressable
      onPress={onPress}
      accessibilityRole="button"
      accessibilityState={{ selected: !!selected }}
      accessibilityLabel={`${name}${primaryMuscle ? `, ${primaryMuscle}` : ''}`}
      style={({ pressed }) => [styles.row, selected && { backgroundColor: theme.color.bg.inset }, pressed && { opacity: theme.opacity.pressed }]}
    >
      {showImage ? (
        <Image source={{ uri: imageUrl! }} style={styles.thumb} onError={() => setImageFailed(true)} accessibilityIgnoresInvertColors />
      ) : (
        <MeridianMark variant="glyph" size={32} />
      )}
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
  thumb: {
    width: 32,
    height: 32,
    borderRadius: theme.radius.sm,
  },
  tagsRow: {
    flexDirection: 'row',
    gap: theme.space.xs,
  },
});
