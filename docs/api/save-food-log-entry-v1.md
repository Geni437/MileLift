# `save_food_log_entry_v1` / `log_saved_meal_v1` — RPC contract

Status: implemented and live. Backing migrations:
`supabase/migrations/20260722200000_create_save_food_log_entry_rpc.sql`,
`supabase/migrations/20260722200100_create_log_saved_meal_rpc.sql`.

Design ref: `docs/architecture/phase-3-module-b.md` §1.5, §1.6, §1.9, §1.10,
§3, §5, §8.1, §9. Direct precedent: `docs/api/save-workout-session-v1.md`
(Module C's `save_workout_session_v1`) — `save_food_log_entry_v1` mirrors its
envelope, idempotency model, and transactional-multi-row-upsert pattern;
only the differences are called out below. Conventions ref:
`api-contract-standards`, `supabase-standards`.

These are Postgres functions called via PostgREST's
`/rest/v1/rpc/<function_name>` endpoint. There is no `/v1` URL path; the
version lives in the function name suffix (`_v1`).

---

## 1. Response shape

Same envelope as every other RPC in this project: always **HTTP 200** from
PostgREST, body shaped as either `{ "data": { ... } }` or
`{ "error": { "code": "...", "message": "...", "field": "..." } }`. The
mobile client must branch on the presence of `error` in the body, not on
HTTP status.

---

## 2. `save_food_log_entry_v1`

`SECURITY INVOKER` (RLS applies to every underlying table). Creates or edits
one meal/eating-occasion: a `timeline_events` row (`source_module =
'nutrition'`, `event_type = 'food_log_entry'`) plus its `food_log_entries`
row plus every `food_log_items` row in `p_items` — in one transaction,
followed by a recompute of the meal's snapshot totals (mirrored onto the
spine's `energy_kcal`). Also used for **edits and incremental appends** (add
more items to an already-synced meal, edit an item's quantity, or remove an
item via an explicit tombstone).

### 2.1 Idempotency — two grains (§9)

- **`p_id`** is the meal's client-generated idempotency key (becomes
  `timeline_events.id`).
- **Every element of `p_items` carries its own client-generated `id`** — a
  second idempotency grain below the meal. Retrying the exact same call, or
  any subset of it, is always safe: every write is `INSERT ... ON CONFLICT
  (id) DO UPDATE` scoped to the same ownership `WHERE` clause.
- **An item is removed by sending it again with `deleted_at` set — never by
  omitting it from the array.** Items already committed in a prior call and
  NOT included in a later call's `p_items` are left completely untouched.

### 2.2 Request parameters

| Parameter | Type | Required | Notes |
| --- | --- | --- | --- |
| `p_id` | uuid | yes | Client-generated idempotency key; becomes `timeline_events.id`. |
| `p_occurred_at` | timestamptz | yes | UTC. Rejected if >24h in the future (clock-skew bound). |
| `p_local_date` | date | yes | User's local calendar day, computed **on-device**. Must be within 1 day of `p_occurred_at` (UTC). |
| `p_event_timezone` | text (IANA) | yes | Device timezone snapshot at record time. |
| `p_meal_type` | `breakfast`\|`lunch`\|`dinner`\|`snack`\|`other` | yes | |
| `p_items` | jsonb array | no (default `[]`) | See §2.3. May be empty (meal-metadata-only save, e.g. starting a meal before any food is added). |
| `p_source` | `manual`\|`import` | no (default `manual`) | `wearable`/`ai_parsed`/`system` are rejected for this RPC. |
| `p_visibility` | `private`\|`followers`\|`public` | no (default `private`) | `food_log_entry` CAN be shared — not in the spine's never-shareable list (§6/§12 decision 4). Fail-closed default. |
| `p_title` | text | no | e.g. "Post-workout shake". |
| `p_notes` | text | no | |
| `p_client_created_at` | timestamptz | no | Offline-clock audit field; never trusted for security. |

