-- =============================================================================
-- Phase 0 — the canonical timeline spine
-- Design ref: docs/architecture/phase-0-foundation.md §1.2, §1.3, §1.4, §3, §8
--
-- Creates public.timeline_events plus its supporting enums and triggers. This
-- is the single hottest write path in the app (§8) — every index below is
-- tied to a named query pattern from the doc, not added reflexively.
--
-- ROLLBACK: see supabase/migrations/rollbacks/20260718210848_create_timeline_events.sql
-- =============================================================================

-- -----------------------------------------------------------------------------
-- Enums. "Extend by migration, add value only — non-breaking" per §1.2/§1.4.
-- Adding a value later: `alter type public.timeline_event_type add value 'x';`
-- (run outside an explicit transaction block on Postgres < 12; fine as a plain
-- statement in a Supabase migration on modern Postgres).
-- -----------------------------------------------------------------------------
create type public.timeline_source_module as enum ('activity', 'nutrition', 'strength', 'community');

create type public.timeline_event_type as enum (
  -- source_module = activity
  'gps_activity', 'sleep_session', 'hr_sample', 'hrv_sample', 'resting_hr',
  -- source_module = nutrition
  'food_log_entry', 'water_intake', 'manual_calorie_burn',
  -- source_module = strength
  'strength_session', 'body_measurement', 'bodyweight', 'progress_photo',
  -- source_module = community
  'native_post'
);

create type public.timeline_source as enum ('manual', 'wearable', 'import', 'ai_parsed', 'system');

create type public.timeline_visibility as enum ('private', 'followers', 'public');

comment on type public.timeline_event_type is
  'Representative Phase-0 taxonomy per §1.4. Extend by migration (add value '
  'only). Adding an energy-bearing type also requires updating the '
  'timeline_events_energy_sign_chk CHECK below and, if it is a raw biometric/'
  'never-shareable type, the timeline_events_sensitive_private_chk CHECK.';

