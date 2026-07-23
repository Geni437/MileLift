import * as SQLite from 'expo-sqlite';

import { getDb } from '../client';
import { sumItemMacros } from '../../lib/nutritionMath';
import type { FoodDataQuality, LocalFoodLogEntry, LocalFoodLogItem, MealType, NutritionSource, NutritionVisibility, SyncStatus } from '../types';

type EntryRow = {
  id: string;
  user_id: string;
  meal_type: string;
  title: string | null;
  notes: string | null;
  occurred_at: string;
  local_date: string;
  event_timezone: string;
  total_energy_kcal: number;
  total_protein_g: number | null;
  total_carb_g: number | null;
  total_fat_g: number | null;
  source: string;
  visibility: string;
  client_created_at: string | null;
  created_at: string | null;
  updated_at: string | null;
  deleted_at: string | null;
  committed_at: string | null;
  server_confirmed: number;
  sync_status: string;
  last_sync_error: string | null;
};

type ItemRow = {
  id: string;
  timeline_event_id: string;
  user_id: string;
  food_id: string | null;
  custom_food_id: string | null;
  food_name_snapshot: string;
  brand_snapshot: string | null;
  serving_label_snapshot: string;
  quantity: number;
  serving_g_or_ml_snapshot: number;
  energy_kcal: number;
  protein_g: number | null;
  carb_g: number | null;
  fat_g: number | null;
  data_quality_snapshot: string | null;
  sort_order: number;
  deleted_at: string | null;
  created_at: string | null;
  updated_at: string | null;
  dirty: number;
  server_confirmed: number;
};

function toLocalEntry(row: EntryRow): LocalFoodLogEntry {
  return {
    id: row.id,
    userId: row.user_id,
    mealType: row.meal_type as MealType,
    title: row.title,
    notes: row.notes,
    occurredAt: row.occurred_at,
    localDate: row.local_date,
    eventTimezone: row.event_timezone,
    totalEnergyKcal: row.total_energy_kcal,
    totalProteinG: row.total_protein_g,
    totalCarbG: row.total_carb_g,
    totalFatG: row.total_fat_g,
    source: row.source as NutritionSource,
    visibility: row.visibility as NutritionVisibility,
    clientCreatedAt: row.client_created_at,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
    deletedAt: row.deleted_at,
    committedAt: row.committed_at,
    serverConfirmed: !!row.server_confirmed,
    syncStatus: row.sync_status as SyncStatus,
    lastSyncError: row.last_sync_error,
  };
}

function toLocalItem(row: ItemRow): LocalFoodLogItem {
  return {
    id: row.id,
    timelineEventId: row.timeline_event_id,
    userId: row.user_id,
    foodId: row.food_id,
    customFoodId: row.custom_food_id,
    foodNameSnapshot: row.food_name_snapshot,
    brandSnapshot: row.brand_snapshot,
    servingLabelSnapshot: row.serving_label_snapshot,
    quantity: row.quantity,
    servingGOrMlSnapshot: row.serving_g_or_ml_snapshot,
    energyKcal: row.energy_kcal,
    proteinG: row.protein_g,
    carbG: row.carb_g,
    fatG: row.fat_g,
    dataQualitySnapshot: row.data_quality_snapshot as FoodDataQuality | null,
    sortOrder: row.sort_order,
    deletedAt: row.deleted_at,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
    dirty: !!row.dirty,
    serverConfirmed: !!row.server_confirmed,
  };
}

export type ItemWriteFields = {
  foodId: string | null;
  customFoodId: string | null;
  foodNameSnapshot: string;
  brandSnapshot: string | null;
  servingLabelSnapshot: string;
  quantity: number;
  servingGOrMlSnapshot: number;
  energyKcal: number;
  proteinG: number | null;
  carbG: number | null;
  fatG: number | null;
  dataQualitySnapshot: FoodDataQuality | null;
  sortOrder: number;
};

export type ServerEntryRow = {
  id: string;
  user_id: string;
  meal_type: string;
  title: string | null;
  notes: string | null;
  occurred_at: string;
  local_date: string;
  event_timezone: string;
  total_energy_kcal: number;
  total_protein_g: number | null;
  total_carb_g: number | null;
  total_fat_g: number | null;
  source: string;
  visibility: string;
  client_created_at: string | null;
  created_at: string;
  updated_at: string;
  deleted_at: string | null;
};

