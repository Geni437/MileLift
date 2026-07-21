import { getDb } from '../client';
import type { LocalStrengthRecord, StrengthPrMetric } from '../types';
import type { StrengthPrEvaluation } from '../../features/strength/strengthPrEngine';

type Row = {
  user_id: string;
  exercise_id: string | null;
  custom_exercise_id: string | null;
  exercise_ref: string;
  metric: string;
  value: number;
  unit_snapshot: string | null;
  source_set_log_id: string;
  timeline_event_id: string;
  achieved_at: string;
  previous_value: number | null;
  confirmed: number;
};

function toLocal(row: Row): LocalStrengthRecord {
  return {
    userId: row.user_id,
    exerciseId: row.exercise_id,
    customExerciseId: row.custom_exercise_id,
    metric: row.metric as StrengthPrMetric,
    value: row.value,
    unitSnapshot: row.unit_snapshot,
    sourceSetLogId: row.source_set_log_id,
    timelineEventId: row.timeline_event_id,
    achievedAt: row.achieved_at,
    previousValue: row.previous_value,
    confirmed: !!row.confirmed,
  };
}

/** `exercise_id`, or `custom:<id>` for a custom movement — see schema.ts strength_records comment for why. */
export function exerciseRefKey(exerciseId: string | null, customExerciseId: string | null): string {
  return exerciseId ?? `custom:${customExerciseId}`;
}

