-- =============================================================================
-- Phase 2 — Module C: strength analytics RPCs (CORE-15, §4.4)
-- Design ref: docs/architecture/phase-2-module-c.md §4.4, §5
--
-- §4.4 explicitly names these two read-side aggregate RPCs ("Volume/1RM-
-- over-time and volume-per-muscle are read-side SECURITY INVOKER aggregate
-- RPCs (get_exercise_progression_v1, get_muscle_volume_v1) computed
-- server-side ... never reassembled on the client"). A plain PostgREST
-- select over workout_set_logs cannot produce a per-session aggregate or a
-- per-muscle sum without shipping every raw set row to the client and
-- summing there -- exactly what §4.4/Phase 0 §5 forbid, so these are RPCs,
-- not direct table access, per supabase-standards' "computation that
-- shouldn't live in application code" criterion.
--
-- Both are SECURITY INVOKER, read-only, and touch only tables the calling
-- user already has SELECT on via RLS -- no elevated privilege needed.
--
-- ROLLBACK: see supabase/migrations/rollbacks/20260721110100_create_strength_analytics_rpcs.sql
-- =============================================================================

-- =============================================================================
-- public.get_exercise_progression_v1(...)
--
-- Per-session time series for one exercise (library or custom): best single-
-- set weight, best estimated 1RM, session volume for that exercise, total
-- reps, and set count -- one row per session the user has non-deleted,
-- working, completed sets of this exercise in, ordered oldest-first.
-- Muscle-volume-style snapshot discipline does not apply here (this reads
-- live weight_kg/reps/estimated_1rm_kg off workout_set_logs, not a
-- snapshotted muscle name) -- exercise identity itself is the fixed axis, not
-- a rendered label, so no snapshot substitution is needed.
-- =============================================================================
create or replace function public.get_exercise_progression_v1(
  p_exercise_id         uuid default null,
  p_custom_exercise_id  uuid default null,
  p_from                date default null,
  p_to                  date default null
)
returns jsonb
language plpgsql
security invoker
set search_path = public, pg_temp
as $$
declare
  v_user_id  uuid;
  v_result    jsonb;
begin
  v_user_id := auth.uid();
  if v_user_id is null then
    return jsonb_build_object('error', jsonb_build_object('code', 'UNAUTHENTICATED', 'message', 'No authenticated user context.', 'field', null));
  end if;

  if (p_exercise_id is not null)::int + (p_custom_exercise_id is not null)::int <> 1 then
    return jsonb_build_object('error', jsonb_build_object(
      'code', 'INVALID_EXERCISE_REF', 'message', 'Exactly one of exercise_id or custom_exercise_id is required.', 'field', 'exercise_id'));
  end if;

  if p_from is not null and p_to is not null and p_from > p_to then
    return jsonb_build_object('error', jsonb_build_object(
      'code', 'VALIDATION_ERROR', 'message', 'from must be on or before to.', 'field', 'from'));
  end if;

  select coalesce(jsonb_agg(
    jsonb_build_object(
      'timeline_event_id', s.timeline_event_id,
      'occurred_at', s.occurred_at,
      'local_date', s.local_date,
      'best_weight_kg', s.best_weight_kg,
      'best_estimated_1rm_kg', s.best_estimated_1rm_kg,
      'session_volume_kg', s.session_volume_kg,
      'total_reps', s.total_reps,
      'set_count', s.set_count
    )
    order by s.occurred_at asc
  ), '[]'::jsonb)
    into v_result
  from (
    select
      te.id as timeline_event_id,
      te.occurred_at,
      te.local_date,
      max(wsl.weight_kg) filter (where wsl.weight_kg is not null and coalesce(wsl.reps, 0) >= 1) as best_weight_kg,
      max(wsl.estimated_1rm_kg) as best_estimated_1rm_kg,
      coalesce(sum(wsl.reps * wsl.weight_kg) filter (where wsl.reps is not null and wsl.weight_kg is not null), 0) as session_volume_kg,
      coalesce(sum(wsl.reps) filter (where wsl.reps is not null), 0) as total_reps,
      count(*) as set_count
    from public.workout_set_logs wsl
    join public.timeline_events te on te.id = wsl.timeline_event_id
    where wsl.user_id = v_user_id
      and te.user_id = v_user_id
      and te.deleted_at is null
      and wsl.deleted_at is null
      and wsl.set_type = 'working'
      and wsl.is_completed
      and (
        (p_exercise_id is not null and wsl.exercise_id = p_exercise_id)
        or (p_custom_exercise_id is not null and wsl.custom_exercise_id = p_custom_exercise_id)
      )
      and (p_from is null or te.local_date >= p_from)
      and (p_to is null or te.local_date <= p_to)
    group by te.id, te.occurred_at, te.local_date
  ) s;

  return jsonb_build_object('data', v_result);
exception when others then
  return jsonb_build_object('error', jsonb_build_object('code', 'READ_FAILED', 'message', sqlerrm, 'field', null));
end;
$$;

comment on function public.get_exercise_progression_v1(uuid, uuid, date, date) is
  'Phase 2 Module C CORE-15 analytics RPC (§4.4): per-session time series '
  '(best weight, best estimated 1RM, session volume, total reps, set count) '
  'for one exercise, oldest-first, optionally bounded by local_date range. '
  'SECURITY INVOKER, read-only, RLS-scoped to the caller.';

revoke execute on function public.get_exercise_progression_v1(uuid, uuid, date, date) from public, anon;
grant execute on function public.get_exercise_progression_v1(uuid, uuid, date, date) to authenticated;

-- =============================================================================
-- public.get_muscle_volume_v1(...)
--
-- Total working-set volume + set count grouped by primary_muscle_snapshot
-- (the FROZEN muscle label recorded at log time, not a live join to
-- exercises/custom_exercises) over an optional date range, so a later
-- re-categorization of a library/custom movement never shifts a historical
-- period's muscle-volume breakdown (§3, §4.4: "Muscle-volume uses the
-- snapshot muscle so historical attribution is stable").
-- =============================================================================
create or replace function public.get_muscle_volume_v1(
  p_from date default null,
  p_to   date default null
)
returns jsonb
language plpgsql
security invoker
set search_path = public, pg_temp
as $$
declare
  v_user_id  uuid;
  v_result    jsonb;
begin
  v_user_id := auth.uid();
  if v_user_id is null then
    return jsonb_build_object('error', jsonb_build_object('code', 'UNAUTHENTICATED', 'message', 'No authenticated user context.', 'field', null));
  end if;

  if p_from is not null and p_to is not null and p_from > p_to then
    return jsonb_build_object('error', jsonb_build_object(
      'code', 'VALIDATION_ERROR', 'message', 'from must be on or before to.', 'field', 'from'));
  end if;

  select coalesce(jsonb_agg(
    jsonb_build_object(
      'primary_muscle', m.primary_muscle_snapshot,
      'total_volume_kg', m.total_volume_kg,
      'set_count', m.set_count
    )
    order by m.total_volume_kg desc
  ), '[]'::jsonb)
    into v_result
  from (
    select
      wsl.primary_muscle_snapshot,
      coalesce(sum(wsl.reps * wsl.weight_kg) filter (where wsl.reps is not null and wsl.weight_kg is not null), 0) as total_volume_kg,
      count(*) as set_count
    from public.workout_set_logs wsl
    join public.timeline_events te on te.id = wsl.timeline_event_id
    where wsl.user_id = v_user_id
      and te.user_id = v_user_id
      and te.deleted_at is null
      and wsl.deleted_at is null
      and wsl.set_type = 'working'
      and wsl.is_completed
      and wsl.primary_muscle_snapshot is not null
      and (p_from is null or te.local_date >= p_from)
      and (p_to is null or te.local_date <= p_to)
    group by wsl.primary_muscle_snapshot
  ) m;

  return jsonb_build_object('data', v_result);
exception when others then
  return jsonb_build_object('error', jsonb_build_object('code', 'READ_FAILED', 'message', sqlerrm, 'field', null));
end;
$$;

comment on function public.get_muscle_volume_v1(date, date) is
  'Phase 2 Module C CORE-15 analytics RPC (§4.4): total working-set volume + '
  'set count grouped by primary_muscle_snapshot (the frozen per-set label, '
  'not a live exercises join), optionally bounded by local_date range. '
  'SECURITY INVOKER, read-only, RLS-scoped to the caller.';

revoke execute on function public.get_muscle_volume_v1(date, date) from public, anon;
grant execute on function public.get_muscle_volume_v1(date, date) to authenticated;
