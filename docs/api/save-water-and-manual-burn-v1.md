# `save_water_intake_v1` / `save_manual_burn_v1` — RPC contract

Status: implemented and live, gate-tested (including the CORE-11 overlap
advisory). Backing migration:
`supabase/migrations/20260722200200_create_save_water_and_manual_burn_rpcs.sql`.

Design ref: `docs/architecture/phase-3-module-b.md` §1.7, §1.8, §4.3, §5, §6,
§12 decision 2. Conventions ref: `api-contract-standards`,
`supabase-standards`.

Both are `SECURITY INVOKER` Postgres functions, thin spine+detail
transactional wrappers over a single-detail-row table (no child firehose) —
§5 permits a direct table upsert for these but recommends a thin RPC "for the
spine+detail transaction consistency," which this migration provides.
Neither table is treated as shareable in Phase 3 (§12 decision 4 only
resolves `food_log_entry` sharing) — both RPCs hardcode `visibility =
'private'` rather than exposing a visibility parameter, a deliberate,
narrow scope-limiting choice, not an oversight.

---

## 1. Response shape

Same envelope as every other RPC in this project: `{ "data": { ... } }` or
`{ "error": { "code", "message", "field" } }`, always HTTP 200.

---

## 2. `save_water_intake_v1`

CORE-09. Grain = **per-drink-event** (db-engineer's confirmed architect
recommendation, §1.7/§12).

### 2.1 Parameters

| Parameter | Type | Required | Notes |
| --- | --- | --- | --- |
| `p_id` | uuid | yes | Client-generated idempotency key; becomes `timeline_events.id`. |
| `p_occurred_at` | timestamptz | yes | UTC. Rejected if >24h in the future. |
| `p_local_date` | date | yes | On-device local calendar day; within 1 day of `p_occurred_at` (UTC). |
| `p_event_timezone` | text | yes | IANA timezone snapshot. |
| `p_volume_ml` | numeric | yes | `> 0`. |
| `p_unit_volume_snapshot` | `ml`\|`fl_oz` | yes | Display unit at log time. |
| `p_source` | `manual`\|`wearable`\|`import` | no (default `manual`) | Sets both `timeline_events.source` and `water_intake_logs.source` to the same value. |
| `p_client_created_at` | timestamptz | no | Offline-clock audit field. |

### 2.2 Success response

```json
{
  "data": {
    "id": "uuid", "occurred_at": "2026-07-22T12:00:00Z", "local_date": "2026-07-22",
    "volume_ml": 500, "unit_volume_snapshot": "ml", "source": "manual"
  }
}
```

### 2.3 Error codes

| `code` | Meaning | `field` |
| --- | --- | --- |
| `UNAUTHENTICATED` | No `auth.uid()` in context. | `null` |
| `VALIDATION_ERROR` | A required parameter is missing/malformed. | the offending field |
| `NEGATIVE_MEASUREMENT` | `volume_ml <= 0`. | `volume_ml` |
| `INVALID_UNIT` | `unit_volume_snapshot` not `ml`/`fl_oz`. | `unit_volume_snapshot` |
| `INVALID_SOURCE` | `source` not `manual`/`wearable`/`import`. | `source` |
| `OCCURRED_AT_TOO_FUTURE` / `LOCAL_DATE_OUT_OF_BOUNDS` | Same rules as every save RPC. | `occurred_at` / `local_date` |
| `ID_CONFLICT` | `id` already belongs to a different user's row. | `id` |
| `WRITE_FAILED` | Unclassified DB error. | `null` |

---

## 3. `save_manual_burn_v1`

CORE-11. Writes one **negative**-`energy_kcal` `manual_calorie_burn` event —
the Module B side of the CORE-11 reconciliation (§4). Includes the **CORE-11
non-blocking overlap advisory** (§4.3, §12 decision 2) inline in the success
response.

### 3.1 Parameters

