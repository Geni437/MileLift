-- Rollback for 20260719133700_create_activity_achievements.sql
-- Safe to re-run; drops in dependency order with IF EXISTS / CASCADE.

drop policy if exists activity_achievements_insert_own on public.activity_achievements;
drop policy if exists activity_achievements_select_own on public.activity_achievements;

drop trigger if exists trg_activity_achievements_force_insert_created_at on public.activity_achievements;
drop trigger if exists trg_activity_achievements_enforce_integrity on public.activity_achievements;

drop function if exists public.enforce_activity_achievements_user_id_matches_spine();

drop index if exists public.idx_activity_achievements_user_created_at;
drop index if exists public.uq_activity_achievements_timeline_event_metric;

drop table if exists public.activity_achievements cascade;

drop type if exists public.activity_achievement_rank;
