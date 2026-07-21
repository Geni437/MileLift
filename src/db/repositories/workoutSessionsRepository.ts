import { getDb } from '../client';
import type {
  CaloriesSource,
  LocalWorkoutSession,
  LocalWorkoutSet,
  MuscleGroup,
  SyncStatus,
  UnitWeightSnapshot,
  WorkoutSetType,
  WorkoutSource,
  WorkoutVisibility,
} from '../types';

type SessionRow = {
  id: string;
  user_id: string;
  title: string | null;
  notes: string | null;
  occurred_at: string;
  local_date: string;
  event_timezone: string;
  duration_seconds: number;
  source_template_id: string | null;
  template_name_snapshot: string | null;
  session_rpe: number | null;
  total_volume_kg: number | null;
  total_sets: number | null;
  calories_source: string;
  energy_kcal: number | null;
  source: string;
  visibility: string;
  load_score: number | null;
  client_created_at: string | null;
  created_at: string | null;
  updated_at: string | null;
  deleted_at: string | null;
  is_finished: number;
  server_confirmed: number;
  sync_status: string;
  last_sync_error: string | null;
};

type SetRow = {
  id: string;
  timeline_event_id: string;
  user_id: string;
  exercise_id: string | null;
  custom_exercise_id: string | null;
  exercise_name_snapshot: string;
  primary_muscle_snapshot: string | null;
  exercise_order: number;
  set_number: number;
  set_type: string;
  reps: number | null;
  weight_kg: number | null;
  unit_weight_snapshot: string;
  is_bodyweight: number;
  duration_seconds: number | null;
  distance_m: number | null;
  rpe: number | null;
  rest_seconds_planned: number | null;
  rest_seconds_actual: number | null;
  is_completed: number;
  estimated_1rm_kg: number | null;
  notes: string | null;
  deleted_at: string | null;
  created_at: string | null;
  updated_at: string | null;
  dirty: number;
  server_confirmed: number;
};

function toLocalSession(row: SessionRow): LocalWorkoutSession {
  return {
    id: row.id,
    userId: row.user_id,
    title: row.title,
    notes: row.notes,
    occurredAt: row.occurred_at,
    localDate: row.local_date,
    eventTimezone: row.event_timezone,
    durationSeconds: row.duration_seconds,
    sourceTemplateId: row.source_template_id,
    templateNameSnapshot: row.template_name_snapshot,
    sessionRpe: row.session_rpe,
    totalVolumeKg: row.total_volume_kg,
    totalSets: row.total_sets,
    caloriesSource: row.calories_source as CaloriesSource,
    energyKcal: row.energy_kcal,
    source: row.source as WorkoutSource,
    visibility: row.visibility as WorkoutVisibility,
    loadScore: row.load_score,
    clientCreatedAt: row.client_created_at,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
    deletedAt: row.deleted_at,
    isFinished: !!row.is_finished,
    serverConfirmed: !!row.server_confirmed,
    syncStatus: row.sync_status as SyncStatus,
    lastSyncError: row.last_sync_error,
  };
}

function toLocalSet(row: SetRow): LocalWorkoutSet {
  return {
    id: row.id,
    timelineEventId: row.timeline_event_id,
    userId: row.user_id,
    exerciseId: row.exercise_id,
    customExerciseId: row.custom_exercise_id,
    exerciseNameSnapshot: row.exercise_name_snapshot,
    primaryMuscleSnapshot: row.primary_muscle_snapshot as MuscleGroup | null,
    exerciseOrder: row.exercise_order,
    setNumber: row.set_number,
    setType: row.set_type as WorkoutSetType,
    reps: row.reps,
    weightKg: row.weight_kg,
    unitWeightSnapshot: row.unit_weight_snapshot as UnitWeightSnapshot,
    isBodyweight: !!row.is_bodyweight,
    durationSeconds: row.duration_seconds,
    distanceM: row.distance_m,
    rpe: row.rpe,
    restSecondsPlanned: row.rest_seconds_planned,
    restSecondsActual: row.rest_seconds_actual,
    isCompleted: !!row.is_completed,
    estimated1rmKg: row.estimated_1rm_kg,
    notes: row.notes,
    deletedAt: row.deleted_at,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
    dirty: !!row.dirty,
    serverConfirmed: !!row.server_confirmed,
  };
}

