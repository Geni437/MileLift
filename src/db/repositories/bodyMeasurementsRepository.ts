import { getDb } from '../client';
import type { LocalBodyMeasurement, LocalBodyMeasurementValue, MeasurementKind, MeasurementUnitSnapshot, SyncStatus } from '../types';

type Row = {
  id: string;
  user_id: string;
  occurred_at: string;
  local_date: string;
  event_timezone: string;
  notes: string | null;
  created_at: string | null;
  updated_at: string | null;
  deleted_at: string | null;
  server_confirmed: number;
  sync_status: string;
  last_sync_error: string | null;
};

type ValueRow = { timeline_event_id: string; measurement_kind: string; value: number; unit_snapshot: string };

async function loadValues(timelineEventId: string): Promise<LocalBodyMeasurementValue[]> {
  const db = await getDb();
  const rows = await db.getAllAsync<ValueRow>('SELECT * FROM body_measurement_values WHERE timeline_event_id = ?', [timelineEventId]);
  return rows.map((r) => ({ measurementKind: r.measurement_kind as MeasurementKind, value: r.value, unitSnapshot: r.unit_snapshot as MeasurementUnitSnapshot }));
}

async function toLocal(row: Row): Promise<LocalBodyMeasurement> {
  return {
    id: row.id,
    userId: row.user_id,
    occurredAt: row.occurred_at,
    localDate: row.local_date,
    eventTimezone: row.event_timezone,
    notes: row.notes,
    values: await loadValues(row.id),
    createdAt: row.created_at,
    updatedAt: row.updated_at,
    deletedAt: row.deleted_at,
    serverConfirmed: !!row.server_confirmed,
    syncStatus: row.sync_status as SyncStatus,
    lastSyncError: row.last_sync_error,
  };
}

/** CORE-16 body measurements (one occasion, multiple sites), health-consent-gated. */
export const bodyMeasurementsRepository = {
  async listForUser(userId: string, limit = 30): Promise<LocalBodyMeasurement[]> {
    const db = await getDb();
    const rows = await db.getAllAsync<Row>('SELECT * FROM body_measurements WHERE user_id = ? AND deleted_at IS NULL ORDER BY occurred_at DESC LIMIT ?', [userId, limit]);
    const results: LocalBodyMeasurement[] = [];
    for (const row of rows) results.push(await toLocal(row));
    return results;
  },

  async latestValuePerKind(userId: string): Promise<Map<MeasurementKind, LocalBodyMeasurementValue>> {
    const all = await this.listForUser(userId, 60);
    const map = new Map<MeasurementKind, LocalBodyMeasurementValue>();
    for (const occasion of all) {
      for (const v of occasion.values) {
        if (!map.has(v.measurementKind)) map.set(v.measurementKind, v);
      }
    }
    return map;
  },

  async create(id: string, userId: string, fields: { occurredAt: string; localDate: string; eventTimezone: string; notes: string | null; values: LocalBodyMeasurementValue[] }): Promise<LocalBodyMeasurement> {
    const db = await getDb();
    const now = new Date().toISOString();
    await db.withTransactionAsync(async () => {
      await db.runAsync(
        `INSERT INTO body_measurements (id, user_id, occurred_at, local_date, event_timezone, notes, created_at, updated_at, server_confirmed, sync_status)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, 0, 'pending')`,
        [id, userId, fields.occurredAt, fields.localDate, fields.eventTimezone, fields.notes, now, now]
      );
      for (const v of fields.values) {
        await db.runAsync(
          `INSERT INTO body_measurement_values (timeline_event_id, measurement_kind, value, unit_snapshot) VALUES (?, ?, ?, ?)
           ON CONFLICT(timeline_event_id, measurement_kind) DO UPDATE SET value = excluded.value, unit_snapshot = excluded.unit_snapshot`,
          [id, v.measurementKind, v.value, v.unitSnapshot]
        );
      }
    });
    const row = await db.getFirstAsync<Row>('SELECT * FROM body_measurements WHERE id = ?', [id]);
    return toLocal(row!);
  },

  async softDelete(id: string): Promise<void> {
    const db = await getDb();
    const now = new Date().toISOString();
    await db.runAsync(`UPDATE body_measurements SET deleted_at = ?, updated_at = ?, sync_status = 'pending' WHERE id = ?`, [now, now, id]);
  },

  async wasServerConfirmed(id: string): Promise<boolean> {
    const db = await getDb();
    const row = await db.getFirstAsync<{ server_confirmed: number }>('SELECT server_confirmed FROM body_measurements WHERE id = ?', [id]);
    return !!row?.server_confirmed;
  },

  async purgeLocalOnly(id: string): Promise<void> {
    const db = await getDb();
    await db.withTransactionAsync(async () => {
      await db.runAsync('DELETE FROM body_measurement_values WHERE timeline_event_id = ?', [id]);
      await db.runAsync('DELETE FROM body_measurements WHERE id = ? AND server_confirmed = 0', [id]);
    });
  },

  async markSynced(id: string): Promise<void> {
    const db = await getDb();
    await db.runAsync(`UPDATE body_measurements SET server_confirmed = 1, sync_status = 'synced', last_sync_error = NULL WHERE id = ?`, [id]);
  },

  async markFailed(id: string, message: string): Promise<void> {
    const db = await getDb();
    await db.runAsync(`UPDATE body_measurements SET sync_status = 'failed', last_sync_error = ? WHERE id = ?`, [message, id]);
  },

  async getUnsynced(userId: string): Promise<LocalBodyMeasurement[]> {
    const db = await getDb();
    const rows = await db.getAllAsync<Row>(`SELECT * FROM body_measurements WHERE user_id = ? AND sync_status IN ('pending', 'failed')`, [userId]);
    const results: LocalBodyMeasurement[] = [];
    for (const row of rows) results.push(await toLocal(row));
    return results;
  },
};
