-- =============================================================================
-- Phase 2 — Module C: bodyweight_logs (CORE-16, health-consent-gated)
-- Design ref: docs/architecture/phase-2-module-c.md §1.9, §6, §8
--
-- 1:1 with a `bodyweight` timeline event -- bodyweight is a timeline event,
-- not a profile scalar, because history matters (Phase 0 §2). Forced
-- visibility = private by the live timeline_events_sensitive_private_chk
-- (Phase 0), never shareable. "Current weight" is a query over the latest of
-- these, not a mutable column.
--
-- ROLLBACK: see supabase/migrations/rollbacks/20260721101000_create_bodyweight_logs.sql
-- =============================================================================

create table public.bodyweight_logs (
  timeline_event_id     uuid primary key references public.timeline_events (id) on delete cascade,

  -- Denormalized for RLS; consistency with the spine's own user_id enforced
  -- by the trigger below.
  user_id                uuid not null references public.profiles (id) on delete cascade,

  weight_kg              numeric not null
    constraint bodyweight_logs_weight_range_chk check (weight_kg > 0 and weight_kg < 650),
  unit_weight_snapshot    text not null
    constraint bodyweight_logs_unit_weight_snapshot_chk check (unit_weight_snapshot in ('kg', 'lb')),
  body_fat_pct            numeric
    constraint bodyweight_logs_body_fat_pct_range_chk check (body_fat_pct is null or (body_fat_pct >= 0 and body_fat_pct <= 100)),

  source                  text not null default 'manual'
    constraint bodyweight_logs_source_chk check (source in ('manual', 'wearable')),

  notes                   text,

  created_at              timestamptz not null default now(),
  updated_at              timestamptz not null default now()
);

comment on table public.bodyweight_logs is
  'CORE-16 bodyweight log, 1:1 with a bodyweight timeline event (§1.9). '
  'Health-consent-gated write (enforce_bodyweight_logs_integrity below). '
  '"Current weight" is a query over the latest non-deleted row via '
  'timeline_events (user_id, occurred_at), not a mutable profile column.';
comment on column public.bodyweight_logs.source is
  'manual today; wearable reserved for a future smart-scale import (§1.9), '
  'plain text + CHECK rather than a new enum type (matches profiles.unit_weight''s convention for a small, stable value set).';

-- No additional index beyond the PK -- "current/latest weight" and
-- "bodyweight history in a date range" are both served by joining through
-- timeline_events' existing (user_id, occurred_at) partial index (Phase 0)
-- then the PK here; a second index on this table would duplicate that
-- coverage without serving a distinct named pattern.

-- -----------------------------------------------------------------------------
-- Seam-integrity + health-consent-gating trigger, reusing the exact
-- enforce_health_consent() pattern from profile_health/activity_details (§6):
-- (1) user_id must match the spine event's user_id, (2) the spine event's
-- event_type must be 'bodyweight', (3) an active health-category consent row
-- is required -- unconditional here (every row in this table is bodyweight
-- data), unlike activity_details' conditional average_hr/max_hr gate.
-- -----------------------------------------------------------------------------
create or replace function public.enforce_bodyweight_logs_integrity()
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
      'bodyweight_logs write rejected: no timeline_events row found for id %',
      new.timeline_event_id
      using errcode = '23503';
  end if;

  if v_spine_user_id <> new.user_id then
    raise exception
      'bodyweight_logs.user_id (%) does not match timeline_events.user_id (%) for event %',
      new.user_id, v_spine_user_id, new.timeline_event_id
      using errcode = '42501';
  end if;

  if v_spine_event_type <> 'bodyweight' then
    raise exception
      'bodyweight_logs write rejected: timeline_events.event_type (%) for event % is not bodyweight',
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
      'bodyweight_logs write rejected: no active health-category consent on file for user % (CONSENT_REQUIRED_HEALTH)',
      new.user_id
      using errcode = '42501';
  end if;

  return new;
end;
$$;

comment on function public.enforce_bodyweight_logs_integrity() is
  'Trigger: (1) user_id must match the spine event''s user_id, (2) event_type '
  'must be bodyweight, (3) an active health consent row is required. §1.9, §6.';

revoke execute on function public.enforce_bodyweight_logs_integrity() from public, anon, authenticated;

create trigger trg_bodyweight_logs_enforce_integrity
  before insert or update on public.bodyweight_logs
  for each row
  execute function public.enforce_bodyweight_logs_integrity();

create trigger trg_bodyweight_logs_set_updated_at
  before update on public.bodyweight_logs
  for each row
  execute function public.set_updated_at();

create trigger trg_bodyweight_logs_force_insert_audit_timestamps
  before insert on public.bodyweight_logs
  for each row
  execute function public.force_insert_audit_timestamps();

-- -----------------------------------------------------------------------------
-- RLS (§8): owner-only, health-consent-gated write (trigger above), never
-- widened -- the spine forces this event type permanently private. SELECT/
-- INSERT/UPDATE, no client DELETE (no deleted_at column here; soft-delete is
-- via timeline_events.deleted_at, mirroring activity_details).
-- -----------------------------------------------------------------------------
alter table public.bodyweight_logs enable row level security;

create policy bodyweight_logs_select_own
  on public.bodyweight_logs
  for select
  to authenticated
  using (user_id = auth.uid());

create policy bodyweight_logs_insert_own
  on public.bodyweight_logs
  for insert
  to authenticated
  with check (user_id = auth.uid());

create policy bodyweight_logs_update_own
  on public.bodyweight_logs
  for update
  to authenticated
  using (user_id = auth.uid())
  with check (user_id = auth.uid());

grant select, insert on public.bodyweight_logs to authenticated;
-- Column-scoped UPDATE excluding timeline_event_id/user_id/created_at
-- (immutable identity columns).
grant update (weight_kg, unit_weight_snapshot, body_fat_pct, source, notes)
  on public.bodyweight_logs to authenticated;
