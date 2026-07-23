-- =============================================================================
-- security-auditor L2 (Phase 3 review) — save_manual_burn_v1 blindly mapped
-- ANY 42501 from enforce_manual_calorie_burn_logs_integrity() to
-- CONSENT_REQUIRED_HEALTH, but that trigger raises 42501 for three distinct
-- conditions: a user_id/spine mismatch, a wrong event_type, and the actual
-- missing-health-consent gate. Not currently exploitable (the RPC always
-- supplies the caller's own user_id and the correct event_type, so the other
-- two branches are unreachable through it), but a latent mislabeling risk if
-- this function is ever reused elsewhere. Never editing an already-applied
-- migration in place (20260722100800/20260722200200) -- this is a new,
-- additive fix per this project's convention.
--
-- Fix: the consent-gate branch's raised message now starts with the literal
-- marker "CONSENT_REQUIRED_HEALTH:", and the RPC's exception handler checks
-- for that marker instead of assuming every 42501 means the same thing.
--
-- ROLLBACK: see supabase/migrations/rollbacks/20260723010000_fix_manual_burn_consent_error_mislabeling.sql
-- =============================================================================

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
      'CONSENT_REQUIRED_HEALTH: manual_calorie_burn_logs write rejected: energy_source is estimated but no active health-category consent on file for user %',
      new.user_id
      using errcode = '42501';
  end if;

  return new;
end;
$$;

comment on function public.enforce_manual_calorie_burn_logs_integrity() is
  'BEFORE INSERT/UPDATE integrity + conditional health-consent gate for manual_calorie_burn_logs. '
  'The consent-gate branch''s message is prefixed "CONSENT_REQUIRED_HEALTH:" so callers can '
  'distinguish it from the other two 42501 conditions this function also raises (user_id '
  'mismatch, wrong event_type) -- see 20260723010000.';
