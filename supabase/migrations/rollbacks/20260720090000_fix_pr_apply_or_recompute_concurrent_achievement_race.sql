-- Rollback for 20260720090000_fix_pr_apply_or_recompute_concurrent_achievement_race.sql
--
-- Restores private._pr_apply_or_recompute to its exact 20260719140000 form
-- (inline achievement insert, immediate-compare-only logging -- reintroduces
-- the concurrent-batch race this migration fixed) and drops the new
-- private._pr_settle_achievement_if_uncontended helper.
--
-- Does not touch personal_records or activity_achievements data -- this
-- migration never altered table schema, only function bodies, so there is
-- nothing to reverse there. Any activity_achievements rows correctly logged
-- via the settle path while this migration was live are left in place (they
-- are legitimate facts, same immutability rule as always) -- this rollback
-- only reverts future behavior, per the rollbacks/README.md convention that
-- these scripts are a schema/behavior reversal, not a data un-write.
--
-- Safe to re-run / run against a partially-applied state (CREATE OR REPLACE
-- is itself idempotent; this just needs the forward migration's target state
-- to already exist, which it does as of 20260719140000).

create or replace function private._pr_apply_or_recompute(
  p_user_id             uuid,
  p_activity_type_code  text,
  p_metric              public.activity_pr_metric,
  p_new_value           numeric,
  p_new_unit_snapshot   text,
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

  select value, timeline_event_id
    into v_existing_value, v_existing_holder
  from public.personal_records
  where user_id = p_user_id
    and activity_type_code = p_activity_type_code
    and metric = p_metric
  for update;

  if v_existing_holder = p_timeline_event_id then
    if v_existing_value is distinct from p_new_value then
      perform private._pr_recompute_metric(p_user_id, p_activity_type_code, p_metric);
    end if;
    return;
  end if;

  if v_existing_value is null or p_new_value > v_existing_value then
    insert into public.personal_records (
      user_id, activity_type_code, metric, value, unit_snapshot,
      timeline_event_id, achieved_at, previous_value
    )
    values (
      p_user_id, p_activity_type_code, p_metric, p_new_value, p_new_unit_snapshot,
      p_timeline_event_id, p_achieved_at, v_existing_value
    )
    on conflict (user_id, activity_type_code, metric) do update set
      previous_value    = personal_records.value,
      value             = excluded.value,
      unit_snapshot     = excluded.unit_snapshot,
      timeline_event_id = excluded.timeline_event_id,
      achieved_at       = excluded.achieved_at;

    insert into public.activity_achievements (
      timeline_event_id, user_id, metric, value, rank
    )
    values (
      p_timeline_event_id, p_user_id, p_metric, p_new_value, 'pr'
    )
    on conflict (timeline_event_id, metric) do nothing;
  end if;
end;
$$;

comment on function private._pr_apply_or_recompute(uuid, text, public.activity_pr_metric, numeric, text, uuid, timestamptz) is
  'Steady-state PR detection primitive (§4.3): O(1) point lookup + '
  'compare-and-swap, or a narrow recompute if the saved activity is '
  'already the record holder. Called from save_activity_v1 for every '
  'applicable metric on every save/edit.';

revoke execute on function private._pr_apply_or_recompute(uuid, text, public.activity_pr_metric, numeric, text, uuid, timestamptz) from public, anon;
grant execute on function private._pr_apply_or_recompute(uuid, text, public.activity_pr_metric, numeric, text, uuid, timestamptz) to authenticated;

drop function if exists private._pr_settle_achievement_if_uncontended(uuid, text, public.activity_pr_metric);
