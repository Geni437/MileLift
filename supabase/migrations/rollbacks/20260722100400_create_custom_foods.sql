-- Rollback for 20260722100400_create_custom_foods.sql
-- Safe to re-run; drops in dependency order with IF EXISTS / CASCADE.
-- Run BEFORE rolling back 20260722100000_create_foods.sql if both are being
-- rolled back (food_log_items/saved_meal_items FK to custom_foods too --
-- roll those back first).

drop policy if exists custom_foods_update_own on public.custom_foods;
drop policy if exists custom_foods_insert_own on public.custom_foods;
drop policy if exists custom_foods_select_own on public.custom_foods;

drop trigger if exists trg_custom_foods_force_insert_audit_timestamps on public.custom_foods;
drop trigger if exists trg_custom_foods_set_updated_at on public.custom_foods;

drop index if exists public.idx_custom_foods_user_barcode;
drop index if exists public.idx_custom_foods_user;

drop table if exists public.custom_foods cascade;
