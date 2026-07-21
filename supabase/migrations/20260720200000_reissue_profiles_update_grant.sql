-- =============================================================================
-- Re-issue the column-scoped UPDATE grant on public.profiles to authenticated.
--
-- Context: 20260719112940_restore_scoped_update_grants.sql already fixed this
-- exact symptom once ("permission denied for table profiles" on a legitimate
-- owner update) after 20260719112010's table-level REVOKE unexpectedly
-- stripped the column-level grant too. `supabase migration list --linked`
-- confirms 20260719112940 is recorded as applied on the live project, and no
-- later migration in this repo issues any REVOKE against public.profiles --
-- yet a live on-device test today reproduced the identical
-- "permission denied for table profiles" error (Postgres code 42501) on a
-- plain profile upsert from the mobile app, hint text identical to before
-- ("GRANT UPDATE ON public.profiles TO authenticated").
--
-- Root cause of the recurrence is not established (Docker wasn't available
-- in this environment to pg_dump the live ACL state for a definitive before/
-- after comparison). Rather than block on that, this migration re-applies
-- the exact same grant again -- GRANT is idempotent and safe to repeat, and
-- matches this project's own precedent for this bug. If it recurs a third
-- time, that's a strong enough signal to escalate to Supabase support as a
-- platform-level ACL-persistence issue rather than a migration authoring bug.
--
-- ROLLBACK: see supabase/migrations/rollbacks/20260720200000_reissue_profiles_update_grant.sql
-- =============================================================================

grant update (
  username, display_name, avatar_url,
  unit_weight, unit_distance, default_timezone,
  deletion_requested_at, training_balance_run_pct
) on public.profiles to authenticated;
