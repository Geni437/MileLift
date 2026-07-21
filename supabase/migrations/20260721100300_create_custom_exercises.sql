-- =============================================================================
-- Phase 2 — Module C: custom_exercises (user-created movements)
-- Design ref: docs/architecture/phase-2-module-c.md §1.3, §8
--
-- A user's own movement not in the library -- owner-owned *definition*, NOT
-- an event (Phase 0 §1.1). Owner-only RLS. A workout_set_logs row references
-- either exercise_id or custom_exercise_id (exactly one, enforced by CHECK on
-- that table) and snapshots the name either way (§3).
--
-- ROLLBACK: see supabase/migrations/rollbacks/20260721100300_create_custom_exercises.sql
-- =============================================================================

create table public.custom_exercises (
  -- Client-generated -- can be created offline (§1.3).
  id                  uuid primary key default gen_random_uuid(),

  user_id             uuid not null references public.profiles (id) on delete cascade,

  name                text not null
    constraint custom_exercises_name_not_blank_chk check (length(trim(name)) > 0),

  primary_muscle      public.muscle_group,
  equipment           public.equipment_type,

  -- Same field-set drivers as library exercises (§1.1/§1.3). At least one
  -- must be true, mirroring exercises' invariant (db-engineer judgment call,
  -- flagged in the task report).
  is_weighted         boolean not null default false,
  is_bodyweight       boolean not null default false,
  is_time_based       boolean not null default false,
  is_distance_based   boolean not null default false,

  notes               text,

  -- Soft-delete: a set may still snapshot-reference this historically (§1.3).
  deleted_at          timestamptz,

  created_at          timestamptz not null default now(),
  updated_at          timestamptz not null default now(),

  constraint custom_exercises_field_set_chk check (
    is_distance_based or is_time_based or is_weighted or is_bodyweight
  )
);

comment on table public.custom_exercises is
  'CORE-14 user-created movement not in the library (§1.3). Owner-owned '
  'definition, not a timeline event. workout_set_logs/workout_template_'
  'exercises snapshot the name at reference time (§3), so soft-deleting a '
  'custom exercise never breaks a historical set''s render.';
comment on column public.custom_exercises.deleted_at is
  'Soft-delete tombstone. A set/template row may still reference this via FK '
  'historically -- the FK has no ON DELETE behavior configured here because '
  'this row is never hard-deleted by the client (only soft-deleted), and the '
  'account-hard-purge job removes it via the profiles ON DELETE CASCADE '
  'along with everything else the user owns.';

-- "My custom exercises" list/search (the builder + logging-screen exercise
-- picker, §1.3) -- owner-scoped, excluding soft-deleted rows.
create index idx_custom_exercises_user
  on public.custom_exercises (user_id)
  where deleted_at is null;

create trigger trg_custom_exercises_set_updated_at
  before update on public.custom_exercises
  for each row
  execute function public.set_updated_at();

create trigger trg_custom_exercises_force_insert_audit_timestamps
  before insert on public.custom_exercises
  for each row
  execute function public.force_insert_audit_timestamps();

-- -----------------------------------------------------------------------------
-- RLS (§8): owner-only, SELECT/INSERT/UPDATE; no client DELETE (soft-delete
-- via deleted_at).
-- -----------------------------------------------------------------------------
alter table public.custom_exercises enable row level security;

create policy custom_exercises_select_own
  on public.custom_exercises
  for select
  to authenticated
  using (user_id = auth.uid());

create policy custom_exercises_insert_own
  on public.custom_exercises
  for insert
  to authenticated
  with check (user_id = auth.uid());

create policy custom_exercises_update_own
  on public.custom_exercises
  for update
  to authenticated
  using (user_id = auth.uid())
  with check (user_id = auth.uid());

grant select, insert on public.custom_exercises to authenticated;
-- Column-scoped UPDATE excluding id/user_id/created_at (immutable identity
-- columns) per §8.1's naive-upsert discipline.
grant update (
  name, primary_muscle, equipment,
  is_weighted, is_bodyweight, is_time_based, is_distance_based,
  notes, deleted_at
) on public.custom_exercises to authenticated;