-- -----------------------------------------------------------------------------
-- public.timeline_events
-- -----------------------------------------------------------------------------
create table public.timeline_events (
  -- Client-generated on-device per db-schema-standards (offline-originating
  -- records generate their own key) and doubles as the sync idempotency key
  -- (§3.4: INSERT ... ON CONFLICT (id) DO UPDATE). Defaults to server-generated
  -- only as a fallback for server-originated rows (e.g. an ai_parsed event
  -- created by an Edge Function on the user's behalf) — mobile clients must
  -- always supply their own id explicitly.
  id                  uuid primary key default gen_random_uuid(),

  user_id             uuid not null references public.profiles (id) on delete cascade,

  source_module       public.timeline_source_module not null,
  event_type          public.timeline_event_type not null,

  occurred_at         timestamptz not null,
  local_date          date not null,
  event_timezone      text not null
    constraint timeline_events_event_timezone_not_blank_chk check (length(trim(event_timezone)) > 0),

  energy_kcal         numeric,
  load_score          numeric,
  duration_seconds    integer
    constraint timeline_events_duration_non_negative_chk check (duration_seconds is null or duration_seconds >= 0),

  source              public.timeline_source not null,
  confidence          numeric
    constraint timeline_events_confidence_range_chk check (confidence is null or (confidence >= 0 and confidence <= 1)),
  needs_confirmation  boolean not null default false,

  visibility          public.timeline_visibility not null default 'private',

  client_created_at   timestamptz,
  created_at          timestamptz not null default now(),
  updated_at          timestamptz not null default now(),
  deleted_at          timestamptz,

  -- Energy sign convention (§1.2): positive = intake, negative = expenditure,
  -- enforced per event_type so a wrong-signed value can never silently corrupt
  -- a day's energy balance. NULL always passes (most event_types never carry
  -- energy_kcal at all). Extending the energy-bearing type set requires
  -- updating this CHECK in the same migration that adds the enum value.
  constraint timeline_events_energy_sign_chk check (
    energy_kcal is null
    or (event_type = 'food_log_entry' and energy_kcal >= 0)
    or (event_type in ('manual_calorie_burn', 'gps_activity', 'strength_session') and energy_kcal <= 0)
  ),

  -- Body measurements / progress photos / bodyweight / raw biometric samples
  -- are never shareable (§1.3) — asserted here as a non-widenable DB
  -- constraint, not merely a default users can override.
  constraint timeline_events_sensitive_private_chk check (
    event_type not in (
      'body_measurement', 'bodyweight', 'progress_photo',
      'sleep_session', 'hr_sample', 'hrv_sample', 'resting_hr'
    )
    or visibility = 'private'
  ),

  -- Sanity bound on local_date vs. occurred_at: local calendar date can differ
  -- from the UTC calendar date of occurred_at by at most one day in either
  -- direction (UTC-12 .. UTC+14 covers every real timezone offset). This is a
  -- validation bound, not a derivation — local_date itself is still computed
  -- client-side and trusted as-is within this bound, per §1.2 ("do not derive
  -- this server-side from occurred_at"). Catches malformed/malicious payloads
  -- without ever overwriting the client-supplied value.
  constraint timeline_events_local_date_bound_chk check (
    local_date between (occurred_at at time zone 'UTC')::date - 1
             and (occurred_at at time zone 'UTC')::date + 1
  )
);

comment on table public.timeline_events is
  'Canonical timeline spine (§1). One row per user-owned, point-in-time '
  'occurrence across all modules. Module detail tables (Phase 1-3) attach via a '
  'shared-PK 1:1 FK to this table''s id. Hottest write path in the app.';
comment on column public.timeline_events.energy_kcal is
  'Signed cross-module energy currency: positive = intake, negative = '
  'expenditure. Snapshot at log time, never live-recomputed (§12 item 6).';
comment on column public.timeline_events.load_score is
  'Normalized training-stress currency slot for AI-06. Formula is a Module C/'
  'AI-06 decision (§8 open item); this column is the accepted spine slot.';
comment on column public.timeline_events.local_date is
  'User''s local calendar day, computed on-device from device timezone. Must '
  'never be derived/overwritten server-side (breaks streaks at DST/tz boundaries).';
comment on column public.timeline_events.deleted_at is
  'Soft-delete tombstone; syncs to clients as an update (§3.8). A separate '
  'scheduled hard-purge job performs the real DELETE — see RLS section below '
  'for why there is no client-facing DELETE policy on this table.';

-- -----------------------------------------------------------------------------
-- Bounded clock-skew check: occurred_at must not be more than 24h in the
-- future (named constant below), per §1.2. Implemented as a BEFORE trigger
-- rather than a CHECK constraint referencing now(): Postgres allows volatile
-- functions in CHECK constraints, but it's a well-known footgun (re-validation
-- during dump/restore, ALTER TABLE VALIDATE, etc. depends on wall-clock time at
-- validation time, not insert time). A trigger evaluated once at write time is
-- the correct, standard way to bound "not too far in the future."
-- -----------------------------------------------------------------------------
create or replace function public.enforce_timeline_event_clock_skew()
returns trigger
language plpgsql
security invoker
set search_path = public, pg_temp
as $$
declare
  -- Named constant (production-standards: no bare magic numbers). Bounds
  -- accepted client clock skew for occurred_at.
  clock_skew_tolerance constant interval := interval '24 hours';
begin
  if new.occurred_at > now() + clock_skew_tolerance then
    raise exception
      'timeline_events.occurred_at (%) is further in the future than the % clock-skew tolerance',
      new.occurred_at, clock_skew_tolerance
      using errcode = '22007'; -- invalid_datetime_format (closest standard code for a bad temporal value)
  end if;

  return new;
end;
$$;

comment on function public.enforce_timeline_event_clock_skew() is
  'Trigger: rejects INSERT/UPDATE where occurred_at is more than 24h in the '
  'future, bounding client clock skew per §1.2.';

revoke execute on function public.enforce_timeline_event_clock_skew() from public, anon, authenticated;

create trigger trg_timeline_events_clock_skew
  before insert or update on public.timeline_events
  for each row
  execute function public.enforce_timeline_event_clock_skew();

create trigger trg_timeline_events_set_updated_at
  before update on public.timeline_events
  for each row
  execute function public.set_updated_at();

-- -----------------------------------------------------------------------------
-- Indexes (§8) — each tied to a named query pattern. This table is the
-- hottest write path in the app, so every index here is justified against
-- insert cost rather than added speculatively.
-- -----------------------------------------------------------------------------

-- "This user's events in a date range" — the dominant history/feed read.
-- Partial on deleted_at IS NULL: history/feed reads exclude soft-deleted rows
-- by default (§3.8), so the partial index both serves the hot pattern and
-- stays smaller than a full index.
create index idx_timeline_events_user_occurred_at
  on public.timeline_events (user_id, occurred_at)
  where deleted_at is null;

-- Daily aggregation: SUM(energy_kcal) ... WHERE user_id = $1 AND local_date =
-- $2 (CORE-11/AI-12 energy balance, §4). Same soft-delete exclusion rationale.
create index idx_timeline_events_user_local_date
  on public.timeline_events (user_id, local_date)
  where deleted_at is null;