export type SessionMetaFields = {
  title?: string | null;
  notes?: string | null;
  sourceTemplateId?: string | null;
  templateNameSnapshot?: string | null;
  sessionRpe?: number | null;
  caloriesSource?: CaloriesSource;
  energyKcal?: number | null;
  visibility?: WorkoutVisibility;
};

export type SetWriteFields = {
  exerciseId: string | null;
  customExerciseId: string | null;
  exerciseNameSnapshot: string;
  primaryMuscleSnapshot: MuscleGroup | null;
  exerciseOrder: number;
  setNumber: number;
  setType: WorkoutSetType;
  reps: number | null;
  weightKg: number | null;
  unitWeightSnapshot: UnitWeightSnapshot;
  isBodyweight: boolean;
  durationSeconds: number | null;
  distanceM: number | null;
  rpe: number | null;
  restSecondsPlanned: number | null;
  restSecondsActual: number | null;
  isCompleted: boolean;
  estimated1rmKg: number | null;
  notes: string | null;
};

export type ServerWorkoutSessionRow = {
  id: string;
  user_id: string;
  title: string | null;
  notes: string | null;
  occurred_at: string;
  local_date: string;
  event_timezone: string;
  duration_seconds: number;
  source_template_id: string | null;
  template_name_snapshot: string | null;
  session_rpe: number | null;
  total_volume_kg: number | null;
  total_sets: number | null;
  calories_source: string;
  energy_kcal: number | null;
  source: string;
  visibility: string;
  load_score: number | null;
  client_created_at: string | null;
  created_at: string;
  updated_at: string;
  deleted_at: string | null;
};

const PAGE_SIZE = 20;

/**
 * Local-first repository for `workout_sessions` + child `workout_set_logs`
 * (CORE-12, the gate-critical table pair). Mirrors `activityRepository`'s
 * shape/conventions; the session/set split (vs. Module A's single merged
 * table) exists because sets are a genuinely separate, independently
 * idempotent write grain (RPC §2.1 — "two grains").
 */
