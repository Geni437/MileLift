-- =============================================================================
-- Phase 1 — Module A: activity_achievements (immutable per-activity PR log)
-- Design ref: docs/architecture/phase-1-module-a.md §4.2, §8
--
-- The immutable historical log of what an activity earned *when it
-- happened*, independent of later PRs -- a badge earned then is a fact, not
-- something a future activity should erase (historical-integrity discipline,
-- Phase 0 §1.5). Drives the "this activity set N PRs" badge without
-- recomputation.
--
-- ROLLBACK: see supabase/migrations/rollbacks/20260719133700_create_activity_achievements.sql
-- =============================================================================

create type public.activity_achievement_rank as enum ('pr', 'second', 'third');

comment on type public.activity_achievement_rank is
  'Top-3-style rank, if desired; pr alone is the minimum (§4.2). Add-only enum.';

-- -----------------------------------------------------------------------------
-- public.activity_achievements
--
-- Immutable: no updated_at, no UPDATE policy, no DELETE policy -- rows are
-- only ever removed via the timeline_events ON DELETE CASCADE (§7: "rows for
-- a deleted activity cascade away with it -- they were facts about that
-- activity").
-- -----------------------------------------------------------------------------
create table public.activity_achievements (
  id                 uuid primary key default gen_random_uuid(),

  timeline_event_id  uuid not null references public.timeline_events (id) on delete cascade,
  -- Denormalized for RLS; consistency with timeline_events.user_id enforced
  -- by the trigger below.
  user_id            uuid not null references public.profiles (id) on delete cascade,

  metric             public.activity_pr_metric not null,
  value              numeric not null
    constraint activity_achievements_value_non_negative_chk check (value >= 0),
  rank               public.activity_achievement_rank,

  created_at         timestamptz not null default now()
);

comment on table public.activity_achievements is
  'Immutable per-activity PR log (§4.2) -- a badge earned by an activity is a '
  'fact about that activity, never rewritten by a later PR. No client UPDATE '
  'or DELETE; rows cascade away only with their parent event.';

-- Idempotency guard: a retried save never double-inserts a badge (§4.2).
create unique index uq_activity_achievements_timeline_event_metric
  on public.activity_achievements (timeline_event_id, metric);

-- "This user's achievement/PR history over time" (CORE-04 PR/achievement
-- surfaces, §13).
create index idx_activity_achievements_user_created_at
  on public.activity_achievements (user_id, created_at);

-- -----------------------------------------------------------------------------
-- Seam-integrity trigger (insert-only -- no UPDATE policy exists on this
-- table).
-- -----------------------------------------------------------------------------
create or replace function public.enforce_activity_achievements_user_id_matches_spine()
returns trigger
language plpgsql
security invoker
set search_path = public, pg_temp
as $$
declare
  v_spine_user_id uuid;
begin
  select user_id into v_spine_user_id
    from public.timeline_events
    where id = new.timeline_event_id;

  if v_spine_user_id is null then
    raise exception
      'activity_achievements write rejected: no timeline_events row found for id %',
      new.timeline_event_id
      using errcode = '23503';
  end if;

  if v_spine_user_id <> new.user_id then
    raise exception
      'activity_achievements.user_id (%) does not match timeline_events.user_id (%) for event %',
      new.user_id, v_spine_user_id, new.timeline_event_id
      using errcode = '42501';
  end if;

  return new;
end;
$$;

comment on function public.enforce_activity_achievements_user_id_matches_spine() is
  'Trigger: user_id must match the achieving event''s user_id.';

revoke execute on function public.enforce_activity_achievements_user_id_matches_spine() from public, anon, authenticated;

create trigger trg_activity_achievements_enforce_integrity
  before insert on public.activity_achievements
  for each row
  execute function public.enforce_activity_achievements_user_id_matches_spine();

create trigger trg_activity_achievements_force_insert_created_at
  before insert on public.activity_achievements
  for each row
  execute function public.force_insert_created_at();

-- -----------------------------------------------------------------------------
-- RLS (§8): owner-only in Phase 1. SELECT/INSERT only -- immutable, no
-- UPDATE, no DELETE (cross-user feed badges depend on the deferred
-- cross-user activity exposure + follows, Phase 4 -- defer widening).
-- -----------------------------------------------------------------------------
alter table public.activity_achievements enable row level security;

create policy activity_achievements_select_own
  on public.activity_achievements
  for select
  to authenticated
  using (user_id = auth.uid());

create policy activity_achievements_insert_own
  on public.activity_achievements
  for insert
  to authenticated
  with check (user_id = auth.uid());

grant select, insert on public.activity_achievements to authenticated;
-- Deliberately no UPDATE/DELETE grant -- immutable log per §4.2.
