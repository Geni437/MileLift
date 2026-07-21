import { getDb } from '../client';
import { generateUuidV4 } from '../../lib/uuid';
import type { LocalWorkoutTemplate, LocalWorkoutTemplateExercise, SyncStatus } from '../types';

type TemplateRow = {
  id: string;
  user_id: string;
  name: string;
  description: string | null;
  deleted_at: string | null;
  created_at: string | null;
  updated_at: string | null;
  server_confirmed: number;
  sync_status: string;
  last_sync_error: string | null;
};

type ExerciseRow = {
  id: string;
  template_id: string;
  user_id: string;
  exercise_id: string | null;
  custom_exercise_id: string | null;
  exercise_name_snapshot: string;
  exercise_order: number;
  target_sets: number | null;
  target_reps_low: number | null;
  target_reps_high: number | null;
  target_weight_kg: number | null;
  target_rest_seconds: number | null;
  notes: string | null;
  deleted_locally: number;
  server_confirmed: number;
  sync_status: string;
  last_sync_error: string | null;
};

function toLocal(row: TemplateRow): LocalWorkoutTemplate {
  return {
    id: row.id,
    userId: row.user_id,
    name: row.name,
    description: row.description,
    deletedAt: row.deleted_at,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
    serverConfirmed: !!row.server_confirmed,
    syncStatus: row.sync_status as SyncStatus,
    lastSyncError: row.last_sync_error,
  };
}

function toLocalExercise(row: ExerciseRow): LocalWorkoutTemplateExercise {
  return {
    id: row.id,
    templateId: row.template_id,
    userId: row.user_id,
    exerciseId: row.exercise_id,
    customExerciseId: row.custom_exercise_id,
    exerciseNameSnapshot: row.exercise_name_snapshot,
    exerciseOrder: row.exercise_order,
    targetSets: row.target_sets,
    targetRepsLow: row.target_reps_low,
    targetRepsHigh: row.target_reps_high,
    targetWeightKg: row.target_weight_kg,
    targetRestSeconds: row.target_rest_seconds,
    notes: row.notes,
    deletedLocally: !!row.deleted_locally,
    serverConfirmed: !!row.server_confirmed,
    syncStatus: row.sync_status as SyncStatus,
    lastSyncError: row.last_sync_error,
  };
}

export type TemplateExerciseFields = {
  exerciseId: string | null;
  customExerciseId: string | null;
  exerciseNameSnapshot: string;
  exerciseOrder: number;
  targetSets: number | null;
  targetRepsLow: number | null;
  targetRepsHigh: number | null;
  targetWeightKg: number | null;
  targetRestSeconds: number | null;
  notes: string | null;
};

