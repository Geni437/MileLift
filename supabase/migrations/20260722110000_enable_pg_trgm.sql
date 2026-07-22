-- =============================================================================
-- Phase 3 — Module B: enable pg_trgm (prerequisite for search_foods_v1)
-- Design ref: docs/architecture/phase-3-module-b.md §2.2
--
-- Prerequisite-only migration, mirroring
-- 20260719133000_enable_postgis.sql's pattern: enables the pg_trgm
-- extension so the next migration can build a GIN trigram index on
-- foods.name and use the `%`/`ilike`-friendly similarity operators inside
-- search_foods_v1. No tables/RLS here.
--
-- The `extensions` schema already exists on this project (confirmed live by
-- 20260719133000, not assumed) and is already on every PostgREST request's
-- search_path per supabase/config.toml's api.extra_search_path. The next
-- migration's functions still explicitly `set search_path = public,
-- extensions, pg_temp` rather than relying on ambient search_path, per the
-- same search_path-hijacking defense used throughout this project.
--
-- ROLLBACK: see supabase/migrations/rollbacks/20260722110000_enable_pg_trgm.sql
-- =============================================================================

create extension if not exists pg_trgm with schema extensions;

comment on extension pg_trgm is
  'Enables trigram similarity + a GIN-indexable operator class for '
  'search_foods_v1''s ranked, indexed name search over public.foods '
  '(Phase 3 Module B, §2.2).';
