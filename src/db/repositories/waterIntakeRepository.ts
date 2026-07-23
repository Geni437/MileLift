import { getDb } from '../client';
import type { LocalWaterIntakeLog, SyncStatus, UnitVolumeSnapshot, WaterSource } from '../types';

type Row = {
  id: string;
  user_id: string;
  occurred_at: string;
  local_date: string;
  event_timezone: string;
  volume_ml: number;
  unit_volume_snapshot: string;
  source: string;
  created_at: string | null;
  updated_at: string | null;
  deleted_at: string | null;
  server_confirmed: number;
  sync_status: string;
  last_sync_error: string | null;
};

export type ServerWaterRow = Pick<
  Row,
  'id' | 'user_id' | 'occurred_at' | 'local_date' | 'event_timezone' | 'volume_ml' | 'unit_volume_snapshot' | 'source' | 'created_at' | 'updated_at' | 'deleted_at'
>;

function toLocal(row: Row): LocalWaterIntakeLog {
  return {
    id: row.id,
    userId: row.user_id,
    occurredAt: row.occurred_at,
    localDate: row.local_date,
    eventTimezone: row.event_timezone,
    volumeMl: row.volume_ml,
    unitVolumeSnapshot: row.unit_volume_snapshot as UnitVolumeSnapshot,
    source: row.source as WaterSource,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
    deletedAt: row.deleted_at,
    serverConfirmed: !!row.server_confirmed,
    syncStatus: row.sync_status as SyncStatus,
    lastSyncError: row.last_sync_error,
  };
}

/** CORE-09 — the fast, one-tap-immediate water logger (§1.7). Not consent-gated. */
export const waterIntakeRepository = {
  async listForLocalDate(userId: string, localDate: string): Promise<LocalWaterIntakeLog[]> {
    const db = await getDb();
    const rows = await db.getAllAsync<Row>(
      'SELECT * FROM water_intake_logs WHERE user_id = ? AND local_date = ? AND deleted_at IS NULL ORDER BY occurred_at ASC',
      [userId, localDate]
    );
    return rows.map(toLocal);
  },

  async getMostRecentForUser(userId: string): Promise<LocalWaterIntakeLog | null> {
    const db = await getDb();
    const row = await db.getFirstAsync<Row>('SELECT * FROM water_intake_logs WHERE user_id = ? AND deleted_at IS NULL ORDER BY occurred_at DESC LIMIT 1', [userId]);
    return row ? toLocal(row) : null;
  },

  async create(
    id: string,
    userId: string,
    fields: { occurredAt: string; localDate: string; eventTimezone: string; volumeMl: number; unitVolumeSnapshot: UnitVolumeSnapshot }
  ): Promise<LocalWaterIntakeLog> {
    const db = await getDb();
    const now = new Date().toISOString();
    await db.runAsync(
      `INSERT INTO water_intake_logs (id, user_id, occurred_at, local_date, event_timezone, volume_ml, unit_volume_snapshot, source, created_at, updated_at, server_confirmed, sync_status)
       VALUES (?, ?, ?, ?, ?, ?, ?, 'manual', ?, ?, 0, 'pending')`,
      [id, userId, fields.occurredAt, fields.localDate, fields.eventTimezone, fields.volumeMl, fields.unitVolumeSnapshot, now, now]
    );
    return (await this.getById(id))!;
  },

  async getById(id: string): Promise<LocalWaterIntakeLog | null> {
    const db = await getDb();
    const row = await db.getFirstAsync<Row>('SELECT * FROM water_intake_logs WHERE id = ?', [id]);
    return row ? toLocal(row) : null;
  },

  /** CORE-09 undo — a mis-tap on the one-tap preset chip must be reversible for a few seconds. */
  async softDelete(id: string): Promise<void> {
    const db = await getDb();
    const now = new Date().toISOString();
    await db.runAsync(`UPDATE water_intake_logs SET deleted_at = ?, updated_at = ?, sync_status = 'pending', last_sync_error = NULL WHERE id = ?`, [now, now, id]);
  },

  async wasServerConfirmed(id: string): Promise<boolean> {
    const db = await getDb();
    const row = await db.getFirstAsync<{ server_confirmed: number }>('SELECT server_confirmed FROM water_intake_logs WHERE id = ?', [id]);
    return !!row?.server_confirmed;
  },

  async purgeLocalOnly(id: string): Promise<void> {
    const db = await getDb();
    await db.runAsync('DELETE FROM water_intake_logs WHERE id = ? AND server_confirmed = 0', [id]);
  },

  async markSynced(id: string): Promise<void> {
    const db = await getDb();
    await db.runAsync(`UPDATE water_intake_logs SET server_confirmed = 1, sync_status = 'synced', last_sync_error = NULL WHERE id = ?`, [id]);
  },

  async markFailed(id: string, message: string): Promise<void> {
    const db = await getDb();
    await db.runAsync(`UPDATE water_intake_logs SET sync_status = 'failed', last_sync_error = ? WHERE id = ?`, [message, id]);
  },

  async getUnsynced(userId: string): Promise<LocalWaterIntakeLog[]> {
    const db = await getDb();
    const rows = await db.getAllAsync<Row>(`SELECT * FROM water_intake_logs WHERE user_id = ? AND sync_status IN ('pending', 'failed')`, [userId]);
    return rows.map(toLocal);
  },

  async reconcileFromServer(rows: ServerWaterRow[]): Promise<void> {
    const db = await getDb();
    await db.withTransactionAsync(async () => {
      for (const row of rows) {
        const existing = await db.getFirstAsync<Row>('SELECT * FROM water_intake_logs WHERE id = ?', [row.id]);
        if (existing && existing.sync_status !== 'synced') continue;
        await db.runAsync(
          `INSERT INTO water_intake_logs (id, user_id, occurred_at, local_date, event_timezone, volume_ml, unit_volume_snapshot, source, created_at, updated_at, deleted_at, server_confirmed, sync_status, last_sync_error)
           VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 1, 'synced', NULL)
           ON CONFLICT(id) DO UPDATE SET volume_ml = excluded.volume_ml, unit_volume_snapshot = excluded.unit_volume_snapshot, deleted_at = excluded.deleted_at, updated_at = excluded.updated_at, server_confirmed = 1, sync_status = 'synced', last_sync_error = NULL`,
          [row.id, row.user_id, row.occurred_at, row.local_date, row.event_timezone, row.volume_ml, row.unit_volume_snapshot, row.source, row.created_at, row.updated_at, row.deleted_at]
        );
      }
    });
  },
};