/** CORE-14 builder: `workout_templates` + `workout_template_exercises`, owner-owned, offline-first. */
export const workoutTemplatesRepository = {
  async listForUser(userId: string): Promise<LocalWorkoutTemplate[]> {
    const db = await getDb();
    const rows = await db.getAllAsync<TemplateRow>('SELECT * FROM workout_templates WHERE user_id = ? AND deleted_at IS NULL ORDER BY updated_at DESC', [userId]);
    return rows.map(toLocal);
  },

  async getById(id: string): Promise<LocalWorkoutTemplate | null> {
    const db = await getDb();
    const row = await db.getFirstAsync<TemplateRow>('SELECT * FROM workout_templates WHERE id = ?', [id]);
    return row ? toLocal(row) : null;
  },

  async create(id: string, userId: string, name: string, description: string | null): Promise<LocalWorkoutTemplate> {
    const db = await getDb();
    const now = new Date().toISOString();
    await db.runAsync(
      `INSERT INTO workout_templates (id, user_id, name, description, created_at, updated_at, server_confirmed, sync_status) VALUES (?, ?, ?, ?, ?, ?, 0, 'pending')`,
      [id, userId, name, description, now, now]
    );
    return (await this.getById(id))!;
  },

  async update(id: string, name: string, description: string | null): Promise<void> {
    const db = await getDb();
    const now = new Date().toISOString();
    await db.runAsync(`UPDATE workout_templates SET name = ?, description = ?, updated_at = ?, sync_status = 'pending' WHERE id = ?`, [name, description, now, id]);
  },

  async softDelete(id: string): Promise<void> {
    const db = await getDb();
    const now = new Date().toISOString();
    await db.runAsync(`UPDATE workout_templates SET deleted_at = ?, updated_at = ?, sync_status = 'pending' WHERE id = ?`, [now, now, id]);
  },

  async markSynced(id: string): Promise<void> {
    const db = await getDb();
    await db.runAsync(`UPDATE workout_templates SET server_confirmed = 1, sync_status = 'synced', last_sync_error = NULL WHERE id = ?`, [id]);
  },

  async markFailed(id: string, message: string): Promise<void> {
    const db = await getDb();
    await db.runAsync(`UPDATE workout_templates SET sync_status = 'failed', last_sync_error = ? WHERE id = ?`, [message, id]);
  },

  /** Has this row's id ever been confirmed by a successful server INSERT — first-create (plain INSERT) vs. edit (column-scoped UPDATE only) for the push side. */
  async wasServerConfirmed(id: string): Promise<boolean> {
    const db = await getDb();
    const row = await db.getFirstAsync<{ server_confirmed: number }>('SELECT server_confirmed FROM workout_templates WHERE id = ?', [id]);
    return !!row?.server_confirmed;
  },

  /** Soft-deleted entirely offline before ever syncing — the server never saw it, so there is nothing to push; just remove it locally. */
  async purgeLocalOnly(id: string): Promise<void> {
    const db = await getDb();
    await db.runAsync('DELETE FROM workout_templates WHERE id = ? AND server_confirmed = 0', [id]);
  },

  async getUnsynced(userId: string): Promise<LocalWorkoutTemplate[]> {
    const db = await getDb();
    const rows = await db.getAllAsync<TemplateRow>(`SELECT * FROM workout_templates WHERE user_id = ? AND sync_status IN ('pending', 'failed')`, [userId]);
    return rows.map(toLocal);
  },

  async reconcileFromServer(rows: TemplateRow[]): Promise<void> {
    const db = await getDb();
    await db.withTransactionAsync(async () => {
      for (const row of rows) {
        const existing = await db.getFirstAsync<TemplateRow>('SELECT * FROM workout_templates WHERE id = ?', [row.id]);
        if (existing && existing.sync_status !== 'synced') continue;
        await db.runAsync(
          `INSERT INTO workout_templates (id, user_id, name, description, deleted_at, created_at, updated_at, server_confirmed, sync_status, last_sync_error)
           VALUES (?, ?, ?, ?, ?, ?, ?, 1, 'synced', NULL)
           ON CONFLICT(id) DO UPDATE SET name = excluded.name, description = excluded.description, deleted_at = excluded.deleted_at, updated_at = excluded.updated_at, server_confirmed = 1, sync_status = 'synced', last_sync_error = NULL`,
          [row.id, row.user_id, row.name, row.description, row.deleted_at, row.created_at, row.updated_at]
        );
      }
    });
  },

  // ----- template exercises (child) -----

  async listExercises(templateId: string): Promise<LocalWorkoutTemplateExercise[]> {
    const db = await getDb();
    const rows = await db.getAllAsync<ExerciseRow>(
      'SELECT * FROM workout_template_exercises WHERE template_id = ? AND deleted_locally = 0 ORDER BY exercise_order ASC',
      [templateId]
    );
    return rows.map(toLocalExercise);
  },

  async upsertExercise(id: string, templateId: string, userId: string, fields: TemplateExerciseFields): Promise<LocalWorkoutTemplateExercise> {
    const db = await getDb();
    await db.runAsync(
      `INSERT INTO workout_template_exercises (id, template_id, user_id, exercise_id, custom_exercise_id, exercise_name_snapshot, exercise_order, target_sets, target_reps_low, target_reps_high, target_weight_kg, target_rest_seconds, notes, sync_status)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'pending')
       ON CONFLICT(id) DO UPDATE SET exercise_order = excluded.exercise_order, target_sets = excluded.target_sets, target_reps_low = excluded.target_reps_low, target_reps_high = excluded.target_reps_high, target_weight_kg = excluded.target_weight_kg, target_rest_seconds = excluded.target_rest_seconds, notes = excluded.notes, sync_status = 'pending'`,
      [id, templateId, userId, fields.exerciseId, fields.customExerciseId, fields.exerciseNameSnapshot, fields.exerciseOrder, fields.targetSets, fields.targetRepsLow, fields.targetRepsHigh, fields.targetWeightKg, fields.targetRestSeconds, fields.notes]
    );
    const db2 = await getDb();
    const row = await db2.getFirstAsync<ExerciseRow>('SELECT * FROM workout_template_exercises WHERE id = ?', [id]);
    return toLocalExercise(row!);
  },

  /** Real server-side DELETE for this child row (§8 exception) — locally, mark `deleted_locally` until the delete pushes. */
  async removeExercise(id: string): Promise<void> {
    const db = await getDb();
    const row = await db.getFirstAsync<ExerciseRow>('SELECT * FROM workout_template_exercises WHERE id = ?', [id]);
    if (!row) return;
    if (!row.server_confirmed) {
      // Never confirmed synced yet (even if a since-superseded edit is
      // mid-flight as 'pending') — nothing server-side references it.
      await db.runAsync('DELETE FROM workout_template_exercises WHERE id = ?', [id]);
      return;
    }
    await db.runAsync(`UPDATE workout_template_exercises SET deleted_locally = 1, sync_status = 'pending' WHERE id = ?`, [id]);
  },

  async getPendingExerciseDeletes(templateId: string): Promise<LocalWorkoutTemplateExercise[]> {
    const db = await getDb();
    const rows = await db.getAllAsync<ExerciseRow>(
      `SELECT * FROM workout_template_exercises WHERE template_id = ? AND deleted_locally = 1 AND sync_status IN ('pending', 'failed')`,
      [templateId]
    );
    return rows.map(toLocalExercise);
  },

  async getUnsyncedExercises(templateId: string): Promise<LocalWorkoutTemplateExercise[]> {
    const db = await getDb();
    const rows = await db.getAllAsync<ExerciseRow>(
      `SELECT * FROM workout_template_exercises WHERE template_id = ? AND deleted_locally = 0 AND sync_status IN ('pending', 'failed')`,
      [templateId]
    );
    return rows.map(toLocalExercise);
  },

  async markExerciseSynced(id: string): Promise<void> {
    const db = await getDb();
    await db.runAsync(`UPDATE workout_template_exercises SET server_confirmed = 1, sync_status = 'synced', last_sync_error = NULL WHERE id = ?`, [id]);
  },

  async purgeSyncedDeletedExercise(id: string): Promise<void> {
    const db = await getDb();
    await db.runAsync('DELETE FROM workout_template_exercises WHERE id = ?', [id]);
  },

  /** Has this exact child row's id ever been confirmed by a successful server INSERT. */
  async wasExerciseServerConfirmed(id: string): Promise<boolean> {
    const db = await getDb();
    const row = await db.getFirstAsync<{ server_confirmed: number }>('SELECT server_confirmed FROM workout_template_exercises WHERE id = ?', [id]);
    return !!row?.server_confirmed;
  },

  async markExerciseFailed(id: string, message: string): Promise<void> {
    const db = await getDb();
    await db.runAsync(`UPDATE workout_template_exercises SET sync_status = 'failed', last_sync_error = ? WHERE id = ?`, [message, id]);
  },

  async reconcileExercisesFromServer(templateId: string, rows: ExerciseRow[]): Promise<void> {
    const db = await getDb();
    await db.withTransactionAsync(async () => {
      const existingIds = new Set((await db.getAllAsync<{ id: string }>('SELECT id FROM workout_template_exercises WHERE template_id = ?', [templateId])).map((r) => r.id));
      const serverIds = new Set(rows.map((r) => r.id));
      for (const row of rows) {
        const existing = await db.getFirstAsync<ExerciseRow>('SELECT * FROM workout_template_exercises WHERE id = ?', [row.id]);
        if (existing && existing.sync_status !== 'synced') continue;
        await db.runAsync(
          `INSERT INTO workout_template_exercises (id, template_id, user_id, exercise_id, custom_exercise_id, exercise_name_snapshot, exercise_order, target_sets, target_reps_low, target_reps_high, target_weight_kg, target_rest_seconds, notes, server_confirmed, sync_status)
           VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 1, 'synced')
           ON CONFLICT(id) DO UPDATE SET exercise_order = excluded.exercise_order, target_sets = excluded.target_sets, target_reps_low = excluded.target_reps_low, target_reps_high = excluded.target_reps_high, target_weight_kg = excluded.target_weight_kg, target_rest_seconds = excluded.target_rest_seconds, notes = excluded.notes, server_confirmed = 1, sync_status = 'synced'`,
          [row.id, templateId, row.user_id, row.exercise_id, row.custom_exercise_id, row.exercise_name_snapshot, row.exercise_order, row.target_sets, row.target_reps_low, row.target_reps_high, row.target_weight_kg, row.target_rest_seconds, row.notes]
        );
      }
      // A row that exists locally, is confirmed synced, but is no longer on
      // the server (deleted elsewhere) — remove locally.
      for (const id of existingIds) {
        if (serverIds.has(id)) continue;
        const existing = await db.getFirstAsync<ExerciseRow>('SELECT * FROM workout_template_exercises WHERE id = ?', [id]);
        if (existing && existing.sync_status === 'synced') {
          await db.runAsync('DELETE FROM workout_template_exercises WHERE id = ?', [id]);
        }
      }
    });
  },

  /**
   * Batch "exercise count + planned-shape micro" summary for the Plans
   * landing list (design doc §CORE-14: "name, exercise count, a
   * `LiftStack:static`-style micro of the planned shape"). Since a template
   * has no logged sets, each segment's "volume" is a plan-shape proxy —
   * `target_sets × (target_reps_high ?? target_reps_low ?? 1)` — rather than
   * an actual completed volume; this stays reasonable even when
   * `target_weight_kg` is left unset (a common case for a fresh template).
   */
  async getExerciseSummariesForTemplates(templateIds: string[]): Promise<Map<string, { count: number; segments: { id: string; volume: number }[] }>> {
    const map = new Map<string, { count: number; segments: { id: string; volume: number }[] }>();
    if (templateIds.length === 0) return map;
    const db = await getDb();
    const placeholders = templateIds.map(() => '?').join(',');
    const rows = await db.getAllAsync<{ id: string; template_id: string; target_sets: number | null; target_reps_low: number | null; target_reps_high: number | null }>(
      `SELECT id, template_id, target_sets, target_reps_low, target_reps_high FROM workout_template_exercises
       WHERE template_id IN (${placeholders}) AND deleted_locally = 0
       ORDER BY template_id, exercise_order ASC`,
      templateIds
    );
    for (const row of rows) {
      const entry = map.get(row.template_id) ?? { count: 0, segments: [] };
      entry.count += 1;
      const reps = row.target_reps_high ?? row.target_reps_low ?? 1;
      entry.segments.push({ id: row.id, volume: (row.target_sets ?? 1) * reps });
      map.set(row.template_id, entry);
    }
    return map;
  },

  newId(): string {
    return generateUuidV4();
  },
};
