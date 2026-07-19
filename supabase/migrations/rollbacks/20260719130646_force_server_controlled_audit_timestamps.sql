-- Rollback for 20260719130646_force_server_controlled_audit_timestamps.sql
-- Safe to re-run. Removing these triggers restores the (lower-severity,
-- own-rows-only) ability for a client to supply an arbitrary created_at/
-- updated_at at insert time -- only do this if genuinely reverting the fix.

drop trigger if exists trg_timeline_events_force_insert_audit_timestamps on public.timeline_events;
drop trigger if exists trg_profile_health_force_insert_audit_timestamps on public.profile_health;
drop trigger if exists trg_user_consents_force_insert_audit_timestamps on public.user_consents;
drop trigger if exists trg_profiles_force_insert_audit_timestamps on public.profiles;

drop function if exists public.force_insert_audit_timestamps();
