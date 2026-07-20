import React from 'react';
import { StyleSheet, Text } from 'react-native';

import { theme } from '../../../src/theme';
import { Screen } from '../../../src/components/Screen';
import { SkeletonBlock } from '../../../src/components/SkeletonBlock';
import { InlineBanner } from '../../../src/components/InlineBanner';
import { EmptyState } from '../../../src/components/EmptyState';
import { IdentitySection } from '../../../src/components/profile/IdentitySection';
import { TrainingBalanceSection } from '../../../src/components/profile/TrainingBalanceSection';
import { UnitsSection } from '../../../src/components/profile/UnitsSection';
import { HealthDetailsSection } from '../../../src/components/profile/HealthDetailsSection';
import { PermissionsSection } from '../../../src/components/profile/PermissionsSection';
import { HealthConnectSection } from '../../../src/components/profile/HealthConnectSection';
import { AccountSection } from '../../../src/components/profile/AccountSection';
import { useAuth } from '../../../src/state/AuthContext';
import { useProfile } from '../../../src/state/ProfileContext';
import { useConsent } from '../../../src/state/ConsentContext';
import { runSync } from '../../../src/sync/syncEngine';

export default function ProfileScreen() {
  const { session, signOut, userId } = useAuth();
  const { loadState, loadError, profile, profileHealth, preferences, updateProfile, updateProfileHealth, setTrainingBalance, refresh } =
    useProfile();
  const { categories, grant } = useConsent();

  if (loadState === 'loading') {
    return (
      <Screen>
        <SkeletonBlock height={80} radius={theme.radius.lg} />
        <SkeletonBlock height={140} radius={theme.radius.lg} />
        <SkeletonBlock height={100} radius={theme.radius.lg} />
      </Screen>
    );
  }

  if (loadState === 'error') {
    return (
      <Screen>
        <InlineBanner tone="danger" message={loadError ?? 'Could not load your profile.'} actionLabel="Retry" onAction={() => void refresh()} />
      </Screen>
    );
  }

  if (loadState === 'empty' || !profile) {
    return (
      <Screen>
        <EmptyState
          title="Your profile isn't set up yet"
          body="We couldn't find your profile locally. If you're offline, reconnect and try again."
          actionLabel="Retry"
          onAction={() => void refresh()}
        />
      </Screen>
    );
  }

  const email = session?.user?.email ?? null;
  const signInMethods = (session?.user?.app_metadata?.providers as string[] | undefined) ?? ['email'];

  return (
    <Screen contentStyle={styles.content}>
      <Text style={[theme.type.displayMd, { color: theme.color.text.primary }]}>Profile</Text>

      <IdentitySection profile={profile} email={email} onSave={updateProfile} />

      <TrainingBalanceSection trainingBalanceRun={preferences?.trainingBalanceRun ?? 50} onChange={setTrainingBalance} />

      <UnitsSection unitWeight={profile.unitWeight} unitDistance={profile.unitDistance} onChange={updateProfile} />

      <HealthDetailsSection
        hasHealthConsent={!!categories.health.consent}
        profileHealth={profileHealth}
        unitDistance={profile.unitDistance}
        onRequestConsent={() => void grant('health')}
        onSave={updateProfileHealth}
      />

      <PermissionsSection />

      <HealthConnectSection
        userId={userId}
        unitDistance={profile.unitDistance}
        hasHealthConsent={!!categories.health.consent}
        onRequestHealthConsent={async () => {
          const result = await grant('health');
          return { ok: result.ok };
        }}
      />

      <AccountSection
        email={email}
        signInMethods={signInMethods}
        onLogOut={signOut}
        onRequestDeletion={async () => {
          await updateProfile({ deletionRequestedAt: new Date().toISOString() });
          void runSync('manual');
        }}
      />
    </Screen>
  );
}

const styles = StyleSheet.create({
  content: {
    gap: theme.space.lg,
  },
});
