-- Rollback for 20260722200100_create_log_saved_meal_rpc.sql
--
-- Drops the single public RPC this migration created. Does not touch any
-- table created by db-engineer's migrations. Safe to re-run (IF EXISTS).

drop function if exists public.log_saved_meal_v1(
  uuid, uuid, timestamptz, date, text, public.meal_type,
  public.timeline_source, public.timeline_visibility, text, text, timestamptz
);