-- Module-filtered reads ("my strength sessions in this range", AI-06 rolling
-- load, etc.) — (user_id, event_type, occurred_at).
create index idx_timeline_events_user_event_type_occurred_at
  on public.timeline_events (user_id, event_type, occurred_at)
  where deleted_at is null;

-- Sync cursor (§3.6): cursor-based incremental pull on updated_at, scoped to
-- the requesting user. Deliberately NOT partial on deleted_at IS NULL —
-- soft-deleted rows must still sync down (a tombstone is itself an update the
-- client needs to receive to remove the row locally).
create index idx_timeline_events_user_updated_at
  on public.timeline_events (user_id, updated_at);

-- Cross-user feed read: RLS-scoped SELECT ... WHERE visibility <> 'private'
-- ORDER BY occurred_at (see timeline_events_select_public policy below).
-- Partial on both conditions actually used by that query.
create index idx_timeline_events_feed_visible
  on public.timeline_events (visibility, occurred_at)
  where deleted_at is null and visibility <> 'private';

-- Note: no separate plain index on user_id alone — every composite index above
-- leads with user_id, so a user_id-only query is already served by the
-- leftmost-column rule; a redundant single-column index would only add write
-- cost without serving a distinct named pattern.

-- -----------------------------------------------------------------------------
-- RLS (§8) — enabled in this same migration.
--
-- Owner: full CRUD is implemented as SELECT/INSERT/UPDATE. Deliberately NO
-- owner DELETE policy, for the same reason as public.profiles: §3.8/§7
-- describe deletion as soft-delete-via-UPDATE (setting deleted_at) followed by
-- a *separate scheduled hard-purge job* — i.e. even single-event deletion goes
-- through a grace-window-then-purge pattern, not an instant client-issued
-- DELETE. The owner UPDATE policy below already covers setting deleted_at
-- (soft-delete "syncs as an update" per §3.8). The scheduled purge job runs
-- under the service role, which bypasses RLS entirely, so it needs no owner
-- DELETE grant here. Flagging this interpretation of "full CRUD" for the
-- architect/person to confirm — see the task report.
--
-- Cross-user read: the one table with a real cross-user SELECT policy per §8.
-- Phase 0 has no follows/social-graph table yet (Module D, Phase 4), so this
-- gates on visibility = 'public' only, per explicit task scope. See the TODO
-- comment on the policy for exactly where the Phase 4 follow-relationship join
-- must be added.
-- -----------------------------------------------------------------------------
alter table public.timeline_events enable row level security;

create policy timeline_events_select_own
  on public.timeline_events
  for select
  to authenticated
  using (user_id = auth.uid());

create policy timeline_events_insert_own
  on public.timeline_events
  for insert
  to authenticated
  with check (user_id = auth.uid());

create policy timeline_events_update_own
  on public.timeline_events
  for update
  to authenticated
  using (user_id = auth.uid())
  with check (user_id = auth.uid());

-- TODO(Phase 4 / Module D community graph): this policy currently allows
-- reading another user's event only when visibility = 'public'. Once the
-- follows table exists, tighten/extend this policy to also admit
-- visibility = 'followers' rows where a follow relationship exists, e.g.:
--
--   using (
--     deleted_at is null
--     and (
--       visibility = 'public'
--       or (
--         visibility = 'followers'
--         and exists (
--           select 1 from public.follows f
--           where f.follower_id = auth.uid()
--             and f.followee_id = timeline_events.user_id
--         )
--       )
--     )
--   )
--
-- Until that join exists, 'followers'-visibility rows are NOT exposed to
-- non-owners by this policy (they behave as private to everyone but the
-- owner) — this is the correct fail-closed behavior for a visibility tier
-- whose enforcement mechanism doesn't exist yet, not an oversight.
create policy timeline_events_select_public
  on public.timeline_events
  for select
  to authenticated
  using (
    deleted_at is null
    and visibility = 'public'
  );

grant select, insert on public.timeline_events to authenticated;
-- Column-scoped UPDATE: corrections (§7 — "a user edits an incorrect logged
-- weight/measurement directly") and soft-delete (setting deleted_at) are both
-- legitimate client updates. id, user_id, source, client_created_at and
-- created_at are excluded — they describe immutable facts about how/when the
-- row originated and must never be rewritten after the fact (user_id is also
-- separately enforced by the RLS WITH CHECK above; excluding it here is
-- defense in depth at the column-privilege layer).
grant update (
  event_type, occurred_at, local_date, event_timezone,
  energy_kcal, load_score, duration_seconds,
  confidence, needs_confirmation, visibility,
  deleted_at
) on public.timeline_events to authenticated;
