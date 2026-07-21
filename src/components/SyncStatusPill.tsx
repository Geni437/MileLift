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
 * sync") / `failed` ("Sync failed · retry", tap to retry) / `local` ("Saved
 * on device", Phase 2 CORE-17 addition — a record durable in local SQLite
 * but not yet enqueued for a sync push at all, e.g. an in-progress workout
 * before Finish). Color is never the only signal — each state has distinct
 * text, not just a color swap. `local` is deliberately neutral
 * (`text.secondary`), neither growth-green (nothing confirmed server-side
 * yet) nor danger — it reads as reassurance, per the design doc.
 */
export function SyncStatusPill({ status, onRetry, testID }: Props) {
  const config = {
    synced: { label: 'Synced', fg: theme.color.feedback.success, bg: theme.color.feedback.successTint },
    pending: { label: 'Saved · will sync', fg: theme.color.text.secondary, bg: theme.color.bg.inset },
    failed: { label: 'Sync failed · retry', fg: theme.color.feedback.danger, bg: theme.color.feedback.dangerTint },
    local: { label: 'Saved on device', fg: theme.color.text.secondary, bg: theme.color.bg.inset },
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
