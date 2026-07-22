-- Rollback for 20260722100200_create_food_servings.sql
-- Safe to re-run; drops in dependency order with IF EXISTS / CASCADE.

drop policy if exists food_servings_select_active on public.food_servings;

drop index if exists public.uq_food_servings_one_default_per_food;
drop index if exists public.idx_food_servings_food_order;

drop table if exists public.food_servings cascade;
