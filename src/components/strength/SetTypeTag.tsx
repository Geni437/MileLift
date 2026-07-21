import React from 'react';
import { StyleSheet, Text, View } from 'react-native';

import { theme } from '../../theme';
import type { WorkoutSetType } from '../../db/types';

const LABEL: Record<WorkoutSetType, string> = {
  working: '',
  warmup: 'W-up',
  dropset: 'Drop',
  failure: 'F',
  amrap: 'AMRAP',
};

type Props = {
  setType: WorkoutSetType;
  setNumber: number;
};

/**
 * SetTypeTag — component vocabulary §A: a compact non-color glyph+label for
 * `set_type`. Working sets are just the plain set index number (no tag);
 * everything else carries a short glyph/label so type is never color-only.
 * Warmups render de-emphasized — `text.secondary`, not `text.tertiary`: this
 * label renders at `type.overline` (11px), well under the "≥18.66px bold or
 * ≥24px" floor `text.tertiary` needs to clear AA (tokens.md "Contrast").
 */
export function SetTypeTag({ setType, setNumber }: Props) {
  if (setType === 'working') {
    return (
      <Text style={[theme.type.metricSm, theme.fontVariation.metric, { color: theme.color.text.primary }]} maxFontSizeMultiplier={1.6}>
        {setNumber}
      </Text>
    );
  }

  return (
    <View style={styles.container}>
      <Text style={[theme.type.overline, { color: theme.color.text.secondary }]} maxFontSizeMultiplier={1.8}>
        {LABEL[setType]}
      </Text>
    </View>
  );
}

const styles = StyleSheet.create({
  container: {
    minWidth: 32,
  },
});
