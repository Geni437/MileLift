import { getDb } from '../client';
import type { LocalSavedMeal, LocalSavedMealItem, MealType, SyncStatus } from '../types';

type MealRow = {
  id: string;
  user_id: string;
  name: string;
  description: string | null;
  meal_type: string | null;
  deleted_at: string | null;
  created_at: string | null;
  updated_at: string | null;
  server_confirmed: number;
  sync_status: string;
  last_sync_error: string | null;
};

type ItemRow = {
  id: string;
  saved_meal_id: string;
  user_id: string;
  food_id: string | null;
  custom_food_id: string | null;
  food_name_snapshot_local: string;
  serving_label: string;
  serving_g_or_ml: number;
  quantity: number;
  sort_order: number;
  deleted_locally: number;
  server_confirmed: number;
  sync_status: string;
  last_sync_error: string | null;
};

function toLocalMeal(row: MealRow): LocalSavedMeal {
  return {
    id: row.id,
    userId: row.user_id,
    name: row.name,
    description: row.description,
    mealType: row.meal_type as MealType | null,
    deletedAt: row.deleted_at,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
    serverConfirmed: !!row.server_confirmed,
    syncStatus: row.sync_status as SyncStatus,
    lastSyncError: row.last_sync_error,
  };
}

function toLocalItem(row: ItemRow): LocalSavedMealItem {
  return {
    id: row.id,
    savedMealId: row.saved_meal_id,
    userId: row.user_id,
    foodId: row.food_id,
    customFoodId: row.custom_food_id,
    foodNameSnapshotLocal: row.food_name_snapshot_local,
    servingLabel: row.serving_label,
    servingGOrMl: row.serving_g_or_ml,
    quantity: row.quantity,
    sortOrder: row.sort_order,
    deletedLocally: !!row.deleted_locally,
    serverConfirmed: !!row.server_confirmed,
    syncStatus: row.sync_status as SyncStatus,
    lastSyncError: row.last_sync_error,
  };
}

export type SavedMealItemFields = {
  foodId: string | null;
  customFoodId: string | null;
  foodNameSnapshotLocal: string;
  servingLabel: string;
  servingGOrMl: number;
  quantity: number;
  sortOrder: number;
};

