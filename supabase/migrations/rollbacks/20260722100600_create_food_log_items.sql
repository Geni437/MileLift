-- Rollback for 20260722100600_create_food_log_items.sql
-- Safe to re-run; drops in dependency order with IF EXISTS / CASCADE.
-- Run BEFORE rolling back food_log_entries/foods/custom_foods (this table
-- FKs to all three).

drop policy if exists food_log_items_update_own on public.food_log_items;
drop policy if exists food_log_items_insert_own on public.food_log_items;
drop policy if exists food_log_items_select_own on public.food_log_items;

drop trigger if exists trg_food_log_items_force_insert_audit_timestamps on public.food_log_items;
drop trigger if exists trg_food_log_items_set_updated_at on public.food_log_items;
drop trigger if exists trg_food_log_items_enforce_integrity on public.food_log_items;

drop function if exists public.enforce_food_log_items_integrity();

drop index if exists public.idx_food_log_items_user_custom_food;
drop index if exists public.idx_food_log_items_user_food;
drop index if exists public.idx_food_log_items_event_order;

drop table if exists public.food_log_items cascade;
