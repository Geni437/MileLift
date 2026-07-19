import React, { useEffect, useState } from 'react';
import { StyleSheet, Text, View } from 'react-native';

import { theme } from '../../src/theme';
import { Screen } from '../../src/components/Screen';
import { OnboardingHeader } from '../../src/components/OnboardingHeader';
import { Field } from '../../src/components/Field';
import { PrimaryButton } from '../../src/components/PrimaryButton';
import { MeridianMark } from '../../src/components/MeridianMark';
import { SegmentedControl } from '../../src/components/SegmentedControl';
import { useAuth } from '../../src/state/AuthContext';
import { useProfile } from '../../src/state/ProfileContext';
import { useNetworkStatus } from '../../src/hooks/useNetworkStatus';
import { useDebouncedValue } from '../../src/hooks/useDebouncedValue';
import { checkUsernameAvailability, type UsernameCheckResult } from '../../src/lib/username';
import { inferTimezone, inferUnitsFromLocale } from '../../src/lib/localeDefaults';
import type { UnitDistance, UnitWeight } from '../../src/db/types';

const COMPLETION_ANIMATION_MS = theme.duration.deliberate * 2 + 400;

export default function OnboardingProfileSetupScreen() {
  const { userId } = useAuth();
  const { profile, updateProfile, completeOnboarding } = useProfile();
  const { isOnline } = useNetworkStatus();

  const localeDefaults = inferUnitsFromLocale();

  const [displayName, setDisplayName] = useState(profile?.displayName ?? '');
  const [username, setUsername] = useState(profile?.username ?? '');
  const [unitWeight, setUnitWeight] = useState<UnitWeight>(profile?.unitWeight ?? localeDefaults.unitWeight);
  const [unitDistance, setUnitDistance] = useState<UnitDistance>(profile?.unitDistance ?? localeDefaults.unitDistance);
  const [usernameCheck, setUsernameCheck] = useState<UsernameCheckResult | 'checking' | 'idle'>('idle');
  const [submitting, setSubmitting] = useState(false);
  const [completed, setCompleted] = useState(false);

  const debouncedUsername = useDebouncedValue(username.trim(), 400);

  useEffect(() => {
    // react-hooks/set-state-in-effect flags the synchronous setState calls
    // below. This is the React-Compiler-oriented "don't setState
    // synchronously in an effect" rule; it doesn't apply here — this effect
    // is deliberately synchronizing local UI state with an external async
    // check (username availability) keyed off a debounced value, which is
    // exactly the "subscribe to an external system" case the rule's own
    // message carves out as legitimate. No React Compiler is in use in this
    // project, so the extra-render concern the rule targets doesn't apply.
    if (!userId || debouncedUsername.length === 0) {
      // eslint-disable-next-line react-hooks/set-state-in-effect
      setUsernameCheck('idle');
      return;
    }
    let cancelled = false;
    setUsernameCheck('checking');
    checkUsernameAvailability(debouncedUsername, userId).then((result) => {
      if (!cancelled) setUsernameCheck(result);
    });
    return () => {
      cancelled = true;
    };
  }, [debouncedUsername, userId]);

  const handleSkip = async () => {
    // "Skip always yields a usable account" (screens-phase-0.md §D) — persist
    // whatever is currently on screen (locale-inferred defaults if untouched,
    // or the user's in-progress edits) rather than discarding them.
    await updateProfile({
      displayName: displayName.trim() || null,
      username: username.trim() || null,
      unitWeight,
      unitDistance,
      defaultTimezone: inferTimezone(),
    });
    await completeOnboarding();
  };

  const handleFinish = async () => {
    setSubmitting(true);
    await updateProfile({
      displayName: displayName.trim() || null,
      username: username.trim() || null,
      unitWeight,
      unitDistance,
      defaultTimezone: inferTimezone(),
    });
    setSubmitting(false);
    setCompleted(true);
    setTimeout(() => {
      void completeOnboarding();
    }, COMPLETION_ANIMATION_MS);
  };

  if (completed) {
    return (
      <Screen scroll={false}>
        <View style={styles.completeWrap}>
          <MeridianMark variant="progress" progressStep={2} size={96} />
        </View>
      </Screen>
    );
  }

  const usernameError =
    usernameCheck === 'invalid_format'
      ? 'Use 3-30 letters, numbers, periods, or underscores.'
      : usernameCheck === 'taken'
        ? 'Taken — try another.'
        : null;
  const usernameSuccess = usernameCheck === 'available' ? 'Available' : null;
  const usernameHelper =
    usernameCheck === 'checking'
      ? 'Checking...'
      : usernameCheck === 'unknown_offline'
        ? "We'll check this is free once you're back online."
        : undefined;

  return (
    <Screen>
      <OnboardingHeader progressStep={1} showBack onSkip={handleSkip} />

      <View style={styles.hero}>
        <Text style={[theme.type.title, { color: theme.color.text.primary }]}>Name & units</Text>
      </View>

      {!isOnline && usernameCheck === 'idle' && (
        <Text style={[theme.type.caption, { color: theme.color.text.tertiary }]}>
          You&apos;re offline — username availability will be confirmed once you&apos;re back online.
        </Text>
      )}

      <View style={styles.form}>
        <Field
          label="Display name"
          value={displayName}
          onChangeText={setDisplayName}
          helperText="Shown to people you train with."
          autoCapitalize="words"
          testID="onboarding-display-name"
        />

        <Field
          label="Username"
          value={username}
          onChangeText={setUsername}
          errorText={usernameError}
          successText={usernameSuccess}
          helperText={usernameHelper}
          autoCapitalize="none"
          autoCorrect={false}
          testID="onboarding-username"
        />

        <View style={styles.unitsSection}>
          <Text style={[theme.type.label, { color: theme.color.text.secondary }]}>Weight</Text>
          <SegmentedControl
            options={[
              { label: 'kg', value: 'kg' as UnitWeight },
              { label: 'lb', value: 'lb' as UnitWeight },
            ]}
            value={unitWeight}
            onChange={setUnitWeight}
          />

          <Text style={[theme.type.label, { color: theme.color.text.secondary }]}>Distance</Text>
          <SegmentedControl
            options={[
              { label: 'km', value: 'km' as UnitDistance },
              { label: 'mi', value: 'mi' as UnitDistance },
            ]}
            value={unitDistance}
            onChange={setUnitDistance}
          />
        </View>
      </View>

      <PrimaryButton label="Finish setup" onPress={handleFinish} loading={submitting} testID="onboarding-finish" />
    </Screen>
  );
}

const styles = StyleSheet.create({
  hero: {
    gap: theme.space.xs,
  },
  form: {
    gap: theme.space.md,
  },
  unitsSection: {
    gap: theme.space.xs,
  },
  completeWrap: {
    flex: 1,
    alignItems: 'center',
    justifyContent: 'center',
  },
});
