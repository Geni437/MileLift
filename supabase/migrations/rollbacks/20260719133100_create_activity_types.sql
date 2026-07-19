-- Rollback for 20260719133100_create_activity_types.sql
-- Safe to re-run; drops in dependency order with IF EXISTS / CASCADE.
-- Run AFTER rolling back activity_details/personal_records (both FK to
-- activity_types.code).

drop policy if exists activity_types_select_all on public.activity_types;

drop trigger if exists trg_activity_types_force_insert_audit_timestamps on public.activity_types;
drop trigger if exists trg_activity_types_set_updated_at on public.activity_types;

drop table if exists public.activity_types cascade;

drop type if exists public.activity_category;
