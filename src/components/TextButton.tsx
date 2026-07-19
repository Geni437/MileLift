import React from 'react';
import { Pressable, StyleSheet, Text, type GestureResponderEvent } from 'react-native';

import { theme } from '../theme';

type Props = {
  label: string;
  onPress: (event: GestureResponderEvent) => void;
  disabled?: boolean;
  danger?: boolean;
  accessibilityHint?: string;
  testID?: string;
};

/** TextButton — no fill/border, `text.secondary` label. Tertiary actions ("Skip", "Need help?"). */
export function TextButton({ label, onPress, disabled, danger, accessibilityHint, testID }: Props) {
  return (
    <Pressable
      onPress={disabled ? undefined : onPress}
      disabled={disabled}
      accessibilityRole="button"
      accessibilityLabel={label}
      accessibilityHint={accessibilityHint}
      accessibilityState={{ disabled }}
      testID={testID}
      style={({ pressed }) => [styles.base, pressed && !disabled && { opacity: theme.opacity.pressed }]}
    >
      <Text
        style={[
          styles.label,
          { color: danger ? theme.color.feedback.danger : theme.color.text.secondary },
          disabled && { opacity: theme.opacity.disabled },
        ]}
        maxFontSizeMultiplier={1.6}
      >
        {label}
      </Text>
    </Pressable>
  );
}

const styles = StyleSheet.create({
  base: {
    minHeight: theme.touchTarget.min,
    alignItems: 'center',
    justifyContent: 'center',
    paddingHorizontal: theme.space.sm,
    paddingVertical: theme.space.xs,
  },
  label: {
    ...theme.type.bodyStrong,
  },
});
