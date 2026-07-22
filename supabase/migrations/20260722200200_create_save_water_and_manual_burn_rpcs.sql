-- =============================================================================
-- Phase 3 — Module B: save_water_intake_v1 / save_manual_burn_v1 RPCs
-- Design ref: docs/architecture/phase-3-module-b.md §1.7, §1.8, §4.3, §5, §6,
-- §8.1, §12 decision 2
--
-- Both are SECURITY INVOKER, thin spine+detail transactional wrappers over a
-- single-detail-row table (no child firehose) -- §5 explicitly permits a
-- direct table upsert for these but "recommend[s] a thin RPC ... for the
-- spine+detail transaction consistency", which this migration provides.
-- Neither table (water_intake_logs, manual_calorie_burn_logs) is treated as
-- shareable in Phase 3 (§12 decision 4 only resolves food_log_entry sharing);
-- both RPCs hardcode visibility = 'private' rather than exposing a
-- visibility parameter -- a deliberate, narrow scope-limiting choice, not an
-- oversight (flagged in the task report).
--
-- ROLLBACK: see supabase/migrations/rollbacks/20260722200200_create_save_water_and_manual_burn_rpcs.sql
-- =============================================================================

-- =============================================================================
-- public.save_water_intake_v1(...) — CORE-09, §1.7, §5
-- =============================================================================
create or replace function public.save_water_intake_v1(
  p_id                  uuid,
  p_occurred_at         timestamptz,
  p_local_date          date,
  p_event_timezone      text,
  p_volume_ml           numeric,
  p_unit_volume_snapshot text,
  p_source              text default 'manual',
  p_client_created_at   timestamptz default null
)
returns jsonb
language plpgsql
security invoker
set search_path = public, pg_temp
as $$
declare
  v_user_id            uuid;
  v_rows_affected      integer;
  v_clock_skew_tolerance constant interval := interval '24 hours';
