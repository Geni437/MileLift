import React from 'react';
import { Pressable, StyleSheet, Text, View } from 'react-native';

import { theme } from '../theme';
import type { SyncStatus } from '../db/types';

type Props = {
  status: SyncStatus;
  onRetry?: () => void;
  testID?: string;
};

/**
 * SyncStatusPill — visible (never silent) sync-status signal
 * (mobile-architecture-standards). `synced` / `pending` ("Saved · will
 * sync") / `failed` ("Sync failed · retry", tap to retry). Color is never
 * the only signal — each state has distinct text, not just a color swap.
 */
export function SyncStatusPill({ status, onRetry, testID }: Props) {
  const config = {
    synced: { label: 'Synced', fg: theme.color.feedback.success, bg: theme.color.feedback.successTint },
    pending: { label: 'Saved · will sync', fg: theme.color.text.secondary, bg: theme.color.bg.inset },
    failed: { label: 'Sync failed · retry', fg: theme.color.feedback.danger, bg: theme.color.feedback.dangerTint },
  }[status];

  const content = (
    <View style={[styles.pill, { backgroundColor: config.bg }]} testID={testID}>
      <Text style={[styles.label, { color: config.fg }]} maxFontSizeMultiplier={2}>
        {config.label}
      </Text>
    </View>
  );

  if (status === 'failed' && onRetry) {
    return (
      <Pressable
        onPress={onRetry}
        accessibilityRole="button"
        accessibilityLabel="Sync failed. Tap to retry."
        hitSlop={8}
        style={styles.pressable}
      >
        {content}
      </Pressable>
    );
  }

  return (
    <View accessibilityLabel={`Sync status: ${config.label}`} accessible>
      {content}
    </View>
  );
}

const styles = StyleSheet.create({
  pressable: {
    minHeight: theme.touchTarget.min,
    justifyContent: 'center',
  },
  pill: {
    alignSelf: 'flex-start',
    borderRadius: theme.radius.pill,
    paddingHorizontal: theme.space.sm,
    paddingVertical: theme.space.xxs,
  },
  label: {
    ...theme.type.caption,
  },
});
