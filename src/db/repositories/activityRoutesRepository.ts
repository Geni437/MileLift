import { getDb } from '../client';
import type { LocalActivityRoute, RouteUploadStatus } from '../types';

type ActivityRouteRow = {
  activity_id: string;
  simplified_geojson: string;
  bounds_json: string | null;
  raw_track_object_path: string;
  raw_track_checksum: string | null;
  raw_point_count: number | null;
  simplified_point_count: number | null;
  raw_track_upload_status: string;
};

function toLocal(row: ActivityRouteRow): LocalActivityRoute {
  return {
    activityId: row.activity_id,
    simplifiedGeojson: row.simplified_geojson,
    boundsJson: row.bounds_json,
    rawTrackObjectPath: row.raw_track_object_path,
    rawTrackChecksum: row.raw_track_checksum,
    rawPointCount: row.raw_point_count,
    simplifiedPointCount: row.simplified_point_count,
    rawTrackUploadStatus: row.raw_track_upload_status as RouteUploadStatus,
  };
}

/**
 * Local mirror of `activity_routes` (architecture §1.4/§9). The map ALWAYS
 * draws from this local row regardless of raw-track upload state (design
 * doc CORE-02: "Never show a blank map for an activity that has a local
 * route").
 */
export const activityRoutesRepository = {
  async getByActivityId(activityId: string): Promise<LocalActivityRoute | null> {
    const db = await getDb();
    const row = await db.getFirstAsync<ActivityRouteRow>('SELECT * FROM activity_routes WHERE activity_id = ?', [
      activityId,
    ]);
    return row ? toLocal(row) : null;
  },

  async save(route: {
    activityId: string;
    simplifiedGeojson: string;
    boundsJson: string | null;
    rawTrackObjectPath: string;
    rawPointCount: number;
    simplifiedPointCount: number;
  }): Promise<void> {
    const db = await getDb();
    const now = new Date().toISOString();
    await db.runAsync(
      `INSERT INTO activity_routes (activity_id, simplified_geojson, bounds_json, raw_track_object_path, raw_track_checksum, raw_point_count, simplified_point_count, raw_track_upload_status, created_at)
       VALUES (?, ?, ?, ?, NULL, ?, ?, 'pending', ?)
       ON CONFLICT(activity_id) DO UPDATE SET
         simplified_geojson = excluded.simplified_geojson,
         bounds_json = excluded.bounds_json,
         raw_track_object_path = excluded.raw_track_object_path,
         raw_point_count = excluded.raw_point_count,
         simplified_point_count = excluded.simplified_point_count`,
      [
        route.activityId,
        route.simplifiedGeojson,
        route.boundsJson,
        route.rawTrackObjectPath,
        route.rawPointCount,
        route.simplifiedPointCount,
        now,
      ]
    );
  },

  async markUploaded(activityId: string, checksum: string): Promise<void> {
    const db = await getDb();
    await db.runAsync(
      `UPDATE activity_routes SET raw_track_upload_status = 'uploaded', raw_track_checksum = ? WHERE activity_id = ?`,
      [checksum, activityId]
    );
  },

  async markUploadFailed(activityId: string): Promise<void> {
    const db = await getDb();
    await db.runAsync(`UPDATE activity_routes SET raw_track_upload_status = 'failed' WHERE activity_id = ?`, [
      activityId,
    ]);
  },

  async getPendingUploads(): Promise<LocalActivityRoute[]> {
    const db = await getDb();
    const rows = await db.getAllAsync<ActivityRouteRow>(
      `SELECT * FROM activity_routes WHERE raw_track_upload_status IN ('pending', 'failed')`
    );
    return rows.map(toLocal);
  },

  /**
   * Of the given activity ids, returns the subset with no local
   * `activity_routes` row yet — the backfill target set for
   * `activitySync.pullActivityRoutes` (a route recorded on a different
   * device, or before a reinstall, is never persisted here until pulled).
   */
  async getMissingActivityIds(activityIds: string[]): Promise<string[]> {
    if (activityIds.length === 0) return [];
    const db = await getDb();
    const placeholders = activityIds.map(() => '?').join(',');
    const rows = await db.getAllAsync<{ activity_id: string }>(
      `SELECT activity_id FROM activity_routes WHERE activity_id IN (${placeholders})`,
      activityIds
    );
    const present = new Set(rows.map((r) => r.activity_id));
    return activityIds.filter((id) => !present.has(id));
  },

  /**
   * Persists a route pulled FROM the server (`activitySync.pullActivityRoutes`)
   * — distinct from `save()`, which is for a route this device just finished
   * recording and still needs to upload. A server-pulled route's raw track is
   * already durably in Storage (this device just doesn't have the raw points
   * locally to re-upload even if it wanted to), so it's stored as `uploaded`
   * up front rather than `pending` — leaving it `pending` would make a future
   * upload-retry job attempt to re-upload points that were never recorded on
   * this device.
   */
  async saveFromServer(route: {
    activityId: string;
    simplifiedGeojson: string;
    boundsJson: string | null;
    rawTrackObjectPath: string;
    rawTrackChecksum: string | null;
    rawPointCount: number | null;
    simplifiedPointCount: number | null;
  }): Promise<void> {
    const db = await getDb();
    const now = new Date().toISOString();
    await db.runAsync(
      `INSERT INTO activity_routes (activity_id, simplified_geojson, bounds_json, raw_track_object_path, raw_track_checksum, raw_point_count, simplified_point_count, raw_track_upload_status, created_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, 'uploaded', ?)
       ON CONFLICT(activity_id) DO UPDATE SET
         simplified_geojson = excluded.simplified_geojson,
         bounds_json = excluded.bounds_json,
         raw_track_object_path = excluded.raw_track_object_path,
         raw_track_checksum = excluded.raw_track_checksum,
         raw_point_count = excluded.raw_point_count,
         simplified_point_count = excluded.simplified_point_count,
         raw_track_upload_status = 'uploaded'`,
      [
        route.activityId,
        route.simplifiedGeojson,
        route.boundsJson,
        route.rawTrackObjectPath,
        route.rawTrackChecksum,
        route.rawPointCount,
        route.simplifiedPointCount,
        now,
      ]
    );
  },
};
