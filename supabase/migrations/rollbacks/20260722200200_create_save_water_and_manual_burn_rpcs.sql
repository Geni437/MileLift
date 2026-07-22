-- Rollback for 20260722200200_create_save_water_and_manual_burn_rpcs.sql
--
-- Drops both public RPCs this migration created. Does not touch any table
-- created by db-engineer's migrations. Safe to re-run (IF EXISTS).

drop function if exists public.save_manual_burn_v1(
  uuid, timestamptz, date, text, numeric, text, public.manual_burn_energy_source,
  text, integer, text, public.timeline_source, timestamptz
);

drop function if exists public.save_water_intake_v1(uuid, timestamptz, date, text, numeric, text, text, timestamptz);
