import { getDb } from '../client';
import type { LocalHealthConnectState } from '../types';

type Row = {
  user_id: string;
  connected: number;
  write_back_enabled: number;
  last_synced_at: string | null;
  last_sync_error: string | null;
};

function toLocal(row: Row): LocalHealthConnectState {
  return {
    userId: row.user_id,
    connected: !!row.connected,
    writeBackEnabled: !!row.write_back_enabled,
    lastSyncedAt: row.last_synced_at,
    lastSyncError: row.last_sync_error,
  };
}

/**
 * Device-local Health Connect connection state (CORE-03). Deliberately not
 * synced — "connected" describes THIS device's OS-level grant, which has no
 * server row (architecture §3.1: Health Connect is on-device, not a cloud
 * API — there is nothing to sync here, only local state to persist across
 * app restarts).
 */
export const healthConnectStateRepository = {
  async get(userId: string): Promise<LocalHealthConnectState> {
    const db = await getDb();
    const row = await db.getFirstAsync<Row>('SELECT * FROM health_connect_state WHERE user_id = ?', [userId]);
    return row ? toLocal(row) : { userId, connected: false, writeBackEnabled: false, lastSyncedAt: null, lastSyncError: null };
  },

  async setConnected(userId: string, connected: boolean): Promise<void> {
    const db = await getDb();
    const now = new Date().toISOString();
    await db.runAsync(
      `INSERT INTO health_connect_state (user_id, connected, write_back_enabled, last_synced_at, last_sync_error, updated_at)
       VALUES (?, ?, 0, NULL, NULL, ?)
       ON CONFLICT(user_id) DO UPDATE SET connected = excluded.connected, updated_at = excluded.updated_at`,
      [userId, connected ? 1 : 0, now]
    );
  },

  async setWriteBackEnabled(userId: string, enabled: boolean): Promise<void> {
    const db = await getDb();
    const now = new Date().toISOString();
    await db.runAsync(
      `INSERT INTO health_connect_state (user_id, connected, write_back_enabled, last_synced_at, last_sync_error, updated_at)
       VALUES (?, 1, ?, NULL, NULL, ?)
       ON CONFLICT(user_id) DO UPDATE SET write_back_enabled = excluded.write_back_enabled, updated_at = excluded.updated_at`,
      [userId, enabled ? 1 : 0, now]
    );
  },

  async markSyncResult(userId: string, result: { ok: true } | { ok: false; error: string }): Promise<void> {
    const db = await getDb();
    const now = new Date().toISOString();
    if (result.ok) {
      await db.runAsync(
        `UPDATE health_connect_state SET last_synced_at = ?, last_sync_error = NULL, updated_at = ? WHERE user_id = ?`,
        [now, now, userId]
      );
    } else {
      await db.runAsync(`UPDATE health_connect_state SET last_sync_error = ?, updated_at = ? WHERE user_id = ?`, [
        result.error,
        now,
        userId,
      ]);
    }
  },
};
