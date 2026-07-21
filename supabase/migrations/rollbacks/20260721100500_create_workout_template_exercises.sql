-- Rollback for 20260721100500_create_workout_template_exercises.sql
-- Safe to re-run; drops in dependency order with IF EXISTS / CASCADE.

drop policy if exists workout_template_exercises_delete_own on public.workout_template_exercises;
drop policy if exists workout_template_exercises_update_own on public.workout_template_exercises;
drop policy if exists workout_template_exercises_insert_own on public.workout_template_exercises;
drop policy if exists workout_template_exercises_select_own on public.workout_template_exercises;

drop trigger if exists trg_workout_template_exercises_force_insert_audit_timestamps on public.workout_template_exercises;
drop trigger if exists trg_workout_template_exercises_set_updated_at on public.workout_template_exercises;
drop trigger if exists trg_workout_template_exercises_enforce_integrity on public.workout_template_exercises;

drop function if exists public.enforce_workout_template_exercises_integrity();

drop index if exists public.idx_workout_template_exercises_template_order;

drop table if exists public.workout_template_exercises cascade;
