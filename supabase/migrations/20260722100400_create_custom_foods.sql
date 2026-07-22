-- =============================================================================
-- Phase 3 — Module B: custom_foods (user-created foods, CORE-06/07)
-- Design ref: docs/architecture/phase-3-module-b.md §1.4, §2.4, §8
--
-- A food not in the reference DB (a barcode miss, §2.4, or a homemade item).
-- Owner-only RLS -- the custom_exercises precedent exactly. A food_log_item
-- references either a food_id or a custom_food_id (exactly one; CHECK on
-- that table) and snapshots the name either way (§3).
--
-- Client-generated id: creatable OFFLINE (the barcode-miss path must work
-- offline, §2.4 step 3) -- mirrors custom_exercises.
--
-- ROLLBACK: see supabase/migrations/rollbacks/20260722100400_create_custom_foods.sql
-- =============================================================================

create table public.custom_foods (
  id                         uuid primary key default gen_random_uuid(),

  user_id                    uuid not null references public.profiles (id) on delete cascade,

  barcode                    text
    constraint custom_foods_barcode_not_blank_chk check (barcode is null or length(trim(barcode)) > 0),

  name                       text not null
    constraint custom_foods_name_not_blank_chk check (length(trim(name)) > 0),
  brand                      text,

  basis                      public.food_measure_basis not null,

  energy_kcal                numeric not null
    constraint custom_foods_energy_kcal_non_negative_chk check (energy_kcal >= 0),
  protein_g                  numeric
    constraint custom_foods_protein_g_non_negative_chk check (protein_g is null or protein_g >= 0),
  carb_g                     numeric
    constraint custom_foods_carb_g_non_negative_chk check (carb_g is null or carb_g >= 0),
  fat_g                      numeric
    constraint custom_foods_fat_g_non_negative_chk check (fat_g is null or fat_g >= 0),

  -- db-engineer judgment call per §1.4/§12: a single default-serving
  -- conversion covers the manual-entry case in Phase 3; a richer
  -- custom_food_servings child table is deferred until a concrete consumer
  -- needs it.
  default_serving_g_or_ml    numeric
    constraint custom_foods_default_serving_positive_chk check (default_serving_g_or_ml is null or default_serving_g_or_ml > 0),

  notes                      text,

  -- Soft-delete: a food_log_item/saved_meal_item may still snapshot-
  -- reference this historically (§1.4).
  deleted_at                 timestamptz,

  created_at                 timestamptz not null default now(),
  updated_at                 timestamptz not null default now()
);

comment on table public.custom_foods is
  'CORE-06/07 user-created food not in the reference library (§1.4). Owner-'
  'owned definition, not a timeline event. food_log_items/saved_meal_items '
  'snapshot the name/macros at reference time (§3), so soft-deleting a '
  'custom food never breaks a historical item''s render.';
comment on column public.custom_foods.barcode is
  'Set when created from a barcode-scan miss (§2.4) -- lets a re-scan '
  'resolve to the user''s own entry rather than prompting creation again. '
  'Not unique -- a user could plausibly create more than one custom entry '
  'that happens to reference the same barcode over time (e.g. correcting a '
  'mistake); resolution to "the" entry for a re-scan is an app-layer '
  '"most recent non-deleted match" query, not a DB uniqueness invariant.';
comment on column public.custom_foods.deleted_at is
  'Soft-delete tombstone. A log item may still reference this via FK '
  'historically -- the FK has no ON DELETE behavior configured here because '
  'this row is never hard-deleted by the client (only soft-deleted); the '
  'account-hard-purge job removes it via the profiles ON DELETE CASCADE.';

-- "My custom foods" list/search (the manual-entry + barcode-miss picker,
-- §1.4) -- owner-scoped, excluding soft-deleted rows.
create index idx_custom_foods_user
  on public.custom_foods (user_id)
  where deleted_at is null;

-- CORE-07 re-scan resolution: "does a barcode miss already have a
-- user-created entry for this barcode" (§2.4 step 3) -- owner + barcode
-- scoped, excluding soft-deleted rows.
create index idx_custom_foods_user_barcode
  on public.custom_foods (user_id, barcode)
  where deleted_at is null and barcode is not null;

create trigger trg_custom_foods_set_updated_at
  before update on public.custom_foods
  for each row
  execute function public.set_updated_at();

create trigger trg_custom_foods_force_insert_audit_timestamps
  before insert on public.custom_foods
  for each row
  execute function public.force_insert_audit_timestamps();

-- -----------------------------------------------------------------------------
-- RLS (§8): owner-only, SELECT/INSERT/UPDATE; no client DELETE (soft-delete
-- via deleted_at).
-- -----------------------------------------------------------------------------
alter table public.custom_foods enable row level security;

create policy custom_foods_select_own
  on public.custom_foods
  for select
  to authenticated
  using (user_id = auth.uid());

create policy custom_foods_insert_own
  on public.custom_foods
  for insert
  to authenticated
  with check (user_id = auth.uid());

create policy custom_foods_update_own
  on public.custom_foods
  for update
  to authenticated
  using (user_id = auth.uid())
  with check (user_id = auth.uid());

grant select, insert on public.custom_foods to authenticated;

-- -----------------------------------------------------------------------------
-- Column-scoped UPDATE grant (§8.1 -- RECURRING LESSON, THIS EXACT BUG CLASS
-- HAS BROKEN user_consents + SIX Phase 2 TABLES ALREADY). A blanket client
-- `.upsert()` compiles to `INSERT ... ON CONFLICT DO UPDATE SET <every
-- payload column>`, and Postgres checks UPDATE privilege on EVERY one of
-- those columns AT PLAN TIME -- even on a brand-new row with no real
-- conflict. Any `.upsert()` against custom_foods MUST supply only the
-- mutable columns listed below (an explicit column list, never a whole-row
-- object), or it will fail to plan.
--
--   MUTABLE   (client UPDATE granted): barcode, name, brand, basis,
--     energy_kcal, protein_g, carb_g, fat_g, default_serving_g_or_ml,
--     notes, deleted_at.
--   IMMUTABLE (excluded, per §8.1 verbatim): id, user_id, created_at.
-- -----------------------------------------------------------------------------
grant update (
  barcode, name, brand, basis, energy_kcal, protein_g, carb_g, fat_g,
  default_serving_g_or_ml, notes, deleted_at
) on public.custom_foods to authenticated;

-- CORRECTED GUIDANCE (live-proven, see
-- 20260722999999_revert_custom_foods_diagnostic_grant.sql for the full
-- account): restricting an .upsert() payload to mutable columns is
-- NECESSARY but NOT SUFFICIENT. PostgREST's .upsert() always includes the
-- conflict-target column (id) in its ON CONFLICT DO UPDATE SET list
-- whenever id is present in the payload -- which it always must be, to
-- target a specific row -- so ANY .upsert() against an EXISTING row here
-- will still fail (id has no UPDATE grant, correctly). Editing an existing
-- row MUST use a plain .update({...mutableCols}).eq('id', x) -- never
-- .upsert(). A client that doesn't know whether the row exists yet should
-- attempt .insert(fullRow) and fall back to .update() on a 23505 conflict.
