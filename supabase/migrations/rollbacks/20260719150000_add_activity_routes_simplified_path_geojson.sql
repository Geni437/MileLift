-- Rollback for 20260719150000_add_activity_routes_simplified_path_geojson.sql
-- Safe to re-run / run against a partially-applied state (IF EXISTS).
--
-- Data-loss note: none. simplified_path_geojson is a generated (derived)
-- column with no independent data of its own -- it is always fully
-- reconstructible from simplified_path, which this rollback does not touch.
-- Unlike most rollbacks in this directory, there is no "already took
-- production writes you'd lose" concern here.

alter table public.activity_routes
  drop column if exists simplified_path_geojson;