**There is no `p_energy_kcal` parameter.** Unlike Module A/C's save RPCs
(where the client supplies the expenditure `energy_kcal`), a meal's energy is
**always server-recomputed** from `p_items`' own `energy_kcal` snapshots —
never client-supplied at the meal level (§1.5: "Recomputed by the save RPC on
every edit").

### 2.3 `p_items` element shape

```json
{
  "id": "uuid",
  "food_id": "uuid | null",
  "custom_food_id": "uuid | null",
  "food_name_snapshot": "text",
  "brand_snapshot": "text | null",
  "serving_label_snapshot": "text",
  "quantity": "numeric (> 0)",
  "serving_g_or_ml_snapshot": "numeric (> 0)",
  "energy_kcal": "numeric (>= 0)",
  "protein_g": "numeric | null (>= 0)",
  "carb_g": "numeric | null (>= 0)",
  "fat_g": "numeric | null (>= 0)",
  "data_quality_snapshot": "high | medium | low | null",
  "sort_order": "integer (>= 0)",
  "deleted_at": "timestamptz | null"
}
```

**Exactly one of `food_id` / `custom_food_id` is required.** `custom_food_id`
must exist in `custom_foods`, be owned by the caller, and not be
soft-deleted (checked explicitly). `food_id` existence against the global
`foods` catalog is enforced by the table's own FK constraint at write time —
**not** independently checkable by this RPC, because `public.foods` carries
**no client SELECT grant of any kind**, not even to this `SECURITY INVOKER`
function (see `20260722100000_create_foods.sql`'s header).

**All macro snapshots (`energy_kcal`/`protein_g`/`carb_g`/`fat_g`/
`food_name_snapshot`/etc.) are CLIENT-SUPPLIED, not server-recomputed from a
live `foods` lookup** — a deliberate divergence mirroring
`save_workout_session_v1`'s identical treatment of
`exercise_name_snapshot`/`primary_muscle_snapshot` (see that RPC's own doc,
§2.3). Two independent reasons converge here: (1) `public.foods` has no
client grant at all, so this `SECURITY INVOKER` RPC could not recompute
against it even if it wanted to; (2) the snapshot's entire purpose (§3) is to
freeze what the user saw **at the moment of logging** (typically computed
fully offline against the mobile client's cached `search_foods_v1`/
`resolve_barcode_v1` response or its local `custom_foods` row), which may
predate this RPC call by hours or days — re-deriving server-side would
silently leak a later food-DB edit into "historical" data. This RPC
validates every snapshot is present/non-blank/in-range; it does **not**
verify the numbers are numerically consistent with the referenced row's
*current* macros.

### 2.4 Success response

```json
{
  "data": {
    "id": "uuid",
    "occurred_at": "2026-07-22T12:00:00Z",
    "local_date": "2026-07-22",
    "meal_type": "lunch",
    "total_energy_kcal": 352.52,
    "total_protein_g": 47.798,
    "total_carb_g": 26.904,
    "total_fat_g": 5.754,
    "item_count": 2
  }
}
```

`total_*` are **recomputed from the full current committed state** of the
meal's items (not just the items in this call's payload) — a partial/
incremental sync payload always leaves the meal's totals correct. Also
written onto `timeline_events.energy_kcal` (positive intake) in the same
transaction, so the CORE-11 daily-balance read (§4,
`get_daily_energy_balance_v1`) never touches `food_log_items`.

### 2.5 Error codes

| `code` | Meaning | `field` |
| --- | --- | --- |
| `UNAUTHENTICATED` | No `auth.uid()` in context. | `null` |
| `VALIDATION_ERROR` | A required parameter/item field is missing/blank/malformed. | the offending field, or `null` |
| `INVALID_SOURCE` | `source` is not `manual`/`import`. | `source` |
| `OCCURRED_AT_TOO_FUTURE` | `occurred_at` exceeds the 24h clock-skew tolerance. | `occurred_at` |
| `LOCAL_DATE_OUT_OF_BOUNDS` | `local_date` more than 1 day from `occurred_at` (UTC). | `local_date` |
| `INVALID_FOOD_REF` | Zero or both of `food_id`/`custom_food_id` set on an item. | `items[i].food_id` |
| `FOOD_NOT_FOUND` | `custom_food_id` doesn't exist / isn't owned by the caller / is soft-deleted, OR `food_id` fails the underlying FK check at write time. | `items[i].custom_food_id` (when detectable pre-write) or `null` |
| `NEGATIVE_QUANTITY` | An item's `quantity` or `serving_g_or_ml_snapshot` is `<= 0`. | `items[i].quantity` or `items[i].serving_g_or_ml_snapshot` |
| `NEGATIVE_MEASUREMENT` | `energy_kcal`/`protein_g`/`carb_g`/`fat_g`/`sort_order` is negative. | the offending field |
| `ID_CONFLICT` | `id` (meal or an item) already belongs to a different user's/meal's row. | `id` or `items[i].id` |
| `WRITE_FAILED` | Unclassified DB error during the write phase. | `null` |

Validation runs to completion over the **entire** `p_items` array before any
write happens — an invalid item anywhere in the payload never results in a
partial write.

---

## 3. `log_saved_meal_v1`

```
log_saved_meal_v1(
  p_id uuid, p_saved_meal_id uuid, p_occurred_at timestamptz,
  p_local_date date, p_event_timezone text,
  p_meal_type meal_type default null, p_source timeline_source default 'manual',
  p_visibility timeline_visibility default 'private',
  p_title text default null, p_notes text default null,
  p_client_created_at timestamptz default null
) returns jsonb
```

CORE-10: expands a `saved_meals` + `saved_meal_items` **live plan** into a
**brand-new** `food_log_entry`, resolving each item's **current** macros at
log time (§1.10/§3) — editing a saved meal's underlying food improves future
logs from it while past logs stay frozen.

### 3.1 Why `SECURITY DEFINER` (a deliberate, justified exception)

This RPC must read each item's **current** macros from `public.foods`, which
carries **no client GRANT at all** — a `SECURITY INVOKER` function running as
`authenticated` could not read it, exactly the same justification
`search_foods_v1`/`resolve_barcode_v1` already establish. Because `SECURITY
DEFINER` + table-owner exemption means RLS does not filter for this function
on **any** table it touches, every read/write inside it explicitly filters
by `auth.uid()` rather than relying on RLS (`saved_meals`/`saved_meal_items`
ownership, `custom_foods` ownership, and every write to
`timeline_events`/`food_log_entries`/`food_log_items`).

### 3.2 Idempotency — a single-shot online action (distinct from §2.1's two-grain model)

Unlike `save_food_log_entry_v1`, this is a **single-shot, online-only**
"expand and log" action — there is no multi-step offline sync of individual
items to make idempotent at the item grain (a saved meal can only be
expanded while the device can read the current catalog, i.e. is online).
**`p_id` is the sole idempotency key**: if a `timeline_events` row with this
id already exists for the caller with `event_type = 'food_log_entry'`, the
call is treated as an idempotent replay and returns the **already-logged**
meal's current data (`"replayed": true`) without re-expanding the saved meal
a second time. If `p_id` already exists but belongs to a different user or
event type, that is a genuine `ID_CONFLICT`.

### 3.3 Request parameters

| Parameter | Required | Notes |
| --- | --- | --- |
| `p_id` | yes | Client-generated idempotency key for the **new** `food_log_entry`. |
| `p_saved_meal_id` | yes | Must exist, be owned by the caller, and not be soft-deleted. |
| `p_occurred_at` / `p_local_date` / `p_event_timezone` | yes | Same rules as §2.2. |
| `p_meal_type` | no | Falls back to the saved meal's own `meal_type`, then `'other'`. |
| `p_title` | no | Falls back to the saved meal's `name`. |
| `p_source` | no (default `manual`) | `manual`\|`import` only. |
| `p_visibility` | no (default `private`) | |

### 3.4 Success response

```json
{
  "data": {
    "id": "uuid",
    "source_saved_meal_id": "uuid",
    "occurred_at": "2026-07-22T08:00:00Z",
    "local_date": "2026-07-22",
    "meal_type": "breakfast",
    "total_energy_kcal": 210.04,
    "total_protein_g": 2.596,
    "total_carb_g": 53.808,
    "total_fat_g": 0.708,
    "item_count": 1,
    "replayed": false
  }
}
```

### 3.5 Error codes

| `code` | Meaning |
| --- | --- |
| `UNAUTHENTICATED` | No `auth.uid()` in context. |
| `VALIDATION_ERROR` | A required parameter is missing/malformed. |
| `INVALID_SOURCE` | `source` is not `manual`/`import`. |
| `OCCURRED_AT_TOO_FUTURE` / `LOCAL_DATE_OUT_OF_BOUNDS` | Same rules as §2.2. |
| `SAVED_MEAL_NOT_FOUND` | `saved_meal_id` doesn't exist, isn't owned by the caller, or is soft-deleted. |
| `SAVED_MEAL_EMPTY` | The saved meal has no items to log. |
| `FOOD_UNAVAILABLE` | A `food_id`-referenced item is no longer `is_active` in the catalog. |
| `CUSTOM_FOOD_UNAVAILABLE` | A `custom_food_id`-referenced item is no longer available (deleted / not owned). |
| `ID_CONFLICT` | `p_id` already belongs to a different user or event type. |
| `WRITE_FAILED` | Unclassified DB error. |

---

## 4. Known, explicitly accepted scope decisions

- **No seed-row supersession on ingest** — unlike Phase 2's exercise-library
  ingestion (which superseded `milelift_authored` illustrative seed rows in
  place), the food-database ingestion job does not attempt to supersede
  `db-engineer`'s illustrative `foods` seed rows (`SEED-FDC-*`/`SEED-OFF-*`
  `source_ref` placeholders never collide with a real `fdcId`/OFF product
  code, so this is additive growth, not duplicate creation — see
  `scripts/ingest-food-database.mjs`'s header).
- **`log_saved_meal_v1` fails the whole call if any single item's reference
  food has gone stale** (`FOOD_UNAVAILABLE`/`CUSTOM_FOOD_UNAVAILABLE`) rather
  than silently skipping that item — a deliberate choice per
  `production-standards`' "never silently accept partial/corrupted data as
  complete" rule; the alternative (silently dropping one food from a
  multi-item saved meal) would corrupt the user's actual intent more than a
  clear, actionable error.
