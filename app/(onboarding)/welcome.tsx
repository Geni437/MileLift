import React from 'react';
import { StyleSheet, Text, View } from 'react-native';
import { router } from 'expo-router';

import { theme } from '../../src/theme';
import { Screen } from '../../src/components/Screen';
import { OnboardingHeader } from '../../src/components/OnboardingHeader';
import { PrimaryButton } from '../../src/components/PrimaryButton';
import { useProfile } from '../../src/state/ProfileContext';
import { inferTimezone, inferUnitsFromLocale } from '../../src/lib/localeDefaults';

export default function OnboardingWelcomeScreen() {
  const { updateProfile, completeOnboarding } = useProfile();

  const handleSkip = async () => {
    // "Skip always yields a usable account" (screens-phase-0.md §D) — apply
    // locale-inferred unit defaults since the Step 3 screen that would
    // normally set them is never reached.
    await updateProfile({ ...inferUnitsFromLocale(), defaultTimezone: inferTimezone() });
    await completeOnboarding();
    // AuthGate's Stack.Protected guard reacts to preferences changing and routes to (app) automatically.
  };

  return (
    <Screen>
      <OnboardingHeader progressStep={0} onSkip={handleSkip} />

      <View style={styles.hero}>
        <Text style={[theme.type.displayLg, { color: theme.color.text.primary }]} maxFontSizeMultiplier={1.6}>
          You run <Text style={styles.italic}>and</Text> you lift.
        </Text>
        <Text style={[theme.type.bodyLg, { color: theme.color.text.secondary }]} maxFontSizeMultiplier={2}>
          Most apps make you pick one. MileLift keeps both in a single history, so your training actually adds up.
        </Text>
      </View>

      <View style={styles.actions}>
        <PrimaryButton label="Set up my training" onPress={() => router.push('/(onboarding)/balance')} />
      </View>
    </Screen>
  );
}

const styles = StyleSheet.create({
  hero: {
    gap: theme.space.sm,
    flex: 1,
    justifyContent: 'center',
  },
  italic: {
    fontStyle: 'italic',
  },
  actions: {
    gap: theme.space.sm,
  },
});
