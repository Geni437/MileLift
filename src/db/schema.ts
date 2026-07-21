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
    recording_hero_metric TEXT NOT NULL DEFAULT 'duration',
    updated_at TEXT NOT NULL
  );`,

  // ---------------------------------------------------------------------
  // Phase 1 — Module A (activity & movement tracking). Design ref:
  // docs/architecture/phase-1-module-a.md §9 ("Local store extension").
  //
  // Deviation from the doc's literal table-per-server-table shape (flagged,
  // not silent): Phase 0 never built a generic local `timeline_events`
  // mirror (schema.ts header: "the full timeline_events mirror is out of
  // scope" for Phase 0), and Module A is the FIRST timeline event type this
  // client stores locally. Rather than build a generic spine+subtype join
  // machinery for a single concrete event type, one denormalized `activities`
  // table carries both the spine fields this client needs (occurred_at,
  // duration_seconds, energy_kcal, visibility, source, local_date, ...) and
  // the activity_details fields, keyed by `id` (= server timeline_event_id).
  // This mirrors the profiles/profile_health precedent of "one local table
  // per server concept the UI actually reads," just merged 1:1 across the
  // spine/subtype seam since nothing else attaches to the spine client-side
  // yet. `src/sync/activitySync.ts` is the only place that needs to know the
  // server splits this into two tables. Revisit if Module B/C add a second
  // event type and this stops being a reasonable simplification.
  // ---------------------------------------------------------------------

  // Reference catalog cache (activity_types, §1.1). Public, read-mostly,
  // pulled and cached so the recording/type-picker screens work fully
  // offline. Booleans stored as INTEGER 0/1 (SQLite has no boolean type).
  `CREATE TABLE IF NOT EXISTS activity_types (
    code TEXT PRIMARY KEY NOT NULL,
    display_name TEXT NOT NULL,
    category TEXT NOT NULL,
    is_distance_based INTEGER NOT NULL,
    tracks_elevation INTEGER NOT NULL,
    supports_gps INTEGER NOT NULL,
    sort_order INTEGER NOT NULL DEFAULT 0
  );`,

  // One row per activity — spine (timeline_events) + activity_details fields
  // merged, per the note above. `id` doubles as the idempotency key sent to
  // `save_activity_v1` as `p_id` (architecture §2.1/§9).
  `CREATE TABLE IF NOT EXISTS activities (
    id TEXT PRIMARY KEY NOT NULL,
    user_id TEXT NOT NULL,
    activity_type_code TEXT NOT NULL,
    activity_type_name_snapshot TEXT NOT NULL,
    title TEXT,
    description TEXT,
    occurred_at TEXT NOT NULL,
    local_date TEXT NOT NULL,
    event_timezone TEXT NOT NULL,
    duration_seconds INTEGER NOT NULL,
    moving_time_seconds INTEGER,
    distance_m REAL,
    unit_distance_snapshot TEXT NOT NULL DEFAULT 'km',
    elevation_gain_m REAL,
    elevation_loss_m REAL,
    average_speed_mps REAL,
    max_speed_mps REAL,
    average_hr REAL,
    max_hr REAL,
    has_gps_route INTEGER NOT NULL DEFAULT 0,
    energy_kcal REAL,
    calories_source TEXT NOT NULL DEFAULT 'none',
    source TEXT NOT NULL DEFAULT 'manual',
    visibility TEXT NOT NULL DEFAULT 'private',
    client_created_at TEXT,
    created_at TEXT,
    updated_at TEXT,
    deleted_at TEXT,
    kudos_count INTEGER NOT NULL DEFAULT 0,
    kudos_count_fetched_at TEXT,
    -- Has this row ever been confirmed by a successful save_activity_v1 call?
    -- Distinguishes "delete needs to push a tombstone" from "this was
    -- recorded and discarded/deleted entirely offline — the server never
    -- saw it, so there is nothing to push at all" (sync engine, §9).
    server_confirmed INTEGER NOT NULL DEFAULT 0,
    sync_status TEXT NOT NULL DEFAULT 'pending',
    pending_payload TEXT,
    last_sync_error TEXT
  );`,

  `CREATE INDEX IF NOT EXISTS idx_activities_user_occurred_at
    ON activities (user_id, occurred_at DESC, id DESC)
    WHERE deleted_at IS NULL;`,

  `CREATE INDEX IF NOT EXISTS idx_activities_sync_status
    ON activities (sync_status);`,

  // Simplified route geometry, 1:1 with an activity. Stored as GeoJSON text
  // (LineString, 3D coords [lng,lat,elevation]) rather than an encoded
  // polyline — SQLite has no PostGIS either way, and GeoJSON avoids hand-
  // rolling a polyline codec while preserving elevation end-to-end for the
  // MeridianTrace/RouteMap elevation profile (a documented, deliberate
  // choice; the architecture doc offers "encoded polyline" as an example
  // local representation, not a mandate — §2.2/§9). This is exactly the
  // `p_route_geojson` shape `save_activity_v1` accepts, so no server-side
  // reformatting is needed either.
  `CREATE TABLE IF NOT EXISTS activity_routes (
    activity_id TEXT PRIMARY KEY NOT NULL,
    simplified_geojson TEXT NOT NULL,
    bounds_json TEXT,
    raw_track_object_path TEXT NOT NULL,
    raw_track_checksum TEXT,
    raw_point_count INTEGER,
    simplified_point_count INTEGER,
    raw_track_upload_status TEXT NOT NULL DEFAULT 'pending',
    created_at TEXT
  );`,

  // Local-only, in-progress-recording GPS samples (architecture §2.1/§9 —
  // "the per-point write firehose lands in local SQLite ... never synced").
  // `session_id` = the activity id the recording will become on finish.
  `CREATE TABLE IF NOT EXISTS route_points_local (
    session_id TEXT NOT NULL,
    seq INTEGER NOT NULL,
    latitude REAL NOT NULL,
    longitude REAL NOT NULL,
    elevation_m REAL,
    accuracy_m REAL,
    recorded_at TEXT NOT NULL,
    is_moving INTEGER NOT NULL DEFAULT 1,
    PRIMARY KEY (session_id, seq)
  );`,

  `CREATE INDEX IF NOT EXISTS idx_route_points_local_session
    ON route_points_local (session_id);`,

  // Local-only in-progress-recording control state (Ready/Recording/Paused),
  // the layer-2 domain state the crash-recovery resume prompt (design doc
  // CORE-01 "Backgrounded / app killed → recovery") reads on relaunch.
  // Never synced — cleared on finish or discard.
  `CREATE TABLE IF NOT EXISTS recording_sessions (
    id TEXT PRIMARY KEY NOT NULL,
    user_id TEXT NOT NULL,
    activity_type_code TEXT NOT NULL,
    status TEXT NOT NULL,
    started_at TEXT NOT NULL,
    last_resumed_at TEXT NOT NULL,
    accumulated_moving_seconds INTEGER NOT NULL DEFAULT 0,
    location_declined INTEGER NOT NULL DEFAULT 0,
    updated_at TEXT NOT NULL
  );`,

  // Cached "current best" per (user, type, metric) — pulled from the server
  // and optimistically updated on a local finish per the design doc's
  // optimistic-then-reconciled PR celebration (CORE-04 judgment call 5).
  // `confirmed` distinguishes a server-reconciled row from a purely local
  // optimistic one (surfaced nowhere in the UI directly, but lets the sync
  // layer tell the two apart when reconciling).
  `CREATE TABLE IF NOT EXISTS personal_records (
    user_id TEXT NOT NULL,
    activity_type_code TEXT NOT NULL,
    metric TEXT NOT NULL,
    value REAL NOT NULL,
    unit_snapshot TEXT,
    timeline_event_id TEXT NOT NULL,
    achieved_at TEXT NOT NULL,
    previous_value REAL,
    confirmed INTEGER NOT NULL DEFAULT 0,
    updated_at TEXT,
    PRIMARY KEY (user_id, activity_type_code, metric)
  );`,

  // Immutable per-activity achievement log (mirrors activity_achievements).
  // `is_optimistic` marks a locally-computed badge not yet confirmed by the
  // `save_activity_v1` response — reconciliation clears the flag or removes
  // the row per activity/[id] screen + the Save sheet's PrCallout logic.
  `CREATE TABLE IF NOT EXISTS activity_achievements (
    id TEXT PRIMARY KEY NOT NULL,
    timeline_event_id TEXT NOT NULL,
    user_id TEXT NOT NULL,
    metric TEXT NOT NULL,
    value REAL NOT NULL,
    rank TEXT,
    is_optimistic INTEGER NOT NULL DEFAULT 0,
    created_at TEXT
  );`,

  `CREATE INDEX IF NOT EXISTS idx_activity_achievements_event
    ON activity_achievements (timeline_event_id);`,

  `CREATE UNIQUE INDEX IF NOT EXISTS uq_activity_achievements_event_metric
    ON activity_achievements (timeline_event_id, metric);`,

  // Generic incremental-pull cursor store (Phase 0's profile/consent sync
  // pulls a single row per user, so it never needed one; Module A's activity
  // history can be large, so pulls page on `updated_at` like the server's
  // own sync-cursor convention, architecture §5/§9).
  `CREATE TABLE IF NOT EXISTS sync_cursors (
    user_id TEXT NOT NULL,
    cursor_key TEXT NOT NULL,
    value TEXT NOT NULL,
    PRIMARY KEY (user_id, cursor_key)
  );`,

  // Wearable provenance/dedup cache (mirrors wearable_links) — the
  // loop-prevention mechanism (architecture §3.3): before importing a Health
  // Connect record, check for an existing `inbound` link with that
  // external_record_id; before importing at all, skip any record whose id
  // matches an `outbound` link this app itself created.
  `CREATE TABLE IF NOT EXISTS wearable_links (
    id TEXT PRIMARY KEY NOT NULL,
    timeline_event_id TEXT NOT NULL,
    user_id TEXT NOT NULL,
    provider TEXT NOT NULL,
    direction TEXT NOT NULL,
    external_record_id TEXT NOT NULL,
    synced_at TEXT NOT NULL,
    sync_status TEXT NOT NULL DEFAULT 'pending',
    last_sync_error TEXT
  );`,

  `CREATE UNIQUE INDEX IF NOT EXISTS uq_wearable_links_provider_direction_external
    ON wearable_links (provider, direction, external_record_id);`,

  `CREATE INDEX IF NOT EXISTS idx_wearable_links_timeline_event
    ON wearable_links (timeline_event_id);`,

  // Device-local Health Connect connection state (CORE-03). Not a synced
  // table — "connected"/"write-back enabled" describe THIS device's OS-level
  // grant, which has no server representation (architecture §3.1: Health
  // Connect is on-device, not a cloud API).
  `CREATE TABLE IF NOT EXISTS health_connect_state (
    user_id TEXT PRIMARY KEY NOT NULL,
    connected INTEGER NOT NULL DEFAULT 0,
    write_back_enabled INTEGER NOT NULL DEFAULT 0,
    last_synced_at TEXT,
    last_sync_error TEXT,
    updated_at TEXT
  );`,
];
