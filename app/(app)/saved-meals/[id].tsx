import React, { useCallback, useEffect, useState } from 'react';
import { FlatList, Modal, Pressable, ScrollView, StyleSheet, Text, View } from 'react-native';
import { router, useLocalSearchParams } from 'expo-router';
import { SafeAreaView } from 'react-native-safe-area-context';

import { theme } from '../../../src/theme';
import { Field } from '../../../src/components/Field';
import { PrimaryButton } from '../../../src/components/PrimaryButton';
import { SecondaryButton } from '../../../src/components/SecondaryButton';
import { TextButton } from '../../../src/components/TextButton';
import { ConfirmSheet } from '../../../src/components/ConfirmSheet';
import { FoodSearchRow } from '../../../src/components/nutrition/FoodSearchRow';
import { ServingControl } from '../../../src/components/nutrition/ServingControl';
import { savedMealsRepository } from '../../../src/db/repositories/savedMealsRepository';
import { generateUuidV4 } from '../../../src/lib/uuid';
import { runSync } from '../../../src/sync/syncEngine';
import { searchFoods, type FoodSearchItem } from '../../../src/lib/foodSearch';
import { useAuth } from '../../../src/state/AuthContext';
import type { FoodServing, LocalSavedMeal, LocalSavedMealItem, MealType } from '../../../src/db/types';

const MEAL_TYPES: MealType[] = ['breakfast', 'lunch', 'dinner', 'snack', 'other'];
const MEAL_TYPE_LABEL: Record<MealType, string> = { breakfast: 'Breakfast', lunch: 'Lunch', dinner: 'Dinner', snack: 'Snack', other: 'Other' };

/** CORE-10 saved-meal builder (design doc §CORE-10). A LIVE plan — macros are explicitly framed as resolving at log time, never shown as if frozen. */
export default function SavedMealBuilderScreen() {
  const { id } = useLocalSearchParams<{ id: string }>();
  const { userId } = useAuth();
  const [meal, setMeal] = useState<LocalSavedMeal | null>(null);
  const [items, setItems] = useState<LocalSavedMealItem[]>([]);
  const [name, setName] = useState('');
  const [description, setDescription] = useState('');
  const [mealType, setMealType] = useState<MealType | null>(null);
  const [showAddFood, setShowAddFood] = useState(false);
  const [showDeleteConfirm, setShowDeleteConfirm] = useState(false);

  const load = useCallback(async () => {
    if (!id) return;
    const m = await savedMealsRepository.getById(id);
    setMeal(m);
    if (m) {
      setName(m.name);
      setDescription(m.description ?? '');
      setMealType(m.mealType);
    }
    setItems(await savedMealsRepository.listItems(id));
  }, [id]);

  useEffect(() => {
    // Synchronizes this saved meal's local state with the SQLite store on
    // mount / id change — the documented legitimate effect pattern (see
    // ProfileContext's own note).
    // eslint-disable-next-line react-hooks/set-state-in-effect
    void load();
  }, [load]);

  const handleSaveMeta = async () => {
    if (!id || !name.trim()) return;
    await savedMealsRepository.update(id, { name: name.trim(), description: description.trim() || null, mealType });
    void runSync('post-write');
    await load();
  };

  const handleRemoveItem = async (itemId: string) => {
    await savedMealsRepository.removeItem(itemId);
    void runSync('post-write');
    await load();
  };

  const handleDelete = async () => {
    if (!id) return;
    await savedMealsRepository.softDelete(id);
    void runSync('post-write');
    router.back();
  };

  if (!meal) {
    return (
      <SafeAreaView style={styles.safe} edges={['top', 'bottom']}>
        <View style={styles.header}>
          <TextButton label="Close" onPress={() => router.back()} />
        </View>
      </SafeAreaView>
    );
  }

  return (
    <SafeAreaView style={styles.safe} edges={['top', 'bottom']}>
      <ScrollView contentContainerStyle={styles.content}>
        <View style={styles.headerRow}>
          <Text style={[theme.type.title, { color: theme.color.text.primary }]} maxFontSizeMultiplier={1.6}>
            Edit saved meal
          </Text>
          <TextButton label="Done" onPress={() => router.back()} />
        </View>

        <Field label="Name" value={name} onChangeText={setName} onBlur={() => void handleSaveMeta()} />
        <Field label="Description (optional)" value={description} onChangeText={setDescription} onBlur={() => void handleSaveMeta()} />

        <Text style={[theme.type.label, { color: theme.color.text.secondary }]} maxFontSizeMultiplier={1.8}>
          Default meal type
        </Text>
        <View style={styles.mealTypeRow}>
          {MEAL_TYPES.map((mt) => (
            <ChipButton
              key={mt}
              label={MEAL_TYPE_LABEL[mt]}
              selected={mealType === mt}
              onPress={async () => {
                setMealType(mt);
                await savedMealsRepository.update(id, { name: name.trim() || meal.name, description: description.trim() || null, mealType: mt });
                void runSync('post-write');
              }}
            />
          ))}
        </View>

        <Text style={[theme.type.body, { color: theme.color.text.secondary }]} maxFontSizeMultiplier={2}>
          Macros update from the latest food data each time you log this — so a corrected food improves every future log.
        </Text>

        <View style={styles.itemsSection}>
          {items.map((item) => (
            <View key={item.id} style={styles.itemRow}>
              <View style={styles.itemTextCol}>
                <Text style={[theme.type.body, { color: theme.color.text.primary }]} maxFontSizeMultiplier={1.8}>
                  {item.foodNameSnapshotLocal}
                </Text>
                <Text style={[theme.type.caption, { color: theme.color.text.secondary }]} maxFontSizeMultiplier={1.8}>
                  {item.servingLabel} × {item.quantity}
                </Text>
              </View>
              <TextButton label="Remove" danger onPress={() => void handleRemoveItem(item.id)} />
            </View>
          ))}
        </View>

        <SecondaryButton label="＋ Add food" onPress={() => setShowAddFood(true)} />
        <TextButton label="Delete this saved meal" danger onPress={() => setShowDeleteConfirm(true)} />
      </ScrollView>

      <AddFoodModal visible={showAddFood} savedMealId={id} userId={userId ?? ''} itemCount={items.length} onClose={() => setShowAddFood(false)} onAdded={load} />

      <ConfirmSheet
        visible={showDeleteConfirm}
        title="Delete this saved meal?"
        body="Meals you've already logged from it stay in your history."
        confirmLabel="Delete saved meal"
        onConfirm={() => void handleDelete()}
        onCancel={() => setShowDeleteConfirm(false)}
      />
    </SafeAreaView>
  );
}

