# Phase 3 — Module B: Nutrition & Food Logging (CORE-06 … CORE-11)

Status: **CONFIRMED (2026-07-22) — all six product/legal/scope decisions resolved by the
person (§12 Decisions); the remaining four items are implementation-level for `db-engineer`,
not open architecture questions.** Ready for `db-engineer` + `backend-builder` (food-database
ingestion first). Architecture/design only — no migrations or code authored in this phase.

Owner: `architect`. Downstream consumers: `db-engineer` (schema + RLS + migrations +
the food-reference tables + the `foods` search index), `backend-builder`
(the food-log save RPC, the barcode-resolution + food-search RPCs, the FDC+OFF ingestion
job, the daily energy-balance RPC, the offline-cache delta endpoint), `mobile-builder`
(offline food logging + barcode scanner + the bounded offline food cache + background
sync), `ui-ux-designer` (food search/log screen, barcode scan flow, macro dashboard,
water tracker, saved-meal builder, manual-burn logging — must run before `mobile-builder`,
§13).

This doc is designed **against** `docs/architecture/phase-0-foundation.md`,
`phase-1-module-a.md`, and `phase-2-module-c.md`, and reuses **verbatim** the patterns
already live in `supabase/migrations/`: client-generated UUID PK doubling as the
idempotency key; denormalized `user_id` for RLS; the `set_updated_at()` /
`force_insert_audit_timestamps()` triggers; **column-scoped `GRANT`s with the mutable-vs-
immutable column list stated per table and the naive-`.upsert()` gotcha called out
(§8.1)**; no client `DELETE` + soft-delete via `deleted_at`; the `enforce_*_integrity()`
seam + consent-gating trigger pattern; add-only enums; partial indexes on
`deleted_at IS NULL`; fail-closed RLS; the `private` schema for internal-only helpers;
the reference-table class (public read to `authenticated`, service-role write) shared by
`activity_types` / `exercises`; the `{"data"}` / `{"error":{"code","message","field"}}`
RPC envelope; a save RPC doing the multi-table transaction; owner-owned definition tables
(`workout_templates`) vs. spine events. Where this doc says "same pattern as Phase 2," it
means those exact mechanisms — do not reinvent them.

