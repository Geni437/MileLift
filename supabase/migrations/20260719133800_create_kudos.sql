-- =============================================================================
-- Phase 1 — Module A: kudos (the one cross-user table, §8.1)
-- Design ref: docs/architecture/phase-1-module-a.md §8.1
--
-- Kudos is a social edge, not a timeline event (Phase 0 §1.1 is explicit:
-- kudos/reactions/follows are edges) -- it does NOT go on the spine. Built
-- now to satisfy CORE-05 though conceptually Module D (§11/§12 item 1).
--
-- ROLLBACK: see supabase/migrations/rollbacks/20260719133800_create_kudos.sql
-- =============================================================================

create type public.kudos_reaction_type as enum ('kudos');

comment on type public.kudos_reaction_type is
  'One reaction type at launch; extensible to emoji reactions later (§8.1). '
  'Add-only enum.';

-- -----------------------------------------------------------------------------
-- public.kudos
-- -----------------------------------------------------------------------------
create table public.kudos (
  id                     uuid primary key default gen_random_uuid(),

  timeline_event_id      uuid not null references public.timeline_events (id) on delete cascade,
  actor_user_id          uuid not null references public.profiles (id) on delete cascade,
  -- Denormalized owner of the target event, for the "kudos on my activities"
  -- query + a simpler policy. Consistency with the target event's own
  -- user_id is enforced by the trigger below.
  target_owner_user_id   uuid not null references public.profiles (id) on delete cascade,

  reaction_type          public.kudos_reaction_type not null default 'kudos',

  created_at             timestamptz not null default now()
);

comment on table public.kudos is
  'Social edge (not a timeline event) recording a reaction to an activity '
  '(§8.1). The one Module A table with a genuine cross-user read/write '
  'policy. actor-only DELETE is a reasoned exception to the app''s '
  'no-client-DELETE default -- un-kudos must take effect immediately.';

-- One kudos per user per activity; makes a retried insert a no-op (§8.1).
create unique index uq_kudos_timeline_event_actor_reaction
  on public.kudos (timeline_event_id, actor_user_id, reaction_type);

-- "Kudos on my activities" / notifications read (§8.1). Also serves
-- COUNT(*) WHERE timeline_event_id = X via the leftmost column of the unique
-- index above, so no separate (timeline_event_id) index is needed.
create index idx_kudos_target_owner_created_at
  on public.kudos (target_owner_user_id, created_at);

-- -----------------------------------------------------------------------------
-- Seam-integrity trigger: target_owner_user_id must match the target event's
-- actual owner (§8.1: "Copied at insert; enforce it matches the target
-- event's user_id"). Insert-only -- kudos has no UPDATE policy.
-- -----------------------------------------------------------------------------
create or replace function public.enforce_kudos_target_owner_matches_spine()
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
      'kudos write rejected: no timeline_events row found for id %',
      new.timeline_event_id
      using errcode = '23503';
  end if;

  if v_spine_user_id <> new.target_owner_user_id then
    raise exception
      'kudos.target_owner_user_id (%) does not match timeline_events.user_id (%) for event %',
      new.target_owner_user_id, v_spine_user_id, new.timeline_event_id
      using errcode = '42501';
  end if;

  return new;
end;
$$;

comment on function public.enforce_kudos_target_owner_matches_spine() is
  'Trigger: target_owner_user_id must match the target event''s actual owner.';

revoke execute on function public.enforce_kudos_target_owner_matches_spine() from public, anon, authenticated;

create trigger trg_kudos_enforce_integrity
  before insert on public.kudos
  for each row
  execute function public.enforce_kudos_target_owner_matches_spine();

create trigger trg_kudos_force_insert_created_at
  before insert on public.kudos
  for each row
  execute function public.force_insert_created_at();

-- -----------------------------------------------------------------------------
-- RLS (§8.1) -- the one Module A table with a genuine cross-user policy.
--
-- "Can see the target" is expressed as `exists (select 1 from
-- timeline_events te where te.id = kudos.timeline_event_id)` rather than
-- duplicating the visibility = 'public' check inline: a policy's subquery
-- against another RLS-enabled table is itself filtered by that table's own
-- policies for the current role, so this EXISTS resolves to true exactly
-- when timeline_events' *own* SELECT policies (today: owner-or-public; from
-- Phase 4: also followers) would let the current user see that row. This
-- means kudos' visibility rule widens automatically the moment
-- timeline_events_select_public is extended for follows, with no change
-- needed here -- exactly the property §8.1 calls out.
-- -----------------------------------------------------------------------------
alter table public.kudos enable row level security;

create policy kudos_insert_own
  on public.kudos
  for insert
  to authenticated
  with check (
    actor_user_id = auth.uid()
    and target_owner_user_id <> auth.uid()
    and exists (
      select 1 from public.timeline_events te
      where te.id = kudos.timeline_event_id
    )
  );

create policy kudos_select_visible
  on public.kudos
  for select
  to authenticated
  using (
    actor_user_id = auth.uid()
    or target_owner_user_id = auth.uid()
    or exists (
      select 1 from public.timeline_events te
      where te.id = kudos.timeline_event_id
    )
  );

-- Reasoned exception to the no-client-DELETE default (§8.1): un-kudos is not
-- health/log data and must take effect immediately, not after a grace
-- window.
create policy kudos_delete_own
  on public.kudos
  for delete
  to authenticated
  using (actor_user_id = auth.uid());

grant select, insert, delete on public.kudos to authenticated;
-- No UPDATE grant -- kudos has no UPDATE policy (§8.1: "No UPDATE").
