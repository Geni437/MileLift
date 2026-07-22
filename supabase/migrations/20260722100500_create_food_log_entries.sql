-- =============================================================================
-- Phase 3 — Module B: food_log_entries (CORE-06/08 subtype, 1:1 with the spine)
-- Design ref: docs/architecture/phase-3-module-b.md §1.5, §1.9, §3, §6, §8, §8.1
--
-- Shared PK = timeline_event_id, 1:1 FK to timeline_events.id, inserted in
-- the same transaction as its spine row via the (backend-builder-owned)
-- save_food_log_entry_v1 RPC. Covers event_type = 'food_log_entry'. Grain
-- decision (§1.5): one event = one eating occasion/meal, foods are the
-- food_log_items child collection (next migration) -- mirrors
-- workout_sessions -> workout_set_logs.
--
-- NOT consent-gated (§6/§12 decision 3): ordinary food logging is treated
-- as core-product app data, unlike bodyweight/body_measurements. Share-
-- capable, private-by-default (§6/§12 decision 4) -- food_log_entry is NOT
-- in the spine's never-shareable set (timeline_events_sensitive_private_chk
-- already excludes it), so visibility defaults to 'private' per the spine's
-- own column default and can be widened per-event by the owner via the
-- spine's existing column-scoped UPDATE grant on timeline_events.visibility.
--
-- ROLLBACK: see supabase/migrations/rollbacks/20260722100500_create_food_log_entries.sql
-- =============================================================================

create type public.meal_type as enum ('breakfast', 'lunch', 'dinner', 'snack', 'other');

comment on type public.meal_type is
  'CORE-08 grouping (§1.5). Add-only enum.';

-- -----------------------------------------------------------------------------
-- public.food_log_entries
-- -----------------------------------------------------------------------------
create table public.food_log_entries (
  timeline_event_id      uuid primary key references public.timeline_events (id) on delete cascade,

  -- Denormalized for RLS per §1.5/§8; consistency with the spine's own
  -- user_id enforced by the trigger below.
  user_id                 uuid not null references public.profiles (id) on delete cascade,

  meal_type               public.meal_type not null,
  title                   text,
  notes                   text,

  -- Snapshots recomputed by the save RPC on every edit (§1.5), never live-
  -- re-summed -- also mirrored onto the spine's energy_kcal so cross-module
  -- reads (§4) never touch this detail table.
  total_energy_kcal       numeric not null
    constraint food_log_entries_total_energy_non_negative_chk check (total_energy_kcal >= 0),
  total_protein_g         numeric
    constraint food_log_entries_total_protein_non_negative_chk check (total_protein_g is null or total_protein_g >= 0),
  total_carb_g            numeric
    constraint food_log_entries_total_carb_non_negative_chk check (total_carb_g is null or total_carb_g >= 0),
  total_fat_g             numeric
    constraint food_log_entries_total_fat_non_negative_chk check (total_fat_g is null or total_fat_g >= 0),

  created_at              timestamptz not null default now(),
  updated_at              timestamptz not null default now()
);

comment on table public.food_log_entries is
  'CORE-06/08 meal/eating-occasion subtype, 1:1 with timeline_events (shared '
  'PK, event_type = food_log_entry). Meal-level metadata + snapshot totals '
  'only -- individual foods are the food_log_items child collection. Not '
  'consent-gated (§6/§12 decision 3); share-capable, private-by-default '
  '(§6/§12 decision 4) via the spine''s own visibility column.';
comment on column public.food_log_entries.total_energy_kcal is
  'Snapshot at save: sum of item energy_kcal. Recomputed by the save RPC on '
  'every edit and written onto timeline_events.energy_kcal (positive '
  'intake) so the CORE-11 daily-balance read (§4) never touches this table.';

-- -----------------------------------------------------------------------------
-- Seam-integrity trigger (§1.9): (1) user_id must match the spine row's
-- user_id, mirroring enforce_body_measurements_integrity; (2) the spine
-- row's event_type must be 'food_log_entry'. No consent check -- §6/§12
-- decision 3 explicitly excludes ordinary food logging from any gate.
-- -----------------------------------------------------------------------------
create or replace function public.enforce_food_log_entries_integrity()
returns trigger
language plpgsql
security invoker
set search_path = public, pg_temp
as $$
declare
  v_spine_user_id    uuid;
  v_spine_event_type public.timeline_event_type;
