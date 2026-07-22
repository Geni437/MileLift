-- =============================================================================
-- Phase 3 — Module B: foods (the global food reference database, CORE-06/07)
-- Design ref: docs/architecture/phase-3-module-b.md §1.1, §2, §8, §8.1
--
-- NOT user-owned, NOT a timeline event -- same ownership class as
-- exercises/activity_types (Phase 0 §5/§8, Phase 2's
-- 20260721100000_create_exercises.sql): global, read-mostly, service-role-
-- write. The critical difference from exercises is SIZE -- FDC is ~2M entries
-- and OFF is ~3M+ branded products, so even a curated merged subset is tens
-- to hundreds of thousands of rows, three-plus orders of magnitude above
-- exercises' ~1,400-row scale. This is the table the doc's §2 access-pattern
-- decision exists to protect against `supabase/config.toml`'s
-- `max_rows = 1000` silent-truncation bug (any unranged PostgREST
-- select() on a table this large truncates to 1000 rows with a normal 200
-- response -- no error).
--
-- ACCESS-PATTERN DECISION (resolves an either/or left open by §2.2, flagged
-- in the task report): §2.2 item 2 allows barcode lookup to be either "a
-- filtered select" directly against `foods` OR a thin `resolve_barcode_v1`
-- RPC. This migration deliberately grants **zero** table-level SELECT to
-- `authenticated`/`anon` on `foods` (see the RLS section below) and routes
-- ALL client reads -- text search AND barcode lookup -- through SECURITY
-- DEFINER RPCs (`search_foods_v1` / `resolve_barcode_v1`,
-- 20260722110100_create_food_search_index_and_rpcs.sql). A `GRANT SELECT`
-- is table-wide regardless of which filter a client happens to use today; the
-- only way to categorically foreclose a future `.select('*')` (or a
-- filter-dropping refactor) from ever silently truncating this table is to
-- never grant the PostgREST select path to it at all. This is the strictest
-- available reading of "no unbounded list grant/endpoint" (§2.2 item 3, §8)
-- and is the one this project's task explicitly calls out as the hazard to
-- guard against a fourth time.
--
-- ROLLBACK: see supabase/migrations/rollbacks/20260722100000_create_foods.sql
-- =============================================================================

-- -----------------------------------------------------------------------------
-- Enums (§1.1). Add-only per supabase-standards.
-- -----------------------------------------------------------------------------
create type public.food_source as enum ('usda_fdc', 'open_food_facts', 'milelift_authored');

comment on type public.food_source is
  'Provenance for attribution/licensing + merge precedence (§2.1). USDA '
  'FoodData Central (public domain, cited) + Open Food Facts (ODbL, '
  'attribution + share-alike) + milelift_authored (owned outright). '
  'Add-only enum.';

create type public.food_measure_basis as enum ('per_100g', 'per_100ml');

comment on type public.food_measure_basis is
  'Canonical nutrient basis (§2.3) -- resolves the "per 100g vs per serving '
  'vs per package" ambiguity at the schema level. The ingestion job converts '
  'every source''s declared basis to this canonical form once, server-side, '
  'at ingest. Add-only enum (a third basis is not anticipated, but the type '
  'is add-only per convention regardless).';

create type public.food_data_quality as enum ('high', 'medium', 'low');

comment on type public.food_data_quality is
  'nutrition-data-standards confidence signal (§1.1). FDC + internally-'
  'consistent OFF default high; sparse/inconsistent OFF defaults low. '
  'Drives the confirm-prompt confidence-escalation pattern (§6) -- a low-'
  'quality entry prompts the user to confirm rather than silently logging a '
  'possibly-wrong calorie count. Add-only enum.';

-- -----------------------------------------------------------------------------
-- public.foods
-- -----------------------------------------------------------------------------
create table public.foods (
  id              uuid primary key default gen_random_uuid(),

  source          public.food_source not null,
  source_ref      text not null
    constraint foods_source_ref_not_blank_chk check (length(trim(source_ref)) > 0),

  barcode         text
    constraint foods_barcode_not_blank_chk check (barcode is null or length(trim(barcode)) > 0),

  name            text not null
    constraint foods_name_not_blank_chk check (length(trim(name)) > 0),
  brand           text,
  category        text,

  basis           public.food_measure_basis not null,

  energy_kcal     numeric not null
    constraint foods_energy_kcal_non_negative_chk check (energy_kcal >= 0),
  protein_g       numeric
    constraint foods_protein_g_non_negative_chk check (protein_g is null or protein_g >= 0),
  carb_g          numeric
    constraint foods_carb_g_non_negative_chk check (carb_g is null or carb_g >= 0),
  fat_g           numeric
    constraint foods_fat_g_non_negative_chk check (fat_g is null or fat_g >= 0),

  data_quality    public.food_data_quality not null,

  is_active       boolean not null default true,

  attribution     text,

  created_at      timestamptz not null default now(),
  updated_at      timestamptz not null default now(),

  -- Dedup key (§2.1): stable across re-ingests so a source update upserts,
  -- never forks a duplicate -- the exercises.slug discipline.
  constraint uq_foods_source_source_ref unique (source, source_ref)
);

