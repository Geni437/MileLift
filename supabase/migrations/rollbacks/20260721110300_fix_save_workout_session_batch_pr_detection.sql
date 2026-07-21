-- Rollback for 20260721110300_fix_save_workout_session_batch_pr_detection.sql
--
-- Restores public.save_workout_session_v1 to its exact 20260721110000 form
-- (inline per-set PR detection) -- reintroduces the duplicate-achievement
-- bug this migration fixed (an ascending/pyramid multi-set payload for the
-- same exercise logs one achievement per set instead of one per exercise
-- per metric per call). Exists for convention-consistency / emergency-revert
-- only; reverting is never the correct choice while this bug is understood.
--
-- Does not touch any table schema or data -- this migration only ever
-- changed a function body.
--
-- Safe to re-run (CREATE OR REPLACE is itself idempotent).

create or replace function public.save_workout_session_v1(
  p_id                        uuid,
  p_occurred_at               timestamptz,
  p_local_date                date,
  p_event_timezone            text,
  p_duration_seconds          integer,
  p_sets                      jsonb default '[]'::jsonb,
  p_source                    public.timeline_source default 'manual',
  p_visibility                public.timeline_visibility default 'private',
  p_energy_kcal               numeric default null,
  p_title                     text default null,
  p_notes                     text default null,
  p_source_template_id        uuid default null,
  p_template_name_snapshot    text default null,
  p_session_rpe               numeric default null,
  p_calories_source           public.activity_calories_source default 'none',
  p_client_created_at         timestamptz default null
)
returns jsonb
language plpgsql
security invoker
set search_path = public, pg_temp
as $$
declare
  v_user_id                  uuid;
  v_idx                       integer;
  v_set                        jsonb;
  v_set_count                   integer;
  v_set_id                       uuid;
  v_exercise_id                   uuid;
  v_custom_exercise_id             uuid;
  v_exercise_name_snapshot          text;
  v_primary_muscle_snapshot          text;
  v_exercise_order                    integer;
  v_set_number                         integer;
  v_set_type                            text;
  v_reps                                 integer;
  v_weight_kg                             numeric;
  v_unit_weight_snapshot                   text;
  v_is_bodyweight                           boolean;
  v_set_duration_seconds                     integer;
  v_distance_m                                numeric;
  v_rpe                                        numeric;
  v_rest_planned                                integer;
  v_rest_actual                                  integer;
  v_is_completed                                  boolean;
  v_set_notes                                      text;
  v_deleted_at                                      timestamptz;
  v_estimated_1rm                                    numeric;
  v_ex_is_weighted                                    boolean;
  v_ex_is_bodyweight                                   boolean;
  v_rows_affected                                       integer;
  v_load_score                                           numeric;
  v_total_volume_kg                                       numeric;
  v_total_sets                                             integer;
  v_achievements                                            jsonb;
  v_clock_skew_tolerance constant interval := interval '24 hours'; -- mirrors trg_timeline_events_clock_skew
  v_epley_reps_divisor   constant numeric := 30.0; -- Epley: 1RM = weight * (1 + reps/30), §4.2
