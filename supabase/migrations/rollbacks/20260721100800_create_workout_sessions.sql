-- Rollback for 20260721100800_create_workout_sessions.sql
-- Safe to re-run; drops in dependency order with IF EXISTS / CASCADE.
-- Run AFTER rolling back workout_set_logs, strength_records,
-- strength_achievements (all FK to workout_sessions or its sets).

drop policy if exists workout_sessions_update_own on public.workout_sessions;
drop policy if exists workout_sessions_insert_own on public.workout_sessions;
drop policy if exists workout_sessions_select_own on public.workout_sessions;

drop trigger if exists trg_workout_sessions_force_insert_audit_timestamps on public.workout_sessions;
drop trigger if exists trg_workout_sessions_set_updated_at on public.workout_sessions;
drop trigger if exists trg_workout_sessions_enforce_integrity on public.workout_sessions;

drop function if exists public.enforce_workout_sessions_integrity();

drop index if exists public.idx_workout_sessions_source_template;

drop table if exists public.workout_sessions cascade;
