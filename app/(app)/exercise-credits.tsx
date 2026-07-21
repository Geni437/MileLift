import React from 'react';
import { ScrollView, StyleSheet, Text, View } from 'react-native';
import { SafeAreaView } from 'react-native-safe-area-context';

import { theme } from '../../src/theme';

/**
 * Exercise data credits (CORE-13) — the in-app realization of the §6/§12.1
 * "attribution actually ships" gate item. Plain and factual, not marketing,
 * matching Module B's nutrition-source attribution screen's tone.
 */
export default function ExerciseCreditsScreen() {
  return (
    <SafeAreaView style={styles.safe} edges={['top', 'bottom']}>
      <ScrollView contentContainerStyle={styles.content}>
        <Text style={[theme.type.title, { color: theme.color.text.primary }]} maxFontSizeMultiplier={1.6}>
          Exercise data credits
        </Text>
        <Text style={[theme.type.body, { color: theme.color.text.secondary }]} maxFontSizeMultiplier={2}>
          MileLift&apos;s exercise library is built from a few sources, credited here as their licenses require.
        </Text>

        <CreditRow title="Free Exercise DB" body="Public domain (Unlicense). No attribution required — used as the base layer of the library." />
        <CreditRow title="wger" body="CC-BY-SA 4.0. Attribution and share-alike apply to entries sourced from wger." />
        <CreditRow title="MileLift-authored" body="Movements written and owned by MileLift." />
      </ScrollView>
    </SafeAreaView>
  );
}

function CreditRow({ title, body }: { title: string; body: string }) {
  return (
    <View style={styles.row}>
      <Text style={[theme.type.bodyStrong, { color: theme.color.text.primary }]} maxFontSizeMultiplier={1.8}>
        {title}
      </Text>
      <Text style={[theme.type.body, { color: theme.color.text.secondary }]} maxFontSizeMultiplier={2}>
        {body}
      </Text>
    </View>
  );
}

const styles = StyleSheet.create({
  safe: { flex: 1, backgroundColor: theme.color.bg.canvas },
  content: { padding: theme.screen.edge, gap: theme.space.lg },
  row: { gap: theme.space.xxs },
});