begin
  v_user_id := auth.uid();
  if v_user_id is null then
    return jsonb_build_object('error', jsonb_build_object(
      'code', 'UNAUTHENTICATED', 'message', 'No authenticated user context.', 'field', null));
  end if;

  if p_id is null then
    return jsonb_build_object('error', jsonb_build_object('code', 'VALIDATION_ERROR', 'message', 'id is required.', 'field', 'id'));
  end if;
  if p_occurred_at is null then
    return jsonb_build_object('error', jsonb_build_object('code', 'VALIDATION_ERROR', 'message', 'occurred_at is required.', 'field', 'occurred_at'));
  end if;
  if p_local_date is null then
    return jsonb_build_object('error', jsonb_build_object('code', 'VALIDATION_ERROR', 'message', 'local_date is required.', 'field', 'local_date'));
  end if;
  if p_event_timezone is null or length(trim(p_event_timezone)) = 0 then
    return jsonb_build_object('error', jsonb_build_object('code', 'VALIDATION_ERROR', 'message', 'event_timezone is required.', 'field', 'event_timezone'));
  end if;
  if p_volume_ml is null then
    return jsonb_build_object('error', jsonb_build_object('code', 'VALIDATION_ERROR', 'message', 'volume_ml is required.', 'field', 'volume_ml'));
  end if;
  if p_volume_ml <= 0 then
    return jsonb_build_object('error', jsonb_build_object('code', 'NEGATIVE_MEASUREMENT', 'message', 'volume_ml must be > 0.', 'field', 'volume_ml'));
  end if;
  if p_unit_volume_snapshot is null or p_unit_volume_snapshot not in ('ml', 'fl_oz') then
    return jsonb_build_object('error', jsonb_build_object('code', 'INVALID_UNIT', 'message', 'unit_volume_snapshot must be ml or fl_oz.', 'field', 'unit_volume_snapshot'));
  end if;
  if p_source not in ('manual', 'wearable', 'import') then
    return jsonb_build_object('error', jsonb_build_object('code', 'INVALID_SOURCE', 'message', 'source must be one of manual, wearable, import.', 'field', 'source'));
  end if;
  if p_occurred_at > now() + v_clock_skew_tolerance then
    return jsonb_build_object('error', jsonb_build_object(
      'code', 'OCCURRED_AT_TOO_FUTURE', 'message', format('occurred_at is further in the future than the %s clock-skew tolerance.', v_clock_skew_tolerance), 'field', 'occurred_at'));
  end if;
  if p_local_date not between (p_occurred_at at time zone 'UTC')::date - 1
                          and (p_occurred_at at time zone 'UTC')::date + 1 then
    return jsonb_build_object('error', jsonb_build_object(
      'code', 'LOCAL_DATE_OUT_OF_BOUNDS', 'message', 'local_date must be within one day of occurred_at (UTC).', 'field', 'local_date'));
  end if;

  begin
    with upsert as (
      insert into public.timeline_events (
        id, user_id, source_module, event_type, occurred_at, local_date, event_timezone,
        source, visibility, client_created_at
      ) values (
        p_id, v_user_id, 'nutrition', 'water_intake', p_occurred_at, p_local_date, p_event_timezone,
        p_source::public.timeline_source, 'private', p_client_created_at
      )
      on conflict (id) do update set
        occurred_at    = excluded.occurred_at,
        local_date     = excluded.local_date,
        event_timezone = excluded.event_timezone
      where timeline_events.user_id = v_user_id
      returning id
    )
    select count(*) into v_rows_affected from upsert;

    if v_rows_affected = 0 then
      return jsonb_build_object('error', jsonb_build_object(
        'code', 'ID_CONFLICT', 'message', 'The provided id is already in use by a different record.', 'field', 'id'));
    end if;

    with upsert as (
      insert into public.water_intake_logs (
        timeline_event_id, user_id, volume_ml, unit_volume_snapshot, source
      ) values (
        p_id, v_user_id, p_volume_ml, p_unit_volume_snapshot, p_source
      )
      on conflict (timeline_event_id) do update set
        volume_ml            = excluded.volume_ml,
        unit_volume_snapshot = excluded.unit_volume_snapshot,
        source               = excluded.source
      where water_intake_logs.user_id = v_user_id
      returning timeline_event_id
    )
    select count(*) into v_rows_affected from upsert;

    if v_rows_affected = 0 then
      return jsonb_build_object('error', jsonb_build_object(
        'code', 'ID_CONFLICT', 'message', 'The water intake detail row could not be written (ownership conflict).', 'field', 'id'));
    end if;

  exception when others then
    return jsonb_build_object('error', jsonb_build_object(
      'code',
        case sqlstate
          when '23505' then 'ID_CONFLICT'
          when '23514' then 'VALIDATION_ERROR'
          when '22P02' then 'VALIDATION_ERROR'
          else 'WRITE_FAILED'
        end,
      'message', sqlerrm,
      'field', null
    ));
  end;

  return jsonb_build_object('data', jsonb_build_object(
    'id', p_id,
    'occurred_at', p_occurred_at,
    'local_date', p_local_date,
    'volume_ml', p_volume_ml,
    'unit_volume_snapshot', p_unit_volume_snapshot,
    'source', p_source
  ));
end;
$$;

comment on function public.save_water_intake_v1(uuid, timestamptz, date, text, numeric, text, text, timestamptz) is
  'Phase 3 Module B CORE-09 save RPC (§1.7/§5). SECURITY INVOKER, transactional '
  'across timeline_events + water_intake_logs. visibility is hardcoded private '
  '(water is not treated as shareable in Phase 3, unlike food_log_entry).';

revoke execute on function public.save_water_intake_v1(uuid, timestamptz, date, text, numeric, text, text, timestamptz) from public, anon;
grant execute on function public.save_water_intake_v1(uuid, timestamptz, date, text, numeric, text, text, timestamptz) to authenticated;

