import { supabase } from '../lib/supabase';
import { foodLogRepository, type ItemRow, type ServerEntryRow } from '../db/repositories/foodLogRepository';
import { customFoodsRepository } from '../db/repositories/customFoodsRepository';
import { waterIntakeRepository, type ServerWaterRow } from '../db/repositories/waterIntakeRepository';
import { manualBurnRepository, type ServerManualBurnRow } from '../db/repositories/manualBurnRepository';
import { savedMealsRepository, type ItemRow as SavedMealItemRow, type MealRow as SavedMealRow } from '../db/repositories/savedMealsRepository';
import { syncCursorRepository } from '../db/repositories/syncCursorRepository';
import { foodCacheRepository } from '../db/repositories/foodCacheRepository';
import type { LocalFoodLogEntry, OverlapAdvisory, OverlapAdvisoryEvent } from '../db/types';

/**
 * Push/pull for Phase 3 — Module B (nutrition & food logging). Wired into
 * `src/sync/syncEngine.ts`'s `runSync`, same opportunistic triggers as every
 * prior phase (mobile-architecture-standards: "sync opportunistically").
 *
 * ***Read this before touching any write in this file*** (task brief — this
 * exact bug class has broken sync FOUR TIMES across three phases):
 * `.upsert()` is unsafe against EVERY table this file writes
 * (`custom_foods`, `food_log_entries`, `food_log_items`, `water_intake_logs`,
 * `manual_calorie_burn_logs`, `saved_meals`, `saved_meal_items`) — not just
 * when the payload includes extra columns, but categorically, because
 * PostgREST's generated `ON CONFLICT DO UPDATE SET` always includes the
 * conflict-target column (`id`/`timeline_event_id`) once a payload targets
 * an existing row, and that identity column has no UPDATE grant. The only
 * safe patterns: `.insert()` for new rows, `.update().eq('id', x)` for
 * edits, or (preferred, and used for every meal/water/burn write below) the
 * transactional save RPC, which internally restricts its own `ON CONFLICT
 * SET` list to the documented mutable-column set (§8.1).
 */

const FOOD_LOG_CURSOR_KEY = 'food_log_entries_updated_at';

type SaveFoodLogEntryRpcResponse = {
  data?: {
    id: string;
    occurred_at: string;
    local_date: string;
    meal_type: string;
    total_energy_kcal: number;
    total_protein_g: number | null;
    total_carb_g: number | null;
    total_fat_g: number | null;
    item_count: number;
  };
  error?: { code: string; message: string; field: string | null };
};

type SaveWaterIntakeRpcResponse = {
  data?: { id: string };
  error?: { code: string; message: string; field: string | null };
};

type RawOverlapAdvisory = {
  has_overlap: boolean;
  overlapping_events: { timeline_event_id: string; event_type: string; occurred_at: string; duration_seconds: number | null; energy_kcal: number | null }[];
};

type SaveManualBurnRpcResponse = {
  data?: {
    id: string;
    overlap_advisory: RawOverlapAdvisory;
  };
  error?: { code: string; message: string; field: string | null };
};

function toOverlapAdvisory(raw: RawOverlapAdvisory): OverlapAdvisory {
  const events: OverlapAdvisoryEvent[] = raw.overlapping_events.map((e) => ({
    timelineEventId: e.timeline_event_id,
    eventType: e.event_type,
    occurredAt: e.occurred_at,
    durationSeconds: e.duration_seconds,
    energyKcal: e.energy_kcal,
  }));
  return { hasOverlap: raw.has_overlap, overlappingEvents: events };
}

// ---------------------------------------------------------------------------
// Custom foods (mirrors pushCustomExercises' insert-then-update pattern —
// custom_foods' UPDATE grant excludes id/user_id/created_at, §8.1).
// ---------------------------------------------------------------------------