async function runUpsertItem(db: SQLite.SQLiteDatabase, id: string, timelineEventId: string, userId: string, fields: ItemWriteFields): Promise<void> {
  const now = new Date().toISOString();
  await db.runAsync(
    `INSERT INTO food_log_items (
       id, timeline_event_id, user_id, food_id, custom_food_id, food_name_snapshot, brand_snapshot,
       serving_label_snapshot, quantity, serving_g_or_ml_snapshot, energy_kcal, protein_g, carb_g, fat_g,
       data_quality_snapshot, sort_order, created_at, updated_at, dirty, server_confirmed
     ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 1, 0)
     ON CONFLICT(id) DO UPDATE SET
       food_name_snapshot = excluded.food_name_snapshot, brand_snapshot = excluded.brand_snapshot,
       serving_label_snapshot = excluded.serving_label_snapshot, quantity = excluded.quantity,
       serving_g_or_ml_snapshot = excluded.serving_g_or_ml_snapshot, energy_kcal = excluded.energy_kcal,
       protein_g = excluded.protein_g, carb_g = excluded.carb_g, fat_g = excluded.fat_g,
       data_quality_snapshot = excluded.data_quality_snapshot, sort_order = excluded.sort_order,
       updated_at = excluded.updated_at, dirty = 1`,
    [
      id,
      timelineEventId,
      userId,
      fields.foodId,
      fields.customFoodId,
      fields.foodNameSnapshot,
      fields.brandSnapshot,
      fields.servingLabelSnapshot,
      fields.quantity,
      fields.servingGOrMlSnapshot,
      fields.energyKcal,
      fields.proteinG,
      fields.carbG,
      fields.fatG,
      fields.dataQualitySnapshot,
      fields.sortOrder,
      now,
      now,
    ]
  );
}

const PAGE_SIZE = 20;

/**
 * Local-first repository for `food_log_entries` + child `food_log_items`
 * (CORE-06, the gate-critical table pair — architecture §1.5/§1.6/§9). Meals
 * are meta-mutable "draft trays" the moment the first item is added
 * (`committedAt = null`, the layer-2 domain-state case, types.ts doc
 * comment) — durable across an app kill, exactly mirroring
 * `workoutSessionsRepository`'s in-progress-session shape, but never
 * included in `getUnsynced()` until `commit()` (Save meal / Log food).
 */
