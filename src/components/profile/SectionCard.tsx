import React from 'react';
import { StyleSheet, Text, View } from 'react-native';

import { theme } from '../../theme';
import { MeridianMark } from '../MeridianMark';

type Props = {
  title: string;
  children: React.ReactNode;
};

/** Profile section shell — "each anchored by a MeridianMark:glyph header" (screens-phase-0.md §F). */
export function SectionCard({ title, children }: Props) {
  return (
    <View style={[styles.card, { backgroundColor: theme.color.bg.raised }]}>
      <View style={styles.header}>
        <MeridianMark variant="glyph" size={24} />
        <Text style={[theme.type.heading, { color: theme.color.text.primary }]}>{title}</Text>
      </View>
      <View style={styles.body}>{children}</View>
    </View>
  );
}

const styles = StyleSheet.create({
  card: {
    borderRadius: theme.radius.lg,
    padding: theme.space.md,
    gap: theme.space.sm,
  },
  header: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: theme.space.xs,
  },
  body: {
    gap: theme.space.sm,
  },
});
