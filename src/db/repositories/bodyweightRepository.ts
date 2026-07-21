import { getDb } from '../client';
import type { LocalBodyweightLog, SyncStatus, UnitWeightSnapshot } from '../types';

type Row = {
  id: string;
  user_id: string;
  occurred_at: string;
  local_date: string;
  event_timezone: string;
  weight_kg: number;
  unit_weight_snapshot: string;
  body_fat_pct: number | null;
  source: string;
  notes: string | null;
  created_at: string | null;
  updated_at: string | null;
  deleted_at: string | null;
  server_confirmed: number;
  sync_status: string;
  last_sync_error: string | null;
};

/** The shape a server pull actually carries — no client-only sync bookkeeping columns (those are set explicitly by `reconcileFromServer` itself). */
export type ServerBodyweightRow = Pick<
  Row,
  'id' | 'user_id' | 'occurred_at' | 'local_date' | 'event_timezone' | 'weight_kg' | 'unit_weight_snapshot' | 'body_fat_pct' | 'source' | 'notes' | 'created_at' | 'updated_at' | 'deleted_at'
>;

function toLocal(row: Row): LocalBodyweightLog {
  return {
    id: row.id,
    userId: row.user_id,
    occurredAt: row.occurred_at,
    localDate: row.local_date,
    eventTimezone: row.event_timezone,
    weightKg: row.weight_kg,
    unitWeightSnapshot: row.unit_weight_snapshot as UnitWeightSnapshot,
    bodyFatPct: row.body_fat_pct,
    source: row.source as LocalBodyweightLog['source'],
    notes: row.notes,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
    deletedAt: row.deleted_at,
    serverConfirmed: !!row.server_confirmed,
    syncStatus: row.sync_status as SyncStatus,
    lastSyncError: row.last_sync_error,
  };
}

/** CORE-16 bodyweight log, health-consent-gated (checked at the UI layer before write, enforced again server-side by the DB trigger). */
export const bodyweightRepository = {
  async getLatest(userId: string): Promise<LocalBodyweightLog | null> {
    const db = await getDb();
    const row = await db.getFirstAsync<Row>(
      'SELECT * FROM bodyweight_logs WHERE user_id = ? AND deleted_at IS NULL ORDER BY occurred_at DESC LIMIT 1',
      [userId]
    );
    return row ? toLocal(row) : null;
  },

  async listForUser(userId: string, limit = 30): Promise<LocalBodyweightLog[]> {
    const db = await getDb();
    const rows = await db.getAllAsync<Row>(
      'SELECT * FROM bodyweight_logs WHERE user_id = ? AND deleted_at IS NULL ORDER BY occurred_at DESC LIMIT ?',
      [userId, limit]
    );
    return rows.map(toLocal);
  },

  async create(id: string, userId: string, fields: { occurredAt: string; localDate: string; eventTimezone: string; weightKg: number; unitWeightSnapshot: UnitWeightSnapshot; bodyFatPct: number | null; notes: string | null }): Promise<LocalBodyweightLog> {
    const db = await getDb();
    const now = new Date().toISOString();
    await db.runAsync(
      `INSERT INTO bodyweight_logs (id, user_id, occurred_at, local_date, event_timezone, weight_kg, unit_weight_snapshot, body_fat_pct, source, notes, created_at, updated_at, server_confirmed, sync_status)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, 'manual', ?, ?, ?, 0, 'pending')`,
      [id, userId, fields.occurredAt, fields.localDate, fields.eventTimezone, fields.weightKg, fields.unitWeightSnapshot, fields.bodyFatPct, fields.notes, now, now]
    );
    const row = await db.getFirstAsync<Row>('SELECT * FROM bodyweight_logs WHERE id = ?', [id]);
    return toLocal(row!);
  },

  async softDelete(id: string): Promise<void> {
    const db = await getDb();
    const now = new Date().toISOString();
    await db.runAsync(`UPDATE bodyweight_logs SET deleted_at = ?, updated_at = ?, sync_status = 'pending' WHERE id = ?`, [now, now, id]);
  },

  async wasServerConfirmed(id: string): Promise<boolean> {
    const db = await getDb();
    const row = await db.getFirstAsync<{ server_confirmed: number }>('SELECT server_confirmed FROM bodyweight_logs WHERE id = ?', [id]);
    return !!row?.server_confirmed;
  },

  async purgeLocalOnly(id: string): Promise<void> {
    const db = await getDb();
    await db.runAsync('DELETE FROM bodyweight_logs WHERE id = ? AND server_confirmed = 0', [id]);
  },

  async markSynced(id: string): Promise<void> {
    const db = await getDb();
    await db.runAsync(`UPDATE bodyweight_logs SET server_confirmed = 1, sync_status = 'synced', last_sync_error = NULL WHERE id = ?`, [id]);
  },

  async markFailed(id: string, message: string): Promise<void> {
    const db = await getDb();
    await db.runAsync(`UPDATE bodyweight_logs SET sync_status = 'failed', last_sync_error = ? WHERE id = ?`, [message, id]);
  },

  async getUnsynced(userId: string): Promise<LocalBodyweightLog[]> {
    const db = await getDb();
    const rows = await db.getAllAsync<Row>(`SELECT * FROM bodyweight_logs WHERE user_id = ? AND sync_status IN ('pending', 'failed')`, [userId]);
    return rows.map(toLocal);
  },

  async reconcileFromServer(rows: ServerBodyweightRow[]): Promise<void> {
    const db = await getDb();
    await db.withTransactionAsync(async () => {
      for (const row of rows) {
        const existing = await db.getFirstAsync<Row>('SELECT * FROM bodyweight_logs WHERE id = ?', [row.id]);
        if (existing && existing.sync_status !== 'synced') continue;
        await db.runAsync(
          `INSERT INTO bodyweight_logs (id, user_id, occurred_at, local_date, event_timezone, weight_kg, unit_weight_snapshot, body_fat_pct, source, notes, created_at, updated_at, deleted_at, server_confirmed, sync_status, last_sync_error)
           VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 1, 'synced', NULL)
           ON CONFLICT(id) DO UPDATE SET weight_kg = excluded.weight_kg, body_fat_pct = excluded.body_fat_pct, notes = excluded.notes, deleted_at = excluded.deleted_at, updated_at = excluded.updated_at, server_confirmed = 1, sync_status = 'synced', last_sync_error = NULL`,
          [row.id, row.user_id, row.occurred_at, row.local_date, row.event_timezone, row.weight_kg, row.unit_weight_snapshot, row.body_fat_pct, row.source, row.notes, row.created_at, row.updated_at, row.deleted_at]
        );
      }
    });
  },
};
