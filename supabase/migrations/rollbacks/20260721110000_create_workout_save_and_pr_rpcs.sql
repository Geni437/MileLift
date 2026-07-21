-- Rollback for 20260721110000_create_workout_save_and_pr_rpcs.sql
--
-- Drops, in reverse dependency order, everything the forward migration
-- created: the two public RPCs, the two AFTER UPDATE triggers + their
-- functions, and the three internal PR-detection helper functions (in the
-- `private` schema). Does NOT drop the `private` schema itself (also used by
-- Module A's 20260719140000_create_activity_save_and_pr_rpcs.sql) or any
-- table created by db-engineer's migrations.
--
-- Safe to re-run / run against a partially-applied state (IF EXISTS on every
-- statement).

drop function if exists public.save_workout_session_v1(
  uuid, timestamptz, date, text, integer, jsonb,
  public.timeline_source, public.timeline_visibility, numeric,
  text, text, uuid, text, numeric, public.activity_calories_source, timestamptz
);

drop function if exists public.recompute_strength_records_for_user_v1(uuid);

drop trigger if exists trg_timeline_events_strength_pr_recompute_on_delete_toggle on public.timeline_events;
drop function if exists public.trg_timeline_events_strength_pr_recompute_on_delete_toggle();

drop trigger if exists trg_workout_set_logs_pr_recompute_on_change on public.workout_set_logs;
drop function if exists public.trg_workout_set_logs_pr_recompute_on_change();

drop function if exists private._strength_pr_apply_or_recompute(uuid, uuid, uuid, public.strength_pr_metric, numeric, text, uuid, uuid, timestamptz);
drop function if exists private._strength_pr_recompute_if_holder(uuid, uuid, uuid, public.strength_pr_metric, uuid);
drop function if exists private._strength_pr_recompute_metric(uuid, uuid, uuid, public.strength_pr_metric);

-- Deliberately no `drop schema private` here -- Module A's migration also
-- owns objects in this schema; dropping it is that migration's rollback's
-- responsibility (see its own header note).
