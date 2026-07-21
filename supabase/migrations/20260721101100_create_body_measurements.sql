-- =============================================================================
-- Phase 2 — Module C: body_measurements + body_measurement_values (CORE-16)
-- Design ref: docs/architecture/phase-2-module-c.md §1.9, §6, §8
--
-- body_measurements: 1:1 with a `body_measurement` timeline event (one
-- measurement occasion). body_measurement_values: child, one row per
-- measured site (a child table, not wide sparse columns, so one weigh-in
-- captures several sites and new sites are add-only enum values, not schema
-- changes). Both health-consent-gated, forced private by the spine.
--
-- ROLLBACK: see supabase/migrations/rollbacks/20260721101100_create_body_measurements.sql
-- =============================================================================

create type public.measurement_kind as enum (
  'waist', 'chest', 'hips', 'thigh', 'biceps', 'calf', 'neck', 'shoulders', 'forearm', 'body_fat_pct'
);

comment on type public.measurement_kind is
  'Measured body site (§1.9). Add-only enum -- adding a new site is an enum '
  'value addition, not a schema change.';

-- -----------------------------------------------------------------------------
-- public.body_measurements (the occasion)
-- -----------------------------------------------------------------------------
create table public.body_measurements (
  timeline_event_id  uuid primary key references public.timeline_events (id) on delete cascade,

  user_id             uuid not null references public.profiles (id) on delete cascade,

  notes               text,

  created_at          timestamptz not null default now(),
  updated_at          timestamptz not null default now()
);

comment on table public.body_measurements is
  'CORE-16 measurement occasion, 1:1 with a body_measurement timeline event '
  '(§1.9). The actual site values live in body_measurement_values.';

create or replace function public.enforce_body_measurements_integrity()
returns trigger
language plpgsql
security invoker
set search_path = public, pg_temp
as $$
declare
  v_spine_user_id    uuid;
  v_spine_event_type public.timeline_event_type;
begin
  select user_id, event_type
    into v_spine_user_id, v_spine_event_type
    from public.timeline_events
    where id = new.timeline_event_id;

  if v_spine_user_id is null then
    raise exception
      'body_measurements write rejected: no timeline_events row found for id %',
      new.timeline_event_id
      using errcode = '23503';
  end if;

  if v_spine_user_id <> new.user_id then
    raise exception
      'body_measurements.user_id (%) does not match timeline_events.user_id (%) for event %',
      new.user_id, v_spine_user_id, new.timeline_event_id
      using errcode = '42501';
  end if;

  if v_spine_event_type <> 'body_measurement' then
    raise exception
      'body_measurements write rejected: timeline_events.event_type (%) for event % is not body_measurement',
      v_spine_event_type, new.timeline_event_id
      using errcode = '42501';
  end if;

  if not exists (
    select 1
    from public.user_consents
    where user_id = new.user_id
      and category = 'health'
      and revoked_at is null
  ) then
    raise exception
      'body_measurements write rejected: no active health-category consent on file for user % (CONSENT_REQUIRED_HEALTH)',
      new.user_id
      using errcode = '42501';
  end if;

  return new;
end;
$$;

comment on function public.enforce_body_measurements_integrity() is
  'Trigger: (1) user_id must match the spine event''s user_id, (2) event_type '
  'must be body_measurement, (3) an active health consent row is required. §1.9, §6.';

revoke execute on function public.enforce_body_measurements_integrity() from public, anon, authenticated;

create trigger trg_body_measurements_enforce_integrity
  before insert or update on public.body_measurements
  for each row
  execute function public.enforce_body_measurements_integrity();

create trigger trg_body_measurements_set_updated_at
  before update on public.body_measurements
  for each row
  execute function public.set_updated_at();

create trigger trg_body_measurements_force_insert_audit_timestamps
  before insert on public.body_measurements
  for each row
  execute function public.force_insert_audit_timestamps();

alter table public.body_measurements enable row level security;

create policy body_measurements_select_own
  on public.body_measurements
  for select
  to authenticated
  using (user_id = auth.uid());

create policy body_measurements_insert_own
  on public.body_measurements
  for insert
  to authenticated
  with check (user_id = auth.uid());

create policy body_measurements_update_own
  on public.body_measurements
  for update
  to authenticated
  using (user_id = auth.uid())
  with check (user_id = auth.uid());

grant select, insert on public.body_measurements to authenticated;
grant update (notes) on public.body_measurements to authenticated;

