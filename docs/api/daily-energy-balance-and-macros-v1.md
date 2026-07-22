# `get_daily_energy_balance_v1` / `get_daily_macros_v1` — RPC contract

Status: implemented and live, gate-tested. Backing migration:
`supabase/migrations/20260722200300_create_daily_energy_and_macros_rpcs.sql`.

Design ref: `docs/architecture/phase-3-module-b.md` §4, §5. Conventions ref:
`api-contract-standards`, `supabase-standards`.

Both are `SECURITY INVOKER` Postgres functions called via PostgREST's
`/rest/v1/rpc/<function_name>` endpoint. RLS on `timeline_events` /
`food_log_entries` / `manual_calorie_burn_logs` / `water_intake_logs` fully
expresses "the caller only ever reads their own rows" — no elevated
privilege is needed for a pure aggregate read.

---

## 1. Response shape

Same envelope as every other RPC in this project: `{ "data": { ... } }` or
`{ "error": { "code", "message", "field" } }`, always HTTP 200.

---

## 2. `get_daily_energy_balance_v1(p_local_date date default current_date)`

**The CORE-11 reconciliation RPC** — Phase 0 §5's pre-named read. This is
**not a bespoke cross-module integration**: because `gps_activity` (Module
A), `strength_session` (Module C), and `manual_calorie_burn` (Module B) all
write **negative** `energy_kcal` on the same `timeline_events` spine
(enforced by the live `timeline_events_energy_sign_chk`), and
`food_log_entry` writes **positive** `energy_kcal`, "today's balance" is a
single `SUM(energy_kcal)` over a `local_date` — no merge/dedup step, ever. A
Module A run or Module C workout appears here purely because it is a
negative-energy `timeline_events` row for this date; no Module B row is ever
created for it, and nothing is double-counted.

### 2.1 Parameters

| Param | Type | Default | Notes |
| --- | --- | --- | --- |
| `p_local_date` | date | `current_date` | The user's local calendar day (Phase 0 §1.2 convention — computed client-side; this RPC just filters on the stored value). |

### 2.2 Success response

```json
{
  "data": {
    "local_date": "2026-07-22",
    "calories_in_kcal": 457.54,
    "calories_out_kcal": 1050,
    "net_kcal": -592.46,
    "intake_event_count": 2,
    "expenditure_events": [
      { "timeline_event_id": "uuid", "event_type": "manual_calorie_burn", "source_module": "nutrition", "occurred_at": "2026-07-22T09:00:00Z", "duration_seconds": 3600, "energy_kcal": -180, "label": "Tennis" },
      { "timeline_event_id": "uuid", "event_type": "strength_session", "source_module": "strength", "occurred_at": "2026-07-22T07:00:00Z", "duration_seconds": 3000, "energy_kcal": -300, "label": null },
      { "timeline_event_id": "uuid", "event_type": "gps_activity", "source_module": "activity", "occurred_at": "2026-07-22T18:00:00Z", "duration_seconds": 2700, "energy_kcal": -450, "label": null },
      { "timeline_event_id": "uuid", "event_type": "manual_calorie_burn", "source_module": "nutrition", "occurred_at": "2026-07-22T18:15:00Z", "duration_seconds": 900, "energy_kcal": -120, "label": "Yoga (accidentally overlapping the tracked run)" }
    ]
  }
}
```

- `calories_in_kcal` = `SUM(energy_kcal) WHERE energy_kcal > 0` (intake —
  in practice, always `food_log_entry` rows today).
- `calories_out_kcal` = `-SUM(energy_kcal) WHERE energy_kcal < 0`
  (expenditure, **additive across every module** — §4.3: "neither wins — all
  expenditure rows sum").
- `net_kcal` = `SUM(energy_kcal)` (intake minus expenditure).
- `expenditure_events` is a **per-line-item breakdown** (not in the design
  doc's literal minimal wording, added so the client can render provenance —
  tracked workout vs. manual burn — per §13's macro-dashboard note). `label`
  is populated only for `manual_calorie_burn` rows (joined from
  `manual_calorie_burn_logs.label`); `null` for `gps_activity`/
  `strength_session` rows.
- **No goal/target field** — Phase 3 surfaces net actuals only (§12 decision
  5: the macro/calorie goal model is out of scope; `get_daily_energy_balance_v1`
  does not compute "remaining vs. goal").

### 2.3 Error codes

| `code` | Meaning |
| --- | --- |
| `UNAUTHENTICATED` | No `auth.uid()` in context. |
| `VALIDATION_ERROR` | `p_local_date` is `null`. |
| `READ_FAILED` | Unclassified DB error. |

### 2.4 The gate test, live-verified

`scripts/verify-food-log-and-reconciliation-rpcs.mjs` Case 5 runs the exact
scenario the gate names: a simulated Module A `gps_activity` row (-450 kcal)
and a simulated Module C `strength_session` row (-300 kcal) are inserted
directly (standing in for `save_activity_v1`/`save_workout_session_v1`),
alongside two real `save_manual_burn_v1` calls (-120, -180 kcal) and two real
`save_food_log_entry_v1`/`log_saved_meal_v1` calls (247.5 + 210.04 kcal
intake). `get_daily_energy_balance_v1` is asserted to return
`calories_in_kcal = 457.54`, `calories_out_kcal = 1050` (all four expenditure
rows summed, each counted **exactly once**), and every expenditure row
present in `expenditure_events` exactly once — live-passing as of this
implementation.

---

## 3. `get_daily_macros_v1(p_local_date date default current_date)`

CORE-08 daily macro-totals aggregate: sums `food_log_entries`' own
meal-level **snapshot** totals (never a live re-sum of `food_log_items`,
§1.5/§3) across every meal for the given `local_date`.

### 3.1 Success response

```json
{
  "data": {
    "local_date": "2026-07-22",
    "total_energy_kcal": 457.54,
    "total_protein_g": 47.798,
    "total_carb_g": 26.904,
    "total_fat_g": 5.754,
    "meal_count": 2,
    "water_ml_total": 500
  }
}
```

`water_ml_total` (sum of `water_intake_logs.volume_ml` for the same date) is
a **value-add beyond the design doc's literal "macro totals" wording** —
flagged here, not a silent scope expansion — included because it is a cheap
join scoped to the same date/user and directly serves the CORE-09 water
tracker dashboard alongside the macro ring (§13).

### 3.2 Error codes

| `code` | Meaning |
| --- | --- |
| `UNAUTHENTICATED` | No `auth.uid()` in context. |
| `VALIDATION_ERROR` | `p_local_date` is `null`. |
| `READ_FAILED` | Unclassified DB error. |

---

## 4. Known, explicitly accepted gaps

- **No goal/target comparison** — by design (§12 decision 5, out of Phase 3
  scope). Both RPCs return actuals only.
- **Unbounded per-day reads, no pagination** — acceptable at Phase 3 scale (a
  single day's events for one user, not a cross-user feed or full history);
  revisit if a single day's expenditure-event count ever grows large enough
  to matter (unlikely — a day has a small, bounded number of workouts/burns).
