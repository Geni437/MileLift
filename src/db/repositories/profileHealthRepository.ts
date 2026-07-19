import { getDb } from '../client';
import type { LocalProfileHealth, ProfileHealthWritableFields, Sex, SyncStatus } from '../types';

type ProfileHealthRow = {
  user_id: string;
  sex: string | null;
  date_of_birth: string | null;
  height_cm: number | null;
  created_at?: string | null;
  updated_at?: string | null;
  sync_status: string;
  last_sync_error: string | null;
};

function toLocal(row: ProfileHealthRow): LocalProfileHealth {
  return {
    userId: row.user_id,
    sex: row.sex as Sex | null,
    dateOfBirth: row.date_of_birth,
    heightCm: row.height_cm,
    syncStatus: row.sync_status as SyncStatus,
    lastSyncError: row.last_sync_error,
  };
}

/**
 * Local-first repository for `profile_health` — the optional, consent-gated
 * demographics (architecture §6/§12.3). The DB-level trigger
 * `enforce_health_consent` rejects any write without an active `health`
 * consent row; the UI layer (src/state/ProfileHealthContext or the Profile
 * screen) is responsible for gating entry to this form behind the E1 consent
 * sheet so the user never hits that rejection as a surprise — this
 * repository does not re-check consent itself, since that would duplicate
 * (and could drift from) the DB's own enforcement.
 */
export const profileHealthRepository = {
  async getLocal(userId: string): Promise<LocalProfileHealth | null> {
    const db = await getDb();
    const row = await db.getFirstAsync<ProfileHealthRow>('SELECT * FROM profile_health WHERE user_id = ?', [userId]);
    return row ? toLocal(row) : null;
  },

  async applyLocalEdit(userId: string, fields: ProfileHealthWritableFields): Promise<LocalProfileHealth> {
    const db = await getDb();
    const now = new Date().toISOString();
    const existing = await this.getLocal(userId);

    const merged: LocalProfileHealth = {
      userId,
      sex: fields.sex !== undefined ? fields.sex : existing?.sex ?? null,
      dateOfBirth: fields.dateOfBirth !== undefined ? fields.dateOfBirth : existing?.dateOfBirth ?? null,
      heightCm: fields.heightCm !== undefined ? fields.heightCm : existing?.heightCm ?? null,
      syncStatus: 'pending',
      lastSyncError: null,
    };

    await db.runAsync(
      `INSERT INTO profile_health (user_id, sex, date_of_birth, height_cm, created_at, updated_at, sync_status, last_sync_error)
       VALUES (?, ?, ?, ?, ?, ?, 'pending', NULL)
       ON CONFLICT(user_id) DO UPDATE SET
         sex = excluded.sex,
         date_of_birth = excluded.date_of_birth,
         height_cm = excluded.height_cm,
         updated_at = excluded.updated_at,
         sync_status = 'pending',
         last_sync_error = NULL`,
      [merged.userId, merged.sex, merged.dateOfBirth, merged.heightCm, now, now]
    );

    return merged;
  },

  async removeField(userId: string, field: keyof ProfileHealthWritableFields): Promise<void> {
    await this.applyLocalEdit(userId, { [field]: null } as ProfileHealthWritableFields);
  },

  async markSynced(row: ProfileHealthRow): Promise<void> {
    const db = await getDb();
    const now = new Date().toISOString();
    await db.runAsync(
      `UPDATE profile_health SET sex = ?, date_of_birth = ?, height_cm = ?, created_at = ?, updated_at = ?, sync_status = 'synced', last_sync_error = NULL WHERE user_id = ?`,
      [row.sex, row.date_of_birth, row.height_cm, row.created_at ?? now, row.updated_at ?? now, row.user_id]
    );
  },

  async markFailed(userId: string, errorMessage: string): Promise<void> {
    const db = await getDb();
    await db.runAsync(`UPDATE profile_health SET sync_status = 'failed', last_sync_error = ? WHERE user_id = ?`, [
      errorMessage,
      userId,
    ]);
  },

  async getUnsynced(): Promise<LocalProfileHealth[]> {
    const db = await getDb();
    const rows = await db.getAllAsync<ProfileHealthRow>(
      `SELECT * FROM profile_health WHERE sync_status IN ('pending', 'failed')`
    );
    return rows.map(toLocal);
  },
};

export type { ProfileHealthRow };
