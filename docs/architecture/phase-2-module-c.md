# Phase 2 — Module C: Strength Training & Workout Logging (CORE-12 … CORE-17)

Status: **CONFIRMED (2026-07-21) — all §12 open questions resolved by the person
(§12 Decisions).** Ready for `db-engineer` + `backend-builder`. One decision (progress-
photo consent) diverged from the architect's recommendation toward the stricter option
(a dedicated `body_image` consent category); the body below is updated to match.

Owner: `architect`. Downstream consumers: `db-engineer` (schema + RLS + migrations +
the two Storage buckets + consent-gating triggers + the exercise-library seed),
`backend-builder` (the save RPC, the analytics/progression RPCs, the exercise-library
ingestion job, the Storage GC + account-deletion purge), `mobile-builder` (offline-first
set logging + rest timer + background sync — "the hardest item in this phase"),
`ui-ux-designer` (logging screen, exercise library/search, workout & program builder,
progress analytics, progress-photo/measurement capture, and the camera/health consent
prompts — must run before `mobile-builder`, §13).

This doc is designed **against** `docs/architecture/phase-0-foundation.md` and reuses,
verbatim, the Phase 0 + Phase 1 patterns already live in `supabase/migrations/`:
client-generated UUID PK doubling as the idempotency key; denormalized `user_id` for
RLS; the `set_updated_at()` and `force_insert_audit_timestamps()` triggers;
column-scoped `GRANT`s (with the naive-`.upsert()` gotcha called out per-table, §8.1);
no client `DELETE` + soft-delete via `deleted_at`; consent-gating triggers against
`user_consents` (`enforce_health_consent()` pattern); add-only enums; partial indexes
on `deleted_at IS NULL`; fail-closed RLS; the `private` schema for internal-only helper
functions; the `{"data"}`/`{"error":{"code","message","field"}}` RPC envelope; a
cached-records + immutable-achievements-log pair for PRs; owner-only Storage buckets
with signed URLs. Where this doc says "same pattern as Phase 1," it means those exact
mechanisms — do not reinvent them.

