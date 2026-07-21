-- =============================================================================
-- Phase 2 — Module C: program_workouts (CORE-14 program-to-template slots)
-- Design ref: docs/architecture/phase-2-module-c.md §1.8, §8
--
-- Ties a workout_templates row into a programs row at a schedule slot. Same
-- "live plan, real DELETE" reasoning as workout_template_exercises (§1.8
-- lists no deleted_at for this table) -- see that migration's header.
--
-- ROLLBACK: see supabase/migrations/rollbacks/20260721100700_create_program_workouts.sql
-- =============================================================================

create table public.program_workouts (
  id             uuid primary key default gen_random_uuid(),

  program_id     uuid not null references public.programs (id) on delete cascade,
  -- Denormalized for RLS; consistency with programs.user_id enforced by the
  -- trigger below.
  user_id        uuid not null references public.profiles (id) on delete cascade,

  -- If the template is deleted, its scheduled slot in the program no longer
  -- has content to run -- CASCADE, unlike workout_sessions.source_template_id
  -- (which is SET NULL specifically to preserve *historical* session
  -- render). This row is a live schedule association, not history (§1.8),
  -- so CASCADE is the correct behavior here (db-engineer judgment call,
  -- flagged in the task report -- the doc does not state the ON DELETE
  -- behavior for this FK explicitly).
  template_id    uuid not null references public.workout_templates (id) on delete cascade,

  week_number    integer
    constraint program_workouts_week_number_positive_chk check (week_number is null or week_number >= 1),
  day_number     integer
    constraint program_workouts_day_number_positive_chk check (day_number is null or day_number >= 1),
  sort_order     integer not null default 0,

  created_at     timestamptz not null default now(),
  updated_at     timestamptz not null default now()
);

comment on table public.program_workouts is
  'CORE-14 program-to-template schedule slot (§1.8). Builder data model only '
  '-- calendar scheduling/auto-progression is a later engine (§11).';

-- "Load this program's workouts in order" -- the dominant builder read (§1.8).
create index idx_program_workouts_program_sort
  on public.program_workouts (program_id, sort_order);

-- FK used in joins ("which programs reference this template" -- e.g. before
-- allowing/warning on template deletion), per db-schema-standards.
create index idx_program_workouts_template
  on public.program_workouts (template_id);

-- -----------------------------------------------------------------------------
-- Seam-integrity trigger: user_id must match the parent programs row's
-- user_id, mirroring workout_template_exercises.
-- -----------------------------------------------------------------------------
create or replace function public.enforce_program_workouts_integrity()
returns trigger
language plpgsql
security invoker
set search_path = public, pg_temp
as $$
declare
  v_program_user_id uuid;
begin
  select user_id into v_program_user_id
    from public.programs
    where id = new.program_id;

  if v_program_user_id is null then
    raise exception
      'program_workouts write rejected: no programs row found for id %',
      new.program_id
      using errcode = '23503';
  end if;

  if v_program_user_id <> new.user_id then
    raise exception
      'program_workouts.user_id (%) does not match programs.user_id (%) for program %',
      new.user_id, v_program_user_id, new.program_id
      using errcode = '42501';
  end if;

  return new;
end;
$$;

comment on function public.enforce_program_workouts_integrity() is
  'Trigger: user_id must match the parent programs row''s user_id (§1.8/§8).';

revoke execute on function public.enforce_program_workouts_integrity() from public, anon, authenticated;

create trigger trg_program_workouts_enforce_integrity
  before insert or update on public.program_workouts
  for each row
  execute function public.enforce_program_workouts_integrity();

create trigger trg_program_workouts_set_updated_at
  before update on public.program_workouts
  for each row
  execute function public.set_updated_at();

create trigger trg_program_workouts_force_insert_audit_timestamps
  before insert on public.program_workouts
  for each row
  execute function public.force_insert_audit_timestamps();

-- -----------------------------------------------------------------------------
-- RLS (§8): owner-only via denormalized user_id. Full SELECT/INSERT/UPDATE/
-- DELETE -- same narrow, reasoned exception as workout_template_exercises.
-- -----------------------------------------------------------------------------
alter table public.program_workouts enable row level security;

create policy program_workouts_select_own
  on public.program_workouts
  for select
  to authenticated
  using (user_id = auth.uid());

create policy program_workouts_insert_own
  on public.program_workouts
  for insert
  to authenticated
  with check (user_id = auth.uid());

create policy program_workouts_update_own
  on public.program_workouts
  for update
  to authenticated
  using (user_id = auth.uid())
  with check (user_id = auth.uid());

create policy program_workouts_delete_own
  on public.program_workouts
  for delete
  to authenticated
  using (user_id = auth.uid());

grant select, insert, delete on public.program_workouts to authenticated;
-- Column-scoped UPDATE excluding id/program_id/user_id (identity columns).
-- template_id is excluded too -- re-pointing a slot at a different template
-- is modeled as delete + re-insert, same rationale as workout_template_exercises.
grant update (week_number, day_number, sort_order) on public.program_workouts to authenticated;
