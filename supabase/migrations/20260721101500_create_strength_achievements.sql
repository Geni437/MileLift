-- =============================================================================
-- Phase 2 — Module C: strength_achievements (immutable per-set PR log)
-- Design ref: docs/architecture/phase-2-module-c.md §1.10, §4.3, §8
--
-- Mirrors Module A's activity_achievements exactly (20260719133700): the
-- immutable historical log of what a set earned *when it happened*,
-- independent of later PRs -- a badge earned then is a fact, not something a
-- future set should erase (historical-integrity discipline, Phase 0 §1.5).
--
-- ROLLBACK: see supabase/migrations/rollbacks/20260721101500_create_strength_achievements.sql
-- =============================================================================

create table public.strength_achievements (
  id                  uuid primary key default gen_random_uuid(),

  timeline_event_id   uuid not null references public.timeline_events (id) on delete cascade,
  source_set_log_id   uuid not null references public.workout_set_logs (id) on delete cascade,
  -- Denormalized for RLS; consistency with timeline_events.user_id enforced
  -- by the trigger below.
  user_id             uuid not null references public.profiles (id) on delete cascade,

  metric              public.strength_pr_metric not null,
  value               numeric not null
    constraint strength_achievements_value_non_negative_chk check (value >= 0),

  created_at          timestamptz not null default now()
);

comment on table public.strength_achievements is
  'Immutable per-set PR log (§1.10, §4.3) -- a badge earned by a set is a '
  'fact about that set, never rewritten by a later PR. No client UPDATE or '
  'DELETE; rows cascade away only if their source set is hard-purged.';

-- Idempotency guard: a retried save never double-inserts a badge (§4.3, same
-- ON CONFLICT (source_set_log_id, metric) DO NOTHING pattern as Module A).
create unique index uq_strength_achievements_source_set_log_metric
  on public.strength_achievements (source_set_log_id, metric);

-- "This user's PR/achievement history over time" (CORE-15 surfaces, §13).
create index idx_strength_achievements_user_created_at
  on public.strength_achievements (user_id, created_at);

-- -----------------------------------------------------------------------------
-- Seam-integrity trigger (insert-only -- no UPDATE policy exists on this
-- table), mirroring enforce_activity_achievements_user_id_matches_spine.
-- -----------------------------------------------------------------------------
create or replace function public.enforce_strength_achievements_user_id_matches_spine()
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
      'strength_achievements write rejected: no timeline_events row found for id %',
      new.timeline_event_id
      using errcode = '23503';
  end if;

  if v_spine_user_id <> new.user_id then
    raise exception
      'strength_achievements.user_id (%) does not match timeline_events.user_id (%) for event %',
      new.user_id, v_spine_user_id, new.timeline_event_id
      using errcode = '42501';
  end if;

  return new;
end;
$$;

comment on function public.enforce_strength_achievements_user_id_matches_spine() is
  'Trigger: user_id must match the achieving event''s user_id.';

revoke execute on function public.enforce_strength_achievements_user_id_matches_spine() from public, anon, authenticated;

create trigger trg_strength_achievements_enforce_integrity
  before insert on public.strength_achievements
  for each row
  execute function public.enforce_strength_achievements_user_id_matches_spine();

create trigger trg_strength_achievements_force_insert_created_at
  before insert on public.strength_achievements
  for each row
  execute function public.force_insert_created_at();

-- -----------------------------------------------------------------------------
-- RLS (§8): owner-only in Phase 2. SELECT/INSERT only -- immutable, no
-- UPDATE, no DELETE (cross-user feed badges are a Phase 4 concern -- defer
-- widening, mirroring activity_achievements).
-- -----------------------------------------------------------------------------
alter table public.strength_achievements enable row level security;

create policy strength_achievements_select_own
  on public.strength_achievements
  for select
  to authenticated
  using (user_id = auth.uid());

create policy strength_achievements_insert_own
  on public.strength_achievements
  for insert
  to authenticated
  with check (user_id = auth.uid());

grant select, insert on public.strength_achievements to authenticated;
-- Deliberately no UPDATE/DELETE grant -- immutable log per §4.3.
