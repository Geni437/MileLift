-- Rollback for 20260719133300_create_activity_routes.sql
-- Safe to re-run; drops in dependency order with IF EXISTS / CASCADE.

drop policy if exists activity_routes_update_own on public.activity_routes;
drop policy if exists activity_routes_insert_own on public.activity_routes;
drop policy if exists activity_routes_select_own on public.activity_routes;

drop trigger if exists trg_activity_routes_force_insert_audit_timestamps on public.activity_routes;
drop trigger if exists trg_activity_routes_set_updated_at on public.activity_routes;
drop trigger if exists trg_activity_routes_enforce_integrity on public.activity_routes;

drop function if exists public.enforce_activity_routes_integrity();

drop index if exists public.idx_activity_routes_simplified_path;

drop table if exists public.activity_routes cascade;
