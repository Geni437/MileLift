-- Rollback for 20260722101000_create_saved_meal_items.sql
-- Safe to re-run; drops in dependency order with IF EXISTS / CASCADE.
-- Run BEFORE rolling back saved_meals/foods/custom_foods (this table FKs to
-- all three).

drop policy if exists saved_meal_items_delete_own on public.saved_meal_items;
drop policy if exists saved_meal_items_update_own on public.saved_meal_items;
drop policy if exists saved_meal_items_insert_own on public.saved_meal_items;
drop policy if exists saved_meal_items_select_own on public.saved_meal_items;

drop trigger if exists trg_saved_meal_items_enforce_integrity on public.saved_meal_items;

drop function if exists public.enforce_saved_meal_items_integrity();

drop index if exists public.idx_saved_meal_items_meal_order;

drop table if exists public.saved_meal_items cascade;
