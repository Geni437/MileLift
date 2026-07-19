import React from 'react';
import { StyleSheet, View } from 'react-native';
import { router } from 'expo-router';

import { theme } from '../theme';
import { MeridianMark, type MeridianVariant } from './MeridianMark';
import { TextButton } from './TextButton';

type Props = {
  progressStep: 0 | 1 | 2;
  showBack?: boolean;
  onSkip: () => void;
};

const VARIANT: MeridianVariant = 'progress';

/** Persistent onboarding header: the Meridian progress indicator + Back/Skip (screens-phase-0.md §D). */
export function OnboardingHeader({ progressStep, showBack, onSkip }: Props) {
  return (
    <View style={styles.row}>
      {showBack ? (
        <TextButton label="Back" onPress={() => router.back()} accessibilityHint="Go to the previous onboarding step" />
      ) : (
        <View style={styles.spacer} />
      )}
      <MeridianMark variant={VARIANT} progressStep={progressStep} size={40} />
      <TextButton label="Skip for now" onPress={onSkip} accessibilityHint="Finish setup with default settings" />
    </View>
  );
}

const styles = StyleSheet.create({
  row: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-between',
  },
  spacer: {
    minWidth: theme.touchTarget.min,
  },
});
