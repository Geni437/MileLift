# Phase 1 — Module A: Activity & Movement Tracking (CORE-01 … CORE-05)

Status: **CONFIRMED (2026-07-19) — all §12 open questions resolved, accepted as
recommended.** Ready for `db-engineer` / `backend-builder` / `mobile-builder`.

Owner: `architect`. Downstream consumers: `db-engineer` (schema + RLS + migrations),
`backend-builder` (the save RPC, the future wearable Edge Function, PostgREST decisions),
`mobile-builder` (recording engine, local store extension, sync), `ui-ux-designer`
(recording, map/history, feed, PR surfaces — must run before `mobile-builder`, §13).

This doc is designed **against** `docs/architecture/phase-0-foundation.md`, not
alongside it. It attaches Module A detail to the existing spine via the §1.5 shared-PK
contract and reuses, verbatim, the Phase 0 patterns already live in
`supabase/migrations/` (client-generated UUID PK doubling as the idempotency key;
denormalized `user_id` for RLS; the `set_updated_at()` trigger; column-scoped
`GRANT`s; no client `DELETE` + soft-delete via `deleted_at`; consent-gating triggers
against `user_consents`; add-only enums; partial indexes on `deleted_at IS NULL`;
fail-closed RLS with cross-user reads gated on `visibility` only). Where this doc says
"same pattern as Phase 0," it means those exact mechanisms — do not reinvent them.

**Scope (this doc):** CORE-01 through CORE-05 detail schema, GPS route storage,
Wear OS/Health Connect sync shape, PR detection, feed + kudos. **Out of scope:**
Module B/C/D detail schemas; the exercise/food libraries; Module D's follow graph
(Phase 4); privacy zones/segments/heatmaps (UNQ-01/04/05, Phase 2); AI-13 sensor
fusion (Phase 8) and AI-14 route reconstruction (Phase 3) — noted only where they
constrain a data-shape decision made now.

---

## 0. What Module A adds to the spine, in one paragraph

