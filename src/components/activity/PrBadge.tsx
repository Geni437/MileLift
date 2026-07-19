import React from 'react';
import { StyleSheet, Text, View } from 'react-native';

import { theme } from '../../theme';

/** PrBadge — the small record indicator on an ActivityRow (CORE-04). Text-carried, never color-only. */
export function PrBadge() {
  return (
    <View style={[styles.badge, { backgroundColor: theme.color.accent.primaryTint }]} accessibilityLabel="Set a personal record">
      <Text style={[theme.type.overline, { color: theme.color.accent.primary }]} maxFontSizeMultiplier={1.6}>
        PR
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
