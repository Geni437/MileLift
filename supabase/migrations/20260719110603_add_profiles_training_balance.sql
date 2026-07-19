-- =============================================================================
-- Phase 0 fix — server column for the onboarding "training balance" slider
-- Design ref: docs/design/screens-phase-0.md Step 2 ("Where's your training
-- right now?" — endurance/strength balance track, readout e.g. "70 / 30
-- run / lift") and Profile §2 ("Training balance" section, same control).
--
-- Gap: mobile-builder built this against a device-local-only SQLite table
-- (src/db/schema.ts: local_preferences.training_balance_run) because
-- public.profiles had no matching column, so the value doesn't sync across
-- devices or survive a reinstall — see the flagged assumption in
-- src/db/repositories/localPreferencesRepository.ts. This is a per-user
-- preference exactly like unit_weight/unit_distance already on profiles (not
-- a point-in-time occurrence, so it does not belong on timeline_events per
-- architecture §1.1's "identity/preferences" exclusion) — no architect
-- round-trip needed, per the coordinator's brief.
--
-- Column design: a single smallint (not two), storing the "run"/endurance
-- share as a 0-100 percentage; the "lift"/strength share is always
-- (100 - value) and is derived at read time rather than also stored — the
-- design doc's control is a single knob on one axis (§Step 2: "Dragging it
-- literally sets where warm meets cool"), so the two shares are not
-- independent facts, they're one value and its complement. Storing both
-- would introduce a sum-to-100 invariant across two columns that a CHECK
-- would have to enforce anyway, for no benefit over deriving the complement
-- in application code / a view.
--
-- Naming vs. the mobile client's local column: the client's SQLite column is
-- `training_balance_run` (see src/db/schema.ts). This migration names the
-- server column `training_balance_run_pct` — the `_pct` suffix makes the
-- unit unambiguous from the column name alone (matching this table's own
-- `height_cm`-style unit-suffixed naming in profile_health), rather than
-- relying on a comment to convey "0-100 share" the way the client-side
-- column currently does. mobile-builder's sync mapping code will need
-- `training_balance_run` (local) <-> `training_balance_run_pct` (server).
--
-- Default: 50 (Balanced), matching both the design doc's stated onboarding
-- default ("Skip for now... balance = Balanced") and the client's existing
-- local default.
--
-- Lock/downtime note (db-schema-standards): public.profiles has 0 rows on
-- the live linked project as of this migration (pre-launch). Adding a NOT
-- NULL column with a constant default is additionally a metadata-only,
-- non-rewriting operation on Postgres 11+ regardless of row count (no full
-- table rewrite, no long lock) — so this ships as a single straightforward
-- ADD COLUMN, not a nullable-then-backfill-then-tighten sequence. That
-- staged approach would still be the right call for a column whose default
-- depends on per-row data (it doesn't here — every row gets the same
-- constant default) or for a database where the constant-default fast path
-- isn't available.
--
-- ROLLBACK: see supabase/migrations/rollbacks/20260719110603_add_profiles_training_balance.sql
-- =============================================================================

alter table public.profiles
  add column training_balance_run_pct smallint not null default 50
    constraint profiles_training_balance_run_pct_range_chk
      check (training_balance_run_pct between 0 and 100);

comment on column public.profiles.training_balance_run_pct is
  'Onboarding/profile training-balance slider: 0-100 share of training '
  'identity weighted toward "run"/endurance (design doc Step 2). "Lift"/'
  'strength share is always (100 - this value), derived at read time, not '
  'stored separately. Default 50 = Balanced, matching the design doc''s '
  'stated onboarding default and the mobile client''s prior local-only '
  'default. Client-side mirror: local_preferences.training_balance_run in '
  'src/db/schema.ts (sync mapping is mobile-builder''s follow-up, not built '
  'in this migration).';

-- No RLS/policy change needed: existing policies on public.profiles
-- (profiles_select_own / profiles_insert_own / profiles_update_own) are
-- row-scoped (id = auth.uid()), not column-scoped, so the new column is
-- already covered for the owner. It is a plain user preference like
-- unit_weight/unit_distance, so it also does not need to appear in
-- profiles_public (that view stays limited to username/display_name/
-- avatar_url per §8 — training balance is not one of the "public fields").
--
-- The existing column-scoped UPDATE grant from the profiles migration,
-- however, explicitly lists grantable columns and predates this one, so it
-- must be extended here or the owner will be unable to write their own
-- training balance (RLS would allow the row, but the column-level GRANT
-- would still reject the column, surfacing as a Postgres
-- insufficient_privilege error) — this is exactly the "confirm rather than
-- assume" check the coordinator asked for, and it did surface a real gap.
grant update (training_balance_run_pct) on public.profiles to authenticated;