export async function pushCustomFoods(userId: string): Promise<void> {
  const unsynced = await customFoodsRepository.getUnsynced(userId);
  for (const food of unsynced) {
    if (food.deletedAt && !food.serverConfirmed) {
      await customFoodsRepository.purgeLocalOnly(food.id);
      continue;
    }
    if (!food.serverConfirmed) {
      const { error } = await supabase.from('custom_foods').insert({
        id: food.id,
        user_id: food.userId,
        barcode: food.barcode,
        name: food.name,
        brand: food.brand,
        basis: food.basis,
        energy_kcal: food.energyKcal,
        protein_g: food.proteinG,
        carb_g: food.carbG,
        fat_g: food.fatG,
        default_serving_g_or_ml: food.defaultServingGOrMl,
        notes: food.notes,
        deleted_at: food.deletedAt,
      });
      // 23505 = unique_violation: a retried push after a prior call that
      // committed but whose response never arrived — treat as already-created.
      if (error && error.code !== '23505') {
        await customFoodsRepository.markFailed(food.id, error.message);
        continue;
      }
      await customFoodsRepository.markSynced(food.id);
    } else {
      const { error } = await supabase
        .from('custom_foods')
        .update({
          barcode: food.barcode,
          name: food.name,
          brand: food.brand,
          basis: food.basis,
          energy_kcal: food.energyKcal,
          protein_g: food.proteinG,
          carb_g: food.carbG,
          fat_g: food.fatG,
          default_serving_g_or_ml: food.defaultServingGOrMl,
          notes: food.notes,
          deleted_at: food.deletedAt,
        })
        .eq('id', food.id);
      if (error) {
        await customFoodsRepository.markFailed(food.id, error.message);
      } else {
        await customFoodsRepository.markSynced(food.id);
      }
    }
  }
}

export async function pullCustomFoods(userId: string): Promise<void> {
  const { data, error } = await supabase.from('custom_foods').select('*').eq('user_id', userId);
  if (error || !data) return;
  await customFoodsRepository.reconcileFromServer(data);
}

// ---------------------------------------------------------------------------
// Meals (food_log_entries + food_log_items) — the CORE-06 gate-critical
// pair. The write path is `save_food_log_entry_v1`, never a raw table
// upsert (architecture §5/§8.1's own explicit recommendation) — it does the
// multi-table transaction (spine + entry + N items) a bare client call
// can't, and its `ON CONFLICT SET` list is already restricted to the
// documented mutable-column set on both tables.
// ---------------------------------------------------------------------------

export async function pushFoodLogEntries(userId: string): Promise<void> {
  const unsynced = await foodLogRepository.getUnsynced(userId);
  // Sequential, never parallel — mirrors pushWorkoutSessions' §2.6 discipline
  // (retries of the same meal id must never race each other).
  for (const entry of unsynced) {
    if (entry.deletedAt) {
      await pushMealTombstone(entry);
    } else {
      await pushMealSave(entry);
    }
  }
}

async function pushMealTombstone(entry: LocalFoodLogEntry): Promise<void> {
  const wasConfirmed = await foodLogRepository.wasServerConfirmed(entry.id);
  if (!wasConfirmed) {
    await foodLogRepository.purgeLocalOnly(entry.id);
    return;
  }
  const { error } = await supabase.from('timeline_events').update({ deleted_at: entry.deletedAt }).eq('id', entry.id);
  if (error) {
    await foodLogRepository.markFailed(entry.id, error.message);
    return;
  }
  await foodLogRepository.markDeleteSynced(entry.id);
}

