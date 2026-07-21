-- Rollback for 20260721100900_create_workout_set_logs.sql
-- Safe to re-run; drops in dependency order with IF EXISTS / CASCADE.
-- Run AFTER rolling back strength_records/strength_achievements (both FK to
-- workout_set_logs.id via source_set_log_id).

drop policy if exists workout_set_logs_update_own on public.workout_set_logs;
drop policy if exists workout_set_logs_insert_own on public.workout_set_logs;
drop policy if exists workout_set_logs_select_own on public.workout_set_logs;

drop trigger if exists trg_workout_set_logs_force_insert_audit_timestamps on public.workout_set_logs;
drop trigger if exists trg_workout_set_logs_set_updated_at on public.workout_set_logs;
drop trigger if exists trg_workout_set_logs_enforce_integrity on public.workout_set_logs;

drop function if exists public.enforce_workout_set_logs_integrity();

drop index if exists public.idx_workout_set_logs_user_custom_exercise;
drop index if exists public.idx_workout_set_logs_user_exercise;
drop index if exists public.idx_workout_set_logs_session_order;

drop table if exists public.workout_set_logs cascade;

drop type if exists public.workout_set_type;
