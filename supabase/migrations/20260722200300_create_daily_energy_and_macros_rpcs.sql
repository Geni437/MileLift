-- =============================================================================
-- Phase 3 — Module B: get_daily_energy_balance_v1 / get_daily_macros_v1 RPCs
-- Design ref: docs/architecture/phase-3-module-b.md §4, §5
--
-- CORE-11's reconciliation is "not a bespoke integration" (§4, verbatim):
-- because Module A (gps_activity) / Module C (strength_session) / Module B
-- (manual_calorie_burn) all write NEGATIVE energy_kcal on the SAME spine
-- (timeline_events -- already enforced by the live
-- timeline_events_energy_sign_chk, 20260718210848_create_timeline_events.sql),
-- and Module B (food_log_entry) writes POSITIVE energy_kcal, "today's
-- balance" is a single SUM(energy_kcal) over a local_date -- no merge/dedup
-- step, ever. get_daily_energy_balance_v1 is exactly the RPC Phase 0 §5
-- pre-named for this read.
--
-- SECURITY INVOKER (the default): RLS on timeline_events/manual_calorie_burn_logs/
-- food_log_entries fully expresses "the caller only ever reads their own
-- rows" -- this is a pure aggregate read, no elevated privilege needed.
-- user_id is always auth.uid(), never a parameter (explicit filter is
-- defense-in-depth on top of RLS, matching this project's convention).
--
-- ROLLBACK: see supabase/migrations/rollbacks/20260722200300_create_daily_energy_and_macros_rpcs.sql
-- =============================================================================

-- =============================================================================
-- public.get_daily_energy_balance_v1(p_local_date) — §4.2, §4.3
--
-- Returns calories in (positive-energy events, i.e. food_log_entry),
-- calories out (the absolute value of negative-energy events -- gps_activity
-- + strength_session + manual_calorie_burn, additive, §4.3: "neither wins --
-- all expenditure rows sum"), net, and a per-line-item expenditure breakdown
-- so the client can render provenance (tracked workout vs. manual burn) per
-- §13's macro-dashboard note. A Module A/C workout appears here purely
-- because it is a negative-energy timeline_events row for this local_date --
-- no Module B row is ever created for it, and nothing is double-counted.
-- =============================================================================
create or replace function public.get_daily_energy_balance_v1(
  p_local_date date default current_date
)
returns jsonb
language plpgsql
security invoker
set search_path = public, pg_temp
as $$
declare
  v_user_id             uuid;
  v_calories_in           numeric;
  v_calories_out            numeric;
  v_net_kcal                  numeric;
  v_intake_event_count           integer;
  v_expenditure_events              jsonb;
begin
  v_user_id := auth.uid();
  if v_user_id is null then
    return jsonb_build_object('error', jsonb_build_object(
      'code', 'UNAUTHENTICATED', 'message', 'No authenticated user context.', 'field', null));
  end if;

  if p_local_date is null then
    return jsonb_build_object('error', jsonb_build_object('code', 'VALIDATION_ERROR', 'message', 'local_date is required.', 'field', 'local_date'));
  end if;

  begin
    select
      coalesce(sum(energy_kcal) filter (where energy_kcal > 0), 0),
      coalesce(-sum(energy_kcal) filter (where energy_kcal < 0), 0),
      coalesce(sum(energy_kcal), 0),
      count(*) filter (where energy_kcal > 0)
      into v_calories_in, v_calories_out, v_net_kcal, v_intake_event_count
    from public.timeline_events
    where user_id = v_user_id
      and local_date = p_local_date
      and deleted_at is null;

    select coalesce(jsonb_agg(jsonb_build_object(
             'timeline_event_id', te.id,
             'event_type', te.event_type,
             'source_module', te.source_module,
             'occurred_at', te.occurred_at,
             'duration_seconds', te.duration_seconds,
             'energy_kcal', te.energy_kcal,
             'label', mcb.label
           ) order by te.occurred_at), '[]'::jsonb)
      into v_expenditure_events
    from public.timeline_events te
    left join public.manual_calorie_burn_logs mcb
      on mcb.timeline_event_id = te.id and mcb.user_id = v_user_id
    where te.user_id = v_user_id
      and te.local_date = p_local_date
      and te.deleted_at is null
      and te.energy_kcal is not null
      and te.energy_kcal < 0;

  exception when others then
    return jsonb_build_object('error', jsonb_build_object('code', 'READ_FAILED', 'message', sqlerrm, 'field', null));
  end;

  return jsonb_build_object('data', jsonb_build_object(
    'local_date', p_local_date,
    'calories_in_kcal', v_calories_in,
    'calories_out_kcal', v_calories_out,
    'net_kcal', v_net_kcal,
    'intake_event_count', v_intake_event_count,
    'expenditure_events', v_expenditure_events
  ));
end;
$$;

comment on function public.get_daily_energy_balance_v1(date) is
  'CORE-11 daily energy reconciliation (§4, the gate-defining RPC). A single '
  'SUM(energy_kcal) over timeline_events for the given local_date -- Module '
  'A gps_activity / Module C strength_session / Module B manual_calorie_burn '
  'all sum additively as negative-energy rows on the same spine, with zero '
  'merge/dedup step (§4.2/§4.3). Phase 3 surfaces net actuals only -- no '
  'goal/target model (§12 decision 5, out of scope).';

revoke execute on function public.get_daily_energy_balance_v1(date) from public, anon;
grant execute on function public.get_daily_energy_balance_v1(date) to authenticated;

-- =============================================================================
-- public.get_daily_macros_v1(p_local_date) — §1.5, §5
--
-- Sums food_log_entries' own meal-level SNAPSHOT totals (never a live re-sum
-- of food_log_items, §1.5/§3) across every food_log_entry for the given
-- local_date. Also surfaces the day's water total (CORE-09) as a low-risk,
-- clearly-useful addition beyond the doc's literal "macro totals" wording --
-- flagged in the task report, not a silent scope expansion.
-- =============================================================================
create or replace function public.get_daily_macros_v1(
  p_local_date date default current_date
)
returns jsonb
language plpgsql
security invoker
set search_path = public, pg_temp
as $$
declare
  v_user_id         uuid;
  v_total_energy      numeric;
  v_total_protein        numeric;
  v_total_carb             numeric;
  v_total_fat                numeric;
  v_meal_count                 integer;
  v_water_ml_total                numeric;
begin
  v_user_id := auth.uid();
  if v_user_id is null then
    return jsonb_build_object('error', jsonb_build_object(
      'code', 'UNAUTHENTICATED', 'message', 'No authenticated user context.', 'field', null));
  end if;

  if p_local_date is null then
    return jsonb_build_object('error', jsonb_build_object('code', 'VALIDATION_ERROR', 'message', 'local_date is required.', 'field', 'local_date'));
  end if;

  begin
    select
      coalesce(sum(fle.total_energy_kcal), 0),
      sum(fle.total_protein_g),
      sum(fle.total_carb_g),
      sum(fle.total_fat_g),
      count(*)
      into v_total_energy, v_total_protein, v_total_carb, v_total_fat, v_meal_count
    from public.food_log_entries fle
    join public.timeline_events te on te.id = fle.timeline_event_id
    where fle.user_id = v_user_id
      and te.local_date = p_local_date
      and te.deleted_at is null;

    select coalesce(sum(wil.volume_ml), 0)
      into v_water_ml_total
    from public.water_intake_logs wil
    join public.timeline_events te on te.id = wil.timeline_event_id
    where wil.user_id = v_user_id
      and te.local_date = p_local_date
      and te.deleted_at is null;

  exception when others then
    return jsonb_build_object('error', jsonb_build_object('code', 'READ_FAILED', 'message', sqlerrm, 'field', null));
  end;

  return jsonb_build_object('data', jsonb_build_object(
    'local_date', p_local_date,
    'total_energy_kcal', v_total_energy,
    'total_protein_g', v_total_protein,
    'total_carb_g', v_total_carb,
    'total_fat_g', v_total_fat,
    'meal_count', v_meal_count,
    'water_ml_total', v_water_ml_total
  ));
end;
$$;

comment on function public.get_daily_macros_v1(date) is
  'CORE-08 daily macro-totals aggregate (§5), summing food_log_entries'' own '
  'meal-level SNAPSHOT totals (never a live re-sum of food_log_items) across '
  'the given local_date, plus the day''s water total. Actuals only -- no '
  'goal/target comparison (§12 decision 5, out of Phase 3 scope).';

revoke execute on function public.get_daily_macros_v1(date) from public, anon;
grant execute on function public.get_daily_macros_v1(date) to authenticated;