function AddFoodModal({
  visible,
  savedMealId,
  userId,
  itemCount,
  onClose,
  onAdded,
}: {
  visible: boolean;
  savedMealId: string;
  userId: string;
  itemCount: number;
  onClose: () => void;
  onAdded: () => void;
}) {
  const [query, setQuery] = useState('');
  const [results, setResults] = useState<FoodSearchItem[]>([]);
  const [picked, setPicked] = useState<{ item: FoodSearchItem; servings: FoodServing[] } | null>(null);
  const [selectedServingId, setSelectedServingId] = useState<string | null>(null);
  const [quantity, setQuantity] = useState(1);

  useEffect(() => {
    // Debounced search-as-you-type, resetting results whenever the query
    // changes — the same legitimate "derive from input" pattern
    // exercises.tsx's own search effect uses.
    if (!query.trim()) {
      // eslint-disable-next-line react-hooks/set-state-in-effect
      setResults([]);
      return;
    }
    const timer = setTimeout(() => {
      void searchFoods(query, null).then((page) => setResults(page.items));
    }, 300);
    return () => clearTimeout(timer);
  }, [query]);

  const handleAdd = async () => {
    if (!picked || !selectedServingId) return;
    const serving = picked.servings.find((s) => s.id === selectedServingId) ?? picked.servings[0];
    if (!serving) return;
    await savedMealsRepository.upsertItem(generateUuidV4(), savedMealId, userId, {
      foodId: picked.item.foodId,
      customFoodId: null,
      foodNameSnapshotLocal: picked.item.name,
      servingLabel: serving.label,
      servingGOrMl: serving.gramOrMlWeight,
      quantity,
      sortOrder: itemCount,
    });
    void runSync('post-write');
    setPicked(null);
    setQuery('');
    onAdded();
    onClose();
  };

  return (
    <Modal visible={visible} transparent animationType="slide" onRequestClose={onClose}>
      <View style={[styles.scrim, { backgroundColor: theme.color.bg.overlay }]}>
        <Pressable style={StyleSheet.absoluteFill} onPress={onClose} accessibilityRole="button" accessibilityLabel="Dismiss" />
        <SafeAreaView edges={['bottom']} style={styles.sheetWrap}>
          <View style={[styles.sheet, { backgroundColor: theme.color.bg.raised }]} accessibilityViewIsModal accessibilityRole="none">
            {picked ? (
              <>
                <Text style={[theme.type.heading, { color: theme.color.text.primary }]} maxFontSizeMultiplier={1.8}>
                  {picked.item.name}
                </Text>
                <ServingControl
                  perBasisMacros={picked.item}
                  servings={picked.servings}
                  selectedServingId={selectedServingId}
                  onSelectServing={setSelectedServingId}
                  quantity={quantity}
                  onChangeQuantity={setQuantity}
                />
                <PrimaryButton label="Add to saved meal" onPress={() => void handleAdd()} disabled={!selectedServingId} />
                <TextButton label="Back" onPress={() => setPicked(null)} />
              </>
            ) : (
              <>
                <Field label="Search" value={query} onChangeText={setQuery} placeholder="Search foods" />
                <FlatList
                  data={results}
                  keyExtractor={(i) => i.foodId}
                  style={styles.addFoodList}
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
                      onPress={() => {
                        setPicked({ item, servings: item.defaultServing ? [item.defaultServing] : [] });
                        setSelectedServingId(item.defaultServing?.id ?? null);
                        setQuantity(1);
                      }}
                    />
                  )}
                />
                <TextButton label="Cancel" onPress={onClose} />
              </>
            )}
          </View>
        </SafeAreaView>
      </View>
    </Modal>
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
  header: { paddingHorizontal: theme.screen.edge, paddingTop: theme.space.md },
  content: { padding: theme.screen.edge, gap: theme.space.md, paddingBottom: theme.space.colossal },
  headerRow: { flexDirection: 'row', justifyContent: 'space-between', alignItems: 'center' },
  mealTypeRow: { flexDirection: 'row', flexWrap: 'wrap', gap: theme.space.xs },
  chip: { minHeight: theme.touchTarget.min, borderRadius: theme.radius.pill, paddingHorizontal: theme.space.sm, justifyContent: 'center' },
  itemsSection: { gap: theme.space.xs },
  itemRow: { flexDirection: 'row', justifyContent: 'space-between', alignItems: 'center', minHeight: theme.touchTarget.min },
  itemTextCol: { gap: 2 },
  scrim: { flex: 1, justifyContent: 'flex-end' },
  sheetWrap: { width: '100%' },
  sheet: { borderTopLeftRadius: theme.radius.xl, borderTopRightRadius: theme.radius.xl, padding: theme.space.lg, gap: theme.space.md, maxHeight: '85%' },
  addFoodList: { maxHeight: 320 },
});
