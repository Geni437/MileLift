import { getDb } from '../client';
import { generateUuidV4 } from '../../lib/uuid';
import type { LocalStrengthAchievement, StrengthPrMetric } from '../types';
import type { StrengthPrEvaluation } from '../../features/strength/strengthPrEngine';

type Row = {
  id: string;
  timeline_event_id: string;
  source_set_log_id: string;
  user_id: string;
  metric: string;
  value: number;
  is_optimistic: number;
};

function toLocal(row: Row): LocalStrengthAchievement {
  return {
    id: row.id,
    timelineEventId: row.timeline_event_id,
    sourceSetLogId: row.source_set_log_id,
    userId: row.user_id,
    metric: row.metric as StrengthPrMetric,
    value: row.value,
    isOptimistic: !!row.is_optimistic,
  };
}

/** Immutable per-set PR badge log (mirrors `strength_achievements`, architecture §4.3). */
export const strengthAchievementsRepository = {
  async getForSession(timelineEventId: string): Promise<LocalStrengthAchievement[]> {
    const db = await getDb();
    const rows = await db.getAllAsync<Row>('SELECT * FROM strength_achievements WHERE timeline_event_id = ?', [timelineEventId]);
    return rows.map(toLocal);
  },

  async getForSessions(timelineEventIds: string[]): Promise<Set<string>> {
    if (timelineEventIds.length === 0) return new Set();
    const db = await getDb();
    const placeholders = timelineEventIds.map(() => '?').join(',');
    const rows = await db.getAllAsync<{ timeline_event_id: string }>(
      `SELECT DISTINCT timeline_event_id FROM strength_achievements WHERE timeline_event_id IN (${placeholders})`,
      timelineEventIds
    );
    return new Set(rows.map((r) => r.timeline_event_id));
  },

  async applyOptimistic(timelineEventId: string, userId: string, evaluations: StrengthPrEvaluation[]): Promise<void> {
    if (evaluations.length === 0) return;
    const db = await getDb();
    await db.withTransactionAsync(async () => {
      for (const evaluation of evaluations) {
        await db.runAsync(
          `INSERT INTO strength_achievements (id, timeline_event_id, source_set_log_id, user_id, metric, value, is_optimistic, created_at)
           VALUES (?, ?, ?, ?, ?, ?, 1, ?)
           ON CONFLICT(source_set_log_id, metric) DO UPDATE SET value = excluded.value, is_optimistic = 1`,
          [generateUuidV4(), timelineEventId, evaluation.sourceSetLogId, userId, evaluation.metric, evaluation.value, new Date().toISOString()]
        );
      }
    });
  },

  async confirm(timelineEventId: string, sourceSetLogId: string, userId: string, metric: StrengthPrMetric, value: number): Promise<void> {
    const db = await getDb();
    await db.runAsync(
      `INSERT INTO strength_achievements (id, timeline_event_id, source_set_log_id, user_id, metric, value, is_optimistic, created_at)
       VALUES (?, ?, ?, ?, ?, ?, 0, ?)
       ON CONFLICT(source_set_log_id, metric) DO UPDATE SET value = excluded.value, is_optimistic = 0, timeline_event_id = excluded.timeline_event_id`,
      [generateUuidV4(), timelineEventId, sourceSetLogId, userId, metric, value, new Date().toISOString()]
    );
  },

  /**
   * Server did not confirm this exact optimistically-celebrated set+metric —
   * quietly remove it (never a second celebratory interruption, §CORE-17).
   * Scoped to the exact `(source_set_log_id, metric)` row — the same unique
   * key the table itself enforces — deliberately NOT `(timeline_event_id,
   * metric)`, which would also delete a DIFFERENT exercise's legitimately
   * server-confirmed achievement sharing the same metric within one session
   * (a session logs many exercises; two exercises can each earn, say,
   * `heaviest_weight` in the same save).
   */
  async retractOptimisticForSession(sourceSetLogId: string, metric: StrengthPrMetric): Promise<void> {
    const db = await getDb();
    await db.runAsync('DELETE FROM strength_achievements WHERE source_set_log_id = ? AND metric = ? AND is_optimistic = 1', [sourceSetLogId, metric]);
  },

  async reconcileAllFromServer(rows: { id: string; timeline_event_id: string; source_set_log_id: string; user_id: string; metric: string; value: number }[]): Promise<void> {
    const db = await getDb();
    await db.withTransactionAsync(async () => {
      for (const row of rows) {
        await db.runAsync(
          `INSERT INTO strength_achievements (id, timeline_event_id, source_set_log_id, user_id, metric, value, is_optimistic, created_at)
           VALUES (?, ?, ?, ?, ?, ?, 0, ?)
           ON CONFLICT(source_set_log_id, metric) DO UPDATE SET value = excluded.value, is_optimistic = 0`,
          [row.id, row.timeline_event_id, row.source_set_log_id, row.user_id, row.metric, row.value, new Date().toISOString()]
        );
      }
    });
  },
};
