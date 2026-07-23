import React from 'react';
import { Pressable, StyleSheet, Text, View } from 'react-native';

import { theme } from '../../theme';
import { SyncStatusPill } from '../SyncStatusPill';
import type { SyncStatus } from '../../db/types';

export type ExpenditureEventType = 'gps_activity' | 'strength_session' | 'manual_calorie_burn';

type Props = {
  eventType: ExpenditureEventType;
  /** The manual burn's `label`, or a derived name for a tracked row. */
  name: string;
  /** Positive kcal magnitude — this row renders the `−` sign itself. */
  kcal: number;
  /** Only meaningful for `manual_calorie_burn` rows — a `MANUAL` burn is this device's own unsynced write, so it carries the same sync legibility as any other unsynced log (design doc §CORE-Sync). Tracked rows are a server mirror, not the user's own write here, so they never take this prop. */
  syncStatus?: SyncStatus;
  onPress?: () => void;
};

const PROVENANCE_LABEL: Record<ExpenditureEventType, string> = {
  gps_activity: 'TRACKED · RUN',
  strength_session: 'TRACKED · LIFT',
  manual_calorie_burn: 'MANUAL',
};

/**
 * ExpenditureRow — one line in the CORE-11 calories-out breakdown (design
 * doc §A). A non-color provenance tag (TRACKED·RUN / TRACKED·LIFT / MANUAL)
 * is what makes the reconciliation legible — every contributing event shown
 * once, clearly labeled tracked-vs-manual. Tracked rows tap through to the
 * source activity/workout; manual rows tap to edit.
 */
export function ExpenditureRow({ eventType, name, kcal, syncStatus, onPress }: Props) {
  const content = (
    <View style={styles.row}>
      <View style={styles.left}>
        <Text style={[theme.type.overline, { color: theme.color.text.secondary }]} maxFontSizeMultiplier={1.8}>
          {PROVENANCE_LABEL[eventType]}
        </Text>
        <Text style={[theme.type.bodyStrong, { color: theme.color.text.primary }]} maxFontSizeMultiplier={1.8}>
          {name}
        </Text>
        {eventType === 'manual_calorie_burn' && syncStatus && syncStatus !== 'synced' && <SyncStatusPill status={syncStatus} />}
      </View>
      <Text style={[theme.type.metricSm, theme.fontVariation.metric, { color: theme.color.text.primary }]} maxFontSizeMultiplier={1.6}>
        −{Math.round(Math.abs(kcal))}
      </Text>
    </View>
  );

  if (!onPress) return content;

  return (
    <Pressable onPress={onPress} accessibilityRole="button" accessibilityLabel={`${PROVENANCE_LABEL[eventType]}: ${name}, ${Math.round(Math.abs(kcal))} kilocalories burned`} style={styles.pressable}>
      {content}
    </Pressable>
  );
}

const styles = StyleSheet.create({
  pressable: {
    minHeight: theme.touchTarget.min,
  },
  row: {
    flexDirection: 'row',
    justifyContent: 'space-between',
    alignItems: 'center',
    minHeight: theme.touchTarget.min,
    paddingVertical: theme.space.xxs,
  },
  left: {
    gap: 2,
    flexShrink: 1,
  },
});