begin
  v_user_id := auth.uid();
  if v_user_id is null then
    return jsonb_build_object('error', jsonb_build_object(
      'code', 'UNAUTHENTICATED', 'message', 'No authenticated user context.', 'field', null));
  end if;

  -- ---------------------------------------------------------------------
  -- Pass 1: top-level required-field / business-invariant validation
  -- (production-standards: validate at the boundary, never trust client
  -- input).
  -- ---------------------------------------------------------------------
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
  if p_duration_seconds is null then
    return jsonb_build_object('error', jsonb_build_object('code', 'VALIDATION_ERROR', 'message', 'duration_seconds is required.', 'field', 'duration_seconds'));
  end if;
  if p_sets is null or jsonb_typeof(p_sets) <> 'array' then
    return jsonb_build_object('error', jsonb_build_object('code', 'VALIDATION_ERROR', 'message', 'sets must be a JSON array (may be empty).', 'field', 'sets'));
  end if;

  if p_source not in ('manual', 'wearable', 'import') then
    return jsonb_build_object('error', jsonb_build_object(
      'code', 'INVALID_SOURCE', 'message', 'source must be one of manual, wearable, import for a workout session.', 'field', 'source'));
  end if;

  if p_duration_seconds < 0 then
    return jsonb_build_object('error', jsonb_build_object('code', 'NEGATIVE_MEASUREMENT', 'message', 'duration_seconds must be >= 0.', 'field', 'duration_seconds'));
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

  if p_energy_kcal is not null and p_energy_kcal > 0 then
    return jsonb_build_object('error', jsonb_build_object(
      'code', 'INVALID_ENERGY_SIGN', 'message', 'energy_kcal must be <= 0 for a workout session (expenditure).', 'field', 'energy_kcal'));
  end if;

  if p_calories_source = 'none' and p_energy_kcal is not null then
    return jsonb_build_object('error', jsonb_build_object(
      'code', 'CALORIES_SOURCE_ENERGY_MISMATCH', 'message', 'energy_kcal must be null when calories_source is none.', 'field', 'calories_source'));
  end if;

  if p_session_rpe is not null and (p_session_rpe < 0 or p_session_rpe > 10) then
    return jsonb_build_object('error', jsonb_build_object(
      'code', 'RPE_OUT_OF_RANGE', 'message', 'session_rpe must be between 0 and 10.', 'field', 'session_rpe'));
  end if;

  if p_source_template_id is not null and not exists (
    select 1 from public.workout_templates where id = p_source_template_id and user_id = v_user_id
  ) then
    return jsonb_build_object('error', jsonb_build_object(
      'code', 'TEMPLATE_NOT_FOUND', 'message', 'source_template_id does not exist or is not owned by the caller.', 'field', 'source_template_id'));
  end if;

  -- Consent gate: calorie ESTIMATION needs bodyweight, same health-consent
  -- gate as Module A's HR data (§6, §12 item: "Estimation needs bodyweight+
  -- consent, same gate as Module A"). Wearable/manual sources are not gated
  -- here -- they aren't derived from the user's bodyweight.
  if p_calories_source = 'estimated' and p_energy_kcal is not null and not exists (
    select 1 from public.user_consents where user_id = v_user_id and category = 'health' and revoked_at is null
  ) then
    return jsonb_build_object('error', jsonb_build_object(
      'code', 'CONSENT_REQUIRED_HEALTH', 'message', 'An active health consent is required for calorie estimation.', 'field', 'calories_source'));
  end if;

  -- ---------------------------------------------------------------------
  -- Pass 2: validate every set BEFORE writing anything, so an invalid set
  -- anywhere in the payload never results in a partial write.
  -- ---------------------------------------------------------------------
  v_set_count := jsonb_array_length(p_sets);

  for v_idx in 0 .. v_set_count - 1 loop
    v_set := p_sets -> v_idx;

    if v_set ->> 'id' is null then
      return jsonb_build_object('error', jsonb_build_object('code', 'VALIDATION_ERROR', 'message', 'id is required.', 'field', format('sets[%s].id', v_idx)));
    end if;
    begin
      v_set_id := (v_set ->> 'id')::uuid;
    exception when others then
      return jsonb_build_object('error', jsonb_build_object('code', 'VALIDATION_ERROR', 'message', 'id must be a valid uuid.', 'field', format('sets[%s].id', v_idx)));
    end;

    begin
      v_exercise_id := nullif(v_set ->> 'exercise_id', '')::uuid;
      v_custom_exercise_id := nullif(v_set ->> 'custom_exercise_id', '')::uuid;
    exception when others then
      return jsonb_build_object('error', jsonb_build_object('code', 'VALIDATION_ERROR', 'message', 'exercise_id/custom_exercise_id must be valid uuids.', 'field', format('sets[%s].exercise_id', v_idx)));
    end;

    if (v_exercise_id is not null)::int + (v_custom_exercise_id is not null)::int <> 1 then
      return jsonb_build_object('error', jsonb_build_object(
        'code', 'INVALID_EXERCISE_REF', 'message', 'Exactly one of exercise_id or custom_exercise_id is required.', 'field', format('sets[%s].exercise_id', v_idx)));
    end if;

    if v_exercise_id is not null and not exists (select 1 from public.exercises where id = v_exercise_id) then
      return jsonb_build_object('error', jsonb_build_object(
        'code', 'EXERCISE_NOT_FOUND', 'message', 'exercise_id does not exist in the library.', 'field', format('sets[%s].exercise_id', v_idx)));
    end if;
    if v_custom_exercise_id is not null and not exists (
      select 1 from public.custom_exercises where id = v_custom_exercise_id and user_id = v_user_id
    ) then
      return jsonb_build_object('error', jsonb_build_object(
        'code', 'EXERCISE_NOT_FOUND', 'message', 'custom_exercise_id does not exist or is not owned by the caller.', 'field', format('sets[%s].custom_exercise_id', v_idx)));
    end if;

    v_exercise_name_snapshot := v_set ->> 'exercise_name_snapshot';
    if v_exercise_name_snapshot is null or length(trim(v_exercise_name_snapshot)) = 0 then
      return jsonb_build_object('error', jsonb_build_object('code', 'VALIDATION_ERROR', 'message', 'exercise_name_snapshot is required.', 'field', format('sets[%s].exercise_name_snapshot', v_idx)));
    end if;

    if v_set ->> 'primary_muscle_snapshot' is not null then
      begin
        perform (v_set ->> 'primary_muscle_snapshot')::public.muscle_group;
      exception when others then
        return jsonb_build_object('error', jsonb_build_object('code', 'VALIDATION_ERROR', 'message', 'primary_muscle_snapshot is not a valid muscle_group.', 'field', format('sets[%s].primary_muscle_snapshot', v_idx)));
      end;
    end if;

    if v_set ->> 'exercise_order' is null then
      return jsonb_build_object('error', jsonb_build_object('code', 'VALIDATION_ERROR', 'message', 'exercise_order is required.', 'field', format('sets[%s].exercise_order', v_idx)));
    end if;
    v_exercise_order := (v_set ->> 'exercise_order')::integer;
    if v_exercise_order < 0 then
      return jsonb_build_object('error', jsonb_build_object('code', 'NEGATIVE_MEASUREMENT', 'message', 'exercise_order must be >= 0.', 'field', format('sets[%s].exercise_order', v_idx)));
    end if;

    if v_set ->> 'set_number' is null then
      return jsonb_build_object('error', jsonb_build_object('code', 'VALIDATION_ERROR', 'message', 'set_number is required.', 'field', format('sets[%s].set_number', v_idx)));
    end if;
    v_set_number := (v_set ->> 'set_number')::integer;
    if v_set_number < 1 then
      return jsonb_build_object('error', jsonb_build_object('code', 'VALIDATION_ERROR', 'message', 'set_number must be >= 1.', 'field', format('sets[%s].set_number', v_idx)));
    end if;

    v_set_type := coalesce(v_set ->> 'set_type', 'working');
    begin
      perform v_set_type::public.workout_set_type;
    exception when others then
      return jsonb_build_object('error', jsonb_build_object('code', 'VALIDATION_ERROR', 'message', 'set_type is not a valid value.', 'field', format('sets[%s].set_type', v_idx)));
    end;

    begin
      v_reps := nullif(v_set ->> 'reps', '')::integer;
    exception when others then
      return jsonb_build_object('error', jsonb_build_object('code', 'VALIDATION_ERROR', 'message', 'reps must be an integer.', 'field', format('sets[%s].reps', v_idx)));
    end;
    if v_reps is not null and v_reps < 0 then
      return jsonb_build_object('error', jsonb_build_object('code', 'NEGATIVE_MEASUREMENT', 'message', 'reps must be >= 0.', 'field', format('sets[%s].reps', v_idx)));
    end if;

    begin
      v_weight_kg := nullif(v_set ->> 'weight_kg', '')::numeric;
    exception when others then
      return jsonb_build_object('error', jsonb_build_object('code', 'VALIDATION_ERROR', 'message', 'weight_kg must be numeric.', 'field', format('sets[%s].weight_kg', v_idx)));
    end;
    if v_weight_kg is not null and v_weight_kg < 0 then
      return jsonb_build_object('error', jsonb_build_object('code', 'NEGATIVE_MEASUREMENT', 'message', 'weight_kg must be >= 0.', 'field', format('sets[%s].weight_kg', v_idx)));
    end if;

    v_unit_weight_snapshot := v_set ->> 'unit_weight_snapshot';
    if v_unit_weight_snapshot is null or v_unit_weight_snapshot not in ('kg', 'lb') then
      return jsonb_build_object('error', jsonb_build_object('code', 'INVALID_UNIT', 'message', 'unit_weight_snapshot must be kg or lb.', 'field', format('sets[%s].unit_weight_snapshot', v_idx)));
    end if;

    begin
      v_set_duration_seconds := nullif(v_set ->> 'duration_seconds', '')::integer;
    exception when others then
      return jsonb_build_object('error', jsonb_build_object('code', 'VALIDATION_ERROR', 'message', 'duration_seconds must be an integer.', 'field', format('sets[%s].duration_seconds', v_idx)));
    end;
    if v_set_duration_seconds is not null and v_set_duration_seconds < 0 then
      return jsonb_build_object('error', jsonb_build_object('code', 'NEGATIVE_MEASUREMENT', 'message', 'duration_seconds must be >= 0.', 'field', format('sets[%s].duration_seconds', v_idx)));
    end if;

    begin
      v_distance_m := nullif(v_set ->> 'distance_m', '')::numeric;
    exception when others then
      return jsonb_build_object('error', jsonb_build_object('code', 'VALIDATION_ERROR', 'message', 'distance_m must be numeric.', 'field', format('sets[%s].distance_m', v_idx)));
    end;
    if v_distance_m is not null and v_distance_m < 0 then
      return jsonb_build_object('error', jsonb_build_object('code', 'NEGATIVE_MEASUREMENT', 'message', 'distance_m must be >= 0.', 'field', format('sets[%s].distance_m', v_idx)));
    end if;

    begin
      v_rpe := nullif(v_set ->> 'rpe', '')::numeric;
    exception when others then
      return jsonb_build_object('error', jsonb_build_object('code', 'VALIDATION_ERROR', 'message', 'rpe must be numeric.', 'field', format('sets[%s].rpe', v_idx)));
    end;
    if v_rpe is not null and (v_rpe < 0 or v_rpe > 10) then
      return jsonb_build_object('error', jsonb_build_object('code', 'RPE_OUT_OF_RANGE', 'message', 'rpe must be between 0 and 10.', 'field', format('sets[%s].rpe', v_idx)));
    end if;

    begin
      v_rest_planned := nullif(v_set ->> 'rest_seconds_planned', '')::integer;
    exception when others then
      return jsonb_build_object('error', jsonb_build_object('code', 'VALIDATION_ERROR', 'message', 'rest_seconds_planned must be an integer.', 'field', format('sets[%s].rest_seconds_planned', v_idx)));
    end;
    if v_rest_planned is not null and v_rest_planned < 0 then
      return jsonb_build_object('error', jsonb_build_object('code', 'NEGATIVE_MEASUREMENT', 'message', 'rest_seconds_planned must be >= 0.', 'field', format('sets[%s].rest_seconds_planned', v_idx)));
    end if;

    begin
      v_rest_actual := nullif(v_set ->> 'rest_seconds_actual', '')::integer;
    exception when others then
      return jsonb_build_object('error', jsonb_build_object('code', 'VALIDATION_ERROR', 'message', 'rest_seconds_actual must be an integer.', 'field', format('sets[%s].rest_seconds_actual', v_idx)));
    end;
    if v_rest_actual is not null and v_rest_actual < 0 then
      return jsonb_build_object('error', jsonb_build_object('code', 'NEGATIVE_MEASUREMENT', 'message', 'rest_seconds_actual must be >= 0.', 'field', format('sets[%s].rest_seconds_actual', v_idx)));
    end if;
  end loop;

  -- ---------------------------------------------------------------------
  -- Transactional writes. Any exception from here rolls back everything
  -- already written in this call (implicit savepoint) and returns the error
  -- envelope instead of a partial write or a raw Postgres error.
  -- ---------------------------------------------------------------------
  begin
    v_load_score := case when p_session_rpe is not null then p_session_rpe * (p_duration_seconds / 60.0) else null end;

    with upsert as (
      insert into public.timeline_events (
        id, user_id, source_module, event_type, occurred_at, local_date, event_timezone,
        energy_kcal, load_score, duration_seconds, source, visibility, client_created_at
      )
      values (
        p_id, v_user_id, 'strength', 'strength_session', p_occurred_at, p_local_date, p_event_timezone,
        p_energy_kcal, v_load_score, p_duration_seconds, p_source, p_visibility, p_client_created_at
      )
      on conflict (id) do update set
        occurred_at      = excluded.occurred_at,
        local_date       = excluded.local_date,
        event_timezone   = excluded.event_timezone,
        energy_kcal      = excluded.energy_kcal,
        load_score       = excluded.load_score,
        duration_seconds = excluded.duration_seconds,
        visibility       = excluded.visibility
      where timeline_events.user_id = v_user_id
      returning id
    )
    select count(*) into v_rows_affected from upsert;

    if v_rows_affected = 0 then
      return jsonb_build_object('error', jsonb_build_object(
        'code', 'ID_CONFLICT', 'message', 'The provided id is already in use by a different record.', 'field', 'id'));
    end if;

    with upsert as (
      insert into public.workout_sessions (
        timeline_event_id, user_id, title, notes, source_template_id, template_name_snapshot,
        session_rpe, calories_source
      )
      values (
        p_id, v_user_id, p_title, p_notes, p_source_template_id, p_template_name_snapshot,
        p_session_rpe, p_calories_source
      )
      on conflict (timeline_event_id) do update set
        title                   = excluded.title,
        notes                   = excluded.notes,
        source_template_id      = excluded.source_template_id,
        template_name_snapshot  = excluded.template_name_snapshot,
        session_rpe             = excluded.session_rpe,
        calories_source         = excluded.calories_source
      where workout_sessions.user_id = v_user_id
      returning timeline_event_id
    )
    select count(*) into v_rows_affected from upsert;

    if v_rows_affected = 0 then
      return jsonb_build_object('error', jsonb_build_object(
        'code', 'ID_CONFLICT', 'message', 'The workout session detail row could not be written (ownership conflict).', 'field', 'id'));
    end if;

    -- Pass 3: upsert every set (re-parsing the already-validated payload;
    -- cheap at this bounded per-session scale) + inline PR detection.
    for v_idx in 0 .. v_set_count - 1 loop
      v_set := p_sets -> v_idx;

      v_set_id := (v_set ->> 'id')::uuid;
      v_exercise_id := nullif(v_set ->> 'exercise_id', '')::uuid;
      v_custom_exercise_id := nullif(v_set ->> 'custom_exercise_id', '')::uuid;
      v_exercise_name_snapshot := v_set ->> 'exercise_name_snapshot';
      v_primary_muscle_snapshot := v_set ->> 'primary_muscle_snapshot';
      v_exercise_order := (v_set ->> 'exercise_order')::integer;
      v_set_number := (v_set ->> 'set_number')::integer;
      v_set_type := coalesce(v_set ->> 'set_type', 'working');
      v_reps := nullif(v_set ->> 'reps', '')::integer;
      v_weight_kg := nullif(v_set ->> 'weight_kg', '')::numeric;
      v_unit_weight_snapshot := v_set ->> 'unit_weight_snapshot';
      v_is_bodyweight := coalesce((v_set ->> 'is_bodyweight')::boolean, false);
      v_set_duration_seconds := nullif(v_set ->> 'duration_seconds', '')::integer;
      v_distance_m := nullif(v_set ->> 'distance_m', '')::numeric;
      v_rpe := nullif(v_set ->> 'rpe', '')::numeric;
      v_rest_planned := nullif(v_set ->> 'rest_seconds_planned', '')::integer;
      v_rest_actual := nullif(v_set ->> 'rest_seconds_actual', '')::integer;
      v_is_completed := coalesce((v_set ->> 'is_completed')::boolean, true);
      v_set_notes := v_set ->> 'notes';
      v_deleted_at := nullif(v_set ->> 'deleted_at', '')::timestamptz;

      -- Epley 1RM (§4.2), server-computed, snapshotted regardless of
      -- set_type/completion so history is stable; PR eligibility below
      -- separately restricts detection to working+completed, non-deleted sets.
      v_estimated_1rm := case
        when v_weight_kg is not null and v_reps is not null and v_reps > 0
          then round(v_weight_kg * (1 + v_reps / v_epley_reps_divisor), 2)
        else null
      end;

      with upsert as (
        insert into public.workout_set_logs (
          id, timeline_event_id, user_id, exercise_id, custom_exercise_id,
          exercise_name_snapshot, primary_muscle_snapshot, exercise_order, set_number, set_type,
          reps, weight_kg, unit_weight_snapshot, is_bodyweight, duration_seconds, distance_m,
          rpe, rest_seconds_planned, rest_seconds_actual, is_completed, estimated_1rm_kg, notes, deleted_at
        )
        values (
          v_set_id, p_id, v_user_id, v_exercise_id, v_custom_exercise_id,
          v_exercise_name_snapshot, v_primary_muscle_snapshot::public.muscle_group, v_exercise_order, v_set_number, v_set_type::public.workout_set_type,
          v_reps, v_weight_kg, v_unit_weight_snapshot, v_is_bodyweight, v_set_duration_seconds, v_distance_m,
          v_rpe, v_rest_planned, v_rest_actual, v_is_completed, v_estimated_1rm, v_set_notes, v_deleted_at
        )
        on conflict (id) do update set
          set_type              = excluded.set_type,
          exercise_order        = excluded.exercise_order,
          set_number             = excluded.set_number,
          reps                    = excluded.reps,
          weight_kg               = excluded.weight_kg,
          unit_weight_snapshot     = excluded.unit_weight_snapshot,
          is_bodyweight             = excluded.is_bodyweight,
          duration_seconds           = excluded.duration_seconds,
          distance_m                  = excluded.distance_m,
          rpe                           = excluded.rpe,
          rest_seconds_planned            = excluded.rest_seconds_planned,
          rest_seconds_actual               = excluded.rest_seconds_actual,
          is_completed                        = excluded.is_completed,
          estimated_1rm_kg                      = excluded.estimated_1rm_kg,
          notes                                   = excluded.notes,
          deleted_at                               = excluded.deleted_at
        where workout_set_logs.user_id = v_user_id
          and workout_set_logs.timeline_event_id = p_id
        returning id
      )
      select count(*) into v_rows_affected from upsert;

      if v_rows_affected = 0 then
        return jsonb_build_object('error', jsonb_build_object(
          'code', 'ID_CONFLICT', 'message', 'A set id is already in use by a different session or user.', 'field', format('sets[%s].id', v_idx)));
      end if;

      -- Inline PR detection (§4.3) -- only for a currently-live, working,
      -- completed set. A tombstoned/warmup/incomplete set contributes no PR
      -- candidate here; if it demotes an existing record holder, trigger 1
      -- above reconciles that on this very write (AFTER UPDATE fires after
      -- this CTE's UPDATE branch commits within the same statement).
      if v_deleted_at is null and v_set_type = 'working' and v_is_completed then
        if v_exercise_id is not null then
          select is_weighted, is_bodyweight into v_ex_is_weighted, v_ex_is_bodyweight
          from public.exercises where id = v_exercise_id;
        else
          select is_weighted, is_bodyweight into v_ex_is_weighted, v_ex_is_bodyweight
          from public.custom_exercises where id = v_custom_exercise_id;
        end if;

        if v_ex_is_weighted then
          if v_weight_kg is not null and coalesce(v_reps, 0) >= 1 then
            perform private._strength_pr_apply_or_recompute(
              v_user_id, v_exercise_id, v_custom_exercise_id, 'heaviest_weight',
              v_weight_kg, v_unit_weight_snapshot, v_set_id, p_id, p_occurred_at
            );
          end if;
          if v_estimated_1rm is not null then
            perform private._strength_pr_apply_or_recompute(
              v_user_id, v_exercise_id, v_custom_exercise_id, 'estimated_1rm',
              v_estimated_1rm, v_unit_weight_snapshot, v_set_id, p_id, p_occurred_at
            );
          end if;
          if v_weight_kg is not null and v_reps is not null then
            perform private._strength_pr_apply_or_recompute(
              v_user_id, v_exercise_id, v_custom_exercise_id, 'best_set_volume',
              v_weight_kg * v_reps, v_unit_weight_snapshot, v_set_id, p_id, p_occurred_at
            );
          end if;
        end if;

        if v_ex_is_bodyweight and v_reps is not null then
          perform private._strength_pr_apply_or_recompute(
            v_user_id, v_exercise_id, v_custom_exercise_id, 'max_reps',
            v_reps::numeric, null, v_set_id, p_id, p_occurred_at
          );
        end if;
      end if;
    end loop;

    -- Recompute + persist session-level snapshots (§1.4, §4.4) over the
    -- CURRENT full committed state of this session's sets -- not just the
    -- sets included in this call's payload, so a partial/incremental sync
    -- payload still leaves the session's totals correct.
    select coalesce(sum(reps * weight_kg), 0)
      into v_total_volume_kg
    from public.workout_set_logs
    where timeline_event_id = p_id
      and deleted_at is null
      and set_type = 'working'
      and is_completed
      and reps is not null
      and weight_kg is not null;

    select count(*)
      into v_total_sets
    from public.workout_set_logs
    where timeline_event_id = p_id
      and deleted_at is null
      and set_type = 'working'
      and is_completed;

    update public.workout_sessions
      set total_volume_kg = v_total_volume_kg,
          total_sets       = v_total_sets
      where timeline_event_id = p_id;

    select coalesce(jsonb_agg(jsonb_build_object('metric', metric, 'value', value, 'source_set_log_id', source_set_log_id) order by metric), '[]'::jsonb)
      into v_achievements
    from public.strength_achievements
    where timeline_event_id = p_id;

  exception when others then
    return jsonb_build_object('error', jsonb_build_object(
      'code',
        case sqlstate
          when '42501' then 'CONSENT_REQUIRED' -- a seam-integrity trigger fired; pre-checks above should make this rare (race window only)
          when '23505' then 'ID_CONFLICT'
          when '23503' then 'VALIDATION_ERROR'
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
    'duration_seconds', p_duration_seconds,
    'total_volume_kg', v_total_volume_kg,
    'total_sets', v_total_sets,
    'load_score', v_load_score,
    'energy_kcal', p_energy_kcal,
    'set_count', v_set_count,
    'achievements', v_achievements
  ));
end;
$$;

comment on function public.save_workout_session_v1(
  uuid, timestamptz, date, text, integer, jsonb,
  public.timeline_source, public.timeline_visibility, numeric,
  text, text, uuid, text, numeric, public.activity_calories_source, timestamptz
) is
  'Phase 2 Module C save/finish/edit RPC (§5). SECURITY INVOKER, transactional '
  'across timeline_events + workout_sessions + workout_set_logs + PR '
  'detection. Two idempotency grains (§9.2): the session id (p_id) and each '
  'set''s own id inside p_sets. Returns {"data": {...}} on success or '
  '{"error": {"code","message","field"}} on a business-rule violation -- see '
  'docs/api/save-workout-session-v1.md for the full contract. Version-suffixed '
  'per supabase-standards: a breaking contract change ships as '
  'save_workout_session_v2, never a mutation of this function''s behavior out '
  'from under app versions already in the field.';

revoke execute on function public.save_workout_session_v1(
  uuid, timestamptz, date, text, integer, jsonb,
  public.timeline_source, public.timeline_visibility, numeric,
  text, text, uuid, text, numeric, public.activity_calories_source, timestamptz
) from public, anon;

grant execute on function public.save_workout_session_v1(
  uuid, timestamptz, date, text, integer, jsonb,
  public.timeline_source, public.timeline_visibility, numeric,
  text, text, uuid, text, numeric, public.activity_calories_source, timestamptz
) to authenticated;
