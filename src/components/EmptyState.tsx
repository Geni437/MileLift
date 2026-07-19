import React from 'react';
import { StyleSheet, Text, View } from 'react-native';

import { theme } from '../theme';
import { MeridianMark } from './MeridianMark';
import { TextButton } from './TextButton';

type Props = {
  title: string;
  body?: string;
  actionLabel?: string;
  onAction?: () => void;
};

/** Empty state — un-built Meridian (`seed`) + message, never a set of blank required-looking fields. */
export function EmptyState({ title, body, actionLabel, onAction }: Props) {
  return (
    <View style={styles.container}>
      <MeridianMark variant="seed" size={56} />
      <Text style={[styles.title, { color: theme.color.text.primary }]} maxFontSizeMultiplier={2}>
        {title}
      </Text>
      {body && (
        <Text style={[styles.body, { color: theme.color.text.secondary }]} maxFontSizeMultiplier={2}>
          {body}
        </Text>
      )}
      {actionLabel && onAction && <TextButton label={actionLabel} onPress={onAction} />}
    </View>
  );
}

const styles = StyleSheet.create({
  container: {
    alignItems: 'center',
    gap: theme.space.sm,
    paddingVertical: theme.space.xxl,
    paddingHorizontal: theme.space.lg,
  },
  title: {
    ...theme.type.heading,
    textAlign: 'center',
  },
  body: {
    ...theme.type.body,
    textAlign: 'center',
  },
});