A recorded or imported activity is **one `timeline_events` row** (`source_module =
activity`, `event_type = gps_activity`, `source = manual|wearable|import`), carrying
the cross-module currency the spine already owns (`energy_kcal` negative =
expenditure, `duration_seconds` = elapsed time, `visibility`, `occurred_at`,
`local_date`). Everything module-private — activity type, distance, pace, elevation,
moving time, per-activity HR summary, wearable provenance — hangs off that row in
**`activity_details`** (1:1, shared PK). The GPS track is stored in **two tiers**: a
simplified PostGIS `LineString` in **`activity_routes`** for map rendering and future
spatial queries, and the full-resolution raw track as a compressed blob in **Supabase
Storage** (owner-only bucket), uploaded once on finish — never streamed point-by-point
to Postgres. PRs are a **cached** `personal_records` table plus an immutable
per-activity `activity_achievements` log, updated by O(#metrics) indexed lookups at
save time, not a history scan. Kudos are a social edge in **`kudos`**, the one Module A
table with a genuine cross-user read/write policy.

---

## 1. Data model — new tables

All new tables denormalize `user_id` (copied from the spine at insert) so their RLS
policy is a direct `user_id = auth.uid()` check, per Phase 0 §1.5. `db-engineer` owns
exact Postgres types/constraints/migration; the columns, semantics, and integrity
rules below are the contract.

### 1.1 `activity_types` — reference table (NOT user-owned, NOT a timeline event)

The extensible catalog behind CORE-01's "run/ride/walk/hike + 40+ types." Modeled as a
**reference table**, not an enum — because PR detection (§4) and rendering need
per-type *metadata* (is it distance-based? does elevation matter? which PR metrics
apply?), which an enum can't carry. This is the same ownership class as the
exercise/food libraries (Phase 0 §5, §8): global, read-mostly, service-role-write.

| Column | Type (intent) | Notes / rules |
| --- | --- | --- |
| `code` | text, PK | Stable machine code, e.g. `run`, `ride`, `walk`, `hike`, `swim`, `row`. Referenced (and **snapshotted**, §1.3) by `activity_details`. |
| `display_name` | text, NOT NULL | Default label; localized on client. |
| `category` | text/enum | Grouping for UI + defaults, e.g. `foot`, `cycle`, `water`, `winter`, `gym_cardio`, `other`. |
| `is_distance_based` | boolean, NOT NULL | Drives which PR metrics apply (§4) and whether distance/pace are shown. `run`/`ride` = true; `yoga` = false. |
| `tracks_elevation` | boolean, NOT NULL | Whether elevation-gain PRs/stats are meaningful. |
| `supports_gps` | boolean, NOT NULL | Whether the recording engine offers GPS for this type. |
| `sort_order` | integer | Catalog ordering in the type picker. |
| `created_at`, `updated_at` | | |

Seeded by a migration (the launch type list is a **product-owned** decision — §12.5).
Extending the list later is an `INSERT`, not a schema change (the advantage over an
enum).

### 1.2 `activity_details` — the CORE-01/02 subtype (1:1 with the spine)

Shared PK = `timeline_event_id`, a 1:1 FK to `timeline_events.id` (§1.5 supertype/
subtype). Inserted in the **same transaction** as its spine row (via the save RPC,
§5). Covers `event_type = gps_activity` for **all** activities — GPS-recorded, manual,
and wearable-imported (a manual activity is simply one with `has_gps_route = false`;
see §12.5 on the historical name `gps_activity`).

**Canonical-unit rule (`db-schema-standards` + Phase 0 §2):** measured quantities are
stored in **canonical SI** (meters, seconds, meters/second) as `numeric`, never float,
plus a **snapshot of the display unit the user logged in** (`unit_distance_snapshot`)
so history renders in the unit used at the time even if the user later switches
`profiles.unit_distance`. Display conversion happens in the client/API layer, never by
mutating stored values.

| Column | Type (intent) | Notes / rules |
| --- | --- | --- |
| `timeline_event_id` | uuid, PK, FK → `timeline_events.id` ON DELETE CASCADE | Shared PK. 1:1. |
| `user_id` | uuid, NOT NULL, FK → `profiles.id` | Denormalized for RLS (§1.5). Must equal the spine row's `user_id` — enforce with a trigger/insert rule so it can't diverge (same discipline Phase 0 §1.5 mandates). |
| `activity_type_code` | text, NOT NULL, FK → `activity_types.code` | Which activity this is. |
| `activity_type_name_snapshot` | text, NOT NULL | **Snapshot** of `activity_types.display_name` at log time (§1.3) — editing the catalog never rewrites history. |
| `title` | text, nullable | User-facing name ("Morning Run"). Needed for feed/history. Default generated client-side (e.g. "Morning Run"). |
| `description` | text, nullable | Optional note. |
| `distance_m` | numeric, nullable | Total distance, meters. NULL for non-distance activities. Computed at finish from the full-res track (GPS) or entered (manual); a **snapshot**, not recomputed on read (Phase 0 §1.2 rule). |
| `unit_distance_snapshot` | text (`km`\|`mi`), NOT NULL | Display unit at log time (from `profiles.unit_distance`). |
| `moving_time_seconds` | integer, nullable | Time excluding pauses. Distinct from the spine's `duration_seconds` (elapsed). CHECK `>= 0` and `<= duration_seconds` (validate at save). |
| `elevation_gain_m` | numeric, nullable | Cumulative ascent, meters. NULL if `tracks_elevation` false or no barometric/GPS elevation. |
| `elevation_loss_m` | numeric, nullable | Cumulative descent, meters. |
| `average_speed_mps` | numeric, nullable | Meters/second. **Pace** (min/km, min/mi) is *derived on display* from this + `unit_distance_snapshot` — do NOT store both speed and pace (redundant, drift risk). |
| `max_speed_mps` | numeric, nullable | |
| `average_hr` | numeric, nullable | **Health-sensitive** (§6). From wearable only. Derived summary we display — storing the derived value (not a raw HR stream) satisfies minimization. Flag §12.6: whether this appears in any shared view. |
| `max_hr` | numeric, nullable | Same sensitivity note. |
| `has_gps_route` | boolean, NOT NULL default false | True ⇔ an `activity_routes` row exists. Lets history/feed decide whether to render a map without joining. |
| `calories_source` | enum (`estimated`\|`wearable`\|`manual`\|`none`) | Provenance of the spine's `energy_kcal` for this activity (§12.7 — estimation needs bodyweight, which is consent-gated). `none` ⇒ `energy_kcal` is NULL, which is valid. |
| `created_at`, `updated_at` | | `updated_at` via the shared `set_updated_at()` trigger. |

Integrity/validation (at the DB boundary, `production-standards` + `db-schema-standards`):
- CHECK: `distance_m >= 0`, `elevation_gain_m >= 0`, `elevation_loss_m >= 0`,
  `average_speed_mps >= 0`, `average_hr`/`max_hr` within a sane physiological band
  (e.g. 20–260) when non-null.
- CHECK: `moving_time_seconds >= 0`.
- The spine already enforces `energy_kcal <= 0` for `gps_activity`
  (`timeline_events_energy_sign_chk`, live). Activity energy is negative expenditure —
  do not duplicate a calorie column here; it lives on the spine so CORE-11/AI-12 read
  it cross-module.

### 1.3 Snapshot discipline at this seam

Same rule as Phase 0 §1.5: `activity_type_name_snapshot` and `unit_distance_snapshot`
freeze the human-meaningful/interpretation fields onto the log row, so editing the
`activity_types` catalog or flipping the user's unit preference **never retroactively
rewrites recorded history**. The spine's `energy_kcal`/`duration_seconds` are already
snapshots; this extends the same discipline through Module A.

### 1.4 `activity_routes` — simplified map geometry (see §2 for the full tiering)

| Column | Type (intent) | Notes / rules |
| --- | --- | --- |
| `timeline_event_id` | uuid, PK, FK → `activity_details.timeline_event_id` ON DELETE CASCADE | 1:1 with the activity. Cascades from the detail row (and transitively from the spine). |
| `user_id` | uuid, NOT NULL | Denormalized for RLS. |
| `simplified_path` | `geometry(LineStringZ, 4326)` (PostGIS) | Douglas-Peucker/`ST_SimplifyVW`-reduced path for map rendering. Z = elevation. This is what CORE-02 draws. |
| `bounds` | `geometry(Polygon, 4326)`, nullable | `ST_Envelope` of the path, for map centering + feed thumbnails. May be a generated column. |
| `raw_track_object_path` | text, NOT NULL | Deterministic Storage path to the full-res compressed track: `activity-tracks/{user_id}/{timeline_event_id}/track.bin` (§2). |
| `raw_track_checksum` | text, nullable | Integrity check for the uploaded blob. |
| `raw_point_count` | integer, nullable | Points in the raw track (diagnostics/quality). |
| `simplified_point_count` | integer, nullable | Points kept after simplification. |
| `created_at`, `updated_at` | | |

Index: **GiST on `simplified_path`** — add it now even though the spatial consumers
(UNQ-01 segments, UNQ-04 heatmaps, AI-16) are Phase 2/3. Routes are write-once, so the
index cost is paid once at finish, and retrofitting a GiST index onto a large table
later is far more disruptive. Justified against write cost per Phase 0 §8.

---

## 2. GPS route storage — the decision and why

This is the highest-volume data in the app (thousands of points per activity). The
decision is a **two-tier hybrid**, and it turns on one observation the alternatives
miss: **the on-device SQLite store is the UI's source of truth (Phase 0 §3.2), and
recording happens offline.** So the per-point write firehose lands in *local* SQLite,
and the server sees the track exactly once — batched on finish. Point-by-point writes
to Postgres never happen.

### 2.1 Chosen shape

1. **Live recording → local-only SQLite.** Each GPS/sensor sample appends to a
   local `route_points_local` table (or a serialized buffer) belonging to the
   *in-progress* activity. Per Phase 0 §3.5 an in-progress recording is **layer-2
   local domain state**, not a synced timeline event and not subject to LWW until it
   commits on finish. This is where the high-frequency write cost lives, and it's
   cheap (local, unindexed append) and correct offline.

2. **On finish → compute once, then two server writes:**
   - **Full-resolution raw track → Supabase Storage** (object storage). One compressed
     blob per activity at the deterministic path
     `activity-tracks/{user_id}/{timeline_event_id}/track.bin`. Contains the full
     stream (`lat`, `lng`, `elevation`, `timestamp`, GPS `accuracy`, and — if present —
     per-point HR). This tier serves **export** (§7), **AI-14 map-matching /
     reconstruction** (Phase 3), and **AI-13** reprocessing (Phase 8). It is
     write-once, read-rarely, not indexed — exactly what object storage is for.
   - **Simplified path → `activity_routes.simplified_path`** (PostGIS `LineStringZ`).
     What CORE-02 actually draws on a map and what feed thumbnails need. PostGIS gives
     spatial indexing (GiST) for the Phase 2/3 spatial features, `ST_Length` for
     verification, and `ST_Envelope` for bounds — the specific reason Phase 0 §9.1
     cited PostGIS as making Postgres fit Module A.
   - **Summary stats** (distance, elevation gain/loss, avg/max speed) are computed
     **once at finish** from the full-res track and stored on `activity_details` as
     snapshots (§1.2) — never recomputed on read.

3. **Idempotency & ordering (retry-safe on a flaky network):** the raw-track upload is
   idempotent because the object path is deterministic from the client-generated
   `timeline_event_id` (re-upload overwrites). The metadata write is idempotent because
   it's an `ON CONFLICT (id) DO UPDATE` upsert (Phase 0 §3.4). Recommended order:
   upload the blob first, then call the save RPC (§5) with `raw_track_object_path`;
   a retry of either step is safe. An orphaned blob from a failed RPC is reclaimed by
   a periodic GC job that deletes track objects with no matching `activity_routes` row.

### 2.2 Rejected alternatives

- **A child table with one row per GPS point (PostGIS `geometry(Point)` per row).**
  Rejected. Thousands of rows per activity × every activity = a table that dwarfs the
  spine, with a punishing insert path and no query that actually wants per-point
  *rows*: map rendering wants a simplified `LineString` (GiST-indexable as one row);
  spatial "activities near here" wants a `LineString` GiST index, not a point-row scan;
  distance/elevation are computed once at finish, not per read. This is the
  "unbounded/unindexed write path that breaks at 100k users" failure Phase 0 §8 warns
  against.

- **Encoded-polyline text blob only, in Postgres, no PostGIS.** Rejected as the *sole*
  representation. It renders a map fine and is compact, but it forfeits every spatial
  query (segments, heatmaps, route recommendation) that Phase 0 explicitly picked
  PostGIS to enable — you'd be re-decoding text and doing geometry math in application
  code. (An encoded polyline is, however, a fine **local SQLite** representation of the
  simplified path, since SQLite has no PostGIS — see §9.)

- **Everything (including full-res) in Postgres.** Rejected. The full-res track is
  high-volume, write-once, read-rarely, and needs no indexing — putting it in Postgres
  bloats the DB and backups for data that object storage stores more cheaply and serves
  via signed URLs.

### 2.3 Cross-user route exposure — deferred to Phase 2 (compliance-driven)

A route is location data (special-category, §6), and its start/end typically reveal a
user's home. **UNQ-05 privacy zones — the mechanism that trims a shared route — is
Phase 2.** Therefore in Phase 1, `activity_routes` is **owner-only** (§8): the public
feed (§5) renders activity *stats*, not the map, cross-user. Sharing the full route
geometry to other users is deferred until privacy zones exist. This is a deliberate
compliance call, flagged for confirmation (§12.3), not an oversight — shipping full
home-revealing routes to a public feed before privacy zones is exactly the kind of
location-privacy gap that surfaces expensively late.

---

## 3. CORE-03 wearable sync — Wear OS / Health Connect (Android-first)

### 3.1 Inbound: a Health Connect activity maps into the *same* shape

A Health Connect `ExerciseSessionRecord` (written by Wear OS or any other Health
Connect writer app) maps to the identical spine + detail shape as a natively recorded
activity — that is the entire point of the canonical timeline:

- `timeline_events`: `source_module = activity`, `event_type = gps_activity`,
  `source = wearable`, `occurred_at`/`duration_seconds`/`local_date` from the session,
  `energy_kcal` (negative) if the session carries `TotalCaloriesBurnedRecord`.
- `activity_details`: `activity_type_code` mapped from the Health Connect exercise
  type; `distance_m` from an associated `DistanceRecord`; `average_hr`/`max_hr` from
  `HeartRateRecord` if present and consented; `calories_source = 'wearable'`;
  `has_gps_route` from whether an `ExerciseRoute` is present.
- `activity_routes`: if the session carries a route, ingest it into the same two-tier
  storage (§2).
- Provenance and dedup go in **`wearable_links`** (§3.4), not on `activity_details` —
  so the model doesn't grow provider-specific columns and stays extensible to the
  deferred Garmin/Apple providers (§12).

**Where ingestion runs (differs from Phase 0 §10):** Health Connect is an *on-device*
Android datastore, not a cloud API. So Wear OS/Health Connect ingestion runs
**on-device** in the RN app via a native Health Connect module → maps to timeline
events → writes to local SQLite → normal background sync (Phase 0 §3). The Edge
Function + queue path that Phase 0 §10 describes is for **cloud** wearable APIs (future
Garmin), not Health Connect. Failure mode: Health Connect unavailable/permission
revoked ⇒ no new device data locally; the local timeline is intact and fully usable —
graceful degradation, no hot-path dependency (Phase 0 §10, `production-standards`
unhappy-path).

### 3.2 Two-way: what MileLift writes *back* ("not just import")

Per the spec's "two-way, not just import," MileLift is both a Health Connect **reader**
(§3.1) and a **writer**: a GPS activity recorded *in* MileLift is written back into
Health Connect as an `ExerciseSessionRecord` (+ `DistanceRecord`,
`TotalCaloriesBurnedRecord`, and — only if the user opts in, §12.7 — an
`ExerciseRoute`), so the rest of the user's Android health ecosystem sees it. Write-back
is gated on the user granting Health Connect *write* permission AND an active `health`
consent row (§6).

**Recommended Phase 1 write-back payload: session + distance + energy, NOT the GPS
route.** Writing a home-revealing route into a shared on-device datastore that other
apps read is a larger privacy surface than the summary; recommend deferring route
write-back until privacy zones (Phase 2), consistent with §2.3. Flagged §12.7.

### 3.3 Loop prevention (the must-have, or you double-count your own activities)

Without this, MileLift writes an activity → Health Connect → MileLift's next read sees
it → a duplicate row. `wearable_links` (§3.4) records, per activity, both the inbound
`external_record_id` (so a re-read of the same session upserts, never duplicates) and
the outbound Health Connect record id we created (so read-back **skips** our own
writes). This also gives AI-19 (wearable dedup, Phase 11) a clean, indexed place to
reconcile overlapping device data — the spine's `source` + `occurred_at` plus these
links make dedup a normal query, per Phase 0 §10.

### 3.4 `wearable_links` — provenance & dedup (owner-only)

| Column | Type (intent) | Notes / rules |
| --- | --- | --- |
| `id` | uuid, PK | Client- or server-generated. |
| `timeline_event_id` | uuid, NOT NULL, FK → `activity_details.timeline_event_id` ON DELETE CASCADE | The activity this link belongs to. |
| `user_id` | uuid, NOT NULL | Denormalized for RLS. |
| `provider` | enum (`health_connect`\|`wear_os`\|`garmin`\|`apple_health`) | Add-only enum. Only `health_connect`/`wear_os` are exercised in Phase 1; the others exist so the shape doesn't preclude them (task constraint) but are not built against. |
| `direction` | enum (`inbound`\|`outbound`) | Did we read this from the provider, or write it to them? |
| `external_record_id` | text, NOT NULL | The provider's record UID. |
| `synced_at` | timestamptz, NOT NULL | |
| `created_at` | timestamptz | |

Unique constraint: `(provider, direction, external_record_id)` — the idempotency guard
that makes re-reading/re-writing the same provider record a no-op. Index
`(timeline_event_id)` for "how did this activity sync."

### 3.5 Recovery/biometric samples — shape designed, ingestion deferred to Phase 2

Phase 0 §1.4/§12.9 slot sleep/HR/HRV/resting-HR ingestion under Module A and ask Phase
1 to confirm. **Recommendation: confirm Module A *owns* the shape, but do NOT build
ingestion in Phase 1** — because its only consumer, AI-06 (adaptive load from recovery
signals), is Phase 2. Persisting raw wearable recovery streams now, with nothing that
reads them, directly violates `health-data-compliance` data-minimization ("don't
persist raw wearable data you don't display or compute from"). So:

- Define the detail table shape now (below) so the spine's already-live
  `sleep_session`/`hr_sample`/`hrv_sample`/`resting_hr` event types aren't orphaned and
  Phase 2 has a target.
- Do **not** wire Health Connect recovery ingestion until AI-06 is built. Flagged
  §12.2.

`biometric_samples` (designed, ingestion Phase 2, owner-only, **never widened** — these
event types are forced `private` by the live `timeline_events_sensitive_private_chk`):

| Column | Type | Notes |
| --- | --- | --- |
| `timeline_event_id` | uuid PK FK → `timeline_events.id` | 1:1. |
| `user_id` | uuid NOT NULL | Denormalized for RLS. |
| `sample_kind` | enum (`sleep`\|`hr`\|`hrv`\|`resting_hr`) | Mirrors the spine event type. |
| `value` | numeric | The single derived value AI-06 needs (bpm, ms, sleep score) — store the derived metric, not a raw firehose (§6). Sleep *duration* uses the spine's `duration_seconds`. |
| `unit` | text | e.g. `bpm`, `ms`. |
| `provider` | enum | Same provider enum as `wearable_links`. |
| `created_at`, `updated_at` | | |

Sleep-stage granularity and multi-sample streams are explicitly **deferred** — add them
in Phase 2 only if AI-06 proves it needs them (minimization).

---

## 4. CORE-04 personal records & achievements

### 4.1 What "PR" means, per activity type

PR metrics are keyed off `activity_types` metadata (§1.1):

- **Distance-based types** (`is_distance_based = true`): `longest_distance`,
  `fastest_avg_pace` (whole-activity average), `longest_duration`, and — if
  `tracks_elevation` — `most_elevation_gain`.
- **Non-distance types**: `longest_duration` (and type-specific metrics added later).

**Phase 1 scope = activity-summary-level PRs only** (computed from `activity_details`
summary columns). **Strava-style "best efforts" over standard sub-distances** (fastest
5k *within* a longer run, etc.) require a rolling-window analysis over the full-res
track — meaningfully heavier — and are **deferred** (§12.4). The `metric` enum below
reserves values for them so adding them later is add-only, not a reshape.

### 4.2 Storage: a cached current-record table + an immutable per-activity log

Computed-on-read is rejected: it re-scans a user's whole history on every history/feed
render, which is the "works at 100 users, dies at 100k" trap and contradicts the Phase
1 gate's "realistic history." Two tables instead:

**`personal_records`** — the fast "current best" cache. One row per
`(user_id, activity_type_code, metric)`:

| Column | Type | Notes |
| --- | --- | --- |
| `user_id` | uuid NOT NULL | |
| `activity_type_code` | text NOT NULL FK → `activity_types.code` | |
| `metric` | enum (`longest_distance`, `fastest_avg_pace`, `most_elevation_gain`, `longest_duration`, + reserved `fastest_1k`/`fastest_5k`/`fastest_10k`/…) | |
| `value` | numeric NOT NULL | Canonical unit; a snapshot. |
| `unit_snapshot` | text | Display unit at achievement time. |
| `timeline_event_id` | uuid NOT NULL FK → `timeline_events.id` ON DELETE … | The activity that currently holds it. |
| `achieved_at` | timestamptz NOT NULL | = that activity's `occurred_at`. |
| `previous_value` | numeric, nullable | What it beat, for "new PR (+X)" display. |
| `created_at`, `updated_at` | | |

Primary key / unique: `(user_id, activity_type_code, metric)` — this is what makes
detection O(#metrics) point lookups.

**`activity_achievements`** — the immutable historical log of what an activity earned
*when it happened*, independent of later PRs (a badge earned then is a fact, not
something a future activity should erase — historical-integrity discipline, Phase 0
§1.5). Drives the "this activity set N PRs" badge on history/feed without recomputation:

| Column | Type | Notes |
| --- | --- | --- |
| `id` | uuid PK | |
| `timeline_event_id` | uuid NOT NULL FK → `timeline_events.id` ON DELETE CASCADE | The activity. |
| `user_id` | uuid NOT NULL | Denormalized for RLS. |
| `metric` | enum (same as above) | |
| `value` | numeric NOT NULL | The value achieved. |
| `rank` | enum (`pr`\|`second`\|`third`), nullable | Top-3 style, if desired; `pr` alone is the minimum. |
| `created_at` | | |

Unique `(timeline_event_id, metric)` — the idempotency guard so a retried save never
double-inserts a badge.

### 4.3 Detection without a full-history scan

- **Steady state (per activity save/import):** detection runs **inside the
  `save_activity_v1` RPC** (§5), in the same transaction, as **one indexed point lookup
  per metric** against `personal_records` (keyed by `(user_id, activity_type_code,
  metric)`). If the new activity's value beats the cached record: `UPDATE`
  `personal_records` (setting `previous_value`) and `INSERT … ON CONFLICT DO NOTHING`
  into `activity_achievements`. Cost is O(#metrics), independent of history size — this
  is the whole reason the cache exists. Idempotent under retry by construction (`>=`
  comparison + `ON CONFLICT`).
- **Backfill (one-time, at wearable/history import or AI-03 cold-start):** import all
  historical activities first, then call `recompute_prs_for_user_v1(user_id)` **once**,
  which does a bounded, indexed `MAX/MIN`-per-metric aggregate over the user's
  activities of each type (served by the spine's `(user_id, event_type, occurred_at)`
  index + `activity_details`). The full scan happens **exactly once at import**, never
  per save.
- **The one genuinely expensive case — deleting/editing the activity that *holds* a
  current PR:** handled lazily and narrowly. On such a delete/edit, mark the affected
  `personal_records` row stale and recompute **just that one (type, metric)** via a
  single indexed aggregate — not a whole-history rescan, and rare. `activity_achievements`
  rows for a deleted activity cascade away with it (they were facts about that activity);
  the *current-best* recompute is the only work.

Detection also fires for **wearable-imported** activities (§3.1), through the same RPC
path, so an imported PR is detected identically to a recorded one.

---

## 5. API surface (`api-contract-standards` + `supabase-standards`)

Per Phase 0 §5, RLS is the authorization mechanism and there are no `/v1` URL versions;
RPC/function versions carry the version suffix instead.

- **Reads → direct PostgREST under RLS.** Own activity history (CORE-02), a single
  activity + its detail/route, PR list, feed (CORE-05) are filtered selects where RLS
  fully expresses authorization. History/feed pagination is **cursor-based on
  `(occurred_at, id)`** (Phase 0 §3.6), never offset.
- **Saving/finishing an activity → a Postgres RPC `save_activity_v1`, `SECURITY
  INVOKER`** (RLS still applies). This is the right layer per `supabase-standards`
  because a finish is **transactional across multiple tables** — `timeline_events` +
  `activity_details` + (optional) `activity_routes` + PR detection (§4.3) — which §1.5
  requires be one transaction, and which a bare multi-row PostgREST upsert can't do
  atomically. Inputs: the client-generated `id` (idempotency key), the spine fields,
  the detail fields, the simplified path (as GeoJSON or an encoded polyline the RPC
  converts to `geometry`), and `raw_track_object_path` (the blob is uploaded to Storage
  *before* the RPC call, §2.1). Body-of-function must re-validate ownership implicitly
  via RLS (INVOKER) and validate business invariants (`moving_time <= elapsed`, signs,
  ranges). Version-suffixed so a contract change ships as `save_activity_v2` without
  breaking app versions in the field (Phase 0 §5, `supabase-standards`).
- **Kudos → direct PostgREST** (insert/delete under the §8 policies) — no RPC needed;
  RLS expresses the rule.
- **Future cloud wearable ingestion (Garmin) → Edge Function + queue** (Phase 0 §10).
  **Health Connect ingestion is on-device, not an Edge Function** (§3.1).
- **Error envelope** (RPC/Edge Function): the single `{ "error": { "code", "message",
  "field" } }` shape with a stable machine `code` (Phase 0 §5) — e.g.
  `MOVING_TIME_EXCEEDS_ELAPSED`, `INVALID_ENERGY_SIGN`, `CONSENT_REQUIRED_LOCATION`.
  Never a raw Postgres/ORM error to the client.
- **Aggregations** (weekly distance, activity-type breakdowns) → `SECURITY INVOKER`
  RPCs, computed server-side, not reassembled on the client (Phase 0 §5).
- The contract (RPC signatures, PostgREST resource shapes, error codes) is written down
  (OpenAPI/equivalent) and kept in sync — builders implement against it, not a guess.

---

## 6. Data sensitivity (`health-data-compliance` — flag early)

Module A touches **location** (GPS routes — special-category) and **health**
(heart-rate summaries, and the deferred recovery samples) data throughout.

- **Consent gating, reusing the live Phase 0 mechanism.** The `consent_category` enum
  already carries `location` and `health` (`20260718210826_create_user_consents.sql`).
  GPS recording and route persistence are gated on an active **`location`** consent row;
  HR summaries and (deferred) recovery samples on **`health`**. Enforce at the DB layer
  with the *same trigger pattern as `enforce_health_consent`* (a `BEFORE INSERT/UPDATE`
  trigger that rejects the write with a specific errcode when no active consent exists)
  — recommended on `activity_routes` (location) and on `average_hr`/`max_hr` presence /
  `biometric_samples` (health). This is a real UI surface: `ui-ux-designer` owns the
  point-of-use, specific-purpose prompts (§13), and revocation must degrade gracefully
  (recording without a route, no crash, no stale-authorized reuse).
- **Data minimization.** Store derived summaries (avg/max HR, distance, elevation), not
  raw firehoses, in Postgres; the full-res raw track lives in owner-only Storage
  because export/AI-14 genuinely need it — not "just in case." Recovery-sample
  ingestion is deferred precisely because nothing consumes it yet (§3.5).
- **Never-shareable enforcement is already live** on the spine: `sleep_session`,
  `hr_sample`, `hrv_sample`, `resting_hr` are forced `visibility = private` by
  `timeline_events_sensitive_private_chk`. Activities (`gps_activity`) *can* be
  widened, which is why route/HR exposure needs the §2.3/§12.6 decisions.
- **Storage** (`activity-tracks` bucket): owner-only, fail-closed policies on
  `storage.objects`, served via **short-expiry signed URLs**, never a public bucket
  (`supabase-standards`, Phase 0 §6).
- **Third-party leakage guard.** No `toJSON()` of an activity/route into an analytics
  or crash-report payload — no raw GPS/HR values leave to third-party SDKs (Phase 0 §6).
- **Export/deletion/correction** (§7) all extend the Phase 0 walk to the new tables.

---

## 7. User-rights code paths (extend the Phase 0 walk to Module A)

- **Export:** the activity tables join the existing timeline export — activity detail +
  route metadata + the raw-track blobs from Storage + PRs, into the portable format.
  A real, tested path (`health-data-compliance`), not a support process.
- **Deletion:** cascades are wired so `profiles` → `timeline_events` →
  `activity_details` → (`activity_routes`, `wearable_links`, `activity_achievements`)
  all `ON DELETE CASCADE`; `personal_records` and `kudos` referencing a deleted event
  cascade too. **Plus** the Storage `activity-tracks/{user_id}/…` objects must be purged
  by the same account-deletion job (Phase 0 §7 warns deletion must not leave orphaned
  health rows — here the orphan risk is **Storage blobs**, which cascades don't reach:
  `db-engineer` + `backend-builder` must ensure the deletion job explicitly deletes the
  user's track objects). Honors the Phase 0 §12.2 hard-delete-after-grace policy.
- **Correction:** an activity is a normal editable timeline event; editing distance/
  type/title flows through `save_activity_v1` (which re-runs PR detection, §4.3). No
  support ticket.

---

## 8. RLS boundary — one row per new table (`db-engineer` implements)

Same discipline as Phase 0 §8. RLS enabled in the same migration as each table.
Cross-user reads are encoded in the policy, never filtered in app code after an
over-broad query (`supabase-standards`).

| Table | RLS posture |
| --- | --- |
| `activity_types` | **Not user-owned, not a timeline event.** Public read to `authenticated`; writes restricted to the service role. Same class as the exercise/food libraries (Phase 0 §8). |
| `activity_details` | Owner-only via denormalized `user_id = auth.uid()`. SELECT/INSERT/UPDATE; **no client DELETE** (deletion is soft-delete on the parent spine row + cascade at hard-purge, mirroring `timeline_events`). Column-scoped UPDATE grant excluding `timeline_event_id`/`user_id`. |
| `activity_routes` | **Owner-only in Phase 1** (`user_id = auth.uid()`), incl. SELECT — the public feed does **not** expose routes cross-user until privacy zones (UNQ-05, Phase 2). §2.3/§12.3. Location-consent-gated write (§6). GiST index on `simplified_path`. |
| `wearable_links` | Owner-only. INSERT/SELECT/DELETE by owner (dedup housekeeping); no cross-user exposure. |
| `biometric_samples` | Owner-only, **never widened** (matches the spine forcing these event types private). Ingestion deferred (§3.5) but the policy is defined with the table. |
| `personal_records` | Owner-only in Phase 1. (Cross-user "PRs on a public profile" is a Phase 4 profile/community concern — defer widening, same fail-closed posture as the Phase 0 feed gap.) |
| `activity_achievements` | Owner-only in Phase 1. Cross-user feed badges depend on the deferred cross-user activity exposure (§2.3) + follows (Phase 4) — defer widening. |
| `kudos` | **The one Module A table with a genuine cross-user policy** (§8.1 below). |
| Storage bucket `activity-tracks` | Owner-only, fail-closed, signed URLs (Phase 0 §6). Path-prefixed by `user_id`. |

### 8.1 `kudos` — the cross-user table (design detail for `db-engineer`)

Kudos is a **social edge, not a timeline event** — it does NOT go on the spine (Phase 0
§1.1 is explicit: kudos/reactions/follows are edges). It conceptually belongs to Module
D's social domain, but is built now to satisfy CORE-05 (flagged §12.1).

| Column | Type | Notes |
| --- | --- | --- |
| `id` | uuid PK | Client-generated (idempotency). |
| `timeline_event_id` | uuid NOT NULL FK → `timeline_events.id` ON DELETE CASCADE | The activity reacted to. |
| `actor_user_id` | uuid NOT NULL FK → `profiles.id` | Who reacted = `auth.uid()`. |
| `target_owner_user_id` | uuid NOT NULL FK → `profiles.id` | Denormalized owner of the target event — for the "kudos on my activities" query + simpler policy. Copied at insert; enforce it matches the target event's `user_id`. |
| `reaction_type` | enum (`kudos`, extensible to emoji reactions) | Spec says "kudos/social reactions" — one type now, add-only later. |
| `created_at` | timestamptz | |

- Unique `(timeline_event_id, actor_user_id, reaction_type)` — one kudos per user per
  activity; makes a retried insert a no-op (idempotency, `supabase-standards`).
- Index `(target_owner_user_id, created_at)` for the notifications/"my kudos" read.
- **RLS:**
  - **INSERT:** `with check (actor_user_id = auth.uid() AND target_owner_user_id <>
    auth.uid() AND EXISTS (a SELECT on the target `timeline_events` row succeeds for
    me))` — you can only kudos an activity you can actually see, and not your own. In
    Phase 1 "can see" = the target is `visibility = 'public'` (the live feed policy);
    when follows land (Phase 4) this widens automatically with the timeline_events
    policy.
  - **SELECT:** `actor_user_id = auth.uid() OR target_owner_user_id = auth.uid() OR the
    target event is visible to me` — the activity owner sees who kudos'd; the actor sees
    their own; anyone who can see a public activity sees its kudos (for counts/lists).
  - **DELETE:** allowed for the actor (`actor_user_id = auth.uid()`) — un-kudos is a
    legitimate immediate hard delete. This is a **reasoned exception** to the app's
    no-client-DELETE default: kudos is not health/log data, and un-kudos must take
    effect at once (not a grace-window soft delete). Stated explicitly per Phase 0's
    discipline of justifying every widening.
  - **No UPDATE.**
- **Kudos counts:** computed via an indexed `COUNT(*)` on `(timeline_event_id)`, not a
  denormalized counter column on `activity_details` (a counter invites concurrency/
  consistency bugs). A `COUNT` with the index is fine at Phase 1 scale; **flag** that a
  materialized count/cache is the scale-out path if a single hot public activity's
  kudos count ever dominates (revisit with Module D at Phase 4, not now).

---

## 9. Sync / offline implications (modules inherit Phase 0 §3; Module A specifics)

- **Offline is core.** Recording is the canonical offline case: an activity is recorded
  entirely offline and syncs on finish/reconnect.
- **In-progress recording = layer-2 local domain state** (Phase 0 §3.5), NOT a synced
  timeline event and NOT subject to LWW until it commits on finish. Only the *finished*
  activity becomes a spine row. This is the single most important Module A sync rule and
  it is inherited, not reinvented.
- **Conflict resolution = the platform default: last-write-wins by server `updated_at`
  at the event-row grain** (Phase 0 §3.5). Editing a finished activity's title/type
  after sync is LWW like any other event. No field-level merge (Phase 0 §11) — GPS
  tracks are write-once so they don't produce field-level conflicts.
- **Idempotency** is the client-generated `id` on the spine + `ON CONFLICT (id) DO
  UPDATE` in `save_activity_v1`, plus the deterministic Storage path (§2.1) and the
  `kudos`/`wearable_links` unique constraints. A retried finish never creates a second
  activity — the "why do I have two copies of my run" bug is designed out.
- **Local store extension.** `src/db/schema.ts`'s `SCHEMA_STATEMENTS` gains
  `activity_details`, a local **`activity_routes`** (simplified path stored as an
  **encoded polyline text** column — SQLite has no PostGIS, §2.2), a local-only
  **`route_points_local`** for in-progress recording, `personal_records` (pullable
  cache), and `kudos` — each with the existing `sync_status` / `pending_payload` /
  `last_sync_error` columns and the visible `SyncStatusPill` signal. `route_points_local`
  is deliberately **not synced** (like `local_preferences`) — it's consumed into the
  finished activity and can be cleared after a successful finish sync.
- **Sync cursor** stays `updated_at` on the spine (Phase 0 §3.6); pulling a changed
  activity pulls its detail/route via the shared PK.

---

## 10. Third-party integration failure modes

- **Health Connect / Wear OS (on-device).** Unavailable, permission-not-granted, or
  permission-revoked ⇒ no new device data and no write-back; the local timeline is
  intact and fully usable. No hot-path or network dependency (it's on-device). Revocation
  degrades gracefully per §6 (record without route, don't crash, don't reuse stale
  authorized data).
- **Supabase Storage (raw track upload).** If the blob upload fails on finish, the
  activity is still saved locally (source of truth) and the metadata write is retried;
  the upload retries independently (idempotent path). A never-completing upload leaves
  `has_gps_route = true` with a missing blob — the finish flow must treat upload success
  as a precondition for setting `raw_track_object_path`, and the GC job reconciles
  orphans. Never report finish as "synced" on a partial failure (`production-standards`).
- **Future cloud wearables (Garmin, deferred).** Per Phase 0 §10, ingestion is async via
  Edge Function + queue, never on a hot path. Out of scope Phase 1; boundary restated.

---

## 11. Explicit tradeoffs — what we chose NOT to do, and why

- **No per-GPS-point table.** Chose a simplified PostGIS `LineString` + a full-res blob
  in Storage. We give up per-point relational queries (which nothing needs) to avoid a
  table that dwarfs the spine and a punishing write path (§2.2).
- **No point-by-point server streaming during recording.** The per-point firehose stays
  in local SQLite; the server sees the track once, batched on finish. We give up
  "live-on-the-web mid-activity tracking" (not a CORE-01…05 requirement; UNQ-02 live
  segments is Phase 2) to keep the hottest path off the network and correct offline.
- **No cross-user route exposure in Phase 1.** Deferred to Phase 2 with privacy zones
  (§2.3). We give up shared route maps on the feed now to avoid shipping home-revealing
  location data before the mechanism that protects it exists.
- **No recovery-sample ingestion in Phase 1.** Shape designed, ingestion deferred to
  Phase 2 when AI-06 consumes it (§3.5). We give up nothing a user sees, and honor
  data-minimization.
- **No sub-distance "best efforts" PRs in Phase 1.** Activity-summary PRs only; the
  metric enum reserves room for best-efforts (§4.1). We give up Strava-parity best
  efforts now to avoid a per-point rolling-window computation with no Phase 1 consumer.
- **PRs cached, not computed-on-read.** We accept a small maintained cache + a rare
  narrow recompute on record-holder deletion, to avoid a full-history scan on every
  read/save (§4).
- **Kudos built in Phase 1 though it's conceptually Module D.** We accept building one
  social-edge table early to satisfy CORE-05, rather than blocking CORE-05 on Phase 4.
  We are NOT building follows, comments, challenges, or leaderboards here (Phase 4 /
  Phase 2) — flagged to prevent scope creep (§12.1).
- **`activity_types` as a reference table, not an enum.** We accept a seed table + a
  join to buy per-type metadata (PR eligibility, distance/elevation flags) an enum can't
  carry, and cheaper extension (an INSERT, not a migration).

---

## 12. Decisions (resolved 2026-07-19) and open questions

**Resolved by the person — all seven architect recommendations accepted as-is:**

1. Feed/kudos: Phase 1 ships the data model + own-activity history view only; the
   follow-based social feed and cross-user kudos loop wait for Phase 4.
2. Recovery/biometric ingestion: shape defined now, ingestion deferred to Phase 2 (AI-06).
3. Cross-user route sharing: public feed exposes stats only; `activity_routes` stays
   owner-only until UNQ-05 privacy zones (Phase 2).
4. Sub-distance "best efforts" PRs: deferred; activity-summary PRs only in Phase 1.
5. Activity-type catalog & naming: keep the historical `gps_activity` event-type name;
   `db-engineer` proposes a sensible launch seed list for `activity_types`.
6. HR summary: excluded from any shared/cross-user payload by default.
7. Health Connect write-back: session + distance + energy only, no route. Energy left
   NULL (`calories_source = 'none'`) when bodyweight/consent is unavailable, no
   estimate fallback.

**Still open / unchanged from Phase 0, do not block Module A:** launch jurisdiction
(§12.5 of the Phase 0 doc), CORE-11 reconciliation policy, `load_score` formula.

**Remaining action for `db-engineer`, not a person-decision:** propose a sensible
launch seed list for `activity_types` (run/ride/walk/hike/swim/row/etc., with
`category`/`is_distance_based`/`tracks_elevation`/`supports_gps` per type) as part of
the migration — extending the list later is an `INSERT`, not a schema change, so this
doesn't need to be exhaustive at launch.

---

## 13. UI-surface note (sequencing)

Module A has **major real UI surfaces**: the live recording screen (CORE-01, with the
GPS/location consent prompt at point of use, §6), the activity detail + route map and
history list (CORE-02), the PR/achievement surfaces (CORE-04), and the feed + kudos
(CORE-05). Per the standing rule (Phase 0 §13) that a screen must not be built against
no design decision: **`ui-ux-designer` runs before `mobile-builder`** on these. This
doc owns the data model and API/RLS contract; it does **not** own the screen-level
visual/UX design — in particular the recording UX, the map interaction, and the
consent-at-point-of-use prompts (specific purpose strings, graceful degradation on
revocation) are `ui-ux-designer`'s to design before implementation starts.

Implementation routing for the build: `db-engineer` (all §1/§3.4/§4.2/§8 tables + RLS +
`activity-tracks` bucket policies + the consent-gating triggers), `backend-builder`
(`save_activity_v1` / `recompute_prs_for_user_v1` RPCs, the Storage GC job, the future
Garmin Edge Function), `mobile-builder` (recording engine, Health Connect native
module, local store extension §9, sync), `ui-ux-designer` (the surfaces above, first).
