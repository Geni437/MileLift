# `save_workout_session_v1` / analytics / backfill RPCs — RPC contract

Status: implemented and live. Backing migrations:
`supabase/migrations/20260721110000_create_workout_save_and_pr_rpcs.sql`,
`supabase/migrations/20260721110100_create_strength_analytics_rpcs.sql`, plus
two same-day corrective migrations found and fixed during live verification
(see each migration's own header for the full reasoning — both are
`CREATE OR REPLACE FUNCTION` fixes, no schema change):
`supabase/migrations/20260721110200_fix_strength_records_grant_mismatch.sql`
(a live-confirmed `permission denied for table strength_records` bug — the
`strength_records` table's actual column-scoped `UPDATE` grant omits
`timeline_event_id`, unlike Module A's `personal_records` precedent, so the
original `INSERT ... ON CONFLICT DO UPDATE` pattern failed to plan; fixed by
switching to `DELETE` + `INSERT`, both fully granted) and
`supabase/migrations/20260721110300_fix_save_workout_session_batch_pr_detection.sql`
(the original per-set inline PR detection logged one achievement per
individual set instead of one per exercise per metric per call — deterministic
on any ascending/pyramid multi-set payload, not a rare race — fixed by
batching detection to the best qualifying candidate per `(exercise_ref,
metric)` across the whole call, see §2.6 below).

Design ref: `docs/architecture/phase-2-module-c.md` §1.4-1.6, §4, §5, §8.1,
§9.2. Direct precedent: `docs/api/save-activity-v1.md` (Module A's
`save_activity_v1`) — this RPC mirrors its envelope, idempotency model, and
PR-detection pattern; only the differences are called out in detail below.
Conventions ref: `api-contract-standards`, `supabase-standards`.

These are Postgres functions (`SECURITY INVOKER`) called via PostgREST's
`/rest/v1/rpc/<function_name>` endpoint. There is no `/v1` URL path; the
version lives in the function name suffix (`_v1`), per this project's
"versioning without URL versions" convention.

