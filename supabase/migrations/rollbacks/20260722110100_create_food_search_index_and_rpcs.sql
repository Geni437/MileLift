-- Rollback for 20260722110100_create_food_search_index_and_rpcs.sql
-- Safe to re-run; drops in dependency order with IF EXISTS / CASCADE.
-- Run this BEFORE rolling back 20260722110000_enable_pg_trgm.sql (this
-- migration's index depends on the pg_trgm extension).

-- DROP FUNCTION IF EXISTS also revokes all privileges as part of dropping
-- the object -- no separate REVOKE statement is needed (REVOKE has no
-- IF EXISTS form in Postgres, so it is deliberately omitted here).
drop function if exists public.resolve_barcode_v1(text);
drop function if exists public.search_foods_v1(text, jsonb, integer);

drop index if exists public.idx_foods_active_name_trgm;