async function pushMealSave(entry: LocalFoodLogEntry): Promise<void> {
  const dirtyItems = await foodLogRepository.getDirtyItems(entry.id);

  const pItems = dirtyItems.map((item) => ({
    id: item.id,
    food_id: item.foodId,
    custom_food_id: item.customFoodId,
    food_name_snapshot: item.foodNameSnapshot,
    brand_snapshot: item.brandSnapshot,
    serving_label_snapshot: item.servingLabelSnapshot,
    quantity: item.quantity,
    serving_g_or_ml_snapshot: item.servingGOrMlSnapshot,
    energy_kcal: item.energyKcal,
    protein_g: item.proteinG,
    carb_g: item.carbG,
    fat_g: item.fatG,
    data_quality_snapshot: item.dataQualitySnapshot,
    sort_order: item.sortOrder,
    deleted_at: item.deletedAt,
  }));

  const { data, error } = await supabase.rpc('save_food_log_entry_v1', {
    p_id: entry.id,
    p_occurred_at: entry.occurredAt,
    p_local_date: entry.localDate,
    p_event_timezone: entry.eventTimezone,
    p_meal_type: entry.mealType,
    p_items: pItems,
    p_source: entry.source,
    p_visibility: entry.visibility,
    p_title: entry.title,
    p_notes: entry.notes,
    p_client_created_at: entry.clientCreatedAt,
  });

  if (error) {
    // Transport-level failure — the meal and every item stay exactly as they
    // are locally; nothing is marked synced.
    await foodLogRepository.markFailed(entry.id, error.message);
    return;
  }

  const body = data as SaveFoodLogEntryRpcResponse | null;
  if (body?.error) {
    await foodLogRepository.markFailed(entry.id, `${body.error.code}: ${body.error.message}`);
    return;
  }
  const result = body?.data;
  if (!result) {
    await foodLogRepository.markFailed(entry.id, 'Empty response from save_food_log_entry_v1.');
    return;
  }

  await foodLogRepository.markSyncedWithServerTotals(
    entry.id,
    {
      totalEnergyKcal: result.total_energy_kcal,
      totalProteinG: result.total_protein_g,
      totalCarbG: result.total_carb_g,
      totalFatG: result.total_fat_g,
    },
    dirtyItems.map((i) => ({ id: i.id, updatedAt: i.updatedAt }))
  );
}

export async function pullFoodLogEntries(userId: string): Promise<void> {
  const cursor = (await syncCursorRepository.get(userId, FOOD_LOG_CURSOR_KEY)) ?? '1970-01-01T00:00:00.000Z';

  const { data, error } = await supabase
    .from('food_log_entries')
    .select('*, timeline_events(*)')
    .eq('user_id', userId)
    .gt('updated_at', cursor)
    .order('updated_at', { ascending: true })
    .limit(200);

  if (error || !data) return;

  type EmbeddedRow = Record<string, unknown> & { timeline_events: Record<string, unknown> | Record<string, unknown>[] | null };

  const rows = (data as EmbeddedRow[])
    .map((row) => {
      const te = Array.isArray(row.timeline_events) ? row.timeline_events[0] : row.timeline_events;
      if (!te) return null;
      return {
        id: te.id,
        user_id: row.user_id,
        meal_type: row.meal_type,
        title: row.title,
        notes: row.notes,
        occurred_at: te.occurred_at,
        local_date: te.local_date,
        event_timezone: te.event_timezone,
        total_energy_kcal: row.total_energy_kcal,
        total_protein_g: row.total_protein_g,
        total_carb_g: row.total_carb_g,
        total_fat_g: row.total_fat_g,
        source: te.source,
        visibility: te.visibility,
        client_created_at: te.client_created_at,
        created_at: row.created_at,
        updated_at: row.updated_at,
        deleted_at: te.deleted_at,
      };
    })
    .filter((r): r is NonNullable<typeof r> => r !== null);

  let lastUpdatedAt: string | null = null;
  for (const row of rows) {
    await foodLogRepository.reconcileEntryFromServer(row as unknown as ServerEntryRow);
    if (typeof row.updated_at === 'string') lastUpdatedAt = row.updated_at;
    await pullItemsForEntry(row.id as string, row.user_id as string);
  }
  if (lastUpdatedAt) await syncCursorRepository.set(userId, FOOD_LOG_CURSOR_KEY, lastUpdatedAt);
}

async function pullItemsForEntry(timelineEventId: string, userId: string): Promise<void> {
  const { data, error } = await supabase.from('food_log_items').select('*').eq('timeline_event_id', timelineEventId).eq('user_id', userId);
  if (error || !data) return;
  await foodLogRepository.reconcileItemsFromServer(timelineEventId, data as ItemRow[]);
}

