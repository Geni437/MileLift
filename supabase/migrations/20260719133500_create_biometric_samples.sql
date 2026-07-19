-- =============================================================================
-- Phase 1 — Module A: biometric_samples (shape designed, ingestion Phase 2)
-- Design ref: docs/architecture/phase-1-module-a.md §3.5, §6, §8, §12 item 2
--
-- 1:1 with timeline_events directly (sample_kind mirrors the spine's
-- sleep_session/hr_sample/hrv_sample/resting_hr event types, which are
-- already forced visibility = 'private' by the live
-- timeline_events_sensitive_private_chk). Owner-only, never widened. Table
-- + RLS + consent trigger are built now per §3.5's instruction to define the
-- shape so Phase 2's AI-06 has a target; no ingestion code is wired here.
--
-- ROLLBACK: see supabase/migrations/rollbacks/20260719133500_create_biometric_samples.sql
-- =============================================================================

create type public.biometric_sample_kind as enum ('sleep', 'hr', 'hrv', 'resting_hr');

comment on type public.biometric_sample_kind is
  'Mirrors the spine''s recovery/biometric event_types (§3.5). Add-only enum.';

-- -----------------------------------------------------------------------------
-- public.biometric_samples
-- -----------------------------------------------------------------------------
create table public.biometric_samples (
  timeline_event_id  uuid primary key references public.timeline_events (id) on delete cascade,

  -- Denormalized for RLS; consistency with timeline_events.user_id enforced
  -- by the trigger below.
  user_id            uuid not null references public.profiles (id) on delete cascade,

  sample_kind        public.biometric_sample_kind not null,

  -- The single derived value AI-06 needs (bpm, ms, sleep score) -- store the
  -- derived metric, not a raw firehose (§3.5/§6 minimization). Sleep
  -- *duration* uses the spine's duration_seconds, not this column.
  value              numeric not null
    constraint biometric_samples_value_non_negative_chk check (value >= 0),
  unit               text not null
    constraint biometric_samples_unit_not_blank_chk check (length(trim(unit)) > 0),

  provider           public.wearable_provider not null,

  created_at         timestamptz not null default now(),
  updated_at         timestamptz not null default now()
);

comment on table public.biometric_samples is
  'Recovery/biometric sample shape (§3.5). Owner-only, never widened -- '
  'matches the spine forcing these event_types visibility = private. '
  'Ingestion is deferred to Phase 2 (AI-06); this table exists so nothing is '
  'orphaned when that lands. Every write requires an active health consent '
  '(§6), unconditionally -- unlike activity_details, there is no non-sensitive '
  'row shape here.';

-- No additional index beyond the PK is added here: the natural read pattern
-- ("this user's recovery samples in a date range") goes through the spine's
-- existing (user_id, event_type, occurred_at) index, joining to this table by
-- its PK (timeline_event_id) -- a redundant (user_id, ...) index on this
-- table would not serve a distinct named query pattern given ingestion is
-- deferred and nothing reads this table yet (db-schema-standards: index
-- deliberately, not speculatively).

-- -----------------------------------------------------------------------------
-- Seam-integrity + unconditional health-consent-gating trigger, reusing the
-- exact enforce_health_consent() pattern from
-- 20260718210837_create_profile_health.sql (§6).
-- -----------------------------------------------------------------------------
create or replace function public.enforce_biometric_samples_integrity()
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
      'biometric_samples write rejected: no timeline_events row found for id %',
      new.timeline_event_id
      using errcode = '23503';
  end if;

  if v_spine_user_id <> new.user_id then
    raise exception
      'biometric_samples.user_id (%) does not match timeline_events.user_id (%) for event %',
      new.user_id, v_spine_user_id, new.timeline_event_id
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
      'biometric_samples write rejected: no active health-category consent on file for user %',
      new.user_id
      using errcode = '42501';
  end if;

  return new;
end;
$$;

comment on function public.enforce_biometric_samples_integrity() is
  'Trigger: (1) user_id must match timeline_events.user_id, (2) every write '
  'unconditionally requires an active health-category consent row. §3.5/§6.';

revoke execute on function public.enforce_biometric_samples_integrity() from public, anon, authenticated;

create trigger trg_biometric_samples_enforce_integrity
  before insert or update on public.biometric_samples
  for each row
  execute function public.enforce_biometric_samples_integrity();

create trigger trg_biometric_samples_set_updated_at
  before update on public.biometric_samples
  for each row
  execute function public.set_updated_at();

create trigger trg_biometric_samples_force_insert_audit_timestamps
  before insert on public.biometric_samples
  for each row
  execute function public.force_insert_audit_timestamps();

-- -----------------------------------------------------------------------------
-- RLS (§8): owner-only, never widened. No client DELETE (cascades from the
-- parent timeline_events row).
-- -----------------------------------------------------------------------------
alter table public.biometric_samples enable row level security;

create policy biometric_samples_select_own
  on public.biometric_samples
  for select
  to authenticated
  using (user_id = auth.uid());

create policy biometric_samples_insert_own
  on public.biometric_samples
  for insert
  to authenticated
  with check (user_id = auth.uid());

create policy biometric_samples_update_own
  on public.biometric_samples
  for update
  to authenticated
  using (user_id = auth.uid())
  with check (user_id = auth.uid());

grant select, insert on public.biometric_samples to authenticated;
grant update (sample_kind, value, unit, provider) on public.biometric_samples to authenticated;
