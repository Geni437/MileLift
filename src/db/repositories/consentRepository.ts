import { getDb } from '../client';
import type { ConsentCategory, LocalConsent, SyncStatus } from '../types';

type ConsentRow = {
  id: string;
  user_id: string;
  category: string;
  purpose_version: string;
  granted_at: string;
  revoked_at: string | null;
  sync_status: string;
  last_sync_error: string | null;
};

function toLocalConsent(row: ConsentRow): LocalConsent {
  return {
    id: row.id,
    userId: row.user_id,
    category: row.category as ConsentCategory,
    purposeVersion: row.purpose_version,
    grantedAt: row.granted_at,
    revokedAt: row.revoked_at,
    syncStatus: row.sync_status as SyncStatus,
    lastSyncError: row.last_sync_error,
  };
}

/**
 * Local-first repository for `user_consents`. Append-only per architecture
 * §6: granting after a revoke inserts a new row (client-generated UUID,
 * doubling as the idempotency key per architecture §3.4), never overwrites
 * history.
 */
export const consentRepository = {
  async getActive(userId: string, category: ConsentCategory): Promise<LocalConsent | null> {
    const db = await getDb();
    const row = await db.getFirstAsync<ConsentRow>(
      `SELECT * FROM user_consents WHERE user_id = ? AND category = ? AND revoked_at IS NULL ORDER BY granted_at DESC LIMIT 1`,
      [userId, category]
    );
    return row ? toLocalConsent(row) : null;
  },

  async getAllForUser(userId: string): Promise<LocalConsent[]> {
    const db = await getDb();
    const rows = await db.getAllAsync<ConsentRow>(
      `SELECT * FROM user_consents WHERE user_id = ? ORDER BY granted_at DESC`,
      [userId]
    );
    return rows.map(toLocalConsent);
  },

  /** Optimistic local grant. `id` is client-generated (crypto.randomUUID) by the caller — see src/lib/consent.ts. */
  async grant(consent: { id: string; userId: string; category: ConsentCategory; purposeVersion: string }): Promise<void> {
    const db = await getDb();
    const now = new Date().toISOString();
    await db.runAsync(
      `INSERT INTO user_consents (id, user_id, category, purpose_version, granted_at, revoked_at, created_at, updated_at, sync_status, last_sync_error)
       VALUES (?, ?, ?, ?, ?, NULL, ?, ?, 'pending', NULL)`,
      [consent.id, consent.userId, consent.category, consent.purposeVersion, now, now, now]
    );
  },

  async revoke(consentId: string): Promise<void> {
    const db = await getDb();
    const now = new Date().toISOString();
    await db.runAsync(
      `UPDATE user_consents SET revoked_at = ?, updated_at = ?, sync_status = 'pending', last_sync_error = NULL WHERE id = ?`,
      [now, now, consentId]
    );
  },

  async markSynced(consentId: string): Promise<void> {
    const db = await getDb();
    await db.runAsync(`UPDATE user_consents SET sync_status = 'synced', last_sync_error = NULL WHERE id = ?`, [
      consentId,
    ]);
  },

  async markFailed(consentId: string, errorMessage: string): Promise<void> {
    const db = await getDb();
    await db.runAsync(`UPDATE user_consents SET sync_status = 'failed', last_sync_error = ? WHERE id = ?`, [
      errorMessage,
      consentId,
    ]);
  },

  async getUnsynced(): Promise<LocalConsent[]> {
    const db = await getDb();
    const rows = await db.getAllAsync<ConsentRow>(`SELECT * FROM user_consents WHERE sync_status IN ('pending', 'failed')`);
    return rows.map(toLocalConsent);
  },

  /** Reconciles rows pulled from the server (e.g. consent granted/revoked on another device). */
  async reconcileFromServer(rows: ConsentRow[]): Promise<void> {
    const db = await getDb();
    await db.withTransactionAsync(async () => {
      for (const row of rows) {
        const localRow = await db.getFirstAsync<ConsentRow>('SELECT * FROM user_consents WHERE id = ?', [row.id]);
        // A row with a pending/failed local edit (e.g. a revoke not yet
        // pushed) is local domain state until it commits — don't clobber it.
        if (localRow && localRow.sync_status !== 'synced') continue;

        await db.runAsync(
          `INSERT INTO user_consents (id, user_id, category, purpose_version, granted_at, revoked_at, created_at, updated_at, sync_status, last_sync_error)
           VALUES (?, ?, ?, ?, ?, ?, ?, ?, 'synced', NULL)
           ON CONFLICT(id) DO UPDATE SET
             revoked_at = excluded.revoked_at,
             updated_at = excluded.updated_at,
             sync_status = 'synced',
             last_sync_error = NULL`,
          [
            row.id,
            row.user_id,
            row.category,
            row.purpose_version,
            row.granted_at,
            row.revoked_at,
            row.granted_at,
            row.revoked_at ?? row.granted_at,
          ]
        );
      }
    });
  },
};

export type { ConsentRow };
