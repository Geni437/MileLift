-- =============================================================================
-- Phase 0 — CORE-18 unified profile
-- Design ref: docs/architecture/phase-0-foundation.md §2, §8
--
-- Creates:
--   - public.profiles              (1:1 with auth.users, low-sensitivity identity/prefs)
--   - public.set_updated_at()      (generic updated_at trigger fn, reused by later migrations)
--   - public.handle_new_user()     (auth.users -> profiles provisioning trigger fn)
--   - trigger on auth.users        (fires handle_new_user on signup)
--   - public.profiles_public       (column-safe view for cross-user public-field reads)
--
-- RLS ships in this same migration (supabase-standards: never a follow-up task).
--
-- ROLLBACK: see supabase/migrations/rollbacks/20260718210814_create_profiles.sql
-- This is a one-way forward migration per Supabase CLI convention (the CLI has no
-- native down-migration mechanism); the paired rollback script is a hand-tested
-- reversal to run manually (e.g. `psql -f ...`) if this needs to be backed out
-- post-deploy. It is safe to run even if some objects were already partially
-- torn down (uses IF EXISTS / CASCADE).
-- =============================================================================

-- -----------------------------------------------------------------------------
-- Generic "maintain updated_at on every UPDATE" trigger function.
-- Reused by profiles, user_consents, profile_health, timeline_events.
-- Not an RPC target: revoke default PUBLIC EXECUTE so PostgREST never exposes
-- it as a callable /rpc/set_updated_at endpoint.
-- -----------------------------------------------------------------------------
create or replace function public.set_updated_at()
returns trigger
language plpgsql
security invoker
set search_path = public, pg_temp
as $$
begin
  new.updated_at = now();
  return new;
end;
$$;

revoke execute on function public.set_updated_at() from public, anon, authenticated;

comment on function public.set_updated_at() is
  'Trigger-only helper: stamps NEW.updated_at = now() on UPDATE. Not intended for direct RPC invocation.';

-- -----------------------------------------------------------------------------
-- public.profiles
-- -----------------------------------------------------------------------------
create table public.profiles (
  id                     uuid primary key references auth.users (id) on delete cascade,

  username               text
    constraint profiles_username_format_chk
      check (username is null or username ~ '^[a-zA-Z0-9_.]{3,30}$'),

  display_name           text,
  avatar_url             text,

  unit_weight            text not null default 'kg'
    constraint profiles_unit_weight_chk check (unit_weight in ('kg', 'lb')),
  unit_distance          text not null default 'km'
    constraint profiles_unit_distance_chk check (unit_distance in ('km', 'mi')),

  default_timezone       text not null default 'UTC',

  -- Deletion-request marker for the confirmed §12 policy: hard-delete after a
  -- ~30-day grace window. Setting this column (an UPDATE, covered by the owner
  -- UPDATE policy below) is how a user *requests* account deletion. The actual
  -- hard DELETE + cascade is performed by a scheduled service-role job once
  -- deletion_requested_at <= now() - 30 days (job implementation is Phase 0
  -- devops/edge-function scope, not this migration — see migration header notes
  -- in the report for why this table intentionally has no client-facing DELETE
  -- policy). NULL = no deletion requested.
  deletion_requested_at  timestamptz,

  created_at             timestamptz not null default now(),
  updated_at             timestamptz not null default now()
);

comment on table public.profiles is
  'CORE-18 unified profile. 1:1 with auth.users, provisioned by handle_new_user(). '
  'Low-sensitivity identity/preferences only — sensitive demographics live in '
  'profile_health (see docs/architecture/phase-0-foundation.md §2, §6).';
comment on column public.profiles.deletion_requested_at is
  'Set by the owner to request account deletion. A scheduled service-role job '
  'hard-deletes the row (cascading) ~30 days after this is set. NULL = not requested.';

-- Supports the future scheduled hard-purge job scanning for accounts past their
-- grace window: WHERE deletion_requested_at IS NOT NULL AND deletion_requested_at
-- <= now() - interval '30 days'. Partial + sparse: negligible write-path cost since
-- almost all rows have this column NULL.
create index idx_profiles_pending_deletion
  on public.profiles (deletion_requested_at)
  where deletion_requested_at is not null;

create trigger trg_profiles_set_updated_at
  before update on public.profiles
  for each row
  execute function public.set_updated_at();