/** Cached current-best per (user, exercise_ref, metric) — architecture §4.3, the on-device optimistic-PR comparison base (CORE-12). */
export const strengthRecordsRepository = {
  async getForExercise(userId: string, exerciseId: string | null, customExerciseId: string | null): Promise<Map<StrengthPrMetric, LocalStrengthRecord>> {
    const db = await getDb();
    const ref = exerciseRefKey(exerciseId, customExerciseId);
    const rows = await db.getAllAsync<Row>('SELECT * FROM strength_records WHERE user_id = ? AND exercise_ref = ?', [userId, ref]);
    const map = new Map<StrengthPrMetric, LocalStrengthRecord>();
    for (const row of rows) map.set(row.metric as StrengthPrMetric, toLocal(row));
    return map;
  },

  async getAllForUser(userId: string): Promise<LocalStrengthRecord[]> {
    const db = await getDb();
    const rows = await db.getAllAsync<Row>('SELECT * FROM strength_records WHERE user_id = ? ORDER BY exercise_ref ASC, metric ASC', [userId]);
    return rows.map(toLocal);
  },

  async applyOptimistic(
    userId: string,
    timelineEventId: string,
    achievedAt: string,
    evaluations: StrengthPrEvaluation[]
  ): Promise<void> {
    if (evaluations.length === 0) return;
    const db = await getDb();
    const now = new Date().toISOString();
    await db.withTransactionAsync(async () => {
      for (const evaluation of evaluations) {
        const ref = exerciseRefKey(evaluation.exerciseId, evaluation.customExerciseId);
        await db.runAsync(
          `INSERT INTO strength_records (user_id, exercise_id, custom_exercise_id, exercise_ref, metric, value, unit_snapshot, source_set_log_id, timeline_event_id, achieved_at, previous_value, confirmed, updated_at)
           VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 0, ?)
           ON CONFLICT(user_id, exercise_ref, metric) DO UPDATE SET
             value = excluded.value, unit_snapshot = excluded.unit_snapshot, source_set_log_id = excluded.source_set_log_id,
             timeline_event_id = excluded.timeline_event_id, achieved_at = excluded.achieved_at,
             previous_value = excluded.previous_value, confirmed = 0, updated_at = excluded.updated_at`,
          [
            userId, evaluation.exerciseId, evaluation.customExerciseId, ref, evaluation.metric, evaluation.value,
            evaluation.unitSnapshot, evaluation.sourceSetLogId, timelineEventId, achievedAt, evaluation.previousValue, now,
          ]
        );
      }
    });
  },

  async confirm(row: {
    userId: string;
    exerciseId: string | null;
    customExerciseId: string | null;
    metric: StrengthPrMetric;
    value: number;
    unitSnapshot: string | null;
    sourceSetLogId: string;
    timelineEventId: string;
    achievedAt: string;
    previousValue: number | null;
  }): Promise<void> {
    const db = await getDb();
    const now = new Date().toISOString();
    const ref = exerciseRefKey(row.exerciseId, row.customExerciseId);
    await db.runAsync(
      `INSERT INTO strength_records (user_id, exercise_id, custom_exercise_id, exercise_ref, metric, value, unit_snapshot, source_set_log_id, timeline_event_id, achieved_at, previous_value, confirmed, updated_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 1, ?)
       ON CONFLICT(user_id, exercise_ref, metric) DO UPDATE SET
         value = excluded.value, unit_snapshot = excluded.unit_snapshot, source_set_log_id = excluded.source_set_log_id,
         timeline_event_id = excluded.timeline_event_id, achieved_at = excluded.achieved_at,
         previous_value = excluded.previous_value, confirmed = 1, updated_at = excluded.updated_at`,
      [row.userId, row.exerciseId, row.customExerciseId, ref, row.metric, row.value, row.unitSnapshot, row.sourceSetLogId, row.timelineEventId, row.achievedAt, row.previousValue, now]
    );
  },

  /** Retraction: the server did not confirm an optimistically-applied metric — remove or replace with the true current best (§CORE-17 reconciliation). `null` row means no record exists at all for this ref/metric. */
  async reconcileFromServerRow(
    row: { userId: string; exerciseId: string | null; customExerciseId: string | null; metric: StrengthPrMetric; value: number; unitSnapshot: string | null; sourceSetLogId: string; timelineEventId: string; achievedAt: string; previousValue: number | null } | null,
    fallback: { userId: string; exerciseId: string | null; customExerciseId: string | null; metric: StrengthPrMetric }
  ): Promise<void> {
    const db = await getDb();
    const ref = exerciseRefKey(fallback.exerciseId, fallback.customExerciseId);
    if (!row) {
      await db.runAsync('DELETE FROM strength_records WHERE user_id = ? AND exercise_ref = ? AND metric = ?', [fallback.userId, ref, fallback.metric]);
      return;
    }
    await this.confirm(row);
  },

  /** Bulk pull reconciliation — this table has no client-facing edit UI, so server always wins. */
  async reconcileAllFromServer(
    rows: {
      user_id: string;
      exercise_id: string | null;
      custom_exercise_id: string | null;
      metric: string;
      value: number;
      unit_snapshot: string | null;
      source_set_log_id: string;
      timeline_event_id: string;
      achieved_at: string;
      previous_value: number | null;
    }[]
  ): Promise<void> {
    const db = await getDb();
    const now = new Date().toISOString();
    await db.withTransactionAsync(async () => {
      for (const row of rows) {
        const ref = exerciseRefKey(row.exercise_id, row.custom_exercise_id);
        await db.runAsync(
          `INSERT INTO strength_records (user_id, exercise_id, custom_exercise_id, exercise_ref, metric, value, unit_snapshot, source_set_log_id, timeline_event_id, achieved_at, previous_value, confirmed, updated_at)
           VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 1, ?)
           ON CONFLICT(user_id, exercise_ref, metric) DO UPDATE SET
             value = excluded.value, unit_snapshot = excluded.unit_snapshot, source_set_log_id = excluded.source_set_log_id,
             timeline_event_id = excluded.timeline_event_id, achieved_at = excluded.achieved_at,
             previous_value = excluded.previous_value, confirmed = 1, updated_at = excluded.updated_at`,
          [row.user_id, row.exercise_id, row.custom_exercise_id, ref, row.metric, row.value, row.unit_snapshot, row.source_set_log_id, row.timeline_event_id, row.achieved_at, row.previous_value, now]
        );
      }
    });
  },
};
