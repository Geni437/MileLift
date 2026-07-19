-- =============================================================================
-- Phase 1 — Module A: save_activity_v1 RPC + PR detection/recompute machinery
-- Design ref: docs/architecture/phase-1-module-a.md §4.3, §5, §6, §7, §9
--
-- Builds against the REAL, already-applied tables from db-engineer's Phase 1
-- migrations (verified by reading them directly, not assumed):
--   20260719133000_enable_postgis.sql          (extensions.geometry, PostGIS fns)
--   20260719133100_create_activity_types.sql   (activity_types)
--   20260719133200_create_activity_details.sql (activity_details, activity_calories_source enum)
--   20260719133300_create_activity_routes.sql  (activity_routes)
--   20260719133600_create_personal_records.sql (personal_records, activity_pr_metric enum)
--   20260719133700_create_activity_achievements.sql (activity_achievements, activity_achievement_rank enum)
-- Every table/column/enum name below is taken verbatim from those files, not
-- guessed — this migration was written after they landed, specifically to
-- avoid a parallel-work naming mismatch.
--
-- What this migration adds (backend-builder scope per the doc's §13
-- implementation routing):
--   1. save_activity_v1(...)          -- SECURITY INVOKER RPC, §5. Transactional
--      upsert across timeline_events + activity_details + (optional)
--      activity_routes, with business-invariant validation and inline PR
--      detection (§4.3 "steady state").
--   2. recompute_prs_for_user_v1(...) -- SECURITY INVOKER RPC, §4.3 backfill
--      path: one bounded aggregate per (type, metric) the calling user
--      actually has activities in.
--   3. Three internal-only helper functions (_pr_recompute_metric,
--      _pr_recompute_if_holder, _pr_apply_or_recompute) implementing the
--      "O(#metrics) point lookup, narrow recompute only when the record
--      holder itself is what changed" logic shared by both RPCs above. These
--      live in a new `private` schema (created below), NOT `public` — see
--      the "PostgREST exposure" note right after this list.
--   4. Two AFTER UPDATE triggers that keep personal_records/activity_achievements
--      correct even when a write reaches timeline_events/activity_details
--      through *direct* PostgREST access rather than save_activity_v1 — the
--      doc's §7 states edits "flow through save_activity_v1," but
--      db-engineer's own column-scoped UPDATE grants on activity_details
--      (distance_m, average_speed_mps, elevation_gain_m, ...) and the owner
--      UPDATE policy on timeline_events (duration_seconds, deleted_at, ...)
--      make a direct-table edit or soft-delete a reachable path too
--      (production-standards: never assume only the "intended" client path
--      is exercised). Both triggers call the same narrow single-metric
--      recompute helper the RPCs use, so there is exactly one PR-correctness
--      code path regardless of which write path was used.
--
-- Error envelope design decision (flagged explicitly, see task report):
-- both public RPCs return `jsonb`, not `void`/a table. On success the return
-- value is `{"data": {...}}`; on a validation failure it is
-- `{"error": {"code", "message", "field"}}` — the exact shape
-- api-contract-standards/this doc's §5 mandate. This is a deliberate choice:
-- PostgREST's own error-response envelope for a raised Postgres exception
-- does NOT match this project's `{"error": {...}}` shape (it uses PostgREST's
-- own `{"code","details","hint","message"}` fields instead), so the only way
-- to guarantee this project's exact envelope for a *Postgres function* call
-- (as opposed to an Edge Function, which controls its own HTTP body) is for
-- the function to return it as a normal value. Practically: every call to
-- these RPCs returns HTTP 200 from PostgREST; the mobile client must inspect
-- the JSON body's `error` key, not the HTTP status, to detect a business-rule
-- failure. Genuine unexpected Postgres errors (a table CHECK/trigger firing
-- that this RPC's own pre-validation didn't already catch, RLS rejecting an
-- ownership mismatch, etc.) are still caught by an outer EXCEPTION handler
-- and translated into the same envelope — a raw Postgres error never reaches
-- the client.
--
-- PostgREST exposure note (security-auditor follow-up, addressed in this same
-- unpushed migration rather than a separate one): the three _pr_* helpers
-- are called via `perform` from other SECURITY INVOKER functions
-- (save_activity_v1, the two triggers, recompute_prs_for_user_v1) as the
-- SAME calling role at every call depth -- Postgres requires that calling
-- role to hold EXECUTE on the helper too, not just on the top-level RPC.
-- Granting that EXECUTE to `authenticated` directly on a `public`-schema
-- function would ALSO make it independently callable via PostgREST as
-- `/rpc/_pr_apply_or_recompute` etc., regardless of the leading underscore
-- (PostgREST does not treat underscore-prefixed names specially) -- RLS
-- still fully prevents any *cross-user* abuse through that door, but it
-- would let a user fabricate a bogus PR/achievement against their OWN
-- account by calling a helper directly with an arbitrary timeline_event_id,
-- bypassing save_activity_v1's validation entirely.
--
-- Fix: these three helpers live in a new `private` schema instead of
-- `public`. PostgREST only introspects/exposes the schemas listed in
-- supabase/config.toml's `[api] schemas` (currently `["public",
-- "graphql_public"]` -- confirmed `private` is not and must not be added
-- there); a schema a request-serving role has EXECUTE on but that isn't in
-- that exposed-schema list is simply never reachable via `/rpc/...` at all
-- (404, not merely permission-denied) -- this is a separate mechanism from
-- GRANT/RLS entirely. The internal `perform private._pr_apply_or_recompute(...)`
-- call from save_activity_v1 (still SECURITY INVOKER, still running as
-- whichever `authenticated` user called it, RLS still fully in force on
-- every table these helpers touch) is unaffected: a same-transaction SQL
-- function call is not a PostgREST HTTP request and is governed purely by
-- schema USAGE + function EXECUTE grants, both granted to `authenticated`
-- below.
--
-- ROLLBACK: see supabase/migrations/rollbacks/20260719140000_create_activity_save_and_pr_rpcs.sql
-- =============================================================================

-- -----------------------------------------------------------------------------
-- The `private` schema: first use in this project. Holds functions that must
-- be callable internally (by other SECURITY INVOKER functions, as the same
-- calling role) but must never be directly reachable over PostgREST. Nothing
-- in this schema is ever added to supabase/config.toml's `api.schemas` --
-- that is what actually keeps it unexposed; the schema itself has no
-- special "hidden" property in Postgres, PostgREST's own schema allowlist is
-- the entire enforcement mechanism.
-- -----------------------------------------------------------------------------
create schema if not exists private;

comment on schema private is
  'Internal-only functions callable from public SECURITY INVOKER RPCs via a '
  'same-transaction schema-qualified call, but never exposed over PostgREST '
  '-- this schema is deliberately absent from supabase/config.toml''s '
  '[api] schemas list. Do not add it there; do not put anything here that '
  'is meant to be directly callable by a client.';

-- authenticated needs USAGE on the schema (to resolve the schema-qualified
-- name at all) plus EXECUTE on each function below (granted per-function
-- further down) for save_activity_v1's internal calls to succeed --
-- SECURITY INVOKER means every call in the chain still runs as, and is
-- privilege-checked as, the original calling `authenticated` user.
-- Deliberately no grant to anon (anon never legitimately reaches any of
-- this) and no grant to public (this project's schema-level default-
-- privilege lockdown, 20260719130400/20260719131119, already makes "no
-- grant" the fail-closed default for anything new -- this is stated
-- explicitly rather than silently relied upon).
grant usage on schema private to authenticated;

-- -----------------------------------------------------------------------------
-- private._pr_recompute_metric(user, type, metric)
--
-- The "one genuinely expensive case" from §4.3: a single indexed MAX-per-
-- metric aggregate over just this (user_id, activity_type_code) pair, used
-- both by the bulk backfill (recompute_prs_for_user_v1) and the narrow
-- record-holder-changed path (_pr_apply_or_recompute / the triggers below).
-- Never scans a user's whole history across all types.
--
-- SECURITY INVOKER (supabase-standards default): runs as the calling role
-- under RLS. Every table this touches (activity_details, timeline_events,
-- activity_types, personal_records) already grants the necessary
-- SELECT/INSERT/UPDATE/DELETE to `authenticated` in db-engineer's migrations
-- (verified by reading them), so no additional GRANTs are needed for this
-- function's own table access to work correctly for a normal owner call.
-- -----------------------------------------------------------------------------
create or replace function private._pr_recompute_metric(
  p_user_id             uuid,
  p_activity_type_code  text,
  p_metric              public.activity_pr_metric
)
returns void
language plpgsql
security invoker
set search_path = public, pg_temp
as $$
declare
  v_old_value          numeric;
  v_value               numeric;
  v_unit_snapshot       text;
  v_timeline_event_id   uuid;
  v_achieved_at         timestamptz;
begin
  select pr.value
    into v_old_value
  from public.personal_records pr
  where pr.user_id = p_user_id
    and pr.activity_type_code = p_activity_type_code
    and pr.metric = p_metric;

  if p_metric = 'longest_distance' then
    select ad.distance_m, ad.unit_distance_snapshot, te.id, te.occurred_at
      into v_value, v_unit_snapshot, v_timeline_event_id, v_achieved_at
    from public.activity_details ad
    join public.timeline_events te on te.id = ad.timeline_event_id
    where ad.user_id = p_user_id
      and ad.activity_type_code = p_activity_type_code
      and te.deleted_at is null
      and ad.distance_m is not null
    order by ad.distance_m desc, te.occurred_at asc
    limit 1;

  elsif p_metric = 'fastest_avg_pace' then
    -- "Fastest" = highest average_speed_mps (canonical stored value; pace is
    -- derived on display, §1.2 — do not store pace here).
    select ad.average_speed_mps, ad.unit_distance_snapshot, te.id, te.occurred_at
      into v_value, v_unit_snapshot, v_timeline_event_id, v_achieved_at
    from public.activity_details ad
    join public.timeline_events te on te.id = ad.timeline_event_id
    where ad.user_id = p_user_id
      and ad.activity_type_code = p_activity_type_code
      and te.deleted_at is null
      and ad.average_speed_mps is not null
    order by ad.average_speed_mps desc, te.occurred_at asc
    limit 1;

  elsif p_metric = 'most_elevation_gain' then
    select ad.elevation_gain_m, ad.unit_distance_snapshot, te.id, te.occurred_at
      into v_value, v_unit_snapshot, v_timeline_event_id, v_achieved_at
    from public.activity_details ad
    join public.timeline_events te on te.id = ad.timeline_event_id
    where ad.user_id = p_user_id
      and ad.activity_type_code = p_activity_type_code
      and te.deleted_at is null
      and ad.elevation_gain_m is not null
    order by ad.elevation_gain_m desc, te.occurred_at asc
    limit 1;

  elsif p_metric = 'longest_duration' then
    -- duration_seconds lives on the spine, not activity_details (§1.2).
    select te.duration_seconds, null::text, te.id, te.occurred_at
      into v_value, v_unit_snapshot, v_timeline_event_id, v_achieved_at
    from public.activity_details ad
    join public.timeline_events te on te.id = ad.timeline_event_id
    where ad.user_id = p_user_id
      and ad.activity_type_code = p_activity_type_code
      and te.deleted_at is null
      and te.duration_seconds is not null
    order by te.duration_seconds desc, te.occurred_at asc
    limit 1;

  else
    -- fastest_1k/5k/10k are reserved-but-unimplemented sub-distance
    -- "best efforts" (architecture §4.1/§11 — deferred, needs a rolling-
    -- window scan over the full-res track). Fail loudly rather than
    -- silently no-op if this is ever reached for one of them.
    raise exception
      'PR recompute for metric % is not implemented in Phase 1 (sub-distance best-efforts are deferred, architecture §4.1/§11)',
      p_metric
      using errcode = '0A000'; -- feature_not_supported
  end if;

  if v_timeline_event_id is null then
    -- No remaining (non-deleted) activity of this type carries this metric
    -- at all — the cached record is stale with nothing left to hold it up.
    delete from public.personal_records
    where user_id = p_user_id
      and activity_type_code = p_activity_type_code
      and metric = p_metric;
    return;
  end if;

  insert into public.personal_records (
    user_id, activity_type_code, metric, value, unit_snapshot,
    timeline_event_id, achieved_at, previous_value
  )
  values (
    p_user_id, p_activity_type_code, p_metric, v_value, v_unit_snapshot,
    v_timeline_event_id, v_achieved_at, v_old_value
  )
  on conflict (user_id, activity_type_code, metric) do update set
    value             = excluded.value,
    unit_snapshot     = excluded.unit_snapshot,
    timeline_event_id = excluded.timeline_event_id,
    achieved_at       = excluded.achieved_at,
    previous_value    = personal_records.value;
end;
$$;

comment on function private._pr_recompute_metric(uuid, text, public.activity_pr_metric) is
  'Bounded, indexed MAX-per-metric recompute for one (user, activity_type, '
  'metric) triple — never a whole-history scan. Used by recompute_prs_for_user_v1 '
  '(bulk backfill) and _pr_recompute_if_holder (narrow record-holder-changed '
  'path), §4.3.';

revoke execute on function private._pr_recompute_metric(uuid, text, public.activity_pr_metric) from public, anon;
grant execute on function private._pr_recompute_metric(uuid, text, public.activity_pr_metric) to authenticated;

-- -----------------------------------------------------------------------------
-- private._pr_recompute_if_holder(user, type, metric, timeline_event_id)
--
-- Cheap point-lookup guard before paying for the aggregate above: only
-- recompute when the given activity is *currently* the cached record holder
-- for this metric. Called from both PR-recompute triggers below.
-- -----------------------------------------------------------------------------
create or replace function private._pr_recompute_if_holder(
  p_user_id             uuid,
  p_activity_type_code  text,
  p_metric              public.activity_pr_metric,
  p_timeline_event_id   uuid
)
returns void
language plpgsql
security invoker
set search_path = public, pg_temp
as $$
begin
  if exists (
    select 1
    from public.personal_records
    where user_id = p_user_id
      and activity_type_code = p_activity_type_code
      and metric = p_metric
      and timeline_event_id = p_timeline_event_id
  ) then
    perform private._pr_recompute_metric(p_user_id, p_activity_type_code, p_metric);
  end if;
end;
$$;

comment on function private._pr_recompute_if_holder(uuid, text, public.activity_pr_metric, uuid) is
  'Guard: only pays for the _pr_recompute_metric aggregate when the given '
  'activity is the current cache holder for this metric.';

revoke execute on function private._pr_recompute_if_holder(uuid, text, public.activity_pr_metric, uuid) from public, anon;
grant execute on function private._pr_recompute_if_holder(uuid, text, public.activity_pr_metric, uuid) to authenticated;

-- -----------------------------------------------------------------------------
-- private._pr_apply_or_recompute(...)
--
-- The steady-state save-time detection primitive (§4.3): one indexed point
-- lookup against personal_records; if the saved activity currently holds the
-- record, re-derive the true current best via the narrow aggregate (handles
-- both "value increased further" and "this edit dropped it below another
-- activity" correctly); otherwise a plain "does the new value beat the
-- cached one" compare-and-upsert, logging an activity_achievements row on a
-- genuine beat. ON CONFLICT DO NOTHING on the achievement insert makes this
-- idempotent under retry by construction, per §4.3.
-- -----------------------------------------------------------------------------
create or replace function private._pr_apply_or_recompute(
  p_user_id             uuid,
  p_activity_type_code  text,
  p_metric              public.activity_pr_metric,
  p_new_value           numeric,
  p_new_unit_snapshot   text,
  p_timeline_event_id   uuid,
  p_achieved_at         timestamptz
)
returns void
language plpgsql
security invoker
set search_path = public, pg_temp
as $$
declare
  v_existing_value  numeric;
  v_existing_holder uuid;
begin
  if p_new_value is null then
    -- Metric not applicable/not present on this activity — nothing to
    -- evaluate (e.g. an indoor_ride with no elevation data).
    return;
  end if;

  select value, timeline_event_id
    into v_existing_value, v_existing_holder
  from public.personal_records
  where user_id = p_user_id
    and activity_type_code = p_activity_type_code
    and metric = p_metric
  for update;

  if v_existing_holder = p_timeline_event_id then
    -- This activity already IS the cache's record holder for this metric —
    -- this is either an idempotent retry (value unchanged) or an edit to
    -- the record-holding activity itself (§4.3's "one genuinely expensive
    -- case"). Either way, re-derive the true current best via the narrow
    -- aggregate rather than assuming this activity is still champion —
    -- correctly demotes it if the edit dropped it below another activity.
    if v_existing_value is distinct from p_new_value then
      perform private._pr_recompute_metric(p_user_id, p_activity_type_code, p_metric);
    end if;
    return;
  end if;

  if v_existing_value is null or p_new_value > v_existing_value then
    insert into public.personal_records (
      user_id, activity_type_code, metric, value, unit_snapshot,
      timeline_event_id, achieved_at, previous_value
    )
    values (
      p_user_id, p_activity_type_code, p_metric, p_new_value, p_new_unit_snapshot,
      p_timeline_event_id, p_achieved_at, v_existing_value
    )
    on conflict (user_id, activity_type_code, metric) do update set
      previous_value    = personal_records.value,
      value             = excluded.value,
      unit_snapshot     = excluded.unit_snapshot,
      timeline_event_id = excluded.timeline_event_id,
      achieved_at       = excluded.achieved_at;

    insert into public.activity_achievements (
      timeline_event_id, user_id, metric, value, rank
    )
    values (
      p_timeline_event_id, p_user_id, p_metric, p_new_value, 'pr'
    )
    on conflict (timeline_event_id, metric) do nothing;
  end if;
end;
$$;

comment on function private._pr_apply_or_recompute(uuid, text, public.activity_pr_metric, numeric, text, uuid, timestamptz) is
  'Steady-state PR detection primitive (§4.3): O(1) point lookup + '
  'compare-and-upsert, or a narrow recompute if the saved activity is '
  'already the record holder. Called from save_activity_v1 for every '
  'applicable metric on every save/edit.';

revoke execute on function private._pr_apply_or_recompute(uuid, text, public.activity_pr_metric, numeric, text, uuid, timestamptz) from public, anon;
grant execute on function private._pr_apply_or_recompute(uuid, text, public.activity_pr_metric, numeric, text, uuid, timestamptz) to authenticated;

-- =============================================================================
-- Trigger 1: keep personal_records correct when a soft-delete/undelete or a
-- direct duration_seconds edit reaches timeline_events *without* going
-- through save_activity_v1 (e.g. a plain PostgREST UPDATE setting
-- deleted_at, which the owner UPDATE policy on timeline_events already
-- permits per Phase 0 §8/§3.8). Narrow: only fires for gps_activity rows,
-- only recomputes the metrics that could plausibly be affected, and the
-- _pr_recompute_if_holder guard means most fires are a single cheap point
-- lookup that immediately no-ops.
-- =============================================================================
create or replace function public.trg_timeline_events_pr_recompute_on_change()
returns trigger
language plpgsql
security invoker
set search_path = public, pg_temp
as $$
declare
  v_activity_type_code text;
  v_is_distance_based   boolean;
  v_tracks_elevation    boolean;
  v_deleted_toggled     boolean;
  v_duration_changed    boolean;
begin
  if new.event_type <> 'gps_activity' then
    return new;
  end if;

  v_deleted_toggled := (new.deleted_at is distinct from old.deleted_at);
  v_duration_changed := (new.duration_seconds is distinct from old.duration_seconds);

  if not (v_deleted_toggled or v_duration_changed) then
    return new;
  end if;

  select ad.activity_type_code, at.is_distance_based, at.tracks_elevation
    into v_activity_type_code, v_is_distance_based, v_tracks_elevation
  from public.activity_details ad
  join public.activity_types at on at.code = ad.activity_type_code
  where ad.timeline_event_id = new.id;

  if not found then
    -- No detail row yet (e.g. this fires mid-save_activity_v1's own
    -- timeline_events upsert, before activity_details exists on a brand
    -- new activity) — nothing to reconcile.
    return new;
  end if;

  if v_deleted_toggled or v_duration_changed then
    perform private._pr_recompute_if_holder(new.user_id, v_activity_type_code, 'longest_duration', new.id);
  end if;

  -- A soft-delete/undelete can affect every metric for this type, not just
  -- duration (the activity vanishes from/reappears in every aggregate);
  -- a plain duration edit only ever affects longest_duration, already
  -- handled above.
  if v_deleted_toggled and v_is_distance_based then
    perform private._pr_recompute_if_holder(new.user_id, v_activity_type_code, 'longest_distance', new.id);
    perform private._pr_recompute_if_holder(new.user_id, v_activity_type_code, 'fastest_avg_pace', new.id);
    if v_tracks_elevation then
      perform private._pr_recompute_if_holder(new.user_id, v_activity_type_code, 'most_elevation_gain', new.id);
    end if;
  end if;

  return new;
end;
$$;

comment on function public.trg_timeline_events_pr_recompute_on_change() is
  'AFTER UPDATE on timeline_events: reconciles personal_records when a '
  'gps_activity is soft-deleted/undeleted or its duration_seconds changes '
  'via any write path (RPC or direct PostgREST), not just save_activity_v1. '
  'Narrow — only the affected (type, metric) pairs, per §4.3.';

revoke execute on function public.trg_timeline_events_pr_recompute_on_change() from public, anon, authenticated;

create trigger trg_timeline_events_pr_recompute_on_change
  after update on public.timeline_events
  for each row
  execute function public.trg_timeline_events_pr_recompute_on_change();

-- =============================================================================
-- Trigger 2: same reconciliation for a direct activity_details measurement
-- edit (distance_m/average_speed_mps/elevation_gain_m) that bypasses
-- save_activity_v1 — db-engineer's column-scoped UPDATE grant on
-- activity_details permits exactly this via plain PostgREST, so PR
-- correctness cannot depend solely on the RPC being the only write path.
--
-- Known, accepted gap (flagged in the task report, not silently swallowed):
-- this trigger keys off the row's own (possibly just-changed)
-- activity_type_code. If a direct edit changes activity_type_code AND a
-- measurement column in the same statement, the OLD type's stale record (if
-- this activity held one) is not reconciled here — only reachable via
-- save_activity_v1 (which always re-runs full PR detection on the new type)
-- or the next recompute_prs_for_user_v1 backfill call. Worst case is a
-- stale/orphaned personal_records cache row under the old type, not data
-- loss (activity_achievements, the immutable log, is unaffected either way).
-- =============================================================================
create or replace function public.trg_activity_details_pr_recompute_on_change()
returns trigger
language plpgsql
security invoker
set search_path = public, pg_temp
as $$
begin
  if new.distance_m is distinct from old.distance_m then
    perform private._pr_recompute_if_holder(new.user_id, new.activity_type_code, 'longest_distance', new.timeline_event_id);
  end if;

  if new.average_speed_mps is distinct from old.average_speed_mps then
    perform private._pr_recompute_if_holder(new.user_id, new.activity_type_code, 'fastest_avg_pace', new.timeline_event_id);
  end if;

  if new.elevation_gain_m is distinct from old.elevation_gain_m then
    perform private._pr_recompute_if_holder(new.user_id, new.activity_type_code, 'most_elevation_gain', new.timeline_event_id);
  end if;

  return new;
end;
$$;

comment on function public.trg_activity_details_pr_recompute_on_change() is
  'AFTER UPDATE on activity_details: reconciles personal_records when '
  'distance_m/average_speed_mps/elevation_gain_m changes via any write path. '
  'See migration comment for the accepted activity_type_code-change edge case.';

revoke execute on function public.trg_activity_details_pr_recompute_on_change() from public, anon, authenticated;

create trigger trg_activity_details_pr_recompute_on_change
  after update on public.activity_details
  for each row
  execute function public.trg_activity_details_pr_recompute_on_change();

-- =============================================================================
-- public.save_activity_v1(...) — §5
--
-- SECURITY INVOKER: runs as the calling `authenticated` role; RLS on every
-- underlying table still applies, so ownership is enforced by the database,
-- not by trusting a client-supplied user_id (none is accepted as a
-- parameter — user_id is always auth.uid(), never client input, per
-- production-standards).
--
-- Transactional across timeline_events + activity_details + (optional)
-- activity_routes + PR detection: all writes below happen inside one nested
-- BEGIN/EXCEPTION block, which plpgsql implements via an implicit savepoint
-- — any failure partway rolls back everything already written in this call,
-- so a partial activity (spine row with no detail row, or a detail row with
-- an inconsistent PR state) can never be observed by a subsequent read.
--
-- Idempotency: p_id is the client-generated idempotency key (doubles as
-- timeline_events.id, Phase 0 §3.4 pattern). A retried call with the same
-- p_id and payload upserts in place and returns the same result; PR
-- detection's own idempotency is documented on _pr_apply_or_recompute above.
-- =============================================================================
create or replace function public.save_activity_v1(
  p_id                        uuid,
  p_activity_type_code        text,
  p_occurred_at               timestamptz,
  p_local_date                date,
  p_event_timezone            text,
  p_duration_seconds          integer,
  p_source                    public.timeline_source default 'manual',
  p_visibility                public.timeline_visibility default 'private',
  p_energy_kcal               numeric default null,
  p_title                     text default null,
  p_description               text default null,
  p_distance_m                numeric default null,
  p_unit_distance_snapshot    text default 'km',
  p_moving_time_seconds       integer default null,
  p_elevation_gain_m          numeric default null,
  p_elevation_loss_m          numeric default null,
  p_average_speed_mps         numeric default null,
  p_max_speed_mps             numeric default null,
  p_average_hr                numeric default null,
  p_max_hr                    numeric default null,
  p_calories_source           public.activity_calories_source default 'none',
  p_route_geojson             jsonb default null,
  p_route_polyline            text default null,
  p_raw_track_object_path     text default null,
  p_raw_track_checksum        text default null,
  p_raw_point_count           integer default null,
  p_simplified_point_count    integer default null,
  p_client_created_at         timestamptz default null
)
returns jsonb
language plpgsql
security invoker
set search_path = public, pg_temp
as $$
declare
  v_user_id               uuid;
  v_activity_type         record;
  v_has_route_input        boolean;
  v_geom                   extensions.geometry;
  v_route_field            text;
  v_expected_track_path    text;
  v_rows_affected          integer;
  v_has_gps_route          boolean;
  v_achievements           jsonb;
  v_clock_skew_tolerance   constant interval := interval '24 hours'; -- mirrors trg_timeline_events_clock_skew (20260718210848)
  v_min_hr                 constant numeric := 20;
  v_max_hr_bound           constant numeric := 260;
begin
  v_user_id := auth.uid();
  if v_user_id is null then
    return jsonb_build_object('error', jsonb_build_object(
      'code', 'UNAUTHENTICATED', 'message', 'No authenticated user context.', 'field', null));
  end if;

  -- ---------------------------------------------------------------------
  -- Required-field validation (production-standards: validate at the
  -- boundary, never trust client input).
  -- ---------------------------------------------------------------------
  if p_id is null then
    return jsonb_build_object('error', jsonb_build_object('code', 'VALIDATION_ERROR', 'message', 'id is required.', 'field', 'id'));
  end if;
  if p_activity_type_code is null or length(trim(p_activity_type_code)) = 0 then
    return jsonb_build_object('error', jsonb_build_object('code', 'VALIDATION_ERROR', 'message', 'activity_type_code is required.', 'field', 'activity_type_code'));
  end if;
  if p_occurred_at is null then
    return jsonb_build_object('error', jsonb_build_object('code', 'VALIDATION_ERROR', 'message', 'occurred_at is required.', 'field', 'occurred_at'));
  end if;
  if p_local_date is null then
    return jsonb_build_object('error', jsonb_build_object('code', 'VALIDATION_ERROR', 'message', 'local_date is required.', 'field', 'local_date'));
  end if;
  if p_event_timezone is null or length(trim(p_event_timezone)) = 0 then
    return jsonb_build_object('error', jsonb_build_object('code', 'VALIDATION_ERROR', 'message', 'event_timezone is required.', 'field', 'event_timezone'));
  end if;
  if p_duration_seconds is null then
    return jsonb_build_object('error', jsonb_build_object('code', 'VALIDATION_ERROR', 'message', 'duration_seconds is required.', 'field', 'duration_seconds'));
  end if;

  if p_source not in ('manual', 'wearable', 'import') then
    return jsonb_build_object('error', jsonb_build_object(
      'code', 'INVALID_SOURCE', 'message', 'source must be one of manual, wearable, import for an activity.', 'field', 'source'));
  end if;

  if p_duration_seconds < 0 then
    return jsonb_build_object('error', jsonb_build_object('code', 'NEGATIVE_MEASUREMENT', 'message', 'duration_seconds must be >= 0.', 'field', 'duration_seconds'));
  end if;

  if p_occurred_at > now() + v_clock_skew_tolerance then
    return jsonb_build_object('error', jsonb_build_object(
      'code', 'OCCURRED_AT_TOO_FUTURE', 'message', format('occurred_at is further in the future than the %s clock-skew tolerance.', v_clock_skew_tolerance), 'field', 'occurred_at'));
  end if;

  if p_local_date not between (p_occurred_at at time zone 'UTC')::date - 1
                          and (p_occurred_at at time zone 'UTC')::date + 1 then
    return jsonb_build_object('error', jsonb_build_object(
      'code', 'LOCAL_DATE_OUT_OF_BOUNDS', 'message', 'local_date must be within one day of occurred_at (UTC).', 'field', 'local_date'));
  end if;

  if p_energy_kcal is not null and p_energy_kcal > 0 then
    return jsonb_build_object('error', jsonb_build_object(
      'code', 'INVALID_ENERGY_SIGN', 'message', 'energy_kcal must be <= 0 for an activity (expenditure).', 'field', 'energy_kcal'));
  end if;

  if p_calories_source = 'none' and p_energy_kcal is not null then
    return jsonb_build_object('error', jsonb_build_object(
      'code', 'CALORIES_SOURCE_ENERGY_MISMATCH', 'message', 'energy_kcal must be null when calories_source is none.', 'field', 'calories_source'));
  end if;

  if p_moving_time_seconds is not null then
    if p_moving_time_seconds < 0 then
      return jsonb_build_object('error', jsonb_build_object('code', 'NEGATIVE_MEASUREMENT', 'message', 'moving_time_seconds must be >= 0.', 'field', 'moving_time_seconds'));
    end if;
    if p_moving_time_seconds > p_duration_seconds then
      return jsonb_build_object('error', jsonb_build_object(
        'code', 'MOVING_TIME_EXCEEDS_ELAPSED', 'message', 'moving_time_seconds cannot exceed duration_seconds.', 'field', 'moving_time_seconds'));
    end if;
  end if;

  if p_distance_m is not null and p_distance_m < 0 then
    return jsonb_build_object('error', jsonb_build_object('code', 'NEGATIVE_MEASUREMENT', 'message', 'distance_m must be >= 0.', 'field', 'distance_m'));
  end if;
  if p_elevation_gain_m is not null and p_elevation_gain_m < 0 then
    return jsonb_build_object('error', jsonb_build_object('code', 'NEGATIVE_MEASUREMENT', 'message', 'elevation_gain_m must be >= 0.', 'field', 'elevation_gain_m'));
  end if;
  if p_elevation_loss_m is not null and p_elevation_loss_m < 0 then
    return jsonb_build_object('error', jsonb_build_object('code', 'NEGATIVE_MEASUREMENT', 'message', 'elevation_loss_m must be >= 0.', 'field', 'elevation_loss_m'));
  end if;
  if p_average_speed_mps is not null and p_average_speed_mps < 0 then
    return jsonb_build_object('error', jsonb_build_object('code', 'NEGATIVE_MEASUREMENT', 'message', 'average_speed_mps must be >= 0.', 'field', 'average_speed_mps'));
  end if;
  if p_max_speed_mps is not null and p_max_speed_mps < 0 then
    return jsonb_build_object('error', jsonb_build_object('code', 'NEGATIVE_MEASUREMENT', 'message', 'max_speed_mps must be >= 0.', 'field', 'max_speed_mps'));
  end if;

  if p_unit_distance_snapshot not in ('km', 'mi') then
    return jsonb_build_object('error', jsonb_build_object('code', 'INVALID_UNIT', 'message', 'unit_distance_snapshot must be km or mi.', 'field', 'unit_distance_snapshot'));
  end if;

  if p_average_hr is not null and (p_average_hr < v_min_hr or p_average_hr > v_max_hr_bound) then
    return jsonb_build_object('error', jsonb_build_object(
      'code', 'HR_OUT_OF_RANGE', 'message', format('average_hr must be between %s and %s bpm.', v_min_hr, v_max_hr_bound), 'field', 'average_hr'));
  end if;
  if p_max_hr is not null and (p_max_hr < v_min_hr or p_max_hr > v_max_hr_bound) then
    return jsonb_build_object('error', jsonb_build_object(
      'code', 'HR_OUT_OF_RANGE', 'message', format('max_hr must be between %s and %s bpm.', v_min_hr, v_max_hr_bound), 'field', 'max_hr'));
  end if;
  if p_average_hr is not null and p_max_hr is not null and p_average_hr > p_max_hr then
    return jsonb_build_object('error', jsonb_build_object(
      'code', 'AVERAGE_HR_EXCEEDS_MAX', 'message', 'average_hr cannot exceed max_hr.', 'field', 'average_hr'));
  end if;

  -- ---------------------------------------------------------------------
  -- activity_type lookup (needed both for the snapshot column and for
  -- deciding which PR metrics apply, §4.1).
  -- ---------------------------------------------------------------------
  select code, display_name, is_distance_based, tracks_elevation
    into v_activity_type
  from public.activity_types
  where code = p_activity_type_code;

  if not found then
    return jsonb_build_object('error', jsonb_build_object(
      'code', 'ACTIVITY_TYPE_NOT_FOUND', 'message', format('Unknown activity_type_code %L.', p_activity_type_code), 'field', 'activity_type_code'));
  end if;

  -- ---------------------------------------------------------------------
  -- Route input validation + GeoJSON/encoded-polyline -> PostGIS conversion
  -- (§2.1/§5: "the RPC converts to geometry"). Exactly one of geojson/
  -- polyline may be provided, and route geometry + raw_track_object_path
  -- are required together (the raw blob is uploaded to Storage before this
  -- call, §2.1).
  -- ---------------------------------------------------------------------
  v_has_route_input := (p_route_geojson is not null) or (p_route_polyline is not null);
  v_route_field := case when p_route_geojson is not null then 'route_geojson' else 'route_polyline' end;

  if p_route_geojson is not null and p_route_polyline is not null then
    return jsonb_build_object('error', jsonb_build_object(
      'code', 'ROUTE_INPUT_AMBIGUOUS', 'message', 'Provide either route_geojson or route_polyline, not both.', 'field', 'route_geojson'));
  end if;

  if v_has_route_input and p_raw_track_object_path is null then
    return jsonb_build_object('error', jsonb_build_object(
      'code', 'MISSING_RAW_TRACK_PATH', 'message', 'raw_track_object_path is required when route geometry is provided.', 'field', 'raw_track_object_path'));
  end if;

  if (not v_has_route_input) and p_raw_track_object_path is not null then
    return jsonb_build_object('error', jsonb_build_object(
      'code', 'MISSING_ROUTE_GEOMETRY', 'message', 'route_geojson or route_polyline is required when raw_track_object_path is provided.', 'field', 'route_geojson'));
  end if;

  if p_raw_track_object_path is not null then
    -- Matches activity_routes_raw_track_object_path_chk exactly (20260719133300).
    v_expected_track_path := 'activity-tracks/' || v_user_id::text || '/' || p_id::text || '/track.bin';
    if p_raw_track_object_path <> v_expected_track_path then
      return jsonb_build_object('error', jsonb_build_object(
        'code', 'INVALID_TRACK_PATH', 'message', format('raw_track_object_path must be %L for this activity.', v_expected_track_path), 'field', 'raw_track_object_path'));
    end if;
  end if;

  if v_has_route_input then
    begin
      if p_route_geojson is not null then
        v_geom := extensions.st_setsrid(extensions.st_geomfromgeojson(p_route_geojson::text), 4326);
      else
        v_geom := extensions.st_setsrid(extensions.st_linefromencodedpolyline(p_route_polyline, 5), 4326);
      end if;

      v_geom := extensions.st_force3dz(v_geom);
    exception when others then
      return jsonb_build_object('error', jsonb_build_object(
        'code', 'INVALID_ROUTE_GEOMETRY', 'message', 'Could not parse the provided route geometry: ' || sqlerrm, 'field', v_route_field));
    end;

    if extensions.st_geometrytype(v_geom) <> 'ST_LineString' then
      return jsonb_build_object('error', jsonb_build_object(
        'code', 'INVALID_ROUTE_GEOMETRY', 'message', 'Route geometry must be a single LineString.', 'field', v_route_field));
    end if;

    if extensions.st_npoints(v_geom) < 2 then
      return jsonb_build_object('error', jsonb_build_object(
        'code', 'INVALID_ROUTE_GEOMETRY', 'message', 'Route geometry must contain at least 2 points.', 'field', v_route_field));
    end if;
  end if;

  -- ---------------------------------------------------------------------
  -- Consent gates (§6). Pre-checked here for a clean, specific error before
  -- attempting any write; the activity_routes/activity_details consent
  -- triggers (enforce_activity_routes_integrity / enforce_activity_details_
  -- integrity, both already live) are the DB-level backstop caught by the
  -- exception handler below if consent is revoked in the narrow race window
  -- between this check and the write.
  -- ---------------------------------------------------------------------
  if v_has_route_input and not exists (
    select 1 from public.user_consents
    where user_id = v_user_id and category = 'location' and revoked_at is null
  ) then
    return jsonb_build_object('error', jsonb_build_object(
      'code', 'CONSENT_REQUIRED_LOCATION', 'message', 'An active location consent is required to save a GPS route.', 'field', 'route_geojson'));
  end if;

  if (p_average_hr is not null or p_max_hr is not null) and not exists (
    select 1 from public.user_consents
    where user_id = v_user_id and category = 'health' and revoked_at is null
  ) then
    return jsonb_build_object('error', jsonb_build_object(
      'code', 'CONSENT_REQUIRED_HEALTH', 'message', 'An active health consent is required to save heart-rate data.', 'field', 'average_hr'));
  end if;

  -- ---------------------------------------------------------------------
  -- Transactional writes. Any exception from here rolls back everything in
  -- this block (implicit savepoint) and returns the error envelope instead
  -- of a partial write or a raw Postgres error.
  -- ---------------------------------------------------------------------
  begin
    v_has_gps_route := v_has_route_input or exists (
      select 1 from public.activity_routes where timeline_event_id = p_id
    );

    with upsert as (
      insert into public.timeline_events (
        id, user_id, source_module, event_type, occurred_at, local_date, event_timezone,
        energy_kcal, duration_seconds, source, visibility, client_created_at
      )
      values (
        p_id, v_user_id, 'activity', 'gps_activity', p_occurred_at, p_local_date, p_event_timezone,
        p_energy_kcal, p_duration_seconds, p_source, p_visibility, p_client_created_at
      )
      on conflict (id) do update set
        occurred_at      = excluded.occurred_at,
        local_date       = excluded.local_date,
        event_timezone   = excluded.event_timezone,
        energy_kcal      = excluded.energy_kcal,
        duration_seconds = excluded.duration_seconds,
        visibility       = excluded.visibility
      where timeline_events.user_id = v_user_id
      returning id
    )
    select count(*) into v_rows_affected from upsert;

    if v_rows_affected = 0 then
      return jsonb_build_object('error', jsonb_build_object(
        'code', 'ID_CONFLICT', 'message', 'The provided id is already in use by a different record.', 'field', 'id'));
    end if;

    with upsert as (
      insert into public.activity_details (
        timeline_event_id, user_id, activity_type_code, activity_type_name_snapshot,
        title, description, distance_m, unit_distance_snapshot, moving_time_seconds,
        elevation_gain_m, elevation_loss_m, average_speed_mps, max_speed_mps,
        average_hr, max_hr, has_gps_route, calories_source
      )
      values (
        p_id, v_user_id, p_activity_type_code, v_activity_type.display_name,
        p_title, p_description, p_distance_m, p_unit_distance_snapshot, p_moving_time_seconds,
        p_elevation_gain_m, p_elevation_loss_m, p_average_speed_mps, p_max_speed_mps,
        p_average_hr, p_max_hr, v_has_gps_route, p_calories_source
      )
      on conflict (timeline_event_id) do update set
        activity_type_code           = excluded.activity_type_code,
        activity_type_name_snapshot  = excluded.activity_type_name_snapshot,
        title                        = excluded.title,
        description                  = excluded.description,
        distance_m                   = excluded.distance_m,
        unit_distance_snapshot       = excluded.unit_distance_snapshot,
        moving_time_seconds          = excluded.moving_time_seconds,
        elevation_gain_m             = excluded.elevation_gain_m,
        elevation_loss_m             = excluded.elevation_loss_m,
        average_speed_mps            = excluded.average_speed_mps,
        max_speed_mps                = excluded.max_speed_mps,
        average_hr                   = excluded.average_hr,
        max_hr                       = excluded.max_hr,
        has_gps_route                = excluded.has_gps_route,
        calories_source              = excluded.calories_source
      where activity_details.user_id = v_user_id
      returning timeline_event_id
    )
    select count(*) into v_rows_affected from upsert;

    if v_rows_affected = 0 then
      return jsonb_build_object('error', jsonb_build_object(
        'code', 'ID_CONFLICT', 'message', 'The activity detail row could not be written (ownership conflict).', 'field', 'id'));
    end if;

    if v_has_route_input then
      insert into public.activity_routes (
        timeline_event_id, user_id, simplified_path, raw_track_object_path,
        raw_track_checksum, raw_point_count, simplified_point_count
      )
      values (
        p_id, v_user_id, v_geom, p_raw_track_object_path,
        p_raw_track_checksum, p_raw_point_count, p_simplified_point_count
      )
      on conflict (timeline_event_id) do update set
        simplified_path         = excluded.simplified_path,
        raw_track_object_path   = excluded.raw_track_object_path,
        raw_track_checksum      = excluded.raw_track_checksum,
        raw_point_count         = excluded.raw_point_count,
        simplified_point_count  = excluded.simplified_point_count
      where activity_routes.user_id = v_user_id;
    end if;

    -- PR detection (§4.3): O(#applicable metrics) point lookups, not a
    -- history scan. unit_snapshot is null for longest_duration (a duration
    -- has no km/mi display unit).
    perform private._pr_apply_or_recompute(
      v_user_id, p_activity_type_code, 'longest_duration',
      p_duration_seconds::numeric, null, p_id, p_occurred_at
    );

    if v_activity_type.is_distance_based then
      perform private._pr_apply_or_recompute(
        v_user_id, p_activity_type_code, 'longest_distance',
        p_distance_m, p_unit_distance_snapshot, p_id, p_occurred_at
      );
      perform private._pr_apply_or_recompute(
        v_user_id, p_activity_type_code, 'fastest_avg_pace',
        p_average_speed_mps, p_unit_distance_snapshot, p_id, p_occurred_at
      );

      if v_activity_type.tracks_elevation then
        perform private._pr_apply_or_recompute(
          v_user_id, p_activity_type_code, 'most_elevation_gain',
          p_elevation_gain_m, p_unit_distance_snapshot, p_id, p_occurred_at
        );
      end if;
    end if;

    select coalesce(jsonb_agg(jsonb_build_object('metric', metric, 'value', value, 'rank', rank) order by metric), '[]'::jsonb)
      into v_achievements
    from public.activity_achievements
    where timeline_event_id = p_id;

  exception when others then
    return jsonb_build_object('error', jsonb_build_object(
      'code',
        case sqlstate
          when '42501' then 'CONSENT_REQUIRED' -- one of the seam-integrity/consent triggers fired; pre-checks above should make this rare (race window only)
          when '23505' then 'ID_CONFLICT'
          when '23503' then 'VALIDATION_ERROR'
          when '23514' then 'VALIDATION_ERROR'
          when '22023' then 'MOVING_TIME_EXCEEDS_ELAPSED'
          else 'WRITE_FAILED'
        end,
      'message', sqlerrm,
      'field', null
    ));
  end;

  return jsonb_build_object('data', jsonb_build_object(
    'id', p_id,
    'activity_type_code', p_activity_type_code,
    'occurred_at', p_occurred_at,
    'local_date', p_local_date,
    'duration_seconds', p_duration_seconds,
    'moving_time_seconds', p_moving_time_seconds,
    'distance_m', p_distance_m,
    'has_gps_route', v_has_gps_route,
    'energy_kcal', p_energy_kcal,
    'achievements', v_achievements
  ));
end;
$$;

comment on function public.save_activity_v1(
  uuid, text, timestamptz, date, text, integer,
  public.timeline_source, public.timeline_visibility, numeric,
  text, text, numeric, text, integer, numeric, numeric, numeric, numeric,
  numeric, numeric, public.activity_calories_source, jsonb, text, text,
  text, integer, integer, timestamptz
) is
  'Phase 1 Module A save/finish/edit RPC (§5). SECURITY INVOKER, transactional '
  'across timeline_events + activity_details + activity_routes + PR detection. '
  'Returns {"data": {...}} on success or {"error": {"code","message","field"}} '
  'on a business-rule violation — see docs/api/save-activity-v1.md for the '
  'full contract. Version-suffixed per supabase-standards: a breaking contract '
  'change ships as save_activity_v2, never a mutation of this function''s '
  'behavior out from under app versions already in the field.';

revoke execute on function public.save_activity_v1(
  uuid, text, timestamptz, date, text, integer,
  public.timeline_source, public.timeline_visibility, numeric,
  text, text, numeric, text, integer, numeric, numeric, numeric, numeric,
  numeric, numeric, public.activity_calories_source, jsonb, text, text,
  text, integer, integer, timestamptz
) from public, anon;

grant execute on function public.save_activity_v1(
  uuid, text, timestamptz, date, text, integer,
  public.timeline_source, public.timeline_visibility, numeric,
  text, text, numeric, text, integer, numeric, numeric, numeric, numeric,
  numeric, numeric, public.activity_calories_source, jsonb, text, text,
  text, integer, integer, timestamptz
) to authenticated;

-- =============================================================================
-- public.recompute_prs_for_user_v1(p_user_id) — §4.3 backfill path
--
-- One-time, bounded backfill for wearable/history import (or AI-03
-- cold-start, per the doc): call once *after* all historical activities have
-- been imported (each import call itself goes through save_activity_v1, so
-- it already ran the steady-state O(#metrics) detection per activity — this
-- RPC is only needed because that steady-state detection, applied in
-- arbitrary import order, does NOT guarantee the final personal_records row
-- reflects the true best if activities are imported out of chronological
-- order; a single explicit backfill pass settles that ambiguity once).
--
-- p_user_id defaults to auth.uid() and is asserted to equal auth.uid() if a
-- caller supplies it explicitly — SECURITY INVOKER + RLS on every touched
-- table already makes it impossible to actually recompute another user's
-- PRs (every read/write below is owner-scoped), but this makes the mismatch
-- fail with a clear, specific error instead of a silently-empty no-op.
--
-- Bounded per §4.3: loops only over the (activity_type_code) values the
-- user actually has non-deleted activities in — not the full activity_types
-- catalog — so cost scales with the user's own history's type diversity,
-- not the global catalog size.
-- =============================================================================
create or replace function public.recompute_prs_for_user_v1(
  p_user_id uuid default auth.uid()
)
returns jsonb
language plpgsql
security invoker
set search_path = public, pg_temp
as $$
declare
  v_user_id             uuid;
  v_type                 record;
  v_metrics_recomputed   integer := 0;
begin
  v_user_id := auth.uid();

  if v_user_id is null then
    return jsonb_build_object('error', jsonb_build_object('code', 'UNAUTHENTICATED', 'message', 'No authenticated user context.', 'field', null));
  end if;

  if p_user_id is not null and p_user_id <> v_user_id then
    return jsonb_build_object('error', jsonb_build_object(
      'code', 'FORBIDDEN', 'message', 'Cannot recompute personal records for another user.', 'field', 'p_user_id'));
  end if;

  for v_type in
    select distinct ad.activity_type_code as code, at.is_distance_based, at.tracks_elevation
    from public.activity_details ad
    join public.activity_types at on at.code = ad.activity_type_code
    join public.timeline_events te on te.id = ad.timeline_event_id
    where ad.user_id = v_user_id
      and te.deleted_at is null
  loop
    perform private._pr_recompute_metric(v_user_id, v_type.code, 'longest_duration');
    v_metrics_recomputed := v_metrics_recomputed + 1;

    if v_type.is_distance_based then
      perform private._pr_recompute_metric(v_user_id, v_type.code, 'longest_distance');
      perform private._pr_recompute_metric(v_user_id, v_type.code, 'fastest_avg_pace');
      v_metrics_recomputed := v_metrics_recomputed + 2;

      if v_type.tracks_elevation then
        perform private._pr_recompute_metric(v_user_id, v_type.code, 'most_elevation_gain');
        v_metrics_recomputed := v_metrics_recomputed + 1;
      end if;
    end if;
  end loop;

  return jsonb_build_object('data', jsonb_build_object('metrics_recomputed', v_metrics_recomputed));

exception when others then
  return jsonb_build_object('error', jsonb_build_object('code', 'WRITE_FAILED', 'message', sqlerrm, 'field', null));
end;
$$;

comment on function public.recompute_prs_for_user_v1(uuid) is
  'Phase 1 Module A bounded PR backfill (§4.3): one indexed MAX-per-metric '
  'aggregate per (activity_type, metric) the calling user actually has '
  'activities in — for use once after bulk wearable/history import, not on '
  'a hot path. p_user_id defaults to and is asserted to equal auth.uid().';

revoke execute on function public.recompute_prs_for_user_v1(uuid) from public, anon;
grant execute on function public.recompute_prs_for_user_v1(uuid) to authenticated;
