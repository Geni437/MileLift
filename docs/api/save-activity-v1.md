# `save_activity_v1` / `recompute_prs_for_user_v1` — RPC contract

Status: implemented and live. Backing migrations:
`supabase/migrations/20260719140000_create_activity_save_and_pr_rpcs.sql`, plus
`supabase/migrations/20260720090000_fix_pr_apply_or_recompute_concurrent_achievement_race.sql`
(concurrent-save achievement-logging race fix — see §2.6 below and that
migration's own header for the full before/after reasoning).

Design ref: `docs/architecture/phase-1-module-a.md` §4.3, §5, §6, §7, §9.
Conventions ref: `api-contract-standards`, `supabase-standards`.

These are Postgres functions (`SECURITY INVOKER`) called via PostgREST's
`/rest/v1/rpc/<function_name>` endpoint — not hand-rolled REST resources, per
`supabase-standards`' "RPC for multi-table transactional logic" guidance
(§5 of the architecture doc). There is no `/v1` URL path; the version lives
in the function name suffix (`_v1`) instead, per this project's established
"versioning without URL versions" convention.

**Only `save_activity_v1` and `recompute_prs_for_user_v1` are part of this
public contract.** PR detection internally calls three helper functions
(`_pr_recompute_metric`, `_pr_recompute_if_holder`, `_pr_apply_or_recompute`)
that live in a separate `private` Postgres schema, deliberately absent from
`supabase/config.toml`'s `api.schemas`. They are not reachable via
`/rpc/...` (PostgREST 404s — the schema isn't in its exposed-schema list at
all, independent of any GRANT) even though `authenticated` holds `EXECUTE`
on them, which is required only for `save_activity_v1`'s own internal
same-transaction calls to succeed under `SECURITY INVOKER`. Do not build
against these helpers directly from a client; they have no stability
guarantee and are not validated/idempotent in the way the two public RPCs
are.

---

## 1. Why the response shape is what it is (read this before wiring a client)

Both RPCs below always return **HTTP 200** from PostgREST and a JSON body
shaped as either:

```json
{ "data": { ... } }
```

or

```json
{ "error": { "code": "MOVING_TIME_EXCEEDS_ELAPSED", "message": "...", "field": "moving_time_seconds" } }
```

**The mobile client must branch on the presence of `error` in the body, not
on HTTP status.** This is a deliberate deviation from a typical REST
endpoint returning 4xx on a validation failure, and it's specific to these
being *Postgres function* RPCs rather than Edge Functions: PostgREST's own
error-response shape for a raised Postgres exception is
`{"code","details","hint","message"}`, which does **not** match this
project's `{"error":{"code","message","field"}}` envelope
(`api-contract-standards`). The only way to guarantee this project's exact
envelope shape for a Postgres function call is for the function to return it
as an ordinary value. Genuinely unexpected Postgres errors (a table
CHECK/trigger firing that the RPC's own pre-validation didn't already catch)
are still caught inside the function and translated into the same envelope
— a raw Postgres/ORM error never reaches the client.

If a future contract change needs real HTTP status codes (e.g. because a
generic HTTP client library keys off status), that is exactly the kind of
incompatible change that should ship as `save_activity_v2`, not a silent
change to this function's existing behavior — see `supabase-standards`'
RPC-versioning section.

---

## 2. `save_activity_v1`

Creates or edits one activity: a `timeline_events` row
(`source_module = 'activity'`, `event_type = 'gps_activity'`) plus its
`activity_details` row plus, optionally, an `activity_routes` row — in one
transaction, followed by inline PR detection. Also used for **edits**
(architecture §7: "editing distance/type/title flows through
`save_activity_v1`, which re-runs PR detection").

### 2.1 Idempotency

`id` is the client-generated idempotency key (a UUID generated on-device),
matching the Phase 0 pattern used for every other synced record. Retrying
the exact same call (network retry, offline-sync replay) is always safe: the
underlying writes are `INSERT ... ON CONFLICT (id) DO UPDATE` upserts, and
PR-achievement logging is `ON CONFLICT DO NOTHING`. Calling it again with a
**different** payload under the same `id` is how an edit works (§7).

### 2.2 Request parameters

| Parameter | Type | Required | Notes |
| --- | --- | --- | --- |
| `p_id` | uuid | yes | Client-generated idempotency key; becomes `timeline_events.id`. |
| `p_activity_type_code` | text | yes | FK to `activity_types.code` (e.g. `run`, `ride`, `hike`). |
| `p_occurred_at` | timestamptz | yes | UTC. Start of the activity. Rejected if >24h in the future (clock-skew bound). |
| `p_local_date` | date | yes | User's local calendar day, computed **on-device** — never derive server-side. Must be within 1 day of `p_occurred_at` (UTC). |
| `p_event_timezone` | text (IANA) | yes | Device timezone snapshot at record time. |
| `p_duration_seconds` | integer | yes | Elapsed time. `>= 0`. |
| `p_source` | `manual`\|`wearable`\|`import` | no (default `manual`) | `ai_parsed`/`system` are rejected — not applicable to Module A in Phase 1. |
| `p_visibility` | `private`\|`followers`\|`public` | no (default `private`) | Fail-closed default, per Phase 0 §1.3. |
| `p_energy_kcal` | numeric | no | Must be `<= 0` (expenditure). Must be `null` if `p_calories_source = 'none'`. |
| `p_title` | text | no | |
| `p_description` | text | no | |
| `p_distance_m` | numeric | no | Meters. `>= 0`. |
| `p_unit_distance_snapshot` | `km`\|`mi` | no (default `km`) | Display-unit snapshot at log time. |
| `p_moving_time_seconds` | integer | no | `>= 0` and `<= p_duration_seconds`. |
| `p_elevation_gain_m` / `p_elevation_loss_m` | numeric | no | Meters. `>= 0`. |
| `p_average_speed_mps` / `p_max_speed_mps` | numeric | no | Meters/second. `>= 0`. Pace is derived client-side from this — never send/store pace directly. |
| `p_average_hr` / `p_max_hr` | numeric | no | bpm. `20–260`. `average_hr <= max_hr` when both present. Requires an active `health` consent row. |
| `p_calories_source` | `estimated`\|`wearable`\|`manual`\|`none` | no (default `none`) | |
| `p_route_geojson` | jsonb | no | A GeoJSON `LineString` (2D or 3D coordinates). Mutually exclusive with `p_route_polyline`. |
| `p_route_polyline` | text | no | A Google-encoded polyline (precision 5), 2D only. Mutually exclusive with `p_route_geojson`. |
| `p_raw_track_object_path` | text | conditionally | Required iff a route is provided. Must equal exactly `activity-tracks/{your_user_id}/{p_id}/track.bin` — the deterministic path the client must have already uploaded the raw track blob to (§2.1 — **upload the blob first, then call this RPC**). |
| `p_raw_track_checksum` | text | no | |
| `p_raw_point_count` / `p_simplified_point_count` | integer | no | Diagnostics. `>= 0`. |
| `p_client_created_at` | timestamptz | no | Offline-clock audit field; never trusted for security. |

Exactly one of `p_route_geojson` / `p_route_polyline` may be set, and route
geometry + `p_raw_track_object_path` must be provided together (both or
neither). The RPC converts either input to a PostGIS `LineStringZ` (SRID
4326) server-side — the client never needs PostGIS.

### 2.3 Success response

```json
{
  "data": {
    "id": "5b1e...uuid",
    "activity_type_code": "run",
    "occurred_at": "2026-07-19T06:12:00Z",
    "local_date": "2026-07-19",
    "duration_seconds": 1830,
    "moving_time_seconds": 1790,
    "distance_m": 8046.7,
    "has_gps_route": true,
    "energy_kcal": -412,
    "achievements": [
      { "metric": "longest_distance", "value": 8046.7, "rank": "pr" }
    ]
  }
}
```

`achievements` reflects every `activity_achievements` row currently logged
for this activity (idempotent across retries — a retry returns the same
list, never a growing one).

### 2.4 Error codes

| `code` | Meaning | `field` |
| --- | --- | --- |
| `UNAUTHENTICATED` | No `auth.uid()` in context. | `null` |
| `VALIDATION_ERROR` | A required parameter is missing/blank, or a DB-level CHECK fired that this RPC's own pre-validation didn't already catch. | the offending field, or `null` |
| `INVALID_SOURCE` | `source` is not one of `manual`/`wearable`/`import`. | `source` |
| `OCCURRED_AT_TOO_FUTURE` | `occurred_at` exceeds the 24h clock-skew tolerance. | `occurred_at` |
| `LOCAL_DATE_OUT_OF_BOUNDS` | `local_date` more than 1 day from `occurred_at` (UTC). | `local_date` |
| `INVALID_ENERGY_SIGN` | `energy_kcal > 0` (must be `<= 0` for an activity). | `energy_kcal` |
| `CALORIES_SOURCE_ENERGY_MISMATCH` | `energy_kcal` set while `calories_source = 'none'`. | `calories_source` |
| `NEGATIVE_MEASUREMENT` | A measurement field (`distance_m`, `elevation_gain_m`, `elevation_loss_m`, `average_speed_mps`, `max_speed_mps`, `moving_time_seconds`, `duration_seconds`) is negative. | the offending field |
| `MOVING_TIME_EXCEEDS_ELAPSED` | `moving_time_seconds > duration_seconds`. | `moving_time_seconds` |
| `INVALID_UNIT` | `unit_distance_snapshot` not `km`/`mi`. | `unit_distance_snapshot` |
| `HR_OUT_OF_RANGE` | `average_hr`/`max_hr` outside 20–260 bpm. | `average_hr` or `max_hr` |
| `AVERAGE_HR_EXCEEDS_MAX` | `average_hr > max_hr`. | `average_hr` |
| `ACTIVITY_TYPE_NOT_FOUND` | `activity_type_code` doesn't exist in `activity_types`. | `activity_type_code` |
| `ROUTE_INPUT_AMBIGUOUS` | Both `route_geojson` and `route_polyline` provided. | `route_geojson` |
| `MISSING_RAW_TRACK_PATH` | Route geometry provided without `raw_track_object_path`. | `raw_track_object_path` |
| `MISSING_ROUTE_GEOMETRY` | `raw_track_object_path` provided without route geometry. | `route_geojson` |
| `INVALID_TRACK_PATH` | `raw_track_object_path` doesn't match the deterministic `activity-tracks/{user_id}/{id}/track.bin` shape. | `raw_track_object_path` |
| `INVALID_ROUTE_GEOMETRY` | The GeoJSON/polyline didn't parse, wasn't a single LineString, or had fewer than 2 points. | `route_geojson` or `route_polyline` |
| `CONSENT_REQUIRED_LOCATION` | Route data provided but no active `location`-category consent on file. | `route_geojson` |
| `CONSENT_REQUIRED_HEALTH` | `average_hr`/`max_hr` provided but no active `health`-category consent on file. | `average_hr` |
| `CONSENT_REQUIRED` | Generic backstop: a consent-gating DB trigger fired inside the write transaction (a race between the pre-check above and the write — rare). | `null` |
| `ID_CONFLICT` | `id` already belongs to a different user's row. | `id` |
| `WRITE_FAILED` | Unclassified DB error during the write phase. `message` carries the raw Postgres error text for debugging (never shown verbatim to the end user — localize/generalize client-side per `api-contract-standards`). | `null` |

### 2.5 Consent gating

- Providing route geometry requires an active `location`-category row in
  `user_consents` (`revoked_at is null`).
- Providing `average_hr`/`max_hr` requires an active `health`-category row.

Both are checked by this RPC *before* any write (clean, specific error), and
independently enforced at the DB layer by triggers on `activity_routes` /
`activity_details` (`enforce_activity_routes_integrity` /
`enforce_activity_details_integrity`, already live in db-engineer's
migrations) as a backstop — surfaced as `CONSENT_REQUIRED` if that backstop
is what actually fires (a narrow race-window case, not the normal path).

### 2.6 PR detection (§4.3)

On every successful save/edit, the RPC evaluates every PR metric applicable
to the activity's type (`longest_duration` always; `longest_distance` /
`fastest_avg_pace` if `is_distance_based`; `most_elevation_gain` if also
`tracks_elevation`) via one indexed point lookup per metric against
`personal_records` — never a full history scan. A genuine new record updates
the cache (`ON CONFLICT (user_id, activity_type_code, metric) DO UPDATE`) and
logs an immutable `activity_achievements` row for whoever currently holds the
record (`ON CONFLICT (timeline_event_id, metric) DO NOTHING` — idempotent
under retry). Editing an activity that currently holds a record re-derives
the true current best via a single bounded aggregate scoped to just that
`(activity_type_code, metric)` pair (§4.3's "one genuinely expensive case")
— this correctly demotes the record if the edit dropped its value below
another activity's.

**Concurrent-save achievement logging (fixed in `20260720090000`).** Under
genuine concurrency — e.g. an offline queue flushing several pending
activities on reconnect, or multi-device sync — multiple `save_activity_v1`
calls can race for the same `(activity_type_code, metric)` record. The
`personal_records` cache always converges to the true final winner (a plain
`SELECT ... FOR UPDATE`-serialized compare-and-swap). Achievement logging is
deliberately decoupled from that per-call comparison: it only commits once no
other `save_activity_v1` call is still queued behind the current one for that
exact record (detected via `pg_locks`, see the migration's own header for the
mechanism), and always logs for whichever activity the settled cache
currently says holds the record — never for a value that was only
momentarily ahead before a concurrent sibling in the same race superseded it.
For a normal, uncontended sequential save, this settles on the very first
check, so the caller's own `achievements` array in the response is
unaffected — a solo save still reports its own PR immediately. For a genuine
concurrent batch, only the batch's actual final winner ever gets logged;
because `activity_achievements` is immutable by design (§4.2), this had to be
prevented up front rather than corrected after the fact.

---

## 3. `recompute_prs_for_user_v1`

```
recompute_prs_for_user_v1(p_user_id uuid default auth.uid())
  returns jsonb
```

One-time bounded backfill: call **once**, after a bulk wearable/history
import has finished (each imported activity should already have gone
through `save_activity_v1` individually — this call settles any ordering
ambiguity from importing out of chronological order). Loops only over the
`activity_type_code`s the calling user actually has non-deleted activities
in (not the full `activity_types` catalog), doing one bounded indexed
aggregate per applicable metric per type.

`p_user_id` defaults to (and is asserted to equal) `auth.uid()` — passing
another user's id returns `FORBIDDEN`; RLS makes it impossible to succeed
regardless, this just fails clearly instead of silently no-op'ing.

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

## 4. Storage GC — `gc-activity-tracks` Edge Function

Not part of the RPC surface (no client ever calls it), but documented here
because it's the other half of the save flow's contract: §2.1 requires the
raw-track blob be uploaded to `activity-tracks/{user_id}/{id}/track.bin`
*before* calling `save_activity_v1`. If the RPC call never completes (app
killed, network drop), the blob is orphaned. `supabase/functions/gc-activity-
tracks/index.ts` is a scheduled, service-role-only Edge Function that scans
the bucket for `track.bin` objects older than a 24h grace period with no
matching `activity_routes.raw_track_object_path`, and deletes them. See the
file's own header comment for the full design (bounded/paginated walk,
authorization model, invocation options). Scheduling (pg_cron vs. Supabase's
native scheduled-function cron) is a deploy-time `devops-engineer` decision,
not built into this repo's migrations, per this project's CI/CD doc's
explicit "no automated deploy" boundary.

---

## 5. Known, explicitly accepted gaps (not silently omitted)

- **`activity_type_code` change + a measurement-field change in the same
  direct `PATCH /activity_details`, bypassing `save_activity_v1`:** the
  `trg_activity_details_pr_recompute_on_change` trigger reconciles PRs under
  the *new* `activity_type_code`, not the old one the row is moving away
  from. Worst case is one stale `personal_records` cache row under the old
  type until the next `save_activity_v1` call or `recompute_prs_for_user_v1`
  backfill — no data loss (the immutable `activity_achievements` log is
  unaffected). Editing via `save_activity_v1` itself does not have this gap.
- **Sub-distance "best efforts" PRs** (`fastest_1k`/`fastest_5k`/`fastest_10k`)
  are reserved in the `activity_pr_metric` enum but not computed in Phase 1,
  per architecture §4.1/§11 (deferred — needs a rolling-window scan over the
  full-resolution track). `_pr_recompute_metric` raises a clear
  `feature_not_supported` error if ever called with one of these rather than
  silently no-op'ing.
- **GC scale:** `gc-activity-tracks` does a bounded, paginated, non-recursive
  walk per run (Storage's `list()` API has no native recursive/cross-user
  query). Fine for Phase 1 scale; a materialized "pending upload" index
  table (written at upload time, cleared at successful save) is the
  natural next step if/when the walk itself becomes the bottleneck — not
  built now, flagged for whoever revisits this at scale.
