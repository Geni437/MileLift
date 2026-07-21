import { getDb } from '../client';
import type { LocalProgram, LocalProgramWorkout, SyncStatus } from '../types';

type ProgramRow = {
  id: string;
  user_id: string;
  name: string;
  description: string | null;
  length_weeks: number | null;
  deleted_at: string | null;
  created_at: string | null;
  updated_at: string | null;
  server_confirmed: number;
  sync_status: string;
  last_sync_error: string | null;
};

type WorkoutRow = {
  id: string;
  program_id: string;
  user_id: string;
  template_id: string;
  template_name_local: string;
  week_number: number | null;
  day_number: number | null;
  sort_order: number;
  deleted_locally: number;
  server_confirmed: number;
  sync_status: string;
  last_sync_error: string | null;
};

function toLocal(row: ProgramRow): LocalProgram {
  return {
    id: row.id,
    userId: row.user_id,
    name: row.name,
    description: row.description,
    lengthWeeks: row.length_weeks,
    deletedAt: row.deleted_at,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
    serverConfirmed: !!row.server_confirmed,
    syncStatus: row.sync_status as SyncStatus,
    lastSyncError: row.last_sync_error,
  };
}

function toLocalWorkout(row: WorkoutRow): LocalProgramWorkout {
  return {
    id: row.id,
    programId: row.program_id,
    userId: row.user_id,
    templateId: row.template_id,
    templateNameLocal: row.template_name_local,
    weekNumber: row.week_number,
    dayNumber: row.day_number,
    sortOrder: row.sort_order,
    deletedLocally: !!row.deleted_locally,
    serverConfirmed: !!row.server_confirmed,
    syncStatus: row.sync_status as SyncStatus,
    lastSyncError: row.last_sync_error,
  };
}

