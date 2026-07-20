-- Rollback for 20260720100000_revert_pr_achievement_settle_check_unsound_batch_boundary.sql
--
-- Restores private._pr_apply_or_recompute and private._pr_settle_achievement_
-- if_uncontended to their exact 20260720090000 form (the pg_locks-waiter
-- "settle" approach).
--
-- WARNING, read before running this: 20260720100000's own migration header
-- documents, with a live re-verification run, that the state this rollback
-- restores is CONFIRMED UNSOUND -- it does not reliably produce "exactly one
-- achievement per concurrent batch" (a live re-test produced FOUR stray rows,
-- worse than the THREE the original pre-20260720090000 bug produced) and
-- cannot be made sound as a per-transaction pg_locks check, because "has this
-- batch finished" is not decidable from inside a single participating
-- transaction without an actual batch boundary this system does not have.
-- This rollback exists only for this project's append-only rollback-pairing
-- convention (every forward migration gets a paired reversal script), not
-- because reverting to this state is ever expected to be the right call --
-- if 20260720100000 itself needs to be undone, prefer writing a NEW forward
-- migration with a better-reasoned fix over resurrecting this one.
--
-- Does not touch personal_records or activity_achievements data -- neither
-- migration in this pair ever altered table schema, only function bodies.
--
-- Safe to re-run / run against a partially-applied state (CREATE OR REPLACE
-- is itself idempotent; this just needs the forward migration's target state
-- to already exist, which it does as of 20260719140000).

create or replace function private._pr_settle_achievement_if_uncontended(
  p_user_id             uuid,
  p_activity_type_code  text,
  p_metric              public.activity_pr_metric
)
returns void
language plpgsql
security invoker
set search_path = public, pg_temp
as $$
declare
  v_my_xid      xid;
  v_has_waiters boolean;
  v_value       numeric;
  v_holder      uuid;
begin
  select l.transactionid
    into v_my_xid
  from pg_locks l
  where l.pid = pg_backend_pid()
    and l.locktype = 'transactionid'
    and l.granted = true
  limit 1;

  if v_my_xid is not null then
    select exists (
      select 1
      from pg_locks
      where locktype = 'transactionid'
        and transactionid = v_my_xid
        and granted = false
    ) into v_has_waiters;
  else
    v_has_waiters := false;
  end if;

  if v_has_waiters then
    return;
  end if;

  select value, timeline_event_id
    into v_value, v_holder
  from public.personal_records
  where user_id = p_user_id
    and activity_type_code = p_activity_type_code
    and metric = p_metric;

  if v_holder is not null then
    insert into public.activity_achievements (
      timeline_event_id, user_id, metric, value, rank
    )
    values (
      v_holder, p_user_id, p_metric, v_value, 'pr'
    )
    on conflict (timeline_event_id, metric) do nothing;
  end if;
end;
$$;

comment on function private._pr_settle_achievement_if_uncontended(uuid, text, public.activity_pr_metric) is
  'Restored by rollback of 20260720100000 -- CONFIRMED UNSOUND, see that '
  'migration''s header and this rollback''s own warning before relying on it.';

revoke execute on function private._pr_settle_achievement_if_uncontended(uuid, text, public.activity_pr_metric) from public, anon;
grant execute on function private._pr_settle_achievement_if_uncontended(uuid, text, public.activity_pr_metric) to authenticated;

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

  elsif v_existing_value is null or p_new_value > v_existing_value then
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
  end if;

  perform private._pr_settle_achievement_if_uncontended(p_user_id, p_activity_type_code, p_metric);
end;
$$;

comment on function private._pr_apply_or_recompute(uuid, text, public.activity_pr_metric, numeric, text, uuid, timestamptz) is
  'Restored by rollback of 20260720100000. Delegates achievement logging to '
  'the CONFIRMED UNSOUND private._pr_settle_achievement_if_uncontended -- see '
  '20260720100000''s migration header before relying on this state.';

revoke execute on function private._pr_apply_or_recompute(uuid, text, public.activity_pr_metric, numeric, text, uuid, timestamptz) from public, anon;
grant execute on function private._pr_apply_or_recompute(uuid, text, public.activity_pr_metric, numeric, text, uuid, timestamptz) to authenticated;
