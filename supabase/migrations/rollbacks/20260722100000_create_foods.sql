-- Rollback for 20260722100000_create_foods.sql
-- Safe to re-run; drops in dependency order with IF EXISTS / CASCADE.
-- Run BEFORE rolling back this migration's own dependents (food_nutrients,
-- food_servings, custom_foods, food_log_items, saved_meal_items, the search/
-- barcode RPCs) -- all FK to public.foods.

drop policy if exists foods_select_active on public.foods;

drop trigger if exists trg_foods_force_insert_audit_timestamps on public.foods;
drop trigger if exists trg_foods_set_updated_at on public.foods;

drop table if exists public.foods cascade;

drop type if exists public.food_data_quality;
drop type if exists public.food_measure_basis;
drop type if exists public.food_source;
