-- Rollback for 20260722100800_create_manual_calorie_burn_logs.sql
-- Safe to re-run; drops in dependency order with IF EXISTS / CASCADE.

drop policy if exists manual_calorie_burn_logs_update_own on public.manual_calorie_burn_logs;
drop policy if exists manual_calorie_burn_logs_insert_own on public.manual_calorie_burn_logs;
drop policy if exists manual_calorie_burn_logs_select_own on public.manual_calorie_burn_logs;

drop trigger if exists trg_manual_calorie_burn_logs_force_insert_audit_timestamps on public.manual_calorie_burn_logs;
drop trigger if exists trg_manual_calorie_burn_logs_set_updated_at on public.manual_calorie_burn_logs;
drop trigger if exists trg_manual_calorie_burn_logs_enforce_integrity on public.manual_calorie_burn_logs;

drop function if exists public.enforce_manual_calorie_burn_logs_integrity();

drop index if exists public.idx_manual_calorie_burn_logs_activity_type;

drop table if exists public.manual_calorie_burn_logs cascade;

drop type if exists public.manual_burn_energy_source;