comment on table public.foods is
  'CORE-06/07 global food reference database (§1.1). Not user-owned, not a '
  'timeline event. Service-role-write only (the ingestion job) -- NO client '
  'GRANT of any kind exists on this table (see RLS section below); every '
  'client read goes through search_foods_v1 / resolve_barcode_v1. '
  'food_log_items/saved_meal_items snapshot the name/macros at reference '
  'time (§3) so editing/hiding this catalog never rewrites logged history.';
comment on column public.foods.basis is
  'Canonical per-100g/per-100ml nutrient basis (§2.3). food_servings child '
  'rows convert a named serving to this basis via gram_or_ml_weight.';
comment on column public.foods.energy_kcal is
  'Per basis. Typed column, not EAV (§1.1/§1.2) -- the cross-module energy '
  'currency (feeds the spine''s energy_kcal at log time via '
  'food_log_entries.total_energy_kcal), queried/displayed on every entry.';
comment on column public.foods.is_active is
  'Soft-hide a bad/duplicate/superseded entry without deleting (§1.1) -- '
  'history still resolves via FK + its own frozen snapshot regardless.';
comment on column public.foods.attribution is
  'Per-entry attribution string the source license requires be shown '
  'in-app (§2.1, §6) -- ODbL (OFF) + USDA citation. Must actually render on '
  'a nutrition sources/credits surface, not just live in this column.';

create trigger trg_foods_set_updated_at
  before update on public.foods
  for each row
  execute function public.set_updated_at();

create trigger trg_foods_force_insert_audit_timestamps
  before insert on public.foods
  for each row
  execute function public.force_insert_audit_timestamps();

-- -----------------------------------------------------------------------------
-- Indexes (db-schema-standards: tied to a named query pattern).
-- -----------------------------------------------------------------------------

-- CORE-07 barcode point lookup (resolve_barcode_v1, §2.2 item 2). Partial:
-- most FDC generic/whole foods carry no barcode. No UNIQUE constraint here --
-- merge/dedup across sources for the same real-world barcode is the
-- ingestion job's deterministic-merge-order call (§2.1: "when both cover the
-- same barcode and materially disagree, flag -- do not silently pick"), not
-- a DB-enforced uniqueness invariant.
create index idx_foods_active_barcode
  on public.foods (barcode)
  where is_active and barcode is not null;

-- Note: no name-search index (trigram/GIN) added here -- per db-schema-
-- standards ("tied to an actual query pattern, not speculative"), that index
-- is added *with* search_foods_v1 in
-- 20260722110100_create_food_search_index_and_rpcs.sql, once the concrete
-- query shape exists (§2.2 item 1).

-- -----------------------------------------------------------------------------
-- RLS (§8): enabled in this same migration, per supabase-standards.
--
-- Deliberately NO grant of SELECT/INSERT/UPDATE/DELETE to authenticated or
-- anon on this table -- see the migration header's "ACCESS-PATTERN DECISION"
-- note. The policy below documents the intended row-visibility rule (active
-- rows only) for defense-in-depth in case a grant is ever added later by a
-- future change, but it is currently unreachable: PostgREST requires the
-- underlying table-level GRANT in addition to an RLS policy (RLS is a row
-- filter on top of the grant, not a substitute for it -- see
-- 20260718210814_create_profiles.sql's own comment on this same point), and
-- no grant exists here. The service-role ingestion job bypasses RLS/ACL
-- entirely, per Supabase's service_role semantics (same posture as
-- 20260721100000_create_exercises.sql, which also grants no
-- INSERT/UPDATE/DELETE to any client role).
--
-- All client reads -- text search AND barcode lookup -- go through
-- search_foods_v1 / resolve_barcode_v1 (SECURITY DEFINER, so they can read
-- this table despite the absent GRANT; both explicitly filter is_active
-- inside the function body, since SECURITY DEFINER + table-owner exemption
-- means RLS does not filter for them either -- per supabase-standards:
-- "validate authorization explicitly inside the function body since RLS
-- won't do it for you there"). NEVER add a plain `grant select on
-- public.foods to authenticated` -- doing so reopens exactly the unranged-
-- select truncation hazard this design forecloses.
-- -----------------------------------------------------------------------------
alter table public.foods enable row level security;

create policy foods_select_active
  on public.foods
  for select
  to authenticated
  using (is_active);

-- No grant statement here, by design -- see comment block above.
