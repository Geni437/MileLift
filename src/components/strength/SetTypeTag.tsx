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
 * Warmups render de-emphasized (`text.tertiary`) since they're excluded from
 * volume/PR (§4.1).
 */
export function SetTypeTag({ setType, setNumber }: Props) {
  if (setType === 'working') {
    return (
      <Text style={[theme.type.metricSm, theme.fontVariation.metric, { color: theme.color.text.primary }]} maxFontSizeMultiplier={1.6}>
        {setNumber}
      </Text>
    );
  }

  const deemphasized = setType === 'warmup';
  return (
    <View style={styles.container}>
      <Text
        style={[theme.type.overline, { color: deemphasized ? theme.color.text.tertiary : theme.color.text.secondary }]}
        maxFontSizeMultiplier={1.8}
      >
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