-- =============================================================================
-- public.save_manual_burn_v1(...) — CORE-11, §1.8, §4.3, §5, §6, §12 decision 2
--
-- Includes the CORE-11 non-blocking overlap advisory (§4.3) inline in the
-- success response: a soft, informational signal only -- this RPC NEVER
-- rejects/blocks the write because of an overlap, and never auto-merges or
-- suppresses either row (§12 decision 2, verbatim). When p_duration_minutes
-- is not given, a named default advisory window is used so an overlap can
-- still be surfaced for a point-in-time-only manual entry.
-- =============================================================================
create or replace function public.save_manual_burn_v1(
  p_id                  uuid,
  p_occurred_at         timestamptz,
  p_local_date          date,
  p_event_timezone      text,
  p_energy_kcal         numeric,
  p_label               text,
  p_energy_source       public.manual_burn_energy_source default 'user_entered',
  p_activity_type_code  text default null,
  p_duration_minutes    integer default null,
  p_notes               text default null,
  p_source              public.timeline_source default 'manual',
  p_client_created_at   timestamptz default null
)
returns jsonb
language plpgsql
security invoker
set search_path = public, pg_temp
as $$
declare
  v_user_id                uuid;
  v_rows_affected           integer;
  v_duration_seconds          integer;
  v_window_end                  timestamptz;
  v_overlap_events                jsonb;
  v_has_overlap                     boolean;
  v_clock_skew_tolerance constant interval := interval '24 hours';
  -- Default overlap-advisory window when no duration is given (§4.3): wide
  -- enough to catch a plausible same-activity duplicate, narrow enough not
  -- to flag unrelated same-day workouts. Named constant, not a bare literal.
  v_default_advisory_window constant interval := interval '30 minutes';
