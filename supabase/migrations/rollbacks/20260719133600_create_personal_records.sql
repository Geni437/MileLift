-- Rollback for 20260719133600_create_personal_records.sql
-- Safe to re-run; drops in dependency order with IF EXISTS / CASCADE.
-- Run AFTER rolling back 20260719133700_create_activity_achievements.sql
-- (that table's `metric` column depends on the activity_pr_metric type
-- dropped at the end of this script).

drop policy if exists personal_records_delete_own on public.personal_records;
drop policy if exists personal_records_update_own on public.personal_records;
drop policy if exists personal_records_insert_own on public.personal_records;
drop policy if exists personal_records_select_own on public.personal_records;

drop trigger if exists trg_personal_records_force_insert_audit_timestamps on public.personal_records;
drop trigger if exists trg_personal_records_set_updated_at on public.personal_records;
drop trigger if exists trg_personal_records_enforce_integrity on public.personal_records;

drop function if exists public.enforce_personal_records_user_id_matches_spine();

drop table if exists public.personal_records cascade;

drop type if exists public.activity_pr_metric;
