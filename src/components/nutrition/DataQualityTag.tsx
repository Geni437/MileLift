import React from 'react';
import { StyleSheet, Text, View } from 'react-native';

import { theme } from '../../theme';
import type { FoodDataQuality } from '../../db/types';

type Props = {
  dataQuality: FoodDataQuality | null;
};

/**
 * DataQualityTag — the `nutrition-data-standards` confidence signal (design
 * doc §A). Renders ONLY for `medium`/`low` — a `high` food (or a user's own
 * custom food, which carries no `data_quality` at all) shows nothing, no
 * clutter. `low` carries a non-color caution glyph + `text.secondary` label
 * (never color-only) and drives the CORE-06 confirm affordance (§6/§CORE-06
 * "Decisions D4" — a soft caution, never a blocking step).
 */
export function DataQualityTag({ dataQuality }: Props) {
  if (dataQuality == null || dataQuality === 'high') return null;

  const label = dataQuality === 'low' ? 'Community data — check it' : 'Community data';

  return (
    <View style={styles.row} accessibilityLabel={label}>
      {dataQuality === 'low' && (
        <Text style={[theme.type.overline, { color: theme.color.feedback.warning }]} maxFontSizeMultiplier={1.6} accessibilityElementsHidden>
          !
        </Text>
      )}
      <Text style={[theme.type.overline, { color: theme.color.text.secondary }]} maxFontSizeMultiplier={1.8}>
        {label.toUpperCase()}
      </Text>
    </View>
  );
}

const styles = StyleSheet.create({
  row: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 4,
  },
});
