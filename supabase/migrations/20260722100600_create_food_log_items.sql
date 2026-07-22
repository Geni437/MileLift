-- =============================================================================
-- Phase 3 — Module B: food_log_items (the per-food firehose, CORE-06)
-- Design ref: docs/architecture/phase-3-module-b.md §1.6, §1.9, §3, §8, §8.1, §9
--
-- The heart of CORE-06 logging and the offline-idempotency design (§9). One
-- row per food in the meal, each carrying its OWN client-generated id (a
-- second idempotency grain below the meal, exactly like workout_set_logs).
-- Hangs off food_log_entries, NOT the spine (Phase 0 §1.5). Snapshots the
-- food's name + per-serving macros so editing/removing the reference food
-- never rewrites this logged item (§3, the gate rule).
--
-- ROLLBACK: see supabase/migrations/rollbacks/20260722100600_create_food_log_items.sql
-- =============================================================================

create table public.food_log_items (
  -- Client-generated on-device -- the per-item idempotency key (§9).
  id                          uuid primary key default gen_random_uuid(),

  timeline_event_id           uuid not null references public.food_log_entries (timeline_event_id) on delete cascade,
  -- Denormalized for RLS; consistency with the parent meal's user_id
  -- enforced by the trigger below.
  user_id                     uuid not null references public.profiles (id) on delete cascade,

  food_id                     uuid references public.foods (id),
  custom_food_id              uuid references public.custom_foods (id),

  -- Snapshot at log time (§3, the gate rule) -- editing/re-normalizing/
  -- hiding the referenced food never rewrites this row's history.
  food_name_snapshot          text not null
    constraint food_log_items_food_name_snapshot_not_blank_chk check (length(trim(food_name_snapshot)) > 0),
  brand_snapshot               text,
  serving_label_snapshot       text not null
    constraint food_log_items_serving_label_snapshot_not_blank_chk check (length(trim(serving_label_snapshot)) > 0),

  quantity                     numeric not null
    constraint food_log_items_quantity_positive_chk check (quantity > 0),
  serving_g_or_ml_snapshot     numeric not null
    constraint food_log_items_serving_weight_snapshot_positive_chk check (serving_g_or_ml_snapshot > 0),

  -- Snapshot macros (§3): quantity * serving_g_or_ml_snapshot / 100 * the
  -- referenced food's per-basis macro, computed and frozen at log time --
  -- never live-recomputed.
  energy_kcal                  numeric not null
    constraint food_log_items_energy_non_negative_chk check (energy_kcal >= 0),
  protein_g                    numeric
    constraint food_log_items_protein_non_negative_chk check (protein_g is null or protein_g >= 0),
  carb_g                       numeric
    constraint food_log_items_carb_non_negative_chk check (carb_g is null or carb_g >= 0),
  fat_g                        numeric
    constraint food_log_items_fat_non_negative_chk check (fat_g is null or fat_g >= 0),

  data_quality_snapshot        public.food_data_quality,

  sort_order                    integer not null
    constraint food_log_items_sort_order_non_negative_chk check (sort_order >= 0),

  -- Soft-delete: a removed item syncs as an explicit deleted_at, never an
  -- omission (§9: "upsert-present, never delete-omitted") -- a truncated/
  -- retried sync payload can never destroy items.
  deleted_at                    timestamptz,

  created_at                    timestamptz not null default now(),
  updated_at                    timestamptz not null default now(),

  -- §1.6: exactly one of food_id/custom_food_id. Table CHECK (needs no
  -- other-table lookup) rather than inside the seam-integrity trigger below
  -- -- cheaper on this table's hottest write path, mirroring
  -- workout_set_logs_exactly_one_exercise_ref_chk (Phase 2 db-engineer
  -- judgment call, applied identically here).
  constraint food_log_items_exactly_one_food_ref_chk check (
    (food_id is not null)::int + (custom_food_id is not null)::int = 1
  )
);

comment on table public.food_log_items is
  'CORE-06 per-food firehose (§1.6). One row per food in a meal, client-'
  'generated id doubling as the per-item sync idempotency key (§9). '
  'Snapshots the food name + per-serving macros at log time (§3) -- the gate '
  'rule: editing/hiding the reference food never retroactively rewrites a '
  'logged item.';
