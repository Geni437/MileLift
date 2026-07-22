-- Rollback for 20260722100500_create_food_log_entries.sql
-- Safe to re-run; drops in dependency order with IF EXISTS / CASCADE.
-- Run AFTER rolling back food_log_items (it FKs to this table's
-- timeline_event_id).

drop policy if exists food_log_entries_update_own on public.food_log_entries;
drop policy if exists food_log_entries_insert_own on public.food_log_entries;
drop policy if exists food_log_entries_select_own on public.food_log_entries;

drop trigger if exists trg_food_log_entries_force_insert_audit_timestamps on public.food_log_entries;
drop trigger if exists trg_food_log_entries_set_updated_at on public.food_log_entries;
drop trigger if exists trg_food_log_entries_enforce_integrity on public.food_log_entries;

drop function if exists public.enforce_food_log_entries_integrity();

drop table if exists public.food_log_entries cascade;

drop type if exists public.meal_type;
