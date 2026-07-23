import React from 'react';
import { Pressable, StyleSheet, Text, View } from 'react-native';
import { router } from 'expo-router';

import { theme } from '../../theme';
import type { FoodSource } from '../../db/types';

type Props = {
  /** `null` for a user-owned custom food (no `FoodSource` enum value covers it). */
  source: FoodSource | 'custom';
  /** When true, tapping the tag routes to the nutrition-sources credits screen (design doc §A: "Doubles as the entry point to the Nutrition sources credits"). */
  linkToCredits?: boolean;
};

const LABELS: Record<Props['source'], string> = {
  usda_fdc: 'USDA',
  open_food_facts: 'Open Food Facts',
  milelift_authored: 'MileLift',
  custom: 'Custom',
};

/** SourceTag — per-food provenance pill (design doc §A). Metadata, not status — `text.secondary` always (never brand-colored, never `tertiary` at this size per the §Contrast rule). */
export function SourceTag({ source, linkToCredits }: Props) {
  const label = LABELS[source];
  const content = (
    <View style={styles.pill} accessibilityLabel={`Source: ${label}`}>
      <Text style={[theme.type.overline, { color: theme.color.text.secondary }]} maxFontSizeMultiplier={1.8}>
        {label.toUpperCase()}
      </Text>
    </View>
  );

  if (!linkToCredits) return content;

  return (
    <Pressable
      onPress={() => router.push('/nutrition-credits')}
      accessibilityRole="link"
      accessibilityLabel={`Source: ${label}. View nutrition data credits.`}
      hitSlop={6}
      style={styles.pressable}
    >
      {content}
    </Pressable>
  );
}

const styles = StyleSheet.create({
  pressable: {
    minHeight: theme.touchTarget.min,
    justifyContent: 'center',
  },
  pill: {
    alignSelf: 'flex-start',
    borderRadius: theme.radius.sm,
    backgroundColor: theme.color.bg.inset,
    paddingHorizontal: theme.space.xs,
    paddingVertical: 3,
  },
});
