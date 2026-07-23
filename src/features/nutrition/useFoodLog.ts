import { useCallback, useEffect, useState } from 'react';

import { generateUuidV4 } from '../../lib/uuid';
import { foodLogRepository, type ItemWriteFields } from '../../db/repositories/foodLogRepository';
import { foodCacheRepository } from '../../db/repositories/foodCacheRepository';
import { resolveServingMacros } from '../../lib/nutritionMath';
import { runSync } from '../../sync/syncEngine';
import type { FoodDataQuality, FoodServing, LocalFoodLogEntry, LocalFoodLogItem, MealType } from '../../db/types';

export type FoodPick = {
  foodId: string | null;
  customFoodId: string | null;
  name: string;
  brand: string | null;
  basis: { energyKcal: number; proteinG: number | null; carbG: number | null; fatG: number | null };
  servings: FoodServing[];
  dataQuality: FoodDataQuality | null;
};

function localDateString(date: Date): string {
  const y = date.getFullYear();
  const m = String(date.getMonth() + 1).padStart(2, '0');
  const d = String(date.getDate()).padStart(2, '0');
  return `${y}-${m}-${d}`;
}

function defaultMealTypeForNow(): MealType {
  const hour = new Date().getHours();
  if (hour < 11) return 'breakfast';
  if (hour < 16) return 'lunch';
  if (hour < 21) return 'dinner';
  return 'snack';
}

/**
 * CORE-06 meal-builder engine — the "draft meal tray" (design doc §CORE-06):
 * items accrete locally as the user adds foods from search/scan/saved, a
 * running total updates live, and "Save meal"/"Log food" commits the whole
 * thing in one `save_food_log_entry_v1` push. Mirrors `useWorkoutEngine`'s
 * "in-progress local domain state, durable across a crash, never blocked on
 * network at commit" shape.
 */
export function useFoodLog(params: { userId: string }) {
  const { userId } = params;
  const [entry, setEntry] = useState<LocalFoodLogEntry | null>(null);
  const [items, setItems] = useState<LocalFoodLogItem[]>([]);
  const [saving, setSaving] = useState(false);

  const refreshItems = useCallback(async (entryId: string) => {
    setItems(await foodLogRepository.getItemsForEntry(entryId));
    setEntry(await foodLogRepository.getEntry(entryId));
  }, []);

  const ensureDraft = useCallback(
    async (mealType?: MealType): Promise<LocalFoodLogEntry> => {
      if (entry) return entry;
      const id = generateUuidV4();
      const now = new Date();
      const created = await foodLogRepository.startDraft(id, userId, {
        mealType: mealType ?? defaultMealTypeForNow(),
        occurredAt: now.toISOString(),
        localDate: localDateString(now),
        eventTimezone: Intl.DateTimeFormat().resolvedOptions().timeZone,
      });
      setEntry(created);
      setItems([]);
      return created;
    },
    [entry, userId]
  );

  /** Loads an already-committed meal for "＋ Add food" incremental append (design doc CORE-06). */
  const loadExisting = useCallback(
    async (entryId: string): Promise<boolean> => {
      const existing = await foodLogRepository.getEntry(entryId);
      if (!existing) return false;
      setEntry(existing);
      await refreshItems(entryId);
      return true;
    },
    [refreshItems]
  );

  const setMealType = useCallback(
    async (mealType: MealType) => {
      if (!entry) return;
      await foodLogRepository.updateMeta(entry.id, { mealType });
      setEntry(await foodLogRepository.getEntry(entry.id));
    },
    [entry]
  );

  /** Adds one food at the chosen serving/quantity — the fast Log-sheet path AND the meal-builder's "Add" action are the same call. */
  const addItem = useCallback(
    async (pick: FoodPick, servingId: string, quantity: number): Promise<void> => {
      const draft = await ensureDraft();
      const serving = pick.servings.find((s) => s.id === servingId) ?? pick.servings[0];
      if (!serving) return;
      const resolved = resolveServingMacros(pick.basis, serving.gramOrMlWeight, quantity);
      const currentItems = await foodLogRepository.getItemsForEntry(draft.id);
      const fields: ItemWriteFields = {
        foodId: pick.foodId,
        customFoodId: pick.customFoodId,
        foodNameSnapshot: pick.name,
        brandSnapshot: pick.brand,
        servingLabelSnapshot: serving.label,
        quantity,
        servingGOrMlSnapshot: serving.gramOrMlWeight,
        energyKcal: resolved.energyKcal,
        proteinG: resolved.proteinG,
        carbG: resolved.carbG,
        fatG: resolved.fatG,
        dataQualitySnapshot: pick.dataQuality,
        sortOrder: currentItems.length,
      };
      await foodLogRepository.upsertItem(generateUuidV4(), draft.id, userId, fields);
      if (pick.foodId) await foodCacheRepository.markUsed(pick.foodId);
      await refreshItems(draft.id);
    },
    [ensureDraft, refreshItems, userId]
  );

  const updateItemQuantity = useCallback(
    async (itemId: string, quantity: number): Promise<void> => {
      if (!entry) return;
      const current = items.find((i) => i.id === itemId);
      if (!current) return;
      const ratio = quantity / current.quantity;
      await foodLogRepository.upsertItem(itemId, entry.id, userId, {
        foodId: current.foodId,
        customFoodId: current.customFoodId,
        foodNameSnapshot: current.foodNameSnapshot,
        brandSnapshot: current.brandSnapshot,
        servingLabelSnapshot: current.servingLabelSnapshot,
        quantity,
        servingGOrMlSnapshot: current.servingGOrMlSnapshot,
        energyKcal: current.energyKcal * ratio,
        proteinG: current.proteinG != null ? current.proteinG * ratio : null,
        carbG: current.carbG != null ? current.carbG * ratio : null,
        fatG: current.fatG != null ? current.fatG * ratio : null,
        dataQualitySnapshot: current.dataQualitySnapshot,
        sortOrder: current.sortOrder,
      });
      await refreshItems(entry.id);
    },
    [entry, items, userId, refreshItems]
  );

  const removeItem = useCallback(
    async (itemId: string) => {
      await foodLogRepository.removeItem(itemId);
      if (entry) await refreshItems(entry.id);
    },
    [entry, refreshItems]
  );

  /** Discard a draft never saved (user backs out) — hard-delete, nothing was ever queued. */
  const discardDraft = useCallback(async () => {
    if (!entry) return;
    await foodLogRepository.discardDraft(entry.id);
    setEntry(null);
    setItems([]);
  }, [entry]);

  /** "Save the whole meal" / "Log food" (design doc CORE-06) — never blocked on network (offline-first, §9). */
  const commit = useCallback(async (): Promise<string> => {
    if (!entry) throw new Error('No draft meal to save.');
    setSaving(true);
    try {
      const committed = await foodLogRepository.commit(entry.id);
      setEntry(committed);
      void runSync('post-write');
      return committed.id;
    } finally {
      setSaving(false);
    }
  }, [entry]);

  useEffect(() => {
    // Resets local hook state whenever the caller unmounts/remounts against
    // a different draft — a normal cleanup, not a React-Compiler hazard.
    return () => {
      setEntry(null);
      setItems([]);
    };
  }, []);

  return {
    entry,
    items,
    saving,
    ensureDraft,
    loadExisting,
    setMealType,
    addItem,
    updateItemQuantity,
    removeItem,
    discardDraft,
    commit,
  };
}