/** CORE-10 builder: `saved_meals` + `saved_meal_items`, owner-owned live plan (§1.10), offline-first — mirrors `workoutTemplatesRepository`. */
export const savedMealsRepository = {
  async listForUser(userId: string): Promise<LocalSavedMeal[]> {
    const db = await getDb();
    const rows = await db.getAllAsync<MealRow>('SELECT * FROM saved_meals WHERE user_id = ? AND deleted_at IS NULL ORDER BY updated_at DESC', [userId]);
    return rows.map(toLocalMeal);
  },

  async getById(id: string): Promise<LocalSavedMeal | null> {
    const db = await getDb();
    const row = await db.getFirstAsync<MealRow>('SELECT * FROM saved_meals WHERE id = ?', [id]);
    return row ? toLocalMeal(row) : null;
  },

  async create(id: string, userId: string, fields: { name: string; description: string | null; mealType: MealType | null }): Promise<LocalSavedMeal> {
    const db = await getDb();
    const now = new Date().toISOString();
    await db.runAsync(
      `INSERT INTO saved_meals (id, user_id, name, description, meal_type, created_at, updated_at, server_confirmed, sync_status) VALUES (?, ?, ?, ?, ?, ?, ?, 0, 'pending')`,
      [id, userId, fields.name, fields.description, fields.mealType, now, now]
    );
    return (await this.getById(id))!;
  },

  async update(id: string, fields: { name: string; description: string | null; mealType: MealType | null }): Promise<void> {
    const db = await getDb();
    const now = new Date().toISOString();
    await db.runAsync(`UPDATE saved_meals SET name = ?, description = ?, meal_type = ?, updated_at = ?, sync_status = 'pending' WHERE id = ?`, [
      fields.name,
      fields.description,
      fields.mealType,
      now,
      id,
    ]);
  },

  async softDelete(id: string): Promise<void> {
    const db = await getDb();
    const now = new Date().toISOString();
    await db.runAsync(`UPDATE saved_meals SET deleted_at = ?, updated_at = ?, sync_status = 'pending' WHERE id = ?`, [now, now, id]);
  },

  async wasServerConfirmed(id: string): Promise<boolean> {
    const db = await getDb();
    const row = await db.getFirstAsync<{ server_confirmed: number }>('SELECT server_confirmed FROM saved_meals WHERE id = ?', [id]);
    return !!row?.server_confirmed;
  },

  async purgeLocalOnly(id: string): Promise<void> {
    const db = await getDb();
    await db.withTransactionAsync(async () => {
      await db.runAsync('DELETE FROM saved_meal_items WHERE saved_meal_id = ?', [id]);
      await db.runAsync('DELETE FROM saved_meals WHERE id = ? AND server_confirmed = 0', [id]);
    });
  },

  async markSynced(id: string): Promise<void> {
    const db = await getDb();
    await db.runAsync(`UPDATE saved_meals SET server_confirmed = 1, sync_status = 'synced', last_sync_error = NULL WHERE id = ?`, [id]);
  },

  async markFailed(id: string, message: string): Promise<void> {
    const db = await getDb();
    await db.runAsync(`UPDATE saved_meals SET sync_status = 'failed', last_sync_error = ? WHERE id = ?`, [message, id]);
  },

  async getUnsynced(userId: string): Promise<LocalSavedMeal[]> {
    const db = await getDb();
    const rows = await db.getAllAsync<MealRow>(`SELECT * FROM saved_meals WHERE user_id = ? AND sync_status IN ('pending', 'failed')`, [userId]);
    return rows.map(toLocalMeal);
  },

  async reconcileFromServer(rows: MealRow[]): Promise<void> {
    const db = await getDb();
    await db.withTransactionAsync(async () => {
      for (const row of rows) {
        const existing = await db.getFirstAsync<MealRow>('SELECT * FROM saved_meals WHERE id = ?', [row.id]);
        if (existing && existing.sync_status !== 'synced') continue;
        await db.runAsync(
          `INSERT INTO saved_meals (id, user_id, name, description, meal_type, deleted_at, created_at, updated_at, server_confirmed, sync_status, last_sync_error)
           VALUES (?, ?, ?, ?, ?, ?, ?, ?, 1, 'synced', NULL)
           ON CONFLICT(id) DO UPDATE SET name = excluded.name, description = excluded.description, meal_type = excluded.meal_type, deleted_at = excluded.deleted_at, updated_at = excluded.updated_at, server_confirmed = 1, sync_status = 'synced', last_sync_error = NULL`,
          [row.id, row.user_id, row.name, row.description, row.meal_type, row.deleted_at, row.created_at, row.updated_at]
        );
      }
    });
  },

  // ----- items (child) -----

  async listItems(savedMealId: string): Promise<LocalSavedMealItem[]> {
    const db = await getDb();
    const rows = await db.getAllAsync<ItemRow>('SELECT * FROM saved_meal_items WHERE saved_meal_id = ? AND deleted_locally = 0 ORDER BY sort_order ASC', [savedMealId]);
    return rows.map(toLocalItem);
  },

  async upsertItem(id: string, savedMealId: string, userId: string, fields: SavedMealItemFields): Promise<LocalSavedMealItem> {
    const db = await getDb();
    await db.runAsync(
      `INSERT INTO saved_meal_items (id, saved_meal_id, user_id, food_id, custom_food_id, food_name_snapshot_local, serving_label, serving_g_or_ml, quantity, sort_order, sync_status)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'pending')
       ON CONFLICT(id) DO UPDATE SET serving_label = excluded.serving_label, serving_g_or_ml = excluded.serving_g_or_ml, quantity = excluded.quantity, sort_order = excluded.sort_order, food_name_snapshot_local = excluded.food_name_snapshot_local, sync_status = 'pending'`,
      [id, savedMealId, userId, fields.foodId, fields.customFoodId, fields.foodNameSnapshotLocal, fields.servingLabel, fields.servingGOrMl, fields.quantity, fields.sortOrder]
    );
    const db2 = await getDb();
    const row = await db2.getFirstAsync<ItemRow>('SELECT * FROM saved_meal_items WHERE id = ?', [id]);
    return toLocalItem(row!);
  },

  /** This table supports a real server-side DELETE (§8 exception, per the migration header) — locally, mark `deleted_locally` until the delete pushes. */
  async removeItem(id: string): Promise<void> {
    const db = await getDb();
    const row = await db.getFirstAsync<ItemRow>('SELECT * FROM saved_meal_items WHERE id = ?', [id]);
    if (!row) return;
    if (!row.server_confirmed) {
      await db.runAsync('DELETE FROM saved_meal_items WHERE id = ?', [id]);
      return;
    }
    await db.runAsync(`UPDATE saved_meal_items SET deleted_locally = 1, sync_status = 'pending' WHERE id = ?`, [id]);
  },

  async getPendingItemDeletes(savedMealId: string): Promise<LocalSavedMealItem[]> {
    const db = await getDb();
    const rows = await db.getAllAsync<ItemRow>(`SELECT * FROM saved_meal_items WHERE saved_meal_id = ? AND deleted_locally = 1 AND sync_status IN ('pending', 'failed')`, [savedMealId]);
    return rows.map(toLocalItem);
  },

  async getUnsyncedItems(savedMealId: string): Promise<LocalSavedMealItem[]> {
    const db = await getDb();
    const rows = await db.getAllAsync<ItemRow>(`SELECT * FROM saved_meal_items WHERE saved_meal_id = ? AND deleted_locally = 0 AND sync_status IN ('pending', 'failed')`, [savedMealId]);
    return rows.map(toLocalItem);
  },

  async markItemSynced(id: string): Promise<void> {
    const db = await getDb();
    await db.runAsync(`UPDATE saved_meal_items SET server_confirmed = 1, sync_status = 'synced', last_sync_error = NULL WHERE id = ?`, [id]);
  },

  async purgeSyncedDeletedItem(id: string): Promise<void> {
    const db = await getDb();
    await db.runAsync('DELETE FROM saved_meal_items WHERE id = ?', [id]);
  },

  async markItemFailed(id: string, message: string): Promise<void> {
    const db = await getDb();
    await db.runAsync(`UPDATE saved_meal_items SET sync_status = 'failed', last_sync_error = ? WHERE id = ?`, [message, id]);
  },

  async reconcileItemsFromServer(savedMealId: string, rows: ItemRow[]): Promise<void> {
    const db = await getDb();
    await db.withTransactionAsync(async () => {
      const existingIds = new Set((await db.getAllAsync<{ id: string }>('SELECT id FROM saved_meal_items WHERE saved_meal_id = ?', [savedMealId])).map((r) => r.id));
      const serverIds = new Set(rows.map((r) => r.id));
      for (const row of rows) {
        const existing = await db.getFirstAsync<ItemRow>('SELECT * FROM saved_meal_items WHERE id = ?', [row.id]);
        if (existing && existing.sync_status !== 'synced') continue;
        await db.runAsync(
          `INSERT INTO saved_meal_items (id, saved_meal_id, user_id, food_id, custom_food_id, food_name_snapshot_local, serving_label, serving_g_or_ml, quantity, sort_order, server_confirmed, sync_status)
           VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 1, 'synced')
           ON CONFLICT(id) DO UPDATE SET serving_label = excluded.serving_label, serving_g_or_ml = excluded.serving_g_or_ml, quantity = excluded.quantity, sort_order = excluded.sort_order, server_confirmed = 1, sync_status = 'synced'`,
          [row.id, savedMealId, row.user_id, row.food_id, row.custom_food_id, row.food_name_snapshot_local, row.serving_label, row.serving_g_or_ml, row.quantity, row.sort_order]
        );
      }
      for (const id of existingIds) {
        if (serverIds.has(id)) continue;
        const existing = await db.getFirstAsync<ItemRow>('SELECT * FROM saved_meal_items WHERE id = ?', [id]);
        if (existing && existing.sync_status === 'synced') {
          await db.runAsync('DELETE FROM saved_meal_items WHERE id = ?', [id]);
        }
      }
    });
  },
};

export type { MealRow, ItemRow };
