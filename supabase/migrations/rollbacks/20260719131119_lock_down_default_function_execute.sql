-- Rollback for 20260719131119_lock_down_default_function_execute.sql
-- Restores default EXECUTE on future functions to anon/authenticated. Safe
-- to re-run. Not recommended -- see the forward migration for why this
-- default should stay closed.

alter default privileges in schema public
  grant execute on functions to anon, authenticated;
