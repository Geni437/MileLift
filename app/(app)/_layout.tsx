import { Stack } from 'expo-router';

import { theme } from '../../src/theme';

/**
 * App-shell stack. Wraps the tab group so `record` (CORE-01) and
 * `activity/[id]` (CORE-02) can live OUTSIDE the tab bar per
 * docs/design/screens-phase-1.md §B: recording is "a full-screen modal
 * route ... not a tab — it's a single immersive task" that "blocks the tab
 * bar while active," and activity detail is "a pushed route."
 *
 * Phase 2 (screens-phase-2.md §B) adds the Module C surfaces the same way:
 * `workout` (CORE-12 active logging) is the Lift-side analog of `record` —
 * a full-screen modal, keep-awake, blocks the tab bar. Session detail,
 * library/picker, exercise detail/credits, plans/builders, and body/progress
 * are pushed routes.
 */
export default function AppShellLayout() {
  return (
    <Stack screenOptions={{ headerShown: false, contentStyle: { backgroundColor: theme.color.bg.canvas } }}>
      <Stack.Screen name="(tabs)" />
      <Stack.Screen name="record" options={{ presentation: 'fullScreenModal', animation: 'slide_from_bottom' }} />
      <Stack.Screen name="activity/[id]" />
      <Stack.Screen name="workout" options={{ presentation: 'fullScreenModal', animation: 'slide_from_bottom' }} />
      <Stack.Screen name="workout/[id]" />
      <Stack.Screen name="exercises" />
      <Stack.Screen name="exercises/[id]" />
      <Stack.Screen name="exercise-credits" />
      <Stack.Screen name="plans" />
      <Stack.Screen name="plans/template/[id]" />
      <Stack.Screen name="plans/program/[id]" />
      <Stack.Screen name="body" />
      <Stack.Screen name="body/photos" />
      {/* Phase 3 — Module B (nutrition & food logging). screens-phase-3.md §B:
          food log/search is a focused modal route; barcode scan is a modal,
          keep-awake camera route; meal detail/edit, saved meals + builder,
          custom-food create/edit, and nutrition credits are pushed/modal
          routes per that doc's exact routing table. Water/burn logging are
          bottom sheets over the Food tab (no dedicated route). */}
      <Stack.Screen name="food/log" options={{ presentation: 'modal', animation: 'slide_from_bottom' }} />
      <Stack.Screen name="food/scan" options={{ presentation: 'fullScreenModal', animation: 'slide_from_bottom' }} />
      <Stack.Screen name="food/meal/[id]" />
      <Stack.Screen name="saved-meals" />
      <Stack.Screen name="saved-meals/[id]" />
      <Stack.Screen name="custom-food" options={{ presentation: 'modal', animation: 'slide_from_bottom' }} />
      <Stack.Screen name="nutrition-credits" />
    </Stack>
  );
}
