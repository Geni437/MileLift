import React from 'react';
import { StyleSheet, Text, View } from 'react-native';

import { theme } from '../../theme';

type Props = {
  proteinG: number | null;
  carbG: number | null;
  fatG: number | null;
};

type MacroRow = { key: 'protein' | 'carb' | 'fat'; label: string; grams: number };

/**
 * MacroBreakdown — CORE-08 macro composition of intake (design doc §A).
 * Three horizontal bars, monochrome in the ember intake family
 * (`energyBalance.intake` on a `bg.inset` track) — the deliberate
 * anti-3-color-macro-donut decision (§0/§Decisions item 3). No target ring,
 * no goal segment. Subordinate in weight to `MeridianBalance` — itemizes the
 * warm side, never a second hero.
 */
export function MacroBreakdown({ proteinG, carbG, fatG }: Props) {
  const rows: MacroRow[] = [
    { key: 'protein', label: 'Protein', grams: proteinG ?? 0 },
    { key: 'carb', label: 'Carb', grams: carbG ?? 0 },
    { key: 'fat', label: 'Fat', grams: fatG ?? 0 },
  ];
  const total = rows.reduce((sum, r) => sum + r.grams, 0);
  const max = Math.max(1, ...rows.map((r) => r.grams));

  return (
    <View style={styles.container}>
      {rows.map((row) => {
        const share = total > 0 ? Math.round((row.grams / total) * 100) : 0;
        return (
          <View key={row.key} style={styles.row} accessible accessibilityLabel={`${row.label}: ${row.grams} grams${total > 0 ? `, ${share}% of intake` : ''}`}>
            <View style={styles.labelCol}>
              <Text style={[theme.type.overline, { color: theme.color.text.secondary }]} maxFontSizeMultiplier={1.8}>
                {row.label.toUpperCase()}
              </Text>
            </View>
            <View style={[styles.track, { backgroundColor: theme.color.bg.inset }]}>
              <View
                style={[
                  styles.fill,
                  { width: `${Math.max(row.grams > 0 ? 4 : 0, (row.grams / max) * 100)}%`, backgroundColor: theme.color.energyBalance.intake },
                ]}
              />
            </View>
            <View style={styles.valueCol}>
              <Text style={[theme.type.metricSm, theme.fontVariation.metric, { color: theme.color.text.primary }]} maxFontSizeMultiplier={1.6}>
                {Math.round(row.grams)}g
              </Text>
              {total > 0 && (
                <Text style={[theme.type.caption, { color: theme.color.text.secondary }]} maxFontSizeMultiplier={1.8}>
                  {share}%
                </Text>
              )}
            </View>
          </View>
        );
      })}
    </View>
  );
}

const styles = StyleSheet.create({
  container: {
    gap: theme.space.xs,
  },
  row: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: theme.space.xs,
  },
  labelCol: {
    width: 56,
  },
  track: {
    flex: 1,
    height: 8,
    borderRadius: theme.radius.sm,
    overflow: 'hidden',
  },
  fill: {
    height: '100%',
    borderRadius: theme.radius.sm,
  },
  valueCol: {
    width: 52,
    alignItems: 'flex-end',
  },
});
