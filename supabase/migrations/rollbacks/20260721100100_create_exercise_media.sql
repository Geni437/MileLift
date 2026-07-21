-- Rollback for 20260721100100_create_exercise_media.sql
-- Safe to re-run; drops in dependency order with IF EXISTS / CASCADE.

drop policy if exists exercise_media_select_all on public.exercise_media;

drop trigger if exists trg_exercise_media_force_insert_audit_timestamps on public.exercise_media;
drop trigger if exists trg_exercise_media_set_updated_at on public.exercise_media;

drop index if exists public.idx_exercise_media_exercise_sort;
drop index if exists public.uq_exercise_media_primary_per_exercise;

drop table if exists public.exercise_media cascade;

drop type if exists public.exercise_media_type;
