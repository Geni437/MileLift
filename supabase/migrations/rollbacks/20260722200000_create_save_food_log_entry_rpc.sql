-- Rollback for 20260722200000_create_save_food_log_entry_rpc.sql
--
-- Drops the single public RPC this migration created. Does not touch any
-- table created by db-engineer's migrations. Safe to re-run (IF EXISTS).

drop function if exists public.save_food_log_entry_v1(
  uuid, timestamptz, date, text, public.meal_type, jsonb,
  public.timeline_source, public.timeline_visibility, text, text, timestamptz
);
