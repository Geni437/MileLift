-- =============================================================================
-- Phase 1 — Module A: activity_details (CORE-01/02 subtype, 1:1 with the spine)
-- Design ref: docs/architecture/phase-1-module-a.md §1.2, §1.3, §6, §8
--
-- Shared PK = timeline_event_id (1:1 FK to timeline_events.id), per the
-- Phase 0 §1.5 supertype/subtype seam. Covers event_type = 'gps_activity' for
-- all activities — GPS-recorded, manual, and wearable-imported.
--
-- ROLLBACK: see supabase/migrations/rollbacks/20260719133200_create_activity_details.sql
-- =============================================================================

create type public.activity_calories_source as enum ('estimated', 'wearable', 'manual', 'none');

comment on type public.activity_calories_source is
  'Provenance of the spine''s energy_kcal for a gps_activity event (§1.2, §12 '
  'item 7). Extend by migration (add value only).';

-- -----------------------------------------------------------------------------
-- public.activity_details
-- -----------------------------------------------------------------------------
create table public.activity_details (
  timeline_event_id            uuid primary key references public.timeline_events (id) on delete cascade,

  -- Denormalized for RLS per §1.5/§8. Consistency with the spine's own
  -- user_id is enforced by the trigger below, not just the FK (a FK alone
  -- can't catch "this user_id doesn't match *this event's* owner").
  user_id                      uuid not null references public.profiles (id) on delete cascade,

  activity_type_code           text not null references public.activity_types (code),
  -- Snapshot per §1.3: editing the activity_types catalog later must never
  -- retroactively rewrite recorded history.
  activity_type_name_snapshot  text not null
    constraint activity_details_type_name_snapshot_not_blank_chk check (length(trim(activity_type_name_snapshot)) > 0),

  title                        text,
  description                  text,

  distance_m                   numeric
    constraint activity_details_distance_non_negative_chk check (distance_m is null or distance_m >= 0),
  unit_distance_snapshot       text not null
    constraint activity_details_unit_distance_snapshot_chk check (unit_distance_snapshot in ('km', 'mi')),

  moving_time_seconds          integer
    constraint activity_details_moving_time_non_negative_chk check (moving_time_seconds is null or moving_time_seconds >= 0),

  elevation_gain_m             numeric
    constraint activity_details_elevation_gain_non_negative_chk check (elevation_gain_m is null or elevation_gain_m >= 0),
  elevation_loss_m             numeric
    constraint activity_details_elevation_loss_non_negative_chk check (elevation_loss_m is null or elevation_loss_m >= 0),

  average_speed_mps            numeric
    constraint activity_details_average_speed_non_negative_chk check (average_speed_mps is null or average_speed_mps >= 0),
  max_speed_mps                numeric
    constraint activity_details_max_speed_non_negative_chk check (max_speed_mps is null or max_speed_mps >= 0),

  -- Health-sensitive (§6). From wearable only. Storing the derived
  -- avg/max summary (not a raw HR stream) satisfies minimization.
  average_hr                   numeric
    constraint activity_details_average_hr_range_chk check (average_hr is null or (average_hr >= 20 and average_hr <= 260)),
  max_hr                       numeric
    constraint activity_details_max_hr_range_chk check (max_hr is null or (max_hr >= 20 and max_hr <= 260)),

  has_gps_route                boolean not null default false,

  calories_source               public.activity_calories_source not null default 'none',

  created_at                   timestamptz not null default now(),
  updated_at                   timestamptz not null default now()
);

comment on table public.activity_details is
  'CORE-01/02 activity subtype, 1:1 with timeline_events (shared PK). Covers '
  'GPS-recorded, manual, and wearable-imported activities alike (§1.2).';
comment on column public.activity_details.average_speed_mps is
  'Meters/second. Pace is derived on display from this + unit_distance_snapshot '
  '-- do not also store pace (redundant, drift risk).';
comment on column public.activity_details.average_hr is
  'Health-sensitive (§6). Gated by the enforce_activity_details_integrity '
  'trigger below: rejected unless an active health-category consent exists.';

-- Recompute_prs_for_user_v1's bounded MAX/MIN aggregate is grouped by
-- (user_id, activity_type_code) per §4.3; the same composite also serves "my
-- activities of type X" reads and covers user_id-only queries via the
-- leftmost-column rule, so no separate plain user_id index is added.
create index idx_activity_details_user_type
  on public.activity_details (user_id, activity_type_code);

-- -----------------------------------------------------------------------------
-- Seam-integrity + consent-gating trigger.
--
-- Three checks, all at the DB layer per db-schema-standards ("constraints in
-- the database, not only app code") and production-standards (never trust
-- client input):
--   1. user_id must match the referenced timeline_events row's user_id
--      (Phase 0 §1.5: "enforce with a trigger/insert rule so it can't diverge").
--   2. moving_time_seconds must not exceed the spine's duration_seconds when
--      both are present (§1.2's CHECK note -- implemented as a trigger, not a
--      table CHECK, because it must read another table).
--   3. average_hr/max_hr presence requires an active 'health' consent row,
--      reusing the exact enforce_health_consent() pattern from
--      20260718210837_create_profile_health.sql (§6).
-- -----------------------------------------------------------------------------
create or replace function public.enforce_activity_details_integrity()
returns trigger
language plpgsql
security invoker
set search_path = public, pg_temp
as $$
declare
  v_spine_user_id           uuid;
  v_spine_duration_seconds  integer;
begin
  select user_id, duration_seconds
    into v_spine_user_id, v_spine_duration_seconds
    from public.timeline_events
    where id = new.timeline_event_id;

  if v_spine_user_id is null then
    raise exception
      'activity_details write rejected: no timeline_events row found for id %',
      new.timeline_event_id
      using errcode = '23503'; -- foreign_key_violation (defensive; the FK already guards this)
  end if;

  if v_spine_user_id <> new.user_id then
    raise exception
      'activity_details.user_id (%) does not match timeline_events.user_id (%) for event %',
      new.user_id, v_spine_user_id, new.timeline_event_id
      using errcode = '42501'; -- insufficient_privilege
  end if;

  if new.moving_time_seconds is not null
     and v_spine_duration_seconds is not null
     and new.moving_time_seconds > v_spine_duration_seconds then
    raise exception
      'activity_details.moving_time_seconds (%) exceeds timeline_events.duration_seconds (%) for event % (MOVING_TIME_EXCEEDS_ELAPSED)',
      new.moving_time_seconds, v_spine_duration_seconds, new.timeline_event_id
      using errcode = '22023'; -- invalid_parameter_value
  end if;

  if (new.average_hr is not null or new.max_hr is not null) and not exists (
    select 1
    from public.user_consents
    where user_id = new.user_id
      and category = 'health'
      and revoked_at is null
  ) then
    raise exception
      'activity_details write rejected: average_hr/max_hr present but no active health-category consent on file for user %',
      new.user_id
      using errcode = '42501';
  end if;

  return new;
end;
$$;

comment on function public.enforce_activity_details_integrity() is
  'Trigger: (1) user_id must match the spine event''s user_id, (2) '
  'moving_time_seconds <= spine duration_seconds when both present, (3) '
  'average_hr/max_hr require an active health consent row. §1.2/§6.';

revoke execute on function public.enforce_activity_details_integrity() from public, anon, authenticated;

create trigger trg_activity_details_enforce_integrity
  before insert or update on public.activity_details
  for each row
  execute function public.enforce_activity_details_integrity();

create trigger trg_activity_details_set_updated_at
  before update on public.activity_details
  for each row
  execute function public.set_updated_at();

create trigger trg_activity_details_force_insert_audit_timestamps
  before insert on public.activity_details
  for each row
  execute function public.force_insert_audit_timestamps();

-- -----------------------------------------------------------------------------
-- RLS (§8): owner-only via denormalized user_id = auth.uid(). SELECT/INSERT/
-- UPDATE; no client DELETE (deletion is soft-delete on the parent spine row +
-- cascade at hard-purge, mirroring timeline_events).
-- -----------------------------------------------------------------------------
alter table public.activity_details enable row level security;

create policy activity_details_select_own
  on public.activity_details
  for select
  to authenticated
  using (user_id = auth.uid());

create policy activity_details_insert_own
  on public.activity_details
  for insert
  to authenticated
  with check (user_id = auth.uid());

create policy activity_details_update_own
  on public.activity_details
  for update
  to authenticated
  using (user_id = auth.uid())
  with check (user_id = auth.uid());

grant select, insert on public.activity_details to authenticated;
-- Column-scoped UPDATE excluding timeline_event_id/user_id (immutable
-- identity/ownership columns) per §8.
grant update (
  activity_type_code, activity_type_name_snapshot, title, description,
  distance_m, unit_distance_snapshot, moving_time_seconds,
  elevation_gain_m, elevation_loss_m, average_speed_mps, max_speed_mps,
  average_hr, max_hr, has_gps_route, calories_source
) on public.activity_details to authenticated;