-- -----------------------------------------------------------------------------
-- RLS — enabled in this same migration, per supabase-standards / Master Build Prompt.
--
-- Boundary per §8: "Owner (id = auth.uid()) full access. Cross-user SELECT
-- limited to public fields ... via a column-safe view or a scoped policy."
--
-- Deviation flagged: "full access" is implemented here as owner SELECT/INSERT/
-- UPDATE. Owner DELETE is deliberately NOT granted via RLS. A raw RLS-level
-- DELETE would let any client instantly hard-delete + cascade the account on a
-- single PostgREST call, which directly defeats the person's confirmed §12
-- decision ("hard-delete after a ~30-day grace window"). Account deletion is
-- instead a two-step flow: owner sets deletion_requested_at (an UPDATE, already
-- covered below) and a scheduled service-role job performs the real DELETE after
-- the grace window — service-role bypasses RLS entirely, so it needs no owner
-- DELETE policy here. Flagging this for the architect/person to confirm; see
-- the task report for full reasoning.
-- -----------------------------------------------------------------------------
alter table public.profiles enable row level security;

create policy profiles_select_own
  on public.profiles
  for select
  to authenticated
  using (id = auth.uid());

create policy profiles_insert_own
  on public.profiles
  for insert
  to authenticated
  with check (id = auth.uid());

create policy profiles_update_own
  on public.profiles
  for update
  to authenticated
  using (id = auth.uid())
  with check (id = auth.uid());

-- Base object-level grant (RLS is a row filter on top of this, not a substitute
-- for it — PostgREST roles need the underlying GRANT too).
grant select, insert on public.profiles to authenticated;
-- Column-scoped UPDATE grant: clients may only ever change the mutable
-- preference/identity fields and the deletion-request marker — never id or
-- created_at (immutable), never updated_at (trigger-maintained).
grant update (
  username, display_name, avatar_url,
  unit_weight, unit_distance, default_timezone,
  deletion_requested_at
) on public.profiles to authenticated;

-- -----------------------------------------------------------------------------
-- public.profiles_public — column-safe view for cross-user reads.
--
-- Deliberately created WITHOUT `security_invoker = true`: a plain view runs
-- with the privileges of its OWNER (the migration role, which owns and is
-- therefore exempt from RLS on public.profiles), so it bypasses the owner-only
-- base-table RLS policies above and returns every user's public columns to any
-- authenticated caller. This is the intended "public directory" behavior and is
-- the exact "column-safe view" pattern called out in §8. Do NOT "fix" this to
-- security_invoker = true — that would silently re-apply owner-only RLS and
-- make this view return zero rows for every other user, breaking username/
-- avatar lookups app-wide without an obvious error.
-- -----------------------------------------------------------------------------
create view public.profiles_public as
  select id, username, display_name, avatar_url
  from public.profiles;

comment on view public.profiles_public is
  'Public-field-only projection of profiles for cross-user reads (username, '
  'display_name, avatar_url). Intentionally bypasses owner-only RLS on the base '
  'table via view-owner privilege — see migration comment. Never add '
  'preference/demographic columns to this view.';

grant select on public.profiles_public to authenticated;

-- -----------------------------------------------------------------------------
-- Signup trigger: auth.users insert -> public.profiles row.
--
-- SECURITY DEFINER because it must write to public.profiles on behalf of a
-- brand-new auth.users row before that user has an authenticated session/JWT
-- (RLS's auth.uid() context doesn't apply to trigger execution anyway; this
-- runs as the function owner, which owns/bypasses RLS on profiles). Per
-- supabase-standards' SECURITY DEFINER rule, authorization is validated
-- explicitly here rather than relying on RLS: the function only ever inserts a
-- profile row keyed to NEW.id, i.e. the exact auth.users row that just got
-- created by Supabase Auth — there is no caller-supplied id to trust or
-- mis-trust.
--
-- ON CONFLICT DO NOTHING makes this idempotent: a retried/duplicate trigger
-- fire (or a race) cannot produce a second profiles row for the same user,
-- satisfying "a signup produces exactly one profiles row" even under retry.
--
-- search_path is pinned to prevent search_path hijacking of a SECURITY DEFINER
-- function (a well-known Postgres/Supabase footgun).
-- -----------------------------------------------------------------------------
create or replace function public.handle_new_user()
returns trigger
language plpgsql
security definer
set search_path = public, pg_temp
as $$
begin
  insert into public.profiles (id, default_timezone)
  values (
    new.id,
    coalesce(nullif(new.raw_user_meta_data ->> 'timezone', ''), 'UTC')
  )
  on conflict (id) do nothing;

  return new;
end;
$$;

comment on function public.handle_new_user() is
  'Provisions exactly one public.profiles row per new auth.users row. '
  'SECURITY DEFINER, idempotent via ON CONFLICT DO NOTHING. Not exposed as RPC.';

-- This function must never be callable directly over PostgREST (/rpc/handle_new_user)
-- by anon/authenticated clients — it should only ever fire via the AFTER INSERT
-- trigger on auth.users below. Postgres grants EXECUTE to PUBLIC by default on
-- function creation, so this revoke is required, not optional.
revoke execute on function public.handle_new_user() from public, anon, authenticated;

drop trigger if exists on_auth_user_created on auth.users;
create trigger on_auth_user_created
  after insert on auth.users
  for each row
  execute function public.handle_new_user();
