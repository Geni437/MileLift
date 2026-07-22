-- Rollback for 20260722100900_create_saved_meals.sql
-- Safe to re-run; drops in dependency order with IF EXISTS / CASCADE.
-- Run AFTER rolling back saved_meal_items (it FKs to this table).

drop policy if exists saved_meals_update_own on public.saved_meals;
drop policy if exists saved_meals_insert_own on public.saved_meals;
drop policy if exists saved_meals_select_own on public.saved_meals;

drop trigger if exists trg_saved_meals_force_insert_audit_timestamps on public.saved_meals;
drop trigger if exists trg_saved_meals_set_updated_at on public.saved_meals;

drop index if exists public.idx_saved_meals_user;

drop table if exists public.saved_meals cascade;
