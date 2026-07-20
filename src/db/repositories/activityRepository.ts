import { getDb } from '../client';
import type {
  ActivitySource,
  ActivityVisibility,
  ActivityWritableFields,
  CaloriesSource,
  LocalActivity,
  SyncStatus,
  UnitDistanceSnapshot,
} from '../types';

type ActivityRow = {
  id: string;
  user_id: string;
  activity_type_code: string;
  activity_type_name_snapshot: string;
  title: string | null;
  description: string | null;
  occurred_at: string;
  local_date: string;
  event_timezone: string;
  duration_seconds: number;
  moving_time_seconds: number | null;
  distance_m: number | null;
  unit_distance_snapshot: string;
  elevation_gain_m: number | null;
  elevation_loss_m: number | null;
  average_speed_mps: number | null;
  max_speed_mps: number | null;
  average_hr: number | null;
  max_hr: number | null;
  has_gps_route: number;
  energy_kcal: number | null;
  calories_source: string;
  source: string;
  visibility: string;
  client_created_at: string | null;
  created_at: string | null;
  updated_at: string | null;
  deleted_at: string | null;
  kudos_count: number;
  kudos_count_fetched_at: string | null;
  server_confirmed: number;
  sync_status: string;
  last_sync_error: string | null;
};

function toLocal(row: ActivityRow): LocalActivity {
  return {
    id: row.id,
    userId: row.user_id,
    activityTypeCode: row.activity_type_code,
    activityTypeNameSnapshot: row.activity_type_name_snapshot,
    title: row.title,
    description: row.description,
    occurredAt: row.occurred_at,
    localDate: row.local_date,
    eventTimezone: row.event_timezone,
    durationSeconds: row.duration_seconds,
    movingTimeSeconds: row.moving_time_seconds,
    distanceM: row.distance_m,
    unitDistanceSnapshot: row.unit_distance_snapshot as UnitDistanceSnapshot,
    elevationGainM: row.elevation_gain_m,
    elevationLossM: row.elevation_loss_m,
    averageSpeedMps: row.average_speed_mps,
    maxSpeedMps: row.max_speed_mps,
    averageHr: row.average_hr,
    maxHr: row.max_hr,
    hasGpsRoute: !!row.has_gps_route,
    energyKcal: row.energy_kcal,
    caloriesSource: row.calories_source as CaloriesSource,
    source: row.source as ActivitySource,
    visibility: row.visibility as ActivityVisibility,
    clientCreatedAt: row.client_created_at,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
    deletedAt: row.deleted_at,
    kudosCount: row.kudos_count,
    kudosCountFetchedAt: row.kudos_count_fetched_at,
    syncStatus: row.sync_status as SyncStatus,
    lastSyncError: row.last_sync_error,
  };
}

export type ActivityPage = { items: LocalActivity[]; nextCursor: { occurredAt: string; id: string } | null };

/** The flat shape `activitySync.ts` maps a server pull into before calling `reconcileFromServer`. */
export type ServerActivityRow = {
  id: string;
  user_id: string;
  activity_type_code: string;
  activity_type_name_snapshot: string;
  title: string | null;
  description: string | null;
  occurred_at: string;
  local_date: string;
  event_timezone: string;
  duration_seconds: number;
  moving_time_seconds: number | null;
  distance_m: number | null;
  unit_distance_snapshot: string;
  elevation_gain_m: number | null;
  elevation_loss_m: number | null;
  average_speed_mps: number | null;
  max_speed_mps: number | null;
  average_hr: number | null;
  max_hr: number | null;
  has_gps_route: boolean;
  energy_kcal: number | null;
  calories_source: string;
  source: string;
  visibility: string;
  client_created_at: string | null;
  created_at: string;
  updated_at: string;
  deleted_at: string | null;
};

/**
 * Local-first repository for `activities` (the merged spine+detail mirror —
 * see schema.ts header note). Screens read exclusively through this, never
 * `supabase.from(...)` directly (mobile-architecture-standards).
 */
