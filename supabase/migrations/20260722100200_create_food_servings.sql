-- =============================================================================
-- Phase 3 — Module B: food_servings (named serving sizes, child of foods)
-- Design ref: docs/architecture/phase-3-module-b.md §1.3, §2.3, §8
--
-- The unit-normalization backbone (§2.3): one row per named portion a food
-- can be logged in, each carrying its gram/ml weight so any serving reduces
-- to the parent's canonical `basis` for macro math. Read by
-- resolve_barcode_v1 / search_foods_v1 (both SECURITY DEFINER,
-- 20260722110100_create_food_search_index_and_rpcs.sql) -- NOT directly by
-- any client grant, same posture as `foods` (see that migration's header):
-- a plain client `.select()` here without a food_id filter is exactly the
-- kind of unranged read the doc's §2.2 forecloses, at the same catalog scale
-- as `foods` itself (many servings per food, hundreds of thousands of foods).
--
-- ROLLBACK: see supabase/migrations/rollbacks/20260722100200_create_food_servings.sql
-- =============================================================================

create table public.food_servings (
  id                  uuid primary key default gen_random_uuid(),

  food_id             uuid not null references public.foods (id) on delete cascade,

  label               text not null
    constraint food_servings_label_not_blank_chk check (length(trim(label)) > 0),
  gram_or_ml_weight   numeric not null
    constraint food_servings_gram_or_ml_weight_positive_chk check (gram_or_ml_weight > 0),
  is_default          boolean not null default false,
  sort_order          integer not null default 0
);

comment on table public.food_servings is
  'CORE-06 named serving sizes (§1.3). gram_or_ml_weight converts a logged '
  '"N servings" into grams/ml, then into macros via the parent food''s '
  'basis. Every food gets at least a synthetic 100 g/100 ml default serving '
  'at ingest (§1.1) so it is always loggable. No client GRANT exists on this '
  'table in Phase 3 -- read only via search_foods_v1/resolve_barcode_v1 '
  '(see migration header).';
comment on column public.food_servings.is_default is
  'The serving pre-selected in the log UI (the OFF-declared serving, else '
  '"100 g/ml"). At most one default per food -- see the partial unique index '
  'below.';

-- "Load this food's servings in order" -- resolve_barcode_v1 / any future
-- food-detail read (§1.3).
create index idx_food_servings_food_order
  on public.food_servings (food_id, sort_order);

-- At most one is_default = true row per food (§1.3: "the serving pre-
-- selected in the log UI") -- a db-engineer data-integrity invariant not
-- verbatim from the doc, flagged in the task report.
create unique index uq_food_servings_one_default_per_food
  on public.food_servings (food_id)
  where is_default;

-- -----------------------------------------------------------------------------
-- RLS (§8): enabled in this same migration. Same posture as `foods` -- see
-- that migration's header. Policy present for defense-in-depth/
-- documentation; currently unreachable (no grant exists). Writes:
-- service-role only (the ingestion job), which bypasses RLS/ACL.
-- -----------------------------------------------------------------------------
alter table public.food_servings enable row level security;

create policy food_servings_select_active
  on public.food_servings
  for select
  to authenticated
  using (
    exists (
      select 1 from public.foods f
      where f.id = food_servings.food_id and f.is_active
    )
  );

-- No grant statement here, by design -- see migration header.
