-- =============================================================================
-- Phase 2 — Module C: save_workout_session_v1 RPC + strength PR detection/
-- recompute machinery
-- Design ref: docs/architecture/phase-2-module-c.md §1.4-1.6, §4.1-4.4, §5,
-- §8.1, §9.2
--
-- Builds against the REAL, already-applied tables from db-engineer's Phase 2
-- migrations (verified by reading them directly, not assumed):
--   20260721100000_create_exercises.sql        (exercises, muscle_group/equipment_type/source_dataset enums)
--   20260721100300_create_custom_exercises.sql (custom_exercises)
--   20260721100800_create_workout_sessions.sql (workout_sessions -- NO deleted_at, see that
--                                                migration's header for the resolved doc conflict)
--   20260721100900_create_workout_set_logs.sql (workout_set_logs, workout_set_type enum)
--   20260721101400_create_strength_records.sql (strength_records, strength_pr_metric enum,
--                                                surrogate id PK + two partial unique indexes)
--   20260721101500_create_strength_achievements.sql (strength_achievements)
-- plus the Phase 0/Phase 1 spine (timeline_events) and the `private` schema
-- first established in 20260719140000_create_activity_save_and_pr_rpcs.sql
-- (Module A's save_activity_v1 — the direct precedent this migration mirrors).
--
-- What this migration adds (backend-builder scope per the doc's §13
-- implementation routing):
--   1. save_workout_session_v1(...)     -- SECURITY INVOKER RPC, §5. Transactional
--      upsert across timeline_events + workout_sessions + N workout_set_logs,
--      with business-invariant validation, per-set Epley 1RM snapshotting
--      (§4.2), session total_volume_kg/total_sets recompute (§1.4), and
--      inline PR detection (§4.3).
--   2. recompute_strength_records_for_user_v1(...) -- SECURITY INVOKER RPC,
--      §4.3 backfill path, mirroring recompute_prs_for_user_v1.
--   3. Three internal-only helper functions (_strength_pr_recompute_metric,
--      _strength_pr_recompute_if_holder, _strength_pr_apply_or_recompute) in
--      the `private` schema (NOT public — see Module A's migration header for
--      the full PostgREST-exposure reasoning; the same mechanism applies here
--      verbatim, not re-explained).
--   4. Two AFTER UPDATE triggers keeping strength_records/strength_achievements
--      correct when a write reaches workout_set_logs or timeline_events
--      through *direct* PostgREST access rather than save_workout_session_v1
--      — db-engineer's column-scoped UPDATE grant on workout_set_logs
--      (weight_kg, reps, deleted_at, estimated_1rm_kg, ...) and the owner
--      UPDATE policy on timeline_events (deleted_at, ...) make a direct-table
--      edit or soft-delete a reachable path too (production-standards: never
--      assume only the "intended" client path is exercised). Mirrors Module
--      A's trg_activity_details_pr_recompute_on_change /
--      trg_timeline_events_pr_recompute_on_change pair exactly.
--
-- Design decisions this migration resolves (not silently — flagged here and
-- in the task report):
--
--   (a) exercise_name_snapshot / primary_muscle_snapshot are CLIENT-SUPPLIED,
--       not server-derived from a live exercises/custom_exercises lookup —
--       a deliberate divergence from Module A's activity_type_name_snapshot
--       (which IS server-derived from activity_types). Reasoning: §9.1
--       requires the mobile client to maintain a read-only cached mirror of
--       the exercise library so logging works fully offline; the snapshot's
--       entire purpose (§3) is to freeze what the user saw AT THE MOMENT OF
--       LOGGING, which may be hours/days before this RPC call executes on
--       reconnect. Re-deriving server-side at sync time would silently leak
--       any library edit made in that gap into "historical" data — exactly
--       what §3's gate rule forbids. The RPC still validates the snapshot is
--       non-blank and that the referenced exercise_id/custom_exercise_id
--       genuinely exists and (for custom_exercise_id) is owned by the
--       caller — it does not trust the snapshot TEXT is accurate to the
--       referenced row, by design.
--   (b) PR detection is evaluated PER SET (using that set's own candidate
--       value), not as a pre-aggregated "best value across the session" —
--       equivalent in effect (each set is independently compared against the
--       cached record and can independently trigger a beat) but simpler and
--       directly mirrors Module A's one-candidate-per-activity model. Every
--       comparison is still a single indexed point lookup against
--       strength_records, so the O(#exercises × #metrics) bound from §4.3
--       holds (in practice O(#sets × #metrics-per-set), a tighter bound).
--   (c) A record-holding set being edited DOWN (or soft-deleted) via a LATER
--       save_workout_session_v1 call for the SAME session is handled
--       correctly inline (the per-set apply-or-recompute helper re-derives
--       the true global best via a bounded aggregate when the set being
--       resaved IS the current cache holder). A record-holding set edited
--       via a *direct* PostgREST UPDATE (bypassing the RPC entirely) is
--       handled by trigger #4 above, not inline here — same split
--       responsibility as Module A.
--
-- ROLLBACK: see supabase/migrations/rollbacks/20260721110000_create_workout_save_and_pr_rpcs.sql
-- =============================================================================

-- `private` schema already exists (created by Module A's
-- 20260719140000_create_activity_save_and_pr_rpcs.sql) — IF NOT EXISTS makes
-- this migration independently replayable without assuming ordering, though
-- ordering is in fact guaranteed by the timestamp prefix.
create schema if not exists private;
grant usage on schema private to authenticated;

-- -----------------------------------------------------------------------------
-- private._strength_pr_recompute_metric(user, exercise_id, custom_exercise_id, metric)
--
-- The "one genuinely expensive case" from §4.3: a single indexed
-- ORDER BY ... LIMIT 1 aggregate over just this (user_id, exercise_ref) pair
-- (served by idx_workout_set_logs_user_exercise / _user_custom_exercise),
-- used both by the bulk backfill (recompute_strength_records_for_user_v1)
-- and the narrow record-holder-changed path (_strength_pr_recompute_if_holder
-- / the triggers below). Never scans a user's whole history across all
-- exercises.
-- -----------------------------------------------------------------------------
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
    -- rep_pr_at_weight / longest_hold are reserved-but-unimplemented (§1.10,
    -- §4.1) -- fail loudly rather than silently no-op, mirroring Module A's
    -- _pr_recompute_metric handling of its own reserved metrics.
    raise exception
      'Strength PR recompute for metric % is not implemented in Phase 2 (reserved, §1.10/§4.1)',
      p_metric
      using errcode = '0A000'; -- feature_not_supported
  end if;

  if v_source_set_log_id is null then
    -- No remaining (non-deleted, working, completed) set for this exercise
    -- carries this metric at all -- the cached record is stale with nothing
    -- left to hold it up.
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

revoke execute on function private._strength_pr_recompute_metric(uuid, uuid, uuid, public.strength_pr_metric) from public, anon;
grant execute on function private._strength_pr_recompute_metric(uuid, uuid, uuid, public.strength_pr_metric) to authenticated;

-- -----------------------------------------------------------------------------
-- private._strength_pr_recompute_if_holder(user, exercise_id, custom_exercise_id, metric, source_set_log_id)
--
-- Cheap point-lookup guard before paying for the aggregate above: only
-- recompute when the given set is *currently* the cached record holder for
-- this metric. Called from both AFTER UPDATE triggers below.
-- -----------------------------------------------------------------------------
create or replace function private._strength_pr_recompute_if_holder(
  p_user_id             uuid,
  p_exercise_id         uuid,
  p_custom_exercise_id  uuid,
  p_metric              public.strength_pr_metric,
  p_source_set_log_id   uuid
)
returns void
language plpgsql
security invoker
set search_path = public, pg_temp
as $$
begin
  if exists (
    select 1
    from public.strength_records
    where user_id = p_user_id
      and metric = p_metric
      and source_set_log_id = p_source_set_log_id
      and (
        (p_exercise_id is not null and exercise_id = p_exercise_id)
        or (p_custom_exercise_id is not null and custom_exercise_id = p_custom_exercise_id)
      )
  ) then
    perform private._strength_pr_recompute_metric(p_user_id, p_exercise_id, p_custom_exercise_id, p_metric);
  end if;
end;
$$;

comment on function private._strength_pr_recompute_if_holder(uuid, uuid, uuid, public.strength_pr_metric, uuid) is
  'Guard: only pays for the _strength_pr_recompute_metric aggregate when the '
  'given set is the current cache holder for this metric.';

revoke execute on function private._strength_pr_recompute_if_holder(uuid, uuid, uuid, public.strength_pr_metric, uuid) from public, anon;
grant execute on function private._strength_pr_recompute_if_holder(uuid, uuid, uuid, public.strength_pr_metric, uuid) to authenticated;

-- -----------------------------------------------------------------------------
-- private._strength_pr_apply_or_recompute(...)
--
-- The steady-state save-time detection primitive (§4.3), evaluated once per
-- (applicable metric) for a single set being saved: one indexed point lookup
-- against strength_records; if the SAME set currently holds the record,
-- re-derive the true current best via the narrow aggregate (handles both
-- "value increased further" and "this edit dropped it below another set"
-- correctly); otherwise a plain "does the new value beat the cached one"
-- compare-and-upsert, logging a strength_achievements row on a genuine beat.
-- ON CONFLICT DO NOTHING on the achievement insert makes this idempotent
-- under retry by construction, per §4.3/§9.2.
-- -----------------------------------------------------------------------------
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
    -- This set already IS the cache's record holder for this metric -- an
    -- idempotent retry (value unchanged) or an edit to the record-holding
    -- set itself. Re-derive the true current best via the narrow aggregate
    -- rather than assuming this set is still champion -- correctly demotes
    -- it if the edit dropped it below another set.
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

revoke execute on function private._strength_pr_apply_or_recompute(uuid, uuid, uuid, public.strength_pr_metric, numeric, text, uuid, uuid, timestamptz) from public, anon;
grant execute on function private._strength_pr_apply_or_recompute(uuid, uuid, uuid, public.strength_pr_metric, numeric, text, uuid, uuid, timestamptz) to authenticated;

-- =============================================================================
-- Trigger 1: keep strength_records correct when a direct workout_set_logs
-- edit (weight_kg/reps/estimated_1rm_kg/deleted_at/set_type/is_completed)
-- reaches the table *without* going through save_workout_session_v1 --
-- db-engineer's column-scoped UPDATE grant on workout_set_logs permits
-- exactly this via plain PostgREST (§8.1).
-- =============================================================================
create or replace function public.trg_workout_set_logs_pr_recompute_on_change()
returns trigger
language plpgsql
security invoker
set search_path = public, pg_temp
as $$
declare
  v_is_weighted    boolean;
  v_is_bodyweight  boolean;
  v_relevant_changed boolean;
begin
  v_relevant_changed :=
    (new.weight_kg is distinct from old.weight_kg)
    or (new.reps is distinct from old.reps)
    or (new.estimated_1rm_kg is distinct from old.estimated_1rm_kg)
    or (new.deleted_at is distinct from old.deleted_at)
    or (new.set_type is distinct from old.set_type)
    or (new.is_completed is distinct from old.is_completed);

  if not v_relevant_changed then
    return new;
  end if;

  if new.exercise_id is not null then
    select is_weighted, is_bodyweight into v_is_weighted, v_is_bodyweight
    from public.exercises where id = new.exercise_id;
  else
    select is_weighted, is_bodyweight into v_is_weighted, v_is_bodyweight
    from public.custom_exercises where id = new.custom_exercise_id;
  end if;

  if not found then
    -- Referenced exercise/custom_exercise row is gone (should not happen --
    -- exercises soft-hides via is_active, custom_exercises soft-deletes via
    -- deleted_at, neither hard-deletes while referenced) -- nothing to
    -- reconcile against.
    return new;
  end if;

  if v_is_weighted then
    perform private._strength_pr_recompute_if_holder(new.user_id, new.exercise_id, new.custom_exercise_id, 'heaviest_weight', new.id);
    perform private._strength_pr_recompute_if_holder(new.user_id, new.exercise_id, new.custom_exercise_id, 'estimated_1rm', new.id);
    perform private._strength_pr_recompute_if_holder(new.user_id, new.exercise_id, new.custom_exercise_id, 'best_set_volume', new.id);
  end if;

  if v_is_bodyweight then
    perform private._strength_pr_recompute_if_holder(new.user_id, new.exercise_id, new.custom_exercise_id, 'max_reps', new.id);
  end if;

  return new;
end;
$$;

comment on function public.trg_workout_set_logs_pr_recompute_on_change() is
  'AFTER UPDATE on workout_set_logs: reconciles strength_records when '
  'weight_kg/reps/estimated_1rm_kg/deleted_at/set_type/is_completed changes '
  'via any write path (RPC or direct PostgREST), not just '
  'save_workout_session_v1. Narrow -- only the affected metrics, per §4.3.';

revoke execute on function public.trg_workout_set_logs_pr_recompute_on_change() from public, anon, authenticated;

create trigger trg_workout_set_logs_pr_recompute_on_change
  after update on public.workout_set_logs
  for each row
  execute function public.trg_workout_set_logs_pr_recompute_on_change();

-- =============================================================================
-- Trigger 2: same reconciliation when a strength_session's spine row is
-- soft-deleted/undeleted directly (the timeline_events owner UPDATE policy
-- permits setting deleted_at without going through save_workout_session_v1).
-- A session soft-delete doesn't cascade-touch its child workout_set_logs
-- rows, so any strength_records currently held by a set inside this session
-- would otherwise go stale (the record still points at a set inside a now-
-- hidden session).
-- =============================================================================
create or replace function public.trg_timeline_events_strength_pr_recompute_on_delete_toggle()
returns trigger
language plpgsql
security invoker
set search_path = public, pg_temp
as $$
declare
  v_rec record;
begin
  if new.event_type <> 'strength_session' then
    return new;
  end if;

  if new.deleted_at is distinct from old.deleted_at then
    for v_rec in
      select distinct sr.exercise_id, sr.custom_exercise_id, sr.metric
      from public.strength_records sr
      join public.workout_set_logs wsl on wsl.id = sr.source_set_log_id
      where wsl.timeline_event_id = new.id
        and sr.user_id = new.user_id
    loop
      perform private._strength_pr_recompute_metric(new.user_id, v_rec.exercise_id, v_rec.custom_exercise_id, v_rec.metric);
    end loop;
  end if;

  return new;
end;
$$;

comment on function public.trg_timeline_events_strength_pr_recompute_on_delete_toggle() is
  'AFTER UPDATE on timeline_events: reconciles strength_records when a '
  'strength_session is soft-deleted/undeleted via any write path, for every '
  '(exercise_ref, metric) currently held by a set inside that session.';

revoke execute on function public.trg_timeline_events_strength_pr_recompute_on_delete_toggle() from public, anon, authenticated;

create trigger trg_timeline_events_strength_pr_recompute_on_delete_toggle
  after update on public.timeline_events
  for each row
  execute function public.trg_timeline_events_strength_pr_recompute_on_delete_toggle();

-- =============================================================================
-- public.save_workout_session_v1(...) — §5
--
-- SECURITY INVOKER: runs as the calling `authenticated` role; RLS on every
-- underlying table still applies. user_id is always auth.uid(), never a
-- parameter (production-standards).
--
-- Transactional across timeline_events + workout_sessions + N
-- workout_set_logs + session-total recompute + PR detection: all writes
-- below happen inside one nested BEGIN/EXCEPTION block (plpgsql implicit
-- savepoint) — any failure partway rolls back everything already written in
-- this call.
--
-- Idempotency (§9.2, two grains): p_id is the session's client-generated
-- idempotency key (doubles as timeline_events.id). Each element of p_sets
-- carries its OWN client-generated id -- a second idempotency grain below
-- the session. Retrying the exact same call, or a subset of it (a truncated/
-- retried sync payload), is always safe: every write is an
-- INSERT ... ON CONFLICT (id) DO UPDATE upsert scoped to the same
-- ownership WHERE clause, and PR-achievement logging is
-- ON CONFLICT DO NOTHING. A set is REMOVED by sending it again with
-- deleted_at set -- never by omitting it from the array (§9.2: "upsert-
-- present, never delete-omitted").
--
-- p_sets shape (jsonb array), one element per set:
--   {
--     "id": uuid,                                 -- required
--     "exercise_id": uuid | null,                  -- exactly one of these two
--     "custom_exercise_id": uuid | null,
--     "exercise_name_snapshot": text,               -- required, client-supplied (see header note (a))
--     "primary_muscle_snapshot": muscle_group | null,
--     "exercise_order": integer,                     -- required, >= 0
--     "set_number": integer,                          -- required, >= 1
--     "set_type": "working"|"warmup"|"dropset"|"failure"|"amrap" (default "working"),
--     "reps": integer | null,                          -- >= 0
--     "weight_kg": numeric | null,                      -- >= 0
--     "unit_weight_snapshot": "kg"|"lb",                 -- required
--     "is_bodyweight": boolean (default false),
--     "duration_seconds": integer | null,                 -- >= 0
--     "distance_m": numeric | null,                         -- >= 0
--     "rpe": numeric | null,                                 -- 0-10
--     "rest_seconds_planned": integer | null,                 -- >= 0
--     "rest_seconds_actual": integer | null,                   -- >= 0
--     "is_completed": boolean (default true),
--     "notes": text | null,
--     "deleted_at": timestamptz | null                          -- explicit tombstone
--   }
--
-- estimated_1rm_kg is NEVER accepted from the client -- always computed
-- server-side via Epley (§4.2, §12 item 3) and snapshotted.
-- =============================================================================
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

-- =============================================================================
-- public.recompute_strength_records_for_user_v1(p_user_id) — §4.3 backfill path
--
-- One-time, bounded backfill for wearable/history import, mirroring
-- recompute_prs_for_user_v1 (Module A). Bounded per §4.3: loops only over the
-- distinct (exercise_id, custom_exercise_id) pairs the user actually has
-- non-deleted, working, completed sets for -- not the full exercise catalog.
-- =============================================================================
create or replace function public.recompute_strength_records_for_user_v1(
  p_user_id uuid default auth.uid()
)
returns jsonb
language plpgsql
security invoker
set search_path = public, pg_temp
as $$
declare
  v_user_id             uuid;
  v_ref                  record;
  v_metrics_recomputed    integer := 0;
begin
  v_user_id := auth.uid();

  if v_user_id is null then
    return jsonb_build_object('error', jsonb_build_object('code', 'UNAUTHENTICATED', 'message', 'No authenticated user context.', 'field', null));
  end if;

  if p_user_id is not null and p_user_id <> v_user_id then
    return jsonb_build_object('error', jsonb_build_object(
      'code', 'FORBIDDEN', 'message', 'Cannot recompute strength records for another user.', 'field', 'p_user_id'));
  end if;

  for v_ref in
    select distinct
      wsl.exercise_id,
      wsl.custom_exercise_id,
      coalesce(ex.is_weighted, cex.is_weighted) as is_weighted,
      coalesce(ex.is_bodyweight, cex.is_bodyweight) as is_bodyweight
    from public.workout_set_logs wsl
    left join public.exercises ex on ex.id = wsl.exercise_id
    left join public.custom_exercises cex on cex.id = wsl.custom_exercise_id
    join public.timeline_events te on te.id = wsl.timeline_event_id
    where wsl.user_id = v_user_id
      and wsl.deleted_at is null
      and wsl.set_type = 'working'
      and wsl.is_completed
      and te.deleted_at is null
  loop
    if v_ref.is_weighted then
      perform private._strength_pr_recompute_metric(v_user_id, v_ref.exercise_id, v_ref.custom_exercise_id, 'heaviest_weight');
      perform private._strength_pr_recompute_metric(v_user_id, v_ref.exercise_id, v_ref.custom_exercise_id, 'estimated_1rm');
      perform private._strength_pr_recompute_metric(v_user_id, v_ref.exercise_id, v_ref.custom_exercise_id, 'best_set_volume');
      v_metrics_recomputed := v_metrics_recomputed + 3;
    end if;

    if v_ref.is_bodyweight then
      perform private._strength_pr_recompute_metric(v_user_id, v_ref.exercise_id, v_ref.custom_exercise_id, 'max_reps');
      v_metrics_recomputed := v_metrics_recomputed + 1;
    end if;
  end loop;

  return jsonb_build_object('data', jsonb_build_object('metrics_recomputed', v_metrics_recomputed));

exception when others then
  return jsonb_build_object('error', jsonb_build_object('code', 'WRITE_FAILED', 'message', sqlerrm, 'field', null));
end;
$$;

comment on function public.recompute_strength_records_for_user_v1(uuid) is
  'Phase 2 Module C bounded strength-PR backfill (§4.3): one indexed '
  'best-value recompute per (exercise_ref, metric) the calling user actually '
  'has qualifying sets for -- for use once after bulk import, not on a hot '
  'path. p_user_id defaults to and is asserted to equal auth.uid().';

revoke execute on function public.recompute_strength_records_for_user_v1(uuid) from public, anon;
grant execute on function public.recompute_strength_records_for_user_v1(uuid) to authenticated;
