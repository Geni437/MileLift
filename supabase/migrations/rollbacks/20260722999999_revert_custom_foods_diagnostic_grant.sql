-- Rollback for 20260722999999_revert_custom_foods_diagnostic_grant.sql
--
-- Re-applies the UPDATE(id) grant this migration removed. There is no
-- scenario where this is the correct choice (it would re-open the
-- immutable-identity-column exposure the forward migration exists to
-- close) -- provided only for convention-consistency.

grant update (id) on public.custom_foods to authenticated;
