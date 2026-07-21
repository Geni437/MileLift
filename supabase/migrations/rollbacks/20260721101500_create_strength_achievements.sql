-- Rollback for 20260721101500_create_strength_achievements.sql
-- Safe to re-run; drops in dependency order with IF EXISTS / CASCADE.
-- Note: does NOT drop public.force_insert_created_at() -- that shared helper
-- is owned by 20260719133400_create_wearable_links.sql (Phase 1) and is also
-- used by public.kudos; only its trigger usage here is undone.

drop policy if exists strength_achievements_insert_own on public.strength_achievements;
drop policy if exists strength_achievements_select_own on public.strength_achievements;

drop trigger if exists trg_strength_achievements_force_insert_created_at on public.strength_achievements;
drop trigger if exists trg_strength_achievements_enforce_integrity on public.strength_achievements;

drop function if exists public.enforce_strength_achievements_user_id_matches_spine();

drop index if exists public.idx_strength_achievements_user_created_at;
drop index if exists public.uq_strength_achievements_source_set_log_metric;

drop table if exists public.strength_achievements cascade;
