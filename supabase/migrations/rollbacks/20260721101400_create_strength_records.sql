-- Rollback for 20260721101400_create_strength_records.sql
-- Safe to re-run; drops in dependency order with IF EXISTS / CASCADE.
-- Run AFTER rolling back strength_achievements if it references this table
-- (it does not FK to strength_records directly, but roll back in the
-- documented reverse order regardless).

drop policy if exists strength_records_delete_own on public.strength_records;
drop policy if exists strength_records_update_own on public.strength_records;
drop policy if exists strength_records_insert_own on public.strength_records;
drop policy if exists strength_records_select_own on public.strength_records;

drop trigger if exists trg_strength_records_force_insert_audit_timestamps on public.strength_records;
drop trigger if exists trg_strength_records_set_updated_at on public.strength_records;
drop trigger if exists trg_strength_records_enforce_integrity on public.strength_records;

drop function if exists public.enforce_strength_records_user_id_matches_spine();

drop index if exists public.uq_strength_records_user_custom_exercise_metric;
drop index if exists public.uq_strength_records_user_exercise_metric;

drop table if exists public.strength_records cascade;

drop type if exists public.strength_pr_metric;
