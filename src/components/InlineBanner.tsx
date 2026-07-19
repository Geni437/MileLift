import React from 'react';
import { Pressable, StyleSheet, Text, View } from 'react-native';

import { theme } from '../theme';

type Tone = 'info' | 'warning' | 'danger' | 'success';

type Props = {
  tone: Tone;
  message: string;
  actionLabel?: string;
  onAction?: () => void;
  testID?: string;
};

const TONE_TOKENS: Record<Tone, { bg: string; fg: string }> = {
  info: { bg: theme.color.feedback.infoTint, fg: theme.color.feedback.info },
  warning: { bg: theme.color.feedback.warningTint, fg: theme.color.feedback.warning },
  danger: { bg: theme.color.feedback.dangerTint, fg: theme.color.feedback.danger },
  success: { bg: theme.color.feedback.successTint, fg: theme.color.feedback.success },
};

/**
 * InlineBanner — full-width tinted note for offline/info/error context that
 * isn't a blocking dialog (component vocabulary §A). Never color-only: the
 * tone color is paired with the message text itself carrying the meaning,
 * and an optional explicit action (e.g. "Open Settings", "Resend").
 */
export function InlineBanner({ tone, message, actionLabel, onAction, testID }: Props) {
  const tokens = TONE_TOKENS[tone];
  return (
    <View style={[styles.container, { backgroundColor: tokens.bg }]} accessibilityRole="alert" testID={testID}>
      <Text style={[styles.message, { color: theme.color.text.primary }]} maxFontSizeMultiplier={2}>
        {message}
      </Text>
      {actionLabel && onAction && (
        <Pressable
          onPress={onAction}
          accessibilityRole="button"
          accessibilityLabel={actionLabel}
          hitSlop={8}
          style={styles.action}
        >
          <Text style={[styles.actionLabel, { color: tokens.fg }]} maxFontSizeMultiplier={2}>
            {actionLabel}
          </Text>
        </Pressable>
      )}
    </View>
  );
}

const styles = StyleSheet.create({
  container: {
    borderRadius: theme.radius.md,
    padding: theme.space.sm,
    gap: theme.space.xxs,
  },
  message: {
    ...theme.type.caption,
  },
  action: {
    alignSelf: 'flex-start',
    minHeight: theme.touchTarget.min,
    justifyContent: 'center',
  },
  actionLabel: {
    ...theme.type.label,
  },
});
