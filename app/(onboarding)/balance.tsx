import React, { useState } from 'react';
import { StyleSheet, Text, View } from 'react-native';
import { router } from 'expo-router';

import { theme } from '../../src/theme';
import { Screen } from '../../src/components/Screen';
import { OnboardingHeader } from '../../src/components/OnboardingHeader';
import { PrimaryButton } from '../../src/components/PrimaryButton';
import { BalanceTrack } from '../../src/components/BalanceTrack';
import { useProfile } from '../../src/state/ProfileContext';
import { inferTimezone, inferUnitsFromLocale } from '../../src/lib/localeDefaults';

export default function OnboardingBalanceScreen() {
  const { preferences, updateProfile, setTrainingBalance, completeOnboarding } = useProfile();
  const [runShare, setRunShare] = useState(preferences?.trainingBalanceRun ?? 50);

  const handleSkip = async () => {
    await setTrainingBalance(runShare);
    // "Skip always yields a usable account" (screens-phase-0.md §D) — apply
    // locale-inferred unit defaults since Step 3 is never reached.
    await updateProfile({ ...inferUnitsFromLocale(), defaultTimezone: inferTimezone() });
    await completeOnboarding();
  };

  const handleNext = async () => {
    await setTrainingBalance(runShare);
    router.push('/(onboarding)/profile-setup');
  };

  return (
    <Screen>
      <OnboardingHeader progressStep={1} showBack onSkip={handleSkip} />

      <View style={styles.hero}>
        <Text style={[theme.type.title, { color: theme.color.text.primary }]}>Where&apos;s your training right now?</Text>
      </View>

      <BalanceTrack value={runShare} onChange={setRunShare} />

      <Text style={[theme.type.body, { color: theme.color.text.secondary }]}>
        You can change this anytime — it just tunes what MileLift shows first.
      </Text>

      <View style={styles.actions}>
        <PrimaryButton label="Next" onPress={handleNext} />
      </View>
    </Screen>
  );
}

const styles = StyleSheet.create({
  hero: {
    gap: theme.space.xs,
  },
  actions: {
    gap: theme.space.sm,
  },
});