export const activityRepository = {
  async getLocal(id: string): Promise<LocalActivity | null> {
    const db = await getDb();
    const row = await db.getFirstAsync<ActivityRow>('SELECT * FROM activities WHERE id = ?', [id]);
    return row ? toLocal(row) : null;
  },

  /** Cursor-based pagination on (occurred_at, id) DESC — most recent first, per architecture §5. */
  async listPage(userId: string, cursor: { occurredAt: string; id: string } | null, limit = 20): Promise<ActivityPage> {
    const db = await getDb();
    const rows = cursor
      ? await db.getAllAsync<ActivityRow>(
          `SELECT * FROM activities
           WHERE user_id = ? AND deleted_at IS NULL
             AND (occurred_at < ? OR (occurred_at = ? AND id < ?))
           ORDER BY occurred_at DESC, id DESC
           LIMIT ?`,
          [userId, cursor.occurredAt, cursor.occurredAt, cursor.id, limit + 1]
        )
      : await db.getAllAsync<ActivityRow>(
          `SELECT * FROM activities
           WHERE user_id = ? AND deleted_at IS NULL
           ORDER BY occurred_at DESC, id DESC
           LIMIT ?`,
          [userId, limit + 1]
        );

    const hasMore = rows.length > limit;
    const page = hasMore ? rows.slice(0, limit) : rows;
    const items = page.map(toLocal);
    const last = items[items.length - 1];
    return {
      items,
      nextCursor: hasMore && last ? { occurredAt: last.occurredAt, id: last.id } : null,
    };
  },

  /**
   * Manually-recorded, server-confirmed activities — the Health Connect
   * write-back candidate set (architecture §3.2: MileLift-recorded
   * activities get written back, not wearable-imported ones — writing an
   * imported session back to where it came from would be the exact loop
   * §3.3 exists to prevent). Bounded to the most recent `limit`, not an
   * exhaustive backlog scan — a stated, reasonable simplification given a
   * Health Connect sync runs opportunistically and repeatedly, not once.
   */
  async getManualConfirmedForUser(userId: string, limit = 50): Promise<LocalActivity[]> {
    const db = await getDb();
    const rows = await db.getAllAsync<ActivityRow>(
      `SELECT * FROM activities
       WHERE user_id = ? AND source = 'manual' AND server_confirmed = 1 AND deleted_at IS NULL
       ORDER BY occurred_at DESC
       LIMIT ?`,
      [userId, limit]
    );
    return rows.map(toLocal);
  },

  /**
   * Ids of this user's non-deleted, server-confirmed GPS activities — the
   * candidate set `activitySync.pullActivityRoutes` checks against the local
   * `activity_routes` table for a missing route (recorded on a different
   * device, or before a reinstall). Scoped to `server_confirmed = 1` since
   * an activity the server has never seen has no server-side route to pull
   * either.
   */
  async getGpsActivityIdsForUser(userId: string): Promise<string[]> {
    const db = await getDb();
    const rows = await db.getAllAsync<{ id: string }>(
      `SELECT id FROM activities WHERE user_id = ? AND has_gps_route = 1 AND deleted_at IS NULL AND server_confirmed = 1`,
      [userId]
    );
    return rows.map((r) => r.id);
  },

  async countForUser(userId: string): Promise<number> {
    const db = await getDb();
    const row = await db.getFirstAsync<{ n: number }>(
      'SELECT COUNT(*) as n FROM activities WHERE user_id = ? AND deleted_at IS NULL',
      [userId]
    );
    return row?.n ?? 0;
  },

  /** Optimistic local write for a brand-new activity (finish flow) or a full re-save (edit flow). `id` is the client-generated idempotency key. */
  async upsertLocal(id: string, userId: string, fields: ActivityWritableFields): Promise<LocalActivity> {
    const db = await getDb();
    const now = new Date().toISOString();

    await db.runAsync(
      `INSERT INTO activities (
         id, user_id, activity_type_code, activity_type_name_snapshot, title, description,
         occurred_at, local_date, event_timezone, duration_seconds, moving_time_seconds,
         distance_m, unit_distance_snapshot, elevation_gain_m, elevation_loss_m,
         average_speed_mps, max_speed_mps, average_hr, max_hr, has_gps_route,
         energy_kcal, calories_source, source, visibility, client_created_at,
         updated_at, sync_status, last_sync_error
       ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'pending', NULL)
       ON CONFLICT(id) DO UPDATE SET
         activity_type_code = excluded.activity_type_code,
         activity_type_name_snapshot = excluded.activity_type_name_snapshot,
         title = excluded.title,
         description = excluded.description,
         occurred_at = excluded.occurred_at,
         local_date = excluded.local_date,
         event_timezone = excluded.event_timezone,
         duration_seconds = excluded.duration_seconds,
         moving_time_seconds = excluded.moving_time_seconds,
         distance_m = excluded.distance_m,
         unit_distance_snapshot = excluded.unit_distance_snapshot,
         elevation_gain_m = excluded.elevation_gain_m,
         elevation_loss_m = excluded.elevation_loss_m,
         average_speed_mps = excluded.average_speed_mps,
         max_speed_mps = excluded.max_speed_mps,
         average_hr = excluded.average_hr,
         max_hr = excluded.max_hr,
         has_gps_route = excluded.has_gps_route,
         energy_kcal = excluded.energy_kcal,
         calories_source = excluded.calories_source,
         source = excluded.source,
         visibility = excluded.visibility,
         updated_at = excluded.updated_at,
         sync_status = 'pending',
         last_sync_error = NULL`,
      [
        id,
        userId,
        fields.activityTypeCode,
        fields.activityTypeNameSnapshot,
        fields.title ?? null,
        fields.description ?? null,
        fields.occurredAt,
        fields.localDate,
        fields.eventTimezone,
        fields.durationSeconds,
        fields.movingTimeSeconds ?? null,
        fields.distanceM ?? null,
        fields.unitDistanceSnapshot,
        fields.elevationGainM ?? null,
        fields.elevationLossM ?? null,
        fields.averageSpeedMps ?? null,
        fields.maxSpeedMps ?? null,
        fields.averageHr ?? null,
        fields.maxHr ?? null,
        fields.hasGpsRoute ? 1 : 0,
        fields.energyKcal ?? null,
        fields.caloriesSource,
        fields.source,
        fields.visibility ?? 'private',
        fields.clientCreatedAt ?? now,
        now,
      ]
    );

    return (await this.getLocal(id))!;
  },

  /** Soft-delete: local-first, mirrors the spine's deleted_at tombstone (architecture §7/§8 — no client DELETE). */
  async softDelete(id: string): Promise<void> {
    const db = await getDb();
    const now = new Date().toISOString();
    await db.runAsync(
      `UPDATE activities SET deleted_at = ?, updated_at = ?, sync_status = 'pending', last_sync_error = NULL WHERE id = ?`,
      [now, now, id]
    );
  },

  /** Applied right after a successful `save_activity_v1` call — accepts the server's confirmed fields and clears the pending flag. */
  async markSynced(
    id: string,
    serverFields: { distanceM: number | null; durationSeconds: number; movingTimeSeconds: number | null; hasGpsRoute: boolean; energyKcal: number | null }
  ): Promise<void> {
    const db = await getDb();
    const now = new Date().toISOString();
    await db.runAsync(
      `UPDATE activities SET
         distance_m = ?, duration_seconds = ?, moving_time_seconds = ?, has_gps_route = ?, energy_kcal = ?,
         created_at = COALESCE(created_at, ?), updated_at = ?, server_confirmed = 1,
         sync_status = 'synced', last_sync_error = NULL
       WHERE id = ?`,
      [
        serverFields.distanceM,
        serverFields.durationSeconds,
        serverFields.movingTimeSeconds,
        serverFields.hasGpsRoute ? 1 : 0,
        serverFields.energyKcal,
        now,
        now,
        id,
      ]
    );
  },

  /** A tombstone push (soft-delete) succeeded — no field reconciliation needed, just clear pending. */
  async markDeleteSynced(id: string): Promise<void> {
    const db = await getDb();
    await db.runAsync(`UPDATE activities SET sync_status = 'synced', last_sync_error = NULL WHERE id = ?`, [id]);
  },

  async markFailed(id: string, errorMessage: string): Promise<void> {
    const db = await getDb();
    await db.runAsync(`UPDATE activities SET sync_status = 'failed', last_sync_error = ? WHERE id = ?`, [
      errorMessage,
      id,
    ]);
  },

  /** Rows that still need a push — new/edited saves and delete-tombstones alike. */
  async getUnsynced(userId: string): Promise<LocalActivity[]> {
    const db = await getDb();
    const rows = await db.getAllAsync<ActivityRow>(
      `SELECT * FROM activities WHERE user_id = ? AND sync_status IN ('pending', 'failed') ORDER BY occurred_at ASC`,
      [userId]
    );
    return rows.map(toLocal);
  },

  /** An activity deleted before it was ever confirmed by the server needs no network call at all — just drop it locally. */
  async purgeLocalOnly(id: string): Promise<void> {
    const db = await getDb();
    await db.runAsync('DELETE FROM activities WHERE id = ? AND server_confirmed = 0', [id]);
  },

  async wasServerConfirmed(id: string): Promise<boolean> {
    const db = await getDb();
    const row = await db.getFirstAsync<{ server_confirmed: number }>(
      'SELECT server_confirmed FROM activities WHERE id = ?',
      [id]
    );
    return !!row?.server_confirmed;
  },

  /** Reconciles a page of rows pulled from the server (own read via PostgREST). A local row with an uncommitted edit/delete is left alone (§3.5 LWW-at-row-grain, but never clobbering an unsynced local edit). */
  async reconcileFromServer(rows: ServerActivityRow[]): Promise<void> {
    const db = await getDb();
    await db.withTransactionAsync(async () => {
      for (const raw of rows) {
        const id = raw.id;
        const existing = await db.getFirstAsync<ActivityRow>('SELECT * FROM activities WHERE id = ?', [id]);
        if (existing && existing.sync_status !== 'synced') continue;

        const deletedAt = raw.deleted_at;
        await db.runAsync(
          `INSERT INTO activities (
             id, user_id, activity_type_code, activity_type_name_snapshot, title, description,
             occurred_at, local_date, event_timezone, duration_seconds, moving_time_seconds,
             distance_m, unit_distance_snapshot, elevation_gain_m, elevation_loss_m,
             average_speed_mps, max_speed_mps, average_hr, max_hr, has_gps_route,
             energy_kcal, calories_source, source, visibility, client_created_at,
             created_at, updated_at, deleted_at, server_confirmed, sync_status, last_sync_error
           ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 1, 'synced', NULL)
           ON CONFLICT(id) DO UPDATE SET
             activity_type_code = excluded.activity_type_code,
             activity_type_name_snapshot = excluded.activity_type_name_snapshot,
             title = excluded.title,
             description = excluded.description,
             occurred_at = excluded.occurred_at,
             local_date = excluded.local_date,
             event_timezone = excluded.event_timezone,
             duration_seconds = excluded.duration_seconds,
             moving_time_seconds = excluded.moving_time_seconds,
             distance_m = excluded.distance_m,
             unit_distance_snapshot = excluded.unit_distance_snapshot,
             elevation_gain_m = excluded.elevation_gain_m,
             elevation_loss_m = excluded.elevation_loss_m,
             average_speed_mps = excluded.average_speed_mps,
             max_speed_mps = excluded.max_speed_mps,
             average_hr = excluded.average_hr,
             max_hr = excluded.max_hr,
             has_gps_route = excluded.has_gps_route,
             energy_kcal = excluded.energy_kcal,
             calories_source = excluded.calories_source,
             visibility = excluded.visibility,
             updated_at = excluded.updated_at,
             deleted_at = excluded.deleted_at,
             server_confirmed = 1,
             sync_status = 'synced',
             last_sync_error = NULL`,
          [
            id,
            raw.user_id,
            raw.activity_type_code,
            raw.activity_type_name_snapshot,
            raw.title ?? null,
            raw.description ?? null,
            raw.occurred_at,
            raw.local_date,
            raw.event_timezone,
            raw.duration_seconds,
            raw.moving_time_seconds ?? null,
            raw.distance_m ?? null,
            raw.unit_distance_snapshot,
            raw.elevation_gain_m ?? null,
            raw.elevation_loss_m ?? null,
            raw.average_speed_mps ?? null,
            raw.max_speed_mps ?? null,
            raw.average_hr ?? null,
            raw.max_hr ?? null,
            raw.has_gps_route ? 1 : 0,
            raw.energy_kcal ?? null,
            raw.calories_source,
            raw.source,
            raw.visibility,
            raw.client_created_at ?? null,
            raw.created_at,
            raw.updated_at,
            deletedAt,
          ]
        );
      }
    });
  },
};

export type { ActivityRow };
