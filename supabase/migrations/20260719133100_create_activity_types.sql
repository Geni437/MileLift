-- =============================================================================
-- Phase 1 — Module A: activity_types reference catalog
-- Design ref: docs/architecture/phase-1-module-a.md §1.1, §8, §12 (remaining
-- action: "propose a sensible launch seed list ... extending the list later
-- is an INSERT, not a schema change")
--
-- Reference table, NOT user-owned, NOT a timeline event — same ownership
-- class as the exercise/food libraries (Phase 0 §5/§8): global, read-mostly,
-- service-role-write. Modeled as a table (not an enum) because PR detection
-- (§4) and rendering need per-type metadata an enum can't carry.
--
-- ROLLBACK: see supabase/migrations/rollbacks/20260719133100_create_activity_types.sql
-- =============================================================================

create type public.activity_category as enum ('foot', 'cycle', 'water', 'winter', 'gym_cardio', 'other');

comment on type public.activity_category is
  'Grouping for UI + defaults (§1.1). Extend by migration (add value only).';

-- -----------------------------------------------------------------------------
-- public.activity_types
-- -----------------------------------------------------------------------------
create table public.activity_types (
  code               text primary key
    constraint activity_types_code_not_blank_chk check (length(trim(code)) > 0),

  display_name       text not null
    constraint activity_types_display_name_not_blank_chk check (length(trim(display_name)) > 0),

  category           public.activity_category not null,

  is_distance_based  boolean not null,
  tracks_elevation   boolean not null,
  supports_gps       boolean not null,

  sort_order         integer not null default 0,

  created_at         timestamptz not null default now(),
  updated_at         timestamptz not null default now()
);

comment on table public.activity_types is
  'Extensible activity-type catalog (§1.1). Global read-mostly reference data, '
  'not user-owned. Writes restricted to service_role. activity_details '
  'snapshots display_name at log time so editing this catalog never '
  'retroactively rewrites recorded history (§1.3).';
comment on column public.activity_types.is_distance_based is
  'Drives which PR metrics apply (§4.1) and whether distance/pace are shown.';
comment on column public.activity_types.tracks_elevation is
  'Whether elevation-gain PRs/stats are meaningful for this type.';
comment on column public.activity_types.supports_gps is
  'Whether the recording engine offers GPS for this type.';

create trigger trg_activity_types_set_updated_at
  before update on public.activity_types
  for each row
  execute function public.set_updated_at();

create trigger trg_activity_types_force_insert_audit_timestamps
  before insert on public.activity_types
  for each row
  execute function public.force_insert_audit_timestamps();

-- -----------------------------------------------------------------------------
-- Launch seed list (db-engineer proposal per §12's remaining action).
-- Not exhaustive by design — extending later is a plain INSERT. Covers the
-- run/ride/walk/hike/swim/row/ski families named in the task, plus a few
-- common indoor/gym-cardio variants and a catch-all `other` so every activity
-- a user records has *some* valid activity_type_code even before the catalog
-- grows further.
-- -----------------------------------------------------------------------------
insert into public.activity_types
  (code, display_name, category, is_distance_based, tracks_elevation, supports_gps, sort_order)
values
  ('run',                 'Run',                 'foot',       true,  true,  true,  10),
  ('trail_run',           'Trail Run',           'foot',       true,  true,  true,  20),
  ('walk',                'Walk',                'foot',       true,  true,  true,  30),
  ('hike',                'Hike',                'foot',       true,  true,  true,  40),
  ('ride',                'Ride',                'cycle',      true,  true,  true,  50),
  ('mountain_bike_ride',  'Mountain Bike Ride',  'cycle',      true,  true,  true,  60),
  ('indoor_ride',         'Indoor Ride',         'cycle',      true,  false, false, 70),
  ('swim_open_water',     'Open Water Swim',     'water',      true,  false, true,  80),
  ('swim_pool',           'Pool Swim',           'water',      true,  false, false, 90),
  ('row',                 'Row',                 'water',      true,  false, true,  100),
  ('indoor_row',          'Indoor Row',          'gym_cardio', true,  false, false, 110),
  ('ski_alpine',          'Alpine Ski',          'winter',     true,  true,  true,  120),
  ('ski_nordic',          'Cross-Country Ski',   'winter',     true,  true,  true,  130),
  ('snowboard',           'Snowboard',           'winter',     true,  true,  true,  140),
  ('elliptical',          'Elliptical',          'gym_cardio', true,  false, false, 150),
  ('stair_stepper',       'Stair Stepper',       'gym_cardio', false, false, false, 160),
  ('hiit',                'HIIT',                'gym_cardio', false, false, false, 170),
  ('yoga',                'Yoga',                'other',      false, false, false, 180),
  ('other',                'Other',              'other',      false, false, false, 999)
on conflict (code) do nothing;

-- -----------------------------------------------------------------------------
-- RLS (§8): public read to authenticated; writes restricted to service role
-- (no INSERT/UPDATE/DELETE policy for authenticated at all — service_role
-- bypasses RLS entirely, so it needs no policy here; anon gets nothing).
-- -----------------------------------------------------------------------------
alter table public.activity_types enable row level security;

create policy activity_types_select_all
  on public.activity_types
  for select
  to authenticated
  using (true);

grant select on public.activity_types to authenticated;
-- Deliberately no insert/update/delete grant to anon/authenticated — matches
-- the schema-level default-privilege backstop (20260719130400) which already
-- leaves this table with zero anon/authenticated access until explicitly
-- granted; only SELECT is granted here.