-- -----------------------------------------------------------------------------
-- public.body_measurement_values (child, one row per measured site)
-- -----------------------------------------------------------------------------
create table public.body_measurement_values (
  id                  uuid primary key default gen_random_uuid(),

  timeline_event_id   uuid not null references public.body_measurements (timeline_event_id) on delete cascade,
  -- Denormalized for RLS; consistency with body_measurements.user_id
  -- enforced by the trigger below.
  user_id             uuid not null references public.profiles (id) on delete cascade,

  measurement_kind    public.measurement_kind not null,
  value               numeric not null
    constraint body_measurement_values_value_non_negative_chk check (value >= 0),
  unit_snapshot        text not null
    constraint body_measurement_values_unit_snapshot_chk check (unit_snapshot in ('cm', 'in', 'pct')),

  created_at           timestamptz not null default now(),
  updated_at           timestamptz not null default now(),

  constraint uq_body_measurement_values_event_kind unique (timeline_event_id, measurement_kind)
);

comment on table public.body_measurement_values is
  'CORE-16 one row per measured site within a body_measurements occasion '
  '(§1.9). unique(timeline_event_id, measurement_kind): at most one value '
  'per site per occasion.';

-- No separate index needed for "load this occasion's values" -- the leading
-- column of uq_body_measurement_values_event_kind already covers a
-- timeline_event_id-only lookup (leftmost-column rule).

create or replace function public.enforce_body_measurement_values_integrity()
returns trigger
language plpgsql
security invoker
set search_path = public, pg_temp
as $$
declare
  v_parent_user_id uuid;
begin
  select user_id into v_parent_user_id
    from public.body_measurements
    where timeline_event_id = new.timeline_event_id;

  if v_parent_user_id is null then
    raise exception
      'body_measurement_values write rejected: no body_measurements row found for timeline_event_id %',
      new.timeline_event_id
      using errcode = '23503';
  end if;

  if v_parent_user_id <> new.user_id then
    raise exception
      'body_measurement_values.user_id (%) does not match body_measurements.user_id (%) for event %',
      new.user_id, v_parent_user_id, new.timeline_event_id
      using errcode = '42501';
  end if;

  -- Checked directly (not only transitively via the parent occasion's own
  -- insert-time check) because a value can be added to an existing occasion
  -- later, after consent may have been revoked in between (§6: "revoking
  -- health blocks new bodyweight/measurement writes").
  if not exists (
    select 1
    from public.user_consents
    where user_id = new.user_id
      and category = 'health'
      and revoked_at is null
  ) then
    raise exception
      'body_measurement_values write rejected: no active health-category consent on file for user % (CONSENT_REQUIRED_HEALTH)',
      new.user_id
      using errcode = '42501';
  end if;

  return new;
end;
$$;

comment on function public.enforce_body_measurement_values_integrity() is
  'Trigger: (1) user_id must match the parent body_measurements row''s '
  'user_id, (2) an active health consent row is required (checked directly, '
  'not only transitively -- a value can be added after the occasion row '
  'already exists). §1.9, §6.';

revoke execute on function public.enforce_body_measurement_values_integrity() from public, anon, authenticated;

create trigger trg_body_measurement_values_enforce_integrity
  before insert or update on public.body_measurement_values
  for each row
  execute function public.enforce_body_measurement_values_integrity();

create trigger trg_body_measurement_values_set_updated_at
  before update on public.body_measurement_values
  for each row
  execute function public.set_updated_at();

create trigger trg_body_measurement_values_force_insert_audit_timestamps
  before insert on public.body_measurement_values
  for each row
  execute function public.force_insert_audit_timestamps();

alter table public.body_measurement_values enable row level security;

create policy body_measurement_values_select_own
  on public.body_measurement_values
  for select
  to authenticated
  using (user_id = auth.uid());

create policy body_measurement_values_insert_own
  on public.body_measurement_values
  for insert
  to authenticated
  with check (user_id = auth.uid());

create policy body_measurement_values_update_own
  on public.body_measurement_values
  for update
  to authenticated
  using (user_id = auth.uid())
  with check (user_id = auth.uid());

grant select, insert on public.body_measurement_values to authenticated;
-- measurement_kind is excluded from UPDATE -- it's part of the natural key
-- (uq_body_measurement_values_event_kind) and immutable once logged. No
-- client DELETE policy exists on this table (mirrors the rest of this
-- module's history-bearing rows): a wrong value is corrected in place via
-- this UPDATE grant; a wrong *site* (measurement_kind) requires soft-deleting
-- the whole occasion at the spine level (timeline_events.deleted_at) and
-- re-logging -- consistent with how a mis-typed exercise on a completed set
-- is handled elsewhere in this module.
grant update (value, unit_snapshot) on public.body_measurement_values to authenticated;
