-- =============================================================================
-- security-auditor M3 — schema-level default-privilege backstop
--
-- Context: 20260719112010_secure_default_grants_and_profiles_public.sql fixed
-- a confirmed critical vulnerability by REVOKE-ing Supabase's over-broad
-- default table privileges on the four existing Phase 0 tables + the
-- profiles_public view. That fix is per-table and therefore fragile: it only
-- protects objects it explicitly names. Supabase provisions every project
-- with `ALTER DEFAULT PRIVILEGES ... GRANT ALL ON TABLES TO anon,
-- authenticated, service_role` (confirmed live via pg_default_acl), which
-- applies AUTOMATICALLY to every new table/view/sequence a migration creates
-- in `public` going forward — so any future Phase 1+ migration that forgets
-- the same REVOKE pattern silently reintroduces the exact same class of bug.
--
-- Fix: flip the schema-level DEFAULT for tables, sequences, and functions so
-- new objects are fail-closed (no anon/authenticated access at all) unless a
-- migration explicitly grants it — turning future per-table grants into pure
-- additive opt-in, matching how RLS itself is meant to work
-- (supabase-standards: "a policy-less table with RLS enabled is inaccessible
-- by default... the correct fail-closed state").
--
-- Scope limitation (verified, not assumed): `ALTER DEFAULT PRIVILEGES` is
-- scoped to the role executing it (or an explicit `FOR ROLE`), and Postgres
-- requires you to already own/be a member of that role to change its default
-- privileges. This project's migrations connect as `postgres` (confirmed:
-- `select current_user` -> `postgres`; all four existing tables and the view
-- are owned by `postgres`), so this migration corrects the default-privilege
-- entry FOR ROLE postgres — which is what actually matters, since that is the
-- role every future `supabase db push` migration in this project will create
-- objects as. There is a SEPARATE default-privilege entry FOR ROLE
-- supabase_admin (Supabase's own internal provisioning role) granting the
-- same broad access; `postgres` does not have permission to alter it
-- (verified live: `ALTER DEFAULT PRIVILEGES FOR ROLE supabase_admin ...` ->
-- `ERROR: 42501: permission denied to change default privileges`) and it is
-- out of this project's control. This is not a gap in this fix — objects
-- *this project's migrations* create are always owned by `postgres`, so the
-- supabase_admin-scoped default is simply never the one that applies to our
-- own future tables.
--
-- NOT retroactive: ALTER DEFAULT PRIVILEGES only affects objects created
-- AFTER this statement runs. The four existing tables + profiles_public view
-- keep whatever privileges the previous migration already explicitly set for
-- them — this migration does not need to (and does not) touch them again.
--
-- ROLLBACK: see supabase/migrations/rollbacks/20260719130400_lock_down_schema_default_privileges.sql
-- =============================================================================

-- Future tables/views created by `postgres` in `public`: no default
-- anon/authenticated access. service_role and postgres itself are
-- deliberately left untouched (service_role is meant to have full backend
-- access by design; postgres is the owning/migrating role).
alter default privileges in schema public
  revoke all on tables from anon, authenticated;

-- Future sequences: same posture, for when Phase 1+ introduces one (this
-- project currently uses client-generated UUID PKs exclusively, so no
-- existing sequence is affected, but the default should be closed regardless
-- of current usage).
alter default privileges in schema public
  revoke all on sequences from anon, authenticated;

-- Future functions: Postgres's built-in default (which Supabase's bootstrap
-- explicitly re-affirms) grants EXECUTE to every role on function creation.
-- Every trigger/helper function this project has written so far has needed a
-- manual `revoke execute ... from public, anon, authenticated;` to close that
-- — this makes the safe state the default instead, so a future migration that
-- forgets the manual revoke on a new SECURITY DEFINER function doesn't
-- silently ship it PostgREST-callable by anyone. Legitimate RPC-callable
-- functions still need an explicit GRANT EXECUTE, same as legitimate
-- table/view access needs an explicit GRANT under the table/sequence default
-- above -- this is intentionally "additive opt-in" throughout.
alter default privileges in schema public
  revoke execute on functions from public;

comment on schema public is
  'Default privileges for anon/authenticated on future tables, sequences, and '
  'functions in this schema are closed (see '
  '20260719130400_lock_down_schema_default_privileges.sql). Every new object '
  'needs an explicit GRANT in the same migration that creates it -- this is '
  'deliberate fail-closed-by-default, not an oversight.';
