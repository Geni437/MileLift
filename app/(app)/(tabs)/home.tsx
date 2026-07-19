import React from 'react';
import { StyleSheet, View } from 'react-native';

import { Screen } from '../../../src/components/Screen';
import { EmptyState } from '../../../src/components/EmptyState';
import { MeridianMark } from '../../../src/components/MeridianMark';

/**
 * Placeholder Home tab. Phase 0 scope is explicitly auth/onboarding/consent/
 * profile only (screens-phase-0.md scope guardrail: "No dashboard, no
 * activity/nutrition/strength logging ... those are Phase 1-3"). This
 * screen states that honestly instead of shipping fabricated activity data
 * to look more finished than the build actually is.
 */
export default function HomeScreen() {
  return (
    <Screen>
      <View style={styles.header}>
        <MeridianMark variant="glyph" size={40} />
      </View>
      <EmptyState
        title="Your history starts here"
        body="Activity, nutrition, and strength logging land in the next phases. For now, your account and profile are set up and syncing."
      />
    </Screen>
  );
}

const styles = StyleSheet.create({
  header: {
    alignItems: 'flex-start',
  },
});
