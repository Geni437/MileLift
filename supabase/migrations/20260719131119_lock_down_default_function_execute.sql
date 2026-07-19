-- =============================================================================
-- Correction to 20260719130400_lock_down_schema_default_privileges.sql
-- (never editing an already-applied migration in place).
--
-- That migration's `alter default privileges in schema public revoke execute
-- on functions from public;` did not actually close the gap for functions.
-- Verified live via pg_default_acl immediately after that migration: the
-- table and sequence REVOKEs worked correctly (anon/authenticated no longer
-- appear in those default-ACL entries), but the function default-ACL entry
-- still shows `anon=X/postgres, authenticated=X/postgres` unchanged.
--
-- Root cause: Supabase's original bootstrap granted default function EXECUTE
-- to `anon` and `authenticated` as separate, explicitly-named-role ACL
-- entries -- not via the `PUBLIC` pseudo-role. `REVOKE ... FROM PUBLIC` only
-- removes an ACL entry literally granted to PUBLIC; it does not implicitly
-- revoke separate grants recorded against specific named roles, even though
-- PUBLIC nominally means "every role." This is the same class of surprise as
-- 20260719112940's fix (a REVOKE not covering what its plain-English reading
-- suggested) -- ACL revocation in Postgres only ever removes exactly the
-- grantee you name, never a broader or narrower equivalent.
--
-- Fix: revoke from the named roles directly, matching the table/sequence
-- fix's pattern instead of relying on the PUBLIC pseudo-role.
--
-- ROLLBACK: see supabase/migrations/rollbacks/20260719131119_lock_down_default_function_execute.sql
-- =============================================================================

alter default privileges in schema public
  revoke execute on functions from anon, authenticated;

-- postgres and service_role keep default EXECUTE on functions they create
-- (service_role is meant to have full backend access by design; postgres is
-- the owning/migrating role and needs to be able to call its own helpers).
