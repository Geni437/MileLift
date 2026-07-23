import { getDb } from '../client';
import type { LocalManualBurnLog, ManualBurnEnergySource, OverlapAdvisory, SyncStatus } from '../types';

type Row = {
  id: string;
  user_id: string;
  occurred_at: string;
  local_date: string;
  event_timezone: string;
  energy_kcal_magnitude: number;
  label: string;
  activity_type_code: string | null;
  duration_minutes: number | null;
  energy_source: string;
  notes: string | null;
  created_at: string | null;
  updated_at: string | null;
  deleted_at: string | null;
  overlap_advisory_json: string | null;
  overlap_advisory_dismissed: number;
  server_confirmed: number;
  sync_status: string;
  last_sync_error: string | null;
};

export type ServerManualBurnRow = Pick<
  Row,
  | 'id'
  | 'user_id'
  | 'occurred_at'
  | 'local_date'
  | 'event_timezone'
  | 'energy_kcal_magnitude'
  | 'label'
  | 'activity_type_code'
  | 'duration_minutes'
  | 'energy_source'
  | 'notes'
  | 'created_at'
  | 'updated_at'
  | 'deleted_at'
>;

function toLocal(row: Row): LocalManualBurnLog {
  let overlapAdvisory: OverlapAdvisory | null = null;
  if (row.overlap_advisory_json) {
    try {
      overlapAdvisory = JSON.parse(row.overlap_advisory_json) as OverlapAdvisory;
    } catch {
      overlapAdvisory = null;
    }
  }
  return {
    id: row.id,
    userId: row.user_id,
    occurredAt: row.occurred_at,
    localDate: row.local_date,
    eventTimezone: row.event_timezone,
    energyKcalMagnitude: row.energy_kcal_magnitude,
    label: row.label,
    activityTypeCode: row.activity_type_code,
    durationMinutes: row.duration_minutes,
    energySource: row.energy_source as ManualBurnEnergySource,
    notes: row.notes,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
    deletedAt: row.deleted_at,
    overlapAdvisory,
    overlapAdvisoryDismissed: !!row.overlap_advisory_dismissed,
    serverConfirmed: !!row.server_confirmed,
    syncStatus: row.sync_status as SyncStatus,
    lastSyncError: row.last_sync_error,
  };
}

export type ManualBurnFields = {
  occurredAt: string;
  localDate: string;
  eventTimezone: string;
  energyKcalMagnitude: number;
  label: string;
  activityTypeCode: string | null;
  durationMinutes: number | null;
  energySource: ManualBurnEnergySource;
  notes: string | null;
};

