-- =============================================================================
-- Phase 0 — sensitive demographics, consent-gated
-- Design ref: docs/architecture/phase-0-foundation.md §2, §6, §8, §12 item 3
--
-- Creates public.profile_health: sex, date of birth, height. Collected
-- optionally at point-of-use (never required at signup), kept out of
-- public.profiles so its access/consent can be reasoned about independently.
--
-- ROLLBACK: see supabase/migrations/rollbacks/20260718210837_create_profile_health.sql
-- =============================================================================

-- -----------------------------------------------------------------------------
-- public.profile_health
--
-- 1:1 with profiles, PK = user_id (not a separate surrogate id) since this is
-- a single sensitive-attributes row per user, not a history/log.
--
-- ASSUMPTION FLAGGED: the architecture doc names *which* attributes to collect
-- (sex, DOB, height) but not the permitted value set for `sex`, nor the storage
-- unit for `height`. Neither is a schema-architecture decision worth blocking
-- Phase 0 on, but both are product/UX-owned specifics (§13: ui-ux-designer owns
-- the point-of-use prompts) that should be confirmed before the consent screen
-- ships:
--   - `sex` uses an inclusive, extend-by-migration CHECK list rather than a
--     rigid binary, to avoid the schema forcing a bad UX choice later.
--   - `height_cm` stores a canonical unit (centimeters) regardless of the
--     user's display unit_distance preference, since height isn't a
--     historical/logged measurement (unlike bodyweight, which is a timeline
--     event) — there is one current value, so no per-record unit snapshot is
--     needed here the way db-schema-standards requires for logged quantities.
-- -----------------------------------------------------------------------------
create table public.profile_health (
  user_id       uuid primary key references public.profiles (id) on delete cascade,

  sex           text
    constraint profile_health_sex_chk
      check (sex is null or sex in ('female', 'male', 'intersex', 'other', 'prefer_not_to_say')),

  date_of_birth date
    constraint profile_health_dob_range_chk
      check (
        date_of_birth is null
        or (date_of_birth <= current_date and date_of_birth >= current_date - interval '120 years')
      ),

  height_cm     numeric(5, 1)
    constraint profile_health_height_range_chk
      check (height_cm is null or (height_cm > 0 and height_cm < 300)),

  created_at    timestamptz not null default now(),
  updated_at    timestamptz not null default now()
);

comment on table public.profile_health is
  'Sensitive, consent-gated demographics (sex, DOB, height) per §6/§12. Never '
  'required at signup, never in public.profiles, never widened cross-user. '
  'Writes are rejected at the DB level unless an active health-category consent '
  'row exists in user_consents (see enforce_health_consent trigger below).';
comment on column public.profile_health.height_cm is
  'Canonical unit: centimeters. Convert for display per profiles.unit_distance '
  'in the client/API layer.';

create trigger trg_profile_health_set_updated_at
  before update on public.profile_health
  for each row
  execute function public.set_updated_at();

-- -----------------------------------------------------------------------------
-- DB-level consent gate (db-schema-standards: enforce invariants at the DB
-- layer, not only in application code — an app-level "check consent, then
-- insert" is exactly the check-then-act pattern that a bug in a different code
-- path, an admin script, or direct DB access can bypass).
--
-- Blocks INSERT/UPDATE of a profile_health row unless the user currently has an
-- active (non-revoked) 'health' consent row in user_consents. Withdrawal is
-- functional per §6: if consent is later revoked, subsequent writes are
-- rejected (existing data is not auto-deleted by this trigger — that's a
-- separate degrade-gracefully/erasure decision for the consent-withdrawal flow,
-- out of this migration's scope).
-- -----------------------------------------------------------------------------
create or replace function public.enforce_health_consent()
returns trigger
language plpgsql
security invoker
set search_path = public, pg_temp
as $$
begin
  if not exists (
    select 1
    from public.user_consents
    where user_id = new.user_id
      and category = 'health'
      and revoked_at is null
  ) then
    raise exception
      'profile_health write rejected: no active health-category consent on file for user %',
      new.user_id
      using errcode = '42501'; -- insufficient_privilege
  end if;

  return new;
end;
$$;

comment on function public.enforce_health_consent() is
  'Trigger: rejects INSERT/UPDATE on profile_health unless an active health '
  'consent row exists in user_consents. DB-level enforcement of the §6 consent gate.';

revoke execute on function public.enforce_health_consent() from public, anon, authenticated;

create trigger trg_profile_health_enforce_consent
  before insert or update on public.profile_health
  for each row
  execute function public.enforce_health_consent();

-- -----------------------------------------------------------------------------
-- RLS — owner-only, never widened, per §8. Full CRUD (unlike profiles/
-- timeline_events, this table has no grace-window deletion pattern — a user
-- revoking/deleting their own sensitive demographics should take effect
-- immediately, not after a delay).
-- -----------------------------------------------------------------------------
alter table public.profile_health enable row level security;

create policy profile_health_select_own
  on public.profile_health
  for select
  to authenticated
  using (user_id = auth.uid());

create policy profile_health_insert_own
  on public.profile_health
  for insert
  to authenticated
  with check (user_id = auth.uid());

create policy profile_health_update_own
  on public.profile_health
  for update
  to authenticated
  using (user_id = auth.uid())
  with check (user_id = auth.uid());

create policy profile_health_delete_own
  on public.profile_health
  for delete
  to authenticated
  using (user_id = auth.uid());

grant select, insert, delete on public.profile_health to authenticated;
grant update (sex, date_of_birth, height_cm) on public.profile_health to authenticated;