begin
  select user_id, event_type
    into v_spine_user_id, v_spine_event_type
    from public.timeline_events
    where id = new.timeline_event_id;

  if v_spine_user_id is null then
    raise exception
      'food_log_entries write rejected: no timeline_events row found for id %',
      new.timeline_event_id
      using errcode = '23503';
  end if;

  if v_spine_user_id <> new.user_id then
    raise exception
      'food_log_entries.user_id (%) does not match timeline_events.user_id (%) for event %',
      new.user_id, v_spine_user_id, new.timeline_event_id
      using errcode = '42501';
  end if;

  if v_spine_event_type <> 'food_log_entry' then
    raise exception
      'food_log_entries write rejected: timeline_events.event_type (%) for event % is not food_log_entry',
      v_spine_event_type, new.timeline_event_id
      using errcode = '42501';
  end if;

  return new;
end;
$$;

comment on function public.enforce_food_log_entries_integrity() is
  'Trigger: (1) user_id must match the spine event''s user_id, (2) '
  'event_type must be food_log_entry. §1.9. No consent gate -- ordinary '
  'food logging is not consent-gated (§6/§12 decision 3).';

revoke execute on function public.enforce_food_log_entries_integrity() from public, anon, authenticated;

create trigger trg_food_log_entries_enforce_integrity
  before insert or update on public.food_log_entries
  for each row
  execute function public.enforce_food_log_entries_integrity();

create trigger trg_food_log_entries_set_updated_at
  before update on public.food_log_entries
  for each row
  execute function public.set_updated_at();

create trigger trg_food_log_entries_force_insert_audit_timestamps
  before insert on public.food_log_entries
  for each row
  execute function public.force_insert_audit_timestamps();

-- -----------------------------------------------------------------------------
-- RLS (§8): owner-only via denormalized user_id. SELECT/INSERT/UPDATE, no
-- client DELETE (soft-delete on the parent spine row + cascade at
-- hard-purge, mirroring workout_sessions/activity_details).
-- -----------------------------------------------------------------------------
alter table public.food_log_entries enable row level security;

create policy food_log_entries_select_own
  on public.food_log_entries
  for select
  to authenticated
  using (user_id = auth.uid());

create policy food_log_entries_insert_own
  on public.food_log_entries
  for insert
  to authenticated
  with check (user_id = auth.uid());

create policy food_log_entries_update_own
  on public.food_log_entries
  for update
  to authenticated
  using (user_id = auth.uid())
  with check (user_id = auth.uid());

grant select, insert on public.food_log_entries to authenticated;

-- -----------------------------------------------------------------------------
-- Column-scoped UPDATE grant (§8.1 -- RECURRING LESSON, THIS EXACT BUG CLASS
-- HAS BROKEN user_consents + SIX Phase 2 TABLES ALREADY). Any `.upsert()`
-- against food_log_entries MUST supply only the mutable columns below (an
-- explicit column list, never a whole-row object), or it will fail to plan
-- at INSERT ... ON CONFLICT time -- Postgres checks UPDATE privilege on
-- every ON CONFLICT SET column even on a brand-new row.
--
--   MUTABLE   (client UPDATE granted): meal_type, title, notes,
--     total_energy_kcal, total_protein_g, total_carb_g, total_fat_g.
--   IMMUTABLE (excluded, per §8.1 verbatim): timeline_event_id, user_id,
--     created_at.
--
-- The write path SHOULD be save_food_log_entry_v1 (backend-builder) -- see
-- that RPC's own header for why it, too, must stay within this same mutable
-- column set for its ON CONFLICT SET list.
-- -----------------------------------------------------------------------------
grant update (
  meal_type, title, notes, total_energy_kcal, total_protein_g, total_carb_g, total_fat_g
) on public.food_log_entries to authenticated;

-- CORRECTED GUIDANCE (live-proven against custom_foods, see
-- 20260722999999_revert_custom_foods_diagnostic_grant.sql for the full
-- account, applies identically here): restricting an .upsert() payload to
-- mutable columns is NECESSARY but NOT SUFFICIENT. PostgREST's .upsert()
-- always includes the conflict-target column (timeline_event_id) in its ON
-- CONFLICT DO UPDATE SET list whenever it is present in the payload --
-- which it always must be, to target a specific row -- so ANY .upsert()
-- against an EXISTING row here will still fail (timeline_event_id has no
-- UPDATE grant, correctly). Editing an existing row MUST use a plain
-- .update({...mutableCols}).eq('timeline_event_id', x) -- never .upsert().
-- save_food_log_entry_v1 avoids this by supplying real values for every
-- NOT NULL column on INSERT and restricting its own ON CONFLICT SET list to
-- this same mutable set -- the dual discipline a bare client .upsert() lacks.
