-- =============================================================================
-- Phase 3 — Module B: food_nutrients (extended micronutrients, child of foods)
-- Design ref: docs/architecture/phase-3-module-b.md §1.2, §8
--
-- EAV child keyed by an add-only enum -- the exact body_measurement_values
-- precedent (Phase 2): a variable, sparse set of measured values without wide
-- sparse columns or schema churn per new nutrient. The four always-displayed
-- macros (energy/protein/carb/fat) stay typed on `foods` itself (§1.1); the
-- long tail lives here.
--
-- No client route reads this table in Phase 3 -- neither search_foods_v1 nor
-- resolve_barcode_v1 return extended micronutrients (§1.2: "not snapshotted
-- onto log items by default... re-derivable via the food_id FK"), and no
-- "full nutrition label" detail screen is built this phase. Zero grants to
-- authenticated/anon, same posture and same reasoning as `foods` itself (see
-- that migration's header) -- when a future consumer needs bounded
-- per-food micronutrient reads, it should be a dedicated RPC (or a narrowly
-- filtered-select grant scoped to food_id), not a blanket table grant added
-- as an afterthought.
--
-- ROLLBACK: see supabase/migrations/rollbacks/20260722100100_create_food_nutrients.sql
-- =============================================================================

-- db-engineer judgment call (§12: "db-engineer finalizes the concrete launch
-- lists, add-only, exactly as muscle_group was resolved in Phase 2"). Starts
-- with the standard US Nutrition-Facts label-panel set per §1.2's guidance
-- ("Start with the label-panel set; extend by migration as AI-09/analytics
-- need more"). `µg` is spelled `mcg` in the `unit` CHECK below (ASCII-safe
-- across tooling) rather than the doc's literal `µg` -- a naming choice, not
-- a semantic difference; flagged in the task report.
create type public.nutrient_kind as enum (
  'fiber_g', 'sugar_g', 'added_sugar_g', 'saturated_fat_g', 'trans_fat_g',
  'sodium_mg', 'cholesterol_mg', 'potassium_mg', 'calcium_mg', 'iron_mg',
  'vitamin_d_mcg', 'vitamin_c_mg'
);

comment on type public.nutrient_kind is
  'Add-only enum, db-engineer-finalized launch list (§1.2/§12) -- extend by '
  'migration as new label-panel or analytics needs arise.';

create table public.food_nutrients (
  id             uuid primary key default gen_random_uuid(),

  food_id        uuid not null references public.foods (id) on delete cascade,

  nutrient_kind  public.nutrient_kind not null,
  amount         numeric not null
    constraint food_nutrients_amount_non_negative_chk check (amount >= 0),
  unit           text not null
    constraint food_nutrients_unit_chk check (unit in ('g', 'mg', 'mcg')),

  constraint uq_food_nutrients_food_kind unique (food_id, nutrient_kind)
);

comment on table public.food_nutrients is
  'CORE-06 extended micronutrients (§1.2), per the parent foods.basis. Not '
  'snapshotted onto food_log_items by default -- re-derivable via food_id FK. '
  'No client GRANT exists on this table in Phase 3 (see migration header).';
comment on column public.food_nutrients.unit is
  'g|mg|mcg, matches the nutrient_kind suffix; kept explicit for display '
  'rather than inferred from the enum name.';

-- No separate index needed for "load this food's nutrients" -- the leading
-- column of uq_food_nutrients_food_kind already covers a food_id-only lookup
-- (leftmost-column rule), matching body_measurement_values' precedent.

-- -----------------------------------------------------------------------------
-- RLS (§8): enabled in this same migration. Same posture as `foods` -- see
-- that migration's header for the full reasoning. Policy present for
-- defense-in-depth/documentation; currently unreachable (no grant exists).
-- Writes: service-role only (the ingestion job), which bypasses RLS/ACL.
-- -----------------------------------------------------------------------------
alter table public.food_nutrients enable row level security;

create policy food_nutrients_select_active
  on public.food_nutrients
  for select
  to authenticated
  using (
    exists (
      select 1 from public.foods f
      where f.id = food_nutrients.food_id and f.is_active
    )
  );

-- No grant statement here, by design -- see migration header.
