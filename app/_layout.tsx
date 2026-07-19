import React, { useCallback, useEffect } from 'react';
import { StatusBar } from 'expo-status-bar';
import * as SplashScreen from 'expo-splash-screen';
import { Stack } from 'expo-router';
import { GestureHandlerRootView } from 'react-native-gesture-handler';
import { useFonts, Archivo_600SemiBold, Archivo_700Bold } from '@expo-google-fonts/archivo';
import { Inter_400Regular, Inter_500Medium, Inter_600SemiBold } from '@expo-google-fonts/inter';
import { JetBrainsMono_500Medium, JetBrainsMono_700Bold } from '@expo-google-fonts/jetbrains-mono';

import { theme } from '../src/theme';
import { AuthProvider, useAuth } from '../src/state/AuthContext';
import { ProfileProvider, useProfile } from '../src/state/ProfileContext';
import { ConsentProvider } from '../src/state/ConsentContext';

SplashScreen.preventAutoHideAsync().catch(() => {
  // Already hidden / not applicable (e.g. web) — never let this block startup.
});

export default function RootLayout() {
  const [fontsLoaded, fontError] = useFonts({
    Archivo_600SemiBold,
    Archivo_700Bold,
    Inter_400Regular,
    Inter_500Medium,
    Inter_600SemiBold,
    JetBrainsMono_500Medium,
    JetBrainsMono_700Bold,
  });

  const onReady = useCallback(async () => {
    if (fontsLoaded || fontError) {
      await SplashScreen.hideAsync();
    }
  }, [fontsLoaded, fontError]);

  useEffect(() => {
    void onReady();
  }, [onReady]);

  // A font-loading failure must not hard-crash the app (production-standards:
  // fail specifically, degrade — not "just the happy path"). We proceed with
  // the OS default font rather than showing a permanently blank screen.
  if (!fontsLoaded && !fontError) {
    return null;
  }

  return (
    <GestureHandlerRootView style={{ flex: 1 }}>
      <AuthProvider>
        <ProfileProvider>
          <ConsentProvider>
            <StatusBar style="light" />
            <AuthGate />
          </ConsentProvider>
        </ProfileProvider>
      </AuthProvider>
    </GestureHandlerRootView>
  );
}

/**
 * Routing gate: which top-level route group is reachable is driven by auth +
 * onboarding-completion state, using expo-router's `Stack.Protected` guard
 * API rather than a manual imperative `router.replace` — navigating to a
 * disallowed group auto-redirects to an allowed one.
 */
function AuthGate() {
  const { session, isBootstrapping } = useAuth();
  const { preferences, loadState } = useProfile();

  if (isBootstrapping || (session && loadState === 'loading')) {
    return null; // native splash screen is still visible at this point
  }

  const onboardingComplete = !!preferences?.onboardingCompletedAt;

  return (
    <Stack screenOptions={{ headerShown: false, contentStyle: { backgroundColor: theme.color.bg.canvas } }}>
      <Stack.Protected guard={!session}>
        <Stack.Screen name="(auth)" />
      </Stack.Protected>
      <Stack.Protected guard={!!session && !onboardingComplete}>
        <Stack.Screen name="(onboarding)" />
      </Stack.Protected>
      <Stack.Protected guard={!!session && onboardingComplete}>
        <Stack.Screen name="(app)" />
      </Stack.Protected>
    </Stack>
  );
}
