-- =============================================================================
-- Phase 1 — Module A: activity_routes (simplified map geometry)
-- Design ref: docs/architecture/phase-1-module-a.md §1.4, §2, §2.3, §6, §8
--
-- Shared PK = timeline_event_id, 1:1 with activity_details. Simplified
-- PostGIS LineStringZ for map rendering; the full-resolution track lives in
-- Storage (see 20260719133900_create_activity_tracks_storage_bucket.sql).
-- Owner-only in Phase 1 (no cross-user route exposure until UNQ-05 privacy
-- zones, §2.3) and location-consent-gated (§6).
--
-- ROLLBACK: see supabase/migrations/rollbacks/20260719133300_create_activity_routes.sql
-- =============================================================================

create table public.activity_routes (
  timeline_event_id        uuid primary key references public.activity_details (timeline_event_id) on delete cascade,

  -- Denormalized for RLS; consistency with activity_details.user_id enforced
  -- by the trigger below.
  user_id                  uuid not null references public.profiles (id) on delete cascade,

  -- Douglas-Peucker/ST_SimplifyVW-reduced path. Z = elevation. This is what
  -- CORE-02 draws (§1.4).
  simplified_path           extensions.geometry(LineStringZ, 4326) not null,

  -- ST_Envelope of the path, for map centering + feed thumbnails. Generated
  -- so it can never drift from simplified_path (§1.4: "May be a generated
  -- column").
  bounds                    extensions.geometry(Polygon, 4326)
    generated always as (extensions.st_envelope(simplified_path)) stored,

  -- Deterministic Storage path per §2.1: activity-tracks/{user_id}/
  -- {timeline_event_id}/track.bin. The CHECK below enforces the path is
  -- actually derived from this row's own user_id/timeline_event_id, at the
  -- DB layer, rather than trusting a client-supplied string.
  raw_track_object_path     text not null,
  raw_track_checksum        text,
  raw_point_count           integer
    constraint activity_routes_raw_point_count_non_negative_chk check (raw_point_count is null or raw_point_count >= 0),
  simplified_point_count    integer
    constraint activity_routes_simplified_point_count_non_negative_chk check (simplified_point_count is null or simplified_point_count >= 0),

  created_at                timestamptz not null default now(),
  updated_at                timestamptz not null default now(),

  constraint activity_routes_raw_track_object_path_chk check (
    raw_track_object_path = 'activity-tracks/' || user_id::text || '/' || timeline_event_id::text || '/track.bin'
  )
);

comment on table public.activity_routes is
  'Simplified map geometry + raw-track Storage pointer for a gps_activity '
  '(§1.4, §2). Owner-only in Phase 1 -- no cross-user route exposure until '
  'UNQ-05 privacy zones (§2.3). Routes are write-once (§9).';
comment on column public.activity_routes.raw_track_object_path is
  'Deterministic Storage path: activity-tracks/{user_id}/{timeline_event_id}/'
  'track.bin (§2.1). CHECK-enforced to actually match this row''s own '
  'user_id/timeline_event_id.';

-- GiST index on simplified_path, added now even though the spatial consumers
-- (UNQ-01 segments, UNQ-04 heatmaps, AI-16) are Phase 2/3 -- routes are
-- write-once, so the index cost is paid once at finish, and retrofitting a
-- GiST index onto a large table later is far more disruptive (§1.4).
create index idx_activity_routes_simplified_path
  on public.activity_routes using gist (simplified_path);

-- -----------------------------------------------------------------------------
-- Seam-integrity + location-consent-gating trigger, reusing the exact
-- enforce_health_consent() pattern from
-- 20260718210837_create_profile_health.sql, applied to the 'location'
-- category per §6 ("GPS recording and route persistence are gated on an
-- active location consent row"). Every row in this table is route data, so
-- the consent check is unconditional (unlike activity_details' conditional
-- average_hr/max_hr gate).
-- -----------------------------------------------------------------------------
create or replace function public.enforce_activity_routes_integrity()
returns trigger
language plpgsql
security invoker
set search_path = public, pg_temp
as $$
declare
  v_detail_user_id uuid;
begin
  select user_id into v_detail_user_id
    from public.activity_details
    where timeline_event_id = new.timeline_event_id;

  if v_detail_user_id is null then
    raise exception
      'activity_routes write rejected: no activity_details row found for event %',
      new.timeline_event_id
      using errcode = '23503';
  end if;

  if v_detail_user_id <> new.user_id then
    raise exception
      'activity_routes.user_id (%) does not match activity_details.user_id (%) for event %',
      new.user_id, v_detail_user_id, new.timeline_event_id
      using errcode = '42501';
  end if;

  if not exists (
    select 1
    from public.user_consents
    where user_id = new.user_id
      and category = 'location'
      and revoked_at is null
  ) then
    raise exception
      'activity_routes write rejected: no active location-category consent on file for user % (CONSENT_REQUIRED_LOCATION)',
      new.user_id
      using errcode = '42501';
  end if;

  return new;
end;
$$;

comment on function public.enforce_activity_routes_integrity() is
  'Trigger: (1) user_id must match activity_details.user_id, (2) an active '
  'location-category consent row is required for every route write. §2/§6.';

revoke execute on function public.enforce_activity_routes_integrity() from public, anon, authenticated;

create trigger trg_activity_routes_enforce_integrity
  before insert or update on public.activity_routes
  for each row
  execute function public.enforce_activity_routes_integrity();

create trigger trg_activity_routes_set_updated_at
  before update on public.activity_routes
  for each row
  execute function public.set_updated_at();

create trigger trg_activity_routes_force_insert_audit_timestamps
  before insert on public.activity_routes
  for each row
  execute function public.force_insert_audit_timestamps();

-- -----------------------------------------------------------------------------
-- RLS (§8): owner-only, including SELECT -- the public feed does NOT expose
-- routes cross-user until privacy zones (Phase 2, §2.3/§12.3). No client
-- DELETE (cascades from the parent activity_details/timeline_events row).
-- -----------------------------------------------------------------------------
alter table public.activity_routes enable row level security;

create policy activity_routes_select_own
  on public.activity_routes
  for select
  to authenticated
  using (user_id = auth.uid());

create policy activity_routes_insert_own
  on public.activity_routes
  for insert
  to authenticated
  with check (user_id = auth.uid());

create policy activity_routes_update_own
  on public.activity_routes
  for update
  to authenticated
  using (user_id = auth.uid())
  with check (user_id = auth.uid());

grant select, insert on public.activity_routes to authenticated;
-- Column-scoped UPDATE excluding timeline_event_id/user_id (immutable
-- identity columns). `bounds` is a generated column and is never directly
-- writable regardless of grants, so it is intentionally not listed. UPDATE is
-- only exercised by a retried finish-flow upsert (§2.1: "a retry of either
-- step is safe") -- routes are otherwise write-once (§9).
grant update (
  simplified_path, raw_track_object_path, raw_track_checksum,
  raw_point_count, simplified_point_count
) on public.activity_routes to authenticated;
