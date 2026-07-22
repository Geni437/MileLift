-- =============================================================================
-- Phase 3 — Module B: saved_meals (CORE-10 builder, owner-owned)
-- Design ref: docs/architecture/phase-3-module-b.md §1.10, §3, §8, §8.1
--
-- Reusable named bundle of foods a user logs in one action. Owner-owned
-- *definition*, not an event -- the workout_templates precedent exactly.
-- Owner-only RLS in Phase 3 (community recipe sharing widens this in Phase
-- 4 -- §12 decision 4, not built here to prevent scope creep). NO snapshot
-- on the definition -- a saved meal is a LIVE plan the user edits
-- deliberately (§3); the snapshot happens when a food_log_entry is logged
-- FROM it, not here.
--
-- ROLLBACK: see supabase/migrations/rollbacks/20260722100900_create_saved_meals.sql
-- =============================================================================

create table public.saved_meals (
  -- Client-generated (§1.10).
  id            uuid primary key default gen_random_uuid(),

  user_id       uuid not null references public.profiles (id) on delete cascade,

  name          text not null
    constraint saved_meals_name_not_blank_chk check (length(trim(name)) > 0),
  description   text,
  meal_type     public.meal_type,

  -- A saved meal is a live plan the user edits deliberately (§1.10) --
  -- soft-delete so a future "logged from this saved meal" provenance link
  -- could still resolve the definition's identity even after the user
  -- deletes it from their builder (mirrors workout_templates' identical
  -- reasoning, applied per the doc's explicit §8 RLS-boundary table even
  -- though no such provenance column exists on food_log_entries in Phase 3).
  deleted_at    timestamptz,

  created_at    timestamptz not null default now(),
  updated_at    timestamptz not null default now()
);

comment on table public.saved_meals is
  'CORE-10 reusable named meal definition (§1.10). Owner-owned, not a '
  'timeline event. Logging one snapshots its items into a NEW '
  'food_log_entry (§3) -- editing/deleting a saved meal never rewrites a '
  'meal already logged from it.';

-- "My saved meals" list (the builder home / quick-log surface, §1.10) --
-- owner-scoped, excluding soft-deleted rows.
create index idx_saved_meals_user
  on public.saved_meals (user_id)
  where deleted_at is null;

create trigger trg_saved_meals_set_updated_at
  before update on public.saved_meals
  for each row
  execute function public.set_updated_at();

create trigger trg_saved_meals_force_insert_audit_timestamps
  before insert on public.saved_meals
  for each row
  execute function public.force_insert_audit_timestamps();

-- -----------------------------------------------------------------------------
-- RLS (§8): owner-only, SELECT/INSERT/UPDATE; no client DELETE (soft-delete
-- via deleted_at, mirroring workout_templates).
-- -----------------------------------------------------------------------------
alter table public.saved_meals enable row level security;

create policy saved_meals_select_own
  on public.saved_meals
  for select
  to authenticated
  using (user_id = auth.uid());

create policy saved_meals_insert_own
  on public.saved_meals
  for insert
  to authenticated
  with check (user_id = auth.uid());

create policy saved_meals_update_own
  on public.saved_meals
  for update
  to authenticated
  using (user_id = auth.uid())
  with check (user_id = auth.uid());

grant select, insert on public.saved_meals to authenticated;

-- -----------------------------------------------------------------------------
-- Column-scoped UPDATE grant (§8.1 -- see food_log_items' migration header
-- for the full recurring-lesson warning; not repeated verbatim here).
--
--   MUTABLE   (client UPDATE granted, the "plan fields" per §8.1): name,
--     description, meal_type, deleted_at.
--   IMMUTABLE (excluded): id, user_id, created_at.
-- -----------------------------------------------------------------------------
grant update (name, description, meal_type, deleted_at) on public.saved_meals to authenticated;

-- CORRECTED GUIDANCE, LIVE-PROVEN (see
-- 20260722999999_revert_custom_foods_diagnostic_grant.sql for the full
-- account): restricting an .upsert() payload to mutable columns is
-- NECESSARY but NOT SUFFICIENT -- PostgREST's .upsert() always includes the
-- conflict-target column (id) in its SET list, which has no UPDATE grant
-- here. Editing an existing row MUST use a plain
-- .update({...mutableCols}).eq('id', x) -- never .upsert().
