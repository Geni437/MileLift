-- =============================================================================
-- Phase 3 — Module B: manual_calorie_burn_logs (CORE-11, 1:1 with the spine)
-- Design ref: docs/architecture/phase-3-module-b.md §1.8, §4, §6, §8, §8.1
--
-- A user logging energy expenditure for an activity NOT tracked by Module A
-- (GPS) or C (strength) -- e.g. tennis, yoga, gardening. One
-- manual_calorie_burn event, NEGATIVE energy_kcal (already enforced by the
-- live timeline_events_energy_sign_chk). The magnitude lives on the spine,
-- not duplicated here (§1.8) -- so CORE-11/AI-12 read it cross-module
-- without touching this detail table.
--
-- Consent gate (§6/§12 decision 3): the ONE gate in Module B -- energy
-- ESTIMATION that reads bodyweight (energy_source = 'estimated') requires
-- an active 'health' consent, the same gate as Module A/C energy
-- estimation. energy_source = 'user_entered' is never gated.
--
-- ROLLBACK: see supabase/migrations/rollbacks/20260722100800_create_manual_calorie_burn_logs.sql
-- =============================================================================

create type public.manual_burn_energy_source as enum ('user_entered', 'estimated');

comment on type public.manual_burn_energy_source is
  'Whether the spine''s energy_kcal figure for this event is a number the '
  'user typed (user_entered) or an app estimate from a MET table x duration '
  'x bodyweight (estimated) -- the latter is health-consent-gated (§1.8, §6). '
  'Add-only enum.';

create table public.manual_calorie_burn_logs (
  timeline_event_id      uuid primary key references public.timeline_events (id) on delete cascade,

  -- Denormalized for RLS; consistency with the spine's own user_id enforced
  -- by the trigger below.
  user_id                 uuid not null references public.profiles (id) on delete cascade,

  label                    text not null
    constraint manual_calorie_burn_logs_label_not_blank_chk check (length(trim(label)) > 0),

  -- Optional structured link to the Module A activity catalog (§1.8) --
  -- reuses the live activity_types reference table rather than inventing a
  -- parallel one. Nullable because free-text is the default logging path.
  activity_type_code       text references public.activity_types (code),

  duration_minutes         integer
    constraint manual_calorie_burn_logs_duration_non_negative_chk check (duration_minutes is null or duration_minutes >= 0),

  energy_source             public.manual_burn_energy_source not null,

  notes                     text,

  created_at                timestamptz not null default now(),
  updated_at                timestamptz not null default now()
);

comment on table public.manual_calorie_burn_logs is
  'CORE-11 manual energy-expenditure log, 1:1 with a manual_calorie_burn '
  'timeline event (§1.8). The burned-kcal magnitude lives on the spine''s '
  '(negative) energy_kcal, not duplicated here, so CORE-11/AI-12 daily-'
  'balance reads (§4) never touch this detail table.';
comment on column public.manual_calorie_burn_logs.duration_minutes is
  'Optional. If given, the save RPC sets the spine''s duration_seconds = '
  'duration_minutes * 60 (§1.8) -- an application-layer pairing convention, '
  'not enforced as a blocking DB CHECK here, since §5 explicitly permits a '
  'direct small-edit table upsert (e.g. correcting duration_minutes alone) '
  'that would otherwise transiently violate a strict cross-table equality '
  'constraint. db-engineer judgment call, flagged in the task report.';
comment on column public.manual_calorie_burn_logs.energy_source is
  'estimated requires an active health-category consent (enforced by the '
  'trigger below) -- the same gate as Module A/C calorie estimation. '
  'user_entered is never gated.';

