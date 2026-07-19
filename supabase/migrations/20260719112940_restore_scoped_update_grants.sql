-- =============================================================================
-- Correction to 20260719112010_secure_default_grants_and_profiles_public.sql
-- (never editing an already-applied migration in place — this is a new,
-- separate fix, per project convention).
--
-- What went wrong: that migration ran `revoke update, delete on <table> from
-- authenticated;` (table-level, no column list) on profiles / user_consents /
-- profile_health / timeline_events, intending only to strip the over-broad
-- default table-wide UPDATE grant and leave each table's pre-existing
-- column-scoped `grant update (col1, col2, ...) ...` intact (table-level and
-- column-level ACL entries are conceptually distinct in Postgres). Verified
-- live immediately after that migration: it did NOT leave the column-level
-- grants intact — information_schema.column_privileges and a direct read of
-- pg_attribute.attacl both show zero UPDATE privileges of any kind on all
-- four tables for `authenticated` post-migration, and a live test confirmed
-- even the legitimate owner could no longer update their own username
-- ("permission denied for table profiles"). Whatever the exact ACL-merging
-- behavior responsible, the practical, verified fact is: the column-scoped
-- grants did not survive that REVOKE. This migration does not depend on
-- re-litigating why — it simply re-establishes the intended column-scoped
-- UPDATE privileges explicitly, and this file's fix is verified live below
-- (both "legit owner update works again" and "cross-user write is still
-- blocked" — see task report).
--
-- Net effect of this migration + the previous one, together: `authenticated`
-- has UPDATE only on the specific columns each table's original migration
-- intended, and no broader table-wide UPDATE/DELETE beyond that (except
-- profile_health's intentional full-CRUD DELETE, untouched throughout).
--
-- ROLLBACK: see supabase/migrations/rollbacks/20260719112940_restore_scoped_update_grants.sql
-- =============================================================================

-- profiles (matches 20260718210814_create_profiles.sql's original intent)
grant update (
  username, display_name, avatar_url,
  unit_weight, unit_distance, default_timezone,
  deletion_requested_at, training_balance_run_pct
) on public.profiles to authenticated;

-- user_consents (matches 20260718210826_create_user_consents.sql's original intent)
grant update (revoked_at) on public.user_consents to authenticated;

-- profile_health (matches 20260718210837_create_profile_health.sql's original intent)
grant update (sex, date_of_birth, height_cm) on public.profile_health to authenticated;

-- timeline_events (matches 20260718210848_create_timeline_events.sql's original intent)
grant update (
  event_type, occurred_at, local_date, event_timezone,
  energy_kcal, load_score, duration_seconds,
  confidence, needs_confirmation, visibility,
  deleted_at
) on public.timeline_events to authenticated;
