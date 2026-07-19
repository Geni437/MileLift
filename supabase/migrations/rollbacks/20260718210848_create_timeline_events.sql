-- Rollback for 20260718210848_create_timeline_events.sql
-- Safe to re-run; drops in dependency order with IF EXISTS / CASCADE.

drop policy if exists timeline_events_select_public on public.timeline_events;
drop policy if exists timeline_events_update_own on public.timeline_events;
drop policy if exists timeline_events_insert_own on public.timeline_events;
drop policy if exists timeline_events_select_own on public.timeline_events;

drop trigger if exists trg_timeline_events_set_updated_at on public.timeline_events;
drop trigger if exists trg_timeline_events_clock_skew on public.timeline_events;

drop function if exists public.enforce_timeline_event_clock_skew();

drop index if exists public.idx_timeline_events_feed_visible;
drop index if exists public.idx_timeline_events_user_updated_at;
drop index if exists public.idx_timeline_events_user_event_type_occurred_at;
drop index if exists public.idx_timeline_events_user_local_date;
drop index if exists public.idx_timeline_events_user_occurred_at;

drop table if exists public.timeline_events cascade;

drop type if exists public.timeline_visibility;
drop type if exists public.timeline_source;
drop type if exists public.timeline_event_type;
drop type if exists public.timeline_source_module;
