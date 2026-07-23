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
    -- Per-device "Always reveal" opt-out for progress-photo tiles (design doc
    -- CORE-16) — device-local only, same rationale as the rest of this table
    -- (no server column for this exists; a glance-in-the-gym privacy default
    -- is a device setting, not an account-wide synced preference).
    photos_always_reveal INTEGER NOT NULL DEFAULT 0,
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

  // ---------------------------------------------------------------------
  // Phase 2 — Module C (strength training & workout logging). Design ref:
  // docs/architecture/phase-2-module-c.md §9 ("Local store extension").
  // Table names mirror the server 1:1 (unlike Module A's merged-table
  // simplification) per the architecture doc's own naming: "Local schema
  // gains workout_sessions, workout_set_logs, custom_exercises,
  // workout_templates(+exercises), programs(+workouts), the three biometric
  // detail tables, strength_records, and a read-only cached mirror of
  // exercises/exercise_media." workout_sessions itself still merges spine +
  // subtype fields (activities' precedent) since there is still no generic
  // local timeline_events table.
  // ---------------------------------------------------------------------

  // Read-only cached mirror of the global exercise library (§9.1) — search/
  // filter/logging all work fully offline against this. Booleans as
  // INTEGER 0/1; secondary_muscles as a comma-joined text list (SQLite has
  // no array type) parsed by exercisesRepository.
  `CREATE TABLE IF NOT EXISTS exercises (
    id TEXT PRIMARY KEY NOT NULL,
    slug TEXT NOT NULL,
    name TEXT NOT NULL,
    primary_muscle TEXT NOT NULL,
    secondary_muscles TEXT NOT NULL DEFAULT '',
    equipment TEXT NOT NULL,
    mechanic TEXT,
    force_vector TEXT,
    is_distance_based INTEGER NOT NULL DEFAULT 0,
    is_time_based INTEGER NOT NULL DEFAULT 0,
    is_weighted INTEGER NOT NULL DEFAULT 0,
    is_bodyweight INTEGER NOT NULL DEFAULT 0,
    instructions TEXT,
    source TEXT NOT NULL,
    attribution TEXT,
    is_active INTEGER NOT NULL DEFAULT 1
  );`,

  `CREATE INDEX IF NOT EXISTS idx_exercises_active_muscle ON exercises (is_active, primary_muscle);`,
  `CREATE INDEX IF NOT EXISTS idx_exercises_active_equipment ON exercises (is_active, equipment);`,
  `CREATE INDEX IF NOT EXISTS idx_exercises_name ON exercises (name);`,

  `CREATE TABLE IF NOT EXISTS exercise_media (
    id TEXT PRIMARY KEY NOT NULL,
    exercise_id TEXT NOT NULL,
    media_type TEXT NOT NULL,
    url_or_object_path TEXT NOT NULL,
    is_primary INTEGER NOT NULL DEFAULT 0,
    source TEXT NOT NULL,
    attribution TEXT,
    license TEXT,
    sort_order INTEGER NOT NULL DEFAULT 0
  );`,

  `CREATE INDEX IF NOT EXISTS idx_exercise_media_exercise ON exercise_media (exercise_id, sort_order);`,

  `CREATE TABLE IF NOT EXISTS custom_exercises (
    id TEXT PRIMARY KEY NOT NULL,
    user_id TEXT NOT NULL,
    name TEXT NOT NULL,
    primary_muscle TEXT,
    equipment TEXT,
    is_weighted INTEGER NOT NULL DEFAULT 0,
    is_bodyweight INTEGER NOT NULL DEFAULT 0,
    is_time_based INTEGER NOT NULL DEFAULT 0,
    is_distance_based INTEGER NOT NULL DEFAULT 0,
    notes TEXT,
    deleted_at TEXT,
    created_at TEXT,
    updated_at TEXT,
    -- Has this row's id ever been confirmed by a successful server INSERT?
    -- Distinguishes "first create — plain INSERT" from "edit — column-scoped
    -- UPDATE only" so the push side never falls back to a whole-row upsert
    -- against a table whose grant is narrower than the payload (the
    -- user_consents-class bug — see src/sync/workoutSync.ts's module doc).
    server_confirmed INTEGER NOT NULL DEFAULT 0,
    sync_status TEXT NOT NULL DEFAULT 'pending',
    last_sync_error TEXT
  );`,

  `CREATE INDEX IF NOT EXISTS idx_custom_exercises_user ON custom_exercises (user_id) WHERE deleted_at IS NULL;`,

  // Merged spine (timeline_events) + workout_sessions fields, mirroring the
  // `activities` precedent (schema.ts header). `is_finished = 0` is the
  // CORE-17 in-progress domain-state case (types.ts LocalWorkoutSession doc
  // comment) — never included in getUnsynced() until Finish flips it.
  `CREATE TABLE IF NOT EXISTS workout_sessions (
    id TEXT PRIMARY KEY NOT NULL,
    user_id TEXT NOT NULL,
    title TEXT,
    notes TEXT,
    occurred_at TEXT NOT NULL,
    local_date TEXT NOT NULL,
    event_timezone TEXT NOT NULL,
    duration_seconds INTEGER NOT NULL DEFAULT 0,
    source_template_id TEXT,
    template_name_snapshot TEXT,
    session_rpe REAL,
    total_volume_kg REAL,
    total_sets INTEGER,
    calories_source TEXT NOT NULL DEFAULT 'none',
    energy_kcal REAL,
    source TEXT NOT NULL DEFAULT 'manual',
    visibility TEXT NOT NULL DEFAULT 'private',
    load_score REAL,
    client_created_at TEXT,
    created_at TEXT,
    updated_at TEXT NOT NULL,
    deleted_at TEXT,
    is_finished INTEGER NOT NULL DEFAULT 0,
    server_confirmed INTEGER NOT NULL DEFAULT 0,
    sync_status TEXT NOT NULL DEFAULT 'local',
    pending_payload TEXT,
    last_sync_error TEXT
  );`,

  `CREATE INDEX IF NOT EXISTS idx_workout_sessions_user_occurred
    ON workout_sessions (user_id, occurred_at DESC, id DESC)
    WHERE deleted_at IS NULL AND is_finished = 1;`,

  `CREATE INDEX IF NOT EXISTS idx_workout_sessions_sync_status ON workout_sessions (sync_status);`,

  `CREATE INDEX IF NOT EXISTS idx_workout_sessions_in_progress
    ON workout_sessions (user_id, is_finished)
    WHERE is_finished = 0 AND deleted_at IS NULL;`,

  // The CORE-12 firehose. `dirty`/`server_confirmed` are the per-set
  // idempotency-grain bookkeeping (§9.2, types.ts doc comment) — a set is
  // resent in the next save_workout_session_v1 call only while dirty.
  `CREATE TABLE IF NOT EXISTS workout_set_logs (
    id TEXT PRIMARY KEY NOT NULL,
    timeline_event_id TEXT NOT NULL,
    user_id TEXT NOT NULL,
    exercise_id TEXT,
    custom_exercise_id TEXT,
    exercise_name_snapshot TEXT NOT NULL,
    primary_muscle_snapshot TEXT,
    exercise_order INTEGER NOT NULL,
    set_number INTEGER NOT NULL,
    set_type TEXT NOT NULL DEFAULT 'working',
    reps INTEGER,
    weight_kg REAL,
    unit_weight_snapshot TEXT NOT NULL DEFAULT 'kg',
    is_bodyweight INTEGER NOT NULL DEFAULT 0,
    duration_seconds INTEGER,
    distance_m REAL,
    rpe REAL,
    rest_seconds_planned INTEGER,
    rest_seconds_actual INTEGER,
    is_completed INTEGER NOT NULL DEFAULT 1,
    estimated_1rm_kg REAL,
    notes TEXT,
    deleted_at TEXT,
    created_at TEXT,
    updated_at TEXT,
    dirty INTEGER NOT NULL DEFAULT 1,
    server_confirmed INTEGER NOT NULL DEFAULT 0
  );`,

  `CREATE INDEX IF NOT EXISTS idx_workout_set_logs_session_order
    ON workout_set_logs (timeline_event_id, exercise_order, set_number);`,

  `CREATE INDEX IF NOT EXISTS idx_workout_set_logs_user_exercise
    ON workout_set_logs (user_id, exercise_id) WHERE deleted_at IS NULL AND exercise_id IS NOT NULL;`,

  `CREATE INDEX IF NOT EXISTS idx_workout_set_logs_dirty
    ON workout_set_logs (timeline_event_id) WHERE dirty = 1;`,

  `CREATE TABLE IF NOT EXISTS workout_templates (
    id TEXT PRIMARY KEY NOT NULL,
    user_id TEXT NOT NULL,
    name TEXT NOT NULL,
    description TEXT,
    deleted_at TEXT,
    created_at TEXT,
    updated_at TEXT,
    -- See custom_exercises.server_confirmed doc comment above.
    server_confirmed INTEGER NOT NULL DEFAULT 0,
    sync_status TEXT NOT NULL DEFAULT 'pending',
    last_sync_error TEXT
  );`,

  `CREATE INDEX IF NOT EXISTS idx_workout_templates_user ON workout_templates (user_id) WHERE deleted_at IS NULL;`,

  `CREATE TABLE IF NOT EXISTS workout_template_exercises (
    id TEXT PRIMARY KEY NOT NULL,
    template_id TEXT NOT NULL,
    user_id TEXT NOT NULL,
    exercise_id TEXT,
    custom_exercise_id TEXT,
    exercise_name_snapshot TEXT NOT NULL,
    exercise_order INTEGER NOT NULL,
    target_sets INTEGER,
    target_reps_low INTEGER,
    target_reps_high INTEGER,
    target_weight_kg REAL,
    target_rest_seconds INTEGER,
    notes TEXT,
    deleted_locally INTEGER NOT NULL DEFAULT 0,
    -- See custom_exercises.server_confirmed doc comment above. Especially
    -- important here: exercise_id/custom_exercise_id are excluded from this
    -- table's UPDATE grant (§8.1 — "modeled as delete + re-insert"), so an
    -- edit push must never re-send them inside an upsert's SET clause.
    server_confirmed INTEGER NOT NULL DEFAULT 0,
    sync_status TEXT NOT NULL DEFAULT 'pending',
    last_sync_error TEXT
  );`,

  `CREATE INDEX IF NOT EXISTS idx_workout_template_exercises_template
    ON workout_template_exercises (template_id, exercise_order);`,

  `CREATE TABLE IF NOT EXISTS programs (
    id TEXT PRIMARY KEY NOT NULL,
    user_id TEXT NOT NULL,
    name TEXT NOT NULL,
    description TEXT,
    length_weeks INTEGER,
    deleted_at TEXT,
    created_at TEXT,
    updated_at TEXT,
    -- See custom_exercises.server_confirmed doc comment above.
    server_confirmed INTEGER NOT NULL DEFAULT 0,
    sync_status TEXT NOT NULL DEFAULT 'pending',
    last_sync_error TEXT
  );`,

  `CREATE INDEX IF NOT EXISTS idx_programs_user ON programs (user_id) WHERE deleted_at IS NULL;`,

  `CREATE TABLE IF NOT EXISTS program_workouts (
    id TEXT PRIMARY KEY NOT NULL,
    program_id TEXT NOT NULL,
    user_id TEXT NOT NULL,
    template_id TEXT NOT NULL,
    template_name_local TEXT NOT NULL,
    week_number INTEGER,
    day_number INTEGER,
    sort_order INTEGER NOT NULL DEFAULT 0,
    deleted_locally INTEGER NOT NULL DEFAULT 0,
    -- See workout_template_exercises.server_confirmed doc comment above —
    -- template_id is likewise excluded from this table's UPDATE grant.
    server_confirmed INTEGER NOT NULL DEFAULT 0,
    sync_status TEXT NOT NULL DEFAULT 'pending',
    last_sync_error TEXT
  );`,

  `CREATE INDEX IF NOT EXISTS idx_program_workouts_program ON program_workouts (program_id, sort_order);`,

  // Cached "current best" per (user, exercise_ref, metric) — mirrors
  // personal_records (§4.3), used both to render Strength Records and as the
  // on-device optimistic-PR comparison base at set-completion (CORE-12).
  // `exercise_ref` is a single NOT NULL synthetic key (exercise_id, or
  // "custom:<custom_exercise_id>") deliberately used in the PK instead of
  // the two separate nullable FK columns: SQLite's NULL != NULL semantics in
  // a unique index means two rows sharing the same NULL custom_exercise_id
  // would NOT collide on a composite PK containing that column, silently
  // breaking ON CONFLICT upsert matching — the server works around the
  // equivalent problem with two partial unique indexes (see
  // 20260721101400_create_strength_records.sql's own header); this is the
  // SQLite-side equivalent fix.
  `CREATE TABLE IF NOT EXISTS strength_records (
    user_id TEXT NOT NULL,
    exercise_id TEXT,
    custom_exercise_id TEXT,
    exercise_ref TEXT NOT NULL,
    metric TEXT NOT NULL,
    value REAL NOT NULL,
    unit_snapshot TEXT,
    source_set_log_id TEXT NOT NULL,
    timeline_event_id TEXT NOT NULL,
    achieved_at TEXT NOT NULL,
    previous_value REAL,
    confirmed INTEGER NOT NULL DEFAULT 0,
    updated_at TEXT,
    PRIMARY KEY (user_id, exercise_ref, metric)
  );`,

  `CREATE TABLE IF NOT EXISTS strength_achievements (
    id TEXT PRIMARY KEY NOT NULL,
    timeline_event_id TEXT NOT NULL,
    source_set_log_id TEXT NOT NULL,
    user_id TEXT NOT NULL,
    metric TEXT NOT NULL,
    value REAL NOT NULL,
    is_optimistic INTEGER NOT NULL DEFAULT 0,
    created_at TEXT
  );`,

  `CREATE INDEX IF NOT EXISTS idx_strength_achievements_event ON strength_achievements (timeline_event_id);`,

  `CREATE UNIQUE INDEX IF NOT EXISTS uq_strength_achievements_set_metric
    ON strength_achievements (source_set_log_id, metric);`,

  // CORE-16 biometrics. Each is 1:1 spine+detail merged, mirroring
  // workout_sessions/activities.
  `CREATE TABLE IF NOT EXISTS bodyweight_logs (
    id TEXT PRIMARY KEY NOT NULL,
    user_id TEXT NOT NULL,
    occurred_at TEXT NOT NULL,
    local_date TEXT NOT NULL,
    event_timezone TEXT NOT NULL,
    weight_kg REAL NOT NULL,
    unit_weight_snapshot TEXT NOT NULL DEFAULT 'kg',
    body_fat_pct REAL,
    source TEXT NOT NULL DEFAULT 'manual',
    notes TEXT,
    created_at TEXT,
    updated_at TEXT,
    deleted_at TEXT,
    server_confirmed INTEGER NOT NULL DEFAULT 0,
    sync_status TEXT NOT NULL DEFAULT 'pending',
    last_sync_error TEXT
  );`,

  `CREATE INDEX IF NOT EXISTS idx_bodyweight_logs_user_occurred
    ON bodyweight_logs (user_id, occurred_at DESC) WHERE deleted_at IS NULL;`,

  `CREATE TABLE IF NOT EXISTS body_measurements (
    id TEXT PRIMARY KEY NOT NULL,
    user_id TEXT NOT NULL,
    occurred_at TEXT NOT NULL,
    local_date TEXT NOT NULL,
    event_timezone TEXT NOT NULL,
    notes TEXT,
    created_at TEXT,
    updated_at TEXT,
    deleted_at TEXT,
    server_confirmed INTEGER NOT NULL DEFAULT 0,
    sync_status TEXT NOT NULL DEFAULT 'pending',
    last_sync_error TEXT
  );`,

  `CREATE INDEX IF NOT EXISTS idx_body_measurements_user_occurred
    ON body_measurements (user_id, occurred_at DESC) WHERE deleted_at IS NULL;`,

  `CREATE TABLE IF NOT EXISTS body_measurement_values (
    timeline_event_id TEXT NOT NULL,
    measurement_kind TEXT NOT NULL,
    value REAL NOT NULL,
    unit_snapshot TEXT NOT NULL,
    PRIMARY KEY (timeline_event_id, measurement_kind)
  );`,

  `CREATE TABLE IF NOT EXISTS progress_photos (
    id TEXT PRIMARY KEY NOT NULL,
    user_id TEXT NOT NULL,
    occurred_at TEXT NOT NULL,
    local_date TEXT NOT NULL,
    event_timezone TEXT NOT NULL,
    notes TEXT,
    created_at TEXT,
    updated_at TEXT,
    deleted_at TEXT,
    server_confirmed INTEGER NOT NULL DEFAULT 0,
    sync_status TEXT NOT NULL DEFAULT 'pending',
    last_sync_error TEXT
  );`,

  `CREATE INDEX IF NOT EXISTS idx_progress_photos_user_occurred
    ON progress_photos (user_id, occurred_at DESC) WHERE deleted_at IS NULL;`,

  `CREATE TABLE IF NOT EXISTS progress_photo_images (
    id TEXT PRIMARY KEY NOT NULL,
    timeline_event_id TEXT NOT NULL,
    pose TEXT NOT NULL,
    local_uri TEXT,
    object_path TEXT,
    checksum TEXT,
    upload_status TEXT NOT NULL DEFAULT 'pending'
  );`,

  `CREATE INDEX IF NOT EXISTS idx_progress_photo_images_event ON progress_photo_images (timeline_event_id);`,

  // ---------------------------------------------------------------------
  // Phase 3 — Module B (nutrition & food logging). Design ref:
  // docs/architecture/phase-3-module-b.md §9 ("Local store extension"):
  // "food_log_entries, food_log_items, water_intake_logs,
  // manual_calorie_burn_logs, custom_foods, saved_meals(+items), and the
  // bounded read-only cached food subset + servings." Table names mirror the
  // server 1:1 for the child/definition tables (Phase 2's convention);
  // food_log_entries merges spine + meal fields per the `activities`/
  // `workout_sessions` simplification (no generic local timeline_events
  // table exists, schema.ts header).
  // ---------------------------------------------------------------------

  // Bounded local cache of resolved catalog foods (§2.2/§2.4/§9) — populated
  // from search_foods_v1/resolve_barcode_v1 responses as the user
  // searches/scans/logs. NEVER a full-catalog mirror: rows are inserted only
  // on an actual search/barcode-resolve hit and capped (foodCacheRepository)
  // by evicting the least-recently-used row beyond a small bound, so this
  // stays orders of magnitude under any storage/`max_rows` concern by
  // construction (the client never bulk-selects `foods` at all). Read-only
  // from the server's point of view — never pushed.
  `CREATE TABLE IF NOT EXISTS food_cache (
    food_id TEXT PRIMARY KEY NOT NULL,
    source TEXT NOT NULL,
    name TEXT NOT NULL,
    brand TEXT,
    barcode TEXT,
    basis TEXT NOT NULL,
    energy_kcal REAL NOT NULL,
    protein_g REAL,
    carb_g REAL,
    fat_g REAL,
    data_quality TEXT NOT NULL,
    attribution TEXT,
    servings_json TEXT NOT NULL DEFAULT '[]',
    cached_at TEXT NOT NULL,
    last_used_at TEXT NOT NULL
  );`,

  `CREATE INDEX IF NOT EXISTS idx_food_cache_barcode ON food_cache (barcode) WHERE barcode IS NOT NULL;`,
  `CREATE INDEX IF NOT EXISTS idx_food_cache_name ON food_cache (name);`,
  `CREATE INDEX IF NOT EXISTS idx_food_cache_last_used ON food_cache (last_used_at);`,

  `CREATE TABLE IF NOT EXISTS custom_foods (
    id TEXT PRIMARY KEY NOT NULL,
    user_id TEXT NOT NULL,
    barcode TEXT,
    name TEXT NOT NULL,
    brand TEXT,
    basis TEXT NOT NULL,
    energy_kcal REAL NOT NULL,
    protein_g REAL,
    carb_g REAL,
    fat_g REAL,
    default_serving_g_or_ml REAL,
    notes TEXT,
    deleted_at TEXT,
    created_at TEXT,
    updated_at TEXT,
    -- See custom_exercises.server_confirmed doc comment (Phase 2 section
    -- above) — same first-create-vs-edit push discipline.
    server_confirmed INTEGER NOT NULL DEFAULT 0,
    sync_status TEXT NOT NULL DEFAULT 'pending',
    last_sync_error TEXT
  );`,

  `CREATE INDEX IF NOT EXISTS idx_custom_foods_user ON custom_foods (user_id) WHERE deleted_at IS NULL;`,
  `CREATE INDEX IF NOT EXISTS idx_custom_foods_user_barcode ON custom_foods (user_id, barcode) WHERE deleted_at IS NULL AND barcode IS NOT NULL;`,

  // Merged spine (timeline_events) + food_log_entries fields, mirroring the
  // `workout_sessions` precedent. `committed_at IS NULL` is the CORE-06
  // "draft meal tray" domain-state case (types.ts LocalFoodLogEntry doc
  // comment) — never included in getUnsynced() until Save/Log flips it,
  // exactly like workout_sessions.is_finished.
  `CREATE TABLE IF NOT EXISTS food_log_entries (
    id TEXT PRIMARY KEY NOT NULL,
    user_id TEXT NOT NULL,
    meal_type TEXT NOT NULL,
    title TEXT,
    notes TEXT,
    occurred_at TEXT NOT NULL,
    local_date TEXT NOT NULL,
    event_timezone TEXT NOT NULL,
    total_energy_kcal REAL NOT NULL DEFAULT 0,
    total_protein_g REAL,
    total_carb_g REAL,
    total_fat_g REAL,
    source TEXT NOT NULL DEFAULT 'manual',
    visibility TEXT NOT NULL DEFAULT 'private',
    client_created_at TEXT,
    created_at TEXT,
    updated_at TEXT,
    deleted_at TEXT,
    committed_at TEXT,
    server_confirmed INTEGER NOT NULL DEFAULT 0,
    sync_status TEXT NOT NULL DEFAULT 'local',
    last_sync_error TEXT
  );`,

  `CREATE INDEX IF NOT EXISTS idx_food_log_entries_user_occurred
    ON food_log_entries (user_id, occurred_at DESC, id DESC)
    WHERE deleted_at IS NULL AND committed_at IS NOT NULL;`,

  `CREATE INDEX IF NOT EXISTS idx_food_log_entries_user_local_date
    ON food_log_entries (user_id, local_date)
    WHERE deleted_at IS NULL AND committed_at IS NOT NULL;`,

  `CREATE INDEX IF NOT EXISTS idx_food_log_entries_sync_status ON food_log_entries (sync_status);`,

  // The CORE-06 per-food firehose, mirroring workout_set_logs' `dirty`/
  // `server_confirmed` per-item idempotency bookkeeping (§9).
  `CREATE TABLE IF NOT EXISTS food_log_items (
    id TEXT PRIMARY KEY NOT NULL,
    timeline_event_id TEXT NOT NULL,
    user_id TEXT NOT NULL,
    food_id TEXT,
    custom_food_id TEXT,
    food_name_snapshot TEXT NOT NULL,
    brand_snapshot TEXT,
    serving_label_snapshot TEXT NOT NULL,
    quantity REAL NOT NULL,
    serving_g_or_ml_snapshot REAL NOT NULL,
    energy_kcal REAL NOT NULL,
    protein_g REAL,
    carb_g REAL,
    fat_g REAL,
    data_quality_snapshot TEXT,
    sort_order INTEGER NOT NULL DEFAULT 0,
    deleted_at TEXT,
    created_at TEXT,
    updated_at TEXT,
    dirty INTEGER NOT NULL DEFAULT 1,
    server_confirmed INTEGER NOT NULL DEFAULT 0
  );`,

  `CREATE INDEX IF NOT EXISTS idx_food_log_items_event_order
    ON food_log_items (timeline_event_id, sort_order);`,

  `CREATE INDEX IF NOT EXISTS idx_food_log_items_user_food
    ON food_log_items (user_id, food_id) WHERE deleted_at IS NULL AND food_id IS NOT NULL;`,

  `CREATE INDEX IF NOT EXISTS idx_food_log_items_dirty
    ON food_log_items (timeline_event_id) WHERE dirty = 1;`,

  // 1:1 with a `water_intake` event (CORE-09, §1.7). Not consent-gated.
  `CREATE TABLE IF NOT EXISTS water_intake_logs (
    id TEXT PRIMARY KEY NOT NULL,
    user_id TEXT NOT NULL,
    occurred_at TEXT NOT NULL,
    local_date TEXT NOT NULL,
    event_timezone TEXT NOT NULL,
    volume_ml REAL NOT NULL,
    unit_volume_snapshot TEXT NOT NULL DEFAULT 'ml',
    source TEXT NOT NULL DEFAULT 'manual',
    created_at TEXT,
    updated_at TEXT,
    deleted_at TEXT,
    server_confirmed INTEGER NOT NULL DEFAULT 0,
    sync_status TEXT NOT NULL DEFAULT 'pending',
    last_sync_error TEXT
  );`,

  `CREATE INDEX IF NOT EXISTS idx_water_intake_logs_user_local_date
    ON water_intake_logs (user_id, local_date) WHERE deleted_at IS NULL;`,

  // 1:1 with a `manual_calorie_burn` event (CORE-11, §1.8/§4.3). Stores the
  // POSITIVE magnitude the user entered — sync negates it onto the spine per
  // `save_manual_burn_v1`'s contract (types.ts doc comment). The
  // `overlap_advisory_json` columns cache the CORE-11 soft advisory
  // (optimistically computed client-side pre-sync, reconciled from the RPC
  // response on sync, §CORE-Sync coordination note) so the post-save banner
  // survives an app restart before it's dismissed.
  `CREATE TABLE IF NOT EXISTS manual_calorie_burn_logs (
    id TEXT PRIMARY KEY NOT NULL,
    user_id TEXT NOT NULL,
    occurred_at TEXT NOT NULL,
    local_date TEXT NOT NULL,
    event_timezone TEXT NOT NULL,
    energy_kcal_magnitude REAL NOT NULL,
    label TEXT NOT NULL,
    activity_type_code TEXT,
    duration_minutes INTEGER,
    energy_source TEXT NOT NULL DEFAULT 'user_entered',
    notes TEXT,
    created_at TEXT,
    updated_at TEXT,
    deleted_at TEXT,
    overlap_advisory_json TEXT,
    overlap_advisory_dismissed INTEGER NOT NULL DEFAULT 0,
    server_confirmed INTEGER NOT NULL DEFAULT 0,
    sync_status TEXT NOT NULL DEFAULT 'pending',
    last_sync_error TEXT
  );`,

  `CREATE INDEX IF NOT EXISTS idx_manual_calorie_burn_logs_user_local_date
    ON manual_calorie_burn_logs (user_id, local_date) WHERE deleted_at IS NULL;`,

  `CREATE TABLE IF NOT EXISTS saved_meals (
    id TEXT PRIMARY KEY NOT NULL,
    user_id TEXT NOT NULL,
    name TEXT NOT NULL,
    description TEXT,
    meal_type TEXT,
    deleted_at TEXT,
    created_at TEXT,
    updated_at TEXT,
    server_confirmed INTEGER NOT NULL DEFAULT 0,
    sync_status TEXT NOT NULL DEFAULT 'pending',
    last_sync_error TEXT
  );`,

  `CREATE INDEX IF NOT EXISTS idx_saved_meals_user ON saved_meals (user_id) WHERE deleted_at IS NULL;`,

  `CREATE TABLE IF NOT EXISTS saved_meal_items (
    id TEXT PRIMARY KEY NOT NULL,
    saved_meal_id TEXT NOT NULL,
    user_id TEXT NOT NULL,
    food_id TEXT,
    custom_food_id TEXT,
    food_name_snapshot_local TEXT NOT NULL,
    serving_label TEXT NOT NULL,
    serving_g_or_ml REAL NOT NULL,
    quantity REAL NOT NULL,
    sort_order INTEGER NOT NULL DEFAULT 0,
    -- Real server-side DELETE is supported for this table (unlike most of
    -- this app's tables) — see the 20260722101000 migration header. Mirrors
    -- workout_template_exercises' deleted_locally "pending delete" marker.
    deleted_locally INTEGER NOT NULL DEFAULT 0,
    server_confirmed INTEGER NOT NULL DEFAULT 0,
    sync_status TEXT NOT NULL DEFAULT 'pending',
    last_sync_error TEXT
  );`,

  `CREATE INDEX IF NOT EXISTS idx_saved_meal_items_meal ON saved_meal_items (saved_meal_id, sort_order);`,
];