/** CORE-11 manual calorie-burn log (§1.8/§4.3), including the soft overlap advisory (optimistic pre-sync, reconciled post-sync — §CORE-Sync coordination note). */
export const manualBurnRepository = {
  async getById(id: string): Promise<LocalManualBurnLog | null> {
    const db = await getDb();
    const row = await db.getFirstAsync<Row>('SELECT * FROM manual_calorie_burn_logs WHERE id = ?', [id]);
    return row ? toLocal(row) : null;
  },

  async listForLocalDate(userId: string, localDate: string): Promise<LocalManualBurnLog[]> {
    const db = await getDb();
    const rows = await db.getAllAsync<Row>(
      'SELECT * FROM manual_calorie_burn_logs WHERE user_id = ? AND local_date = ? AND deleted_at IS NULL ORDER BY occurred_at ASC',
      [userId, localDate]
    );
    return rows.map(toLocal);
  },

  /** Undismissed overlap advisories across recent history — drives the post-save `OverlapAdvisory` banner surviving an app restart. */
  async listWithUndismissedAdvisory(userId: string): Promise<LocalManualBurnLog[]> {
    const db = await getDb();
    const rows = await db.getAllAsync<Row>(
      `SELECT * FROM manual_calorie_burn_logs WHERE user_id = ? AND deleted_at IS NULL AND overlap_advisory_dismissed = 0 AND overlap_advisory_json IS NOT NULL ORDER BY occurred_at DESC`,
      [userId]
    );
    return rows.map(toLocal).filter((r) => r.overlapAdvisory?.hasOverlap);
  },

  async create(id: string, userId: string, fields: ManualBurnFields): Promise<LocalManualBurnLog> {
    const db = await getDb();
    const now = new Date().toISOString();
    await db.runAsync(
      `INSERT INTO manual_calorie_burn_logs (id, user_id, occurred_at, local_date, event_timezone, energy_kcal_magnitude, label, activity_type_code, duration_minutes, energy_source, notes, created_at, updated_at, server_confirmed, sync_status)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 0, 'pending')`,
      [
        id,
        userId,
        fields.occurredAt,
        fields.localDate,
        fields.eventTimezone,
        fields.energyKcalMagnitude,
        fields.label,
        fields.activityTypeCode,
        fields.durationMinutes,
        fields.energySource,
        fields.notes,
        now,
        now,
      ]
    );
    return (await this.getById(id))!;
  },

  /** Records the CORE-11 overlap advisory (either the client-side optimistic pre-check, or the RPC's authoritative response on sync — both funnel through here so the banner reads whichever is freshest). */
  async setOverlapAdvisory(id: string, advisory: OverlapAdvisory): Promise<void> {
    const db = await getDb();
    await db.runAsync(`UPDATE manual_calorie_burn_logs SET overlap_advisory_json = ?, overlap_advisory_dismissed = 0 WHERE id = ?`, [JSON.stringify(advisory), id]);
  },

  async dismissOverlapAdvisory(id: string): Promise<void> {
    const db = await getDb();
    await db.runAsync(`UPDATE manual_calorie_burn_logs SET overlap_advisory_dismissed = 1 WHERE id = ?`, [id]);
  },

  async softDelete(id: string): Promise<void> {
    const db = await getDb();
    const now = new Date().toISOString();
    await db.runAsync(`UPDATE manual_calorie_burn_logs SET deleted_at = ?, updated_at = ?, sync_status = 'pending', last_sync_error = NULL WHERE id = ?`, [now, now, id]);
  },

  async wasServerConfirmed(id: string): Promise<boolean> {
    const db = await getDb();
    const row = await db.getFirstAsync<{ server_confirmed: number }>('SELECT server_confirmed FROM manual_calorie_burn_logs WHERE id = ?', [id]);
    return !!row?.server_confirmed;
  },

  async purgeLocalOnly(id: string): Promise<void> {
    const db = await getDb();
    await db.runAsync('DELETE FROM manual_calorie_burn_logs WHERE id = ? AND server_confirmed = 0', [id]);
  },

  async markSynced(id: string): Promise<void> {
    const db = await getDb();
    await db.runAsync(`UPDATE manual_calorie_burn_logs SET server_confirmed = 1, sync_status = 'synced', last_sync_error = NULL WHERE id = ?`, [id]);
  },

  async markFailed(id: string, message: string): Promise<void> {
    const db = await getDb();
    await db.runAsync(`UPDATE manual_calorie_burn_logs SET sync_status = 'failed', last_sync_error = ? WHERE id = ?`, [message, id]);
  },

  async getUnsynced(userId: string): Promise<LocalManualBurnLog[]> {
    const db = await getDb();
    const rows = await db.getAllAsync<Row>(`SELECT * FROM manual_calorie_burn_logs WHERE user_id = ? AND sync_status IN ('pending', 'failed')`, [userId]);
    return rows.map(toLocal);
  },

  async reconcileFromServer(rows: ServerManualBurnRow[]): Promise<void> {
    const db = await getDb();
    await db.withTransactionAsync(async () => {
      for (const row of rows) {
        const existing = await db.getFirstAsync<Row>('SELECT * FROM manual_calorie_burn_logs WHERE id = ?', [row.id]);
        if (existing && existing.sync_status !== 'synced') continue;
        await db.runAsync(
          `INSERT INTO manual_calorie_burn_logs (id, user_id, occurred_at, local_date, event_timezone, energy_kcal_magnitude, label, activity_type_code, duration_minutes, energy_source, notes, created_at, updated_at, deleted_at, server_confirmed, sync_status, last_sync_error)
           VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 1, 'synced', NULL)
           ON CONFLICT(id) DO UPDATE SET label = excluded.label, activity_type_code = excluded.activity_type_code, duration_minutes = excluded.duration_minutes, notes = excluded.notes, deleted_at = excluded.deleted_at, updated_at = excluded.updated_at, server_confirmed = 1, sync_status = 'synced', last_sync_error = NULL`,
          [
            row.id, row.user_id, row.occurred_at, row.local_date, row.event_timezone, row.energy_kcal_magnitude, row.label,
            row.activity_type_code, row.duration_minutes, row.energy_source, row.notes, row.created_at, row.updated_at, row.deleted_at,
          ]
        );
      }
    });
  },
};
