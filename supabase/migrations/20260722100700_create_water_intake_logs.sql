-- =============================================================================
-- Phase 3 — Module B: water_intake_logs (CORE-09, 1:1 with the spine)
-- Design ref: docs/architecture/phase-3-module-b.md §1.7, §8, §8.1, §12
--
-- One water_intake event per logged drink. Grain decision (§12
-- implementation-level item, resolved here): PER-DRINK-EVENT, confirming
-- the architect's recommendation as-is -- consistent with every other
-- point-in-time occurrence on the spine, and with per-entry editability/
-- history (a daily-total-only grain would lose "I logged 500ml at 2pm and
-- another 300ml at 5pm" resolution for no offsetting benefit).
--
-- NOT consent-gated (§6/§12 decision 3) -- water is not health-sensitive in
-- the biometric sense. Carries no energy_kcal -- the spine's energy-sign
-- CHECK already passes NULL for this event_type (water is not energy).
--
-- ROLLBACK: see supabase/migrations/rollbacks/20260722100700_create_water_intake_logs.sql
-- =============================================================================

create table public.water_intake_logs (
  timeline_event_id      uuid primary key references public.timeline_events (id) on delete cascade,

  -- Denormalized for RLS; consistency with the spine's own user_id enforced
  -- by the trigger below.
  user_id                 uuid not null references public.profiles (id) on delete cascade,

  volume_ml               numeric not null
    constraint water_intake_logs_volume_positive_chk check (volume_ml > 0),
  unit_volume_snapshot     text not null
    constraint water_intake_logs_unit_volume_snapshot_chk check (unit_volume_snapshot in ('ml', 'fl_oz')),

  source                   text not null default 'manual'
    constraint water_intake_logs_source_chk check (source in ('manual', 'wearable', 'import')),

  created_at               timestamptz not null default now(),
  updated_at               timestamptz not null default now()
);

comment on table public.water_intake_logs is
  'CORE-09 per-drink water log, 1:1 with a water_intake timeline event '
  '(§1.7). Grain = per-drink-event (db-engineer confirmation of the '
  'architect recommendation, §12). Not consent-gated (§6/§12 decision 3).';
comment on column public.water_intake_logs.source is
  'manual today; wearable/import reserved for a future smart-bottle/'
  'HealthKit water import (§1.7), plain text + CHECK matching '
  'bodyweight_logs.source''s convention for a small, stable value set.';

-- No additional index beyond the PK -- "today's water total" / "water
-- history in a date range" are both served by joining through
-- timeline_events' existing (user_id, local_date) / (user_id, occurred_at)
-- partial indexes (Phase 0) then the PK here, mirroring bodyweight_logs'
-- identical reasoning.

-- -----------------------------------------------------------------------------
-- Seam-integrity trigger (§1.9): (1) user_id must match the spine row's
-- user_id, (2) event_type must be 'water_intake'. No consent check (§6/§12
-- decision 3).
-- -----------------------------------------------------------------------------
create or replace function public.enforce_water_intake_logs_integrity()
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
      'water_intake_logs write rejected: no timeline_events row found for id %',
      new.timeline_event_id
      using errcode = '23503';
  end if;

  if v_spine_user_id <> new.user_id then
    raise exception
      'water_intake_logs.user_id (%) does not match timeline_events.user_id (%) for event %',
      new.user_id, v_spine_user_id, new.timeline_event_id
      using errcode = '42501';
  end if;

  if v_spine_event_type <> 'water_intake' then
    raise exception
      'water_intake_logs write rejected: timeline_events.event_type (%) for event % is not water_intake',
      v_spine_event_type, new.timeline_event_id
      using errcode = '42501';
  end if;

  return new;
end;
$$;

comment on function public.enforce_water_intake_logs_integrity() is
  'Trigger: (1) user_id must match the spine event''s user_id, (2) '
  'event_type must be water_intake. §1.9. No consent gate (§6/§12 decision 3).';

revoke execute on function public.enforce_water_intake_logs_integrity() from public, anon, authenticated;

create trigger trg_water_intake_logs_enforce_integrity
  before insert or update on public.water_intake_logs
  for each row
  execute function public.enforce_water_intake_logs_integrity();

create trigger trg_water_intake_logs_set_updated_at
  before update on public.water_intake_logs
  for each row
  execute function public.set_updated_at();

create trigger trg_water_intake_logs_force_insert_audit_timestamps
  before insert on public.water_intake_logs
  for each row
  execute function public.force_insert_audit_timestamps();

-- -----------------------------------------------------------------------------
-- RLS (§8): owner-only via denormalized user_id. SELECT/INSERT/UPDATE, no
-- client DELETE (soft-delete on the parent spine row).
-- -----------------------------------------------------------------------------
alter table public.water_intake_logs enable row level security;

create policy water_intake_logs_select_own
  on public.water_intake_logs
  for select
  to authenticated
  using (user_id = auth.uid());

create policy water_intake_logs_insert_own
  on public.water_intake_logs
  for insert
  to authenticated
  with check (user_id = auth.uid());

create policy water_intake_logs_update_own
  on public.water_intake_logs
  for update
  to authenticated
  using (user_id = auth.uid())
  with check (user_id = auth.uid());

grant select, insert on public.water_intake_logs to authenticated;

-- -----------------------------------------------------------------------------
-- Column-scoped UPDATE grant (§8.1 -- see food_log_items' migration header
-- for the full recurring-lesson warning; not repeated verbatim here).
--
--   MUTABLE   (client UPDATE granted): volume_ml, unit_volume_snapshot, source.
--   IMMUTABLE (excluded): timeline_event_id, user_id, created_at.
--
-- Per §5, this table is small enough (single-detail-row, no child firehose)
-- that a DIRECT table `.upsert()` with an explicit mutable-column list is an
-- acceptable write path -- it does not require save_water_intake_v1 the way
-- food_log_entries/food_log_items require save_food_log_entry_v1, though a
-- thin save_water_intake_v1 RPC (backend-builder, §5) is recommended for
-- the spine+detail transaction consistency.
-- -----------------------------------------------------------------------------
grant update (volume_ml, unit_volume_snapshot, source)
  on public.water_intake_logs to authenticated;

-- CORRECTED GUIDANCE, LIVE-PROVEN (see
-- 20260722999999_revert_custom_foods_diagnostic_grant.sql for the full
-- account): restricting an .upsert() payload to mutable columns is
-- NECESSARY but NOT SUFFICIENT -- PostgREST's .upsert() always includes the
-- conflict-target column (timeline_event_id) in its SET list, which has no
-- UPDATE grant here. Editing an existing row MUST use a plain
-- .update({...mutableCols}).eq('timeline_event_id', x) -- never .upsert().
