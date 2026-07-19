import React, { useState } from 'react';
import { Pressable, StyleSheet, Text, TextInput, View, type TextInputProps } from 'react-native';

import { theme } from '../theme';

type Props = Omit<TextInputProps, 'style'> & {
  label: string;
  helperText?: string;
  errorText?: string | null;
  successText?: string | null;
  isPassword?: boolean;
  testID?: string;
};

/**
 * Field — component vocabulary §A. Label above input; `bg.inset` input,
 * `border.default` hairline, `radius.sm`, min height 48. Focus ->
 * `focusRing` border at `border.thick`. Error -> danger border + danger
 * caption helper. Otherwise helper is `text.tertiary`.
 */
export function Field({ label, helperText, errorText, successText, isPassword, testID, ...inputProps }: Props) {
  const [focused, setFocused] = useState(false);
  const [secure, setSecure] = useState(!!isPassword);
  const hasError = !!errorText;

  const borderColor = hasError
    ? theme.color.feedback.danger
    : focused
      ? theme.color.focusRing
      : theme.color.border.default;

  return (
    <View style={styles.container}>
      <Text style={[styles.label, { color: theme.color.text.secondary }]} maxFontSizeMultiplier={1.8}>
        {label}
      </Text>
      <View
        style={[
          styles.inputRow,
          {
            backgroundColor: theme.color.bg.inset,
            borderColor,
            borderWidth: focused || hasError ? theme.border.thick : theme.border.hairline,
          },
        ]}
      >
        <TextInput
          {...inputProps}
          testID={testID}
          accessibilityLabel={label}
          secureTextEntry={secure}
          placeholderTextColor={theme.color.text.tertiary}
          onFocus={(e) => {
            setFocused(true);
            inputProps.onFocus?.(e);
          }}
          onBlur={(e) => {
            setFocused(false);
            inputProps.onBlur?.(e);
          }}
          style={[styles.input, { color: theme.color.text.primary }]}
          maxFontSizeMultiplier={1.8}
        />
        {isPassword && (
          <Pressable
            onPress={() => setSecure((s) => !s)}
            hitSlop={8}
            accessibilityRole="button"
            accessibilityLabel={secure ? 'Show password' : 'Hide password'}
            style={styles.toggle}
          >
            <Text style={{ color: theme.color.text.secondary, ...theme.type.label }}>{secure ? 'Show' : 'Hide'}</Text>
          </Pressable>
        )}
      </View>
      {hasError ? (
        <Text style={[styles.helper, { color: theme.color.feedback.danger }]} maxFontSizeMultiplier={2}>
          {errorText}
        </Text>
      ) : successText ? (
        <Text style={[styles.helper, { color: theme.color.feedback.success }]} maxFontSizeMultiplier={2}>
          {successText}
        </Text>
      ) : helperText ? (
        <Text style={[styles.helper, { color: theme.color.text.secondary }]} maxFontSizeMultiplier={2}>
          {helperText}
        </Text>
      ) : null}
    </View>
  );
}

const styles = StyleSheet.create({
  container: {
    gap: theme.space.xxs,
  },
  label: {
    ...theme.type.label,
  },
  inputRow: {
    flexDirection: 'row',
    alignItems: 'center',
    minHeight: 48,
    borderRadius: theme.radius.sm,
    paddingHorizontal: theme.space.sm,
  },
  input: {
    flex: 1,
    ...theme.type.body,
    paddingVertical: theme.space.xs,
  },
  toggle: {
    minWidth: theme.touchTarget.min,
    minHeight: theme.touchTarget.min,
    alignItems: 'center',
    justifyContent: 'center',
  },
  helper: {
    ...theme.type.caption,
  },
});