comment on column public.food_log_items.energy_kcal is
  'Snapshot at log time = quantity * serving_g_or_ml_snapshot / 100 * the '
  'referenced food''s energy_kcal (per its basis). Stored, not '
  'live-recomputed -- computed by the save RPC / client, not this table.';
comment on column public.food_log_items.deleted_at is
  'Soft-delete tombstone, set explicitly by the client on item removal -- '
  'never inferred from omission in a synced payload (§9).';

-- Indexes (§1.6's explicit list, db-schema-standards: justified against
-- write cost -- this is the module's hottest write path).

-- "Load this meal's items in order" -- the dominant read + meal render.
create index idx_food_log_items_event_order
  on public.food_log_items (timeline_event_id, sort_order);

-- "All my logs of this reference food over time" (AI-08 "you usually log
-- X" / "how often do I eat this", §1.6) -- partial on deleted_at + food_id
-- both present so the index only carries rows it actually serves.
create index idx_food_log_items_user_food
  on public.food_log_items (user_id, food_id)
  where deleted_at is null and food_id is not null;

-- Parallel partial index for custom foods (§1.6).
create index idx_food_log_items_user_custom_food
  on public.food_log_items (user_id, custom_food_id)
  where deleted_at is null and custom_food_id is not null;

-- -----------------------------------------------------------------------------
-- Seam-integrity trigger (§1.9 item 1 + item 3): (1) user_id must match the
-- parent food_log_entries row's user_id, mirroring
-- enforce_workout_set_logs_integrity; (3) if custom_food_id is set, it must
-- be owned by the caller (new.user_id) -- a lookup the table CHECK above
-- cannot express, so it lives here, mirroring the same discipline
-- save_workout_session_v1 applies to custom_exercise_id at the RPC layer,
-- but enforced unconditionally at the DB layer here since food_log_items
-- also accepts direct-table writes (small edits, §5) that never go through
-- an RPC at all.
-- -----------------------------------------------------------------------------
create or replace function public.enforce_food_log_items_integrity()
returns trigger
language plpgsql
security invoker
set search_path = public, pg_temp
as $$
declare
  v_parent_user_id       uuid;
  v_custom_food_owner_id uuid;
begin
  select user_id into v_parent_user_id
    from public.food_log_entries
    where timeline_event_id = new.timeline_event_id;

  if v_parent_user_id is null then
    raise exception
      'food_log_items write rejected: no food_log_entries row found for timeline_event_id %',
      new.timeline_event_id
      using errcode = '23503';
  end if;

  if v_parent_user_id <> new.user_id then
    raise exception
      'food_log_items.user_id (%) does not match food_log_entries.user_id (%) for meal %',
      new.user_id, v_parent_user_id, new.timeline_event_id
      using errcode = '42501';
  end if;

  if new.custom_food_id is not null then
    select user_id into v_custom_food_owner_id
      from public.custom_foods
      where id = new.custom_food_id;

    if v_custom_food_owner_id is null then
      raise exception
        'food_log_items write rejected: no custom_foods row found for id %',
        new.custom_food_id
        using errcode = '23503';
    end if;

    if v_custom_food_owner_id <> new.user_id then
      raise exception
        'food_log_items write rejected: custom_food_id % is not owned by caller %',
        new.custom_food_id, new.user_id
        using errcode = '42501';
    end if;
  end if;

  return new;
end;
$$;

comment on function public.enforce_food_log_items_integrity() is
  'Trigger: (1) user_id must match the parent food_log_entries row''s '
  'user_id, (2) if custom_food_id is set it must be owned by the caller. '
  'The exactly-one-food-ref invariant is enforced by a table CHECK instead '
  '(no other-table lookup needed). §1.9/§1.6.';

revoke execute on function public.enforce_food_log_items_integrity() from public, anon, authenticated;

create trigger trg_food_log_items_enforce_integrity
  before insert or update on public.food_log_items
  for each row
  execute function public.enforce_food_log_items_integrity();

create trigger trg_food_log_items_set_updated_at
  before update on public.food_log_items
  for each row
  execute function public.set_updated_at();

create trigger trg_food_log_items_force_insert_audit_timestamps
  before insert on public.food_log_items
  for each row
  execute function public.force_insert_audit_timestamps();

-- -----------------------------------------------------------------------------
-- RLS (§8): owner-only via denormalized user_id. SELECT/INSERT/UPDATE, no
-- client DELETE (soft-delete via deleted_at, §9).
-- -----------------------------------------------------------------------------
alter table public.food_log_items enable row level security;

create policy food_log_items_select_own
  on public.food_log_items
  for select
  to authenticated
  using (user_id = auth.uid());

create policy food_log_items_insert_own
  on public.food_log_items
  for insert
  to authenticated
  with check (user_id = auth.uid());

create policy food_log_items_update_own
  on public.food_log_items
  for update
  to authenticated
  using (user_id = auth.uid())
  with check (user_id = auth.uid());

grant select, insert on public.food_log_items to authenticated;

-- -----------------------------------------------------------------------------
-- Column-scoped UPDATE grant (§8.1 verbatim) -- ****READ THIS BEFORE WRITING
-- ANY .upsert() AGAINST THIS TABLE.****
--
-- THIS EXACT BUG CLASS HAS RECURRED THREE TIMES ACROSS THREE PHASES
-- (user_consents in Phase 0/1; custom_exercises, workout_templates,
-- workout_template_exercises, programs, program_workouts,
-- body_measurement_values in Phase 2) -- EVERY TIME because the
-- implementing agent wrote a blanket client `.upsert()` without checking the
-- exact grant shape first. PostgREST compiles `.upsert()` to
-- `INSERT ... ON CONFLICT DO UPDATE SET <every payload column>`, and
-- Postgres checks UPDATE privilege on EVERY one of those columns AT PLAN
-- TIME -- even with no real conflict, even on a brand-new row. A whole-row
-- `.upsert(itemObject)` against food_log_items WILL fail to plan.
--
--   MUTABLE   (client UPDATE granted, per §8.1 verbatim): food_name_snapshot,
--     brand_snapshot, serving_label_snapshot, quantity,
--     serving_g_or_ml_snapshot, energy_kcal, protein_g, carb_g, fat_g,
--     data_quality_snapshot, sort_order, deleted_at.
--   IMMUTABLE (excluded, per §8.1 verbatim): id, timeline_event_id,
--     user_id, food_id, custom_food_id, created_at.
--
-- §8.1's own resolution for "the food changed" edits: swapping which food an
-- item refers to is delete-old-item + insert-new-item, never an in-place
-- food_id/custom_food_id swap -- keeps the food-ref immutable and the
-- snapshot honest. Any direct-table `.upsert()` (e.g. a small quantity/
-- serving correction, per §5) MUST supply an explicit column list drawn only
-- from the mutable set above -- never a whole-row object. The preferred
-- write path is save_food_log_entry_v1 (backend-builder), whose own
-- ON CONFLICT SET list must likewise stay within this same mutable set.
-- -----------------------------------------------------------------------------
grant update (
  food_name_snapshot, brand_snapshot, serving_label_snapshot, quantity,
  serving_g_or_ml_snapshot, energy_kcal, protein_g, carb_g, fat_g,
  data_quality_snapshot, sort_order, deleted_at
) on public.food_log_items to authenticated;

-- CORRECTED GUIDANCE, LIVE-PROVEN (see
-- 20260722999999_revert_custom_foods_diagnostic_grant.sql for the full
-- account -- the same experiment applies verbatim here): restricting an
-- .upsert() payload to mutable columns is NECESSARY but NOT SUFFICIENT.
-- PostgREST's .upsert() always includes the conflict-target column (id) in
-- its ON CONFLICT DO UPDATE SET list whenever it is present in the
-- payload -- which it always must be, to target a specific existing item --
-- so ANY .upsert() against an EXISTING food_log_items row will still fail
-- (id has no UPDATE grant, correctly). Editing an existing item MUST use a
-- plain .update({...mutableCols}).eq('id', x) -- never .upsert(). A client
-- that doesn't know whether an item id already exists (the offline-retry
-- case this table is designed for) should attempt .insert(fullRow) and fall
-- back to .update() on a 23505 conflict, or -- for the multi-item
-- transactional case -- go through save_food_log_entry_v1, which supplies
-- real values for every NOT NULL column on INSERT and restricts its own ON
-- CONFLICT SET list to this same mutable set.
