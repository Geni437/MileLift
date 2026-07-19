-- Rollback for 20260719130400_lock_down_schema_default_privileges.sql
-- Restores Supabase's original (over-broad) default-privilege posture for
-- future objects created by `postgres` in `public`. Safe to re-run.
-- NOTE: like the critical-vuln fix this migration builds on, reverting this
-- is generally NOT something you want to do -- it re-opens the fail-closed
-- default for every table/sequence/function created after the rollback runs.
-- Provided for completeness per db-schema-standards ("every migration has a
-- working reversal"), not as a recommended action.

alter default privileges in schema public
  grant all on tables to anon, authenticated;

alter default privileges in schema public
  grant all on sequences to anon, authenticated;

alter default privileges in schema public
  grant execute on functions to public;

comment on schema public is null;
