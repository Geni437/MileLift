import { Redirect } from 'expo-router';

import { useAuth } from '../src/state/AuthContext';
import { useProfile } from '../src/state/ProfileContext';

/**
 * Entry redirector. The actual access control lives in the root layout's
 * `Stack.Protected` guards — this just picks the first screen inside
 * whichever group is currently reachable, so `/` always lands somewhere
 * real instead of a blank route.
 */
export default function Index() {
  const { session, isBootstrapping } = useAuth();
  const { preferences, loadState } = useProfile();

  if (isBootstrapping || (session && loadState === 'loading')) {
    return null;
  }

  if (!session) {
    return <Redirect href="/(auth)/sign-up" />;
  }

  if (!preferences?.onboardingCompletedAt) {
    return <Redirect href="/(onboarding)/welcome" />;
  }

  return <Redirect href="/(app)/home" />;
}
