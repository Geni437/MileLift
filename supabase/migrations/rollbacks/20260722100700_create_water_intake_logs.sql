-- Rollback for 20260722100700_create_water_intake_logs.sql
-- Safe to re-run; drops in dependency order with IF EXISTS / CASCADE.

drop policy if exists water_intake_logs_update_own on public.water_intake_logs;
drop policy if exists water_intake_logs_insert_own on public.water_intake_logs;
drop policy if exists water_intake_logs_select_own on public.water_intake_logs;

drop trigger if exists trg_water_intake_logs_force_insert_audit_timestamps on public.water_intake_logs;
drop trigger if exists trg_water_intake_logs_set_updated_at on public.water_intake_logs;
drop trigger if exists trg_water_intake_logs_enforce_integrity on public.water_intake_logs;

drop function if exists public.enforce_water_intake_logs_integrity();

drop table if exists public.water_intake_logs cascade;
