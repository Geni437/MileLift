-- Rollback for 20260718210837_create_profile_health.sql
-- Safe to re-run; drops in dependency order with IF EXISTS / CASCADE.

drop policy if exists profile_health_delete_own on public.profile_health;
drop policy if exists profile_health_update_own on public.profile_health;
drop policy if exists profile_health_insert_own on public.profile_health;
drop policy if exists profile_health_select_own on public.profile_health;

drop trigger if exists trg_profile_health_enforce_consent on public.profile_health;
drop trigger if exists trg_profile_health_set_updated_at on public.profile_health;

drop function if exists public.enforce_health_consent();

drop table if exists public.profile_health cascade;
