-- =============================================================================
-- Phase 1 — Module A: personal_records (cached current-best per metric)
-- Design ref: docs/architecture/phase-1-module-a.md §4.1, §4.2, §4.3, §8
--
-- One row per (user_id, activity_type_code, metric) -- the composite PK is
-- exactly what makes PR detection O(#metrics) indexed point lookups (§4.2/§4.3)
-- instead of a full-history scan.
--
-- ROLLBACK: see supabase/migrations/rollbacks/20260719133600_create_personal_records.sql
-- =============================================================================

create type public.activity_pr_metric as enum (
  'longest_distance', 'fastest_avg_pace', 'most_elevation_gain', 'longest_duration',
  -- Reserved for the deferred sub-distance "best efforts" feature (§4.1/§11)
  -- so adding them later is add-only, not a reshape.
  'fastest_1k', 'fastest_5k', 'fastest_10k'
);

comment on type public.activity_pr_metric is
  'PR metric keyed off activity_types metadata (§4.1). fastest_1k/5k/10k are '
  'reserved for the deferred sub-distance "best efforts" feature -- not '
  'computed in Phase 1. Add-only enum.';

-- -----------------------------------------------------------------------------
-- public.personal_records
-- -----------------------------------------------------------------------------
create table public.personal_records (
  user_id             uuid not null references public.profiles (id) on delete cascade,
  activity_type_code  text not null references public.activity_types (code),
  metric              public.activity_pr_metric not null,

  value               numeric not null
    constraint personal_records_value_non_negative_chk check (value >= 0),
  unit_snapshot       text,

  timeline_event_id   uuid not null references public.timeline_events (id) on delete cascade,
  achieved_at         timestamptz not null,
  previous_value      numeric
    constraint personal_records_previous_value_non_negative_chk check (previous_value is null or previous_value >= 0),

  created_at          timestamptz not null default now(),
  updated_at          timestamptz not null default now(),

  primary key (user_id, activity_type_code, metric)
);

comment on table public.personal_records is
  'Cached "current best" per (user_id, activity_type_code, metric), per §4.2. '
  'ON DELETE CASCADE on timeline_event_id per §7 ("personal_records ... '
  'referencing a deleted event cascade too"); recomputing the new record '
  'holder (if any) after such a deletion is the save/recompute RPC''s job '
  '(backend-builder, §4.3), not this migration''s.';
comment on column public.personal_records.previous_value is
  'What this PR beat, for "new PR (+X)" display. NULL if this is the first '
  'recorded value for this (user, type, metric).';

-- No additional index needed beyond the (user_id, activity_type_code, metric)
-- primary key -- that composite PK *is* the O(#metrics) point-lookup index
-- PR detection depends on (§4.3).

-- -----------------------------------------------------------------------------
-- Seam-integrity trigger.
-- -----------------------------------------------------------------------------
create or replace function public.enforce_personal_records_user_id_matches_spine()
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
      'personal_records write rejected: no timeline_events row found for id %',
      new.timeline_event_id
      using errcode = '23503';
  end if;

  if v_spine_user_id <> new.user_id then
    raise exception
      'personal_records.user_id (%) does not match timeline_events.user_id (%) for event %',
      new.user_id, v_spine_user_id, new.timeline_event_id
      using errcode = '42501';
  end if;

  return new;
end;
$$;

comment on function public.enforce_personal_records_user_id_matches_spine() is
  'Trigger: user_id must match the record-holding event''s user_id.';

revoke execute on function public.enforce_personal_records_user_id_matches_spine() from public, anon, authenticated;

create trigger trg_personal_records_enforce_integrity
  before insert or update on public.personal_records
  for each row
  execute function public.enforce_personal_records_user_id_matches_spine();

create trigger trg_personal_records_set_updated_at
  before update on public.personal_records
  for each row
  execute function public.set_updated_at();

create trigger trg_personal_records_force_insert_audit_timestamps
  before insert on public.personal_records
  for each row
  execute function public.force_insert_audit_timestamps();

-- -----------------------------------------------------------------------------
-- RLS (§8): owner-only in Phase 1. Unlike the app's general no-client-DELETE
-- default, this table gets an owner DELETE policy: personal_records is a
-- maintained *cache* of the current best (the immutable historical facts live
-- in activity_achievements, which has no DELETE at all), and the recompute
-- path (§4.3 -- "mark the affected personal_records row stale and recompute")
-- runs inside a SECURITY INVOKER RPC, i.e. as the calling user under RLS, so
-- it needs a real DELETE privilege to remove a cache row when no activity of
-- that (type, metric) remains. This is a narrow, reasoned exception, same
-- spirit as kudos' actor-only DELETE (§8.1) -- stated explicitly per Phase 0's
-- discipline of justifying every widening, not a general precedent.
-- -----------------------------------------------------------------------------
alter table public.personal_records enable row level security;

create policy personal_records_select_own
  on public.personal_records
  for select
  to authenticated
  using (user_id = auth.uid());

create policy personal_records_insert_own
  on public.personal_records
  for insert
  to authenticated
  with check (user_id = auth.uid());

create policy personal_records_update_own
  on public.personal_records
  for update
  to authenticated
  using (user_id = auth.uid())
  with check (user_id = auth.uid());

create policy personal_records_delete_own
  on public.personal_records
  for delete
  to authenticated
  using (user_id = auth.uid());

grant select, insert, delete on public.personal_records to authenticated;
-- Column-scoped UPDATE excluding the PK-forming identity columns
-- (user_id/activity_type_code/metric).
grant update (value, unit_snapshot, timeline_event_id, achieved_at, previous_value)
  on public.personal_records to authenticated;
