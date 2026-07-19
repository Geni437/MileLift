-- =============================================================================
-- Phase 1 — Module A: enable PostGIS
-- Design ref: docs/architecture/phase-1-module-a.md §1.4, §2.1;
--             phase-0-foundation.md §9.1 ("PostGIS as making Postgres fit
--             Module A")
--
-- Prerequisite-only migration: enables the PostGIS extension so
-- activity_routes (next migration) can use geometry(LineStringZ, 4326) with a
-- GiST index. No tables/RLS here.
--
-- The `extensions` schema already exists on this project (pg_stat_statements,
-- pgcrypto, uuid-ossp already live there — confirmed live, not assumed) and is
-- already on every PostgREST request's search_path per
-- supabase/config.toml's `api.extra_search_path`. All Module A migrations
-- that reference PostGIS types/functions still schema-qualify them
-- explicitly (`extensions.geometry`, `extensions.st_envelope`, ...) rather
-- than relying on search_path, since a migration script's own session
-- search_path is not guaranteed to include `extensions`.
--
-- ROLLBACK: see supabase/migrations/rollbacks/20260719133000_enable_postgis.sql
-- =============================================================================

create extension if not exists postgis with schema extensions;

comment on extension postgis is
  'Enables geometry(LineStringZ, 4326) simplified-route storage + GiST '
  'indexing for public.activity_routes (Module A, Phase 1 §1.4/§2.1).';
