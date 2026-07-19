/**
 * Local SQLite schema — the on-device mirror of the profile/auth slice of
 * the spine (architecture §3.2: "the on-device local store (SQLite-based) is
 * the UI's source of truth"). Screens read these tables, never a live
 * network call.
 *
 * Scope: Phase 0 only (profiles, profile_health, user_consents). The full
 * timeline_events mirror is out of scope here per the task brief — later
 * phases extend this schema, not replace it.
 *
 * Every synced table carries `sync_status` + `pending_payload`:
 *   - sync_status: 'synced' | 'pending' | 'failed' — the visible sync-status
 *     signal the UI shows (SyncStatusPill), never silent
 *     (mobile-architecture-standards).
 *   - pending_payload: the last locally-written values not yet confirmed by
 *     the server, so a killed app / crashed sync can resume without losing
 *     the optimistic write.
 *
 * Migrations here are forward-only and additive (CREATE TABLE IF NOT EXISTS
 * / ALTER TABLE ADD COLUMN), run once at startup by `runMigrations`.
 */

export const SCHEMA_STATEMENTS: string[] = [
  `PRAGMA journal_mode = WAL;`,

  `CREATE TABLE IF NOT EXISTS profiles (
    id TEXT PRIMARY KEY NOT NULL,
    username TEXT,
    display_name TEXT,
    avatar_url TEXT,
    unit_weight TEXT NOT NULL DEFAULT 'kg',
    unit_distance TEXT NOT NULL DEFAULT 'km',
    default_timezone TEXT NOT NULL DEFAULT 'UTC',
    deletion_requested_at TEXT,
    created_at TEXT,
    updated_at TEXT,
    sync_status TEXT NOT NULL DEFAULT 'pending',
    pending_payload TEXT,
    last_sync_error TEXT
  );`,

  `CREATE TABLE IF NOT EXISTS profile_health (
    user_id TEXT PRIMARY KEY NOT NULL,
    sex TEXT,
    date_of_birth TEXT,
    height_cm REAL,
    created_at TEXT,
    updated_at TEXT,
    sync_status TEXT NOT NULL DEFAULT 'pending',
    pending_payload TEXT,
    last_sync_error TEXT
  );`,

  `CREATE TABLE IF NOT EXISTS user_consents (
    id TEXT PRIMARY KEY NOT NULL,
    user_id TEXT NOT NULL,
    category TEXT NOT NULL,
    purpose_version TEXT NOT NULL,
    granted_at TEXT NOT NULL,
    revoked_at TEXT,
    created_at TEXT,
    updated_at TEXT,
    sync_status TEXT NOT NULL DEFAULT 'pending',
    last_sync_error TEXT
  );`,

  `CREATE INDEX IF NOT EXISTS idx_user_consents_user_category
    ON user_consents (user_id, category, granted_at DESC);`,

  // Device-local-only preference. NOT part of the synced spine: the
  // architecture doc's `profiles` column list (phase-0-foundation.md §2) has
  // no training-balance column, so there is nowhere on the server to sync
  // this to yet. See src/db/repositories/localPreferencesRepository.ts for
  // the full flagged assumption. Deliberately has no sync_status column —
  // it is never synced, so a sync-status pill would be misleading.
  `CREATE TABLE IF NOT EXISTS local_preferences (
    user_id TEXT PRIMARY KEY NOT NULL,
    training_balance_run INTEGER NOT NULL DEFAULT 50,
    onboarding_completed_at TEXT,
    updated_at TEXT NOT NULL
  );`,
];
