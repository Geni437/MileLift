-- Rollback for 20260721100600_create_programs.sql
-- Safe to re-run; drops in dependency order with IF EXISTS / CASCADE.
-- Run AFTER rolling back program_workouts (FKs to programs).

drop policy if exists programs_update_own on public.programs;
drop policy if exists programs_insert_own on public.programs;
drop policy if exists programs_select_own on public.programs;

drop trigger if exists trg_programs_force_insert_audit_timestamps on public.programs;
drop trigger if exists trg_programs_set_updated_at on public.programs;

drop index if exists public.idx_programs_user;

drop table if exists public.programs cascade;
