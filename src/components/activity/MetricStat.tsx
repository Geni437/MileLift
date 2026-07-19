import React from 'react';
import { StyleSheet, Text, View } from 'react-native';

import { theme } from '../../theme';

type Size = 'hero' | 'primary' | 'inline';

type Props = {
  value: string;
  unit?: string;
  label: string;
  size?: Size;
  accessibilityLabel?: string;
};

const SIZE_STYLE = {
  hero: theme.type.metricXl,
  primary: theme.type.metricLg,
  inline: theme.type.metricMd,
} as const;

/**
 * MetricStat — component vocabulary §A. One metric rendered in the metric
 * face (tabular figures): a value, a small unit, a label. Never boxed on
 * its own — always composed inside a MetricBar or a screen layout.
 */
export function MetricStat({ value, unit, label, size = 'primary', accessibilityLabel }: Props) {
  return (
    <View
      style={styles.container}
      accessible
      accessibilityRole="text"
      accessibilityLabel={accessibilityLabel ?? `${label}: ${value}${unit ? ` ${unit}` : ''}`}
    >
      <View style={styles.valueRow}>
        <Text
          style={[SIZE_STYLE[size], theme.fontVariation.metric, { color: theme.color.text.primary }]}
          maxFontSizeMultiplier={1.6}
        >
          {value}
        </Text>
        {unit ? (
          <Text style={[theme.type.label, { color: theme.color.text.tertiary }]} maxFontSizeMultiplier={1.6}>
            {' '}
            {unit}
          </Text>
        ) : null}
      </View>
      <Text style={[theme.type.overline, styles.label, { color: theme.color.text.tertiary }]} maxFontSizeMultiplier={1.8}>
        {label.toUpperCase()}
      </Text>
    </View>
  );
}

const styles = StyleSheet.create({
  container: {
    alignItems: 'flex-start',
  },
  valueRow: {
    flexDirection: 'row',
    alignItems: 'baseline',
  },
  label: {
    marginTop: theme.space.xxs,
  },
});
