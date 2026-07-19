-- =============================================================================
-- Phase 0 — per-category consent tracking
-- Design ref: docs/architecture/phase-0-foundation.md §6, §8, §12 item 5
--
-- Creates public.user_consents. Must exist before profile_health (next
-- migration), because profile_health's insert/update trigger checks this table
-- for an active health-category consent row.
--
-- ROLLBACK: see supabase/migrations/rollbacks/20260718210826_create_user_consents.sql
-- =============================================================================

create type public.consent_category as enum ('health', 'location', 'camera');

comment on type public.consent_category is
  'Consent categories per §6. Extend by migration, add-only (never remove/rename '
  'a value — non-breaking per supabase-standards).';

-- -----------------------------------------------------------------------------
-- public.user_consents
--
-- Design: append-only consent history, not a single mutable row per category.
-- Re-granting after a revocation inserts a NEW row rather than overwriting the
-- old one, so the full grant/revoke history is preserved for audit purposes —
-- this is the GDPR-baseline "strictest common denominator" posture §12 item 5
-- calls for (being able to prove what was consented to and when). "Active
-- consent for category X" = the row for (user_id, category) with
-- revoked_at IS NULL; the partial unique index below guarantees at most one
-- such row exists per (user_id, category) at any time.
-- -----------------------------------------------------------------------------
create table public.user_consents (
  id               uuid primary key default gen_random_uuid(),
  user_id          uuid not null references public.profiles (id) on delete cascade,
  category         public.consent_category not null,
  purpose_version  text not null
    constraint user_consents_purpose_version_not_blank_chk check (length(trim(purpose_version)) > 0),
  granted_at       timestamptz not null default now(),
  revoked_at       timestamptz
    constraint user_consents_revoked_after_granted_chk check (revoked_at is null or revoked_at >= granted_at),
  created_at       timestamptz not null default now(),
  updated_at       timestamptz not null default now()
);

comment on table public.user_consents is
  'Per-category, explicit, point-of-use consent log (§6). Append-only: revocation '
  'sets revoked_at on the active row; re-consent inserts a new row. Never bundled '
  'into signup, never inferred from continued use.';
comment on column public.user_consents.purpose_version is
  'Version identifier of the consent purpose/policy text the user agreed to '
  '(e.g. a policy revision tag). Lets withdrawal/re-consent be tied to a specific '
  'disclosure version.';

-- At most one *active* (non-revoked) consent row per user+category.
create unique index uq_user_consents_active_category
  on public.user_consents (user_id, category)
  where revoked_at is null;

-- Consent-history reads: "does this user have active consent for category X"
-- and "show this user's full consent history" both filter on (user_id, category).
create index idx_user_consents_user_category
  on public.user_consents (user_id, category, granted_at desc);

create trigger trg_user_consents_set_updated_at
  before update on public.user_consents
  for each row
  execute function public.set_updated_at();

-- -----------------------------------------------------------------------------
-- RLS — owner-only, per §8. No client-facing DELETE: consent history is
-- immutable/append-only from the client's perspective (revocation is an UPDATE
-- of revoked_at, not a row deletion) so the audit trail can't be erased by the
-- user who created it. Rows are only ever removed via the profiles ON DELETE
-- CASCADE at account hard-purge time (service role, bypasses RLS).
-- -----------------------------------------------------------------------------
alter table public.user_consents enable row level security;

create policy user_consents_select_own
  on public.user_consents
  for select
  to authenticated
  using (user_id = auth.uid());

create policy user_consents_insert_own
  on public.user_consents
  for insert
  to authenticated
  with check (user_id = auth.uid());

create policy user_consents_update_own
  on public.user_consents
  for update
  to authenticated
  using (user_id = auth.uid())
  with check (user_id = auth.uid());

grant select, insert on public.user_consents to authenticated;
-- Column-scoped UPDATE: the only legitimate client-initiated update is
-- withdrawing consent (setting revoked_at). category/purpose_version/granted_at
-- are facts about what was granted and must not be editable after the fact.
grant update (revoked_at) on public.user_consents to authenticated;
