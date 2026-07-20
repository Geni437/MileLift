import { getDb } from '../client';
import { generateUuidV4 } from '../../lib/uuid';
import type { AchievementRank, LocalAchievement, PrMetric } from '../types';
import type { PrEvaluation } from '../../features/activity/prEngine';

type AchievementRow = {
  id: string;
  timeline_event_id: string;
  user_id: string;
  metric: string;
  value: number;
  rank: string | null;
  is_optimistic: number;
};

function toLocal(row: AchievementRow): LocalAchievement {
  return {
    id: row.id,
    timelineEventId: row.timeline_event_id,
    userId: row.user_id,
    metric: row.metric as PrMetric,
    value: row.value,
    rank: row.rank as AchievementRank | null,
    isOptimistic: !!row.is_optimistic,
  };
}

/**
 * Immutable per-activity PR badge log (mirrors `activity_achievements`).
 * Rows written optimistically at finish are marked `is_optimistic`; the
 * reconciliation pass either clears that flag (server confirmed) or deletes
 * the row (server retracted) — see `prEngine.diffAchievements`.
 */
export const activityAchievementsRepository = {
  async getForActivity(timelineEventId: string): Promise<LocalAchievement[]> {
    const db = await getDb();
    const rows = await db.getAllAsync<AchievementRow>(
      'SELECT * FROM activity_achievements WHERE timeline_event_id = ? ORDER BY metric ASC',
      [timelineEventId]
    );
    return rows.map(toLocal);
  },

  /**
   * Batched "which of these activities have at least one PR badge" check —
   * one query for a whole page instead of `getForActivity` called once per
   * row (the N+1 pattern `useActivityLog`'s PR-badge lookup used to have).
   * Returns just the ids that have a badge, not the badges themselves, since
   * that's all the log/history row needs to decide whether to render
   * `PrBadge`.
   */
  async getForActivities(timelineEventIds: string[]): Promise<Set<string>> {
    if (timelineEventIds.length === 0) return new Set();
    const db = await getDb();
    const placeholders = timelineEventIds.map(() => '?').join(',');
    const rows = await db.getAllAsync<{ timeline_event_id: string }>(
      `SELECT DISTINCT timeline_event_id FROM activity_achievements WHERE timeline_event_id IN (${placeholders})`,
      timelineEventIds
    );
    return new Set(rows.map((r) => r.timeline_event_id));
  },

  async applyOptimistic(timelineEventId: string, userId: string, evaluations: PrEvaluation[]): Promise<void> {
    if (evaluations.length === 0) return;
    const db = await getDb();
    await db.withTransactionAsync(async () => {
      for (const evaluation of evaluations) {
        await db.runAsync(
          `INSERT INTO activity_achievements (id, timeline_event_id, user_id, metric, value, rank, is_optimistic, created_at)
           VALUES (?, ?, ?, ?, ?, 'pr', 1, ?)`,
          [generateUuidV4(), timelineEventId, userId, evaluation.metric, evaluation.value, new Date().toISOString()]
        );
      }
    });
  },

  /** Server confirmed this metric for this activity — clear the optimistic flag and align the value/rank with the authoritative response. */
  async confirm(timelineEventId: string, metric: PrMetric, value: number, rank: AchievementRank | null): Promise<void> {
    const db = await getDb();
    const existing = await db.getFirstAsync<AchievementRow>(
      'SELECT * FROM activity_achievements WHERE timeline_event_id = ? AND metric = ?',
      [timelineEventId, metric]
    );
    if (existing) {
      await db.runAsync(
        `UPDATE activity_achievements SET value = ?, rank = ?, is_optimistic = 0 WHERE timeline_event_id = ? AND metric = ?`,
        [value, rank, timelineEventId, metric]
      );
    } else {
      await db.runAsync(
        `INSERT INTO activity_achievements (id, timeline_event_id, user_id, metric, value, rank, is_optimistic, created_at)
         VALUES (?, ?, (SELECT user_id FROM activities WHERE id = ?), ?, ?, ?, 0, ?)`,
        [generateUuidV4(), timelineEventId, timelineEventId, metric, value, rank, new Date().toISOString()]
      );
    }
  },

  /** Server did not confirm this optimistically-celebrated metric — remove the badge quietly (§CORE-04: "never a second celebratory interruption"). */
  async retract(timelineEventId: string, metric: PrMetric): Promise<void> {
    const db = await getDb();
    await db.runAsync('DELETE FROM activity_achievements WHERE timeline_event_id = ? AND metric = ? AND is_optimistic = 1', [
      timelineEventId,
      metric,
    ]);
  },

  /** Bulk pull reconciliation for a page of activities' worth of achievements. */
  async reconcileAllFromServer(
    rows: { id: string; timeline_event_id: string; user_id: string; metric: string; value: number; rank: string | null }[]
  ): Promise<void> {
    const db = await getDb();
    await db.withTransactionAsync(async () => {
      for (const row of rows) {
        await db.runAsync(
          `INSERT INTO activity_achievements (id, timeline_event_id, user_id, metric, value, rank, is_optimistic, created_at)
           VALUES (?, ?, ?, ?, ?, ?, 0, ?)
           ON CONFLICT(timeline_event_id, metric) DO UPDATE SET
             value = excluded.value,
             rank = excluded.rank,
             is_optimistic = 0`,
          [row.id, row.timeline_event_id, row.user_id, row.metric, row.value, row.rank, new Date().toISOString()]
        );
      }
    });
  },
};
