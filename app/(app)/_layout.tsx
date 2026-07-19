import { Stack } from 'expo-router';

import { theme } from '../../src/theme';

/**
 * App-shell stack. Wraps the tab group so `record` (CORE-01) and
 * `activity/[id]` (CORE-02) can live OUTSIDE the tab bar per
 * docs/design/screens-phase-1.md §B: recording is "a full-screen modal
 * route ... not a tab — it's a single immersive task" that "blocks the tab
 * bar while active," and activity detail is "a pushed route."
 */
export default function AppShellLayout() {
  return (
    <Stack screenOptions={{ headerShown: false, contentStyle: { backgroundColor: theme.color.bg.canvas } }}>
      <Stack.Screen name="(tabs)" />
      <Stack.Screen name="record" options={{ presentation: 'fullScreenModal', animation: 'slide_from_bottom' }} />
      <Stack.Screen name="activity/[id]" />
    </Stack>
  );
}
