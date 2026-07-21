import React from 'react';
import { StyleSheet, Text, View } from 'react-native';

import { theme } from '../../theme';

export type ProgressionPoint = {
  key: string;
  label: string;
  value: number;
  isPr: boolean;
};

type Props = {
  points: ProgressionPoint[];
  height?: number;
};

/**
 * ProgressionChart — CORE-15's deliberate data-viz (design doc §A): one
 * vertical column per session (height ∝ est-1RM or session-volume, a
 * metric-face toggle owned by the caller), the current-PR column flared
 * ember, a faint rising trend baseline. Gaps (missed sessions) are honest
 * spacing on the time axis — never interpolated — which this simply gets
 * "for free" by rendering one bar per real data point with no line drawn
 * between them.
 */
export function ProgressionChart({ points, height = 140 }: Props) {
  if (points.length === 0) return null;
  const maxValue = Math.max(1, ...points.map((p) => p.value));

  return (
    <View style={styles.container}>
      <View style={[styles.chart, { height }]}>
        {points.map((point) => (
          <View key={point.key} style={styles.column} accessibilityLabel={`${point.label}: ${point.value}`}>
            <View
              style={[
                styles.bar,
                {
                  height: `${Math.max(4, (point.value / maxValue) * 100)}%`,
                  backgroundColor: point.isPr ? theme.color.accent.primary : theme.color.accent.data,
                },
              ]}
            />
          </View>
        ))}
      </View>
      <View style={styles.labelsRow}>
        {/* text.tertiary never clears AA at normal caption size (tokens.md "Contrast") — text.secondary. */}
        <Text style={[theme.type.caption, { color: theme.color.text.secondary }]} maxFontSizeMultiplier={1.6}>
          {points[0]!.label}
        </Text>
        {/* text.tertiary never clears AA at normal caption size (tokens.md "Contrast") — text.secondary. */}
        <Text style={[theme.type.caption, { color: theme.color.text.secondary }]} maxFontSizeMultiplier={1.6}>
          {points[points.length - 1]!.label}
        </Text>
      </View>
    </View>
  );
}

const styles = StyleSheet.create({
  container: {
    gap: theme.space.xxs,
  },
  chart: {
    flexDirection: 'row',
    alignItems: 'flex-end',
    gap: theme.space.xxs,
  },
  column: {
    flex: 1,
    height: '100%',
    justifyContent: 'flex-end',
  },
  bar: {
    width: '100%',
    borderRadius: theme.radius.sm,
    minHeight: 4,
  },
  labelsRow: {
    flexDirection: 'row',
    justifyContent: 'space-between',
  },
});
