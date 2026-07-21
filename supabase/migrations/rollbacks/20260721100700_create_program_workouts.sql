-- Rollback for 20260721100700_create_program_workouts.sql
-- Safe to re-run; drops in dependency order with IF EXISTS / CASCADE.

drop policy if exists program_workouts_delete_own on public.program_workouts;
drop policy if exists program_workouts_update_own on public.program_workouts;
drop policy if exists program_workouts_insert_own on public.program_workouts;
drop policy if exists program_workouts_select_own on public.program_workouts;

drop trigger if exists trg_program_workouts_force_insert_audit_timestamps on public.program_workouts;
drop trigger if exists trg_program_workouts_set_updated_at on public.program_workouts;
drop trigger if exists trg_program_workouts_enforce_integrity on public.program_workouts;

drop function if exists public.enforce_program_workouts_integrity();

drop index if exists public.idx_program_workouts_template;
drop index if exists public.idx_program_workouts_program_sort;

drop table if exists public.program_workouts cascade;