**Only `save_workout_session_v1`, `recompute_strength_records_for_user_v1`,
`get_exercise_progression_v1`, and `get_muscle_volume_v1` are part of this
public contract.** PR detection internally calls three helper functions
(`_strength_pr_recompute_metric`, `_strength_pr_recompute_if_holder`,
`_strength_pr_apply_or_recompute`) that live in the `private` Postgres schema
(shared with Module A, first established in
`20260719140000_create_activity_save_and_pr_rpcs.sql`), deliberately absent
from `supabase/config.toml`'s `api.schemas`. They are not reachable via
`/rpc/...` even though `authenticated` holds `EXECUTE` on them (required only
for the public RPCs' own internal same-transaction calls under `SECURITY
INVOKER`). Do not build against these helpers directly from a client.

---

## 1. Response shape (same envelope as `save_activity_v1`)

Every RPC below always returns **HTTP 200** from PostgREST and a JSON body
shaped as either `{ "data": { ... } }` or
`{ "error": { "code": "...", "message": "...", "field": "..." } }`. The
mobile client must branch on the presence of `error` in the body, not on HTTP
status — see `docs/api/save-activity-v1.md` §1 for the full reasoning (identical
here, not repeated).

---

## 2. `save_workout_session_v1`

Creates or edits one workout session: a `timeline_events` row
(`source_module = 'strength'`, `event_type = 'strength_session'`) plus its
`workout_sessions` row plus every `workout_set_logs` row in `p_sets` — in one
transaction, followed by batched PR detection and session-total
(`total_volume_kg`/`total_sets`) recompute. Also used for **edits and
incremental appends** (add more sets to an already-synced session, edit a
set's reps/weight, or remove a set via an explicit tombstone).

### 2.1 Idempotency — two grains (§9.2)

- **`p_id`** is the session's client-generated idempotency key (becomes
  `timeline_events.id`, matching every other Phase 0/1/2 event).
- **Every element of `p_sets` carries its own client-generated `id`** — a
  second idempotency grain below the session. Retrying the exact same call,
  or any subset of it (a truncated/retried sync payload), is always safe:
  every write is `INSERT ... ON CONFLICT (id) DO UPDATE` scoped to the same
  ownership `WHERE` clause, and PR-achievement logging is
  `ON CONFLICT DO NOTHING`.
- **A set is removed by sending it again with `deleted_at` set — never by
  omitting it from the array.** `p_sets` is upsert-present, never
  delete-omitted: a partial/retried payload can never destroy sets that
  aren't included in it. Sets already committed in a prior call and NOT
  included in a later call's `p_sets` are left completely untouched (they are
  not re-validated, re-written, or considered for PR detection by that later
  call).

### 2.2 Request parameters

| Parameter | Type | Required | Notes |
| --- | --- | --- | --- |
| `p_id` | uuid | yes | Client-generated idempotency key; becomes `timeline_events.id`. |
| `p_occurred_at` | timestamptz | yes | UTC. Session start. Rejected if >24h in the future (clock-skew bound). |
| `p_local_date` | date | yes | User's local calendar day, computed **on-device**. Must be within 1 day of `p_occurred_at` (UTC). |
| `p_event_timezone` | text (IANA) | yes | Device timezone snapshot at record time. |
| `p_duration_seconds` | integer | yes | Elapsed session time. `>= 0`. Feeds `load_score` (§2.7). |
| `p_sets` | jsonb array | no (default `[]`) | See §2.3 for element shape. May be empty (session-metadata-only save/edit, e.g. starting a workout before any set is logged). |
| `p_source` | `manual`\|`wearable`\|`import` | no (default `manual`) | `ai_parsed`/`system` are rejected. |
| `p_visibility` | `private`\|`followers`\|`public` | no (default `private`) | A `strength_session` CAN be shared — it is not in the spine's never-shareable list (unlike this module's biometric event types). Fail-closed default per Phase 0 §1.3. |
| `p_energy_kcal` | numeric | no | Must be `<= 0` (expenditure). Must be `null` if `p_calories_source = 'none'`. |
| `p_title` | text | no | e.g. "Push Day A". |
| `p_notes` | text | no | |
| `p_source_template_id` | uuid | no | Must exist and be owned by the caller (checked explicitly; the FK itself is `ON DELETE SET NULL`, so a template deleted after this check would still succeed at the DB layer — the explicit check exists for a clean `TEMPLATE_NOT_FOUND` error, not to prevent a race). |
| `p_template_name_snapshot` | text | no | **Snapshot**, not server-derived — the RPC does not look up the template's current name; the client sends the name as it was when the session was built from the template (§3 gate rule). |
| `p_session_rpe` | numeric | no | `0`–`10` (CR-10 scale). Feeds `load_score`. |
| `p_calories_source` | `estimated`\|`wearable`\|`manual`\|`none` | no (default `none`) | `estimated` requires an active `health` consent (§2.5) — calorie estimation needs bodyweight. |
| `p_client_created_at` | timestamptz | no | Offline-clock audit field; never trusted for security. |

### 2.3 `p_sets` element shape

```json
{
  "id": "uuid",
  "exercise_id": "uuid | null",
  "custom_exercise_id": "uuid | null",
  "exercise_name_snapshot": "text",
  "primary_muscle_snapshot": "muscle_group enum value | null",
  "exercise_order": 0,
  "set_number": 1,
  "set_type": "working | warmup | dropset | failure | amrap (default working)",
  "reps": "integer | null",
  "weight_kg": "numeric | null",
  "unit_weight_snapshot": "kg | lb",
  "is_bodyweight": "boolean (default false)",
  "duration_seconds": "integer | null",
  "distance_m": "numeric | null",
  "rpe": "numeric | null (0-10)",
  "rest_seconds_planned": "integer | null",
  "rest_seconds_actual": "integer | null",
  "is_completed": "boolean (default true)",
  "notes": "text | null",
  "deleted_at": "timestamptz | null"
}
```

**Exactly one of `exercise_id` / `custom_exercise_id` is required.**
`exercise_id` must exist in the public `exercises` library (any row,
active or not — a historical set may reference a since-hidden entry).
`custom_exercise_id` must exist in `custom_exercises` **and be owned by the
caller** (checked explicitly — RLS alone does not protect this, because FK
constraint checks in Postgres run with elevated internal privilege and are
not subject to the referencer's own SELECT policy; without this explicit
check a malicious client could silently point a set at another user's
private custom exercise).

**`exercise_name_snapshot` / `primary_muscle_snapshot` are CLIENT-SUPPLIED,
not server-derived** — a deliberate divergence from `save_activity_v1`'s
`activity_type_name_snapshot` (which IS looked up server-side from
`activity_types`). Reasoning: the mobile client maintains an offline-cached
mirror of the exercise library (architecture §9.1) so logging works fully
offline; the snapshot's entire purpose (§3) is to freeze what the user saw
**at the moment of logging**, which may be hours or days before this RPC call
executes on reconnect. Re-deriving server-side at sync time would silently
leak any library edit made in that gap into "historical" data. The RPC
validates the snapshot is non-blank and that the reference genuinely exists
and is owned correctly — it does not verify the snapshot text matches the
referenced row's current name, by design.

**`estimated_1rm_kg` is NEVER accepted from the client.** It is always
computed server-side via Epley (`weight_kg * (1 + reps/30)`, §4.2/§12 item 3)
whenever `weight_kg` and `reps > 0` are both present, and snapshotted onto
the set row regardless of `set_type`/`is_completed` (history stays stable if
the formula ever changes; PR eligibility separately restricts *detection* to
working, completed, non-deleted sets).

**Immutable-after-insert set fields:** `exercise_id`, `custom_exercise_id`,
`exercise_name_snapshot`, `primary_muscle_snapshot` cannot be changed by a
later call for the same set `id` — `workout_set_logs`' column-scoped
`UPDATE` grant (architecture §8.1) excludes these columns, so this RPC's own
`ON CONFLICT DO UPDATE` clause never assigns them either. Resending a set
with a different `exercise_id` than its first save silently keeps the
**original** reference (the DB has no privilege to change it under this
grant) — the client should treat a set's exercise reference as fixed at
creation; to genuinely change it, tombstone the set and create a new one.

### 2.4 Success response

```json
{
  "data": {
    "id": "5b1e...uuid",
    "occurred_at": "2026-07-21T18:00:00Z",
    "local_date": "2026-07-21",
    "duration_seconds": 2400,
    "total_volume_kg": 1025,
    "total_sets": 2,
    "load_score": 320,
    "energy_kcal": null,
    "set_count": 2,
    "achievements": [
      { "metric": "heaviest_weight", "value": 105, "source_set_log_id": "...uuid" },
      { "metric": "estimated_1rm", "value": 122.5, "source_set_log_id": "...uuid" },
      { "metric": "best_set_volume", "value": 525, "source_set_log_id": "...uuid" }
    ]
  }
}
```

- `total_volume_kg` / `total_sets` are **recomputed from the full current
  committed state** of the session's sets (not just the sets in this call's
  payload), so a partial/incremental sync payload always leaves the session's
  totals correct.
- `set_count` is the size of **this call's** `p_sets` array (diagnostic —
  distinct from `total_sets`, the session's live total).
- `achievements` is the **full immutable `strength_achievements` history for
  this session across every call so far** (mirrors `save_activity_v1`'s
  `achievements` field) — a retry returns the same list, never a growing one;
  a later call that adds a new PR appends to what earlier calls already
  logged. It is not scoped to "achievements from this call only".

### 2.5 Error codes

| `code` | Meaning | `field` |
| --- | --- | --- |
| `UNAUTHENTICATED` | No `auth.uid()` in context. | `null` |
| `VALIDATION_ERROR` | A required parameter/set field is missing/blank/malformed. | the offending field (e.g. `sets[2].reps`), or `null` |
| `INVALID_SOURCE` | `source` is not one of `manual`/`wearable`/`import`. | `source` |
| `OCCURRED_AT_TOO_FUTURE` | `occurred_at` exceeds the 24h clock-skew tolerance. | `occurred_at` |
| `LOCAL_DATE_OUT_OF_BOUNDS` | `local_date` more than 1 day from `occurred_at` (UTC). | `local_date` |
| `INVALID_ENERGY_SIGN` | `energy_kcal > 0` (must be `<= 0`). | `energy_kcal` |
| `CALORIES_SOURCE_ENERGY_MISMATCH` | `energy_kcal` set while `calories_source = 'none'`. | `calories_source` |
| `NEGATIVE_MEASUREMENT` | `duration_seconds`, or a set's `reps`/`weight_kg`/`duration_seconds`/`distance_m`/`rest_seconds_planned`/`rest_seconds_actual`/`exercise_order`, is negative. | the offending field |
| `RPE_OUT_OF_RANGE` | `session_rpe` or a set's `rpe` outside 0–10. | `session_rpe` or `sets[i].rpe` |
| `INVALID_UNIT` | A set's `unit_weight_snapshot` not `kg`/`lb`. | `sets[i].unit_weight_snapshot` |
| `INVALID_EXERCISE_REF` | Zero or both of `exercise_id`/`custom_exercise_id` set on a set. | `sets[i].exercise_id` |
| `EXERCISE_NOT_FOUND` | `exercise_id` doesn't exist in the library, or `custom_exercise_id` doesn't exist / isn't owned by the caller. | `sets[i].exercise_id` or `sets[i].custom_exercise_id` |
| `TEMPLATE_NOT_FOUND` | `source_template_id` doesn't exist or isn't owned by the caller. | `source_template_id` |
| `CONSENT_REQUIRED_HEALTH` | `calories_source = 'estimated'` with `energy_kcal` set, but no active `health`-category consent on file. | `calories_source` |
| `CONSENT_REQUIRED` | Generic backstop: a consent-gating DB trigger fired inside the write transaction (rare race window). | `null` |
| `ID_CONFLICT` | `id` (session or a set) already belongs to a different user's/session's row. | `id` or `sets[i].id` |
| `WRITE_FAILED` | Unclassified DB error during the write phase. `message` carries the raw Postgres error text for debugging (never shown verbatim to the end user). | `null` |

Validation runs to completion over the **entire** `p_sets` array before any
write happens (production-standards: an invalid set anywhere in the payload
never results in a partial write — the whole call fails atomically with the
first validation error encountered).

### 2.6 PR detection (§4.3) — batched per call, not per set

On every successful save/edit, the RPC evaluates PR metrics **once per
`(exercise_ref, metric)` pair across the whole call**, not once per
individual set. For every exercise referenced by a live (non-deleted,
`set_type = 'working'`, `is_completed`) set in `p_sets`, the RPC picks the
**single best qualifying value this call contributed** for each applicable
metric (`heaviest_weight`/`estimated_1rm`/`best_set_volume` if the exercise
`is_weighted`; `max_reps` if `is_bodyweight`) and compares that one candidate
against the cached `strength_records` row via one indexed point lookup —
exactly the O(#exercises-in-call × #metrics) bound architecture §4.3
describes.

**Why this matters, concretely:** a session with ascending/pyramid sets of
the same exercise in one save call (e.g. squat 100kg, then 105kg, both
`working`, both in the same `p_sets` array) evaluates to **one**
`heaviest_weight` candidate (105kg, the call's own best), not two sequential
"beats" that would each independently log an achievement. This was a real,
live-reproduced bug in the first version of this RPC (see this doc's header)
— fixed by batching, not by anything concurrency-specific, because it
happened deterministically on a single device with a single synchronous call.

A genuine new record updates the cache and logs an immutable
`strength_achievements` row (`ON CONFLICT (source_set_log_id, metric) DO
NOTHING` — idempotent under retry). Editing a set that currently holds a
record re-derives the true current best via a bounded aggregate scoped to
just that `(exercise_ref, metric)` — this correctly demotes the record if the
edit (or an explicit tombstone) drops its value below another set's,
including another set from a **different** session.

**Direct-PostgREST-edit reconciliation.** `workout_set_logs`' column-scoped
`UPDATE` grant permits a client to edit `weight_kg`/`reps`/`deleted_at`/etc.
directly (bypassing this RPC entirely), and `timeline_events`' owner
`UPDATE` policy permits soft-deleting/undeleting a whole session the same
way. Two `AFTER UPDATE` triggers
(`trg_workout_set_logs_pr_recompute_on_change`,
`trg_timeline_events_strength_pr_recompute_on_delete_toggle`) keep
`strength_records` correct on those paths too, using the same narrow
recompute-if-holder guard — one PR-correctness code path regardless of write
path, mirroring Module A's pair of reconciliation triggers.

**Cross-call/cross-device concurrency — known, accepted, narrow risk (same
root cause and posture as `save_activity_v1` §2.6, not solved differently
here).** The batching fix above only addresses candidates evaluated **within
one call**. If two or more truly concurrent `save_workout_session_v1` calls
for the **same account** (e.g. the same user signed in on two devices, or an
overlapping retry) race for the same `(exercise_ref, metric)`,
`strength_records` still always converges correctly to the true final winner
(`SELECT ... FOR UPDATE` genuinely serializes writers on that cache row), but
each racing transaction can only compare against whatever was already
committed at its own turn — so a genuine multi-device-same-instant race MAY
still log more than one achievement row for the same metric, exactly as
documented for `save_activity_v1`. **This is not reachable from a single
device's normal sequential offline-queue flush**, provided the mobile sync
engine pushes pending workout saves strictly sequentially (never
`Promise.all`) with a single in-flight guard — the same discipline
`src/sync/activitySync.ts` / `src/sync/syncEngine.ts` already implement for
Module A. `mobile-builder` must apply the identical sequencing discipline to
the Module C sync path; this is flagged here as a requirement on that build,
not assumed.

### 2.7 `load_score` (§4.4, §12 item 4)

`load_score = session_rpe * (duration_seconds / 60)` when `session_rpe` is
present, else `NULL`. Written onto the spine `timeline_events` row by this
RPC on every save. A `NULL` `load_score` (no RPE given) is valid and simply
doesn't contribute to AI-06's rolling training-load calculation (Phase 8).

---

## 3. `recompute_strength_records_for_user_v1`

```
recompute_strength_records_for_user_v1(p_user_id uuid default auth.uid())
  returns jsonb
```

One-time bounded backfill, mirroring `recompute_prs_for_user_v1`: call once
after a bulk wearable/history import. Loops only over the distinct
`(exercise_id, custom_exercise_id)` pairs the calling user actually has
non-deleted, working, completed sets for (not the full exercise catalog).
`p_user_id` defaults to (and is asserted to equal) `auth.uid()`.

### Success

```json
{ "data": { "metrics_recomputed": 7 } }
```

### Errors

| `code` | Meaning |
| --- | --- |
| `UNAUTHENTICATED` | No `auth.uid()` in context. |
| `FORBIDDEN` | `p_user_id` explicitly passed and does not match `auth.uid()`. |
| `WRITE_FAILED` | Unclassified DB error. |

---

## 4. `get_exercise_progression_v1`

```
get_exercise_progression_v1(
  p_exercise_id uuid default null,
  p_custom_exercise_id uuid default null,
  p_from date default null,
  p_to date default null
) returns jsonb
```

Per-session time series for one exercise (library or custom), oldest-first:
best single-set weight, best estimated 1RM, session volume for that
exercise, total reps, and set count. Exactly one of `p_exercise_id` /
`p_custom_exercise_id` is required. `p_from`/`p_to` (inclusive, on
`timeline_events.local_date`) are both optional.

### Success

```json
{
  "data": [
    {
      "timeline_event_id": "...uuid",
      "occurred_at": "2026-07-21T18:00:00Z",
      "local_date": "2026-07-21",
      "best_weight_kg": 105,
      "best_estimated_1rm_kg": 122.5,
      "session_volume_kg": 1025,
      "total_reps": 10,
      "set_count": 2
    }
  ]
}
```

### Errors

| `code` | Meaning |
| --- | --- |
| `UNAUTHENTICATED` | No `auth.uid()` in context. |
| `INVALID_EXERCISE_REF` | Zero or both of `p_exercise_id`/`p_custom_exercise_id` provided. |
| `VALIDATION_ERROR` | `p_from` is after `p_to`. |
| `READ_FAILED` | Unclassified DB error. |

---

## 5. `get_muscle_volume_v1`

```
get_muscle_volume_v1(p_from date default null, p_to date default null)
  returns jsonb
```

Total working-set volume + set count grouped by `primary_muscle_snapshot` —
the **frozen per-set label recorded at log time**, not a live join to
`exercises`/`custom_exercises` — so a later re-categorization of a
library/custom movement never shifts a historical period's muscle-volume
breakdown (§3, §4.4). `p_from`/`p_to` optional, same semantics as §4.

### Success

```json
{
  "data": [
    { "primary_muscle": "quadriceps", "total_volume_kg": 1025, "set_count": 2 },
    { "primary_muscle": "chest", "total_volume_kg": 800, "set_count": 6 }
  ]
}
```

Ordered by `total_volume_kg` descending.

### Errors

| `code` | Meaning |
| --- | --- |
| `UNAUTHENTICATED` | No `auth.uid()` in context. |
| `VALIDATION_ERROR` | `p_from` is after `p_to`. |
| `READ_FAILED` | Unclassified DB error. |

---

## 6. Known, explicitly accepted gaps (not silently omitted)

- **Cross-call/cross-device concurrent achievement duplication** — see §2.6.
  Same accepted posture as `save_activity_v1`, contingent on `mobile-builder`
  implementing strictly-sequential sync push for Module C (not yet built as
  of this RPC's implementation — flagged as a requirement on that work, not
  assumed true).
- **`rep_pr_at_weight` / `longest_hold`** (architecture §1.10/§4.1) are
  reserved in the `strength_pr_metric` enum but not computed in Phase 2 —
  `_strength_pr_recompute_metric` raises a clear `feature_not_supported`
  error if ever called with one of these rather than silently no-op'ing,
  mirroring `_pr_recompute_metric`'s handling of its own reserved metrics.
- **`workout_sessions` has no `deleted_at` column of its own** — a whole
  session is soft-deleted via `timeline_events.deleted_at` (the general Phase
  0 mechanism), not a session-local column. This RPC never writes
  `timeline_events.deleted_at` — soft-delete of a session is a direct
  owner `UPDATE` on `timeline_events`, reconciled for PR correctness by
  `trg_timeline_events_strength_pr_recompute_on_delete_toggle` (§2.6).
- **`get_exercise_progression_v1`/`get_muscle_volume_v1` are unbounded reads**
  over a user's own history (no pagination) — acceptable at Phase 2 scale (a
  single user's own workout history, not a cross-user feed); revisit with
  cursor-based pagination if a user's per-exercise session count grows large
  enough to matter (`api-contract-standards`' pagination guidance would then
  apply the same way it does to workout history itself).
