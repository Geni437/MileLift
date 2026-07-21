-- Rollback for 20260721101000_create_bodyweight_logs.sql
-- Safe to re-run; drops in dependency order with IF EXISTS / CASCADE.

drop policy if exists bodyweight_logs_update_own on public.bodyweight_logs;
drop policy if exists bodyweight_logs_insert_own on public.bodyweight_logs;
drop policy if exists bodyweight_logs_select_own on public.bodyweight_logs;

drop trigger if exists trg_bodyweight_logs_force_insert_audit_timestamps on public.bodyweight_logs;
drop trigger if exists trg_bodyweight_logs_set_updated_at on public.bodyweight_logs;
drop trigger if exists trg_bodyweight_logs_enforce_integrity on public.bodyweight_logs;

drop function if exists public.enforce_bodyweight_logs_integrity();

drop table if exists public.bodyweight_logs cascade;
