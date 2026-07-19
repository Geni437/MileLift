import React from 'react';
import { ActivityIndicator, Pressable, StyleSheet, Text, type GestureResponderEvent } from 'react-native';

import { theme } from '../theme';

type Props = {
  label: string;
  onPress: (event: GestureResponderEvent) => void;
  loading?: boolean;
  disabled?: boolean;
  /**
   * `danger` uses `feedback.dangerSolid` (not `feedback.danger`) with
   * `text.onDanger` — the AA-safe destructive fill per screens-phase-0.md §F
   * destructive-action rule ("feedback.danger ... fails contrast under a
   * white label"). Reserved for the single confirming action in a
   * destructive flow (e.g. "Delete my account"), never the entry point.
   */
  tone?: 'primary' | 'danger';
  accessibilityHint?: string;
  testID?: string;
};

/**
 * PrimaryButton — component vocabulary §A. `accent.primary` fill,
 * `text.onAccent` label, `radius.md`, height `touchTarget.comfortable`,
 * full-width. Pressed -> `accent.primaryPressed` + `opacity.pressed`.
 * Disabled -> `opacity.disabled`. Loading -> centered spinner, control
 * disabled, button stays sized (no layout jump).
 */
export function PrimaryButton({ label, onPress, loading, disabled, tone = 'primary', accessibilityHint, testID }: Props) {
  const isInteractive = !loading && !disabled;
  const fill = tone === 'danger' ? theme.color.feedback.dangerSolid : theme.color.accent.primary;
  const textColor = tone === 'danger' ? theme.color.text.onDanger : theme.color.text.onAccent;

  return (
    <Pressable
      onPress={isInteractive ? onPress : undefined}
      disabled={!isInteractive}
      accessibilityRole="button"
      accessibilityLabel={label}
      accessibilityHint={accessibilityHint}
      accessibilityState={{ disabled: !isInteractive, busy: loading }}
      testID={testID}
      style={({ pressed }) => [
        styles.base,
        { backgroundColor: fill },
        pressed && isInteractive && { opacity: theme.opacity.pressed },
        disabled && !loading && { opacity: theme.opacity.disabled },
      ]}
    >
      {loading ? (
        <ActivityIndicator color={textColor} />
      ) : (
        <Text style={[styles.label, { color: textColor }]} maxFontSizeMultiplier={1.6}>
          {label}
        </Text>
      )}
    </Pressable>
  );
}

const styles = StyleSheet.create({
  base: {
    height: theme.touchTarget.comfortable,
    borderRadius: theme.radius.md,
    alignItems: 'center',
    justifyContent: 'center',
    width: '100%',
    paddingHorizontal: theme.space.lg,
  },
  label: {
    ...theme.type.bodyStrong,
  },
});