export const workoutSessionsRepository = {
  // ----- session -----

  async getSession(id: string): Promise<LocalWorkoutSession | null> {
    const db = await getDb();
    const row = await db.getFirstAsync<SessionRow>('SELECT * FROM workout_sessions WHERE id = ?', [id]);
    return row ? toLocalSession(row) : null;
  },

  /** The one in-progress (not yet finished) session for this user, if any — CORE-12 crash-recovery / Resume. */
  async getInProgressForUser(userId: string): Promise<LocalWorkoutSession | null> {
    const db = await getDb();
    const row = await db.getFirstAsync<SessionRow>(
      `SELECT * FROM workout_sessions WHERE user_id = ? AND is_finished = 0 AND deleted_at IS NULL ORDER BY occurred_at DESC LIMIT 1`,
      [userId]
    );
    return row ? toLocalSession(row) : null;
  },

  /** Starts a new in-progress session — `sync_status = 'local'` (§CORE-17: "Saved on device" from the first moment, never queued until Finish). */
  async startInProgress(
    id: string,
    userId: string,
    fields: { title: string | null; occurredAt: string; localDate: string; eventTimezone: string; sourceTemplateId: string | null; templateNameSnapshot: string | null }
  ): Promise<LocalWorkoutSession> {
    const db = await getDb();
    const now = new Date().toISOString();
    await db.runAsync(
      `INSERT INTO workout_sessions (
         id, user_id, title, occurred_at, local_date, event_timezone, duration_seconds,
         source_template_id, template_name_snapshot, calories_source, source, visibility,
         client_created_at, created_at, updated_at, is_finished, server_confirmed, sync_status
       ) VALUES (?, ?, ?, ?, ?, ?, 0, ?, ?, 'none', 'manual', 'private', ?, ?, ?, 0, 0, 'local')`,
      [id, userId, fields.title, fields.occurredAt, fields.localDate, fields.eventTimezone, fields.sourceTemplateId, fields.templateNameSnapshot, now, now, now]
    );
    return (await this.getSession(id))!;
  },

  async updateMeta(id: string, fields: SessionMetaFields): Promise<void> {
    const db = await getDb();
    const now = new Date().toISOString();
    const current = await this.getSession(id);
    if (!current) return;
    await db.runAsync(
      `UPDATE workout_sessions SET
         title = ?, notes = ?, source_template_id = ?, template_name_snapshot = ?,
         session_rpe = ?, calories_source = ?, energy_kcal = ?, visibility = ?, updated_at = ?
       WHERE id = ?`,
      [
        fields.title !== undefined ? fields.title : current.title,
        fields.notes !== undefined ? fields.notes : current.notes,
        fields.sourceTemplateId !== undefined ? fields.sourceTemplateId : current.sourceTemplateId,
        fields.templateNameSnapshot !== undefined ? fields.templateNameSnapshot : current.templateNameSnapshot,
        fields.sessionRpe !== undefined ? fields.sessionRpe : current.sessionRpe,
        fields.caloriesSource !== undefined ? fields.caloriesSource : current.caloriesSource,
        fields.energyKcal !== undefined ? fields.energyKcal : current.energyKcal,
        fields.visibility !== undefined ? fields.visibility : current.visibility,
        now,
        id,
      ]
    );
  },

  /** Finish: flips `is_finished` and enqueues the session for push (the ONLY thing that transitions `local` -> `pending`, §CORE-17). Recomputes local totals optimistically — the server recomputes authoritatively on sync (§2.4). */
  async finish(id: string, durationSeconds: number, sessionRpe: number | null): Promise<LocalWorkoutSession> {
    const db = await getDb();
    const now = new Date().toISOString();
    const sets = await this.getSetsForSession(id, { includeDeleted: false });
    const workingSets = sets.filter((s) => s.setType === 'working' && s.isCompleted);
    const totalVolumeKg = workingSets.reduce((sum, s) => sum + (s.reps ?? 0) * (s.weightKg ?? 0), 0);
    const loadScore = sessionRpe != null ? sessionRpe * (durationSeconds / 60) : null;

    await db.runAsync(
      `UPDATE workout_sessions SET
         duration_seconds = ?, session_rpe = ?, total_volume_kg = ?, total_sets = ?, load_score = ?,
         updated_at = ?, is_finished = 1, sync_status = 'pending', last_sync_error = NULL
       WHERE id = ?`,
      [durationSeconds, sessionRpe, totalVolumeKg, workingSets.length, loadScore, now, id]
    );
    return (await this.getSession(id))!;
  },

  /** Discard an in-progress (never-finished) session — hard-delete, nothing was ever queued to sync. */
  async discardInProgress(id: string): Promise<void> {
    const db = await getDb();
    await db.withTransactionAsync(async () => {
      await db.runAsync('DELETE FROM workout_set_logs WHERE timeline_event_id = ?', [id]);
      await db.runAsync('DELETE FROM workout_sessions WHERE id = ?', [id]);
    });
  },

  /** Soft-delete a finished session (session-detail "Delete", design doc CORE-15). Tombstone pushes as a direct `timeline_events.deleted_at` update (RPC §6), mirroring `activityRepository.softDelete`. */
  async softDelete(id: string): Promise<void> {
    const db = await getDb();
    const now = new Date().toISOString();
    await db.runAsync(
      `UPDATE workout_sessions SET deleted_at = ?, updated_at = ?, sync_status = 'pending', last_sync_error = NULL WHERE id = ?`,
      [now, now, id]
    );
  },

  async wasServerConfirmed(id: string): Promise<boolean> {
    const db = await getDb();
    const row = await db.getFirstAsync<{ server_confirmed: number }>('SELECT server_confirmed FROM workout_sessions WHERE id = ?', [id]);
    return !!row?.server_confirmed;
  },

  /** A session deleted before it was ever confirmed by the server needs no network call — drop it and its sets locally. */
  async purgeLocalOnly(id: string): Promise<void> {
    const db = await getDb();
    await db.withTransactionAsync(async () => {
      await db.runAsync('DELETE FROM workout_set_logs WHERE timeline_event_id = ?', [id]);
      await db.runAsync('DELETE FROM workout_sessions WHERE id = ? AND server_confirmed = 0', [id]);
    });
  },

  async listPage(userId: string, cursor: { occurredAt: string; id: string } | null, limit = PAGE_SIZE): Promise<{ items: LocalWorkoutSession[]; nextCursor: { occurredAt: string; id: string } | null }> {
    const db = await getDb();
    const rows = cursor
      ? await db.getAllAsync<SessionRow>(
          `SELECT * FROM workout_sessions
           WHERE user_id = ? AND deleted_at IS NULL AND is_finished = 1
             AND (occurred_at < ? OR (occurred_at = ? AND id < ?))
           ORDER BY occurred_at DESC, id DESC LIMIT ?`,
          [userId, cursor.occurredAt, cursor.occurredAt, cursor.id, limit + 1]
        )
      : await db.getAllAsync<SessionRow>(
          `SELECT * FROM workout_sessions WHERE user_id = ? AND deleted_at IS NULL AND is_finished = 1
           ORDER BY occurred_at DESC, id DESC LIMIT ?`,
          [userId, limit + 1]
        );
    const hasMore = rows.length > limit;
    const page = hasMore ? rows.slice(0, limit) : rows;
    const items = page.map(toLocalSession);
    const last = items[items.length - 1];
    return { items, nextCursor: hasMore && last ? { occurredAt: last.occurredAt, id: last.id } : null };
  },

  async countForUser(userId: string): Promise<number> {
    const db = await getDb();
    const row = await db.getFirstAsync<{ n: number }>(
      'SELECT COUNT(*) as n FROM workout_sessions WHERE user_id = ? AND deleted_at IS NULL AND is_finished = 1',
      [userId]
    );
    return row?.n ?? 0;
  },

  async markFinishedSynced(id: string, server: { durationSeconds: number; totalVolumeKg: number | null; totalSets: number | null; loadScore: number | null; energyKcal: number | null }): Promise<void> {
    const db = await getDb();
    const now = new Date().toISOString();
    await db.runAsync(
      `UPDATE workout_sessions SET
         duration_seconds = ?, total_volume_kg = ?, total_sets = ?, load_score = ?, energy_kcal = ?,
         created_at = COALESCE(created_at, ?), updated_at = ?, server_confirmed = 1, sync_status = 'synced', last_sync_error = NULL
       WHERE id = ?`,
      [server.durationSeconds, server.totalVolumeKg, server.totalSets, server.loadScore, server.energyKcal, now, now, id]
    );
  },

  async markDeleteSynced(id: string): Promise<void> {
    const db = await getDb();
    await db.runAsync(`UPDATE workout_sessions SET sync_status = 'synced', last_sync_error = NULL WHERE id = ?`, [id]);
  },

  async markFailed(id: string, message: string): Promise<void> {
    const db = await getDb();
    await db.runAsync(`UPDATE workout_sessions SET sync_status = 'failed', last_sync_error = ? WHERE id = ?`, [message, id]);
  },

  /** Finished sessions still needing a push — new/edited saves and delete-tombstones alike (never an in-progress `local` row, §CORE-17). */
  async getUnsynced(userId: string): Promise<LocalWorkoutSession[]> {
    const db = await getDb();
    const rows = await db.getAllAsync<SessionRow>(
      `SELECT * FROM workout_sessions WHERE user_id = ? AND is_finished = 1 AND sync_status IN ('pending', 'failed') ORDER BY occurred_at ASC`,
      [userId]
    );
    return rows.map(toLocalSession);
  },

  async reconcileSessionFromServer(row: ServerWorkoutSessionRow): Promise<void> {
    const db = await getDb();
    const existing = await db.getFirstAsync<SessionRow>('SELECT * FROM workout_sessions WHERE id = ?', [row.id]);
    if (existing && existing.sync_status !== 'synced') return; // never clobber an unsynced local edit/delete (§3.5 LWW-at-row-grain)
    await db.runAsync(
      `INSERT INTO workout_sessions (
         id, user_id, title, notes, occurred_at, local_date, event_timezone, duration_seconds,
         source_template_id, template_name_snapshot, session_rpe, total_volume_kg, total_sets,
         calories_source, energy_kcal, source, visibility, load_score, client_created_at,
         created_at, updated_at, deleted_at, is_finished, server_confirmed, sync_status, last_sync_error
       ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 1, 1, 'synced', NULL)
       ON CONFLICT(id) DO UPDATE SET
         title = excluded.title, notes = excluded.notes, occurred_at = excluded.occurred_at,
         local_date = excluded.local_date, event_timezone = excluded.event_timezone,
         duration_seconds = excluded.duration_seconds, source_template_id = excluded.source_template_id,
         template_name_snapshot = excluded.template_name_snapshot, session_rpe = excluded.session_rpe,
         total_volume_kg = excluded.total_volume_kg, total_sets = excluded.total_sets,
         calories_source = excluded.calories_source, energy_kcal = excluded.energy_kcal,
         visibility = excluded.visibility, load_score = excluded.load_score, updated_at = excluded.updated_at,
         deleted_at = excluded.deleted_at, is_finished = 1, server_confirmed = 1, sync_status = 'synced', last_sync_error = NULL`,
      [
        row.id, row.user_id, row.title, row.notes, row.occurred_at, row.local_date, row.event_timezone, row.duration_seconds,
        row.source_template_id, row.template_name_snapshot, row.session_rpe, row.total_volume_kg, row.total_sets,
        row.calories_source, row.energy_kcal, row.source, row.visibility, row.load_score, row.client_created_at,
        row.created_at, row.updated_at, row.deleted_at,
      ]
    );
  },

  // ----- sets -----

  async getSetsForSession(timelineEventId: string, opts?: { includeDeleted?: boolean }): Promise<LocalWorkoutSet[]> {
    const db = await getDb();
    const rows = opts?.includeDeleted
      ? await db.getAllAsync<SetRow>(
          'SELECT * FROM workout_set_logs WHERE timeline_event_id = ? ORDER BY exercise_order ASC, set_number ASC',
          [timelineEventId]
        )
      : await db.getAllAsync<SetRow>(
          'SELECT * FROM workout_set_logs WHERE timeline_event_id = ? AND deleted_at IS NULL ORDER BY exercise_order ASC, set_number ASC',
          [timelineEventId]
        );
    return rows.map(toLocalSet);
  },

  /**
   * The most recent OTHER finished session's working sets for this exact
   * exercise — the CORE-12 "prev" reference column (design doc §A SetRow: "a
   * major logging-speed aid"). Returns just that one prior session's sets,
   * ordered by set_number, or `[]` if this exercise has never been logged
   * before.
   */
  async getPreviousSetsForExercise(userId: string, exerciseId: string | null, customExerciseId: string | null, excludeTimelineEventId: string): Promise<LocalWorkoutSet[]> {
    const db = await getDb();
    const refClause = exerciseId ? 'wsl.exercise_id = ?' : 'wsl.custom_exercise_id = ?';
    const refValue = exerciseId ?? customExerciseId;
    const rows = await db.getAllAsync<SetRow & { occurred_at: string }>(
      `SELECT wsl.*, ws.occurred_at as occurred_at FROM workout_set_logs wsl
       JOIN workout_sessions ws ON ws.id = wsl.timeline_event_id
       WHERE wsl.user_id = ? AND wsl.deleted_at IS NULL AND wsl.set_type = 'working'
         AND ${refClause} AND wsl.timeline_event_id != ?
         AND ws.deleted_at IS NULL AND ws.is_finished = 1
       ORDER BY ws.occurred_at DESC, wsl.set_number ASC
       LIMIT 30`,
      [userId, refValue, excludeTimelineEventId]
    );
    if (rows.length === 0) return [];
    const mostRecentSessionId = rows[0]!.timeline_event_id;
    return rows.filter((r) => r.timeline_event_id === mostRecentSessionId).map(toLocalSet);
  },

  async getSet(id: string): Promise<LocalWorkoutSet | null> {
    const db = await getDb();
    const row = await db.getFirstAsync<SetRow>('SELECT * FROM workout_set_logs WHERE id = ?', [id]);
    return row ? toLocalSet(row) : null;
  },

  /** Upsert a set (new or edited) — always marks `dirty = 1` (§9.2 per-set idempotency grain: resent until confirmed). */
  async upsertSet(id: string, timelineEventId: string, userId: string, fields: SetWriteFields): Promise<LocalWorkoutSet> {
    const db = await getDb();
    const now = new Date().toISOString();
    await db.runAsync(
      `INSERT INTO workout_set_logs (
         id, timeline_event_id, user_id, exercise_id, custom_exercise_id, exercise_name_snapshot, primary_muscle_snapshot,
         exercise_order, set_number, set_type, reps, weight_kg, unit_weight_snapshot, is_bodyweight,
         duration_seconds, distance_m, rpe, rest_seconds_planned, rest_seconds_actual, is_completed,
         estimated_1rm_kg, notes, created_at, updated_at, dirty, server_confirmed
       ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 1, 0)
       ON CONFLICT(id) DO UPDATE SET
         exercise_order = excluded.exercise_order, set_number = excluded.set_number, set_type = excluded.set_type,
         reps = excluded.reps, weight_kg = excluded.weight_kg, unit_weight_snapshot = excluded.unit_weight_snapshot,
         is_bodyweight = excluded.is_bodyweight, duration_seconds = excluded.duration_seconds, distance_m = excluded.distance_m,
         rpe = excluded.rpe, rest_seconds_planned = excluded.rest_seconds_planned, rest_seconds_actual = excluded.rest_seconds_actual,
         is_completed = excluded.is_completed, estimated_1rm_kg = excluded.estimated_1rm_kg, notes = excluded.notes,
         updated_at = excluded.updated_at, dirty = 1`,
      [
        id, timelineEventId, userId, fields.exerciseId, fields.customExerciseId, fields.exerciseNameSnapshot, fields.primaryMuscleSnapshot,
        fields.exerciseOrder, fields.setNumber, fields.setType, fields.reps, fields.weightKg, fields.unitWeightSnapshot, fields.isBodyweight ? 1 : 0,
        fields.durationSeconds, fields.distanceM, fields.rpe, fields.restSecondsPlanned, fields.restSecondsActual, fields.isCompleted ? 1 : 0,
        fields.estimated1rmKg, fields.notes, now, now,
      ]
    );
    return (await this.getSet(id))!;
  },

  /**
   * Remove a set. If it was never confirmed by the server, hard-delete (there
   * is nothing to tombstone). Otherwise soft-delete + mark dirty so the next
   * sync sends an explicit `deleted_at` tombstone — RPC §2.1/design CORE-12:
   * "never dropped by omission."
   */
  async removeSet(id: string): Promise<void> {
    const db = await getDb();
    const set = await this.getSet(id);
    if (!set) return;
    if (!set.serverConfirmed) {
      await db.runAsync('DELETE FROM workout_set_logs WHERE id = ?', [id]);
      return;
    }
    const now = new Date().toISOString();
    await db.runAsync(`UPDATE workout_set_logs SET deleted_at = ?, updated_at = ?, dirty = 1 WHERE id = ?`, [now, now, id]);
  },

  /** Sets not yet confirmed synced for this exact `id` (§9.2 — what the next `save_workout_session_v1` call's `p_sets` should include). */
  async getDirtySets(timelineEventId: string): Promise<LocalWorkoutSet[]> {
    const db = await getDb();
    const rows = await db.getAllAsync<SetRow>(
      'SELECT * FROM workout_set_logs WHERE timeline_event_id = ? AND dirty = 1 ORDER BY exercise_order ASC, set_number ASC',
      [timelineEventId]
    );
    return rows.map(toLocalSet);
  },

  async markSetsSynced(ids: string[]): Promise<void> {
    if (ids.length === 0) return;
    const db = await getDb();
    await db.withTransactionAsync(async () => {
      for (const id of ids) {
        await db.runAsync(`UPDATE workout_set_logs SET dirty = 0, server_confirmed = 1 WHERE id = ?`, [id]);
      }
    });
  },

  /** Bulk pull reconciliation for a session's sets (own read, own edits win per row per §3.5 — a locally dirty set is left untouched). */
  async reconcileSetsFromServer(timelineEventId: string, rows: SetRow[]): Promise<void> {
    const db = await getDb();
    await db.withTransactionAsync(async () => {
      for (const row of rows) {
        const existing = await db.getFirstAsync<SetRow>('SELECT * FROM workout_set_logs WHERE id = ?', [row.id]);
        if (existing && existing.dirty) continue;
        await db.runAsync(
          `INSERT INTO workout_set_logs (
             id, timeline_event_id, user_id, exercise_id, custom_exercise_id, exercise_name_snapshot, primary_muscle_snapshot,
             exercise_order, set_number, set_type, reps, weight_kg, unit_weight_snapshot, is_bodyweight,
             duration_seconds, distance_m, rpe, rest_seconds_planned, rest_seconds_actual, is_completed,
             estimated_1rm_kg, notes, deleted_at, created_at, updated_at, dirty, server_confirmed
           ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 0, 1)
           ON CONFLICT(id) DO UPDATE SET
             exercise_order = excluded.exercise_order, set_number = excluded.set_number, set_type = excluded.set_type,
             reps = excluded.reps, weight_kg = excluded.weight_kg, unit_weight_snapshot = excluded.unit_weight_snapshot,
             is_bodyweight = excluded.is_bodyweight, duration_seconds = excluded.duration_seconds, distance_m = excluded.distance_m,
             rpe = excluded.rpe, rest_seconds_planned = excluded.rest_seconds_planned, rest_seconds_actual = excluded.rest_seconds_actual,
             is_completed = excluded.is_completed, estimated_1rm_kg = excluded.estimated_1rm_kg, notes = excluded.notes,
             deleted_at = excluded.deleted_at, updated_at = excluded.updated_at, dirty = 0, server_confirmed = 1`,
          [
            row.id, timelineEventId, row.user_id, row.exercise_id, row.custom_exercise_id, row.exercise_name_snapshot, row.primary_muscle_snapshot,
            row.exercise_order, row.set_number, row.set_type, row.reps, row.weight_kg, row.unit_weight_snapshot, row.is_bodyweight,
            row.duration_seconds, row.distance_m, row.rpe, row.rest_seconds_planned, row.rest_seconds_actual, row.is_completed,
            row.estimated_1rm_kg, row.notes, row.deleted_at, row.created_at, row.updated_at,
          ]
        );
      }
    });
  },
};

export type { SessionRow, SetRow };
