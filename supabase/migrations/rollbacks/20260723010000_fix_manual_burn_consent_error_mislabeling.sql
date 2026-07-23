-- Rollback for 20260723010000_fix_manual_burn_consent_error_mislabeling.sql
-- Restores enforce_manual_calorie_burn_logs_integrity() to its pre-fix text
-- (the consent-gate message without the "CONSENT_REQUIRED_HEALTH:" prefix).

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