**Scope (this doc):** CORE-06 (food logging against a large searchable open-data DB),
CORE-07 (barcode scanning, offline-capable), CORE-08 (macro tracking), CORE-09 (water
intake), CORE-10 (recipe/meal saving for fast re-logging), CORE-11 (manual
exercise/calorie-burn logging that reconciles with Module A/C without double-counting).
**Out of scope** (noted only where they constrain a shape decided now): AI-09 meal
parsing from photo/text (Phase 5+ — but the spine's `source = ai_parsed` + `confidence` +
`needs_confirmation` and this module's per-item snapshot are the slots it lands in),
AI-10 portion estimation, AI-11 self-correcting logs (the *editability* is designed in
now; the AI correction loop is later), AI-12 auto macro-goal adjustment (consumes the
`get_daily_energy_balance_v1` read designed here), community sharing of meals (Phase 4
widening), and the daily macro **goal/target** model (explicitly OUT of Phase 3 scope per
§12 decision 5 — this phase ships logging + reconciliation reads only).

---

## 0. What Module B adds to the spine, in one paragraph

Three spine event types were **pre-declared in Phase 0 and are already live** in
`20260718210848_create_timeline_events.sql`: `food_log_entry`, `water_intake`,
`manual_calorie_burn` (all `source_module = nutrition`), and the live
`timeline_events_energy_sign_chk` **already** enforces `food_log_entry` energy ≥ 0
(intake) and `manual_calorie_burn` energy ≤ 0 (expenditure) — so Module B attaches to an
energy currency the spine was built to carry. A logged meal/eating occasion is **one
`timeline_events` row** (`event_type = food_log_entry`, positive `energy_kcal` = intake),
with meal-level detail in **`food_log_entries`** (1:1 shared PK) and the actual foods as a
child collection **`food_log_items`** (one client-UUID'd row per food — the offline
idempotency firehose, mirroring `workout_set_logs`). Each item references **either** a
global `foods` row **or** a user-owned `custom_foods` row (exactly one; CHECK), and
**snapshots** the food name + per-serving macros at log time so editing the food DB later
never rewrites history (the CORE-06 gate rule, same discipline as `exercise_name_snapshot`).
Water is **one `water_intake` event** + **`water_intake_logs`** (1:1); a manual burn is
**one `manual_calorie_burn` event** (negative energy) + **`manual_calorie_burn_logs`**
(1:1). The **food reference database** (`foods` + `food_nutrients` + `food_servings`) is a
global reference table — **not** user-owned, **not** a timeline event (same class as
`exercises`/`activity_types`) — but it is **3+ orders of magnitude larger** than the
exercise library, which forces the central access-pattern decision in §2: the full catalog
is **server-side-search-only** (the client never bulk-syncs it), with a **bounded offline
cache** of common barcodes + the user's own history for offline barcode scanning. Reusable
**`saved_meals`** (+ `saved_meal_items`) are owner-owned *definitions, not events* (like
`workout_templates`); logging one snapshots its items into a new `food_log_entry`.
**CORE-11 reconciliation** is not a bespoke integration: because Module A/C workouts and
Module B manual burns are all **negative-energy rows on the same spine**, "today's burn"
and "calories remaining" are a single `SUM(energy_kcal)` over a `local_date` (§4) — the
exact Phase 0 §4 design paying off.

---

## 1. Data model — new tables

All user-owned tables denormalize `user_id` (copied from the spine at insert, or set to
`auth.uid()` for the non-event definition tables) so their RLS policy is a direct
`user_id = auth.uid()` check, per Phase 0 §1.5. `db-engineer` owns exact Postgres
types/constraints/migration; the columns, semantics, and integrity rules below are the
contract. **Canonical-unit rule** (`db-schema-standards`): measured quantities are
`numeric` (never float); food nutrient amounts are stored on a **canonical per-100g /
per-100ml basis** (§2.3), volumes in **milliliters**, energy in **kcal**, with a
**snapshot of the display unit / serving the user logged in** so history renders in the
unit used at the time even if the user later switches preference. Display conversion is
client/API-layer only.

### 1.1 `foods` — the global food reference database (NOT user-owned, NOT a timeline event)

CORE-06's "large searchable database," sourced from **USDA FoodData Central (FDC) + Open
Food Facts (OFF)** per `nutrition-data-standards`. Same ownership class as
`exercises`/`activity_types` (Phase 0 §5/§8): global, read-mostly, **service-role-write,
public-read to `authenticated`**. The critical difference from `exercises` is **size** —
FDC is ~2M entries and OFF is ~3M+ branded products; even a curated merged subset is tens
to hundreds of thousands of rows. This is the table the §2 access-pattern decision exists
to protect against the `max_rows = 1000` silent-truncation bug.

| Column | Type (intent) | Notes / rules |
| --- | --- | --- |
| `id` | uuid, PK | Stable library id. Referenced (and **snapshotted**, §3) by `food_log_items` and `saved_meal_items`. |
| `source` | enum `food_source` (`usda_fdc`\|`open_food_facts`\|`milelift_authored`) | Provenance for attribution/licensing + merge precedence (§2.1). Add-only enum. Mirrors `exercises.source`/`source_dataset`. |
| `source_ref` | text, NOT NULL | The upstream stable key (FDC `fdcId`, OFF product code) — stable across re-ingests so a source update **upserts, never forks a duplicate** (the `exercises.slug` discipline). Unique per `(source, source_ref)`. |
| `barcode` | text, nullable | GTIN/EAN/UPC for branded products (mostly OFF). **Indexed** (§1 indexes) — this is the CORE-07 lookup key. Nullable because generic/whole FDC foods have no barcode. |
| `name` | text, NOT NULL | Canonical display name; localized on client. |
| `brand` | text, nullable | Branded-product manufacturer (OFF). |
| `category` | text, nullable | Coarse food group for browse/filter (FDC food category / OFF categories). |
| `basis` | enum `food_measure_basis` (`per_100g`\|`per_100ml`) | Whether nutrients are stored per 100 grams (solids) or per 100 milliliters (liquids). Resolves the "per 100g vs per serving vs per package" ambiguity at the schema level (§2.3). |
| `energy_kcal` | numeric, NOT NULL | Per `basis`. **Typed column, not EAV** — it is the cross-module currency (feeds the spine's `energy_kcal` at log time) and is queried/displayed on every entry, so it earns a typed, indexable slot (Phase 0 §1.2's "typed if cross-read" rule). CHECK ≥ 0. |
| `protein_g` | numeric, nullable | Per `basis`. CORE-08 macro — typed column (always displayed). CHECK ≥ 0. |
| `carb_g` | numeric, nullable | Per `basis`. CORE-08 macro. CHECK ≥ 0. |
| `fat_g` | numeric, nullable | Per `basis`. CORE-08 macro. CHECK ≥ 0. |
| `data_quality` | enum `food_data_quality` (`high`\|`medium`\|`low`), NOT NULL | The `nutrition-data-standards` confidence signal: FDC + internally-consistent OFF default `high`; sparse/inconsistent OFF defaults `low`. Feeds the confidence-escalation pattern (§6) — a low-quality entry prompts the user to confirm rather than silently logging a possibly-wrong calorie count. |
| `is_active` | boolean, NOT NULL default true | Soft-hide a bad/duplicate entry without deleting (history still snapshots it) — the `exercises.is_active` pattern. |
| `attribution` | text, nullable | Per-entry attribution string the source license requires be shown **in-app** (§2.1, §6) — ODbL (OFF) + USDA citation, not just noted in this doc. |
| `created_at`, `updated_at` | | |

Extended micronutrients (fiber, sugar, saturated fat, sodium, etc.) do **not** get wide
sparse columns — they go in **`food_nutrients`** (§1.2), so the four always-present macros
stay typed/indexable while the long tail is add-only. Seeded/maintained by the ingestion
job (§2.1), never hand-edited. `db-engineer` ships a small **illustrative starter seed** (a
few dozen common foods across both bases + a couple with barcodes) so RLS/grants/search/
barcode behavior verify end-to-end before the real FDC+OFF pipeline lands — exactly how
`exercises` shipped (§2 of Phase 2).

### 1.2 `food_nutrients` — extended micronutrients (child of `foods`)

Split from `foods` because the micronutrient set is large, sparse, and add-only — an EAV
child keyed by an add-only enum, the exact `body_measurement_values` precedent (a variable
set of measured values without wide sparse columns or schema churn per new nutrient).

| Column | Type | Notes |
| --- | --- | --- |
| `id` | uuid, PK | |
| `food_id` | uuid, NOT NULL, FK → `foods.id` ON DELETE CASCADE | |
| `nutrient_kind` | enum `nutrient_kind` (`fiber_g`\|`sugar_g`\|`saturated_fat_g`\|`sodium_mg`\|`cholesterol_mg`\|`potassium_mg`\|…) | Add-only enum. Start with the label-panel set; extend by migration as AI-09/analytics need more. |
| `amount` | numeric, NOT NULL | Per the parent's `basis`. CHECK ≥ 0. |
| `unit` | text, NOT NULL | `g`\|`mg`\|`µg` — matches the `nutrient_kind` suffix; kept explicit for display. |

Unique `(food_id, nutrient_kind)`. RLS: **public read to `authenticated`, service-role
write** (reference data, §8). Micronutrients are **not** snapshotted onto log items by
default (§3) — the four macros + energy are the always-displayed integrity-critical fields;
extended micros are re-derivable via the `food_id` FK and freezing all of them onto every
log item would bloat the firehose. (Whether any single micro is ever snapshotted is an
implementation-level `db-engineer` call, §12.)

### 1.3 `food_servings` — named serving sizes / portion conversions (child of `foods`)

The unit-normalization backbone (`nutrition-data-standards`: "normalize serving size and
units before comparing or merging"). One row per named portion a food can be logged in,
each carrying its **gram/ml weight** so any serving reduces to the canonical `basis` for
macro math. FDC `foodPortions` and OFF `serving_size` map here.

| Column | Type | Notes |
| --- | --- | --- |
| `id` | uuid, PK | |
| `food_id` | uuid, NOT NULL, FK → `foods.id` ON DELETE CASCADE | |
| `label` | text, NOT NULL | "1 cup", "1 medium egg (50 g)", "1 container", "100 g". |
| `gram_or_ml_weight` | numeric, NOT NULL | Weight of one of this serving in the parent's `basis` unit (g or ml). This is what converts a logged "2 cups" into grams → into macros. CHECK > 0. |
| `is_default` | boolean, NOT NULL default false | The serving pre-selected in the log UI (e.g. the OFF declared serving, else "100 g/ml"). |
| `sort_order` | integer | |

RLS: public read, service-role write. Every food gets at least a synthetic `100 g`/`100 ml`
default serving at ingest so a food is always loggable even when the source declares no
portion.

### 1.4 `custom_foods` — user-created foods (owner-owned definition, NOT an event)

A food not in the reference DB (a barcode miss, §6/§2.4, or a homemade item). Owner-only
RLS. The `custom_exercises` precedent exactly. A `food_log_item` references **either** a
`food_id` **or** a `custom_food_id` (exactly one; CHECK), and snapshots the name either way.

| Column | Type | Notes |
| --- | --- | --- |
| `id` | uuid, PK | Client-generated (created offline — the barcode-miss path must work offline). |
| `user_id` | uuid, NOT NULL, FK → `profiles.id` ON DELETE CASCADE | Owner. |
| `barcode` | text, nullable | If created from a scan miss — lets a re-scan resolve to the user's own entry (§2.4). |
| `name` | text, NOT NULL | |
| `brand` | text, nullable | |
| `basis` | enum `food_measure_basis` | `per_100g`\|`per_100ml`. |
| `energy_kcal` | numeric, NOT NULL | Per basis. CHECK ≥ 0. |
| `protein_g`, `carb_g`, `fat_g` | numeric, nullable | Per basis. CHECK ≥ 0. |
| `default_serving_g_or_ml` | numeric, nullable | Simple single-serving conversion (a custom food doesn't need a full `food_servings` child table in Phase 3 — a single default serving covers the manual-entry case; an implementation-level `db-engineer` call if richer serving support is wanted, §12). CHECK > 0 when set. |
| `notes` | text, nullable | |
| `deleted_at` | timestamptz, nullable | Soft-delete (a log item may still snapshot-reference it historically). |
| `created_at`, `updated_at` | | |

### 1.5 `food_log_entries` — the CORE-06/08 subtype (1:1 with the spine)

Shared PK = `timeline_event_id`, 1:1 FK to `timeline_events.id`, inserted in the **same
transaction** as its spine row via the save RPC (§5). Covers `event_type = food_log_entry`.
**Grain decision:** one event = **one eating occasion / meal**, with the individual foods
as the child collection (§1.6) — mirroring `workout_sessions` → `workout_set_logs` and
`body_measurements` → `_values`. Rejected alternative: one event *per food item* — it
would flood the spine (the hottest table) with a row per apple and lose the natural "what
did I eat at breakfast" grouping that macro dashboards and AI-09 both want. Meal-level
totals are **snapshots** so the macro dashboard doesn't re-sum every item on every read.

| Column | Type (intent) | Notes / rules |
| --- | --- | --- |
| `timeline_event_id` | uuid, PK, FK → `timeline_events.id` ON DELETE CASCADE | Shared PK. 1:1. |
| `user_id` | uuid, NOT NULL, FK → `profiles.id` | Denormalized for RLS; must equal the spine row's `user_id` — enforced by trigger (§1.9). |
| `meal_type` | enum `meal_type` (`breakfast`\|`lunch`\|`dinner`\|`snack`\|`other`) | CORE-08 grouping; add-only. |
| `title` | text, nullable | Optional user label ("Post-workout shake"). |
| `notes` | text, nullable | |
| `total_energy_kcal` | numeric, NOT NULL | **Snapshot** at save: Σ item energy. Denormalized so the day's macro dashboard doesn't re-scan items. Recomputed by the save RPC on every edit, **and written onto the spine row's `energy_kcal`** (positive intake) so cross-module reads (§4) never touch the detail table. CHECK ≥ 0. |
| `total_protein_g`, `total_carb_g`, `total_fat_g` | numeric, nullable | **Snapshot** Σ macros. CORE-08 dashboard reads these, not a live re-sum. CHECK ≥ 0. |
| `created_at`, `updated_at` | | `updated_at` via `set_updated_at()`. |

`food_log_entry` is **not** in the spine's never-shareable set — a user *can* share a meal
(`visibility` followers/public), default private (spine fail-closed default). **Decided
(§12 decision 4):** nutrition is treated like most app data — share-capable, private-by-
default, explicit per-event opt-in — and is **not** locked permanently private like
bodyweight/measurements/photos.

### 1.6 `food_log_items` — the per-food firehose (child of `food_log_entries`)

The heart of CORE-06 logging and the offline-idempotency design (§9). One row per food in
the meal. Each carries its **own client-generated `id`** (a second idempotency grain below
the meal, exactly like `workout_set_logs`). Hangs off `food_log_entries`, **not** the spine
(Phase 0 §1.5). Snapshots the food's name + per-serving macros so editing/removing the
reference food never rewrites this logged item (the CORE-06 gate rule, §3).

| Column | Type (intent) | Notes / rules |
| --- | --- | --- |
| `id` | uuid, PK | **Client-generated** on-device — the per-item idempotency key (§9). |
| `timeline_event_id` | uuid, NOT NULL, FK → `food_log_entries.timeline_event_id` ON DELETE CASCADE | The meal this item belongs to. |
| `user_id` | uuid, NOT NULL | Denormalized for RLS; must equal the parent meal's `user_id` (trigger, §1.9). |
| `food_id` | uuid, nullable, FK → `foods.id` | Reference food… |
| `custom_food_id` | uuid, nullable, FK → `custom_foods.id` | …or a custom food. CHECK: **exactly one** of the two is non-null (the `workout_set_logs` exercise-ref pattern). |
| `food_name_snapshot` | text, NOT NULL | **Snapshot** of the food name at log time (§3) — the gate rule. |
| `brand_snapshot` | text, nullable | Snapshot of brand for display stability. |
| `serving_label_snapshot` | text, NOT NULL | The serving the user picked ("2 cups"), frozen. |
| `quantity` | numeric, NOT NULL | Number of servings logged (e.g. 2). CHECK > 0. |
| `serving_g_or_ml_snapshot` | numeric, NOT NULL | Gram/ml weight of **one** serving at log time (from `food_servings`), frozen so re-normalizing the reference food later can't shift this item's macros. CHECK > 0. |
| `energy_kcal` | numeric, NOT NULL | **Snapshot** computed at log time = `quantity × serving_g_or_ml_snapshot / 100 × foods.energy_kcal`. Stored, not live-recomputed. CHECK ≥ 0. |
| `protein_g`, `carb_g`, `fat_g` | numeric, nullable | **Snapshot** macros for this item, same computation. CHECK ≥ 0. |
| `data_quality_snapshot` | enum `food_data_quality`, nullable | Snapshot of the source food's quality signal, so a low-confidence entry stays flagged in history and drives the confirm-prompt (§6). |
| `sort_order` | integer, NOT NULL | Display order within the meal. |
| `deleted_at` | timestamptz, nullable | Soft-delete a removed item; syncs as an update (§9). |
| `created_at`, `updated_at` | | |

Indexes (justified against write cost): `(timeline_event_id, sort_order)` (load a meal's
items in order); `(user_id, food_id) where deleted_at is null` (AI-08 "you usually log X",
"how often do I eat this" — the analytics read); unique PK on `id` (idempotency). A
parallel partial index on `(user_id, custom_food_id)` for custom foods.

### 1.7 `water_intake_logs` — CORE-09 (1:1 with the spine)

The simplest CORE item, but it gets the full spine + detail + RLS treatment. One
`water_intake` event per logged drink. Per-drink-event vs. one-editable-daily-total is an
implementation-level grain choice for `db-engineer` (§12); the architect recommendation is
**per-drink-event**, consistent with every other "point-in-time occurrence" on the spine and
with editability/history.

| Column | Type | Notes |
| --- | --- | --- |
| `timeline_event_id` | uuid, PK, FK → `timeline_events.id` ON DELETE CASCADE | 1:1. `event_type = water_intake`. |
| `user_id` | uuid, NOT NULL | Denormalized for RLS; trigger-checked (§1.9). |
| `volume_ml` | numeric, NOT NULL | Canonical milliliters. CHECK > 0. |
| `unit_volume_snapshot` | text, NOT NULL | `ml`\|`fl_oz` — display unit at log time. CHECK in that set. |
| `source` | text, NOT NULL default `manual` | `manual` today; `wearable`/`import` reserved (smart-bottle/HealthKit water). Plain text + CHECK, matching `bodyweight_logs.source`. |
| `created_at`, `updated_at` | | |

`water_intake` carries **no** `energy_kcal` (water is not energy) — the spine's energy-sign
CHECK already passes NULL. Not health-sensitive in the biometric sense — **not** consent-gated
(§12 decision 3, consistent with all Module B logging).

### 1.8 `manual_calorie_burn_logs` — CORE-11 manual burn (1:1 with the spine)

A user logging energy expenditure for an activity **not** tracked by Module A (GPS) or C
(strength) — e.g. a tennis match, a yoga class, "1 hour of gardening." One
`manual_calorie_burn` event, **negative** `energy_kcal` (the live spine CHECK already
enforces ≤ 0). This is the Module B side of the CORE-11 reconciliation (§4).

| Column | Type | Notes |
| --- | --- | --- |
| `timeline_event_id` | uuid, PK, FK → `timeline_events.id` ON DELETE CASCADE | 1:1. `event_type = manual_calorie_burn`. |
| `user_id` | uuid, NOT NULL | Denormalized for RLS; trigger-checked (§1.9). |
| `label` | text, NOT NULL | What the user did ("Tennis", "Yoga class"). Free text — no reference table; manual burn is deliberately unstructured (it exists precisely for the long tail Module A/C don't model). |
| `activity_type_code` | text, nullable, FK → `activity_types.code` | **Optional** structured link to the Module A activity catalog if the user picks a known type (reuses the live `activity_types` reference table rather than inventing a parallel one). Nullable because free-text is the default. |
| `duration_minutes` | integer, nullable | Optional; if given, the spine's `duration_seconds` is set = `duration_minutes × 60`. CHECK ≥ 0. |
| `energy_source` | enum `manual_burn_energy_source` (`user_entered`\|`estimated`) | Whether the kcal figure is a number the user typed or an app estimate (MET-table × duration × bodyweight — the latter needs bodyweight + `health` consent, same gate as Module A/C energy estimation, §6). |
| `notes` | text, nullable | |
| `created_at`, `updated_at` | | |

The burned-kcal magnitude lives on the **spine** (`energy_kcal`, negative) — not duplicated
here — exactly so CORE-11/AI-12 read it cross-module without touching this detail table
(Phase 0 §1.2 / §4).

### 1.9 Seam-integrity trigger (mirrors `enforce_bodyweight_logs_integrity`)

A `BEFORE INSERT/UPDATE` trigger on each detail table (`food_log_entries`,
`food_log_items`, `water_intake_logs`, `manual_calorie_burn_logs`), reusing the live
pattern, enforces at the DB layer: (1) the denormalized `user_id` matches the parent's
`user_id` (spine row for the 1:1 detail; parent meal for a `food_log_item`) so it can't
diverge; (2) the referenced spine row's `event_type` is the expected one
(`food_log_entry` / `water_intake` / `manual_calorie_burn`); (3) on `food_log_items`,
exactly one of `food_id`/`custom_food_id` is set and, if `custom_food_id`, it is owned by
the caller. Constraints in the DB, not just app code (`db-schema-standards`,
`production-standards`).

### 1.10 `saved_meals` + `saved_meal_items` — CORE-10 (owner-owned definition, NOT an event)

A reusable named bundle of foods a user logs in one action. Owner-owned *definition, not a
point-in-time occurrence* (Phase 0 §1.1 lists "saved recipes" explicitly as a
definition/template, not a spine event) — the `workout_templates` + `workout_template_exercises`
precedent exactly. Owner-only RLS in Phase 3 (community recipe sharing widens this in
Phase 4 — §12 decision 4). **No snapshot on the definition** — a saved meal is a *live* plan
the user edits deliberately; the snapshot happens when a **`food_log_entry` is logged from
it** (§3), so editing/deleting the saved meal never rewrites already-logged history.

`saved_meals`: `id` (uuid PK, client-gen), `user_id`, `name` NOT NULL, `description`,
`meal_type` (nullable default), `deleted_at`, `created_at`, `updated_at`.

`saved_meal_items` (child, one row per food): `id`, `saved_meal_id` (FK ON DELETE CASCADE),
`user_id`, `food_id`/`custom_food_id` (exactly one; CHECK), `serving_label`,
`serving_g_or_ml`, `quantity`, `sort_order`. **No macro snapshot here** — like a template's
`target_reps`, a saved meal points at the *current* food; macros are resolved at log time so
a corrected reference food improves future logs. Logging a saved meal (§5) expands its items
into `food_log_items`, snapshotting name+macros at that moment.

---

## 2. Food reference database — sourcing, merge/dedup, unit normalization, and the access pattern (the CORE-06/07 decision — APPROVED, §12 decision 1)

This is the gate's most load-bearing decision and the one the task flags three explicit
hazards against. The **engineering** parts (data sources, ingestion, dedup, hosting, access
pattern) are this doc's; the **content/legal** part (ODbL share-alike acceptance) was the
person's call and is now **APPROVED** (§12 decision 1).

### 2.1 Sources, merge order, attribution (per `nutrition-data-standards`)

- **USDA FoodData Central (FDC)** — authoritative for generic/whole foods and
  government-verified branded entries. Public domain (USDA still expects **citation**).
  Higher default trust (`data_quality = high`).
- **Open Food Facts (OFF)** — crowd-sourced, far larger branded/barcoded coverage, variable
  quality. Published under **ODbL** (attribution **and share-alike** obligations). Default
  trust `medium`/`low` depending on macro completeness/consistency.
- **MileLift-authored** — gap fills, owned outright.

**Deterministic merge/dedup order** (carried from `nutrition-data-standards`, same discipline
as the exercise library's §2.1): prefer **FDC for generic/whole foods**; prefer **OFF for
barcode-scanned branded items where FDC has no match**; when both cover the same barcode and
**materially disagree on macros, flag — do not silently pick** (record both / mark
`data_quality = low` / surface for review). Dedup key is `(source, source_ref)` for stable
re-ingest + a normalized name/brand/barcode match across sources. An **ingestion job**
(`backend-builder`, service-role, off any hot path) runs on a **documented cadence** (FDC
periodic releases; OFF continuous) and **versions the dataset snapshot** so a bad upstream
update rolls back rather than silently corrupting search for every user. Per-entry
`source`/`attribution` (§1.1) so **attribution actually renders in-app** (a nutrition
credits/sources surface) where ODbL + USDA require — the same in-app-attribution gate as
Module C's CC-BY-SA. **Confirm current license terms for each source before shipping**
(terms change) — legal sign-off on the **ODbL share-alike obligation for redistributed OFF
data** is tracked as a pre-public-launch item (§12), mirroring how Phase 2 tracked wger's
CC-BY-SA.

### 2.2 The access pattern — the `max_rows = 1000` hazard, resolved explicitly

`supabase/config.toml` sets `max_rows = 1000`: **any unranged PostgREST `select()` on
`foods` silently truncates to 1000 rows with a normal 200 response, no error.** A naive
"cache the whole food database locally" or "search returns everything" design would either
be enormous or hit this exact silent-truncation bug that already bit the (3-orders-of-
magnitude-smaller) exercise library. **Decision: the full catalog is (a) server-side-search-
only — the client never bulk-syncs `foods`.** Concretely:

1. **Text search → a paginated search RPC** `search_foods_v1(query, cursor, limit)` (§5),
   `SECURITY INVOKER`, that returns a **bounded, ranked, cursor-paginated** page (default/
   max page size a named constant well under 1000). Never an unranged select. Ranking:
   exact/prefix name match + `data_quality` + FDC-over-OFF tie-break. `db-engineer` adds the
   supporting index (trigram/GIN or `tsvector` — the concrete shape is the search RPC's, so
   the index is added *with* that RPC, not speculatively, per `db-schema-standards`).
2. **Barcode lookup → an exact point lookup** on the indexed `barcode` column (a filtered
   select is single-row and safe, or a thin `resolve_barcode_v1(barcode)` RPC, §5). Never a
   scan.
3. **The client MUST NOT ever `.select()` `foods`/`food_nutrients`/`food_servings`
   unranged.** Stated here so `backend-builder`/`mobile-builder` don't reintroduce the
   truncation bug: every catalog read is either the paginated search RPC, the barcode point
   lookup, or the bounded offline-cache delta (§2.3/§9). `db-engineer` documents this on the
   grant; there is deliberately **no unbounded list endpoint** on these tables.

### 2.3 Unit normalization (the silent-off-by-serving-ratio bug)

`nutrition-data-standards` names this as one of the most common real nutrition-app bugs:
two sources reporting "per 100g" vs "per serving" vs "per package" for the same field,
silently producing numbers off by the serving ratio. Resolved structurally: **`foods`
stores nutrients on a single canonical `basis` (per 100 g or per 100 ml)** — the ingestion
job converts every source's declared basis to that canonical form at ingest, once, server-
side. Named servings live in **`food_servings`** with an explicit `gram_or_ml_weight`, so a
logged "2 cups" resolves deterministically: `grams = quantity × serving_weight` →
`macros = grams / 100 × foods.<macro>`. The log item then **snapshots the resolved
per-serving weight + macros** (§1.6) so a later re-normalization of the reference food never
retroactively shifts a historical entry.

### 2.4 Offline barcode scanning — reconciled with server-side-search-only (CORE-07 + CORE-17 gate)

The gate requires barcode scanning to **work offline**, but §2.2 says the full catalog is
server-side-search-only and never bulk-synced. Reconciliation — a **bounded two-part local
cache**, never the full catalog:

- **A curated "common foods/barcodes" subset** shipped/synced to the device: the top-N most-
  frequently-scanned/logged products (a few thousand rows — small enough to sync and query
  in local SQLite, orders of magnitude under both `max_rows` and any storage concern). This
  is the offline-capable barcode dataset `nutrition-data-standards` step 1 assumes. It syncs
  as a **bounded, versioned delta** on its own cadence (like the exercise-library mirror,
  Phase 2 §9), **not** an unranged pull.
- **The user's own recently-logged + saved foods + custom foods**, which are already local
  (they live in the user's timeline / owner-owned tables and sync normally).

**Barcode resolution flow (CORE-07), miss handled explicitly — never a silent dead end:**
1. Look up the scanned barcode in the **local cache** first (offline-capable, fast).
2. On a local miss **and online**: hit the **full server catalog** via the barcode point
   lookup (§2.2 step 2).
3. On a local miss **and offline**, or a full-catalog miss: route the user to **manually
   create the food** (a `custom_foods` row, creatable offline, §1.4) carrying the scanned
   `barcode`, so it is immediately loggable and a **re-scan resolves to the user's own
   entry**. The offline-queued barcode is also retried against the server on reconnect.
   Per `nutrition-data-standards` / AI-11, a user correction/creation is **retained**
   (owner's `custom_foods`), not overwritten on the next scan. A barcode miss creates **only**
   a local custom food — contributing user-created foods *back upstream* to OFF is **out of
   Phase 3 scope** (§12 decision 6).
4. Every barcode-resolved entry still passes through the same confidence/edit path as any
   other entry — a barcode match is not automatically high-confidence if the underlying
   source data is sparse (`data_quality` drives the confirm prompt, §6).

### 2.5 Rejected alternatives

- **Bulk-sync the whole food DB to the client.** Rejected — enormous, and any unranged sync
  hits the `max_rows = 1000` silent truncation (or, if paginated, ships hundreds of MB of
  mostly-never-used branded products to every device). The bounded common-subset cache
  (§2.4) gives offline scanning of the products people actually scan without either failure.
- **A single wide `foods` table with all ~150 micronutrients as columns.** Rejected — sparse,
  and forfeits add-only extension; micros go in the `food_nutrients` EAV child (§1.2) while
  the four always-used macros stay typed (the spine's typed-if-cross-read rule).
- **Live per-request calls to the OFF/FDC public APIs at log time.** Rejected as the primary
  path — a third-party API on the hot logging path (offline-first app, no SLA) violates
  Phase 0 §10 and `production-standards`. We ingest into our own `foods` and serve from it;
  the OFF API is only a possible *fallback enrichment* for a brand-new barcode miss (§10),
  never the logging critical path.

---

## 3. Snapshot discipline at this seam (the CORE-06 gate rule)

Same rule as Phase 0 §1.5 / Phase 1 §1.3 / Phase 2 §3, applied to nutrition:

- `food_log_items` stores `food_id`/`custom_food_id` (the live reference) **and** snapshots
  `food_name_snapshot` + `brand_snapshot` + `serving_label_snapshot` +
  `serving_g_or_ml_snapshot` + per-item `energy_kcal`/`protein_g`/`carb_g`/`fat_g` +
  `data_quality_snapshot` at log time.
- **Editing/re-normalizing/re-categorizing a `foods` entry, or hiding it (`is_active =
  false`), never retroactively changes a meal already logged against it** — the historical
  item reads its own snapshot; the FK is only for "jump to the current food" / future
  re-computation. A reference food is soft-hidden, never hard-deleted; a custom food soft-
  deletes; the log item's FK is nullable/SET-NULL-safe so referential changes never destroy a
  log.
- `food_log_entries.total_*` are meal-level snapshots for the same reason (and the total
  energy is mirrored onto the spine's `energy_kcal`), so the macro dashboard and the day's
  energy balance are stable and never re-scan items on read.
- `saved_meals`/`_items` are **not** snapshotted (they are live plans, §1.10); the snapshot
  happens when a session is logged from them — identical to `workout_templates`.
- Extended micronutrients are **not** snapshotted by default (§1.2) — re-derivable via FK,
  and freezing them onto the firehose buys no integrity for the fields users actually track.

This is the same end-to-end discipline as the spine's `energy_kcal`/`load_score`, Module A's
`activity_type_name_snapshot`, and Module C's `exercise_name_snapshot`.

---

## 4. CORE-11 reconciliation — the first real cross-module design (DECIDED, §12 decision 2)

The gate test is explicit: **"log a workout in Module A, confirm the calorie-burn figure
appears correctly in Module B without double-counting."** Phase 0 §12.7 deferred *which of a
manual burn vs. a GPS activity "wins" the day's total* to Phase 3. Here is the concrete
design.

### 4.1 Where the authoritative calorie-burn number lives

**On the spine's `energy_kcal`, signed, for every expenditure event type**, across all
modules: `gps_activity` (Module A), `strength_session` (Module C), and
`manual_calorie_burn` (Module B) — all write **negative** `energy_kcal` (already enforced by
the live `timeline_events_energy_sign_chk`). Food writes **positive** `energy_kcal`. There is
**one row per real-world occurrence** and its energy lives in exactly one place. Module B
does **not** copy, cache, or recompute Module A/C's burn — it reads the spine.

### 4.2 How Module B surfaces it (one indexed query, no bespoke integration)

The day's numbers are a single scan of the spine over a `local_date`, served by the live
`idx_timeline_events_user_local_date` partial index:

- **Calories in** = `SUM(energy_kcal) WHERE energy_kcal > 0` (intake).
- **Calories out (burn)** = `-SUM(energy_kcal) WHERE energy_kcal < 0` — this **automatically
  includes** a Module A run and a Module C workout with **zero extra work**, because they are
  already negative-energy rows on the same spine.
- **Net** = `SUM(energy_kcal)` (intake minus expenditure). A user-facing "remaining vs.
  goal" needs a target; the goal/target model is **out of Phase 3 scope** (§12 decision 5),
  so Phase 3 surfaces net actuals, not remaining-vs-goal.

Exposed as `get_daily_energy_balance_v1(local_date)` (`SECURITY INVOKER`, RLS applies) — the
exact RPC Phase 0 §5 named. This is the AI-12 read too. **The gate is concretely testable:**
log a GPS run in Module A → it writes one negative-energy spine row → open Module B's day
view → the burn total (this RPC) includes that run **exactly once**, shown as a
tracked-workout line item, with no Module B row created for it and nothing to double-count.

### 4.3 The deterministic double-counting rule

The only genuine double-count risk is a user **manually** logging a `manual_calorie_burn`
for **the same activity** Module A/C already tracked (e.g. logging "Run −450" by hand after
their watch already synced it). The rule:

- **Manual burns and tracked workouts are always separate spine rows and always additive at
  aggregate time — never merged into one physical row, never silently suppressed** (Phase 0
  §11 already committed to "not merging a manual burn and a GPS activity into one row"; user-
  entered data is never destroyed). Manual burn exists for activities Module A/C **don't**
  track (tennis, yoga, gardening), so in the normal case they are genuinely additive and
  correct.
- **A non-destructive overlap advisory prevents *accidental* duplication.** When the user
  adds a `manual_calorie_burn` whose time window (`occurred_at` .. `occurred_at +
  duration`) **overlaps an existing `gps_activity`/`strength_session` that already has a
  populated (non-NULL, negative) `energy_kcal` for that window**, the log flow **warns**:
  "You already have a tracked workout in this window that's counted in today's burn — add
  this anyway?" The user confirms or cancels. This is computable client-side from the local
  timeline (source of truth) and re-checkable server-side in the save RPC — a normal query
  over `source`/`occurred_at`/`duration_seconds`/`energy_kcal`, exactly what Phase 0 §4 said
  the spine carries for this.
- **The advisory is a soft, non-blocking warning — never an auto-merge, hard block, or
  silent suppression** (§12 decision 2). Only the user knows whether their manual "yoga −200"
  is the same session their watch logged as a "workout −180" or a genuinely separate second
  activity; auto-suppressing would destroy a real second workout and hard-blocking would stop a
  legitimate additive log, so the app warns and lets the user decide. Both entries keep counting
  until the user removes one.

So Phase 0 §12.7 resolves as: **neither "wins" — all expenditure rows sum**, provenance is
visible per line item in the UI (tracked vs. manual), and the overlap advisory stops
accidental same-activity duplication without ever destroying or hiding a row.

---

## 5. API surface (`api-contract-standards` + `supabase-standards`)

Per Phase 0 §5: RLS is the authorization mechanism; no `/v1` URL versions; RPC/function
versions carry the suffix.

- **Reads → direct PostgREST under RLS.** Own food-log history (a meal + its items),
  saved meals, water/manual-burn history, custom foods — filtered selects where RLS fully
  expresses authorization. History pagination is **cursor-based on `(occurred_at, id)`**
  (Phase 0 §3.6), never offset.
- **Food search → `search_foods_v1(query, cursor, limit)`, `SECURITY INVOKER`, paginated/
  ranged** (§2.2). The reference tables have **no unbounded list endpoint** — this and the
  barcode lookup are the only catalog read paths (guards the `max_rows` bug).
- **Barcode resolution → `resolve_barcode_v1(barcode)` (or a single-row filtered select on
  the indexed `barcode`)**, returning the food + its servings, or a structured "not found"
  that the client routes to custom-food creation (§2.4). Never a silent empty result.
- **Saving/finishing a meal → `save_food_log_entry_v1`, `SECURITY INVOKER`** (RLS applies) —
  the right layer (`supabase-standards`) because a meal save is **transactional across
  `timeline_events` + `food_log_entries` + N `food_log_items`** with total/energy snapshotting
  and the spine `energy_kcal` write, which a bare multi-row PostgREST upsert can't do
  atomically. Inputs: client-generated meal `id` (idempotency key), spine fields, meal
  fields, and a **jsonb array of items each carrying its own client `id`** (§9). `user_id`
  is always `auth.uid()`, never a parameter. Validates at the boundary: `quantity`/serving/
  macro ≥ 0, `energy_kcal ≥ 0` (intake), exactly-one food-ref per item, `occurred_at` not
  >24h future (the live clock-skew constant), unit enums. **Set-array semantics: upsert-
  present, never delete-omitted** — a removed item is an explicit `deleted_at` in the
  payload, so a truncated/retried payload can never destroy items (§9). Mirrors
  `save_workout_session_v1` exactly. Version-suffixed.
- **Logging a saved meal → `log_saved_meal_v1(saved_meal_id, occurred_at, …)`** (or the
  client expands the saved meal into an item array and calls `save_food_log_entry_v1`) —
  either way it snapshots current food macros into new `food_log_items` (§3). `db-engineer`/
  `backend-builder` pick; recommend the RPC so the snapshot resolution is server-authoritative
  and transactional.
- **Water / manual burn → small dedicated RPCs or direct table upserts under RLS + the
  consent/seam triggers.** These are single-detail-row writes (no child firehose), so a
  direct upsert to the mutable column set (§8.1) is acceptable; a thin
  `save_water_intake_v1` / `save_manual_burn_v1` is cleaner for the spine+detail transaction
  and recommended for consistency. Manual-burn writes the negative `energy_kcal` to the spine.
- **Daily energy balance / macro totals → `get_daily_energy_balance_v1(local_date)` and
  `get_daily_macros_v1(local_date)`, `SECURITY INVOKER` aggregates** (§4.2), server-side,
  not reassembled on the client.
- **Food-DB ingestion/refresh → a backend job/Edge Function, service-role, off any hot
  path** (§2.1) — writes the reference tables, which are not client-writable.
- **Error envelope + codes** (RPC): the single `{"error":{"code","message","field"}}` shape
  with stable machine codes, e.g. `VALIDATION_ERROR`, `FOOD_NOT_FOUND`,
  `BARCODE_NOT_FOUND`, `INVALID_FOOD_REF` (zero or both refs set), `NEGATIVE_QUANTITY`,
  `INVALID_ENERGY_SIGN`, `CONSENT_REQUIRED_HEALTH` (bodyweight-reading energy estimation only —
  §6 / §12 decision 3; ordinary logging is not consent-gated), `ID_CONFLICT`. Never a raw
  Postgres error to the client.
- The contract (RPC signatures, resource shapes, error codes) is **written down**
  (`docs/api/`, OpenAPI/equivalent) and kept in sync — builders implement against it.

---

## 6. Data sensitivity (`health-data-compliance` — decisions resolved in §12)

Nutrition data is **more health-sensitive than it first appears** — the two calls below were
flagged rather than decided silently, and are now resolved (§12 decisions 3 and 4):

- **Dietary/food-log data & consent — DECIDED (§12 decision 3): no dedicated gate on logging.**
  Detailed dietary logs can, under some GDPR interpretations, reveal health conditions
  (diabetes management, eating disorders), which is why this was flagged. Resolution: food/
  water/manual-burn logging is treated as **ordinary core-product app data** — **no** new
  `nutrition` consent category, **no** per-write consent trigger (gating every meal write would
  be disproportionate and hostile to the offline-first flow). The live `consent_category` enum
  (`health`\|`location`\|`camera`\|`body_image`) is **unchanged** by Module B. The **one**
  consent gate is on **energy *estimation* that reads bodyweight** (the `estimated` manual-burn
  source, §1.8), which stays behind the existing Phase 2 **`health`** consent exactly like
  Module A/C energy estimation. The privacy policy must still specifically cover dietary data (a
  legal, pre-launch item).
- **Sharing / ED-adjacency — DECIDED (§12 decision 4): share-capable, private-by-default.**
  `food_log_entry` is treated like most app data — shareable via the spine's `visibility` with a
  fail-closed **private default** and explicit per-event opt-in — and is **not** added to the
  spine's never-shareable set (unlike bodyweight/measurements/photos). Nothing leaks without an
  explicit widen; the ED-adjacency concern is addressed by the private default + per-event
  granularity, not by locking nutrition permanently private.
- **Data minimization.** Store the logged item + its snapshot macros (the product *is* the
  food log); do not persist, e.g., the raw camera frame from a future AI-09 photo-parse after
  the parse (that's an AI-phase concern, flagged forward).
- **Confidence-escalation for open-data quality** (`nutrition-data-standards` +
  `ai-orchestration-standards`): a `data_quality = low` food surfaces a confirm prompt rather
  than silently logging a possibly-wrong calorie count — the `needs_confirmation`/`confidence`
  spine slots + `data_quality_snapshot` carry this. Every entry stays **editable** (AI-11 /
  CORE-11 self-correcting logs) — a genuine, tested edit path, not a support ticket.
- **Third-party leakage guard:** no `toJSON()` of a food-log/biometric row into an analytics/
  crash payload — dietary values don't leak to third-party SDKs (Phase 0 §6).
- **Attribution actually ships** (§2.1): ODbL (OFF) + USDA citation render on an in-app
  nutrition-sources/credits surface, not just this doc — same standard as Module C's exercise
  attribution.

---

## 7. User-rights code paths (extend the Phase 0/A/C walk to Module B)

- **Export:** the nutrition tables join the existing timeline export — meals + items + water
  + manual burns + saved meals + custom foods — into the portable format. A real, tested path.
- **Deletion:** cascades wired so `profiles` → `timeline_events` → (`food_log_entries` →
  `food_log_items`; `water_intake_logs`; `manual_calorie_burn_logs`) all `ON DELETE CASCADE`;
  owner-owned `custom_foods` / `saved_meals` → `saved_meal_items` cascade from `profiles`.
  No Storage objects in Module B (nutrition has no user-uploaded blobs in Phase 3 — AI-09
  meal photos are a later phase), so unlike Module A/C there is **no Storage-orphan cleanup**
  to wire. Honors the Phase 0 §12.2 hard-delete-after-grace policy.
- **Correction:** a meal/item/water/burn is a normal editable timeline event; edits flow
  through the save RPC (re-snapshotting totals + the spine energy) or a direct owner update.
  No support ticket. This *is* AI-11's "editable, self-correcting logs" substrate.

---

## 8. RLS boundary — one row per new table (`db-engineer` implements)

Same discipline as Phase 0/1/2 §8. RLS enabled in the **same migration** as each table — no
exceptions (this project's hard rule; Phase 0's default-grants vulnerability). Cross-user
reads encoded in the policy, never filtered in app code.

| Table | RLS posture |
| --- | --- |
| `foods`, `food_nutrients`, `food_servings` | **Not user-owned, not a timeline event.** Public read to `authenticated`; **writes service-role only** (ingestion job). Same class as `exercises`/`activity_types`. **No unbounded list grant/endpoint** — read only via the paginated search RPC + barcode point lookup (§2.2). |
| `custom_foods` | Owner-only (`user_id = auth.uid()`), SELECT/INSERT/UPDATE; no client DELETE (soft-delete via `deleted_at`). |
| `food_log_entries` | Owner-only via denormalized `user_id`; SELECT/INSERT/UPDATE, **no client DELETE** (soft-delete on the parent spine row + cascade at hard-purge, mirroring `activity_details`/`workout_sessions`). Column-scoped UPDATE excluding `timeline_event_id`/`user_id`/`created_at` (§8.1). Share-capable via the spine's `visibility` (default private, per §12 decision 4). |
| `food_log_items` | Owner-only; SELECT/INSERT/UPDATE, no client DELETE (soft-delete via `deleted_at`). Column-scoped UPDATE excluding the identity + snapshot columns (§8.1). |
| `water_intake_logs`, `manual_calorie_burn_logs` | Owner-only; SELECT/INSERT/UPDATE, no client DELETE (soft-delete on the parent spine row). Column-scoped UPDATE excluding identity columns (§8.1). |
| `saved_meals`, `saved_meal_items` | Owner-only in Phase 3. Community recipe sharing (Phase 4) widens `saved_meals` with an explicit visibility policy then — not now (fail-closed default; §12). Soft-delete via `deleted_at`. |

### 8.1 Column-scoped UPDATE grants + the naive-`.upsert()` gotcha (RECURRING LESSON — must not repeat a fourth time)

**This exact class of bug has recurred three times across three phases.** A blanket client
`.upsert()` compiles to `INSERT … ON CONFLICT DO UPDATE SET <every payload column>`, and
Postgres checks UPDATE privilege on **every** one of those columns at **plan time** — even
with no real conflict — so a column-scoped grant makes a naive full-row upsert fail at plan
time. The mutable-vs-immutable column split is stated **explicitly per table** so
`backend-builder`/`mobile-builder` build to it:

- **`food_log_items`** — **mutable (client UPDATE granted):** `food_name_snapshot`,
  `brand_snapshot`, `serving_label_snapshot`, `quantity`, `serving_g_or_ml_snapshot`,
  `energy_kcal`, `protein_g`, `carb_g`, `fat_g`, `data_quality_snapshot`, `sort_order`,
  `deleted_at`. **Immutable (excluded):** `id`, `timeline_event_id`, `user_id`, `food_id`,
  `custom_food_id`, `created_at`. (A correction that changes *which food* an item is becomes a
  delete-old-item + insert-new-item, not an in-place ref swap — keeps the food-ref immutable
  and the snapshot honest.)
- **`food_log_entries`** — **mutable:** `meal_type`, `title`, `notes`, `total_energy_kcal`,
  `total_protein_g`, `total_carb_g`, `total_fat_g`. **Immutable:** `timeline_event_id`,
  `user_id`, `created_at`.
- **`water_intake_logs`** — **mutable:** `volume_ml`, `unit_volume_snapshot`, `source`.
  **Immutable:** `timeline_event_id`, `user_id`, `created_at`.
- **`manual_calorie_burn_logs`** — **mutable:** `label`, `activity_type_code`,
  `duration_minutes`, `energy_source`, `notes`. **Immutable:** `timeline_event_id`,
  `user_id`, `created_at`.
- **`custom_foods`** — **mutable:** `barcode`, `name`, `brand`, `basis`, `energy_kcal`,
  `protein_g`, `carb_g`, `fat_g`, `default_serving_g_or_ml`, `notes`, `deleted_at`.
  **Immutable:** `id`, `user_id`, `created_at`.
- **`saved_meals` / `saved_meal_items`** — mutable = the plan fields (name/description/
  meal_type; item serving/quantity/order); immutable = `id`/`user_id`/`saved_meal_id`/
  `created_at` and the exactly-one food-ref pair.

**The write path for a meal SHOULD be `save_food_log_entry_v1`, not a raw table upsert** —
the RPC does the multi-table transaction the client can't. If a direct-table upsert is
nonetheless used for a small edit (toggling a serving, correcting a quantity), it **must**
target only the mutable column set above (a PostgREST upsert with an explicit column list,
**not** a whole-row object), or the write is rejected at plan time. `db-engineer` documents
this on each grant; `backend-builder`/`mobile-builder` build to it. Reference tables
(`foods`/`food_nutrients`/`food_servings`) get **no** client UPDATE grant at all (service-
role write only), so the gotcha cannot arise there.

---

## 9. Sync / offline (CORE-06/07/17 — modules inherit Phase 0 §3; Module B specifics)

The Phase 0 §3 rules are inherited, not reinvented. Food logging is offline-first: a meal is
logged in a kitchen or a restaurant with poor signal and syncs later.

- **Source of truth & durability.** The on-device SQLite store is the UI's source of truth
  (Phase 0 §3.2). Local schema (`src/db/schema.ts` `SCHEMA_STATEMENTS`) gains
  `food_log_entries`, `food_log_items`, `water_intake_logs`, `manual_calorie_burn_logs`,
  `custom_foods`, `saved_meals`(+items), and the **bounded read-only cached food subset +
  servings** (§2.4) so search-of-common-foods + barcode scanning + logging work fully offline.
  Each writable local table carries the existing `sync_status`/`pending_payload`/
  `last_sync_error` columns and the visible `SyncStatusPill`. **The full `foods` catalog is
  NOT mirrored locally** (§2.4) — only the curated common subset + the user's own foods.
- **Idempotency (two grains — the "two copies of my breakfast" bug, designed out).** Every
  item gets its own client UUID `id` at log time; the meal gets its own client UUID (=
  `timeline_events.id`), both generated offline before any network. `save_food_log_entry_v1`
  does `INSERT … ON CONFLICT (id) DO UPDATE` on the spine/meal **and on each item** — not
  application check-then-insert (which races under retry). Retrying the whole meal, or any
  subset, is always safe. **Item removal syncs as an explicit `deleted_at`, never as an
  omission** (§5) — a truncated/retried payload can never destroy items.
- **In-progress vs. committed.** A meal being assembled is layer-2 local domain state (Phase 0
  §3.5), durable in SQLite; it becomes a spine row + rows on save. (Meals are short-lived
  compared to a workout, so no server-side autosave question arises.)
- **Conflict resolution = the platform default: last-write-wins by server `updated_at` at the
  row grain** (Phase 0 §3.5). A meal edited on two devices resolves LWW at the meal-row grain;
  items resolve at the item-row grain (the same reasoned two-grain refinement Module C §9.4
  made for sets — independent items logged incrementally shouldn't clobber each other). No
  field-level merge.
- **Sync cursor** stays `updated_at` on the spine (Phase 0 §3.6); pulling a changed meal pulls
  its items via `timeline_event_id`. The **food-cache subset pulls on its own bounded, versioned
  cadence** (like the exercise-library mirror), independent of the user timeline and never
  unranged.

---

## 10. Third-party integration failure modes

- **FDC / OFF (build/ingest-time, not runtime hot path).** The ingestion job runs server-side,
  off any user request; if a source is down, the last good **versioned snapshot** (§2.1) keeps
  serving. A bad upstream update rolls back to the prior snapshot version, not silently
  shipped. **No user-facing runtime dependency for logging** — the client logs against our
  ingested `foods` + the local cache, not a live third-party call.
- **Optional live OFF-API enrichment for a brand-new barcode miss** (if built, §2.4): strictly
  a **fallback, off the critical path** — a slow/down OFF API degrades to the manual-create
  flow (§2.4 step 3), never blocks logging. If added it runs in an Edge Function with a tight
  timeout, never a synchronous client call on the hot path (Phase 0 §10, `production-standards`
  unhappy-path).
- **Barcode scanner (on-device camera).** Camera unavailable / permission denied ⇒ manual
  search/entry still works; scanning degrades gracefully, no crash. (Camera permission is the
  live `camera` consent category — the scanner is a point-of-use camera prompt, §13.)

---

## 11. Explicit tradeoffs — what we chose NOT to do, and why

- **Full catalog server-side-search-only + a bounded offline cache, NOT a full local mirror
  and NOT live per-request source-API calls (§2).** We give up "the entire food DB is offline"
  to avoid shipping hundreds of MB to every device and to sidestep the `max_rows` truncation
  bug; the common-subset cache gives offline scanning of the products people actually scan.
- **Meal as one event with an items child collection, NOT one event per food and NOT a JSONB
  item blob (§1.5/§1.6).** One-event-per-food would flood the spine; a JSONB blob would forfeit
  per-item idempotency, per-item analytics indexes, and DB-level per-item CHECKs (the same
  argument the spine made against a JSONB bag, Phase 0 §4, and Module C made against a JSONB
  set array). We accept a high-write child table (indexed against write cost) for correct
  offline idempotency and queryable history.
- **Four macros as typed columns, micronutrients as an EAV child (§1.1/§1.2).** We keep the
  always-displayed integrity-critical fields typed/indexable and make the sparse long tail
  add-only, rather than a 150-column sparse table or a fully-untyped bag.
- **Manual burn + tracked workouts additive-with-overlap-advisory, NOT auto-merged and NOT
  hard-blocked (§4.3).** We give up "the app silently reconciles duplicates for you" to
  guarantee we never destroy a real second workout or block a legitimate additive log;
  reconciliation is at read/aggregate time over one spine, provenance visible per line item.
- **Saved meals as live definitions with log-time snapshot, NOT snapshotted definitions
  (§1.10).** Editing a recipe improves future logs while past logs stay frozen — the
  `workout_templates` posture.
- **No consent-gate on ordinary food/water logging (§6, §12 decision 3), only on bodyweight-
  reading energy estimation.** We chose not to make every meal write a consent-gated operation
  (disproportionate, hostile to offline-first); the dietary-data legal question was flagged and
  resolved rather than decided silently.
- **Not building the macro/calorie GOAL model here (§12 decision 5).** Phase 3 ships logging +
  reconciliation reads; the *target* a user is logging against (and AI-12's auto-adjustment of
  it) is a distinct later scope, kept out to bound Phase 3 and avoid scope creep into the AI
  phase.
- **No community meal sharing, no upstream contribution to OFF (§2.4, §12 decisions 4/6).**
  Owner-only in Phase 3; community recipe sharing widens in Phase 4, and upstream OFF
  contribution is out of scope. Kept out to prevent scope creep.

---

## 12. Decisions (resolved 2026-07-22) and remaining implementation-level items

**Resolved by the person — all six product/legal/scope calls; every architect recommendation
accepted as recommended:**

1. **Food-DB sourcing — APPROVED as recommended (§2).** USDA FoodData Central (public-domain,
   cited) + Open Food Facts (ODbL) + MileLift-authored, merged with deterministic dedup, and
   **in-app attribution shipping** for the ODbL share-alike + USDA-citation obligation (a
   nutrition sources/credits surface, not just this doc). `backend-builder` builds the versioned,
   deterministic-dedup ingestion job (§2.1). Legal sign-off on the ODbL share-alike obligation
   for redistributed OFF data is tracked as a pre-public-launch item, not a Phase 3 blocker
   (mirrors Phase 2's wger CC-BY-SA handling).
2. **CORE-11 overlap handling — soft, non-blocking advisory (§4.3).** When a manual burn
   overlaps a tracked workout, the app **warns but never blocks** — both entries still count
   (additive), and the user can override. No hard block, no auto-merge, no silent suppression.
   `ui-ux-designer` owns the advisory copy/interaction.
3. **Nutrition consent — no dedicated gate on logging (§6).** Food/water/manual-burn logging is
   treated as ordinary core-product app data — **no** new `nutrition` consent category and
   **no** per-write consent trigger. The **only** consent gate in Module B is on **bodyweight-
   reading energy estimation** (the `estimated` manual-burn source, §1.8), which stays behind
   the existing Phase 2 **`health`** consent exactly like Module A/C energy estimation. The
   `consent_category` enum is unchanged by Module B. The privacy policy must still specifically
   cover dietary data (a legal, pre-launch item).
4. **Nutrition sharing — share-capable, private-by-default (§1.5/§6).** `food_log_entry` is
   treated like most app data: shareable via the spine's `visibility` with a fail-closed
   **private default** and explicit per-event opt-in. It is **NOT** added to the spine's
   never-shareable set (unlike bodyweight/measurements/photos). Nothing leaks without an explicit
   widen.
5. **Macro/calorie goal-setting & targets — OUT of Phase 3 scope (§11).** Phase 3 ships
   **logging + the reconciliation reads only** (`get_daily_energy_balance_v1` /
   `get_daily_macros_v1` return actuals). The daily **target** a user logs against, and AI-12's
   auto-adjustment of it, are a separate later scope — **no `nutrition_goals` table is built
   now**. `db-engineer`/`backend-builder` do not build goal storage in this phase.
6. **Barcode-miss contribution back to OFF — OUT of Phase 3 scope (§2.4).** A barcode miss only
   ever creates a **local `custom_foods` row** (creatable offline; a re-scan resolves to it).
   User-created foods are **not** contributed back upstream to Open Food Facts in Phase 3 —
   flagged so it isn't built accidentally.

**Implementation-level items for `db-engineer` to resolve during build (NOT open architecture
questions — the same latitude as the `muscle_group` enum call in Phase 2):**

- **Water grain (§1.7):** per-drink-event is the architect recommendation (consistent with the
  spine's point-in-time model + editable history); `db-engineer` may confirm it or adopt a
  daily-total grain if implementation surfaces a reason — a documented judgment call, not a
  person-decision.
- **Enum value lists (§1.1/§1.2/§1.5):** the `nutrient_kind` / `meal_type` / `food_source`
  starter sets here are proposals; `db-engineer` finalizes the concrete launch lists, add-only,
  exactly as `muscle_group` was resolved in Phase 2.
- **`custom_foods` serving richness (§1.4):** a single `default_serving_g_or_ml` is recommended
  for Phase 3; `db-engineer` may add a `custom_food_servings` child later if needed.
- **Micronutrient snapshotting onto `food_log_items` (§1.2/§3):** recommend none (macros +
  energy only); `db-engineer` revisits only if a concrete consumer needs a frozen micro.

**Inherited-open, do not block Phase 3** (unchanged from Phase 0): launch jurisdiction (governs
`user_consents` semantics + the dietary-data privacy-policy language; GDPR-baseline default
stands), the post-deletion retention window, and the open-data license sign-offs (legal calls
before public launch).

---

## 13. UI-surface note (sequencing)

Module B has **major real UI surfaces**: the food search + log screen (CORE-06/08 — a
top-frequency, fast-path screen; logging speed is a churn driver, like Module C's set-logging),
the **barcode scan flow with the camera consent prompt at point of use** (CORE-07, §10), the
macro dashboard (CORE-08 — the day's protein/carb/fat vs. goal, and the CORE-11 net-energy
surface that shows tracked-vs-manual burn provenance, §4), the water tracker (CORE-09), the
saved-meal builder + one-tap re-log (CORE-10), and manual-burn logging with the overlap
advisory (CORE-11, §4.3). Per the standing rule (Phase 0 §13) that a screen must not be built
against no design decision: **`ui-ux-designer` runs before `mobile-builder`** on these. This
doc owns the data model and API/RLS contract; it does **not** own the screen-level visual/UX
design — the log-flow ergonomics (biggest retention lever here), the barcode-scan-and-miss
flow, the macro-ring/dashboard design, the confirm-prompt for low-`data_quality` entries
(§6), the CORE-11 soft, non-blocking overlap-advisory copy/interaction (§4.3, §12 decision 2), and the camera
consent-at-point-of-use prompt are `ui-ux-designer`'s to design first.

Implementation routing for the build: `db-engineer` (all §1 tables + RLS + column-scoped
grants per §8.1 + the reference-table schema and seed hook + the seam/consent triggers + the
`foods` search index with the search RPC), `backend-builder` (`save_food_log_entry_v1`,
`search_foods_v1`, `resolve_barcode_v1`, `log_saved_meal_v1`, the daily-balance/macros
aggregate RPCs, the FDC+OFF ingestion job §2.1, the offline-cache delta endpoint §2.4),
`mobile-builder` (offline food-logging engine + barcode scanner native module + the bounded
offline food cache + local-store extension §9 + background sync), `ui-ux-designer` (the
surfaces above, first).
