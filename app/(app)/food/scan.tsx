import React, { useEffect, useState } from 'react';
import { Modal, Pressable, StyleSheet, Text, View } from 'react-native';
import { router } from 'expo-router';
import { SafeAreaView } from 'react-native-safe-area-context';

import { theme } from '../../../src/theme';
import { TextButton } from '../../../src/components/TextButton';
import { PrimaryButton } from '../../../src/components/PrimaryButton';
import { InlineBanner } from '../../../src/components/InlineBanner';
import { ConsentSheet } from '../../../src/components/consent/ConsentSheet';
import { ScanFrame } from '../../../src/components/nutrition/ScanFrame';
import { ServingControl } from '../../../src/components/nutrition/ServingControl';
import { SourceTag } from '../../../src/components/nutrition/SourceTag';
import { DataQualityTag } from '../../../src/components/nutrition/DataQualityTag';
import { useAuth } from '../../../src/state/AuthContext';
import { useConsent } from '../../../src/state/ConsentContext';
import { useFoodLog, type FoodPick } from '../../../src/features/nutrition/useFoodLog';
import { resolveBarcode, type FoodSearchItem } from '../../../src/lib/foodSearch';
import type { FoodServing, MealType } from '../../../src/db/types';

/** CORE-07 — camera-based barcode scan → resolve → log, with an explicit, non-dead-end miss path (design doc §CORE-07/§2.4). */
export default function ScanBarcodeScreen() {
  const { userId } = useAuth();
  const { categories, grant, refreshOsStatus } = useConsent();
  const foodLog = useFoodLog({ userId: userId ?? '' });

  const hasCameraConsent = !!categories.camera.consent && categories.camera.osStatus === 'granted';
  const [showConsent, setShowConsent] = useState(false);
  const [consentLoading, setConsentLoading] = useState(false);
  const [cameraDeclined, setCameraDeclined] = useState(false);
  const [resolving, setResolving] = useState(false);
  const [resolvedFood, setResolvedFood] = useState<{ item: FoodSearchItem; servings: FoodServing[] } | null>(null);
  const [selectedServingId, setSelectedServingId] = useState<string | null>(null);
  const [quantity, setQuantity] = useState(1);

  useEffect(() => {
    // Point-of-use camera consent check (design doc §CORE-07 step 1: "reuse
    // E3 — do NOT reinvent"). Runs once on mount, mirroring the existing E3
    // consent-priming pattern used elsewhere (e.g. body.tsx's photo flow).
    void refreshOsStatus('camera');
    // eslint-disable-next-line react-hooks/set-state-in-effect
    if (!hasCameraConsent) setShowConsent(true);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const handleAllowCamera = async () => {
    setConsentLoading(true);
    const result = await grant('camera');
    setConsentLoading(false);
    setShowConsent(false);
    if (!result.ok) setCameraDeclined(true);
  };

  const handleScanned = async (barcode: string) => {
    setResolving(true);
    try {
      const result = await resolveBarcode(barcode);
      if (result.status === 'hit') {
        setResolvedFood({ item: result.item, servings: result.servings });
        setSelectedServingId(result.servings.find((s) => s.isDefault)?.id ?? result.servings[0]?.id ?? null);
        setQuantity(1);
      } else {
        // Miss (server-confirmed or offline) — the explicit non-dead-end path
        // (§2.4 step 3): route to custom-food creation, prefilling the barcode.
        router.replace({ pathname: '/custom-food', params: { prefillBarcode: barcode } });
      }
    } finally {
      // An unexpected throw (e.g. getDb() itself failing) must never leave
      // the scan UI stuck showing a resolving spinner forever.
      setResolving(false);
    }
  };

  const handleAddAndLog = async () => {
    if (!resolvedFood || !selectedServingId) return;
    const pick: FoodPick = {
      foodId: resolvedFood.item.foodId,
      customFoodId: null,
      name: resolvedFood.item.name,
      brand: resolvedFood.item.brand,
      basis: { energyKcal: resolvedFood.item.energyKcal, proteinG: resolvedFood.item.proteinG, carbG: resolvedFood.item.carbG, fatG: resolvedFood.item.fatG },
      servings: resolvedFood.servings,
      dataQuality: resolvedFood.item.dataQuality,
    };
    await foodLog.ensureDraft(defaultMealTypeForNow());
    await foodLog.addItem(pick, selectedServingId, quantity);
    await foodLog.commit();
    router.back();
  };

  if (cameraDeclined) {
    return (
      <SafeAreaView style={styles.safe} edges={['top', 'bottom']}>
        <View style={styles.declinedWrap}>
          <InlineBanner tone="info" message="Camera's off — search for the food by name instead, or turn on the camera." actionLabel="Turn on camera" onAction={() => setShowConsent(true)} />
          <PrimaryButton label="Search instead" onPress={() => router.replace('/food/log')} />
          <TextButton label="Close" onPress={() => router.back()} />
        </View>
        <ConsentSheet visible={showConsent} category="camera" loading={consentLoading} onAllow={() => void handleAllowCamera()} onDecline={() => setShowConsent(false)} />
      </SafeAreaView>
    );
  }

  return (
    <View style={styles.safe}>
      {hasCameraConsent && <ScanFrame onBarcodeScanned={(b) => void handleScanned(b)} resolving={resolving} onSearchInstead={() => router.replace('/food/log')} />}

      <SafeAreaView edges={['top']} style={styles.topBar}>
        <TextButton label="Close" onPress={() => router.back()} />
      </SafeAreaView>

      <ConsentSheet
        visible={showConsent}
        category="camera"
        loading={consentLoading}
        onAllow={() => void handleAllowCamera()}
        onDecline={() => {
          setShowConsent(false);
          setCameraDeclined(true);
        }}
      />

      <Modal visible={!!resolvedFood} transparent animationType="slide" onRequestClose={() => setResolvedFood(null)}>
        <View style={[styles.scrim, { backgroundColor: theme.color.bg.overlay }]}>
          <Pressable style={StyleSheet.absoluteFill} onPress={() => setResolvedFood(null)} accessibilityRole="button" accessibilityLabel="Dismiss" />
          <SafeAreaView edges={['bottom']} style={styles.sheetWrap}>
            <View style={[styles.sheet, { backgroundColor: theme.color.bg.raised }]} accessibilityViewIsModal accessibilityRole="none">
              {resolvedFood && (
                <>
                  <View style={styles.sheetHeaderRow}>
                    <Text style={[theme.type.heading, { color: theme.color.text.primary }]} maxFontSizeMultiplier={1.8}>
                      {resolvedFood.item.name}
                    </Text>
                    <SourceTag source={resolvedFood.item.source} />
                  </View>
                  <DataQualityTag dataQuality={resolvedFood.item.dataQuality} />
                  {resolvedFood.item.dataQuality === 'low' && (
                    <Text style={[theme.type.body, styles.caution, { color: theme.color.text.primary }]} maxFontSizeMultiplier={2}>
                      This is community-sourced and may be off — check the calories before you log.
                    </Text>
                  )}
                  <ServingControl
                    perBasisMacros={resolvedFood.item}
                    servings={resolvedFood.servings}
                    selectedServingId={selectedServingId}
                    onSelectServing={setSelectedServingId}
                    quantity={quantity}
                    onChangeQuantity={setQuantity}
                  />
                  <PrimaryButton label="Log food" onPress={() => void handleAddAndLog()} loading={foodLog.saving} disabled={!selectedServingId} />
                  <TextButton label="Cancel" onPress={() => setResolvedFood(null)} />
                </>
              )}
            </View>
          </SafeAreaView>
        </View>
      </Modal>
    </View>
  );
}

function defaultMealTypeForNow(): MealType {
  const hour = new Date().getHours();
  if (hour < 11) return 'breakfast';
  if (hour < 16) return 'lunch';
  if (hour < 21) return 'dinner';
  return 'snack';
}

const styles = StyleSheet.create({
  safe: { flex: 1, backgroundColor: theme.color.bg.canvas },
  topBar: { position: 'absolute', top: 0, left: 0, right: 0, paddingHorizontal: theme.screen.edge, alignItems: 'flex-start' },
  declinedWrap: { flex: 1, justifyContent: 'center', padding: theme.screen.edge, gap: theme.space.md },
  scrim: { flex: 1, justifyContent: 'flex-end' },
  sheetWrap: { width: '100%' },
  sheet: { borderTopLeftRadius: theme.radius.xl, borderTopRightRadius: theme.radius.xl, padding: theme.space.lg, gap: theme.space.md },
  sheetHeaderRow: { flexDirection: 'row', justifyContent: 'space-between', alignItems: 'center' },
  caution: {},
});