/** CORE-14 builder: `programs` + `program_workouts` (schedule-list slots, deliberately not a calendar — design doc §CORE-14). */
export const programsRepository = {
  async listForUser(userId: string): Promise<LocalProgram[]> {
    const db = await getDb();
    const rows = await db.getAllAsync<ProgramRow>('SELECT * FROM programs WHERE user_id = ? AND deleted_at IS NULL ORDER BY updated_at DESC', [userId]);
    return rows.map(toLocal);
  },

  async getById(id: string): Promise<LocalProgram | null> {
    const db = await getDb();
    const row = await db.getFirstAsync<ProgramRow>('SELECT * FROM programs WHERE id = ?', [id]);
    return row ? toLocal(row) : null;
  },

  async create(id: string, userId: string, name: string, description: string | null, lengthWeeks: number | null): Promise<LocalProgram> {
    const db = await getDb();
    const now = new Date().toISOString();
    await db.runAsync(
      `INSERT INTO programs (id, user_id, name, description, length_weeks, created_at, updated_at, server_confirmed, sync_status) VALUES (?, ?, ?, ?, ?, ?, ?, 0, 'pending')`,
      [id, userId, name, description, lengthWeeks, now, now]
    );
    return (await this.getById(id))!;
  },

  async update(id: string, name: string, description: string | null, lengthWeeks: number | null): Promise<void> {
    const db = await getDb();
    const now = new Date().toISOString();
    await db.runAsync(`UPDATE programs SET name = ?, description = ?, length_weeks = ?, updated_at = ?, sync_status = 'pending' WHERE id = ?`, [name, description, lengthWeeks, now, id]);
  },

  async softDelete(id: string): Promise<void> {
    const db = await getDb();
    const now = new Date().toISOString();
    await db.runAsync(`UPDATE programs SET deleted_at = ?, updated_at = ?, sync_status = 'pending' WHERE id = ?`, [now, now, id]);
  },

  async markSynced(id: string): Promise<void> {
    const db = await getDb();
    await db.runAsync(`UPDATE programs SET server_confirmed = 1, sync_status = 'synced', last_sync_error = NULL WHERE id = ?`, [id]);
  },

  async markFailed(id: string, message: string): Promise<void> {
    const db = await getDb();
    await db.runAsync(`UPDATE programs SET sync_status = 'failed', last_sync_error = ? WHERE id = ?`, [message, id]);
  },

  /** Has this row's id ever been confirmed by a successful server INSERT — first-create (plain INSERT) vs. edit (column-scoped UPDATE only) for the push side. */
  async wasServerConfirmed(id: string): Promise<boolean> {
    const db = await getDb();
    const row = await db.getFirstAsync<{ server_confirmed: number }>('SELECT server_confirmed FROM programs WHERE id = ?', [id]);
    return !!row?.server_confirmed;
  },

  /** Soft-deleted entirely offline before ever syncing — the server never saw it, so there is nothing to push; just remove it locally. */
  async purgeLocalOnly(id: string): Promise<void> {
    const db = await getDb();
    await db.runAsync('DELETE FROM programs WHERE id = ? AND server_confirmed = 0', [id]);
  },

  async getUnsynced(userId: string): Promise<LocalProgram[]> {
    const db = await getDb();
    const rows = await db.getAllAsync<ProgramRow>(`SELECT * FROM programs WHERE user_id = ? AND sync_status IN ('pending', 'failed')`, [userId]);
    return rows.map(toLocal);
  },

  async reconcileFromServer(rows: ProgramRow[]): Promise<void> {
    const db = await getDb();
    await db.withTransactionAsync(async () => {
      for (const row of rows) {
        const existing = await db.getFirstAsync<ProgramRow>('SELECT * FROM programs WHERE id = ?', [row.id]);
        if (existing && existing.sync_status !== 'synced') continue;
        await db.runAsync(
          `INSERT INTO programs (id, user_id, name, description, length_weeks, deleted_at, created_at, updated_at, server_confirmed, sync_status, last_sync_error)
           VALUES (?, ?, ?, ?, ?, ?, ?, ?, 1, 'synced', NULL)
           ON CONFLICT(id) DO UPDATE SET name = excluded.name, description = excluded.description, length_weeks = excluded.length_weeks, deleted_at = excluded.deleted_at, updated_at = excluded.updated_at, server_confirmed = 1, sync_status = 'synced', last_sync_error = NULL`,
          [row.id, row.user_id, row.name, row.description, row.length_weeks, row.deleted_at, row.created_at, row.updated_at]
        );
      }
    });
  },

  // ----- program workouts (child slots) -----

  async listWorkouts(programId: string): Promise<LocalProgramWorkout[]> {
    const db = await getDb();
    const rows = await db.getAllAsync<WorkoutRow>('SELECT * FROM program_workouts WHERE program_id = ? AND deleted_locally = 0 ORDER BY sort_order ASC', [programId]);
    return rows.map(toLocalWorkout);
  },

  async upsertWorkout(id: string, programId: string, userId: string, fields: { templateId: string; templateNameLocal: string; weekNumber: number | null; dayNumber: number | null; sortOrder: number }): Promise<LocalProgramWorkout> {
    const db = await getDb();
    await db.runAsync(
      `INSERT INTO program_workouts (id, program_id, user_id, template_id, template_name_local, week_number, day_number, sort_order, sync_status)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, 'pending')
       ON CONFLICT(id) DO UPDATE SET week_number = excluded.week_number, day_number = excluded.day_number, sort_order = excluded.sort_order, sync_status = 'pending'`,
      [id, programId, userId, fields.templateId, fields.templateNameLocal, fields.weekNumber, fields.dayNumber, fields.sortOrder]
    );
    const row = await db.getFirstAsync<WorkoutRow>('SELECT * FROM program_workouts WHERE id = ?', [id]);
    return toLocalWorkout(row!);
  },

  async removeWorkout(id: string): Promise<void> {
    const db = await getDb();
    const row = await db.getFirstAsync<WorkoutRow>('SELECT * FROM program_workouts WHERE id = ?', [id]);
    if (!row) return;
    if (!row.server_confirmed) {
      // Never confirmed synced yet (even if a since-superseded edit is
      // mid-flight as 'pending') — nothing server-side references it.
      await db.runAsync('DELETE FROM program_workouts WHERE id = ?', [id]);
      return;
    }
    await db.runAsync(`UPDATE program_workouts SET deleted_locally = 1, sync_status = 'pending' WHERE id = ?`, [id]);
  },

  async getUnsyncedWorkouts(programId: string): Promise<LocalProgramWorkout[]> {
    const db = await getDb();
    const rows = await db.getAllAsync<WorkoutRow>(`SELECT * FROM program_workouts WHERE program_id = ? AND sync_status IN ('pending', 'failed')`, [programId]);
    return rows.map(toLocalWorkout);
  },

  async markWorkoutSynced(id: string): Promise<void> {
    const db = await getDb();
    await db.runAsync(`UPDATE program_workouts SET server_confirmed = 1, sync_status = 'synced', last_sync_error = NULL WHERE id = ?`, [id]);
  },

  /** Has this exact child row's id ever been confirmed by a successful server INSERT. */
  async wasWorkoutServerConfirmed(id: string): Promise<boolean> {
    const db = await getDb();
    const row = await db.getFirstAsync<{ server_confirmed: number }>('SELECT server_confirmed FROM program_workouts WHERE id = ?', [id]);
    return !!row?.server_confirmed;
  },

  async purgeSyncedDeletedWorkout(id: string): Promise<void> {
    const db = await getDb();
    await db.runAsync('DELETE FROM program_workouts WHERE id = ?', [id]);
  },

  async markWorkoutFailed(id: string, message: string): Promise<void> {
    const db = await getDb();
    await db.runAsync(`UPDATE program_workouts SET sync_status = 'failed', last_sync_error = ? WHERE id = ?`, [message, id]);
  },

  /** Templates referenced by at least one program slot — the CORE-14 "used by a program" delete-warning check. */
  async templateIdsInUse(userId: string): Promise<Set<string>> {
    const db = await getDb();
    const rows = await db.getAllAsync<{ template_id: string }>('SELECT DISTINCT template_id FROM program_workouts WHERE user_id = ? AND deleted_locally = 0', [userId]);
    return new Set(rows.map((r) => r.template_id));
  },

  /** Batch template-slot count per program — the Plans landing "Programs" row's "template count" (design doc §CORE-14). */
  async getTemplateCountsForPrograms(programIds: string[]): Promise<Map<string, number>> {
    const map = new Map<string, number>();
    if (programIds.length === 0) return map;
    const db = await getDb();
    const placeholders = programIds.map(() => '?').join(',');
    const rows = await db.getAllAsync<{ program_id: string; n: number }>(
      `SELECT program_id, COUNT(*) as n FROM program_workouts WHERE program_id IN (${placeholders}) AND deleted_locally = 0 GROUP BY program_id`,
      programIds
    );
    for (const row of rows) map.set(row.program_id, row.n);
    return map;
  },
};
