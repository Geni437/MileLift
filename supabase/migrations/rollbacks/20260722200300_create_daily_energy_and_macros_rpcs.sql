-- Rollback for 20260722200300_create_daily_energy_and_macros_rpcs.sql
--
-- Drops both public RPCs this migration created. Does not touch any table
-- created by db-engineer's migrations. Safe to re-run (IF EXISTS).

drop function if exists public.get_daily_macros_v1(date);
drop function if exists public.get_daily_energy_balance_v1(date);
