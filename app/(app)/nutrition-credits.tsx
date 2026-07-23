import React from 'react';
import { Linking, Pressable, ScrollView, StyleSheet, Text, View } from 'react-native';
import { router } from 'expo-router';
import { SafeAreaView } from 'react-native-safe-area-context';

import { theme } from '../../src/theme';
import { TextButton } from '../../src/components/TextButton';

/**
 * Nutrition sources & attribution (CORE-Credits) — a GATE requirement, not
 * optional polish (design doc §CORE-Credits/§2.1/§6/§12 decision 1). Mirrors
 * `exercise-credits.tsx`'s established pattern, but USDA (public domain) and
 * Open Food Facts (ODbL — attribution AND share-alike) carry genuinely
 * different obligations from each other and from Module C's CC-BY-SA — the
 * copy below is NOT a copy-paste of exercise-credits.tsx's wording.
 */
export default function NutritionCreditsScreen() {
  return (
    <SafeAreaView style={styles.safe} edges={['top', 'bottom']}>
      <ScrollView contentContainerStyle={styles.content}>
        <View style={styles.headerRow}>
          <Text style={[theme.type.title, { color: theme.color.text.primary }]} maxFontSizeMultiplier={1.6}>
            Nutrition sources & credits
          </Text>
          <TextButton label="Close" onPress={() => router.back()} />
        </View>
        <Text style={[theme.type.body, { color: theme.color.text.secondary }]} maxFontSizeMultiplier={2}>
          MileLift&apos;s food database is built from a few sources, credited here as their licenses require.
        </Text>

        <CreditRow
          title="USDA FoodData Central"
          body="Public domain. Generic and whole-food data is from the U.S. Department of Agriculture, Agricultural Research Service, FoodData Central. Cited as good practice; no attribution is legally required."
        />

        <CreditRow
          title="Open Food Facts"
          body="© Open Food Facts contributors, made available under the Open Database License (ODbL) v1.0. Branded and barcoded product data comes from the Open Food Facts community database. Under ODbL, this data stays open: attribution and share-alike apply."
        />
        <Pressable onPress={() => Linking.openURL('https://openfoodfacts.org')} accessibilityRole="link" accessibilityLabel="Open Food Facts website" style={styles.linkRow}>
          <Text style={[theme.type.label, { color: theme.color.accent.data }]} maxFontSizeMultiplier={1.8}>
            openfoodfacts.org
          </Text>
        </Pressable>
        <Pressable onPress={() => Linking.openURL('https://opendatacommons.org/licenses/odbl/1-0/')} accessibilityRole="link" accessibilityLabel="Open Database License v1.0 text" style={styles.linkRow}>
          <Text style={[theme.type.label, { color: theme.color.accent.data }]} maxFontSizeMultiplier={1.8}>
            Read the ODbL v1.0 license
          </Text>
        </Pressable>

        <CreditRow title="MileLift-authored" body="Foods written and owned by MileLift." />
        <CreditRow title="Your own foods" body="Custom foods you create are your own and are not redistributed." />
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
  content: { padding: theme.screen.edge, gap: theme.space.lg, paddingBottom: theme.space.colossal },
  headerRow: { flexDirection: 'row', justifyContent: 'space-between', alignItems: 'center' },
  row: { gap: theme.space.xxs },
  linkRow: { minHeight: theme.touchTarget.min, justifyContent: 'center' },
});