begin
  v_user_id := auth.uid();
  if v_user_id is null then
    return jsonb_build_object('error', jsonb_build_object(
      'code', 'UNAUTHENTICATED', 'message', 'No authenticated user context.', 'field', null));
  end if;

  if p_id is null then
    return jsonb_build_object('error', jsonb_build_object('code', 'VALIDATION_ERROR', 'message', 'id is required.', 'field', 'id'));
  end if;
  if p_occurred_at is null then
    return jsonb_build_object('error', jsonb_build_object('code', 'VALIDATION_ERROR', 'message', 'occurred_at is required.', 'field', 'occurred_at'));
  end if;
  if p_local_date is null then
    return jsonb_build_object('error', jsonb_build_object('code', 'VALIDATION_ERROR', 'message', 'local_date is required.', 'field', 'local_date'));
  end if;
  if p_event_timezone is null or length(trim(p_event_timezone)) = 0 then
    return jsonb_build_object('error', jsonb_build_object('code', 'VALIDATION_ERROR', 'message', 'event_timezone is required.', 'field', 'event_timezone'));
  end if;
  if p_label is null or length(trim(p_label)) = 0 then
    return jsonb_build_object('error', jsonb_build_object('code', 'VALIDATION_ERROR', 'message', 'label is required.', 'field', 'label'));
  end if;
  if p_energy_kcal is null then
    return jsonb_build_object('error', jsonb_build_object('code', 'VALIDATION_ERROR', 'message', 'energy_kcal is required.', 'field', 'energy_kcal'));
  end if;
  if p_energy_kcal >= 0 then
    return jsonb_build_object('error', jsonb_build_object('code', 'INVALID_ENERGY_SIGN', 'message', 'energy_kcal must be < 0 (expenditure) for a manual burn.', 'field', 'energy_kcal'));
  end if;
  if p_duration_minutes is not null and p_duration_minutes < 0 then
    return jsonb_build_object('error', jsonb_build_object('code', 'NEGATIVE_MEASUREMENT', 'message', 'duration_minutes must be >= 0.', 'field', 'duration_minutes'));
  end if;
  if p_source not in ('manual', 'import') then
    return jsonb_build_object('error', jsonb_build_object('code', 'INVALID_SOURCE', 'message', 'source must be one of manual, import.', 'field', 'source'));
  end if;
  if p_occurred_at > now() + v_clock_skew_tolerance then
    return jsonb_build_object('error', jsonb_build_object(
      'code', 'OCCURRED_AT_TOO_FUTURE', 'message', format('occurred_at is further in the future than the %s clock-skew tolerance.', v_clock_skew_tolerance), 'field', 'occurred_at'));
  end if;
  if p_local_date not between (p_occurred_at at time zone 'UTC')::date - 1
                          and (p_occurred_at at time zone 'UTC')::date + 1 then
    return jsonb_build_object('error', jsonb_build_object(
      'code', 'LOCAL_DATE_OUT_OF_BOUNDS', 'message', 'local_date must be within one day of occurred_at (UTC).', 'field', 'local_date'));
  end if;
  if p_activity_type_code is not null and not exists (
    select 1 from public.activity_types where code = p_activity_type_code
  ) then
    return jsonb_build_object('error', jsonb_build_object('code', 'VALIDATION_ERROR', 'message', 'activity_type_code does not exist.', 'field', 'activity_type_code'));
  end if;

  -- Consent pre-check (§6): an active health consent is required for
  -- energy_source = 'estimated'. The DB trigger
  -- (enforce_manual_calorie_burn_logs_integrity) enforces this
  -- unconditionally regardless of write path; this RPC-layer check exists
  -- only to surface a clean CONSENT_REQUIRED_HEALTH error before attempting
  -- the write, mirroring save_workout_session_v1's identical belt-and-
  -- suspenders pattern for calories_source = 'estimated'.
  if p_energy_source = 'estimated' and not exists (
    select 1 from public.user_consents where user_id = v_user_id and category = 'health' and revoked_at is null
  ) then
    return jsonb_build_object('error', jsonb_build_object(
      'code', 'CONSENT_REQUIRED_HEALTH', 'message', 'An active health consent is required for estimated energy_source.', 'field', 'energy_source'));
  end if;

  v_duration_seconds := case when p_duration_minutes is not null then p_duration_minutes * 60 else null end;

  begin
    with upsert as (
      insert into public.timeline_events (
        id, user_id, source_module, event_type, occurred_at, local_date, event_timezone,
        energy_kcal, duration_seconds, source, visibility, client_created_at
      ) values (
        p_id, v_user_id, 'nutrition', 'manual_calorie_burn', p_occurred_at, p_local_date, p_event_timezone,
        p_energy_kcal, v_duration_seconds, p_source, 'private', p_client_created_at
      )
      on conflict (id) do update set
        occurred_at      = excluded.occurred_at,
        local_date       = excluded.local_date,
        event_timezone   = excluded.event_timezone,
        energy_kcal      = excluded.energy_kcal,
        duration_seconds = excluded.duration_seconds
      where timeline_events.user_id = v_user_id
      returning id
    )
    select count(*) into v_rows_affected from upsert;

    if v_rows_affected = 0 then
      return jsonb_build_object('error', jsonb_build_object(
        'code', 'ID_CONFLICT', 'message', 'The provided id is already in use by a different record.', 'field', 'id'));
    end if;

    with upsert as (
      insert into public.manual_calorie_burn_logs (
        timeline_event_id, user_id, label, activity_type_code, duration_minutes, energy_source, notes
      ) values (
        p_id, v_user_id, p_label, p_activity_type_code, p_duration_minutes, p_energy_source, p_notes
      )
      on conflict (timeline_event_id) do update set
        label              = excluded.label,
        activity_type_code = excluded.activity_type_code,
        duration_minutes   = excluded.duration_minutes,
        energy_source      = excluded.energy_source,
        notes              = excluded.notes
      where manual_calorie_burn_logs.user_id = v_user_id
      returning timeline_event_id
    )
    select count(*) into v_rows_affected from upsert;

    if v_rows_affected = 0 then
      return jsonb_build_object('error', jsonb_build_object(
        'code', 'ID_CONFLICT', 'message', 'The manual burn detail row could not be written (ownership conflict).', 'field', 'id'));
    end if;

  exception when others then
    return jsonb_build_object('error', jsonb_build_object(
      'code',
        case sqlstate
          when '42501' then 'CONSENT_REQUIRED_HEALTH'
          when '23505' then 'ID_CONFLICT'
          when '23514' then 'VALIDATION_ERROR'
          when '22P02' then 'VALIDATION_ERROR'
          else 'WRITE_FAILED'
        end,
      'message', sqlerrm,
      'field', null
    ));
  end;

  -- ---------------------------------------------------------------------
  -- Non-blocking overlap advisory (§4.3, §12 decision 2). Computed AFTER the
  -- write already succeeded -- this never gates the save. Overlap test:
  -- [p_occurred_at, v_window_end) intersects [te.occurred_at,
  -- te.occurred_at + te.duration_seconds) for any of the caller's own
  -- gps_activity/strength_session events that already carry a populated,
  -- negative energy_kcal (i.e. already counted in today's burn).
  -- ---------------------------------------------------------------------
  v_window_end := p_occurred_at + case
    when p_duration_minutes is not null then (p_duration_minutes || ' minutes')::interval
    else v_default_advisory_window
  end;

  select coalesce(jsonb_agg(jsonb_build_object(
           'timeline_event_id', te.id,
           'event_type', te.event_type,
           'occurred_at', te.occurred_at,
           'duration_seconds', te.duration_seconds,
           'energy_kcal', te.energy_kcal
         ) order by te.occurred_at), '[]'::jsonb)
    into v_overlap_events
  from public.timeline_events te
  where te.user_id = v_user_id
    and te.id <> p_id
    and te.deleted_at is null
    and te.event_type in ('gps_activity', 'strength_session')
    and te.energy_kcal is not null
    and te.energy_kcal < 0
    and te.occurred_at < v_window_end
    and (te.occurred_at + (coalesce(te.duration_seconds, 0) || ' seconds')::interval) > p_occurred_at;

  v_has_overlap := jsonb_array_length(v_overlap_events) > 0;

  return jsonb_build_object('data', jsonb_build_object(
    'id', p_id,
    'occurred_at', p_occurred_at,
    'local_date', p_local_date,
    'energy_kcal', p_energy_kcal,
    'label', p_label,
    'energy_source', p_energy_source,
    'duration_minutes', p_duration_minutes,
    'overlap_advisory', jsonb_build_object(
      'has_overlap', v_has_overlap,
      'overlapping_events', v_overlap_events
    )
  ));
end;
$$;

comment on function public.save_manual_burn_v1(
  uuid, timestamptz, date, text, numeric, text, public.manual_burn_energy_source,
  text, integer, text, public.timeline_source, timestamptz
) is
  'Phase 3 Module B CORE-11 save RPC (§1.8/§5). SECURITY INVOKER, transactional '
  'across timeline_events + manual_calorie_burn_logs, PLUS the non-blocking '
  'overlap advisory (§4.3/§12 decision 2): the save ALWAYS succeeds regardless '
  'of overlap; data.overlap_advisory.has_overlap/overlapping_events is purely '
  'informational for the client to warn the user, never a block/merge/'
  'suppression.';

revoke execute on function public.save_manual_burn_v1(
  uuid, timestamptz, date, text, numeric, text, public.manual_burn_energy_source,
  text, integer, text, public.timeline_source, timestamptz
) from public, anon;

grant execute on function public.save_manual_burn_v1(
  uuid, timestamptz, date, text, numeric, text, public.manual_burn_energy_source,
  text, integer, text, public.timeline_source, timestamptz
) to authenticated;
