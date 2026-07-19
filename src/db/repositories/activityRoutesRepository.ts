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
};
