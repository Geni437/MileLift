-- Rollback for 20260722100100_create_food_nutrients.sql
-- Safe to re-run; drops in dependency order with IF EXISTS / CASCADE.

drop policy if exists food_nutrients_select_active on public.food_nutrients;

drop table if exists public.food_nutrients cascade;

drop type if exists public.nutrient_kind;
