import React, { useEffect, useState } from 'react';
import { FlatList, Modal, Pressable, StyleSheet, Text, View } from 'react-native';
import { router, useLocalSearchParams } from 'expo-router';
import { SafeAreaView } from 'react-native-safe-area-context';

import { theme } from '../../../src/theme';
import { Field } from '../../../src/components/Field';
import { PrimaryButton } from '../../../src/components/PrimaryButton';
import { TextButton } from '../../../src/components/TextButton';
import { InlineBanner } from '../../../src/components/InlineBanner';
import { MeridianMark } from '../../../src/components/MeridianMark';
import { FoodSearchRow } from '../../../src/components/nutrition/FoodSearchRow';
import { ServingControl } from '../../../src/components/nutrition/ServingControl';
import { DataQualityTag } from '../../../src/components/nutrition/DataQualityTag';
import { SourceTag } from '../../../src/components/nutrition/SourceTag';
import { FoodLogItemRow } from '../../../src/components/nutrition/FoodLogItemRow';
import { useAuth } from '../../../src/state/AuthContext';
import { useFoodLog, type FoodPick } from '../../../src/features/nutrition/useFoodLog';
import { searchFoods, type FoodSearchCursor, type FoodSearchItem } from '../../../src/lib/foodSearch';
import { customFoodsRepository } from '../../../src/db/repositories/customFoodsRepository';
import type { FoodServing, LocalCustomFood, MealType } from '../../../src/db/types';

const MEAL_TYPES: MealType[] = ['breakfast', 'lunch', 'dinner', 'snack', 'other'];
const MEAL_TYPE_LABEL: Record<MealType, string> = { breakfast: 'Breakfast', lunch: 'Lunch', dinner: 'Dinner', snack: 'Snack', other: 'Other' };

function toFoodPick(item: FoodSearchItem, servings: FoodServing[]): FoodPick {
  return {
    foodId: item.foodId,
    customFoodId: null,
    name: item.name,
    brand: item.brand,
    basis: { energyKcal: item.energyKcal, proteinG: item.proteinG, carbG: item.carbG, fatG: item.fatG },
    servings,
    dataQuality: item.dataQuality,
  };
}

function customFoodToPick(food: LocalCustomFood): FoodPick {
  const serving: FoodServing = { id: 'default', label: food.defaultServingGOrMl ? `${food.defaultServingGOrMl} ${food.basis === 'per_100ml' ? 'ml' : 'g'}` : '100 g/ml', gramOrMlWeight: food.defaultServingGOrMl ?? 100, isDefault: true };
  return {
    foodId: null,
    customFoodId: food.id,
    name: food.name,
    brand: food.brand,
    basis: { energyKcal: food.energyKcal, proteinG: food.proteinG, carbG: food.carbG, fatG: food.fatG },
    servings: [serving],
    dataQuality: null,
  };
}

