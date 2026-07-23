import * as Network from 'expo-network';

import { supabase } from '../../lib/supabase';
import { generateUuidV4 } from '../../lib/uuid';
import { foodLogRepository, type ItemRow, type ServerEntryRow } from '../../db/repositories/foodLogRepository';
import { savedMealsRepository } from '../../db/repositories/savedMealsRepository';
import { foodCacheRepository } from '../../db/repositories/foodCacheRepository';
import { customFoodsRepository } from '../../db/repositories/customFoodsRepository';
import { resolveServingMacros } from '../../lib/nutritionMath';
import { runSync } from '../../sync/syncEngine';
import type { LocalSavedMeal } from '../../db/types';

function localDateString(date: Date): string {
  const y = date.getFullYear();
  const m = String(date.getMonth() + 1).padStart(2, '0');
  const d = String(date.getDate()).padStart(2, '0');
  return `${y}-${m}-${d}`;
}

async function isOnline(): Promise<boolean> {
  try {
    const state = await Network.getNetworkStateAsync();
    return !!state.isConnected && state.isInternetReachable !== false;
  } catch {
    return false;
  }
}

type LogSavedMealRpcResponse = {
  data?: { id: string };
  error?: { code: string; message: string; field: string | null };
};

export type LogSavedMealResult =
  | { status: 'logged'; entryId: string }
  | { status: 'needs_connection'; missingFoodName: string }
  | { status: 'error'; message: string };

/** Pulls a single just-logged meal (+ its items) back into the local store, marked already-synced — so Today reflects it immediately without waiting for the next full sync pass. */
async function pullSingleEntry(entryId: string, userId: string): Promise<void> {
  const { data, error } = await supabase.from('food_log_entries').select('*, timeline_events(*)').eq('timeline_event_id', entryId).maybeSingle<Record<string, unknown> & { timeline_events: Record<string, unknown> | Record<string, unknown>[] | null }>();
  if (error || !data) return;
  const te = Array.isArray(data.timeline_events) ? data.timeline_events[0] : data.timeline_events;
  if (!te) return;
  await foodLogRepository.reconcileEntryFromServer({
    id: te.id as string,
    user_id: data.user_id as string,
    meal_type: data.meal_type as string,
    title: data.title as string | null,
    notes: data.notes as string | null,
    occurred_at: te.occurred_at as string,
    local_date: te.local_date as string,
    event_timezone: te.event_timezone as string,
    total_energy_kcal: data.total_energy_kcal as number,
    total_protein_g: data.total_protein_g as number | null,
    total_carb_g: data.total_carb_g as number | null,
    total_fat_g: data.total_fat_g as number | null,
    source: te.source as string,
    visibility: te.visibility as string,
    client_created_at: te.client_created_at as string | null,
    created_at: data.created_at as string,
    updated_at: data.updated_at as string,
    deleted_at: te.deleted_at as string | null,
  } satisfies ServerEntryRow);

  const { data: items } = await supabase.from('food_log_items').select('*').eq('timeline_event_id', entryId).eq('user_id', userId);
  if (items) await foodLogRepository.reconcileItemsFromServer(entryId, items as ItemRow[]);
}

/**
 * CORE-10 "Log it" (design doc §CORE-10 "Log-time behavior" / §Decisions D3).
 * Online: `log_saved_meal_v1` re-resolves current catalog macros
 * server-side (authoritative). Offline: expands the saved meal's items into
 * local `food_log_items` using each item's last-known/cached macros
 * IMMEDIATELY — never blocked, never queued-until-online — via the same
 * offline-first `foodLogRepository` path every other log uses. The one
 * honest exception: an item never yet resolved on this device (no cached
 * macros to expand) surfaces a specific note rather than fabricating a figure.
 */
export async function logSavedMeal(userId: string, savedMeal: LocalSavedMeal): Promise<LogSavedMealResult> {
  const online = await isOnline();

  if (online) {
    const id = generateUuidV4();
    const now = new Date();
    const { data, error } = await supabase.rpc('log_saved_meal_v1', {
      p_id: id,
      p_saved_meal_id: savedMeal.id,
      p_occurred_at: now.toISOString(),
      p_local_date: localDateString(now),
      p_event_timezone: Intl.DateTimeFormat().resolvedOptions().timeZone,
      p_meal_type: savedMeal.mealType,
    });
    if (error) return { status: 'error', message: error.message };
    const body = data as LogSavedMealRpcResponse | null;
    if (body?.error) return { status: 'error', message: `${body.error.code}: ${body.error.message}` };
    if (!body?.data) return { status: 'error', message: 'Empty response from log_saved_meal_v1.' };
    await pullSingleEntry(body.data.id, userId);
    return { status: 'logged', entryId: body.data.id };
  }

  // Offline expansion (§Decisions D3).
  const items = await savedMealsRepository.listItems(savedMeal.id);
  if (items.length === 0) return { status: 'error', message: 'This saved meal has no foods yet.' };

  type Resolved = { name: string; brand: string | null; foodId: string | null; customFoodId: string | null; basis: { energyKcal: number; proteinG: number | null; carbG: number | null; fatG: number | null }; dataQuality: 'high' | 'medium' | 'low' | null };
  const resolved: Resolved[] = [];
  for (const item of items) {
    if (item.foodId) {
      const cached = await foodCacheRepository.getById(item.foodId);
      if (!cached) return { status: 'needs_connection', missingFoodName: item.foodNameSnapshotLocal };
      resolved.push({ name: cached.name, brand: cached.brand, foodId: cached.foodId, customFoodId: null, basis: cached, dataQuality: cached.dataQuality });
    } else if (item.customFoodId) {
      const custom = await customFoodsRepository.getById(item.customFoodId);
      if (!custom) return { status: 'needs_connection', missingFoodName: item.foodNameSnapshotLocal };
      resolved.push({ name: custom.name, brand: custom.brand, foodId: null, customFoodId: custom.id, basis: custom, dataQuality: null });
    } else {
      return { status: 'needs_connection', missingFoodName: item.foodNameSnapshotLocal };
    }
  }

  const entryId = generateUuidV4();
  const now = new Date();
  await foodLogRepository.startDraft(entryId, userId, {
    mealType: savedMeal.mealType ?? 'other',
    occurredAt: now.toISOString(),
    localDate: localDateString(now),
    eventTimezone: Intl.DateTimeFormat().resolvedOptions().timeZone,
    title: savedMeal.name,
  });

  for (let i = 0; i < items.length; i++) {
    const item = items[i]!;
    const source = resolved[i]!;
    const macros = resolveServingMacros(source.basis, item.servingGOrMl, item.quantity);
    await foodLogRepository.upsertItem(generateUuidV4(), entryId, userId, {
      foodId: source.foodId,
      customFoodId: source.customFoodId,
      foodNameSnapshot: source.name,
      brandSnapshot: source.brand,
      servingLabelSnapshot: item.servingLabel,
      quantity: item.quantity,
      servingGOrMlSnapshot: item.servingGOrMl,
      energyKcal: macros.energyKcal,
      proteinG: macros.proteinG,
      carbG: macros.carbG,
      fatG: macros.fatG,
      dataQualitySnapshot: source.dataQuality,
      sortOrder: i,
    });
  }

  await foodLogRepository.commit(entryId);
  void runSync('post-write');
  return { status: 'logged', entryId };
}