**Scope (this doc):** CORE-12 (set/rep/weight logging + rest timer), CORE-13 (exercise
library with video), CORE-14 (custom workout & program builder), CORE-15 (progress
analytics — volume, 1RM, PRs), CORE-16 (progress photos & body measurements), CORE-17
(offline logging with background sync). **Out of scope** (noted only where they
constrain a shape decided now): AI-01 CV form-check (Phase 9), AI-03 cold-start (uses
1RM estimate — a read of what's designed here), AI-06 recovery→load (consumes the
spine's `load_score`, Phase 2/8), AI-08 predictive next-set (reads this history),
shared/community routines (Phase 4 widening of the owner-only template tables),
program *calendar scheduling / auto-progression* (a later builder concern; Phase 2
ships the builder data model + logging a session from a template, not a scheduling
engine — §11).

---

## 0. What Module C adds to the spine, in one paragraph

A completed workout is **one `timeline_events` row** (`source_module = strength`,
`event_type = strength_session`), carrying the spine's cross-module currencies
(`load_score` = training stress for AI-06; `energy_kcal` negative = expenditure when
estimable; `duration_seconds`; `visibility`; `occurred_at`; `local_date`). Session-level
detail hangs off it 1:1 in **`workout_sessions`** (shared PK); the actual set/rep/weight
firehose is the child collection **`workout_set_logs`** — one client-UUID'd row per
set, the high-volume offline write. The **exercise library** (`exercises` +
`exercise_media`) is a global reference table, **not** user-owned and **not** a timeline
event (same class as `activity_types` and the food DB); a user's own movements live in
owner-only **`custom_exercises`**. A set log **snapshots** the exercise name (and key
metadata) alongside the reference FK, so editing the library never rewrites history —
the exact Phase 2 gate rule. Reusable definitions — **`workout_templates`**
(+`workout_template_exercises`) and **`programs`** (+`program_workouts`) — are
owner-owned *templates, not events* (Phase 0 §1.1), and a session logged from one
snapshots the template name too. Biometric logs — **`bodyweight_logs`**,
**`body_measurements`** (+`body_measurement_values`), **`progress_photos`**
(+`progress_photo_images`) — are their own already-declared spine event types
(`bodyweight`/`body_measurement`/`progress_photo`), **forced private and never
shareable** by the live spine CHECK, consent-gated at the DB layer. PRs mirror Module A
exactly: a cached **`strength_records`** table + an immutable **`strength_achievements`**
log, maintained by O(#exercises×#metrics) indexed point-lookups inside the save RPC.
Progress photos live in an owner-only **`progress-photos`** Storage bucket (signed URLs,
never public), mirroring `activity-tracks`.

---

## 1. Data model — new tables

All user-owned tables denormalize `user_id` (copied from the spine at insert, or set to
`auth.uid()` for the non-event definition tables) so their RLS policy is a direct
`user_id = auth.uid()` check, per Phase 0 §1.5. `db-engineer` owns exact Postgres
types/constraints/migration; the columns, semantics, and integrity rules below are the
contract. **Canonical-unit rule** (`db-schema-standards`): all measured quantities are
`numeric` (never float), stored in a canonical unit (weight in **kilograms**, distance
in meters where relevant), with a **snapshot of the display unit the user logged in**
(`unit_weight_snapshot`) so history renders in the unit used at the time even if the
user later switches `profiles.unit_weight`. Display conversion is client/API-layer only.

### 1.1 `exercises` — the global exercise library (NOT user-owned, NOT a timeline event)

CORE-13's "1,400+ movements." Same ownership class as `activity_types` / the food DB
(Phase 0 §5/§8): global, read-mostly, **service-role-write, public-read to
`authenticated`**. Modeled as a table (not an enum) because PR eligibility, muscle
targeting, equipment filtering, and search all need per-movement *metadata*.

| Column | Type (intent) | Notes / rules |
| --- | --- | --- |
| `id` | uuid, PK | Stable library id. Referenced (and **snapshotted**, §3) by `workout_set_logs` and `workout_template_exercises`. |
| `slug` | text, UNIQUE, NOT NULL | Stable human/machine key (e.g. `barbell-back-squat`), stable across re-ingests so a source update doesn't fork duplicates. |
| `name` | text, NOT NULL | Canonical display name; localized on client. |
| `primary_muscle` | enum (`muscle_group`) | e.g. `quadriceps`, `chest`, `lats`. Add-only enum. Drives UNQ-09 muscle-categorized library + analytics-by-muscle. |
| `secondary_muscles` | `muscle_group[]` | Array of secondary movers. |
| `equipment` | enum (`equipment_type`) | `barbell`\|`dumbbell`\|`machine`\|`cable`\|`bodyweight`\|`kettlebell`\|`band`\|`other`. Drives the builder's equipment filter + AI-generated-workout equipment matching. |
| `mechanic` | enum (`compound`\|`isolation`), nullable | For analytics + program balance. |
| `force_vector` | enum (`push`\|`pull`\|`static`), nullable | |
| `is_distance_based`, `is_time_based`, `is_weighted`, `is_bodyweight` | boolean, NOT NULL | Which of {reps, weight, distance, duration} a set of this movement records — drives the logging UI's field set and which PR metrics apply (§4). A plank is time-based, not weighted; a run-on-treadmill is distance/time; a squat is weighted+reps. |
| `instructions` | text, nullable | Step text (attribution-bearing — §2). |
| `source` | enum (`source_dataset`) | Provenance for attribution/licensing (§2): `free_exercise_db`\|`wger`\|`milelift_authored`. |
| `attribution` | text, nullable | Per-entry attribution string the license requires be shown (§2, §6). |
| `is_active` | boolean, NOT NULL default true | Soft-hide a bad/duplicate entry without deleting (history still snapshots it). |
| `created_at`, `updated_at` | | |

Seeded/maintained by an **ingestion job** (`backend-builder`, §2), not hand-edited.
Extending is an `INSERT`, not a schema change.

### 1.2 `exercise_media` — video/image demos for a library exercise (child of `exercises`)

Split from `exercises` because a movement has **0..N** media of mixed type, from mixed
sources with mixed licenses, and the video-content track backfills these over time
independently of the movement metadata (§2). Media is **display data, re-fetchable —
NOT snapshotted** onto set logs (§3).

| Column | Type | Notes |
| --- | --- | --- |
| `id` | uuid, PK | |
| `exercise_id` | uuid, NOT NULL, FK → `exercises.id` ON DELETE CASCADE | |
| `media_type` | enum (`image`\|`animation`\|`video`) | Supports the phased content strategy (§2): static image now, video backfilled. |
| `url_or_object_path` | text, NOT NULL | Either a hosted/CDN URL or a Storage object path in the `exercise-media` bucket (§2 hosting decision). |
| `is_primary` | boolean, NOT NULL default false | The one shown by default. |
| `source` | enum (`source_dataset`) | Same enum as `exercises.source`. |
| `attribution`, `license` | text | Per-media attribution + license id (e.g. `CC-BY-SA-4.0`) — the share-alike/attribution obligation is per-asset (§2, §6). |
| `sort_order` | integer | |
| `created_at`, `updated_at` | | |

RLS: **public read to `authenticated`, service-role write** (§8). This is a reference
table, not user data.

### 1.3 `custom_exercises` — user-created movements (owner-owned definition, NOT an event)

A user's own movement not in the library (Phase 0 §1.1: "user-owned definitions that
are not a point-in-time occurrence live in their own module tables, not the spine").
Owner-only RLS. A `workout_set_logs` row references **either** an `exercise_id`
**or** a `custom_exercise_id` (exactly one; CHECK), and snapshots the name either way.

| Column | Type | Notes |
| --- | --- | --- |
| `id` | uuid, PK | Client-generated (can be created offline). |
| `user_id` | uuid, NOT NULL, FK → `profiles.id` ON DELETE CASCADE | Owner. |
| `name` | text, NOT NULL | |
| `primary_muscle` | enum (`muscle_group`), nullable | |
| `equipment` | enum (`equipment_type`), nullable | |
| `is_weighted`, `is_bodyweight`, `is_time_based`, `is_distance_based` | boolean, NOT NULL | Same field-set drivers as library exercises. |
| `notes` | text, nullable | |
| `deleted_at` | timestamptz, nullable | Soft-delete (a set may still snapshot-reference it historically). |
| `created_at`, `updated_at` | | |

### 1.4 `workout_sessions` — the CORE-12 subtype (1:1 with the spine)

Shared PK = `timeline_event_id`, 1:1 FK to `timeline_events.id`, inserted in the **same
transaction** as its spine row via the save RPC (§5). Covers `event_type =
strength_session`. Session-level metadata only — the sets are the child collection §1.5.

| Column | Type (intent) | Notes / rules |
| --- | --- | --- |
| `timeline_event_id` | uuid, PK, FK → `timeline_events.id` ON DELETE CASCADE | Shared PK. 1:1. |
| `user_id` | uuid, NOT NULL, FK → `profiles.id` | Denormalized for RLS; must equal the spine row's `user_id` — enforced by trigger (§1.6), same discipline as `activity_details`. |
| `title` | text, nullable | "Push Day A". Default generated client-side. |
| `notes` | text, nullable | |
| `source_template_id` | uuid, nullable, FK → `workout_templates.id` ON DELETE SET NULL | If logged from a template. FK is nullable + SET NULL so deleting a template never deletes history. |
| `template_name_snapshot` | text, nullable | **Snapshot** of the template name at log time (§3) — editing/deleting the template never rewrites this session's history. |
| `session_rpe` | numeric (0–10), nullable | Session-level rate of perceived exertion (CR-10 scale). Feeds `load_score` (§4.4). CHECK 0–10. |
| `total_volume_kg` | numeric, nullable | **Snapshot** at save: Σ(reps × weight_kg) over working sets. Denormalized so history/analytics don't re-scan every set on every read. Recomputed by the save RPC on every edit, never live-joined. |
| `total_sets` | integer, nullable | Snapshot count of completed working sets. |
| `calories_source` | enum (`activity_calories_source`, reused: `estimated`\|`wearable`\|`manual`\|`none`) | Provenance of the spine's `energy_kcal`. `none` ⇒ `energy_kcal` NULL (valid). Estimation needs bodyweight+consent, same gate as Module A (§6, §12). |
| `created_at`, `updated_at` | | |

Note: a `strength_session` **can** be shared (`visibility` follower/public) — people
share workouts; it is deliberately *not* in the spine's never-shareable list. Its child
sets inherit visibility from the session (there is no separate per-set visibility).

### 1.5 `workout_set_logs` — the set/rep/weight firehose (child of `workout_sessions`)

The heart of CORE-12 and the **offline-idempotency** design (§9). One row per set. Each
row carries its **own client-generated `id`** (a second idempotency grain below the
session, §9.2). Hangs off `workout_sessions`, **not** the spine (Phase 0 §1.5: deeper
child collections hang off the detail table). This is the most heavily-written table in
the module — index count is justified against insert cost.

| Column | Type (intent) | Notes / rules |
| --- | --- | --- |
| `id` | uuid, PK | **Client-generated** on-device — the per-set idempotency key (§9.2). |
| `timeline_event_id` | uuid, NOT NULL, FK → `workout_sessions.timeline_event_id` ON DELETE CASCADE | The session this set belongs to. |
| `user_id` | uuid, NOT NULL | Denormalized for RLS; must equal the parent session's `user_id` (trigger, §1.6). |
| `exercise_id` | uuid, nullable, FK → `exercises.id` | Library movement… |
| `custom_exercise_id` | uuid, nullable, FK → `custom_exercises.id` | …or a custom movement. CHECK: exactly one of the two is non-null. |
| `exercise_name_snapshot` | text, NOT NULL | **Snapshot** of the movement name at log time (§3) — the gate rule. |
| `primary_muscle_snapshot` | enum (`muscle_group`), nullable | **Snapshot** so muscle-volume analytics of *historical* sets don't shift when the library entry is re-categorized. |
| `exercise_order` | integer, NOT NULL | Order of the exercise within the session (groups sets of the same movement; supersets share adjacent orders). |
| `set_number` | integer, NOT NULL | 1-based set index within that exercise. |
| `set_type` | enum (`working`\|`warmup`\|`dropset`\|`failure`\|`amrap`), NOT NULL default `working` | Warmups excluded from volume/PR by default (§4). |
| `reps` | integer, nullable | CHECK `>= 0`. Null for a pure time/distance movement. |
| `weight_kg` | numeric, nullable | Canonical kg. CHECK `>= 0`. Null for bodyweight/time movements. |
| `unit_weight_snapshot` | enum (`kg`\|`lb`), NOT NULL | Display unit at log time (from `profiles.unit_weight`). |
| `is_bodyweight` | boolean, NOT NULL default false | Bodyweight movement; `weight_kg` may hold added load (0 = pure bodyweight). |
| `duration_seconds` | integer, nullable | For time-based movements (plank). CHECK `>= 0`. |
| `distance_m` | numeric, nullable | For distance-based gym cardio. CHECK `>= 0`. |
| `rpe` | numeric (0–10), nullable | Per-set RPE. CHECK 0–10. |
| `rest_seconds_planned` | integer, nullable | CORE-12 rest timer target. |
| `rest_seconds_actual` | integer, nullable | Recorded actual rest (client computes from timestamps). Mostly a display/analytics field; the timer itself is client-side UI (§9.5). |
| `is_completed` | boolean, NOT NULL default true | A logged-but-skipped/planned set can be `false`. |
| `estimated_1rm_kg` | numeric, nullable | **Snapshot** of the estimated 1RM for this set at log time, via the chosen formula (§4.2, §12). Stored (not live-computed) so history is stable if the formula changes; PR detection reads it. |
| `notes` | text, nullable | |
| `deleted_at` | timestamptz, nullable | Soft-delete a removed set; syncs as an update (§9.2). |
| `created_at`, `updated_at` | | |

Indexes (justified against write cost, `db-schema-standards`):
- `(timeline_event_id, exercise_order, set_number)` — the dominant "load this session's
  sets in order" read + the session render.
- `(user_id, exercise_id)` partial `where deleted_at is null` — the analytics/PR read
  "all my sets of this movement over time." A parallel partial index on
  `(user_id, custom_exercise_id)` for custom movements.
- Unique PK on `id` for idempotency.

### 1.6 Seam-integrity trigger (mirrors `enforce_activity_details_integrity`)

A `BEFORE INSERT/UPDATE` trigger on `workout_sessions` and on `workout_set_logs`
(reusing the Phase 1 pattern) enforces at the DB layer: (1) the denormalized `user_id`
matches the parent's `user_id` (spine row for the session; session for a set) so it
can't diverge; (2) exactly one of `exercise_id`/`custom_exercise_id` is set on a set;
(3) the referenced spine row's `event_type = 'strength_session'`. Constraints in the DB,
not just app code (`db-schema-standards`, `production-standards`).

### 1.7 `workout_templates` + `workout_template_exercises` — the builder (CORE-14, owner-owned)

Reusable named workouts. Owner-owned *definition, not an event*. Owner-only RLS in
Phase 2 (community-shared routines widen this in Phase 4 — flagged §12).

`workout_templates`: `id` (uuid PK, client-gen), `user_id`, `name` NOT NULL,
`description`, `deleted_at`, `created_at`, `updated_at`.

`workout_template_exercises` (child, one row per planned movement):
`id`, `template_id` (FK ON DELETE CASCADE), `user_id`, `exercise_id`/`custom_exercise_id`
(exactly one), `exercise_order`, `target_sets`, `target_reps_low`/`target_reps_high`
(a rep range), `target_weight_kg` (nullable), `target_rest_seconds`, `notes`. **No
snapshot here** — a template is a *live* plan the user edits deliberately; the snapshot
happens when a *session* is logged from it (§3). CHECK exactly-one-exercise-ref as above.

### 1.8 `programs` + `program_workouts` — multi-workout programs (CORE-14, owner-owned)

A program is an ordered/scheduled collection of templates ("PPL 6-day", "5/3/1"). Phase
2 = the *builder data model + associating templates to a program*; the calendar/auto-
progression engine is later (§11).

`programs`: `id`, `user_id`, `name`, `description`, `length_weeks` (nullable), `deleted_at`,
timestamps.

`program_workouts` (child): `id`, `program_id` (FK ON DELETE CASCADE), `user_id`,
`template_id` (FK → `workout_templates.id`), `week_number` (nullable), `day_number`
(nullable), `sort_order`. Ties a template into a program at a schedule slot.

### 1.9 Biometric logs — CORE-16 (already-declared spine event types, forced private)

These three event types were pre-declared in Phase 0 and are **forced `visibility =
private` by the live `timeline_events_sensitive_private_chk`** — never shareable, an
assertion not an option (Phase 0 §1.3). Bodyweight and body measurements are
**`health`-consent-gated**; progress photos are gated on a **dedicated `body_image`
consent category** — all enforced at the DB layer (§6, §12.5).

**`bodyweight_logs`** (1:1 with a `bodyweight` event — bodyweight is a timeline event,
not a profile scalar, per Phase 0 §2, because history matters):
`timeline_event_id` (PK FK), `user_id`, `weight_kg` (numeric, canonical, CHECK 0<w<650),
`unit_weight_snapshot` (`kg`\|`lb`), `body_fat_pct` (nullable, CHECK 0–100),
`source` (`manual`\|`wearable` — smart-scale import later), `notes`, timestamps.
"Current weight" is a query over the latest of these, not a mutable column.

**`body_measurements`** (1:1 with a `body_measurement` event = one measurement
occasion) + **`body_measurement_values`** (child, one row per measured site):
- `body_measurements`: `timeline_event_id` (PK FK), `user_id`, `notes`, timestamps.
- `body_measurement_values`: `id`, `timeline_event_id` (FK ON DELETE CASCADE), `user_id`,
  `measurement_kind` (enum: `waist`\|`chest`\|`hips`\|`thigh`\|`biceps`\|`calf`\|`neck`\|
  `shoulders`\|`forearm`\|`body_fat_pct`; add-only), `value` (numeric), `unit_snapshot`
  (`cm`\|`in`\|`pct`). A child table (not wide sparse columns) so one weigh-in captures
  several sites and new sites are add-only enum values, not schema changes. Unique
  `(timeline_event_id, measurement_kind)`.

**`progress_photos`** (1:1 with a `progress_photo` event = one photo occasion) +
**`progress_photo_images`** (child, one row per pose):
- `progress_photos`: `timeline_event_id` (PK FK), `user_id`, `notes`, timestamps.
- `progress_photo_images`: `id`, `timeline_event_id` (FK ON DELETE CASCADE), `user_id`,
  `pose` (enum `front`\|`side`\|`back`\|`other`), `object_path` (text, Storage path in the
  owner-only `progress-photos` bucket — `{user_id}/{timeline_event_id}/{pose}.jpg`,
  deterministic like `activity-tracks`), `checksum` (nullable). **No image bytes in
  Postgres** — the image lives in Storage, served via short-expiry signed URLs (§6, §8).

Grouping poses under one occasion event gives per-occasion deletion/export granularity
and a natural "compare front-pose over time" query. (Minor granularity alternative in
§12.)

### 1.10 `strength_records` + `strength_achievements` — CORE-15 PRs (mirror Module A §4)

Same two-table pattern as Module A: a fast cached current-best + an immutable per-set
achievement log. Detection is O(#exercises-in-session × #metrics) indexed point-lookups
inside the save RPC (§4.3) — never a history scan.

`strength_records` (current best; PK/unique `(user_id, exercise_ref, metric)`):
`user_id`, `exercise_id` **or** `custom_exercise_id` (the "exercise_ref"; exactly one),
`metric` (enum `heaviest_weight`\|`estimated_1rm`\|`best_set_volume`\|`max_reps`; reserved
add-only room for `rep_pr_at_weight`), `value` (numeric, canonical), `unit_snapshot`,
`source_set_log_id` (FK → `workout_set_logs.id`), `timeline_event_id` (the session),
`achieved_at`, `previous_value` (for "new PR (+X)"), timestamps.

`strength_achievements` (immutable log; unique `(source_set_log_id, metric)` idempotency
guard): `id`, `timeline_event_id`, `source_set_log_id`, `user_id`, `metric`, `value`,
`created_at`. A badge earned then is a fact; it does not change when a future set beats
it (historical-integrity, Phase 0 §1.5). Cascades away only if its set is hard-purged.

---

## 2. Exercise-library content sourcing — the CORE-13 decision (NEEDS APPROVAL, §12.1)

This is the gate's explicit "resolve or flag with an approved placeholder" item. It is
partly an **engineering** decision (data source, ingestion, hosting — this doc's job)
and partly a **content-production/legal** decision (licensing 1,400 videos vs. producing
them — the person's call). I propose a concrete plan and flag the parts needing approval.
This mirrors how Module B sourced nutrition data from USDA FDC + Open Food Facts
(`nutrition-data-standards`): free/open sources, merge/dedup discipline, attribution
that actually ships in-app.

### 2.1 Movement metadata (names, muscles, equipment, instructions)

**Recommended plan — two free/open sources, merged, mirroring `nutrition-data-standards`:**

- **Free Exercise DB** (`yuhonas/free-exercise-db`) — ~800 movements with
  muscle/equipment/mechanic metadata, instructions, and static demonstration images,
  released public-domain (Unlicense). Base layer: no attribution obligation, clean to
  redistribute.
- **wger** exercise database (wger.de) — a larger crowd/community movement set. Its
  exercise data is **CC-BY-SA 4.0**, which carries **attribution + share-alike**
  obligations. Supplement layer for coverage toward the 1,400+ target.
- **MileLift-authored** entries — fill remaining gaps over time (the `milelift_authored`
  source value), owned outright.

Discipline carried over from `nutrition-data-standards`, because these are unpaid,
non-SLA sources: a deterministic **merge/dedup order** by normalized name+equipment
(prefer Free Exercise DB when both cover the same movement, to minimize share-alike
surface; flag — don't silently pick — genuine metadata disagreements); an **ingestion
job** (`backend-builder`) with a documented cadence, not a one-time manual import, that
**versions the dataset snapshot** so a bad upstream update can be rolled back;
per-entry `source`/`attribution` columns (§1.1) so **attribution actually renders in the
shipped app** where the license requires (§6), not just in this doc. **Confirm current
license terms for each source before shipping** — terms change.

### 2.2 Video hosting — the genuinely hard/expensive part (placeholder strategy)

Neither free source provides comprehensive *video* for 1,400 movements. Full video
coverage is a **content-production cost, not an engineering task**, and licensing a
commercial video set (or producing one) is a real budget/legal decision. Forcing that
decision to completion should **not** block the Phase 2 build.

**Recommended placeholder strategy (needs the person's approval):**
1. The data model supports mixed media from day one — `exercise_media.media_type` is
   `image`\|`animation`\|`video` (§1.2), so upgrading a movement from static image to
   video later is an `INSERT`/row-swap, not a schema change.
2. Phase 2 **ships** with the free static images (Free Exercise DB) + a **curated video
   subset** for the highest-frequency movements (compound lifts + common accessories),
   sourced from a properly-licensed/attributed set the person approves. The long tail
   shows a static image/animation until video backfills.
3. Video assets are hosted in a dedicated **owner-agnostic public-read Storage bucket
   `exercise-media`** (or a CDN) — these are non-sensitive reference assets, unlike the
   owner-only `progress-photos` bucket. Served with normal caching, attribution per §6.
4. The 1,400-video target becomes a **parallel content track** that backfills
   `exercise_media` rows over time — tracked as a product deliverable, not an
   engineering blocker.

**Flagged for approval (§12.1):** (a) is the "static-image-now, video-backfilled" MVP
acceptable for the Phase 2 gate, or is video coverage a hard launch requirement? (b) the
video-subset source (license vs. produce) and its budget; (c) accepting the CC-BY-SA
share-alike obligation that attaches to redistributed wger data (legal review).

---

## 3. Snapshot discipline at this seam (the CORE-13 gate rule)

Same rule as Phase 0 §1.5 / Phase 1 §1.3, applied to the strength library — this is
the Phase 2 gate's #2 criterion made concrete:

- `workout_set_logs` stores `exercise_id`/`custom_exercise_id` (the live reference)
  **and** snapshots `exercise_name_snapshot` + `primary_muscle_snapshot` +
  `unit_weight_snapshot` + `estimated_1rm_kg` onto the log row at save time.
- **Editing/renaming/re-categorizing an `exercises` entry, or deleting it, never
  retroactively changes a set already logged against it** — the historical log reads its
  own snapshot, the FK is for "jump to the current library entry" only. Deleting a
  library entry is a soft `is_active = false` (§1.1); a custom exercise soft-deletes; a
  set's FK is nullable/SET-NULL-safe so referential deletion never destroys a log.
- Media is **not** snapshotted (§1.2) — it's display data, re-fetchable, and freezing a
  video URL onto every set would bloat the firehose for no integrity gain.
- `workout_sessions.template_name_snapshot` + `total_volume_kg` + `total_sets` are
  snapshots for the same reason: editing/deleting the source template, or the library,
  never rewrites a completed session's rendered history or its volume total.

This is the same end-to-end discipline as the spine's `energy_kcal`/`load_score` and
Module A's `activity_type_name_snapshot`.

---

## 4. Progress analytics — CORE-15 (volume, 1RM, PRs)

### 4.1 What a "PR" means per movement (keyed off exercise metadata, §1.1)

- **Weighted movements** (`is_weighted`): `heaviest_weight` (top single-set weight for
  ≥1 rep), `estimated_1rm` (§4.2), `best_set_volume` (max reps×weight in one set).
- **Bodyweight / rep movements**: `max_reps` (most reps in a set).
- **Time-based** (plank): reserved `longest_hold` (add-only; deferred if no Phase 2
  consumer). Warmup sets are excluded from PR consideration.

### 4.2 1RM estimation (formula is a decision, §12.2)

**Recommended default: Epley** — `1RM = weight × (1 + reps/30)` — computed at save and
**stored as `estimated_1rm_kg` snapshot** on each qualifying set (§1.5), so history is
stable if the formula is ever changed and PR detection is a plain column read. Brzycki
and others are alternatives; the choice affects displayed numbers, so it's flagged for
confirmation, not silently picked. Whichever is chosen, the snapshot means changing it
later only affects *new* sets, never rewriting history — the same integrity posture as
everything else here.

### 4.3 Detection without a full-history scan (mirror Module A §4.3)

Detection runs **inside `save_workout_session_v1`** (§5), in the same transaction, as
**one indexed point-lookup per (exercise_ref, metric)** against `strength_records`
(keyed `(user_id, exercise_ref, metric)`). Beat the cached record ⇒ `UPDATE`
`strength_records` (setting `previous_value`) + `INSERT … ON CONFLICT
(source_set_log_id, metric) DO NOTHING` into `strength_achievements`. Cost is O(#distinct
exercises in the session × #metrics), independent of history size. Idempotent under retry
by construction (`>` compare + `ON CONFLICT`). The internal helpers live in the existing
`private` schema (Phase 1 pattern) so they are never PostgREST-reachable. The "record-
holder edited/deleted" narrow-recompute case and the AFTER-UPDATE reconciliation triggers
(for direct-PostgREST edits that bypass the RPC) are carried over verbatim from Module A
§4.3 — one PR-correctness code path regardless of write path.

### 4.4 Volume, muscle-volume, and `load_score` (feeds AI-06)

- **Session volume** is snapshotted on `workout_sessions.total_volume_kg` at save (§1.4).
- **Volume/1RM-over-time and volume-per-muscle** are read-side `SECURITY INVOKER`
  aggregate RPCs (`get_exercise_progression_v1`, `get_muscle_volume_v1`) computed
  server-side over the `(user_id, exercise_id)` / `primary_muscle_snapshot` indexes —
  never reassembled on the client (Phase 0 §5). Muscle-volume uses the *snapshot* muscle
  so historical attribution is stable (§3).
- **`load_score`** (the spine slot Phase 0 §12.8 left to Module C/AI-06): **recommended
  working default = session sRPE** = `session_rpe × (duration_seconds/60)` when
  `session_rpe` is present, else NULL. Populated by the save RPC onto the spine row so
  "rolling load vs. rolling recovery" stays one time-ordered scan (Phase 0 §4). This is a
  *recommendation*; the authoritative formula is AI-06's call (Phase 8) — flagged §12.3.
  A NULL load_score (no RPE given) is valid and simply doesn't contribute to load.

---

## 5. API surface (`api-contract-standards` + `supabase-standards`)

Per Phase 0 §5: RLS is the authorization mechanism; no `/v1` URL versions; RPC/function
versions carry the suffix.

- **Reads → direct PostgREST under RLS.** Own workout history, a session + its sets,
  the exercise library (public read, **paginated + searchable** — cursor-based, never
  unbounded), templates/programs, PR list, biometric history. Library search/filter is a
  filtered select (or a search RPC) over the public `exercises` table.
- **Saving/finishing a workout → `save_workout_session_v1`, `SECURITY INVOKER`** (RLS
  applies). This is the right layer (`supabase-standards`) because a finish is
  **transactional across `timeline_events` + `workout_sessions` + N `workout_set_logs` +
  PR detection + volume/load snapshotting** — which §1.5 requires be one transaction and
  a bare multi-row PostgREST upsert can't do atomically. Inputs: the client-generated
  session `id` (idempotency key), spine fields, session fields, and a **jsonb array of
  set logs each carrying its own client `id`** (§9.2). `user_id` is always `auth.uid()`,
  never a parameter (`production-standards`). Validates business invariants at the
  boundary: reps/weight/duration/distance `>= 0`, `session_rpe`/`rpe` 0–10, `occurred_at`
  not >24h future (mirrors the live clock-skew constant), exactly-one exercise-ref per
  set, `energy_kcal <= 0`, unit enums. Set-array semantics: **upsert-present, never
  delete-omitted** — a removed set is an explicit `deleted_at` in the payload, so a
  partial/retried payload can never destroy sets (§9.2). Returns the `{"data"}`/`{"error"}`
  envelope. Version-suffixed.
- **Analytics → `SECURITY INVOKER` aggregate RPCs** (§4.4), server-side.
- **Exercise-library ingestion/refresh → an Edge Function or backend job**, service-role,
  off any hot path (§2.1) — writes the reference tables, which are not client-writable.
- **Error envelope + codes** (RPC): the single `{"error":{"code","message","field"}}`
  shape with stable machine codes, e.g. `VALIDATION_ERROR`, `EXERCISE_NOT_FOUND`,
  `INVALID_EXERCISE_REF` (zero or both refs set), `NEGATIVE_MEASUREMENT`,
  `RPE_OUT_OF_RANGE`, `INVALID_ENERGY_SIGN`, `CONSENT_REQUIRED_HEALTH`,
  `CONSENT_REQUIRED_BODY_IMAGE`, `ID_CONFLICT`. Never a raw Postgres error to the client.
- The contract (RPC signatures, resource shapes, error codes) is **written down**
  (OpenAPI/equivalent, `docs/api/`) and kept in sync — builders implement against it.

Biometric writes (bodyweight/measurements/photos) go through smaller dedicated RPCs or
direct table upserts under the consent-gating triggers (§6); progress-photo *bytes*
upload to Storage first (deterministic path), then the metadata row is written — same
upload-then-metadata idempotent ordering as Module A's raw track (§2.1 of Phase 1).

---

## 6. Data sensitivity (`health-data-compliance` — flag early)

Module C touches **biometric/health** data (bodyweight, body measurements, body-fat %,
session RPE/HR-derived load) and **especially-sensitive body imagery** (progress photos —
often near-nude in fitness progress tracking). Workout sets themselves are health-
adjacent training data.

- **Consent gating, reusing the live Phase 0 mechanism** (`consent_category` enum already
  carries `health`, `location`, `camera` — **`db-engineer` adds a new `body_image` value
  to the `consent_category` enum for progress photos, add-only per §12.5**; the
  `enforce_health_consent()` trigger pattern is live and is copied per-category):
  - `bodyweight_logs`, `body_measurements`/`_values`, and any energy *estimation* needing
    bodyweight are gated on an active **`health`** consent row (DB-level trigger, same as
    `profile_health`).
  - `progress_photos`/`_images` are gated on a **dedicated `body_image` consent
    category** (decision §12.5) — deliberately **not** reused from `health`/`camera`, so a
    user can allow health sync while keeping progress photos off, or revoke photo consent
    alone without losing health-data logging. A `BEFORE INSERT/UPDATE` trigger (same shape
    as the live `enforce_health_consent()`) rejects a photo-metadata write unless an
    active `body_image` consent row exists. Body imagery is the most sensitive data in the
    module (often near-nude), so this independently-revocable category is the stricter,
    correct posture, worth the one add-only enum value.
- **Never-shareable is already enforced** on the spine: `bodyweight`, `body_measurement`,
  `progress_photo` are forced `visibility = private` by the live
  `timeline_events_sensitive_private_chk`. `strength_session` is intentionally shareable
  (people share workouts), but its shared render must **not** leak bodyweight/measurement/
  photo data (those are separate private events; no join exposes them cross-user).
- **Data minimization:** store the derived/needed value, not raw firehoses. We store
  logged sets (the product *is* the training log) but do not, e.g., persist raw camera
  frames or continuous HR streams; session load is a derived scalar.
- **Storage** (`progress-photos` bucket): owner-only, fail-closed policies on
  `storage.objects`, path-prefixed by `user_id`, served via **short-expiry signed URLs**,
  never public (mirrors `activity-tracks`, §8). The `exercise-media` bucket is the
  opposite — non-sensitive public reference assets.
- **Attribution actually ships** (§2): the exercise-library/media attribution required by
  CC-BY-SA / source terms must render in-app (a library/credits screen), not just live in
  this doc — same standard as Module B's nutrition-source attribution gate.
- **Third-party leakage guard:** no `toJSON()` of a biometric/photo row or a workout into
  an analytics/crash payload — no raw health values or image paths leave to third-party
  SDKs (Phase 0 §6).
- **Withdrawal is functional and independent per category:** revoking `body_image`
  blocks new progress-photo writes while `health` logging keeps working, and vice-versa;
  revoking `health` blocks new bodyweight/measurement writes. Existing data is untouched
  until an explicit erasure action; withdrawal never crashes and never reuses stale-
  authorized capture.

---

## 7. User-rights code paths (extend the Phase 0/Module A walk to Module C)

- **Export:** the strength tables join the existing timeline export — sessions + sets +
  templates/programs + custom exercises + biometric logs + the progress-photo **blobs
  from Storage** + PRs — into the portable format. A real, tested path.
- **Deletion:** cascades wired so `profiles` → `timeline_events` → (`workout_sessions` →
  `workout_set_logs`; `bodyweight_logs`; `body_measurements` → `_values`;
  `progress_photos` → `_images`) all `ON DELETE CASCADE`; `strength_records`/
  `strength_achievements` referencing a deleted event cascade too; owner-owned
  `custom_exercises`/`workout_templates`/`programs` cascade from `profiles`. **Plus** the
  account-deletion job must explicitly purge the user's `progress-photos/{user_id}/…`
  **Storage objects** (cascades don't reach Storage — the same orphan risk Module A §7
  flags for `activity-tracks`). Honors the Phase 0 §12.2 hard-delete-after-grace policy.
- **Correction:** a session/set/measurement is a normal editable timeline event; edits
  flow through `save_workout_session_v1` (re-running PR detection + volume snapshot) or a
  direct owner update. No support ticket.

---

## 8. RLS boundary — one row per new table (`db-engineer` implements)

Same discipline as Phase 0/1 §8. RLS enabled in the **same migration** as each table —
no exceptions (this project's hard rule; Phase 0's default-grants vulnerability). Cross-
user reads encoded in the policy, never filtered in app code.

| Table | RLS posture |
| --- | --- |
| `exercises`, `exercise_media` | **Not user-owned, not a timeline event.** Public read to `authenticated`; **writes service-role only** (ingestion job). Same class as `activity_types`/food DB. |
| `custom_exercises` | Owner-only (`user_id = auth.uid()`), SELECT/INSERT/UPDATE; no client DELETE (soft-delete via `deleted_at`). |
| `workout_sessions` | Owner-only via denormalized `user_id`; SELECT/INSERT/UPDATE, **no client DELETE** (soft-delete on the parent spine row + cascade at hard-purge, mirroring `activity_details`). Column-scoped UPDATE excluding `timeline_event_id`/`user_id` (§8.1). |
| `workout_set_logs` | Owner-only; SELECT/INSERT/UPDATE, no client DELETE (soft-delete via `deleted_at`). Column-scoped UPDATE excluding `id`/`timeline_event_id`/`user_id`/`exercise_id`/`custom_exercise_id`/the snapshot columns (§8.1). |
| `workout_templates`, `workout_template_exercises`, `programs`, `program_workouts` | Owner-only in Phase 2. Community-shared routines (Phase 4) widen the template tables with an explicit visibility policy then — not now (fail-closed default; §12). |
| `bodyweight_logs`, `body_measurements`, `body_measurement_values` | Owner-only, **`health`-consent-gated write** (trigger). Never widened (the spine forces the event private). |
| `progress_photos`, `progress_photo_images` | Owner-only, **`body_image`-consent-gated write** (dedicated add-only category, §12.5; trigger). Never widened. |
| `strength_records`, `strength_achievements` | Owner-only in Phase 2. (Cross-user "PRs on a public profile" is a Phase 4 community concern — defer widening, same fail-closed posture as Module A §8.) |
| Storage `progress-photos` | Owner-only, fail-closed, signed URLs, path-prefixed by `user_id` (mirrors `activity-tracks`). No client DELETE (GC/account-purge run service-role). |
| Storage `exercise-media` | Public read; service-role write. Non-sensitive reference assets. |

### 8.1 Column-scoped UPDATE grants + the naive-`.upsert()` gotcha (live-confirmed, must not repeat)

A blanket client `.upsert()` compiles to `INSERT … ON CONFLICT DO UPDATE SET <every
column>`, which needs UPDATE privilege on **every** column just to *plan* the statement —
so a column-scoped grant makes a naive full-row upsert fail. To prevent
`backend-builder`/`mobile-builder` repeating the Phase 1 mistake, the **mutable vs.
immutable columns are stated explicitly per table**:

- **`workout_set_logs`** — mutable (client UPDATE granted): `exercise_order`,
  `set_number`, `set_type`, `reps`, `weight_kg`, `unit_weight_snapshot`, `is_bodyweight`,
  `duration_seconds`, `distance_m`, `rpe`, `rest_seconds_planned`, `rest_seconds_actual`,
  `is_completed`, `estimated_1rm_kg`, `notes`, `deleted_at`. **Immutable (excluded):**
  `id`, `timeline_event_id`, `user_id`, `exercise_id`, `custom_exercise_id`,
  `exercise_name_snapshot`, `primary_muscle_snapshot`, `created_at`.
- **`workout_sessions`** — mutable: `title`, `notes`, `source_template_id`,
  `template_name_snapshot`, `session_rpe`, `total_volume_kg`, `total_sets`,
  `calories_source`, `deleted_at`. Immutable: `timeline_event_id`, `user_id`,
  `created_at`.
- **The write path SHOULD be `save_workout_session_v1`, not a raw table upsert** — the
  RPC does the multi-table transaction the client can't. If a direct-table upsert is
  nonetheless used for a small edit (e.g. toggling one set's `is_completed`), it **must**
  target only the mutable column set above (a PostgREST upsert with an explicit column
  list, not a whole-row object), or the write is rejected at plan time. `db-engineer`
  documents this on each grant; `backend-builder`/`mobile-builder` build to it.

---

## 9. Sync / offline — CORE-17, "the hardest item in this phase"

The Phase 0 §3 rules are inherited, not reinvented. Module C is the offline design's
hardest test because a workout is a *long-lived, multi-row, incrementally-built* record
in a gym basement with no Wi-Fi (the spec's "non-negotiable"), and the gate's #1 test is
mandatory: **log a full workout in airplane mode → reconnect → exactly one synced copy.**

### 9.1 Source of truth & durability
The **on-device SQLite store is the UI's source of truth** (Phase 0 §3.2). Local schema
(`src/db/schema.ts` `SCHEMA_STATEMENTS`) gains `workout_sessions`, `workout_set_logs`,
`custom_exercises`, `workout_templates`(+exercises), `programs`(+workouts), the three
biometric detail tables, `strength_records` (pullable cache), and a **read-only cached
mirror of `exercises`/`exercise_media`** so library search + logging work fully offline
(CORE-17). Each writable local table carries the existing `sync_status` /
`pending_payload` / `last_sync_error` columns and the visible `SyncStatusPill`. Because
SQLite is durable, an in-progress workout survives an app crash even before any server
sync.

### 9.2 The idempotency design (two grains — this is the core of the gate test)
- **Every set gets its own client-generated UUID `id` at the moment it's logged**, and
  the **session gets its own client UUID** (= `timeline_events.id`), per Phase 0 §3.4 /
  `db-schema-standards`. Both are generated on-device, offline, before any network.
- On reconnect, `save_workout_session_v1` performs `INSERT … ON CONFLICT (id) DO UPDATE`
  on the spine/session **and on each set row** (`ON CONFLICT (id)` per set) — **not**
  application-level check-then-insert (which races under retry). Retrying the whole
  finish, or any subset, is always safe: the session upserts in place, each set upserts
  in place, PR detection is idempotent (§4.3). **Exactly one copy of the session and one
  copy of each set exists no matter how many times the flaky sync retries** — the "why do
  I have two copies of my workout" bug is designed out at both grains.
- **Set removal syncs as an explicit `deleted_at`, never as an omission.** The RPC's set
  array is **upsert-present, never delete-omitted** (§5), so a truncated/retried payload
  can never destroy sets — a critical safety property for a firehose synced over a flaky
  link.

### 9.3 In-progress vs. committed
An in-progress workout is **layer-2 local domain state** (Phase 0 §3.5) — durable in
SQLite, not yet a synced spine row. It becomes `timeline_events` + rows on **finish**
(or on an optional periodic autosave of the in-progress session, if the person wants
crash-sync-through — but local SQLite durability already prevents data loss, so
server-side autosave is an optional enhancement, not required for the gate; §12.5).

### 9.4 Conflict resolution (documented, a reasoned refinement of the platform default)
Platform default is LWW by server `updated_at` at the **event-row grain** (Phase 0 §3.5).
Module C refines this to **two row grains, both still row-level LWW (no field-level
merge):** the session spine/detail row is LWW at the *session* grain (title, notes, RPE);
each set is LWW at the *set-row* grain (its own `updated_at`). Rationale: sets are
independent facts logged incrementally; two devices (or a foreground edit + a background
retry) touching *different* sets of the same session must not clobber each other, which a
whole-session LWW unit would cause. This is a deliberate, documented deviation flagged
for confirmation (§12.5) — not a silent per-module choice, per Phase 0's discipline. It
is still row-grain LWW, not the field-level merge Phase 0 §11 reserves as a heavier future
option.

### 9.5 Rest timer (CORE-12)
The rest timer is **client-side UI state** — a local countdown, not a synced entity. Its
only persisted footprint is `rest_seconds_planned`/`rest_seconds_actual` on the set row.
It works entirely offline and needs no server design beyond those two columns.

### 9.6 Sync cursor & pull
Sync cursor stays `updated_at` on the spine (Phase 0 §3.6); pulling a changed session
pulls its detail + sets via the shared PK / `timeline_event_id`. The exercise-library
mirror pulls on its own cadence (library `updated_at`), independent of the user timeline.
History pagination is cursor-based on `(occurred_at, id)`, never offset.

---

## 10. Third-party integration failure modes

- **Exercise-library sources (Free Exercise DB / wger)** are **build/ingest-time**
  dependencies, not runtime hot-path calls: the ingestion job runs server-side
  (`backend-builder`), off any user request path; if a source is down, the last good
  versioned snapshot (§2.1) keeps serving. A bad upstream update is rolled back to the
  prior snapshot version, not silently shipped. No user-facing runtime dependency.
- **Video/media host / CDN** (`exercise-media`): if a media asset fails to load, the
  logging + library UI degrade to the movement's static image or name — a demo video is
  never on the critical path of logging a set.
- **Supabase Storage (progress-photo upload):** if the blob upload fails, the metadata
  row is not written (upload-then-metadata ordering); the local photo is retained and the
  upload retries idempotently (deterministic path). Never report "saved" on a partial
  failure (`production-standards`). A never-completing upload is reconciled by the same GC
  pattern as `activity-tracks`.
- **Smart-scale / wearable bodyweight import** (deferred): if/when added, ingestion is
  async off the hot path (Phase 0 §10); absent, bodyweight is manual and fully functional.

---

## 11. Explicit tradeoffs — what we chose NOT to do, and why

- **Set logs as a child collection of the session, not one flat mega-table and not one
  row-per-workout with a JSONB set array.** A JSONB set blob would forfeit per-set
  idempotency (§9.2), per-set indexes for analytics (§4), and DB-level per-set CHECKs —
  the same type-safety/index-ability argument the spine made against a JSONB bag (Phase 0
  §4). We accept a high-write child table (indexed against write cost) to get correct
  offline idempotency and queryable history.
- **Per-set-row LWW, not whole-session LWW.** A documented refinement (§9.4) so
  concurrent edits to different sets don't clobber; we give up "the session is one atomic
  sync unit" to avoid a real multi-device data-loss case.
- **PRs cached + immutable log, not computed-on-read.** Same call as Module A §4 — a
  small maintained cache + rare narrow recompute beats a full-history scan on every read.
- **1RM/volume snapshotted, not live-recomputed.** History stays stable across formula/
  library changes (§3, §4.2); we accept a denormalized value that the save RPC keeps
  correct.
- **Exercise library from free/open sources with static-image-first video (§2), not a
  licensed commercial DB or a 1,400-video launch blocker.** We give up guaranteed video
  completeness at launch to avoid blocking the build on a content-production/legal
  decision; the model supports backfilling video with zero schema change.
- **Templates/programs owner-only, no community sharing yet.** CORE-14 builder ships;
  shared/community routines are Phase 4. Flagged to prevent scope creep — we are **not**
  building routine sharing, marketplace, or social discovery here.
- **Program builder = data model + template association, NOT a calendar/auto-progression
  engine.** Scheduling a program across dates and AI-driven load progression are later
  (AI layer / a dedicated phase). We ship the structures, not the engine, to keep Phase 2
  bounded.
- **Progress photos grouped per occasion with a child images table, not one event per
  image** — for occasion-level export/deletion granularity and "front pose over time"
  queries (minor alternative flagged §12.6).
- **Reused `activity_calories_source` enum for `workout_sessions.calories_source`** — a
  shared enum for the shared spine concept, rather than a near-identical parallel enum
  (avoids the copy-paste-near-duplicate anti-pattern `production-standards` forbids).
- **A dedicated `body_image` consent category for progress photos** (decision §12.5,
  chosen over the architect's reuse-`health`+`camera` recommendation) — the extra enum
  value buys independent, granular withdrawal (photos off while health stays on) for the
  module's most sensitive data, matching `health-data-compliance`'s granular-consent
  posture. The cost is one add-only `consent_category` value.

---

## 12. Decisions (resolved 2026-07-21) and remaining open items

**Resolved by the person — five architect recommendations accepted as-is, one taken to
the stricter option (progress-photo consent):**

1. **Exercise-library content sourcing — APPROVED as recommended (§2).** Free Exercise DB
   (public-domain) + wger (CC-BY-SA) + MileLift-authored, merged, with **attribution that
   ships in-app** (a library/credits surface, not just this doc). **Static images at
   launch; video is backfilled as a parallel content track and is NOT a hard requirement
   for the Phase 2 gate.** `backend-builder` builds the versioned, deterministic-dedup
   ingestion job (§2.1); legal sign-off on the CC-BY-SA share-alike obligation for
   redistributed wger data is tracked as a pre-public-launch item, not a Phase 2 blocker.
2. **Exercise-library size — the gate does NOT require literally hitting 1,400+ (§2).**
   The gate closes once the ingestion pipeline + library/search/logging UI work
   end-to-end against a real (smaller) dataset. Growing toward 1,400+ is ongoing content
   work, not a gate blocker; `qa-engineer` tests the pipeline against a real dataset, not
   a hard count.
3. **1RM formula — Epley confirmed (§4.2).** `estimated_1rm_kg = weight_kg × (1 + reps/30)`,
   computed at save and snapshotted per set, so a later formula change never rewrites
   history.
4. **Strength `load_score` — session sRPE confirmed as the working default (§4.4).**
   `load_score = session_rpe × (duration_seconds/60)` when `session_rpe` is present, else
   NULL. Written onto the spine by the save RPC. AI-06 (Phase 8) may refine the formula;
   this is the accepted working default until then (settles Phase 0 §12.8 for strength).
5. **Progress-photo consent — a DEDICATED `body_image` consent category (§6).** Taken to
   the stricter option, **diverging from the architect's reuse-`health`+`camera`
   recommendation.** `db-engineer` adds `body_image` to the `public.consent_category`
   enum as an **add-only migration** (never remove/rename an enum value, per
   `supabase-standards`) and gates all `progress_photos`/`progress_photo_images` writes on
   an active `body_image` consent row via a `BEFORE INSERT/UPDATE` trigger (same shape as
   the live `enforce_health_consent()`). This lets a user allow health sync while keeping
   photos off, or revoke photo consent alone — independent, granular withdrawal for the
   module's most sensitive data. `bodyweight_logs`/`body_measurements` remain `health`-gated.
6. **Progress-photo deletion — 30-day grace window, the platform default (§7).** No
   special instant/permanent path; consistent with every other delete in the app (Phase 0
   §12.2 hard-delete-after-grace). Soft-delete via `deleted_at` + the scheduled hard-purge
   job, which also purges the user's `progress-photos` Storage objects (§7).
7. **Offline sync refinements — confirmed as recommended (§9.3–9.4).** (a) **Per-set-row
   last-write-wins** (not whole-session LWW) is the documented conflict rule. (b) **Local
   SQLite durability is sufficient** for in-progress workouts; server-side autosave of an
   unfinished session is an optional later enhancement, **not** required for the Phase 2
   gate.
8. **Progress-photo grouping — per-occasion confirmed (§1.9).** One `progress_photo`
   timeline event per photo occasion, with front/side/back as child `progress_photo_images`
   rows — not one standalone event per image.

**Remaining action for `db-engineer` (not a person-decision):** propose a sensible launch
seed strategy for `exercises`/`exercise_media` from the merged sources (§2), and add the
`body_image` enum value plus its consent-gating trigger in the same migration that creates
the progress-photo tables — RLS + grants + consent gate all in one migration, no
exceptions (this project's hard rule).

**Inherited-open, do not block Phase 2** (unchanged from Phase 0): launch jurisdiction
(governs `user_consents` semantics; GDPR-baseline default stands), and the post-deletion
retention window + CC-BY-SA legal sign-off (legal calls before public launch).

---

## 13. UI-surface note (sequencing)

Module C has **major real UI surfaces**: the set-logging screen with the rest timer
(CORE-12 — the highest-frequency, fastest-path screen in the module; logging speed is a
top churn driver per the spec), the exercise library browser + search + video player
(CORE-13), the workout & program builder (CORE-14), the progress-analytics dashboards
(CORE-15 — volume/1RM/PR charts), and the progress-photo/measurement capture flows
(CORE-16, **with the camera + health consent prompts at point of use**, §6). Per the
standing rule (Phase 0 §13) that a screen must not be built against no design decision:
**`ui-ux-designer` runs before `mobile-builder`** on these. This doc owns the data model
and API/RLS contract; it does **not** own the screen-level visual/UX design — the
logging-flow ergonomics (the single biggest lever on retention here), the builder
interaction, the chart design, and the consent-at-point-of-use prompts (specific purpose
strings, graceful degradation on revocation) are `ui-ux-designer`'s to design first.

Implementation routing for the build: `db-engineer` (all §1 tables + RLS + column-scoped
grants per §8.1 + the two Storage buckets + consent-gating triggers + the `exercises`/
`exercise_media` schema and seed hooks), `backend-builder` (`save_workout_session_v1`,
the analytics/progression RPCs, the exercise-library ingestion job §2, the Storage GC +
account-deletion photo purge §7), `mobile-builder` (offline set-logging engine + rest
timer + local-store extension §9 + background sync — the hardest item), `ui-ux-designer`
(the surfaces above, first).
