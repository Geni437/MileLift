import { getDb } from '../client';
import type { LocalPersonalRecord, PrMetric } from '../types';
import type { PrEvaluation } from '../../features/activity/prEngine';

type PersonalRecordRow = {
  user_id: string;
  activity_type_code: string;
  metric: string;
  value: number;
  unit_snapshot: string | null;
  timeline_event_id: string;
  achieved_at: string;
  previous_value: number | null;
  confirmed: number;
};

function toLocal(row: PersonalRecordRow): LocalPersonalRecord {
  return {
    userId: row.user_id,
    activityTypeCode: row.activity_type_code,
    metric: row.metric as PrMetric,
    value: row.value,
    unitSnapshot: row.unit_snapshot,
    timelineEventId: row.timeline_event_id,
    achievedAt: row.achieved_at,
    previousValue: row.previous_value,
    confirmed: !!row.confirmed,
  };
}

/**
 * Cached "current best" per (user, type, metric) — architecture §4.2. Also
 * the base the optimistic-PR-celebration engine (`prEngine.ts`) compares
 * against, per design doc CORE-04's optimistic-then-reconciled flow.
 */
export const personalRecordsRepository = {
  async getForType(userId: string, activityTypeCode: string): Promise<Map<PrMetric, LocalPersonalRecord>> {
    const db = await getDb();
    const rows = await db.getAllAsync<PersonalRecordRow>(
      'SELECT * FROM personal_records WHERE user_id = ? AND activity_type_code = ?',
      [userId, activityTypeCode]
    );
    const map = new Map<PrMetric, LocalPersonalRecord>();
    for (const row of rows) {
      const record = toLocal(row);
      map.set(record.metric, record);
    }
    return map;
  },

  async getAllForUser(userId: string): Promise<LocalPersonalRecord[]> {
    const db = await getDb();
    const rows = await db.getAllAsync<PersonalRecordRow>(
      'SELECT * FROM personal_records WHERE user_id = ? ORDER BY activity_type_code ASC, metric ASC',
      [userId]
    );
    return rows.map(toLocal);
  },

  /** Writes the optimistic (unconfirmed) new records the instant a finish computes them — instant, offline-safe celebration. */
  async applyOptimistic(
    userId: string,
    activityTypeCode: string,
    timelineEventId: string,
    achievedAt: string,
    unitSnapshot: string | null,
    evaluations: PrEvaluation[]
  ): Promise<void> {
    if (evaluations.length === 0) return;
    const db = await getDb();
    const now = new Date().toISOString();
    await db.withTransactionAsync(async () => {
      for (const evaluation of evaluations) {
        await db.runAsync(
          `INSERT INTO personal_records (user_id, activity_type_code, metric, value, unit_snapshot, timeline_event_id, achieved_at, previous_value, confirmed, updated_at)
           VALUES (?, ?, ?, ?, ?, ?, ?, ?, 0, ?)
           ON CONFLICT(user_id, activity_type_code, metric) DO UPDATE SET
             value = excluded.value,
             unit_snapshot = excluded.unit_snapshot,
             timeline_event_id = excluded.timeline_event_id,
             achieved_at = excluded.achieved_at,
             previous_value = excluded.previous_value,
             confirmed = 0,
             updated_at = excluded.updated_at`,
          [
            userId,
            activityTypeCode,
            evaluation.metric,
            evaluation.value,
            unitSnapshot,
            timelineEventId,
            achievedAt,
            evaluation.previousValue,
            now,
          ]
        );
      }
    });
  },

  /** Server confirmed this metric for this activity — mark the cache row confirmed with the server's own values. */
  async confirm(
    userId: string,
    activityTypeCode: string,
    metric: PrMetric,
    value: number,
    unitSnapshot: string | null,
    timelineEventId: string,
    achievedAt: string
  ): Promise<void> {
    const db = await getDb();
    const now = new Date().toISOString();
    await db.runAsync(
      `INSERT INTO personal_records (user_id, activity_type_code, metric, value, unit_snapshot, timeline_event_id, achieved_at, previous_value, confirmed, updated_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, NULL, 1, ?)
       ON CONFLICT(user_id, activity_type_code, metric) DO UPDATE SET
         value = excluded.value,
         unit_snapshot = excluded.unit_snapshot,
         timeline_event_id = excluded.timeline_event_id,
         achieved_at = excluded.achieved_at,
         confirmed = 1,
         updated_at = excluded.updated_at`,
      [userId, activityTypeCode, metric, value, unitSnapshot, timelineEventId, achievedAt, now]
    );
  },

  /** Overwrites (or removes) a cache row from an authoritative server pull — used when reconciliation retracts an optimistic PR (§CORE-04). */
  async reconcileFromServerRow(row: {
    userId: string;
    activityTypeCode: string;
    metric: PrMetric;
    value: number;
    unitSnapshot: string | null;
    timelineEventId: string;
    achievedAt: string;
    previousValue: number | null;
  } | null, fallback: { userId: string; activityTypeCode: string; metric: PrMetric }): Promise<void> {
    const db = await getDb();
    if (!row) {
      await db.runAsync('DELETE FROM personal_records WHERE user_id = ? AND activity_type_code = ? AND metric = ?', [
        fallback.userId,
        fallback.activityTypeCode,
        fallback.metric,
      ]);
      return;
    }
    const now = new Date().toISOString();
    await db.runAsync(
      `INSERT INTO personal_records (user_id, activity_type_code, metric, value, unit_snapshot, timeline_event_id, achieved_at, previous_value, confirmed, updated_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, 1, ?)
       ON CONFLICT(user_id, activity_type_code, metric) DO UPDATE SET
         value = excluded.value,
         unit_snapshot = excluded.unit_snapshot,
         timeline_event_id = excluded.timeline_event_id,
         achieved_at = excluded.achieved_at,
         previous_value = excluded.previous_value,
         confirmed = 1,
         updated_at = excluded.updated_at`,
      [row.userId, row.activityTypeCode, row.metric, row.value, row.unitSnapshot, row.timelineEventId, row.achievedAt, row.previousValue, now]
    );
  },

  /** Bulk pull reconciliation — a `personal_records` row with an unconfirmed local edit is never expected (this table has no client-facing edit UI), so server always wins here. */
  async reconcileAllFromServer(
    rows: {
      user_id: string;
      activity_type_code: string;
      metric: string;
      value: number;
      unit_snapshot: string | null;
      timeline_event_id: string;
      achieved_at: string;
      previous_value: number | null;
    }[]
  ): Promise<void> {
    const db = await getDb();
    const now = new Date().toISOString();
    await db.withTransactionAsync(async () => {
      for (const row of rows) {
        await db.runAsync(
          `INSERT INTO personal_records (user_id, activity_type_code, metric, value, unit_snapshot, timeline_event_id, achieved_at, previous_value, confirmed, updated_at)
           VALUES (?, ?, ?, ?, ?, ?, ?, ?, 1, ?)
           ON CONFLICT(user_id, activity_type_code, metric) DO UPDATE SET
             value = excluded.value,
             unit_snapshot = excluded.unit_snapshot,
             timeline_event_id = excluded.timeline_event_id,
             achieved_at = excluded.achieved_at,
             previous_value = excluded.previous_value,
             confirmed = 1,
             updated_at = excluded.updated_at`,
          [
            row.user_id,
            row.activity_type_code,
            row.metric,
            row.value,
            row.unit_snapshot,
            row.timeline_event_id,
            row.achieved_at,
            row.previous_value,
            now,
          ]
        );
      }
    });
  },
};
