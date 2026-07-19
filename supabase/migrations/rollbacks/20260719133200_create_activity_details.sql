-- Rollback for 20260719133200_create_activity_details.sql
-- Safe to re-run; drops in dependency order with IF EXISTS / CASCADE.
-- Run AFTER rolling back every migration that FKs to activity_details
-- (activity_routes, wearable_links) -- their cascades handle child rows, but
-- this table's own drop should still happen only once those are gone.

drop policy if exists activity_details_update_own on public.activity_details;
drop policy if exists activity_details_insert_own on public.activity_details;
drop policy if exists activity_details_select_own on public.activity_details;

drop trigger if exists trg_activity_details_force_insert_audit_timestamps on public.activity_details;
drop trigger if exists trg_activity_details_set_updated_at on public.activity_details;
drop trigger if exists trg_activity_details_enforce_integrity on public.activity_details;

drop function if exists public.enforce_activity_details_integrity();

drop index if exists public.idx_activity_details_user_type;

drop table if exists public.activity_details cascade;

drop type if exists public.activity_calories_source;
