import { getDb } from '../client';
import type { LocalProfile, ProfileWritableFields, SyncStatus, UnitDistance, UnitWeight } from '../types';

type ProfileRow = {
  id: string;
  username: string | null;
  display_name: string | null;
  avatar_url: string | null;
  unit_weight: string;
  unit_distance: string;
  default_timezone: string;
  deletion_requested_at: string | null;
  created_at: string | null;
  updated_at: string | null;
  sync_status: string;
  last_sync_error: string | null;
};

function toLocalProfile(row: ProfileRow): LocalProfile {
  return {
    id: row.id,
    username: row.username,
    displayName: row.display_name,
    avatarUrl: row.avatar_url,
    unitWeight: row.unit_weight as UnitWeight,
    unitDistance: row.unit_distance as UnitDistance,
    defaultTimezone: row.default_timezone,
    deletionRequestedAt: row.deletion_requested_at,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
    syncStatus: row.sync_status as SyncStatus,
    lastSyncError: row.last_sync_error,
  };
}

/**
 * Local-first repository for `profiles`. Screens call `getLocal` /
 * `subscribe`-style reads against this — never `supabase.from('profiles')`
 * directly (mobile-architecture-standards, layer 1: server cache state goes
 * through the sync layer, not straight into a component).
 */
export const profileRepository = {
  async getLocal(userId: string): Promise<LocalProfile | null> {
    const db = await getDb();
    const row = await db.getFirstAsync<ProfileRow>('SELECT * FROM profiles WHERE id = ?', [userId]);
    return row ? toLocalProfile(row) : null;
  },

  /**
   * Optimistic local write (architecture §3.3). Applies immediately, marks
   * the row `pending` so the sync engine picks it up and the UI can render
   * `SyncStatusPill: Saved · will sync`. Never blocks on the network.
   */
  async applyLocalEdit(userId: string, fields: ProfileWritableFields): Promise<LocalProfile> {
    const db = await getDb();
    const now = new Date().toISOString();
    const existing = await this.getLocal(userId);

    const merged: LocalProfile = {
      id: userId,
      username: fields.username !== undefined ? fields.username : existing?.username ?? null,
      displayName: fields.displayName !== undefined ? fields.displayName : existing?.displayName ?? null,
      avatarUrl: fields.avatarUrl !== undefined ? fields.avatarUrl : existing?.avatarUrl ?? null,
      unitWeight: fields.unitWeight ?? existing?.unitWeight ?? 'kg',
      unitDistance: fields.unitDistance ?? existing?.unitDistance ?? 'km',
      defaultTimezone: fields.defaultTimezone ?? existing?.defaultTimezone ?? 'UTC',
      deletionRequestedAt:
        fields.deletionRequestedAt !== undefined ? fields.deletionRequestedAt : existing?.deletionRequestedAt ?? null,
      createdAt: existing?.createdAt ?? null,
      updatedAt: now,
      syncStatus: 'pending',
      lastSyncError: null,
    };

    await db.runAsync(
      `INSERT INTO profiles (id, username, display_name, avatar_url, unit_weight, unit_distance, default_timezone, deletion_requested_at, created_at, updated_at, sync_status, last_sync_error)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'pending', NULL)
       ON CONFLICT(id) DO UPDATE SET
         username = excluded.username,
         display_name = excluded.display_name,
         avatar_url = excluded.avatar_url,
         unit_weight = excluded.unit_weight,
         unit_distance = excluded.unit_distance,
         default_timezone = excluded.default_timezone,
         deletion_requested_at = excluded.deletion_requested_at,
         updated_at = excluded.updated_at,
         sync_status = 'pending',
         last_sync_error = NULL`,
      [
        merged.id,
        merged.username,
        merged.displayName,
        merged.avatarUrl,
        merged.unitWeight,
        merged.unitDistance,
        merged.defaultTimezone,
        merged.deletionRequestedAt,
        merged.createdAt,
        merged.updatedAt,
      ]
    );

    return merged;
  },

  /**
   * Reconciles a server row into the local mirror. Conflict rule (architecture
   * §3.5, last-write-wins by server `updated_at`, at the row grain): a local
   * row with an uncommitted (`pending`/`failed`) edit is local domain state
   * and is NOT overwritten here — it's only superseded once the sync engine's
   * push for that edit succeeds (see `markSynced`). Only a `synced` local row
   * (no outstanding edit) is safe to overwrite from a pull.
   */
  async reconcileFromServer(row: ProfileRow): Promise<'applied' | 'skipped_pending_local_edit'> {
    const db = await getDb();
    const existing = await this.getLocal(row.id);

    if (existing && existing.syncStatus !== 'synced') {
      return 'skipped_pending_local_edit';
    }

    await db.runAsync(
      `INSERT INTO profiles (id, username, display_name, avatar_url, unit_weight, unit_distance, default_timezone, deletion_requested_at, created_at, updated_at, sync_status, last_sync_error)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'synced', NULL)
       ON CONFLICT(id) DO UPDATE SET
         username = excluded.username,
         display_name = excluded.display_name,
         avatar_url = excluded.avatar_url,
         unit_weight = excluded.unit_weight,
         unit_distance = excluded.unit_distance,
         default_timezone = excluded.default_timezone,
         deletion_requested_at = excluded.deletion_requested_at,
         created_at = excluded.created_at,
         updated_at = excluded.updated_at,
         sync_status = 'synced',
         last_sync_error = NULL`,
      [
        row.id,
        row.username,
        row.display_name,
        row.avatar_url,
        row.unit_weight,
        row.unit_distance,
        row.default_timezone,
        row.deletion_requested_at,
        row.created_at,
        row.updated_at,
      ]
    );
    return 'applied';
  },

  /** Used right after a successful push, where we WANT to accept the server's row unconditionally. */
  async reconcileFromServerForce(row: ProfileRow): Promise<void> {
    const db = await getDb();
    await db.runAsync(
      `UPDATE profiles SET
         username = ?, display_name = ?, avatar_url = ?, unit_weight = ?, unit_distance = ?,
         default_timezone = ?, deletion_requested_at = ?, created_at = ?, updated_at = ?,
         sync_status = 'synced', last_sync_error = NULL
       WHERE id = ?`,
      [
        row.username,
        row.display_name,
        row.avatar_url,
        row.unit_weight,
        row.unit_distance,
        row.default_timezone,
        row.deletion_requested_at,
        row.created_at,
        row.updated_at,
        row.id,
      ]
    );
  },

  async markFailed(userId: string, errorMessage: string): Promise<void> {
    const db = await getDb();
    await db.runAsync(`UPDATE profiles SET sync_status = 'failed', last_sync_error = ? WHERE id = ?`, [
      errorMessage,
      userId,
    ]);
  },

  async getUnsynced(): Promise<LocalProfile[]> {
    const db = await getDb();
    const rows = await db.getAllAsync<ProfileRow>(
      `SELECT * FROM profiles WHERE sync_status IN ('pending', 'failed')`
    );
    return rows.map(toLocalProfile);
  },

  /** Seeds the local row the first time we see a freshly-signed-in user, before any local edit exists. */
  async seedIfMissing(row: ProfileRow): Promise<void> {
    const db = await getDb();
    const existing = await this.getLocal(row.id);
    if (existing) return;

    await db.runAsync(
      `INSERT INTO profiles (id, username, display_name, avatar_url, unit_weight, unit_distance, default_timezone, deletion_requested_at, created_at, updated_at, sync_status, last_sync_error)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'synced', NULL)`,
      [
        row.id,
        row.username,
        row.display_name,
        row.avatar_url,
        row.unit_weight,
        row.unit_distance,
        row.default_timezone,
        row.deletion_requested_at,
        row.created_at,
        row.updated_at,
      ]
    );
  },
};

export type { ProfileRow };
