-- =============================================================================
-- Phase 2 — Module C: workout_template_exercises (CORE-14 builder child)
-- Design ref: docs/architecture/phase-2-module-c.md §1.7, §8
--
-- One row per planned movement within a workout_templates row. No snapshot
-- here -- a template is a *live* plan the user edits deliberately; the
-- snapshot happens when a *session* is logged from it (§1.7, §3).
--
-- Deletion note (db-engineer judgment call, flagged in the task report): the
-- doc lists no `deleted_at` for this table (unlike its parent
-- workout_templates, or the historical event-bearing tables elsewhere in
-- this module) -- removing a planned exercise from a template is a real
-- structural edit to a live plan, not a historical fact that must survive.
-- This table therefore gets a genuine owner DELETE policy, same reasoning
-- Phase 1 used for personal_records' narrow DELETE exception (§8 of that
-- migration).
--
-- ROLLBACK: see supabase/migrations/rollbacks/20260721100500_create_workout_template_exercises.sql
-- =============================================================================

create table public.workout_template_exercises (
  id                    uuid primary key default gen_random_uuid(),

  template_id           uuid not null references public.workout_templates (id) on delete cascade,
  -- Denormalized for RLS; consistency with workout_templates.user_id
  -- enforced by the trigger below.
  user_id               uuid not null references public.profiles (id) on delete cascade,

  exercise_id           uuid references public.exercises (id),
  custom_exercise_id    uuid references public.custom_exercises (id),

  exercise_order        integer not null
    constraint workout_template_exercises_order_non_negative_chk check (exercise_order >= 0),

  target_sets           integer
    constraint workout_template_exercises_target_sets_non_negative_chk check (target_sets is null or target_sets >= 0),
  target_reps_low        integer
    constraint workout_template_exercises_target_reps_low_non_negative_chk check (target_reps_low is null or target_reps_low >= 0),
  target_reps_high       integer
    constraint workout_template_exercises_target_reps_high_non_negative_chk check (target_reps_high is null or target_reps_high >= 0),
  target_weight_kg       numeric
    constraint workout_template_exercises_target_weight_non_negative_chk check (target_weight_kg is null or target_weight_kg >= 0),
  target_rest_seconds    integer
    constraint workout_template_exercises_target_rest_non_negative_chk check (target_rest_seconds is null or target_rest_seconds >= 0),

  notes                  text,

  created_at             timestamptz not null default now(),
  updated_at             timestamptz not null default now(),

  constraint workout_template_exercises_exactly_one_ref_chk check (
    (exercise_id is not null)::int + (custom_exercise_id is not null)::int = 1
  ),
  constraint workout_template_exercises_reps_range_chk check (
    target_reps_low is null or target_reps_high is null or target_reps_low <= target_reps_high
  )
);

comment on table public.workout_template_exercises is
  'CORE-14 planned-movement child row of workout_templates (§1.7). Exactly '
  'one of exercise_id/custom_exercise_id per row. No snapshot columns -- a '
  'template is a live, user-edited plan (§3).';

-- "Load this template's exercises in order" -- the dominant builder/logging-
-- from-template read (§1.7). Leftmost column also serves a template_id-only
-- lookup.
create index idx_workout_template_exercises_template_order
  on public.workout_template_exercises (template_id, exercise_order);

-- -----------------------------------------------------------------------------
-- Seam-integrity trigger: user_id must match the parent workout_templates
-- row's user_id, mirroring enforce_activity_routes_integrity (Phase 1).
-- exactly-one-exercise-ref is enforced by the CHECK above (cheaper than a
-- trigger, needs no other-table lookup).
-- -----------------------------------------------------------------------------
create or replace function public.enforce_workout_template_exercises_integrity()
returns trigger
language plpgsql
security invoker
set search_path = public, pg_temp
as $$
declare
  v_template_user_id uuid;
begin
  select user_id into v_template_user_id
    from public.workout_templates
    where id = new.template_id;

  if v_template_user_id is null then
    raise exception
      'workout_template_exercises write rejected: no workout_templates row found for id %',
      new.template_id
      using errcode = '23503';
  end if;

  if v_template_user_id <> new.user_id then
    raise exception
      'workout_template_exercises.user_id (%) does not match workout_templates.user_id (%) for template %',
      new.user_id, v_template_user_id, new.template_id
      using errcode = '42501';
  end if;

  return new;
end;
$$;

comment on function public.enforce_workout_template_exercises_integrity() is
  'Trigger: user_id must match the parent workout_templates row''s user_id (§1.7/§8).';

revoke execute on function public.enforce_workout_template_exercises_integrity() from public, anon, authenticated;

create trigger trg_workout_template_exercises_enforce_integrity
  before insert or update on public.workout_template_exercises
  for each row
  execute function public.enforce_workout_template_exercises_integrity();

create trigger trg_workout_template_exercises_set_updated_at
  before update on public.workout_template_exercises
  for each row
  execute function public.set_updated_at();

create trigger trg_workout_template_exercises_force_insert_audit_timestamps
  before insert on public.workout_template_exercises
  for each row
  execute function public.force_insert_audit_timestamps();

-- -----------------------------------------------------------------------------
-- RLS (§8): owner-only via denormalized user_id. Full SELECT/INSERT/UPDATE/
-- DELETE -- see migration header for why DELETE is a deliberate, narrow
-- exception to this app's general no-client-DELETE default.
-- -----------------------------------------------------------------------------
alter table public.workout_template_exercises enable row level security;

create policy workout_template_exercises_select_own
  on public.workout_template_exercises
  for select
  to authenticated
  using (user_id = auth.uid());

create policy workout_template_exercises_insert_own
  on public.workout_template_exercises
  for insert
  to authenticated
  with check (user_id = auth.uid());

create policy workout_template_exercises_update_own
  on public.workout_template_exercises
  for update
  to authenticated
  using (user_id = auth.uid())
  with check (user_id = auth.uid());

create policy workout_template_exercises_delete_own
  on public.workout_template_exercises
  for delete
  to authenticated
  using (user_id = auth.uid());

grant select, insert, delete on public.workout_template_exercises to authenticated;
-- Column-scoped UPDATE excluding id/template_id/user_id (identity columns).
-- exercise_id/custom_exercise_id are intentionally excluded too -- swapping
-- which movement a planned row refers to is modeled as delete + re-insert,
-- not an in-place mutation, to keep the exactly-one-ref CHECK's intent (a
-- deliberate row identity) clean.
grant update (
  exercise_order, target_sets, target_reps_low, target_reps_high,
  target_weight_kg, target_rest_seconds, notes
) on public.workout_template_exercises to authenticated;
