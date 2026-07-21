-- =============================================================================
-- Phase 2 — Module C: workout_templates (CORE-14 builder, owner-owned)
-- Design ref: docs/architecture/phase-2-module-c.md §1.7, §8, §11, §12
--
-- Reusable named workouts. Owner-owned *definition*, not an event. Owner-only
-- RLS in Phase 2 -- community-shared routines (Phase 4) widen this later
-- (§8/§11/§12: explicitly not built here, to prevent scope creep).
--
-- ROLLBACK: see supabase/migrations/rollbacks/20260721100400_create_workout_templates.sql
-- =============================================================================

create table public.workout_templates (
  -- Client-generated (§1.7).
  id            uuid primary key default gen_random_uuid(),

  user_id       uuid not null references public.profiles (id) on delete cascade,

  name          text not null
    constraint workout_templates_name_not_blank_chk check (length(trim(name)) > 0),
  description   text,

  -- A template is a live plan the user edits deliberately (§1.7) -- soft-
  -- delete so a workout_sessions.source_template_id can still resolve the
  -- template's identity even after the user deletes it from their builder.
  deleted_at    timestamptz,

  created_at    timestamptz not null default now(),
  updated_at    timestamptz not null default now()
);

comment on table public.workout_templates is
  'CORE-14 reusable named workout definition (§1.7). Owner-owned, not a '
  'timeline event. Logging a session from a template snapshots the name onto '
  'workout_sessions.template_name_snapshot (§3) -- editing/deleting a '
  'template never rewrites a session already logged from it.';

-- "My templates" list (the builder home screen, §1.7) -- owner-scoped,
-- excluding soft-deleted rows.
create index idx_workout_templates_user
  on public.workout_templates (user_id)
  where deleted_at is null;

create trigger trg_workout_templates_set_updated_at
  before update on public.workout_templates
  for each row
  execute function public.set_updated_at();

create trigger trg_workout_templates_force_insert_audit_timestamps
  before insert on public.workout_templates
  for each row
  execute function public.force_insert_audit_timestamps();

-- -----------------------------------------------------------------------------
-- RLS (§8): owner-only, SELECT/INSERT/UPDATE; no client DELETE (soft-delete
-- via deleted_at, since workout_sessions.source_template_id may still point
-- at this row for historical "logged from" display).
-- -----------------------------------------------------------------------------
alter table public.workout_templates enable row level security;

create policy workout_templates_select_own
  on public.workout_templates
  for select
  to authenticated
  using (user_id = auth.uid());

create policy workout_templates_insert_own
  on public.workout_templates
  for insert
  to authenticated
  with check (user_id = auth.uid());

create policy workout_templates_update_own
  on public.workout_templates
  for update
  to authenticated
  using (user_id = auth.uid())
  with check (user_id = auth.uid());

grant select, insert on public.workout_templates to authenticated;
grant update (name, description, deleted_at) on public.workout_templates to authenticated;
