import { getDb } from '../client';
import type { FoodMeasureBasis, LocalCustomFood, SyncStatus } from '../types';

type Row = {
  id: string;
  user_id: string;
  barcode: string | null;
  name: string;
  brand: string | null;
  basis: string;
  energy_kcal: number;
  protein_g: number | null;
  carb_g: number | null;
  fat_g: number | null;
  default_serving_g_or_ml: number | null;
  notes: string | null;
  deleted_at: string | null;
  created_at: string | null;
  updated_at: string | null;
  server_confirmed: number;
  sync_status: string;
  last_sync_error: string | null;
};

function toLocal(row: Row): LocalCustomFood {
  return {
    id: row.id,
    userId: row.user_id,
    barcode: row.barcode,
    name: row.name,
    brand: row.brand,
    basis: row.basis as FoodMeasureBasis,
    energyKcal: row.energy_kcal,
    proteinG: row.protein_g,
    carbG: row.carb_g,
    fatG: row.fat_g,
    defaultServingGOrMl: row.default_serving_g_or_ml,
    notes: row.notes,
    deletedAt: row.deleted_at,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
    serverConfirmed: !!row.server_confirmed,
    syncStatus: row.sync_status as SyncStatus,
    lastSyncError: row.last_sync_error,
  };
}

export type CustomFoodFields = {
  barcode: string | null;
  name: string;
  brand: string | null;
  basis: FoodMeasureBasis;
  energyKcal: number;
  proteinG: number | null;
  carbG: number | null;
  fatG: number | null;
  defaultServingGOrMl: number | null;
  notes: string | null;
};

/** Owner-owned, offline-first (CORE-06/07 barcode-miss landing spot + general "add my own food," §1.4/§2.4). */
export const customFoodsRepository = {
  async getById(id: string): Promise<LocalCustomFood | null> {
    const db = await getDb();
    const row = await db.getFirstAsync<Row>('SELECT * FROM custom_foods WHERE id = ?', [id]);
    return row ? toLocal(row) : null;
  },

  async listForUser(userId: string): Promise<LocalCustomFood[]> {
    const db = await getDb();
    const rows = await db.getAllAsync<Row>('SELECT * FROM custom_foods WHERE user_id = ? AND deleted_at IS NULL ORDER BY name ASC', [userId]);
    return rows.map(toLocal);
  },

  /** CORE-07 §2.4 step 3 — "does a barcode miss already have a user-created entry for this barcode." Most-recent non-deleted match, an app-layer resolution (not a DB uniqueness invariant, per the migration's own comment). */
  async getByBarcode(userId: string, barcode: string): Promise<LocalCustomFood | null> {
    const db = await getDb();
    const row = await db.getFirstAsync<Row>(
      'SELECT * FROM custom_foods WHERE user_id = ? AND barcode = ? AND deleted_at IS NULL ORDER BY created_at DESC LIMIT 1',
      [userId, barcode]
    );
    return row ? toLocal(row) : null;
  },

  async create(id: string, userId: string, fields: CustomFoodFields): Promise<LocalCustomFood> {
    const db = await getDb();
    const now = new Date().toISOString();
    await db.runAsync(
      `INSERT INTO custom_foods (id, user_id, barcode, name, brand, basis, energy_kcal, protein_g, carb_g, fat_g, default_serving_g_or_ml, notes, created_at, updated_at, server_confirmed, sync_status, last_sync_error)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 0, 'pending', NULL)`,
      [
        id,
        userId,
        fields.barcode,
        fields.name,
        fields.brand,
        fields.basis,
        fields.energyKcal,
        fields.proteinG,
        fields.carbG,
        fields.fatG,
        fields.defaultServingGOrMl,
        fields.notes,
        now,
        now,
      ]
    );
    return (await this.getById(id))!;
  },

  async softDelete(id: string): Promise<void> {
    const db = await getDb();
    const now = new Date().toISOString();
    await db.runAsync(`UPDATE custom_foods SET deleted_at = ?, updated_at = ?, sync_status = 'pending', last_sync_error = NULL WHERE id = ?`, [now, now, id]);
  },

  async wasServerConfirmed(id: string): Promise<boolean> {
    const db = await getDb();
    const row = await db.getFirstAsync<{ server_confirmed: number }>('SELECT server_confirmed FROM custom_foods WHERE id = ?', [id]);
    return !!row?.server_confirmed;
  },

  async purgeLocalOnly(id: string): Promise<void> {
    const db = await getDb();
    await db.runAsync('DELETE FROM custom_foods WHERE id = ? AND server_confirmed = 0', [id]);
  },

  async markSynced(id: string): Promise<void> {
    const db = await getDb();
    await db.runAsync(`UPDATE custom_foods SET server_confirmed = 1, sync_status = 'synced', last_sync_error = NULL WHERE id = ?`, [id]);
  },

  async markFailed(id: string, message: string): Promise<void> {
    const db = await getDb();
    await db.runAsync(`UPDATE custom_foods SET sync_status = 'failed', last_sync_error = ? WHERE id = ?`, [message, id]);
  },

  async getUnsynced(userId: string): Promise<LocalCustomFood[]> {
    const db = await getDb();
    const rows = await db.getAllAsync<Row>(`SELECT * FROM custom_foods WHERE user_id = ? AND sync_status IN ('pending', 'failed')`, [userId]);
    return rows.map(toLocal);
  },

  async reconcileFromServer(rows: Row[]): Promise<void> {
    const db = await getDb();
    await db.withTransactionAsync(async () => {
      for (const row of rows) {
        const existing = await db.getFirstAsync<Row>('SELECT * FROM custom_foods WHERE id = ?', [row.id]);
        if (existing && existing.sync_status !== 'synced') continue;
        await db.runAsync(
          `INSERT INTO custom_foods (id, user_id, barcode, name, brand, basis, energy_kcal, protein_g, carb_g, fat_g, default_serving_g_or_ml, notes, deleted_at, created_at, updated_at, server_confirmed, sync_status, last_sync_error)
           VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 1, 'synced', NULL)
           ON CONFLICT(id) DO UPDATE SET
             barcode = excluded.barcode, name = excluded.name, brand = excluded.brand, basis = excluded.basis,
             energy_kcal = excluded.energy_kcal, protein_g = excluded.protein_g, carb_g = excluded.carb_g, fat_g = excluded.fat_g,
             default_serving_g_or_ml = excluded.default_serving_g_or_ml, notes = excluded.notes,
             deleted_at = excluded.deleted_at, updated_at = excluded.updated_at,
             server_confirmed = 1, sync_status = 'synced', last_sync_error = NULL`,
          [
            row.id,
            row.user_id,
            row.barcode,
            row.name,
            row.brand,
            row.basis,
            row.energy_kcal,
            row.protein_g,
            row.carb_g,
            row.fat_g,
            row.default_serving_g_or_ml,
            row.notes,
            row.deleted_at,
            row.created_at,
            row.updated_at,
          ]
        );
      }
    });
  },
};
