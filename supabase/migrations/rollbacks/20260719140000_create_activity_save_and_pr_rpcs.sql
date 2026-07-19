-- Rollback for 20260719140000_create_activity_save_and_pr_rpcs.sql
--
-- Drops, in reverse dependency order, everything the forward migration
-- created: the two public RPCs, the two AFTER UPDATE triggers + their
-- functions, the three internal PR-detection helper functions (in the
-- `private` schema — not `public`, see the forward migration's "PostgREST
-- exposure note"), and the `private` schema itself.
--
-- Safe to re-run / run against a partially-applied state (IF EXISTS on every
-- statement). Does not touch any table created by db-engineer's migrations
-- (activity_types, activity_details, activity_routes, personal_records,
-- activity_achievements, ...) — this migration only ever added functions and
-- triggers on top of them, never altered their schema.

drop function if exists public.save_activity_v1(
  uuid, text, timestamptz, date, text, integer,
  public.timeline_source, public.timeline_visibility, numeric,
  text, text, numeric, text, integer, numeric, numeric, numeric, numeric,
  numeric, numeric, public.activity_calories_source, jsonb, text, text,
  text, integer, integer, timestamptz
);

drop function if exists public.recompute_prs_for_user_v1(uuid);

drop trigger if exists trg_activity_details_pr_recompute_on_change on public.activity_details;
drop function if exists public.trg_activity_details_pr_recompute_on_change();

drop trigger if exists trg_timeline_events_pr_recompute_on_change on public.timeline_events;
drop function if exists public.trg_timeline_events_pr_recompute_on_change();

drop function if exists private._pr_apply_or_recompute(uuid, text, public.activity_pr_metric, numeric, text, uuid, timestamptz);
drop function if exists private._pr_recompute_if_holder(uuid, text, public.activity_pr_metric, uuid);
drop function if exists private._pr_recompute_metric(uuid, text, public.activity_pr_metric);

-- Only drop the schema itself if this is the only thing that ever used it
-- (true as of this migration — first use in the project, per the forward
-- migration's comment). `restrict` (the default) rather than `cascade` is
-- deliberate: if some later migration also started using `private` before
-- this rollback ran, this will safely fail loudly instead of silently
-- dropping that other work too.
drop schema if exists private restrict;
