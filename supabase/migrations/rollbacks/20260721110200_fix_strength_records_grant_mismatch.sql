-- Rollback for 20260721110200_fix_strength_records_grant_mismatch.sql
--
-- Restores private._strength_pr_recompute_metric and
-- private._strength_pr_apply_or_recompute to their exact 20260721110000 form
-- (INSERT ... ON CONFLICT DO UPDATE) -- reintroduces the live-confirmed
-- "permission denied for table strength_records" bug this migration fixed
-- (db-engineer's strength_records UPDATE grant omits timeline_event_id).
-- Exists for convention-consistency / emergency-revert only; reverting is
-- never the correct choice while this bug is understood.
--
-- Does not touch strength_records/strength_achievements table schema or
-- data -- this migration only ever changed function bodies.
--
-- Safe to re-run (CREATE OR REPLACE is itself idempotent).

create or replace function private._strength_pr_recompute_metric(
  p_user_id             uuid,
  p_exercise_id         uuid,
  p_custom_exercise_id  uuid,
  p_metric              public.strength_pr_metric
)
returns void
language plpgsql
security invoker
set search_path = public, pg_temp
as $$
declare
  v_old_value          numeric;
  v_value               numeric;
  v_unit_snapshot       text;
  v_source_set_log_id   uuid;
  v_timeline_event_id   uuid;
  v_achieved_at         timestamptz;
begin
  if p_exercise_id is not null then
    select value into v_old_value
    from public.strength_records
    where user_id = p_user_id and exercise_id = p_exercise_id and metric = p_metric;
  else
    select value into v_old_value
    from public.strength_records
    where user_id = p_user_id and custom_exercise_id = p_custom_exercise_id and metric = p_metric;
  end if;

  if p_metric = 'heaviest_weight' then
    select wsl.weight_kg, wsl.unit_weight_snapshot, wsl.id, wsl.timeline_event_id, te.occurred_at
      into v_value, v_unit_snapshot, v_source_set_log_id, v_timeline_event_id, v_achieved_at
    from public.workout_set_logs wsl
    join public.timeline_events te on te.id = wsl.timeline_event_id
    where wsl.user_id = p_user_id
      and (
        (p_exercise_id is not null and wsl.exercise_id = p_exercise_id)
        or (p_custom_exercise_id is not null and wsl.custom_exercise_id = p_custom_exercise_id)
      )
      and wsl.deleted_at is null
      and wsl.set_type = 'working'
      and wsl.is_completed
      and wsl.weight_kg is not null
      and coalesce(wsl.reps, 0) >= 1
      and te.deleted_at is null
    order by wsl.weight_kg desc, te.occurred_at asc
    limit 1;

  elsif p_metric = 'estimated_1rm' then
    select wsl.estimated_1rm_kg, wsl.unit_weight_snapshot, wsl.id, wsl.timeline_event_id, te.occurred_at
      into v_value, v_unit_snapshot, v_source_set_log_id, v_timeline_event_id, v_achieved_at
    from public.workout_set_logs wsl
    join public.timeline_events te on te.id = wsl.timeline_event_id
    where wsl.user_id = p_user_id
      and (
        (p_exercise_id is not null and wsl.exercise_id = p_exercise_id)
        or (p_custom_exercise_id is not null and wsl.custom_exercise_id = p_custom_exercise_id)
      )
      and wsl.deleted_at is null
      and wsl.set_type = 'working'
      and wsl.is_completed
      and wsl.estimated_1rm_kg is not null
      and te.deleted_at is null
    order by wsl.estimated_1rm_kg desc, te.occurred_at asc
    limit 1;

  elsif p_metric = 'best_set_volume' then
    select (wsl.reps * wsl.weight_kg), wsl.unit_weight_snapshot, wsl.id, wsl.timeline_event_id, te.occurred_at
      into v_value, v_unit_snapshot, v_source_set_log_id, v_timeline_event_id, v_achieved_at
    from public.workout_set_logs wsl
    join public.timeline_events te on te.id = wsl.timeline_event_id
    where wsl.user_id = p_user_id
      and (
        (p_exercise_id is not null and wsl.exercise_id = p_exercise_id)
        or (p_custom_exercise_id is not null and wsl.custom_exercise_id = p_custom_exercise_id)
      )
      and wsl.deleted_at is null
      and wsl.set_type = 'working'
      and wsl.is_completed
      and wsl.reps is not null
      and wsl.weight_kg is not null
      and te.deleted_at is null
    order by (wsl.reps * wsl.weight_kg) desc, te.occurred_at asc
    limit 1;

  elsif p_metric = 'max_reps' then
    select wsl.reps::numeric, null::text, wsl.id, wsl.timeline_event_id, te.occurred_at
      into v_value, v_unit_snapshot, v_source_set_log_id, v_timeline_event_id, v_achieved_at
    from public.workout_set_logs wsl
    join public.timeline_events te on te.id = wsl.timeline_event_id
    where wsl.user_id = p_user_id
      and (
        (p_exercise_id is not null and wsl.exercise_id = p_exercise_id)
        or (p_custom_exercise_id is not null and wsl.custom_exercise_id = p_custom_exercise_id)
      )
      and wsl.deleted_at is null
      and wsl.set_type = 'working'
      and wsl.is_completed
      and wsl.reps is not null
      and te.deleted_at is null
    order by wsl.reps desc, te.occurred_at asc
    limit 1;

  else
    raise exception
      'Strength PR recompute for metric % is not implemented in Phase 2 (reserved, §1.10/§4.1)',
      p_metric
      using errcode = '0A000';
  end if;

  if v_source_set_log_id is null then
    if p_exercise_id is not null then
      delete from public.strength_records
      where user_id = p_user_id and exercise_id = p_exercise_id and metric = p_metric;
    else
      delete from public.strength_records
      where user_id = p_user_id and custom_exercise_id = p_custom_exercise_id and metric = p_metric;
    end if;
    return;
  end if;

  if p_exercise_id is not null then
    insert into public.strength_records (
      user_id, exercise_id, metric, value, unit_snapshot,
      source_set_log_id, timeline_event_id, achieved_at, previous_value
    )
    values (
      p_user_id, p_exercise_id, p_metric, v_value, v_unit_snapshot,
      v_source_set_log_id, v_timeline_event_id, v_achieved_at, v_old_value
    )
    on conflict (user_id, exercise_id, metric) where exercise_id is not null do update set
      value             = excluded.value,
      unit_snapshot     = excluded.unit_snapshot,
      source_set_log_id = excluded.source_set_log_id,
      timeline_event_id = excluded.timeline_event_id,
      achieved_at       = excluded.achieved_at,
      previous_value    = strength_records.value;
  else
    insert into public.strength_records (
      user_id, custom_exercise_id, metric, value, unit_snapshot,
      source_set_log_id, timeline_event_id, achieved_at, previous_value
    )
    values (
      p_user_id, p_custom_exercise_id, p_metric, v_value, v_unit_snapshot,
      v_source_set_log_id, v_timeline_event_id, v_achieved_at, v_old_value
    )
    on conflict (user_id, custom_exercise_id, metric) where custom_exercise_id is not null do update set
      value             = excluded.value,
      unit_snapshot     = excluded.unit_snapshot,
      source_set_log_id = excluded.source_set_log_id,
      timeline_event_id = excluded.timeline_event_id,
      achieved_at       = excluded.achieved_at,
      previous_value    = strength_records.value;
  end if;
end;
$$;

comment on function private._strength_pr_recompute_metric(uuid, uuid, uuid, public.strength_pr_metric) is
  'Bounded, indexed best-value recompute for one (user, exercise_ref, metric) '
  'triple -- never a whole-history scan. Used by '
  'recompute_strength_records_for_user_v1 (bulk backfill) and '
  '_strength_pr_recompute_if_holder (narrow record-holder-changed path), §4.3.';

create or replace function private._strength_pr_apply_or_recompute(
  p_user_id             uuid,
  p_exercise_id         uuid,
  p_custom_exercise_id  uuid,
  p_metric              public.strength_pr_metric,
  p_new_value           numeric,
  p_new_unit_snapshot   text,
  p_source_set_log_id   uuid,
  p_timeline_event_id   uuid,
  p_achieved_at         timestamptz
)
returns void
language plpgsql
security invoker
set search_path = public, pg_temp
as $$
declare
  v_existing_value  numeric;
  v_existing_holder uuid;
begin
  if p_new_value is null then
    return;
  end if;

  if p_exercise_id is not null then
    select value, source_set_log_id
      into v_existing_value, v_existing_holder
    from public.strength_records
    where user_id = p_user_id and exercise_id = p_exercise_id and metric = p_metric
    for update;
  else
    select value, source_set_log_id
      into v_existing_value, v_existing_holder
    from public.strength_records
    where user_id = p_user_id and custom_exercise_id = p_custom_exercise_id and metric = p_metric
    for update;
  end if;

  if v_existing_holder = p_source_set_log_id then
    if v_existing_value is distinct from p_new_value then
      perform private._strength_pr_recompute_metric(p_user_id, p_exercise_id, p_custom_exercise_id, p_metric);
    end if;
    return;
  end if;

  if v_existing_value is null or p_new_value > v_existing_value then
    if p_exercise_id is not null then
      insert into public.strength_records (
        user_id, exercise_id, metric, value, unit_snapshot,
        source_set_log_id, timeline_event_id, achieved_at, previous_value
      )
      values (
        p_user_id, p_exercise_id, p_metric, p_new_value, p_new_unit_snapshot,
        p_source_set_log_id, p_timeline_event_id, p_achieved_at, v_existing_value
      )
      on conflict (user_id, exercise_id, metric) where exercise_id is not null do update set
        previous_value    = strength_records.value,
        value             = excluded.value,
        unit_snapshot     = excluded.unit_snapshot,
        source_set_log_id = excluded.source_set_log_id,
        timeline_event_id = excluded.timeline_event_id,
        achieved_at       = excluded.achieved_at;
    else
      insert into public.strength_records (
        user_id, custom_exercise_id, metric, value, unit_snapshot,
        source_set_log_id, timeline_event_id, achieved_at, previous_value
      )
      values (
        p_user_id, p_custom_exercise_id, p_metric, p_new_value, p_new_unit_snapshot,
        p_source_set_log_id, p_timeline_event_id, p_achieved_at, v_existing_value
      )
      on conflict (user_id, custom_exercise_id, metric) where custom_exercise_id is not null do update set
        previous_value    = strength_records.value,
        value             = excluded.value,
        unit_snapshot     = excluded.unit_snapshot,
        source_set_log_id = excluded.source_set_log_id,
        timeline_event_id = excluded.timeline_event_id,
        achieved_at       = excluded.achieved_at;
    end if;

    insert into public.strength_achievements (
      timeline_event_id, source_set_log_id, user_id, metric, value
    )
    values (
      p_timeline_event_id, p_source_set_log_id, p_user_id, p_metric, p_new_value
    )
    on conflict (source_set_log_id, metric) do nothing;
  end if;
end;
$$;

comment on function private._strength_pr_apply_or_recompute(uuid, uuid, uuid, public.strength_pr_metric, numeric, text, uuid, uuid, timestamptz) is
  'Steady-state PR detection primitive (§4.3): O(1) point lookup + '
  'compare-and-upsert per set, or a narrow recompute if the saved set is '
  'already the record holder. Called from save_workout_session_v1 for every '
  'applicable metric on every qualifying set on every save/edit.';