/** CORE-06 — food search + meal builder (design doc, the highest-frequency screen in the module). */
export default function FoodLogScreen() {
  const { entryId, prefillQuery } = useLocalSearchParams<{ entryId?: string; prefillQuery?: string }>();
  const { userId } = useAuth();
  const foodLog = useFoodLog({ userId: userId ?? '' });

  const [query, setQuery] = useState(prefillQuery ?? '');
  const [results, setResults] = useState<FoodSearchItem[]>([]);
  const [cursor, setCursor] = useState<FoodSearchCursor>(null);
  const [offline, setOffline] = useState(false);
  const [searching, setSearching] = useState(false);
  const [showMyFoods, setShowMyFoods] = useState(false);
  const [customFoods, setCustomFoods] = useState<LocalCustomFood[]>([]);
  const [pickedFood, setPickedFood] = useState<FoodPick | null>(null);
  const [selectedServingId, setSelectedServingId] = useState<string | null>(null);
  const [quantity, setQuantity] = useState(1);

  useEffect(() => {
    if (entryId && userId) void foodLog.loadExisting(entryId);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [entryId, userId]);

  useEffect(() => {
    if (userId) void customFoodsRepository.listForUser(userId).then(setCustomFoods);
  }, [userId]);

  useEffect(() => {
    // Debounced search-as-you-type against the trimmed query, resetting
    // pagination each time the query changes — a legitimate "derive from
    // input" effect, same pattern as exercises.tsx's own search effect.
    if (!query.trim()) {
      // eslint-disable-next-line react-hooks/set-state-in-effect
      setResults([]);
      setCursor(null);
      return;
    }
    const timer = setTimeout(() => {
      setSearching(true);
      void searchFoods(query, null).then((page) => {
        setResults(page.items);
        setCursor(page.nextCursor);
        setOffline(page.offline);
        setSearching(false);
      });
    }, 300);
    return () => clearTimeout(timer);
  }, [query]);

  const loadMore = async () => {
    if (!cursor || searching) return;
    setSearching(true);
    const page = await searchFoods(query, cursor);
    setResults((prev) => [...prev, ...page.items]);
    setCursor(page.nextCursor);
    setSearching(false);
  };

  const openServingSheet = (pick: FoodPick) => {
    setPickedFood(pick);
    setSelectedServingId(pick.servings[0]?.id ?? null);
    setQuantity(1);
  };

  const handleAddToMeal = async () => {
    if (!pickedFood || !selectedServingId) return;
    await foodLog.addItem(pickedFood, selectedServingId, quantity);
    setPickedFood(null);
  };

  const handleSaveMeal = async () => {
    await foodLog.commit();
    router.back();
  };

  const handleClose = async () => {
    // A draft with items already added is committed on close rather than
    // left an orphaned, never-visible-anywhere row (§CORE-06 "never lose
    // what's already added") — the user already took the deliberate "Add to
    // meal" action for each item, so backing out of search is treated the
    // same as "Save meal," landing it in Today. Only a truly empty,
    // never-touched draft is safe to fully discard.
    if (foodLog.entry && foodLog.items.length > 0) await foodLog.commit();
    else if (foodLog.entry) await foodLog.discardDraft();
    router.back();
  };

  const noResults = query.trim().length > 0 && !searching && results.length === 0 && !showMyFoods;

  return (
    <SafeAreaView style={styles.safe} edges={['top', 'bottom']}>
      <View style={styles.header}>
        <View style={styles.headerRow}>
          <Text style={[theme.type.title, { color: theme.color.text.primary }]} maxFontSizeMultiplier={1.6}>
            {entryId ? 'Add food' : 'Log food'}
          </Text>
          <TextButton label="Close" onPress={() => void handleClose()} />
        </View>
        <Field label="Search" value={query} onChangeText={setQuery} placeholder="Search foods" accessibilityLabel="Search foods" />
        <View style={styles.chipRow}>
          <ChipButton label="My foods" selected={showMyFoods} onPress={() => setShowMyFoods((v) => !v)} />
          <TextButton label="Scan a barcode ▸" onPress={() => router.push('/food/scan')} />
          <TextButton label="Saved meals ▸" onPress={() => router.push('/saved-meals')} />
        </View>
        {offline && (
          <InlineBanner tone="info" message="Offline — searching your recent foods and common items. Full search is back when you reconnect." />
        )}
      </View>

      {showMyFoods ? (
        <FlatList
          data={customFoods}
          keyExtractor={(f) => f.id}
          contentContainerStyle={styles.listContent}
          ListEmptyComponent={
            <Text style={[theme.type.body, { color: theme.color.text.secondary }]} maxFontSizeMultiplier={2}>
              No custom foods yet. Create one from the search-empty state, or a barcode miss.
            </Text>
          }
          renderItem={({ item }) => (
            <FoodSearchRow
              name={item.name}
              brand={item.brand}
              source="custom"
              dataQuality={null}
              defaultServingLabel={item.defaultServingGOrMl ? `${item.defaultServingGOrMl}` : null}
              energyKcal={item.energyKcal}
              proteinG={item.proteinG}
              carbG={item.carbG}
              fatG={item.fatG}
              onPress={() => openServingSheet(customFoodToPick(item))}
            />
          )}
        />
      ) : !query.trim() ? (
        <View style={styles.emptyWrap}>
          <MeridianMark variant="seed" size={56} />
          <Text style={[theme.type.body, { color: theme.color.text.secondary }]} maxFontSizeMultiplier={2}>
            Search a food, scan a barcode, or start from a saved meal.
          </Text>
        </View>
      ) : noResults ? (
        <View style={styles.listContent}>
          <Text style={[theme.type.body, { color: theme.color.text.secondary }]} maxFontSizeMultiplier={2}>
            No match for &quot;{query}&quot;. Add it as your own food?
          </Text>
          <PrimaryButton label="＋ Add as my own food" onPress={() => router.push({ pathname: '/custom-food', params: { prefillName: query } })} />
        </View>
      ) : (
        <FlatList
          data={results}
          keyExtractor={(item) => item.foodId}
          contentContainerStyle={styles.listContent}
          onEndReached={loadMore}
          onEndReachedThreshold={0.4}
          ListFooterComponent={
            !cursor && results.length > 0 ? (
              <Text style={[theme.type.caption, styles.footerNote, { color: theme.color.text.secondary }]} maxFontSizeMultiplier={2}>
                That&apos;s every match.
              </Text>
            ) : null
          }
          renderItem={({ item }) => (
            <FoodSearchRow
              name={item.name}
              brand={item.brand}
              source={item.source}
              dataQuality={item.dataQuality}
              defaultServingLabel={item.defaultServing?.label ?? null}
              energyKcal={item.energyKcal}
              proteinG={item.proteinG}
              carbG={item.carbG}
              fatG={item.fatG}
              onPress={() => openServingSheet(toFoodPick(item, item.defaultServing ? [item.defaultServing] : []))}
            />
          )}
        />
      )}

      {foodLog.items.length > 0 && (
        <View style={[styles.draftBar, { backgroundColor: theme.color.bg.raised }]}>
          <View>
            <Text style={[theme.type.metricMd, theme.fontVariation.metric, { color: theme.color.text.primary }]} maxFontSizeMultiplier={1.6}>
              {Math.round(foodLog.entry?.totalEnergyKcal ?? 0)} kcal
            </Text>
            <Text style={[theme.type.caption, { color: theme.color.text.secondary }]} maxFontSizeMultiplier={1.8}>
              {foodLog.items.length} item{foodLog.items.length === 1 ? '' : 's'}
            </Text>
          </View>
          <PrimaryButton label={entryId ? 'Save' : 'Save meal'} onPress={() => void handleSaveMeal()} loading={foodLog.saving} />
        </View>
      )}

      <Modal visible={!!pickedFood} transparent animationType="slide" onRequestClose={() => setPickedFood(null)}>
        <View style={[styles.scrim, { backgroundColor: theme.color.bg.overlay }]}>
          <Pressable style={StyleSheet.absoluteFill} onPress={() => setPickedFood(null)} accessibilityRole="button" accessibilityLabel="Dismiss" />
          <SafeAreaView edges={['bottom']} style={styles.sheetWrap}>
            <View style={[styles.sheet, { backgroundColor: theme.color.bg.raised }]} accessibilityViewIsModal accessibilityRole="none">
              {pickedFood && (
                <>
                  <View style={styles.sheetHeaderRow}>
                    <Text style={[theme.type.heading, { color: theme.color.text.primary }]} maxFontSizeMultiplier={1.8}>
                      {pickedFood.name}
                    </Text>
                    <SourceTag source={pickedFood.customFoodId ? 'custom' : (results.find((r) => r.foodId === pickedFood.foodId)?.source ?? 'milelift_authored')} />
                  </View>

                  <DataQualityTag dataQuality={pickedFood.dataQuality} />
                  {pickedFood.dataQuality === 'low' && <DataQualitySheetCaution />}

                  <ServingControl
                    perBasisMacros={pickedFood.basis}
                    servings={pickedFood.servings}
                    selectedServingId={selectedServingId}
                    onSelectServing={setSelectedServingId}
                    quantity={quantity}
                    onChangeQuantity={setQuantity}
                  />

                  <Text style={[theme.type.label, { color: theme.color.text.secondary }]} maxFontSizeMultiplier={1.8}>
                    Meal
                  </Text>
                  <View style={styles.mealTypeRow}>
                    {MEAL_TYPES.map((mt) => (
                      <ChipButton
                        key={mt}
                        label={MEAL_TYPE_LABEL[mt]}
                        selected={foodLog.entry?.mealType === mt}
                        onPress={() => void foodLog.setMealType(mt)}
                      />
                    ))}
                  </View>

                  <PrimaryButton label="Add to meal" onPress={() => void handleAddToMeal()} disabled={!selectedServingId} />
                  <TextButton label="Cancel" onPress={() => setPickedFood(null)} />
                </>
              )}
            </View>
          </SafeAreaView>
        </View>
      </Modal>

      {foodLog.items.length > 0 && (
        <View style={styles.draftItemsPreview}>
          {foodLog.items.map((item) => (
            <FoodLogItemRow key={item.id} item={item} editable onRemove={() => void foodLog.removeItem(item.id)} />
          ))}
        </View>
      )}
    </SafeAreaView>
  );
}

function DataQualitySheetCaution() {
  return (
    <View style={styles.cautionBox}>
      <Text style={[theme.type.bodyStrong, { color: theme.color.text.primary }]} maxFontSizeMultiplier={2}>
        This is community-sourced and may be off — check the calories before you log.
      </Text>
    </View>
  );
}

function ChipButton({ label, selected, onPress }: { label: string; selected: boolean; onPress: () => void }) {
  return (
    <Pressable
      onPress={onPress}
      accessibilityRole="button"
      accessibilityState={{ selected }}
      accessibilityLabel={label}
      style={[styles.chip, { backgroundColor: selected ? theme.color.accent.primary : theme.color.bg.inset }]}
    >
      <Text style={[theme.type.label, { color: selected ? theme.color.text.onAccent : theme.color.text.secondary }]} maxFontSizeMultiplier={1.6}>
        {label}
      </Text>
    </Pressable>
  );
}

const styles = StyleSheet.create({
  safe: { flex: 1, backgroundColor: theme.color.bg.canvas },
  header: { paddingHorizontal: theme.screen.edge, paddingTop: theme.space.md, gap: theme.space.sm },
  headerRow: { flexDirection: 'row', justifyContent: 'space-between', alignItems: 'center' },
  chipRow: { flexDirection: 'row', flexWrap: 'wrap', gap: theme.space.sm, alignItems: 'center' },
  chip: { minHeight: theme.touchTarget.min, borderRadius: theme.radius.pill, paddingHorizontal: theme.space.sm, justifyContent: 'center' },
  listContent: { paddingHorizontal: theme.screen.edge, paddingBottom: theme.space.colossal, gap: theme.space.sm },
  emptyWrap: { alignItems: 'center', gap: theme.space.sm, paddingVertical: theme.space.xxl, paddingHorizontal: theme.screen.edge },
  footerNote: { textAlign: 'center', paddingVertical: theme.space.lg },
  draftBar: {
    flexDirection: 'row',
    justifyContent: 'space-between',
    alignItems: 'center',
    padding: theme.space.md,
    borderTopLeftRadius: theme.radius.lg,
    borderTopRightRadius: theme.radius.lg,
  },
  draftItemsPreview: { paddingHorizontal: theme.screen.edge, paddingBottom: theme.space.md },
  scrim: { flex: 1, justifyContent: 'flex-end' },
  sheetWrap: { width: '100%' },
  sheet: { borderTopLeftRadius: theme.radius.xl, borderTopRightRadius: theme.radius.xl, padding: theme.space.lg, gap: theme.space.md, maxHeight: '85%' },
  sheetHeaderRow: { flexDirection: 'row', justifyContent: 'space-between', alignItems: 'center' },
  mealTypeRow: { flexDirection: 'row', flexWrap: 'wrap', gap: theme.space.xs },
  cautionBox: { backgroundColor: theme.color.feedback.warningTint, borderRadius: theme.radius.md, padding: theme.space.sm },
});
