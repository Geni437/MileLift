-- =============================================================================
-- CRITICAL FIX — Supabase's default schema privileges silently undermined
-- this project's grant model on every Phase 0 table, and on profiles_public
-- specifically this was a real, confirmed cross-user write vulnerability.
--
-- Root cause: Supabase provisions every new project with a schema-level
-- default-privilege bootstrap that grants `anon` and `authenticated` full
-- SELECT/INSERT/UPDATE/DELETE/TRUNCATE/REFERENCES/TRIGGER on every table (and
-- view) created in `public` — this is intentional on Supabase's part (their
-- model is "RLS is the only real boundary, GRANT is not"), but it was not
-- accounted for when profiles / user_consents / profile_health /
-- timeline_events / profiles_public were built:
--
--   1. CRITICAL: public.profiles_public is a simple, auto-updatable view
--      (Postgres marks single-table projection views as auto-updatable) that
--      was deliberately created WITHOUT security_invoker so that SELECT
--      through it bypasses the owner-only RLS on public.profiles (the
--      intended "public directory" read behavior, per architecture §8). The
--      same RLS-bypassing view-owner privilege applies to writes made
--      through it. Combined with the default INSERT/UPDATE/DELETE grants
--      neither table nor view definition explicitly restricted, this meant
--      ANY authenticated user (verified with a live test: a second user
--      successfully overwrote a first user's `profiles.username` via
--      `profiles_public`) — and, once a valid-length payload is used, any
--      unauthenticated `anon` request too — could read AND WRITE any other
--      user's profiles row through the view, completely bypassing the
--      owner-only RLS policies on the base table. This is now fixed below.
--
--   2. The column-scoped UPDATE grants documented as "defense in depth" on
--      profiles / user_consents / profile_health / timeline_events (e.g.
--      "grant update (username, ...) to authenticated", intended to exclude
--      id/created_at/user_id/source/etc.) were silently no-ops: the broader
--      table-level default UPDATE grant already covers every column, and
--      Postgres privilege checks are a union of all applicable grants, so
--      the narrower column list never actually restricted anything. Live
--      query against information_schema.role_table_grants confirmed
--      `authenticated` held table-wide UPDATE (and DELETE) on all four
--      tables regardless of what this project's own migrations explicitly
--      granted.
--
-- Fix: explicitly REVOKE the over-broad default privileges this project
-- never intended, on every object touched so far, so the actual live grant
-- state matches the documented design intent:
--   - profiles_public: revoke ALL from anon and authenticated, then
--     re-grant only SELECT to authenticated (matching the original,
--     never-changed intent — "restricted to authenticated only... a
--     column-safe view", not a writable surface at all).
--   - profiles / user_consents / profile_health / timeline_events: revoke
--     the table-wide UPDATE grant from authenticated so the pre-existing
--     column-scoped UPDATE grants become the actual effective privilege
--     again; revoke the table-wide DELETE grant from authenticated on the
--     three tables that were never meant to have a client-facing DELETE
--     (profiles, timeline_events, user_consents) — RLS already produced a
--     0-row no-op here (verified live), but removing the coarse permission
--     is still the correct, legible fix rather than relying solely on
--     "no policy happens to make this a no-op" (belt-and-suspenders,
--     supabase-standards: "never default to permissive"). profile_health
--     keeps its DELETE grant — full owner CRUD there was and remains
--     intentional (§8).
--   - anon: revoke ALL on all four base tables from anon. RLS already
--     blocked anon in practice (every policy is scoped `TO authenticated`,
--     so anon matched zero policies and got zero rows/writes regardless of
--     the coarse grant) but the coarse grant should not exist for a role
--     this project never intended to touch these tables at all.
--
-- PROCESS NOTE for every future Phase 1+ migration that creates a new table
-- in `public`: Supabase's default-privilege bootstrap will apply the same
-- broad anon/authenticated grant automatically to that new table too, the
-- instant it's created — this is not a one-off bug, it's how this Supabase
-- project is provisioned. Any future table that needs column-level write
-- restriction, or needs to exclude `anon` entirely, must include the same
-- REVOKE pattern as this migration in the SAME migration that creates it,
-- not as an afterthought. Relying on RLS row-scoping alone remains correct
-- and sufficient for row-level access; it is column-level and role-level
-- restriction (anon exclusion, immutable-column protection) that additionally
-- needs an explicit REVOKE given how this project is provisioned.
--
-- ROLLBACK: see supabase/migrations/rollbacks/20260719112010_secure_default_grants_and_profiles_public.sql
-- Rollback intentionally does NOT restore the over-broad default grants —
-- see that file for why.
-- =============================================================================

-- ---------------------------------------------------------------------------
-- profiles_public: the critical fix. Make it SELECT-only for authenticated,
-- and unreachable at all for anon.
-- ---------------------------------------------------------------------------
revoke all privileges on public.profiles_public from anon, authenticated;
grant select on public.profiles_public to authenticated;

-- ---------------------------------------------------------------------------
-- profiles
-- ---------------------------------------------------------------------------
revoke all privileges on public.profiles from anon;
revoke update, delete on public.profiles from authenticated;
-- The pre-existing column-scoped grant from 20260718210814_create_profiles.sql
-- (`grant update (username, display_name, avatar_url, unit_weight,
-- unit_distance, default_timezone, deletion_requested_at) on public.profiles
-- to authenticated;`) is untouched by the revokes above (table-level REVOKE
-- does not remove column-level grants) and is now, finally, the actual
-- effective UPDATE privilege for authenticated on this table.

-- ---------------------------------------------------------------------------
-- user_consents
-- ---------------------------------------------------------------------------
revoke all privileges on public.user_consents from anon;
revoke update, delete on public.user_consents from authenticated;
-- Pre-existing `grant update (revoked_at) ...` remains the effective UPDATE
-- privilege.

-- ---------------------------------------------------------------------------
-- profile_health — DELETE is intentionally kept (full owner CRUD, §8).
-- ---------------------------------------------------------------------------
revoke all privileges on public.profile_health from anon;
revoke update on public.profile_health from authenticated;
-- Pre-existing `grant update (sex, date_of_birth, height_cm) ...` remains the
-- effective UPDATE privilege. DELETE grant to authenticated is left as-is.

-- ---------------------------------------------------------------------------
-- timeline_events
-- ---------------------------------------------------------------------------
revoke all privileges on public.timeline_events from anon;
revoke update, delete on public.timeline_events from authenticated;
-- Pre-existing column-scoped UPDATE grant (event_type, occurred_at,
-- local_date, event_timezone, energy_kcal, load_score, duration_seconds,
-- confidence, needs_confirmation, visibility, deleted_at) remains the
-- effective UPDATE privilege.
