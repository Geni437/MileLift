-- =============================================================================
-- Phase 2 — Module C: exercise_media (video/image demos, CORE-13)
-- Design ref: docs/architecture/phase-2-module-c.md §1.2, §2.2, §3, §8
--
-- Child of exercises, split out because a movement has 0..N media of mixed
-- type/source/license, and the video track backfills independently of the
-- movement metadata (§2.2). Display data, re-fetchable — NOT snapshotted onto
-- set logs (§3): a set log freezes exercise_name_snapshot but never a media URL.
--
-- ROLLBACK: see supabase/migrations/rollbacks/20260721100100_create_exercise_media.sql
-- =============================================================================

create type public.exercise_media_type as enum ('image', 'animation', 'video');

comment on type public.exercise_media_type is
  'Supports the phased content strategy (§2.2): static image now, video '
  'backfilled later — upgrading a movement is an INSERT/row-swap, not a '
  'schema change. Add-only enum.';

create table public.exercise_media (
  id                    uuid primary key default gen_random_uuid(),

  exercise_id           uuid not null references public.exercises (id) on delete cascade,

  media_type            public.exercise_media_type not null,
  url_or_object_path     text not null
    constraint exercise_media_path_not_blank_chk check (length(trim(url_or_object_path)) > 0),

  is_primary            boolean not null default false,

  source                public.source_dataset not null,
  attribution            text,
  license                text,

  sort_order             integer not null default 0,

  created_at             timestamptz not null default now(),
  updated_at             timestamptz not null default now()
);

comment on table public.exercise_media is
  'CORE-13 video/image demos for a library exercise (§1.2). Not user-owned. '
  'Service-role-write (ingestion/content-backfill job), public-read to '
  'authenticated. Never snapshotted onto workout_set_logs (§3) -- display '
  'data only.';
comment on column public.exercise_media.url_or_object_path is
  'Either a hosted/CDN URL or a Storage object path in the exercise-media '
  'bucket (§2.2 hosting decision).';
comment on column public.exercise_media.attribution is
  'Per-media attribution string; the share-alike/attribution obligation is '
  'per-asset for CC-BY-SA sources (§2, §6) and must actually render in-app.';

-- At most one primary media item per exercise (db-engineer invariant, not
-- verbatim from the doc -- "the one shown by default" (§1.2) only makes sense
-- as a singular choice; flagged in the task report).
create unique index uq_exercise_media_primary_per_exercise
  on public.exercise_media (exercise_id)
  where is_primary;

-- "Load this exercise's media in display order" -- the library detail
-- screen's dominant read (§1.2). Leftmost column also serves an
-- exercise_id-only lookup.
create index idx_exercise_media_exercise_sort
  on public.exercise_media (exercise_id, sort_order);

create trigger trg_exercise_media_set_updated_at
  before update on public.exercise_media
  for each row
  execute function public.set_updated_at();

create trigger trg_exercise_media_force_insert_audit_timestamps
  before insert on public.exercise_media
  for each row
  execute function public.force_insert_audit_timestamps();

-- -----------------------------------------------------------------------------
-- RLS (§8): public read to authenticated; service-role write only, same
-- posture as exercises. No insert/update/delete grant for anon/authenticated.
-- -----------------------------------------------------------------------------
alter table public.exercise_media enable row level security;

create policy exercise_media_select_all
  on public.exercise_media
  for select
  to authenticated
  using (true);

grant select on public.exercise_media to authenticated;
