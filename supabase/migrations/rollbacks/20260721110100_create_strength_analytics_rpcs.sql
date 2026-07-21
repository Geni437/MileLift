-- Rollback for 20260721110100_create_strength_analytics_rpcs.sql
-- Safe to re-run; drops both read-only analytics RPCs.

drop function if exists public.get_muscle_volume_v1(date, date);
drop function if exists public.get_exercise_progression_v1(uuid, uuid, date, date);
