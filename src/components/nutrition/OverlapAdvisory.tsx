import React from 'react';
import { StyleSheet, Text, View } from 'react-native';

import { theme } from '../../theme';
import { TextButton } from '../TextButton';
import type { OverlapAdvisoryEvent } from '../../db/types';

type Props = {
  events: OverlapAdvisoryEvent[];
  onKeepBoth: () => void;
  onRemoveBurn: () => void;
};

function eventLabel(e: OverlapAdvisoryEvent): string {
  const kind = e.eventType === 'gps_activity' ? 'run' : e.eventType === 'strength_session' ? 'workout' : 'burn';
  const kcal = e.energyKcal != null ? `, ${Math.round(Math.abs(e.energyKcal))} kcal` : '';
  return `${kind}${kcal}`;
}

/**
 * OverlapAdvisory — the CORE-11 soft, non-blocking overlap note (design doc
 * §A/§CORE-11/§4.3, §12 decision 2). A DISMISSIBLE inline banner shown AFTER
 * a manual burn has already saved — never a modal, never a blocker. Two
 * equal, non-coercive choices: "Keep both" (the honest default — dismiss)
 * and "Remove this burn" (soft-delete the just-saved burn, an undo, not a
 * block). Both entries keep counting until the user acts.
 *
 * Both actions render as EQUAL-weight `TextButton`s — no `danger` styling on
 * "Remove this burn" — a deliberate exception to this app's usual
 * red-for-destructive convention, because the design doc calls for
 * neutrality here specifically (coloring one option red would subtly weight
 * the choice, the opposite of what this banner exists to avoid).
 */
export function OverlapAdvisory({ events, onKeepBoth, onRemoveBurn }: Props) {
  const summary = events.map(eventLabel).join('; ');

  return (
    <View style={[styles.container, { backgroundColor: theme.color.feedback.warningTint }]} accessibilityRole="alert">
      <Text style={[theme.type.bodyStrong, { color: theme.color.text.primary }]} maxFontSizeMultiplier={2}>
        Logged. Heads up — you already have a tracked workout in this window.
      </Text>
      <Text style={[theme.type.caption, { color: theme.color.text.secondary }]} maxFontSizeMultiplier={2}>
        {summary ? `Overlapping: ${summary}. ` : ''}That&apos;s counted in today&apos;s burn. Both are counting now — only you know if this is the same session your watch logged.
      </Text>
      <View style={styles.actions}>
        <TextButton label="Keep both" onPress={onKeepBoth} />
        <TextButton label="Remove this burn" onPress={onRemoveBurn} />
      </View>
    </View>
  );
}

const styles = StyleSheet.create({
  container: {
    borderRadius: theme.radius.md,
    padding: theme.space.sm,
    gap: theme.space.xs,
  },
  actions: {
    flexDirection: 'row',
    justifyContent: 'flex-end',
    gap: theme.space.md,
  },
});
