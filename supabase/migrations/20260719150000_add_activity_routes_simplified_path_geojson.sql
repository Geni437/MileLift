-- =============================================================================
-- Phase 1 Module A fix — GeoJSON-readable projection of activity_routes.simplified_path
-- Design ref: docs/architecture/phase-1-module-a.md §1.4, §2, §2.3, §8
-- Gap report: mobile-builder, CORE-02 gate — see task report for context.
--
-- Gap: activity_routes.simplified_path is raw PostGIS geometry
-- (geometry(LineStringZ, 4326)). PostgREST has no built-in geometry
-- serializer; a `select simplified_path from activity_routes` over
-- PostgREST returns EWKB hex, which no mobile GeoJSON/map-rendering library
-- can consume. In practice this meant a route only ever rendered from the
-- device that recorded it (its own local cache) -- fetching it from the
-- server on a second device or after a reinstall returned unusable raw
-- geometry, which breaks CORE-02 ("route mapping & activity history") for
-- exactly the case history is for: viewing past routes from a different
-- session than the one that created them.
--
-- Fix: a generated, stored column that materializes
-- ST_AsGeoJSON(simplified_path) as jsonb, following the exact precedent
-- already established by this table's own `bounds` column
-- (20260719133300_create_activity_routes.sql: "ST_Envelope of the path...
-- Generated so it can never drift from simplified_path"). Same rationale
-- applies here: a generated column can never drift from simplified_path
-- (no dual-write, no backfill-then-forget risk), and jsonb -- not text --
-- so PostgREST/postgrest-js hands the mobile client a parsed GeoJSON object
-- directly in the response body rather than a JSON-encoded string the
-- client would have to parse a second time.
--
-- Why a generated column and not a get_activity_route_v1 RPC (the other
-- documented option, per the save_activity_v1 RPC precedent in
-- docs/api/save-activity-v1.md): the RPC pattern in this project is
-- reserved for multi-table transactional logic or computation that
-- shouldn't live in application code (supabase-standards). Reading back a
-- single column's alternate representation of itself, with no cross-table
-- logic and no authorization decision beyond "the same row-level RLS this
-- table already enforces," is exactly the "straightforward CRUD where RLS
-- alone fully expresses the authorization rule" case supabase-standards
-- assigns to direct PostgREST table access -- an RPC would just be an extra
-- moving part duplicating what `bounds` already proved out on this same
-- table.
--
-- RLS/authorization: no policy change. This is a new column on an existing
-- row, not a new table or a widened audience -- the existing owner-only
-- policies (activity_routes_select_own et al., user_id = auth.uid()) and
-- the plain `grant select on public.activity_routes to authenticated`
-- (column-unrestricted, unlike the column-scoped UPDATE grant) already
-- cover it. activity_routes remains owner-only in Phase 1 per architecture
-- §2.3/§8 -- this fix lets the OWNER read their own route from a different
-- device/after reinstall; it does not open routes to other users, and nothing
-- here touches the update grant, the consent-gating trigger, or cross-user
-- visibility.
--
-- Lock/downtime note (db-schema-standards, production-standards §6):
-- `ADD COLUMN ... GENERATED ALWAYS AS (...) STORED` requires computing and
-- writing the new column for every existing row, which -- unlike a
-- constant-default ADD COLUMN -- IS a full table rewrite under an
-- ACCESS EXCLUSIVE lock in Postgres 17 (the generated expression must
-- actually run per row, so the fast metadata-only path used by
-- 20260719110603_add_profiles_training_balance.sql for a constant default
-- does not apply here). activity_routes is a brand-new, write-once,
-- low-volume table (Phase 1 just shipped; routes are only ever produced one
-- per finished GPS activity) -- current live row count is negligible, so the
-- rewrite is effectively instantaneous and a single-step migration is safe
-- to ship as-is. This is explicitly NOT the safe pattern for a table with
-- meaningful existing volume; if activity_routes ever accumulates
-- significant rows before a future generated-column addition, that one
-- should instead ship as: add the column nullable/non-generated, backfill
-- via a batched UPDATE, then swap to GENERATED ALWAYS (or, more simply,
-- compute the GeoJSON in a plain view instead of a stored generated column)
-- to avoid a single blocking rewrite.
--
-- ROLLBACK: see supabase/migrations/rollbacks/20260719150000_add_activity_routes_simplified_path_geojson.sql
-- =============================================================================

alter table public.activity_routes
  add column simplified_path_geojson jsonb
    generated always as (extensions.st_asgeojson(simplified_path)::jsonb) stored;

comment on column public.activity_routes.simplified_path_geojson is
  'GeoJSON Geometry object (RFC 7946) equivalent of simplified_path, '
  'generated via ST_AsGeoJSON so it can never drift from the source '
  'geometry. This is the field the mobile client should actually select '
  'when rendering a route from server data (history view, second device, '
  'post-reinstall) -- simplified_path itself is unusable over PostgREST '
  '(no geometry serializer; returns EWKB hex). Owner-only, same as every '
  'other column on this row -- see activity_routes_select_own.';
