import { getDb } from '../client';
import type { EquipmentType, LocalCustomExercise, MuscleGroup, SyncStatus } from '../types';

type Row = {
  id: string;
  user_id: string;
  name: string;
  primary_muscle: string | null;
  equipment: string | null;
  is_weighted: number;
  is_bodyweight: number;
  is_time_based: number;
  is_distance_based: number;
  notes: string | null;
  deleted_at: string | null;
  created_at: string | null;
  updated_at: string | null;
  sync_status: string;
  last_sync_error: string | null;
};

function toLocal(row: Row): LocalCustomExercise {
  return {
    id: row.id,
    userId: row.user_id,
    name: row.name,
    primaryMuscle: row.primary_muscle as MuscleGroup | null,
    equipment: row.equipment as EquipmentType | null,
    isWeighted: !!row.is_weighted,
    isBodyweight: !!row.is_bodyweight,
    isTimeBased: !!row.is_time_based,
    isDistanceBased: !!row.is_distance_based,
    notes: row.notes,
    deletedAt: row.deleted_at,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
    syncStatus: row.sync_status as SyncStatus,
    lastSyncError: row.last_sync_error,
  };
}

export type CustomExerciseFields = {
  name: string;
  primaryMuscle: MuscleGroup | null;
  equipment: EquipmentType | null;
  isWeighted: boolean;
  isBodyweight: boolean;
  isTimeBased: boolean;
  isDistanceBased: boolean;
  notes: string | null;
};

/** Owner-owned, offline-first (CORE-13 "Custom exercise creation"). */
export const customExercisesRepository = {
  async getById(id: string): Promise<LocalCustomExercise | null> {
    const db = await getDb();
    const row = await db.getFirstAsync<Row>('SELECT * FROM custom_exercises WHERE id = ?', [id]);
    return row ? toLocal(row) : null;
  },

  async listForUser(userId: string): Promise<LocalCustomExercise[]> {
    const db = await getDb();
    const rows = await db.getAllAsync<Row>(
      'SELECT * FROM custom_exercises WHERE user_id = ? AND deleted_at IS NULL ORDER BY name ASC',
      [userId]
    );
    return rows.map(toLocal);
  },

  async create(id: string, userId: string, fields: CustomExerciseFields): Promise<LocalCustomExercise> {
    const db = await getDb();
    const now = new Date().toISOString();
    await db.runAsync(
      `INSERT INTO custom_exercises (id, user_id, name, primary_muscle, equipment, is_weighted, is_bodyweight, is_time_based, is_distance_based, notes, created_at, updated_at, sync_status, last_sync_error)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'pending', NULL)`,
      [
        id,
        userId,
        fields.name,
        fields.primaryMuscle,
        fields.equipment,
        fields.isWeighted ? 1 : 0,
        fields.isBodyweight ? 1 : 0,
        fields.isTimeBased ? 1 : 0,
        fields.isDistanceBased ? 1 : 0,
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
    await db.runAsync(
      `UPDATE custom_exercises SET deleted_at = ?, updated_at = ?, sync_status = 'pending', last_sync_error = NULL WHERE id = ?`,
      [now, now, id]
    );
  },

  async markSynced(id: string): Promise<void> {
    const db = await getDb();
    await db.runAsync(`UPDATE custom_exercises SET sync_status = 'synced', last_sync_error = NULL WHERE id = ?`, [id]);
  },

  async markFailed(id: string, message: string): Promise<void> {
    const db = await getDb();
    await db.runAsync(`UPDATE custom_exercises SET sync_status = 'failed', last_sync_error = ? WHERE id = ?`, [message, id]);
  },

  async getUnsynced(userId: string): Promise<LocalCustomExercise[]> {
    const db = await getDb();
    const rows = await db.getAllAsync<Row>(
      `SELECT * FROM custom_exercises WHERE user_id = ? AND sync_status IN ('pending', 'failed')`,
      [userId]
    );
    return rows.map(toLocal);
  },

  async reconcileFromServer(rows: Row[]): Promise<void> {
    const db = await getDb();
    await db.withTransactionAsync(async () => {
      for (const row of rows) {
        const existing = await db.getFirstAsync<Row>('SELECT * FROM custom_exercises WHERE id = ?', [row.id]);
        if (existing && existing.sync_status !== 'synced') continue;
        await db.runAsync(
          `INSERT INTO custom_exercises (id, user_id, name, primary_muscle, equipment, is_weighted, is_bodyweight, is_time_based, is_distance_based, notes, deleted_at, created_at, updated_at, sync_status, last_sync_error)
           VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'synced', NULL)
           ON CONFLICT(id) DO UPDATE SET
             name = excluded.name, primary_muscle = excluded.primary_muscle, equipment = excluded.equipment,
             is_weighted = excluded.is_weighted, is_bodyweight = excluded.is_bodyweight,
             is_time_based = excluded.is_time_based, is_distance_based = excluded.is_distance_based,
             notes = excluded.notes, deleted_at = excluded.deleted_at, updated_at = excluded.updated_at,
             sync_status = 'synced', last_sync_error = NULL`,
          [
            row.id,
            row.user_id,
            row.name,
            row.primary_muscle,
            row.equipment,
            row.is_weighted ? 1 : 0,
            row.is_bodyweight ? 1 : 0,
            row.is_time_based ? 1 : 0,
            row.is_distance_based ? 1 : 0,
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