// ---------------------------------------------------------------------------
// Water intake (CORE-09) — a single-detail-row write via the thin
// `save_water_intake_v1` RPC (recommended by architecture §5 "for the
// spine+detail transaction consistency"). No edit UI exists for a logged
// drink (only create + soft-delete undo), so the only two push cases are
// create and tombstone.
// ---------------------------------------------------------------------------

export async function pushWaterIntakeLogs(userId: string): Promise<void> {
  const unsynced = await waterIntakeRepository.getUnsynced(userId);
  for (const log of unsynced) {
    if (log.deletedAt) {
      const wasConfirmed = await waterIntakeRepository.wasServerConfirmed(log.id);
      if (!wasConfirmed) {
        await waterIntakeRepository.purgeLocalOnly(log.id);
        continue;
      }
      const { error } = await supabase.from('timeline_events').update({ deleted_at: log.deletedAt }).eq('id', log.id);
      if (error) {
        await waterIntakeRepository.markFailed(log.id, error.message);
      } else {
        await waterIntakeRepository.markSynced(log.id);
      }
      continue;
    }

    const { data, error } = await supabase.rpc('save_water_intake_v1', {
      p_id: log.id,
      p_occurred_at: log.occurredAt,
      p_local_date: log.localDate,
      p_event_timezone: log.eventTimezone,
      p_volume_ml: log.volumeMl,
      p_unit_volume_snapshot: log.unitVolumeSnapshot,
      p_source: log.source,
    });

    if (error) {
      await waterIntakeRepository.markFailed(log.id, error.message);
      continue;
    }
    const body = data as SaveWaterIntakeRpcResponse | null;
    if (body?.error) {
      await waterIntakeRepository.markFailed(log.id, `${body.error.code}: ${body.error.message}`);
      continue;
    }
    if (!body?.data) {
      await waterIntakeRepository.markFailed(log.id, 'Empty response from save_water_intake_v1.');
      continue;
    }
    await waterIntakeRepository.markSynced(log.id);
  }
}

export async function pullWaterIntakeLogs(userId: string): Promise<void> {
  const { data, error } = await supabase.from('water_intake_logs').select('*, timeline_events(*)').eq('user_id', userId);
  if (error || !data) return;
  type EmbeddedRow = Record<string, unknown> & { timeline_events: Record<string, unknown> | Record<string, unknown>[] | null };
  const rows = (data as EmbeddedRow[])
    .map((row) => {
      const te = Array.isArray(row.timeline_events) ? row.timeline_events[0] : row.timeline_events;
      if (!te) return null;
      return {
        id: row.timeline_event_id,
        user_id: row.user_id,
        occurred_at: te.occurred_at,
        local_date: te.local_date,
        event_timezone: te.event_timezone,
        volume_ml: row.volume_ml,
        unit_volume_snapshot: row.unit_volume_snapshot,
        source: row.source,
        created_at: row.created_at,
        updated_at: row.updated_at,
        deleted_at: te.deleted_at,
      };
    })
    .filter((r): r is NonNullable<typeof r> => r !== null);
  await waterIntakeRepository.reconcileFromServer(rows as unknown as ServerWaterRow[]);
}

// ---------------------------------------------------------------------------
// Manual calorie burn (CORE-11) — same thin-RPC shape as water. Captures the
// RPC's authoritative `overlap_advisory` on a successful push, reconciling
// with whatever optimistic client-side advisory was computed at save time
// (§CORE-Sync coordination note: "the same seam as the optimistic PR badges").
// ---------------------------------------------------------------------------

