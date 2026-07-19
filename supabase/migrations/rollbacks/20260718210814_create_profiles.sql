-- Rollback for 20260718210814_create_profiles.sql
-- Safe to re-run; drops in dependency order with IF EXISTS / CASCADE.
-- Run this LAST when rolling back everything (profile_health, user_consents,
-- and timeline_events all FK to profiles).

drop trigger if exists on_auth_user_created on auth.users;
drop function if exists public.handle_new_user();

drop view if exists public.profiles_public;

drop policy if exists profiles_update_own on public.profiles;
drop policy if exists profiles_insert_own on public.profiles;
drop policy if exists profiles_select_own on public.profiles;

drop trigger if exists trg_profiles_set_updated_at on public.profiles;

drop index if exists public.idx_profiles_pending_deletion;

drop table if exists public.profiles cascade;

drop function if exists public.set_updated_at();
