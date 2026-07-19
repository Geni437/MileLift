-- Rollback for 20260718210826_create_user_consents.sql
-- Safe to re-run; drops in dependency order with IF EXISTS / CASCADE.
-- NOTE: run this only after the profile_health rollback (that table's trigger
-- reads user_consents; profile_health itself must be gone first, which the
-- CASCADE on user_consents' referencing FK does not by itself guarantee order
-- for, so drop profile_health's rollback script first).

drop policy if exists user_consents_update_own on public.user_consents;
drop policy if exists user_consents_insert_own on public.user_consents;
drop policy if exists user_consents_select_own on public.user_consents;

drop trigger if exists trg_user_consents_set_updated_at on public.user_consents;

drop index if exists public.idx_user_consents_user_category;
drop index if exists public.uq_user_consents_active_category;

drop table if exists public.user_consents cascade;

drop type if exists public.consent_category;
