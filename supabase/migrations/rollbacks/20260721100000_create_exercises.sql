-- Rollback for 20260721100000_create_exercises.sql
-- Safe to re-run; drops in dependency order with IF EXISTS / CASCADE.
-- Run AFTER rolling back every migration that FKs to exercises
-- (exercise_media, custom_exercises's sibling tables don't FK here, but
-- workout_template_exercises, workout_set_logs, strength_records/
-- _achievements all do) -- their own drops must happen first.

drop policy if exists exercises_select_all on public.exercises;

drop trigger if exists trg_exercises_force_insert_audit_timestamps on public.exercises;
drop trigger if exists trg_exercises_set_updated_at on public.exercises;

drop index if exists public.idx_exercises_active_equipment;
drop index if exists public.idx_exercises_active_primary_muscle;

drop table if exists public.exercises cascade;

drop type if exists public.source_dataset;
drop type if exists public.exercise_force_vector;
drop type if exists public.exercise_mechanic;
drop type if exists public.equipment_type;
drop type if exists public.muscle_group;
