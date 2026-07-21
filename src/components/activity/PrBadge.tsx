import React from 'react';
import { StyleSheet, Text, View } from 'react-native';

import { theme } from '../../theme';

/** PrBadge — the small record indicator on an ActivityRow (CORE-04) / SetRow (CORE-12, "New best" inline copy per design doc). Text-carried, never color-only. */
export function PrBadge({ label = 'PR' }: { label?: string }) {
  return (
    <View style={[styles.badge, { backgroundColor: theme.color.accent.primaryTint }]} accessibilityLabel="Set a personal record">
      <Text style={[theme.type.overline, { color: theme.color.accent.primary }]} maxFontSizeMultiplier={1.6}>
        {label}
      </Text>
    </View>
  );
}

const styles = StyleSheet.create({
  badge: {
    borderRadius: theme.radius.sm,
    paddingHorizontal: theme.space.xs,
    paddingVertical: 2,
    alignSelf: 'flex-start',
  },
});
