-- =============================================================================
-- Phase 0 fix — profiles.username has no DB-level uniqueness guarantee
-- Design ref: docs/architecture/phase-0-foundation.md §2 ("username — Unique,
-- for community"). Gap surfaced by mobile-builder: the client did a
-- best-effort availability check before insert/update, which is not race-safe
-- (two clients can both pass the check for the same handle before either
-- write lands). The uniqueness invariant belongs in the database, not just in
-- app-layer pre-checks (db-schema-standards: constraints enforced at the DB
-- level, not only in application code).
--
-- Case sensitivity choice: a case-insensitive unique index on lower(username)
-- rather than converting the column to `citext`:
--   - citext requires `CREATE EXTENSION citext` and an `ALTER COLUMN ... TYPE
--     citext` column rewrite — a heavier, extension-dependent change for a
--     single-column concern.
--   - `username` is a public handle (§2: "Unique, for community"), and
--     handle-style fields conventionally treat case as cosmetic only —
--     "JohnDoe" and "johndoe" should not be able to coexist as two different
--     accounts (impersonation/confusion risk), matching how Twitter/GitHub/
--     Instagram-style handles behave.
--   - A functional unique index on lower(username) gets identical
--     case-insensitive-uniqueness semantics without a new extension
--     dependency, and preserves the user's originally-typed casing in the
--     stored column for display (only the *uniqueness check* folds case, not
--     the stored value).
--
-- Lock/downtime note (db-schema-standards): as of this migration,
-- public.profiles has 0 rows on the live linked project (verified via
-- `supabase db query --linked` immediately before writing this migration —
-- pre-launch, no real users yet), so a plain `CREATE UNIQUE INDEX` is safe:
-- it takes a brief exclusive lock but there is no concurrent write traffic to
-- block and no existing-row duplicate-scan risk. This is NOT the right
-- approach once the table has live production traffic — at that point, use
-- `CREATE UNIQUE INDEX CONCURRENTLY` instead (which cannot run inside a
-- transaction block, so it must ship as its own non-transactional migration
-- statement, not bundled with other DDL).
--
-- ROLLBACK: see supabase/migrations/rollbacks/20260719110557_add_profiles_username_unique_index.sql
-- =============================================================================

create unique index uq_profiles_username_lower
  on public.profiles (lower(username));

comment on index public.uq_profiles_username_lower is
  'Case-insensitive uniqueness on profiles.username (§2: "Unique, for '
  'community"). NULLs (no username set yet) are unaffected — Postgres UNIQUE '
  'indexes permit multiple NULLs, so users who have not chosen a handle yet '
  'never collide with each other or block onboarding.';

-- No RLS/policy change needed: existing policies on public.profiles
-- (profiles_select_own / profiles_insert_own / profiles_update_own) are
-- row-scoped (id = auth.uid()), not column-scoped, so they already cover
-- reads/writes that touch username with no changes required. The existing
-- `grant update (username, ...) on public.profiles to authenticated;` from
-- the profiles migration also already includes username, so no grant change
-- is needed either. A duplicate-handle attempt now surfaces as a normal
-- Postgres unique_violation (SQLSTATE 23505) from the INSERT/UPDATE call,
-- which the client should already be prepared to handle as a "username
-- taken" validation error (distinct from an authorization error) per
-- production-standards' explicit-error-types rule.
