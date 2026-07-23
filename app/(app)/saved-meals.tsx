import React, { useCallback, useEffect, useState } from 'react';
import { FlatList, StyleSheet, Text, View } from 'react-native';
import { router } from 'expo-router';
import { SafeAreaView } from 'react-native-safe-area-context';

import { theme } from '../../src/theme';
import { TextButton } from '../../src/components/TextButton';
import { PrimaryButton } from '../../src/components/PrimaryButton';
import { EmptyState } from '../../src/components/EmptyState';
import { SkeletonBlock } from '../../src/components/SkeletonBlock';
import { InlineBanner } from '../../src/components/InlineBanner';
import { SyncStatusPill } from '../../src/components/SyncStatusPill';
import { savedMealsRepository } from '../../src/db/repositories/savedMealsRepository';
import { generateUuidV4 } from '../../src/lib/uuid';
import { useAuth } from '../../src/state/AuthContext';
import { logSavedMeal } from '../../src/features/nutrition/savedMealLogging';
import { runSync } from '../../src/sync/syncEngine';
import type { LocalSavedMeal } from '../../src/db/types';

/** CORE-10 saved meals landing — browse + log-in-one-action (design doc §CORE-10). */
export default function SavedMealsScreen() {
  const { userId } = useAuth();
  const [loading, setLoading] = useState(true);
  const [meals, setMeals] = useState<LocalSavedMeal[]>([]);
  const [itemCounts, setItemCounts] = useState<Map<string, number>>(new Map());
  const [loggingId, setLoggingId] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);

  const load = useCallback(async () => {
    if (!userId) return;
    setLoading(true);
    const rows = await savedMealsRepository.listForUser(userId);
    setMeals(rows);
    const counts = new Map<string, number>();
    for (const meal of rows) counts.set(meal.id, (await savedMealsRepository.listItems(meal.id)).length);
    setItemCounts(counts);
    setLoading(false);
  }, [userId]);

  useEffect(() => {
    // Synchronizes the saved-meals list with the SQLite store on mount /
    // user change — the documented legitimate effect pattern (see
    // ProfileContext's own note).
    // eslint-disable-next-line react-hooks/set-state-in-effect
    void load();
  }, [load]);

  const handleCreate = async () => {
    if (!userId) return;
    const id = generateUuidV4();
    await savedMealsRepository.create(id, userId, { name: 'New saved meal', description: null, mealType: null });
    void runSync('post-write');
    router.push({ pathname: '/saved-meals/[id]', params: { id } });
  };

  const handleLogIt = async (meal: LocalSavedMeal) => {
    if (!userId) return;
    setLoggingId(meal.id);
    setNotice(null);
    try {
      const result = await logSavedMeal(userId, meal);
      if (result.status === 'logged') {
        setNotice('Meal logged.');
        router.push({ pathname: '/food/meal/[id]', params: { id: result.entryId } });
      } else if (result.status === 'needs_connection') {
        setNotice(`One food here hasn't loaded on this device yet — connect once to log this meal (${result.missingFoodName}).`);
      } else {
        setNotice(result.message);
      }
    } finally {
      setLoggingId(null);
    }
  };

  return (
    <SafeAreaView style={styles.safe} edges={['top', 'bottom']}>
      <View style={styles.header}>
        <Text style={[theme.type.title, { color: theme.color.text.primary }]} maxFontSizeMultiplier={1.6}>
          Saved meals
        </Text>
        <TextButton label="Close" onPress={() => router.back()} />
      </View>

      {notice && <View style={styles.noticeWrap}><InlineBanner tone="info" message={notice} /></View>}

      {loading ? (
        <View style={styles.listContent}>
          <SkeletonBlock height={72} radius={theme.radius.md} />
          <SkeletonBlock height={72} radius={theme.radius.md} />
        </View>
      ) : meals.length === 0 ? (
        <EmptyState title="Build a meal once, log it in one tap forever after." actionLabel="＋ New saved meal" onAction={() => void handleCreate()} />
      ) : (
        <FlatList
          data={meals}
          keyExtractor={(m) => m.id}
          contentContainerStyle={styles.listContent}
          ListHeaderComponent={<PrimaryButton label="＋ New saved meal" onPress={() => void handleCreate()} />}
          renderItem={({ item }) => (
            <View style={[styles.row, { backgroundColor: theme.color.bg.raised }]}>
              <TextButton label={`${item.name} — ${itemCounts.get(item.id) ?? 0} food${(itemCounts.get(item.id) ?? 0) === 1 ? '' : 's'}`} onPress={() => router.push({ pathname: '/saved-meals/[id]', params: { id: item.id } })} />
              {item.syncStatus !== 'synced' && <SyncStatusPill status={item.syncStatus} />}
              <PrimaryButton label="Log it" onPress={() => void handleLogIt(item)} loading={loggingId === item.id} />
            </View>
          )}
        />
      )}
    </SafeAreaView>
  );
}

const styles = StyleSheet.create({
  safe: { flex: 1, backgroundColor: theme.color.bg.canvas },
  header: { flexDirection: 'row', justifyContent: 'space-between', alignItems: 'center', paddingHorizontal: theme.screen.edge, paddingTop: theme.space.md },
  noticeWrap: { paddingHorizontal: theme.screen.edge, paddingTop: theme.space.sm },
  listContent: { padding: theme.screen.edge, gap: theme.space.sm, paddingBottom: theme.space.colossal },
  row: { borderRadius: theme.radius.lg, padding: theme.space.md, gap: theme.space.xs },
});
