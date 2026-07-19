-- Rollback for 20260719133400_create_wearable_links.sql
-- Safe to re-run; drops in dependency order with IF EXISTS / CASCADE.
-- Run AFTER rolling back 20260719133500_create_biometric_samples.sql (that
-- table's `provider` column depends on the wearable_provider type dropped at
-- the end of this script).
--
-- NOTE: this also drops public.force_insert_created_at(), which
-- 20260719133700_create_activity_achievements.sql and
-- 20260719133800_create_kudos.sql also depend on -- roll those back first.

drop policy if exists wearable_links_delete_own on public.wearable_links;
drop policy if exists wearable_links_insert_own on public.wearable_links;
drop policy if exists wearable_links_select_own on public.wearable_links;

drop trigger if exists trg_wearable_links_force_insert_created_at on public.wearable_links;
drop trigger if exists trg_wearable_links_enforce_integrity on public.wearable_links;

drop function if exists public.enforce_wearable_links_user_id_matches_spine();

drop index if exists public.idx_wearable_links_timeline_event_id;
drop index if exists public.uq_wearable_links_provider_direction_external_record;

drop table if exists public.wearable_links cascade;

drop function if exists public.force_insert_created_at();

drop type if exists public.wearable_link_direction;
drop type if exists public.wearable_provider;
