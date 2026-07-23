import React, { useState } from 'react';
import { ScrollView, StyleSheet, Text, View } from 'react-native';
import { router, useLocalSearchParams } from 'expo-router';
import { SafeAreaView } from 'react-native-safe-area-context';

import { theme } from '../../src/theme';
import { Field } from '../../src/components/Field';
import { PrimaryButton } from '../../src/components/PrimaryButton';
import { TextButton } from '../../src/components/TextButton';
import { SegmentedControl } from '../../src/components/SegmentedControl';
import { customFoodsRepository } from '../../src/db/repositories/customFoodsRepository';
import { generateUuidV4 } from '../../src/lib/uuid';
import { runSync } from '../../src/sync/syncEngine';
import { useAuth } from '../../src/state/AuthContext';
import type { FoodMeasureBasis } from '../../src/db/types';

/**
 * CORE-Custom — custom food creation (design doc §CORE-Custom): the
 * barcode-miss landing spot AND a general "add my own food" flow. Owner-
 * only, offline-first — creatable in airplane mode (the barcode-miss path
 * must work offline, §2.4/§1.4).
 */
export default function CustomFoodScreen() {
  const { prefillName, prefillBarcode } = useLocalSearchParams<{ prefillName?: string; prefillBarcode?: string }>();
  const { userId } = useAuth();

  const [name, setName] = useState(prefillName ?? '');
  const [brand, setBrand] = useState('');
  const [basis, setBasis] = useState<FoodMeasureBasis>('per_100g');
  const [energyKcal, setEnergyKcal] = useState('');
  const [proteinG, setProteinG] = useState('');
  const [carbG, setCarbG] = useState('');
  const [fatG, setFatG] = useState('');
  const [defaultServing, setDefaultServing] = useState('');
  const [notes, setNotes] = useState('');
  const [saving, setSaving] = useState(false);

  const parsedEnergy = Number(energyKcal);
  const canSave = name.trim().length > 0 && Number.isFinite(parsedEnergy) && parsedEnergy >= 0;

  const handleSave = async () => {
    if (!userId || !canSave) return;
    setSaving(true);
    try {
      // CORE-07 §2.4 step 3: a barcode already re-scanned to one of the
      // user's own custom foods is retained, never re-created.
      if (prefillBarcode) {
        const existing = await customFoodsRepository.getByBarcode(userId, prefillBarcode);
        if (existing) {
          router.replace({ pathname: '/food/log' });
          return;
        }
      }
      const id = generateUuidV4();
      await customFoodsRepository.create(id, userId, {
        barcode: prefillBarcode ?? null,
        name: name.trim(),
        brand: brand.trim() || null,
        basis,
        energyKcal: parsedEnergy,
        proteinG: proteinG.trim() ? Number(proteinG) : null,
        carbG: carbG.trim() ? Number(carbG) : null,
        fatG: fatG.trim() ? Number(fatG) : null,
        defaultServingGOrMl: defaultServing.trim() ? Number(defaultServing) : null,
        notes: notes.trim() || null,
      });
      void runSync('post-write');
      router.back();
    } finally {
      setSaving(false);
    }
  };

  return (
    <SafeAreaView style={styles.safe} edges={['top', 'bottom']}>
      <ScrollView contentContainerStyle={styles.content}>
        <View style={styles.headerRow}>
          <Text style={[theme.type.title, { color: theme.color.text.primary }]} maxFontSizeMultiplier={1.6}>
            {prefillBarcode ? 'Add this barcode as your own food' : 'Create a food'}
          </Text>
          <TextButton label="Cancel" onPress={() => router.back()} />
        </View>
        {prefillBarcode && (
          <Text style={[theme.type.body, { color: theme.color.text.secondary }]} maxFontSizeMultiplier={2}>
            No match for this barcode yet. Add it as your own food — scan it next time and it&apos;s yours instantly.
          </Text>
        )}

        <Field label="Name" value={name} onChangeText={setName} />
        <Field label="Brand (optional)" value={brand} onChangeText={setBrand} />

        <Text style={[theme.type.label, { color: theme.color.text.secondary }]} maxFontSizeMultiplier={1.8}>
          Are these numbers per 100 g, or per 100 ml?
        </Text>
        <SegmentedControl
          options={[
            { label: '100 g', value: 'per_100g' },
            { label: '100 ml', value: 'per_100ml' },
          ]}
          value={basis}
          onChange={setBasis}
        />

        <Field label="Calories (required)" value={energyKcal} onChangeText={setEnergyKcal} keyboardType="decimal-pad" />
        <Field label="Protein (g, optional)" value={proteinG} onChangeText={setProteinG} keyboardType="decimal-pad" />
        <Field label="Carb (g, optional)" value={carbG} onChangeText={setCarbG} keyboardType="decimal-pad" />
        <Field label="Fat (g, optional)" value={fatG} onChangeText={setFatG} keyboardType="decimal-pad" />
        <Field label={`Default serving (${basis === 'per_100ml' ? 'ml' : 'g'}, optional)`} value={defaultServing} onChangeText={setDefaultServing} keyboardType="decimal-pad" />
        <Field label="Notes (optional)" value={notes} onChangeText={setNotes} />

        <PrimaryButton label="Save food" onPress={() => void handleSave()} loading={saving} disabled={!canSave} />
      </ScrollView>
    </SafeAreaView>
  );
}

const styles = StyleSheet.create({
  safe: { flex: 1, backgroundColor: theme.color.bg.canvas },
  content: { padding: theme.screen.edge, gap: theme.space.md, paddingBottom: theme.space.colossal },
  headerRow: { flexDirection: 'row', justifyContent: 'space-between', alignItems: 'center' },
});
