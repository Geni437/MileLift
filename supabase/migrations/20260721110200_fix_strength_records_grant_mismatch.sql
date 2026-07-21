-- =============================================================================
-- Phase 2 — Module C: fix a live grant-mismatch bug in the strength PR
-- cache-write helpers
-- Fixes: private._strength_pr_recompute_metric, private._strength_pr_apply_or_recompute,
-- introduced in supabase/migrations/20260721110000_create_workout_save_and_pr_rpcs.sql
--
-- Per this project's migration convention (see
-- 20260720090000_fix_pr_apply_or_recompute_concurrent_achievement_race.sql's
-- header), 20260721110000 is already applied and is not edited in place --
-- this is a new, additive migration.
--
-- =============================================================================
-- THE BUG (live-reproduced via scripts/verify-save-workout-session.mjs
-- against the real tjaplaqxsbtwlqkysmkr project, on the very first end-to-end
-- verification run of save_workout_session_v1)
-- =============================================================================
-- Every call to save_workout_session_v1 that should have logged a PR failed
-- with:
--   {"code":"CONSENT_REQUIRED","message":"permission denied for table strength_records"}
-- (CONSENT_REQUIRED is this RPC's generic sqlstate-42501 bucket per its
-- exception handler -- the actual cause here was a column-privilege denial,
-- not a consent-trigger firing, but both raise 42501 so the message text is
-- what actually reveals the real cause.)
--
-- Root cause: the original _strength_pr_recompute_metric and
-- _strength_pr_apply_or_recompute (both in 20260721110000) write
-- strength_records via `INSERT ... ON CONFLICT (...) DO UPDATE SET ...`,
-- copying Module A's personal_records pattern verbatim -- including a SET
-- list that assigns `timeline_event_id = excluded.timeline_event_id`. That
-- assignment is exactly right for personal_records (Module A's grant,
-- 20260719133600_create_personal_records.sql, is
-- `grant update (value, unit_snapshot, timeline_event_id, achieved_at,
-- previous_value) on public.personal_records to authenticated` -- it DOES
-- include timeline_event_id). db-engineer's actual, live strength_records
-- grant (20260721101400_create_strength_records.sql) is
-- `grant update (value, unit_snapshot, source_set_log_id, achieved_at,
-- previous_value) on public.strength_records to authenticated` -- it
-- deliberately swaps in source_set_log_id (a column personal_records doesn't
-- have) but does NOT carry timeline_event_id over. `save_workout_session_v1`
-- runs SECURITY INVOKER as `authenticated`, so Postgres refuses to even PLAN
-- an UPDATE (or an ON CONFLICT DO UPDATE, which is the same privilege check)
-- that assigns a column the calling role has no UPDATE privilege on -- this
-- is precisely the §8.1 "naive full-row upsert" footgun this project's own
-- convention explicitly warns against, reached here despite deliberately
-- trying to avoid it, because the mismatch was between two DIFFERENT
-- modules' grant lists (Module A's precedent vs. Module C's actual live
-- grant) rather than a single table's full-row vs. column-scoped grant. The
-- task instruction to "check each table's actual grant list ... before
-- writing any upsert against it" is the exact discipline that catches this;
-- it was not applied carefully enough on the first pass, corrected here
-- immediately upon live verification rather than reported as a known gap.
--
-- =============================================================================
-- THE FIX
-- =============================================================================
-- Replace the two INSERT ... ON CONFLICT DO UPDATE writes with
-- DELETE-then-INSERT. Both DELETE and INSERT are fully (unrestricted)
-- granted to `authenticated` on strength_records
-- (`grant select, insert, delete on public.strength_records to
-- authenticated`), so this achieves the exact same end state (a single row
-- per (user_id, exercise_ref, metric) with the new value/holder/
-- timeline_event_id/previous_value) without needing UPDATE privilege on any
-- column at all, let alone the missing one. `CREATE OR REPLACE FUNCTION`
-- with an unchanged signature is used so no DROP/CASCADE is needed --
-- save_workout_session_v1, the AFTER UPDATE triggers, and
-- recompute_strength_records_for_user_v1 (all of which call these two
-- helpers by schema-qualified name) pick up the corrected body automatically
-- on their next invocation, no redeployment of anything else required.
--
-- This is a workaround for the live strength_records grant as written, NOT
-- a change to that grant -- flagged in the task report for db-engineer to
-- consider directly: adding `timeline_event_id` to strength_records' UPDATE
-- grant (matching personal_records' precedent) would let a future revision
-- revert to a plain upsert if desired. Both approaches are equally correct;
-- this migration takes the "work within the existing grant" path per this
-- project's stated discipline of treating a live migration's grant list as
-- ground truth rather than editing it unilaterally.
--
-- Live re-verified after this fix: scripts/verify-save-workout-session.mjs
-- passes all cases (fresh PR, idempotent retry, a new PR beating the cache,
-- explicit-tombstone demotion, direct-PostgREST-edit demotion via the AFTER
-- UPDATE trigger, validation rejection, both analytics RPCs, and the backfill
-- RPC).
--
-- ROLLBACK: see supabase/migrations/rollbacks/20260721110200_fix_strength_records_grant_mismatch.sql
-- (restores the original INSERT ... ON CONFLICT DO UPDATE bodies from
-- 20260721110000, i.e. reintroduces the bug -- rollback exists for
-- convention-consistency/emergency-revert only, not because reverting is
-- ever the correct choice while this bug is understood).
-- =============================================================================

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
      using errcode = '0A000'; -- feature_not_supported
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

  -- FIX: DELETE + INSERT instead of INSERT ... ON CONFLICT DO UPDATE -- see
  -- this migration's header for the full grant-mismatch reasoning. Both
  -- DELETE and INSERT are fully granted to `authenticated` on
  -- strength_records, so this needs no column-level UPDATE privilege at all.
  if p_exercise_id is not null then
    delete from public.strength_records
    where user_id = p_user_id and exercise_id = p_exercise_id and metric = p_metric;

    insert into public.strength_records (
      user_id, exercise_id, metric, value, unit_snapshot,
      source_set_log_id, timeline_event_id, achieved_at, previous_value
    )
    values (
      p_user_id, p_exercise_id, p_metric, v_value, v_unit_snapshot,
      v_source_set_log_id, v_timeline_event_id, v_achieved_at, v_old_value
    );
  else
    delete from public.strength_records
    where user_id = p_user_id and custom_exercise_id = p_custom_exercise_id and metric = p_metric;

    insert into public.strength_records (
      user_id, custom_exercise_id, metric, value, unit_snapshot,
      source_set_log_id, timeline_event_id, achieved_at, previous_value
    )
    values (
      p_user_id, p_custom_exercise_id, p_metric, v_value, v_unit_snapshot,
      v_source_set_log_id, v_timeline_event_id, v_achieved_at, v_old_value
    );
  end if;
end;
$$;

comment on function private._strength_pr_recompute_metric(uuid, uuid, uuid, public.strength_pr_metric) is
  'Bounded, indexed best-value recompute for one (user, exercise_ref, metric) '
  'triple -- never a whole-history scan. Used by '
  'recompute_strength_records_for_user_v1 (bulk backfill) and '
  '_strength_pr_recompute_if_holder (narrow record-holder-changed path), §4.3. '
  'Fixed in 20260721110200 to DELETE+INSERT rather than INSERT ... ON '
  'CONFLICT DO UPDATE -- see that migration for why.';

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
    -- FIX: DELETE + INSERT instead of INSERT ... ON CONFLICT DO UPDATE --
    -- same grant-mismatch reasoning as _strength_pr_recompute_metric above.
    if p_exercise_id is not null then
      delete from public.strength_records
      where user_id = p_user_id and exercise_id = p_exercise_id and metric = p_metric;

      insert into public.strength_records (
        user_id, exercise_id, metric, value, unit_snapshot,
        source_set_log_id, timeline_event_id, achieved_at, previous_value
      )
      values (
        p_user_id, p_exercise_id, p_metric, p_new_value, p_new_unit_snapshot,
        p_source_set_log_id, p_timeline_event_id, p_achieved_at, v_existing_value
      );
    else
      delete from public.strength_records
      where user_id = p_user_id and custom_exercise_id = p_custom_exercise_id and metric = p_metric;

      insert into public.strength_records (
        user_id, custom_exercise_id, metric, value, unit_snapshot,
        source_set_log_id, timeline_event_id, achieved_at, previous_value
      )
      values (
        p_user_id, p_custom_exercise_id, p_metric, p_new_value, p_new_unit_snapshot,
        p_source_set_log_id, p_timeline_event_id, p_achieved_at, v_existing_value
      );
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
  'applicable metric on every qualifying set on every save/edit. Fixed in '
  '20260721110200 to DELETE+INSERT rather than INSERT ... ON CONFLICT DO '
  'UPDATE -- see that migration for why.';
