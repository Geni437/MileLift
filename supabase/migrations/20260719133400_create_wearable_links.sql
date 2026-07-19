-- =============================================================================
-- Phase 1 — Module A: wearable_links (provenance & dedup)
-- Design ref: docs/architecture/phase-1-module-a.md §3.3, §3.4, §8
--
-- Records, per activity, both inbound external_record_id (so a re-read of the
-- same session upserts, never duplicates) and outbound-created record ids
-- (so read-back skips MileLift's own writes) -- the loop-prevention mechanism
-- for CORE-03 two-way Health Connect sync.
--
-- ROLLBACK: see supabase/migrations/rollbacks/20260719133400_create_wearable_links.sql
-- =============================================================================

create type public.wearable_provider as enum ('health_connect', 'wear_os', 'garmin', 'apple_health');
create type public.wearable_link_direction as enum ('inbound', 'outbound');

comment on type public.wearable_provider is
  'Only health_connect/wear_os are exercised in Phase 1; garmin/apple_health '
  'exist so the shape does not preclude them later (§3.4). Add-only enum.';

-- -----------------------------------------------------------------------------
-- Generic "force created_at = now() on INSERT" trigger helper, for the
-- created_at-only immutable-log tables Module A introduces (wearable_links,
-- activity_achievements, kudos -- none of which have an updated_at column, so
-- the existing force_insert_audit_timestamps() from
-- 20260719130646_force_server_controlled_audit_timestamps.sql, which stamps
-- both created_at AND updated_at, does not apply). Same rationale as that
-- migration: a deterministic BEFORE INSERT trigger rather than a
-- column-scoped INSERT grant, which 20260719112010/20260719112940 showed is
-- fragile under later table-level REVOKEs.
-- -----------------------------------------------------------------------------
create or replace function public.force_insert_created_at()
returns trigger
language plpgsql
security invoker
set search_path = public, pg_temp
as $$
begin
  new.created_at = now();
  return new;
end;
$$;

revoke execute on function public.force_insert_created_at() from public, anon, authenticated;

comment on function public.force_insert_created_at() is
  'Trigger-only helper: forces NEW.created_at to now() on INSERT for tables '
  'that have created_at but no updated_at. Not intended for direct RPC invocation.';

-- -----------------------------------------------------------------------------
-- public.wearable_links
--
-- Immutable link facts: no UPDATE policy/grant (a wrong link is deleted and
-- re-inserted, not edited in place).
-- -----------------------------------------------------------------------------
create table public.wearable_links (
  id                  uuid primary key default gen_random_uuid(),

  timeline_event_id   uuid not null references public.activity_details (timeline_event_id) on delete cascade,
  -- Denormalized for RLS; consistency with activity_details.user_id enforced
  -- by the trigger below.
  user_id             uuid not null references public.profiles (id) on delete cascade,

  provider            public.wearable_provider not null,
  direction           public.wearable_link_direction not null,
  external_record_id  text not null
    constraint wearable_links_external_record_id_not_blank_chk check (length(trim(external_record_id)) > 0),

  synced_at           timestamptz not null,
  created_at          timestamptz not null default now()
);

comment on table public.wearable_links is
  'Wearable sync provenance/dedup, owner-only (§3.4/§8). Immutable once '
  'written -- no client UPDATE.';

-- Idempotency guard: re-reading/re-writing the same provider record is a
-- no-op (§3.4).
create unique index uq_wearable_links_provider_direction_external_record
  on public.wearable_links (provider, direction, external_record_id);

-- "How did this activity sync" (§3.4).
create index idx_wearable_links_timeline_event_id
  on public.wearable_links (timeline_event_id);

-- -----------------------------------------------------------------------------
-- Seam-integrity trigger (insert-only -- no UPDATE policy exists on this
-- table, so there is nothing to guard on update).
-- -----------------------------------------------------------------------------
create or replace function public.enforce_wearable_links_user_id_matches_spine()
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
      'wearable_links write rejected: no activity_details row found for event %',
      new.timeline_event_id
      using errcode = '23503';
  end if;

  if v_detail_user_id <> new.user_id then
    raise exception
      'wearable_links.user_id (%) does not match activity_details.user_id (%) for event %',
      new.user_id, v_detail_user_id, new.timeline_event_id
      using errcode = '42501';
  end if;

  return new;
end;
$$;

comment on function public.enforce_wearable_links_user_id_matches_spine() is
  'Trigger: user_id must match activity_details.user_id for the referenced event.';

revoke execute on function public.enforce_wearable_links_user_id_matches_spine() from public, anon, authenticated;

create trigger trg_wearable_links_enforce_integrity
  before insert on public.wearable_links
  for each row
  execute function public.enforce_wearable_links_user_id_matches_spine();

create trigger trg_wearable_links_force_insert_created_at
  before insert on public.wearable_links
  for each row
  execute function public.force_insert_created_at();

-- -----------------------------------------------------------------------------
-- RLS (§8): owner-only. INSERT/SELECT/DELETE by owner (dedup housekeeping);
-- no cross-user exposure, no UPDATE.
-- -----------------------------------------------------------------------------
alter table public.wearable_links enable row level security;

create policy wearable_links_select_own
  on public.wearable_links
  for select
  to authenticated
  using (user_id = auth.uid());

create policy wearable_links_insert_own
  on public.wearable_links
  for insert
  to authenticated
  with check (user_id = auth.uid());

create policy wearable_links_delete_own
  on public.wearable_links
  for delete
  to authenticated
  using (user_id = auth.uid());

grant select, insert, delete on public.wearable_links to authenticated;
-- Deliberately no UPDATE grant -- links are immutable facts (§3.4).
