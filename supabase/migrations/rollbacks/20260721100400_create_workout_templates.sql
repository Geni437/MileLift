-- Rollback for 20260721100400_create_workout_templates.sql
-- Safe to re-run; drops in dependency order with IF EXISTS / CASCADE.
-- Run AFTER rolling back workout_template_exercises, program_workouts, and
-- workout_sessions (all FK to workout_templates).

drop policy if exists workout_templates_update_own on public.workout_templates;
drop policy if exists workout_templates_insert_own on public.workout_templates;
drop policy if exists workout_templates_select_own on public.workout_templates;

drop trigger if exists trg_workout_templates_force_insert_audit_timestamps on public.workout_templates;
drop trigger if exists trg_workout_templates_set_updated_at on public.workout_templates;

drop index if exists public.idx_workout_templates_user;

drop table if exists public.workout_templates cascade;
