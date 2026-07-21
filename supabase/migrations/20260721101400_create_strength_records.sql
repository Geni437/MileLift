-- =============================================================================
-- Phase 2 — Module C: strength_records (cached current-best per metric)
-- Design ref: docs/architecture/phase-2-module-c.md §1.10, §4.1-4.3, §8
--
-- Mirrors Module A's personal_records exactly (20260719133600): one row per
-- (user_id, exercise_ref, metric) -- the composite "PK" is what makes PR
-- detection O(#metrics) indexed point lookups (§4.3) instead of a full-
-- history scan. Maintained by the (backend-builder-owned) save_workout_
-- session_v1 RPC.
--
-- Implementation note (db-engineer judgment call, flagged in the task
-- report): the doc describes the key as "(user_id, exercise_ref, metric)"
-- where exercise_ref is exercise_id OR custom_exercise_id (exactly one).
-- Postgres cannot express a composite PRIMARY KEY across two columns where
-- exactly one is always NULL (PK columns must be NOT NULL). This migration
-- uses a surrogate `id` PK plus two partial UNIQUE indexes -- one per ref
-- column, each `WHERE <col> IS NOT NULL` -- which together enforce the
-- doc's intended composite-unique constraint and support
-- `ON CONFLICT (user_id, exercise_id, metric) WHERE exercise_id IS NOT NULL`
-- / the custom_exercise_id equivalent in the save RPC's upsert, the standard
-- Postgres pattern for "unique together, modulo an either/or nullable FK."
--
-- ROLLBACK: see supabase/migrations/rollbacks/20260721101400_create_strength_records.sql
-- =============================================================================

create type public.strength_pr_metric as enum (
  'heaviest_weight', 'estimated_1rm', 'best_set_volume', 'max_reps',
  -- Reserved for a future weight-specific rep PR (§1.10) and the deferred
  -- time-based "longest hold" metric (§4.1) -- add-only room, mirroring
  -- Module A's activity_pr_metric precedent of reserving unimplemented
  -- future values up front (db-engineer judgment call, flagged in the task
  -- report: neither is computed/consumed in Phase 2).
  'rep_pr_at_weight', 'longest_hold'
);

comment on type public.strength_pr_metric is
  'PR metric keyed off exercise/custom_exercise field-set flags (§4.1). '
  'rep_pr_at_weight/longest_hold are reserved, not computed in Phase 2. '
  'Add-only enum.';

create table public.strength_records (
  id                  uuid primary key default gen_random_uuid(),

  user_id             uuid not null references public.profiles (id) on delete cascade,

  exercise_id         uuid references public.exercises (id),
  custom_exercise_id  uuid references public.custom_exercises (id),

  metric              public.strength_pr_metric not null,

  value               numeric not null
    constraint strength_records_value_non_negative_chk check (value >= 0),
  unit_snapshot       text,

  source_set_log_id   uuid not null references public.workout_set_logs (id) on delete cascade,
  timeline_event_id   uuid not null references public.timeline_events (id) on delete cascade,

  achieved_at         timestamptz not null,
  previous_value      numeric
    constraint strength_records_previous_value_non_negative_chk check (previous_value is null or previous_value >= 0),

  created_at          timestamptz not null default now(),
  updated_at          timestamptz not null default now(),

  constraint strength_records_exactly_one_exercise_ref_chk check (
    (exercise_id is not null)::int + (custom_exercise_id is not null)::int = 1
  )
);

comment on table public.strength_records is
  'Cached "current best" per (user_id, exercise_ref, metric), per §4.3. See '
  'migration header for the partial-unique-index implementation of the '
  'doc''s composite key. ON DELETE CASCADE on source_set_log_id/'
  'timeline_event_id per §7 -- recomputing the new record holder (if any) '
  'after such a deletion is the save/recompute RPC''s job (backend-builder), '
  'not this migration''s.';
comment on column public.strength_records.previous_value is
  'What this PR beat, for "new PR (+X)" display. NULL if this is the first '
  'recorded value for this (user, exercise_ref, metric).';

-- The two partial unique indexes ARE the O(#metrics) point-lookup index PR
-- detection depends on (§4.3) -- this is the composite key the doc describes,
-- split across exercise_id/custom_exercise_id (see migration header).
create unique index uq_strength_records_user_exercise_metric
  on public.strength_records (user_id, exercise_id, metric)
  where exercise_id is not null;

create unique index uq_strength_records_user_custom_exercise_metric
  on public.strength_records (user_id, custom_exercise_id, metric)
  where custom_exercise_id is not null;

-- -----------------------------------------------------------------------------
-- Seam-integrity trigger, mirroring
-- enforce_personal_records_user_id_matches_spine (Phase 1).
-- -----------------------------------------------------------------------------
create or replace function public.enforce_strength_records_user_id_matches_spine()
returns trigger
language plpgsql
security invoker
set search_path = public, pg_temp
as $$
declare
  v_spine_user_id uuid;
begin
  select user_id into v_spine_user_id
    from public.timeline_events
    where id = new.timeline_event_id;

  if v_spine_user_id is null then
    raise exception
      'strength_records write rejected: no timeline_events row found for id %',
      new.timeline_event_id
      using errcode = '23503';
  end if;

  if v_spine_user_id <> new.user_id then
    raise exception
      'strength_records.user_id (%) does not match timeline_events.user_id (%) for event %',
      new.user_id, v_spine_user_id, new.timeline_event_id
      using errcode = '42501';
  end if;

  return new;
end;
$$;

comment on function public.enforce_strength_records_user_id_matches_spine() is
  'Trigger: user_id must match the record-holding event''s user_id.';

revoke execute on function public.enforce_strength_records_user_id_matches_spine() from public, anon, authenticated;

create trigger trg_strength_records_enforce_integrity
  before insert or update on public.strength_records
  for each row
  execute function public.enforce_strength_records_user_id_matches_spine();

create trigger trg_strength_records_set_updated_at
  before update on public.strength_records
  for each row
  execute function public.set_updated_at();

create trigger trg_strength_records_force_insert_audit_timestamps
  before insert on public.strength_records
  for each row
  execute function public.force_insert_audit_timestamps();

-- -----------------------------------------------------------------------------
-- RLS (§8): owner-only in Phase 2 (cross-user "PRs on a public profile" is a
-- Phase 4 community concern -- defer widening, same fail-closed posture as
-- Module A). Real owner DELETE granted -- same narrow, reasoned exception as
-- personal_records: this is a maintained *cache* (the immutable historical
-- facts live in strength_achievements, which has no DELETE at all), and the
-- recompute path needs to remove a cache row when no set of that
-- (exercise_ref, metric) remains.
-- -----------------------------------------------------------------------------
alter table public.strength_records enable row level security;

create policy strength_records_select_own
  on public.strength_records
  for select
  to authenticated
  using (user_id = auth.uid());

create policy strength_records_insert_own
  on public.strength_records
  for insert
  to authenticated
  with check (user_id = auth.uid());

create policy strength_records_update_own
  on public.strength_records
  for update
  to authenticated
  using (user_id = auth.uid())
  with check (user_id = auth.uid());

create policy strength_records_delete_own
  on public.strength_records
  for delete
  to authenticated
  using (user_id = auth.uid());

grant select, insert, delete on public.strength_records to authenticated;
-- Column-scoped UPDATE excluding the identity-forming columns
-- (id/user_id/exercise_id/custom_exercise_id/metric/created_at).
grant update (value, unit_snapshot, source_set_log_id, achieved_at, previous_value)
  on public.strength_records to authenticated;
