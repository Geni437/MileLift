-- Rollback for 20260721100300_create_custom_exercises.sql
-- Safe to re-run; drops in dependency order with IF EXISTS / CASCADE.
-- Run AFTER rolling back workout_template_exercises and workout_set_logs
-- (both FK to custom_exercises).

drop policy if exists custom_exercises_update_own on public.custom_exercises;
drop policy if exists custom_exercises_insert_own on public.custom_exercises;
drop policy if exists custom_exercises_select_own on public.custom_exercises;

drop trigger if exists trg_custom_exercises_force_insert_audit_timestamps on public.custom_exercises;
drop trigger if exists trg_custom_exercises_set_updated_at on public.custom_exercises;

drop index if exists public.idx_custom_exercises_user;

drop table if exists public.custom_exercises cascade;
