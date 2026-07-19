import React from 'react';
import { ActivityIndicator, Pressable, StyleSheet, Text, View, type GestureResponderEvent } from 'react-native';

import { theme } from '../theme';

type Props = {
  label: string;
  onPress: (event: GestureResponderEvent) => void;
  loading?: boolean;
  disabled?: boolean;
  icon?: React.ReactNode;
  accessibilityHint?: string;
  testID?: string;
};

/**
 * SecondaryButton — transparent fill, `border.default` hairline, `text.primary`
 * label. Used for "Not now" / non-destructive alternates. Never styled
 * tinier/lower-contrast than PrimaryButton to nudge a choice — same height,
 * same weight (component vocabulary §A; consent-sheet equal-weight rule §E4).
 */
export function SecondaryButton({ label, onPress, loading, disabled, icon, accessibilityHint, testID }: Props) {
  const isInteractive = !loading && !disabled;

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
        { borderColor: theme.color.border.default },
        pressed && isInteractive && { opacity: theme.opacity.pressed },
        disabled && !loading && { opacity: theme.opacity.disabled },
      ]}
    >
      {loading ? (
        <ActivityIndicator color={theme.color.text.primary} />
      ) : (
        <View style={styles.row}>
          {icon}
          <Text style={[styles.label, { color: theme.color.text.primary }]} maxFontSizeMultiplier={1.6}>
            {label}
          </Text>
        </View>
      )}
    </Pressable>
  );
}

const styles = StyleSheet.create({
  base: {
    height: theme.touchTarget.comfortable,
    borderRadius: theme.radius.md,
    borderWidth: theme.border.hairline,
    alignItems: 'center',
    justifyContent: 'center',
    width: '100%',
    paddingHorizontal: theme.space.lg,
  },
  row: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: theme.space.xs,
  },
  label: {
    ...theme.type.bodyStrong,
  },
});