export const foodLogRepository = {
  async getEntry(id: string): Promise<LocalFoodLogEntry | null> {
    const db = await getDb();
    const row = await db.getFirstAsync<EntryRow>('SELECT * FROM food_log_entries WHERE id = ?', [id]);
    return row ? toLocalEntry(row) : null;
  },

  /** Starts (or resumes) a draft meal — `sync_status = 'local'`, not yet enqueued (§CORE-Sync: "Saved on device" from the first item). */
  async startDraft(
    id: string,
    userId: string,
    fields: { mealType: MealType; occurredAt: string; localDate: string; eventTimezone: string; title?: string | null }
  ): Promise<LocalFoodLogEntry> {
    const db = await getDb();
    const now = new Date().toISOString();
    await db.runAsync(
      `INSERT INTO food_log_entries (
         id, user_id, meal_type, title, occurred_at, local_date, event_timezone,
         total_energy_kcal, source, visibility, client_created_at, created_at, updated_at,
         committed_at, server_confirmed, sync_status
       ) VALUES (?, ?, ?, ?, ?, ?, ?, 0, 'manual', 'private', ?, ?, ?, NULL, 0, 'local')`,
      [id, userId, fields.mealType, fields.title ?? null, fields.occurredAt, fields.localDate, fields.eventTimezone, now, now, now]
    );
    return (await this.getEntry(id))!;
  },

  async updateMeta(id: string, fields: { mealType?: MealType; title?: string | null; notes?: string | null }): Promise<void> {
    const db = await getDb();
    const current = await this.getEntry(id);
    if (!current) return;
    const now = new Date().toISOString();
    await db.runAsync(`UPDATE food_log_entries SET meal_type = ?, title = ?, notes = ?, updated_at = ? WHERE id = ?`, [
      fields.mealType ?? current.mealType,
      fields.title !== undefined ? fields.title : current.title,
      fields.notes !== undefined ? fields.notes : current.notes,
      now,
      id,
    ]);
  },

  /** Recomputes + writes the meal's snapshot totals from its current live items — the client-side mirror of what the save RPC recomputes server-side (§1.5). Called after every item add/edit/remove so the draft tray's running total (design doc CORE-06) is always correct. */
  async recomputeTotals(id: string): Promise<void> {
    const db = await getDb();
    const items = await this.getItemsForEntry(id);
    const totals = sumItemMacros(items);
    const now = new Date().toISOString();
    await db.runAsync(
      `UPDATE food_log_entries SET total_energy_kcal = ?, total_protein_g = ?, total_carb_g = ?, total_fat_g = ?, updated_at = ? WHERE id = ?`,
      [totals.energyKcal, totals.proteinG, totals.carbG, totals.fatG, now, id]
    );
  },

  /** Save meal / Log food (design doc CORE-06) — flips the draft to enqueued-for-sync. The ONLY thing that transitions `local` -> `pending` (mirrors `workoutSessionsRepository.finish`). */
  async commit(id: string): Promise<LocalFoodLogEntry> {
    const db = await getDb();
    await this.recomputeTotals(id);
    const now = new Date().toISOString();
    await db.runAsync(`UPDATE food_log_entries SET committed_at = ?, updated_at = ?, sync_status = 'pending', last_sync_error = NULL WHERE id = ?`, [now, now, id]);
    return (await this.getEntry(id))!;
  },

  /** Discard a never-committed draft (user backs out of the log sheet without saving) — hard-delete, nothing was ever queued to sync. */
  async discardDraft(id: string): Promise<void> {
    const db = await getDb();
    await db.withTransactionAsync(async () => {
      await db.runAsync('DELETE FROM food_log_items WHERE timeline_event_id = ?', [id]);
      await db.runAsync('DELETE FROM food_log_entries WHERE id = ?', [id]);
    });
  },

  /** Soft-delete a committed meal (meal-detail "Delete"). Tombstone pushes as a direct `timeline_events.deleted_at` update, mirroring `workoutSessionsRepository.softDelete`. */
  async softDelete(id: string): Promise<void> {
    const db = await getDb();
    const now = new Date().toISOString();
    await db.runAsync(`UPDATE food_log_entries SET deleted_at = ?, updated_at = ?, sync_status = 'pending', last_sync_error = NULL WHERE id = ?`, [now, now, id]);
  },

  async wasServerConfirmed(id: string): Promise<boolean> {
    const db = await getDb();
    const row = await db.getFirstAsync<{ server_confirmed: number }>('SELECT server_confirmed FROM food_log_entries WHERE id = ?', [id]);
    return !!row?.server_confirmed;
  },

  async purgeLocalOnly(id: string): Promise<void> {
    const db = await getDb();
    await db.withTransactionAsync(async () => {
      await db.runAsync('DELETE FROM food_log_items WHERE timeline_event_id = ?', [id]);
      await db.runAsync('DELETE FROM food_log_entries WHERE id = ? AND server_confirmed = 0', [id]);
    });
  },

  /** Today's committed meals, grouped by the caller (Food → Today, design doc §CORE-08). */
  async listForLocalDate(userId: string, localDate: string): Promise<LocalFoodLogEntry[]> {
    const db = await getDb();
    const rows = await db.getAllAsync<EntryRow>(
      `SELECT * FROM food_log_entries WHERE user_id = ? AND local_date = ? AND deleted_at IS NULL AND committed_at IS NOT NULL ORDER BY occurred_at ASC`,
      [userId, localDate]
    );
    return rows.map(toLocalEntry);
  },

  async listPage(userId: string, cursor: { occurredAt: string; id: string } | null, limit = PAGE_SIZE): Promise<{ items: LocalFoodLogEntry[]; nextCursor: { occurredAt: string; id: string } | null }> {
    const db = await getDb();
    const rows = cursor
      ? await db.getAllAsync<EntryRow>(
          `SELECT * FROM food_log_entries
           WHERE user_id = ? AND deleted_at IS NULL AND committed_at IS NOT NULL
             AND (occurred_at < ? OR (occurred_at = ? AND id < ?))
           ORDER BY occurred_at DESC, id DESC LIMIT ?`,
          [userId, cursor.occurredAt, cursor.occurredAt, cursor.id, limit + 1]
        )
      : await db.getAllAsync<EntryRow>(
          `SELECT * FROM food_log_entries WHERE user_id = ? AND deleted_at IS NULL AND committed_at IS NOT NULL
           ORDER BY occurred_at DESC, id DESC LIMIT ?`,
          [userId, limit + 1]
        );
    const hasMore = rows.length > limit;
    const page = hasMore ? rows.slice(0, limit) : rows;
    const items = page.map(toLocalEntry);
    const last = items[items.length - 1];
    return { items, nextCursor: hasMore && last ? { occurredAt: last.occurredAt, id: last.id } : null };
  },

  async markSyncedWithServerTotals(id: string, totals: { totalEnergyKcal: number; totalProteinG: number | null; totalCarbG: number | null; totalFatG: number | null }, syncedItemIds: string[]): Promise<void> {
    const db = await getDb();
    const now = new Date().toISOString();
    await db.withTransactionAsync(async () => {
      await db.runAsync(
        `UPDATE food_log_entries SET total_energy_kcal = ?, total_protein_g = ?, total_carb_g = ?, total_fat_g = ?,
           created_at = COALESCE(created_at, ?), updated_at = ?, server_confirmed = 1, sync_status = 'synced', last_sync_error = NULL
         WHERE id = ?`,
        [totals.totalEnergyKcal, totals.totalProteinG, totals.totalCarbG, totals.totalFatG, now, now, id]
      );
      for (const itemId of syncedItemIds) {
        await db.runAsync(`UPDATE food_log_items SET dirty = 0, server_confirmed = 1 WHERE id = ?`, [itemId]);
      }
    });
  },

  async markDeleteSynced(id: string): Promise<void> {
    const db = await getDb();
    await db.runAsync(`UPDATE food_log_entries SET sync_status = 'synced', last_sync_error = NULL WHERE id = ?`, [id]);
  },

  async markFailed(id: string, message: string): Promise<void> {
    const db = await getDb();
    await db.runAsync(`UPDATE food_log_entries SET sync_status = 'failed', last_sync_error = ? WHERE id = ?`, [message, id]);
  },

  /** Committed meals still needing a push — new/edited saves and delete-tombstones alike (never a draft, mirrors `workoutSessionsRepository.getUnsynced`). */
  async getUnsynced(userId: string): Promise<LocalFoodLogEntry[]> {
    const db = await getDb();
    const rows = await db.getAllAsync<EntryRow>(
      `SELECT * FROM food_log_entries WHERE user_id = ? AND committed_at IS NOT NULL AND sync_status IN ('pending', 'failed') ORDER BY occurred_at ASC`,
      [userId]
    );
    return rows.map(toLocalEntry);
  },

  async reconcileEntryFromServer(row: ServerEntryRow): Promise<void> {
    const db = await getDb();
    const existing = await db.getFirstAsync<EntryRow>('SELECT * FROM food_log_entries WHERE id = ?', [row.id]);
    if (existing && existing.sync_status !== 'synced') return; // never clobber an unsynced local edit/delete
    await db.runAsync(
      `INSERT INTO food_log_entries (
         id, user_id, meal_type, title, notes, occurred_at, local_date, event_timezone,
         total_energy_kcal, total_protein_g, total_carb_g, total_fat_g, source, visibility,
         client_created_at, created_at, updated_at, deleted_at, committed_at, server_confirmed, sync_status, last_sync_error
       ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 1, 'synced', NULL)
       ON CONFLICT(id) DO UPDATE SET
         meal_type = excluded.meal_type, title = excluded.title, notes = excluded.notes,
         occurred_at = excluded.occurred_at, local_date = excluded.local_date, event_timezone = excluded.event_timezone,
         total_energy_kcal = excluded.total_energy_kcal, total_protein_g = excluded.total_protein_g,
         total_carb_g = excluded.total_carb_g, total_fat_g = excluded.total_fat_g, visibility = excluded.visibility,
         updated_at = excluded.updated_at, deleted_at = excluded.deleted_at, committed_at = excluded.committed_at,
         server_confirmed = 1, sync_status = 'synced', last_sync_error = NULL`,
      [
        row.id, row.user_id, row.meal_type, row.title, row.notes, row.occurred_at, row.local_date, row.event_timezone,
        row.total_energy_kcal, row.total_protein_g, row.total_carb_g, row.total_fat_g, row.source, row.visibility,
        row.client_created_at, row.created_at, row.updated_at, row.deleted_at, row.updated_at,
      ]
    );
  },

  // ----- items -----

  async getItemsForEntry(timelineEventId: string, opts?: { includeDeleted?: boolean }): Promise<LocalFoodLogItem[]> {
    const db = await getDb();
    const rows = opts?.includeDeleted
      ? await db.getAllAsync<ItemRow>('SELECT * FROM food_log_items WHERE timeline_event_id = ? ORDER BY sort_order ASC', [timelineEventId])
      : await db.getAllAsync<ItemRow>('SELECT * FROM food_log_items WHERE timeline_event_id = ? AND deleted_at IS NULL ORDER BY sort_order ASC', [timelineEventId]);
    return rows.map(toLocalItem);
  },

  async upsertItem(id: string, timelineEventId: string, userId: string, fields: ItemWriteFields): Promise<LocalFoodLogItem> {
    const db = await getDb();
    await runUpsertItem(db, id, timelineEventId, userId, fields);
    await this.recomputeTotals(timelineEventId);
    const row = await db.getFirstAsync<ItemRow>('SELECT * FROM food_log_items WHERE id = ?', [id]);
    return toLocalItem(row!);
  },

  /** Remove an item. Never confirmed by the server -> hard-delete. Otherwise soft-delete + dirty so the next sync sends an explicit `deleted_at` tombstone (§9: "never dropped by omission"). */
  async removeItem(id: string): Promise<void> {
    const db = await getDb();
    const row = await db.getFirstAsync<ItemRow>('SELECT * FROM food_log_items WHERE id = ?', [id]);
    if (!row) return;
    if (!row.server_confirmed) {
      await db.runAsync('DELETE FROM food_log_items WHERE id = ?', [id]);
    } else {
      const now = new Date().toISOString();
      await db.runAsync(`UPDATE food_log_items SET deleted_at = ?, updated_at = ?, dirty = 1 WHERE id = ?`, [now, now, id]);
    }
    await this.recomputeTotals(row.timeline_event_id);
  },

  async getDirtyItems(timelineEventId: string): Promise<LocalFoodLogItem[]> {
    const db = await getDb();
    const rows = await db.getAllAsync<ItemRow>('SELECT * FROM food_log_items WHERE timeline_event_id = ? AND dirty = 1 ORDER BY sort_order ASC', [timelineEventId]);
    return rows.map(toLocalItem);
  },

  async reconcileItemsFromServer(timelineEventId: string, rows: ItemRow[]): Promise<void> {
    const db = await getDb();
    await db.withTransactionAsync(async () => {
      for (const row of rows) {
        const existing = await db.getFirstAsync<ItemRow>('SELECT * FROM food_log_items WHERE id = ?', [row.id]);
        if (existing && existing.dirty) continue;
        await db.runAsync(
          `INSERT INTO food_log_items (
             id, timeline_event_id, user_id, food_id, custom_food_id, food_name_snapshot, brand_snapshot,
             serving_label_snapshot, quantity, serving_g_or_ml_snapshot, energy_kcal, protein_g, carb_g, fat_g,
             data_quality_snapshot, sort_order, deleted_at, created_at, updated_at, dirty, server_confirmed
           ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 0, 1)
           ON CONFLICT(id) DO UPDATE SET
             food_name_snapshot = excluded.food_name_snapshot, brand_snapshot = excluded.brand_snapshot,
             serving_label_snapshot = excluded.serving_label_snapshot, quantity = excluded.quantity,
             serving_g_or_ml_snapshot = excluded.serving_g_or_ml_snapshot, energy_kcal = excluded.energy_kcal,
             protein_g = excluded.protein_g, carb_g = excluded.carb_g, fat_g = excluded.fat_g,
             data_quality_snapshot = excluded.data_quality_snapshot, sort_order = excluded.sort_order,
             deleted_at = excluded.deleted_at, updated_at = excluded.updated_at, dirty = 0, server_confirmed = 1`,
          [
            row.id, timelineEventId, row.user_id, row.food_id, row.custom_food_id, row.food_name_snapshot, row.brand_snapshot,
            row.serving_label_snapshot, row.quantity, row.serving_g_or_ml_snapshot, row.energy_kcal, row.protein_g, row.carb_g, row.fat_g,
            row.data_quality_snapshot, row.sort_order, row.deleted_at, row.created_at, row.updated_at,
          ]
        );
      }
    });
  },
};

export type { EntryRow, ItemRow };
