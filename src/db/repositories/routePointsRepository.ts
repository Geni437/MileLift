import { getDb } from '../client';
import type { GeoPoint } from '../types';

type RoutePointRow = {
  session_id: string;
  seq: number;
  latitude: number;
  longitude: number;
  elevation_m: number | null;
  accuracy_m: number | null;
  recorded_at: string;
  is_moving: number;
};

function toLocal(row: RoutePointRow): GeoPoint {
  return {
    latitude: row.latitude,
    longitude: row.longitude,
    elevationM: row.elevation_m,
    accuracyM: row.accuracy_m,
    recordedAt: row.recorded_at,
    isMoving: !!row.is_moving,
  };
}

/**
 * Local-only, in-progress-recording GPS buffer (architecture §2.1: "the
 * per-point write firehose lands in local SQLite ... never streamed
 * point-by-point to Postgres"). Cleared after a successful finish (§9:
 * "consumed into the finished activity and can be cleared").
 */
export const routePointsRepository = {
  async append(sessionId: string, point: GeoPoint): Promise<void> {
    const db = await getDb();
    const row = await db.getFirstAsync<{ maxSeq: number | null }>(
      'SELECT MAX(seq) as maxSeq FROM route_points_local WHERE session_id = ?',
      [sessionId]
    );
    const nextSeq = (row?.maxSeq ?? -1) + 1;
    await db.runAsync(
      `INSERT INTO route_points_local (session_id, seq, latitude, longitude, elevation_m, accuracy_m, recorded_at, is_moving)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
      [sessionId, nextSeq, point.latitude, point.longitude, point.elevationM, point.accuracyM, point.recordedAt, point.isMoving ? 1 : 0]
    );
  },

  async getAll(sessionId: string): Promise<GeoPoint[]> {
    const db = await getDb();
    const rows = await db.getAllAsync<RoutePointRow>(
      'SELECT * FROM route_points_local WHERE session_id = ? ORDER BY seq ASC',
      [sessionId]
    );
    return rows.map(toLocal);
  },

  async count(sessionId: string): Promise<number> {
    const db = await getDb();
    const row = await db.getFirstAsync<{ n: number }>(
      'SELECT COUNT(*) as n FROM route_points_local WHERE session_id = ?',
      [sessionId]
    );
    return row?.n ?? 0;
  },

  async clear(sessionId: string): Promise<void> {
    const db = await getDb();
    await db.runAsync('DELETE FROM route_points_local WHERE session_id = ?', [sessionId]);
  },
};