-- No additional index beyond the PK -- CORE-11 reads (today's burn total)
-- go through the spine's own (user_id, local_date) partial index (§4.2),
-- not this detail table; "browse my manual burns" is served by joining
-- through timeline_events' (user_id, occurred_at) index then the PK here,
-- mirroring bodyweight_logs/water_intake_logs' identical reasoning.

-- Partial FK-supporting index: "how many manual burns were logged against
-- this activity type" (a plausible analytics/admin read) -- sparse, since
-- activity_type_code is nullable and free-text is the default logging path.
create index idx_manual_calorie_burn_logs_activity_type
  on public.manual_calorie_burn_logs (activity_type_code)
  where activity_type_code is not null;

-- -----------------------------------------------------------------------------
-- Seam-integrity + conditional consent-gating trigger (§1.9, §6), reusing
-- the exact conditional-gate pattern from
-- enforce_activity_details_integrity's average_hr/max_hr check (Phase 1):
-- (1) user_id must match the spine row's user_id, (2) event_type must be
-- 'manual_calorie_burn', (3) energy_source = 'estimated' requires an active
-- health-category consent row -- conditional, unlike bodyweight_logs'
-- unconditional gate, because only the 'estimated' source reads bodyweight.
-- -----------------------------------------------------------------------------
create or replace function public.enforce_manual_calorie_burn_logs_integrity()
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
      'manual_calorie_burn_logs write rejected: no timeline_events row found for id %',
      new.timeline_event_id
      using errcode = '23503';
  end if;

  if v_spine_user_id <> new.user_id then
    raise exception
      'manual_calorie_burn_logs.user_id (%) does not match timeline_events.user_id (%) for event %',
      new.user_id, v_spine_user_id, new.timeline_event_id
      using errcode = '42501';
  end if;

  if v_spine_event_type <> 'manual_calorie_burn' then
    raise exception
      'manual_calorie_burn_logs write rejected: timeline_events.event_type (%) for event % is not manual_calorie_burn',
      v_spine_event_type, new.timeline_event_id
      using errcode = '42501';
  end if;

  if new.energy_source = 'estimated' and not exists (
    select 1
    from public.user_consents
    where user_id = new.user_id
      and category = 'health'
      and revoked_at is null
  ) then
    raise exception
      'manual_calorie_burn_logs write rejected: energy_source is estimated but no active health-category consent on file for user % (CONSENT_REQUIRED_HEALTH)',
      new.user_id
      using errcode = '42501';
  end if;

  return new;
end;
$$;

comment on function public.enforce_manual_calorie_burn_logs_integrity() is
  'Trigger: (1) user_id must match the spine event''s user_id, (2) '
  'event_type must be manual_calorie_burn, (3) energy_source = estimated '
  'requires an active health consent row (conditional gate). §1.9/§6.';

revoke execute on function public.enforce_manual_calorie_burn_logs_integrity() from public, anon, authenticated;

create trigger trg_manual_calorie_burn_logs_enforce_integrity
  before insert or update on public.manual_calorie_burn_logs
  for each row
  execute function public.enforce_manual_calorie_burn_logs_integrity();

create trigger trg_manual_calorie_burn_logs_set_updated_at
  before update on public.manual_calorie_burn_logs
  for each row
  execute function public.set_updated_at();

create trigger trg_manual_calorie_burn_logs_force_insert_audit_timestamps
  before insert on public.manual_calorie_burn_logs
  for each row
  execute function public.force_insert_audit_timestamps();

-- -----------------------------------------------------------------------------
-- RLS (§8): owner-only via denormalized user_id. SELECT/INSERT/UPDATE, no
-- client DELETE (soft-delete on the parent spine row).
-- -----------------------------------------------------------------------------
alter table public.manual_calorie_burn_logs enable row level security;

create policy manual_calorie_burn_logs_select_own
  on public.manual_calorie_burn_logs
  for select
  to authenticated
  using (user_id = auth.uid());

create policy manual_calorie_burn_logs_insert_own
  on public.manual_calorie_burn_logs
  for insert
  to authenticated
  with check (user_id = auth.uid());

create policy manual_calorie_burn_logs_update_own
  on public.manual_calorie_burn_logs
  for update
  to authenticated
  using (user_id = auth.uid())
  with check (user_id = auth.uid());

grant select, insert on public.manual_calorie_burn_logs to authenticated;

-- -----------------------------------------------------------------------------
-- Column-scoped UPDATE grant (§8.1 -- see food_log_items' migration header
-- for the full recurring-lesson warning; not repeated verbatim here).
--
--   MUTABLE   (client UPDATE granted): label, activity_type_code,
--     duration_minutes, energy_source, notes.
--   IMMUTABLE (excluded): timeline_event_id, user_id, created_at.
-- -----------------------------------------------------------------------------
grant update (label, activity_type_code, duration_minutes, energy_source, notes)
  on public.manual_calorie_burn_logs to authenticated;

-- CORRECTED GUIDANCE, LIVE-PROVEN (see
-- 20260722999999_revert_custom_foods_diagnostic_grant.sql for the full
-- account): restricting an .upsert() payload to mutable columns is
-- NECESSARY but NOT SUFFICIENT -- PostgREST's .upsert() always includes the
-- conflict-target column (timeline_event_id) in its SET list, which has no
-- UPDATE grant here. Editing an existing row MUST use a plain
-- .update({...mutableCols}).eq('timeline_event_id', x) -- never .upsert().