| Parameter | Type | Required | Notes |
| --- | --- | --- | --- |
| `p_id` | uuid | yes | Client-generated idempotency key. |
| `p_occurred_at` / `p_local_date` / `p_event_timezone` | — | yes | Same rules as every save RPC. |
| `p_energy_kcal` | numeric | yes | Must be `< 0` (strictly — a 0-kcal burn is rejected as meaningless). |
| `p_label` | text | yes | Free text ("Tennis", "Yoga class") — manual burn is deliberately unstructured. |
| `p_energy_source` | `user_entered`\|`estimated` | no (default `user_entered`) | `estimated` requires an active `health`-category consent (§6) — checked both by this RPC (a clean early error) and unconditionally by the underlying `enforce_manual_calorie_burn_logs_integrity` trigger (belt-and-suspenders, mirrors `save_workout_session_v1`'s identical pattern for `calories_source = 'estimated'`). |
| `p_activity_type_code` | text | no | Optional structured link to `activity_types.code`; validated to exist if given. |
| `p_duration_minutes` | integer | no | `>= 0`. If given, `timeline_events.duration_seconds = p_duration_minutes * 60` and it also sets the overlap-advisory window (§3.3). |
| `p_notes` | text | no | |
| `p_source` | `manual`\|`import` | no (default `manual`) | |
| `p_client_created_at` | timestamptz | no | |

### 3.2 Success response

```json
{
  "data": {
    "id": "uuid", "occurred_at": "2026-07-22T18:15:00Z", "local_date": "2026-07-22",
    "energy_kcal": -120, "label": "Yoga", "energy_source": "user_entered",
    "duration_minutes": 15,
    "overlap_advisory": {
      "has_overlap": true,
      "overlapping_events": [
        { "timeline_event_id": "uuid", "event_type": "gps_activity", "occurred_at": "2026-07-22T18:00:00Z", "duration_seconds": 2700, "energy_kcal": -450 }
      ]
    }
  }
}
```

### 3.3 The overlap advisory (§4.3, §12 decision 2) — soft, non-blocking, never suppresses

**The save always succeeds regardless of any overlap.** This RPC never
rejects, auto-merges, or suppresses either row — "manual burns and tracked
workouts are always separate spine rows and always additive at aggregate
time" (§4.3, verbatim). The advisory is computed **after** the write already
committed, purely informational, for the client to render: *"You already
have a tracked workout in this window that's counted in today's burn — add
this anyway?"* (copy owned by `ui-ux-designer`).

- **Overlap test:** the new burn's window `[p_occurred_at, p_occurred_at +
  duration)` intersects `[te.occurred_at, te.occurred_at +
  te.duration_seconds)` for any of the caller's own `gps_activity`/
  `strength_session` events that already carry a populated, negative
  `energy_kcal` (i.e. already counted in today's burn).
- **Default window when `p_duration_minutes` is omitted:** a named 30-minute
  constant (`v_default_advisory_window`) — wide enough to catch a plausible
  same-activity duplicate, narrow enough not to flag unrelated same-day
  workouts.
- `overlapping_events` lists every matching row (`timeline_event_id`,
  `event_type`, `occurred_at`, `duration_seconds`, `energy_kcal`) — the
  client can look up the specific workout(s) to show the user.
- **Both entries keep counting** in `get_daily_energy_balance_v1` regardless
  of the advisory — the user decides whether to remove one; this RPC never
  does it for them.

### 3.4 Error codes

| `code` | Meaning | `field` |
| --- | --- | --- |
| `UNAUTHENTICATED` | No `auth.uid()` in context. | `null` |
| `VALIDATION_ERROR` | A required parameter is missing/malformed, or `activity_type_code` doesn't exist. | the offending field |
| `INVALID_ENERGY_SIGN` | `energy_kcal >= 0`. | `energy_kcal` |
| `NEGATIVE_MEASUREMENT` | `duration_minutes < 0`. | `duration_minutes` |
| `INVALID_SOURCE` | `source` not `manual`/`import`. | `source` |
| `CONSENT_REQUIRED_HEALTH` | `energy_source = 'estimated'` without an active `health` consent. | `energy_source` |
| `OCCURRED_AT_TOO_FUTURE` / `LOCAL_DATE_OUT_OF_BOUNDS` | Same rules as every save RPC. | `occurred_at` / `local_date` |
| `ID_CONFLICT` | `id` already belongs to a different user's row. | `id` |
| `WRITE_FAILED` | Unclassified DB error. | `null` |

### 3.5 Live-verified

`scripts/verify-food-log-and-reconciliation-rpcs.mjs` Case 4 proves: an
overlapping burn still saves and returns `has_overlap: true` naming the
overlapping `gps_activity` row; a non-overlapping burn returns
`has_overlap: false`; `estimated` without consent is rejected
(`CONSENT_REQUIRED_HEALTH`); `energy_kcal >= 0` is rejected
(`INVALID_ENERGY_SIGN`).