export async function pushManualBurnLogs(userId: string): Promise<void> {
  const unsynced = await manualBurnRepository.getUnsynced(userId);
  for (const log of unsynced) {
    if (log.deletedAt) {
      const wasConfirmed = await manualBurnRepository.wasServerConfirmed(log.id);
      if (!wasConfirmed) {
        await manualBurnRepository.purgeLocalOnly(log.id);
        continue;
      }
      const { error } = await supabase.from('timeline_events').update({ deleted_at: log.deletedAt }).eq('id', log.id);
      if (error) {
        await manualBurnRepository.markFailed(log.id, error.message);
      } else {
        await manualBurnRepository.markSynced(log.id);
      }
      continue;
    }

    const { data, error } = await supabase.rpc('save_manual_burn_v1', {
      p_id: log.id,
      p_occurred_at: log.occurredAt,
      p_local_date: log.localDate,
      p_event_timezone: log.eventTimezone,
      // The spine stores burn energy NEGATIVE (architecture §1.8/`BURN §3.1`)
      // — this repo stores the positive magnitude the user typed locally.
      p_energy_kcal: -Math.abs(log.energyKcalMagnitude),
      p_label: log.label,
      p_energy_source: log.energySource,
      p_activity_type_code: log.activityTypeCode,
      p_duration_minutes: log.durationMinutes,
      p_notes: log.notes,
      p_source: 'manual',
    });

    if (error) {
      await manualBurnRepository.markFailed(log.id, error.message);
      continue;
    }
    const body = data as SaveManualBurnRpcResponse | null;
    if (body?.error) {
      // CONSENT_REQUIRED_HEALTH surfaces here if `estimated` was selected
      // without an active health consent that hasn't synced yet — surfaced
      // distinctly rather than a generic failure, mirroring pushProfileHealth.
      const message = body.error.code === 'CONSENT_REQUIRED_HEALTH' ? 'Waiting for health consent to sync first.' : `${body.error.code}: ${body.error.message}`;
      await manualBurnRepository.markFailed(log.id, message);
      continue;
    }
    if (!body?.data) {
      await manualBurnRepository.markFailed(log.id, 'Empty response from save_manual_burn_v1.');
      continue;
    }
    await manualBurnRepository.setOverlapAdvisory(log.id, toOverlapAdvisory(body.data.overlap_advisory));
    await manualBurnRepository.markSynced(log.id);
  }
}

export async function pullManualBurnLogs(userId: string): Promise<void> {
  const { data, error } = await supabase.from('manual_calorie_burn_logs').select('*, timeline_events(*)').eq('user_id', userId);
  if (error || !data) return;
  type EmbeddedRow = Record<string, unknown> & { timeline_events: Record<string, unknown> | Record<string, unknown>[] | null };
  const rows = (data as EmbeddedRow[])
    .map((row) => {
      const te = Array.isArray(row.timeline_events) ? row.timeline_events[0] : row.timeline_events;
      if (!te) return null;
      const energyKcal = (te.energy_kcal as number | null) ?? 0;
      return {
        id: row.timeline_event_id,
        user_id: row.user_id,
        occurred_at: te.occurred_at,
        local_date: te.local_date,
        event_timezone: te.event_timezone,
        energy_kcal_magnitude: Math.abs(energyKcal),
        label: row.label,
        activity_type_code: row.activity_type_code,
        duration_minutes: row.duration_minutes,
        energy_source: row.energy_source,
        notes: row.notes,
        created_at: row.created_at,
        updated_at: row.updated_at,
        deleted_at: te.deleted_at,
      };
    })
    .filter((r): r is NonNullable<typeof r> => r !== null);
  await manualBurnRepository.reconcileFromServer(rows as unknown as ServerManualBurnRow[]);
}

// ---------------------------------------------------------------------------
// Saved meals (CORE-10) — mirrors pushWorkoutTemplates' insert-then-update +
// child-item pattern exactly (`saved_meals`/`saved_meal_items`' UPDATE
// grants are both column-scoped, §8.1).
// ---------------------------------------------------------------------------

