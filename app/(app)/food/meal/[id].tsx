import React, { useCallback, useEffect, useState } from 'react';
import { ScrollView, StyleSheet, Text, View } from 'react-native';
import { router, useLocalSearchParams } from 'expo-router';
import { SafeAreaView } from 'react-native-safe-area-context';

import { theme } from '../../../../src/theme';
import { TextButton } from '../../../../src/components/TextButton';
import { ConfirmSheet } from '../../../../src/components/ConfirmSheet';
import { SyncStatusPill } from '../../../../src/components/SyncStatusPill';
import { FoodLogItemRow } from '../../../../src/components/nutrition/FoodLogItemRow';
import { foodLogRepository } from '../../../../src/db/repositories/foodLogRepository';
import { runSync } from '../../../../src/sync/syncEngine';
import type { LocalFoodLogEntry, LocalFoodLogItem, MealType } from '../../../../src/db/types';

const MEAL_TYPE_LABEL: Record<MealType, string> = { breakfast: 'Breakfast', lunch: 'Lunch', dinner: 'Dinner', snack: 'Snack', other: 'Other' };

/** CORE-06 meal detail/edit — a normal editable timeline event (AI-11's self-correcting-log substrate). */
export default function MealDetailScreen() {
  const { id } = useLocalSearchParams<{ id: string }>();
  const [entry, setEntry] = useState<LocalFoodLogEntry | null>(null);
  const [items, setItems] = useState<LocalFoodLogItem[]>([]);
  const [showDeleteConfirm, setShowDeleteConfirm] = useState(false);
  const [deleting, setDeleting] = useState(false);

  const load = useCallback(async () => {
    if (!id) return;
    setEntry(await foodLogRepository.getEntry(id));
    setItems(await foodLogRepository.getItemsForEntry(id));
  }, [id]);

  useEffect(() => {
    // Synchronizes this meal's local state with the SQLite store on mount /
    // id change — the documented legitimate effect pattern (see
    // ProfileContext's own note).
    // eslint-disable-next-line react-hooks/set-state-in-effect
    void load();
  }, [load]);

  const handleRemoveItem = async (itemId: string) => {
    await foodLogRepository.removeItem(itemId);
    void runSync('post-write');
    await load();
  };

  const handleDelete = async () => {
    if (!id) return;
    setDeleting(true);
    try {
      await foodLogRepository.softDelete(id);
      void runSync('post-write');
      router.back();
    } finally {
      setDeleting(false);
    }
  };

  if (!entry) {
    return (
      <SafeAreaView style={styles.safe} edges={['top', 'bottom']}>
        <View style={styles.header}>
          <TextButton label="Close" onPress={() => router.back()} />
        </View>
      </SafeAreaView>
    );
  }

  const time = new Date(entry.occurredAt).toLocaleTimeString(undefined, { hour: 'numeric', minute: '2-digit' });

  return (
    <SafeAreaView style={styles.safe} edges={['top', 'bottom']}>
      <ScrollView contentContainerStyle={styles.content}>
        <View style={styles.headerRow}>
          <View>
            <Text style={[theme.type.title, { color: theme.color.text.primary }]} maxFontSizeMultiplier={1.6}>
              {entry.title || MEAL_TYPE_LABEL[entry.mealType]}
            </Text>
            <Text style={[theme.type.caption, { color: theme.color.text.secondary }]} maxFontSizeMultiplier={2}>
              {MEAL_TYPE_LABEL[entry.mealType]} · {time}
            </Text>
          </View>
          <TextButton label="Close" onPress={() => router.back()} />
        </View>

        {entry.syncStatus !== 'synced' && <SyncStatusPill status={entry.syncStatus} onRetry={() => void runSync('manual')} />}

        <View style={styles.totalsRow}>
          <Text style={[theme.type.metricLg, theme.fontVariation.metric, { color: theme.color.text.primary }]} maxFontSizeMultiplier={1.4}>
            {Math.round(entry.totalEnergyKcal)} kcal
          </Text>
          <Text style={[theme.type.caption, { color: theme.color.text.secondary }]} maxFontSizeMultiplier={2}>
            {entry.totalProteinG != null ? `P ${Math.round(entry.totalProteinG)}g` : ''}
            {entry.totalCarbG != null ? ` · C ${Math.round(entry.totalCarbG)}g` : ''}
            {entry.totalFatG != null ? ` · F ${Math.round(entry.totalFatG)}g` : ''}
          </Text>
        </View>

        <View style={styles.itemsSection}>
          {items.map((item) => (
            <FoodLogItemRow key={item.id} item={item} editable onRemove={() => void handleRemoveItem(item.id)} />
          ))}
        </View>

        <TextButton label="＋ Add food" onPress={() => router.push({ pathname: '/food/log', params: { entryId: entry.id } })} />
        <TextButton label="Delete this meal" danger onPress={() => setShowDeleteConfirm(true)} />
      </ScrollView>

      <ConfirmSheet
        visible={showDeleteConfirm}
        title="Delete this meal?"
        body="This removes it from your food log and today's totals. This can't be undone."
        confirmLabel="Delete meal"
        loading={deleting}
        onConfirm={() => void handleDelete()}
        onCancel={() => setShowDeleteConfirm(false)}
      />
    </SafeAreaView>
  );
}

const styles = StyleSheet.create({
  safe: { flex: 1, backgroundColor: theme.color.bg.canvas },
  header: { paddingHorizontal: theme.screen.edge, paddingTop: theme.space.md },
  content: { padding: theme.screen.edge, gap: theme.space.md, paddingBottom: theme.space.colossal },
  headerRow: { flexDirection: 'row', justifyContent: 'space-between', alignItems: 'flex-start' },
  totalsRow: { gap: 2 },
  itemsSection: { gap: theme.space.xs },
});