export async function pushSavedMeals(userId: string): Promise<void> {
  const unsynced = await savedMealsRepository.getUnsynced(userId);
  for (const meal of unsynced) {
    if (meal.deletedAt && !meal.serverConfirmed) {
      await savedMealsRepository.purgeLocalOnly(meal.id);
      continue;
    }

    if (!meal.serverConfirmed) {
      const { error } = await supabase
        .from('saved_meals')
        .insert({ id: meal.id, user_id: meal.userId, name: meal.name, description: meal.description, meal_type: meal.mealType, deleted_at: meal.deletedAt });
      if (error && error.code !== '23505') {
        await savedMealsRepository.markFailed(meal.id, error.message);
        continue;
      }
      await savedMealsRepository.markSynced(meal.id);
    } else {
      const { error } = await supabase
        .from('saved_meals')
        .update({ name: meal.name, description: meal.description, meal_type: meal.mealType, deleted_at: meal.deletedAt })
        .eq('id', meal.id);
      if (error) {
        await savedMealsRepository.markFailed(meal.id, error.message);
        continue;
      }
      await savedMealsRepository.markSynced(meal.id);
    }

    const pendingDeletes = await savedMealsRepository.getPendingItemDeletes(meal.id);
    for (const row of pendingDeletes) {
      const { error: delError } = await supabase.from('saved_meal_items').delete().eq('id', row.id);
      if (delError) {
        await savedMealsRepository.markItemFailed(row.id, delError.message);
      } else {
        await savedMealsRepository.purgeSyncedDeletedItem(row.id);
      }
    }

    const pendingItems = await savedMealsRepository.getUnsyncedItems(meal.id);
    for (const row of pendingItems) {
      // saved_meal_items' UPDATE grant excludes id/saved_meal_id/user_id AND
      // food_id/custom_food_id (§8.1: "modeled as delete + re-insert") — an
      // edit push must send ONLY the grantable mutable columns.
      if (!row.serverConfirmed) {
        const { error: itemError } = await supabase.from('saved_meal_items').insert({
          id: row.id,
          saved_meal_id: row.savedMealId,
          user_id: row.userId,
          food_id: row.foodId,
          custom_food_id: row.customFoodId,
          serving_label: row.servingLabel,
          serving_g_or_ml: row.servingGOrMl,
          quantity: row.quantity,
          sort_order: row.sortOrder,
        });
        if (itemError && itemError.code !== '23505') {
          await savedMealsRepository.markItemFailed(row.id, itemError.message);
          continue;
        }
        await savedMealsRepository.markItemSynced(row.id);
      } else {
        const { error: itemError } = await supabase
          .from('saved_meal_items')
          .update({ serving_label: row.servingLabel, serving_g_or_ml: row.servingGOrMl, quantity: row.quantity, sort_order: row.sortOrder })
          .eq('id', row.id);
        if (itemError) {
          await savedMealsRepository.markItemFailed(row.id, itemError.message);
        } else {
          await savedMealsRepository.markItemSynced(row.id);
        }
      }
    }
  }
}

export async function pullSavedMeals(userId: string): Promise<void> {
  const { data, error } = await supabase.from('saved_meals').select('*').eq('user_id', userId);
  if (error || !data) return;
  await savedMealsRepository.reconcileFromServer(data as SavedMealRow[]);
  for (const meal of data as SavedMealRow[]) {
    const { data: items, error: itemsError } = await supabase.from('saved_meal_items').select('*').eq('saved_meal_id', meal.id);
    if (itemsError || !items) continue;
    // The server carries no food-name column for a saved_meal_item (§1.10) —
    // resolve a local display convenience from the food cache / custom
    // foods if we have it, falling back to a generic label rather than
    // fabricating a name (never silently wrong).
    const withNames: SavedMealItemRow[] = await Promise.all(
      (items as Omit<SavedMealItemRow, 'food_name_snapshot_local'>[]).map(async (row) => {
        let name = 'Food';
        if (row.food_id) {
          const cached = await foodCacheRepository.getById(row.food_id);
          if (cached) name = cached.name;
        } else if (row.custom_food_id) {
          const custom = await customFoodsRepository.getById(row.custom_food_id);
          if (custom) name = custom.name;
        }
        return { ...row, food_name_snapshot_local: name };
      })
    );
    await savedMealsRepository.reconcileItemsFromServer(meal.id, withNames);
  }
}
