-- =============================================================================
-- Phase 3 — Module B: saved_meal_items (CORE-10 builder child)
-- Design ref: docs/architecture/phase-3-module-b.md §1.10, §8, §8.1
--
-- One row per planned food within a saved_meals row. NO snapshot here -- a
-- saved meal is a LIVE plan the user edits deliberately; the snapshot
-- happens when a food_log_entry is logged FROM it (§1.10, §3) -- exactly
-- mirroring workout_template_exercises' identical no-snapshot reasoning for
-- workout_templates.
--
-- Deletion posture (db-engineer judgment call, mirroring
-- workout_template_exercises' precedent, §8 of that migration): the doc
-- lists no deleted_at for this table -- removing a planned food from a
-- saved meal is a real structural edit to a live plan, not a historical
-- fact that must survive. This table therefore gets a genuine owner DELETE
-- policy, the same narrow, reasoned exception used for
-- workout_template_exercises/personal_records.
--
-- ROLLBACK: see supabase/migrations/rollbacks/20260722101000_create_saved_meal_items.sql
-- =============================================================================

create table public.saved_meal_items (
  id                uuid primary key default gen_random_uuid(),

  saved_meal_id     uuid not null references public.saved_meals (id) on delete cascade,
  -- Denormalized for RLS; consistency with saved_meals.user_id enforced by
  -- the trigger below.
  user_id           uuid not null references public.profiles (id) on delete cascade,

  food_id           uuid references public.foods (id),
  custom_food_id    uuid references public.custom_foods (id),

  serving_label     text not null
    constraint saved_meal_items_serving_label_not_blank_chk check (length(trim(serving_label)) > 0),
  serving_g_or_ml   numeric not null
    constraint saved_meal_items_serving_weight_positive_chk check (serving_g_or_ml > 0),
  quantity          numeric not null
    constraint saved_meal_items_quantity_positive_chk check (quantity > 0),
  sort_order        integer not null
    constraint saved_meal_items_sort_order_non_negative_chk check (sort_order >= 0),

  constraint saved_meal_items_exactly_one_food_ref_chk check (
    (food_id is not null)::int + (custom_food_id is not null)::int = 1
  )
);

comment on table public.saved_meal_items is
  'CORE-10 planned-food child row of saved_meals (§1.10). Exactly one of '
  'food_id/custom_food_id per row. No macro snapshot columns -- points at '
  'the CURRENT food; macros are resolved at log time so a corrected '
  'reference food improves future logs (§3).';

-- "Load this saved meal's items in order" -- the dominant builder/log-from-
-- saved-meal read (§1.10). Leftmost column also serves a saved_meal_id-only
-- lookup.
create index idx_saved_meal_items_meal_order
  on public.saved_meal_items (saved_meal_id, sort_order);

-- -----------------------------------------------------------------------------
-- Seam-integrity trigger: (1) user_id must match the parent saved_meals
-- row's user_id, mirroring enforce_workout_template_exercises_integrity;
-- (2) if custom_food_id is set, it must be owned by the caller -- the same
-- discipline enforce_food_log_items_integrity applies, extended here for
-- consistency (a db-engineer judgment call beyond the doc's literal §1.9
-- item list, which names food_log_items specifically -- flagged in the task
-- report: the same integrity risk exists here, since a malicious/buggy
-- client could otherwise supply an arbitrary custom_food_id belonging to
-- another user directly in the INSERT payload). exactly-one-food-ref is
-- enforced by the table CHECK above (cheaper, no other-table lookup).
-- -----------------------------------------------------------------------------
create or replace function public.enforce_saved_meal_items_integrity()
returns trigger
language plpgsql
security invoker
set search_path = public, pg_temp
as $$
declare
  v_meal_user_id         uuid;
  v_custom_food_owner_id uuid;
begin
  select user_id into v_meal_user_id
    from public.saved_meals
    where id = new.saved_meal_id;

  if v_meal_user_id is null then
    raise exception
      'saved_meal_items write rejected: no saved_meals row found for id %',
      new.saved_meal_id
      using errcode = '23503';
  end if;

  if v_meal_user_id <> new.user_id then
    raise exception
      'saved_meal_items.user_id (%) does not match saved_meals.user_id (%) for saved meal %',
      new.user_id, v_meal_user_id, new.saved_meal_id
      using errcode = '42501';
  end if;

  if new.custom_food_id is not null then
    select user_id into v_custom_food_owner_id
      from public.custom_foods
      where id = new.custom_food_id;

    if v_custom_food_owner_id is null then
      raise exception
        'saved_meal_items write rejected: no custom_foods row found for id %',
        new.custom_food_id
        using errcode = '23503';
    end if;

    if v_custom_food_owner_id <> new.user_id then
      raise exception
        'saved_meal_items write rejected: custom_food_id % is not owned by caller %',
        new.custom_food_id, new.user_id
        using errcode = '42501';
    end if;
  end if;

  return new;
end;
$$;

comment on function public.enforce_saved_meal_items_integrity() is
  'Trigger: (1) user_id must match the parent saved_meals row''s user_id, '
  '(2) if custom_food_id is set it must be owned by the caller (§1.10/§8, '
  'extended from the food_log_items precedent -- db-engineer judgment call).';

revoke execute on function public.enforce_saved_meal_items_integrity() from public, anon, authenticated;

create trigger trg_saved_meal_items_enforce_integrity
  before insert or update on public.saved_meal_items
  for each row
  execute function public.enforce_saved_meal_items_integrity();

-- -----------------------------------------------------------------------------
-- RLS (§8): owner-only via denormalized user_id. Full SELECT/INSERT/UPDATE/
-- DELETE -- see migration header for why DELETE is a deliberate, narrow
-- exception here (mirroring workout_template_exercises).
-- -----------------------------------------------------------------------------
alter table public.saved_meal_items enable row level security;

create policy saved_meal_items_select_own
  on public.saved_meal_items
  for select
  to authenticated
  using (user_id = auth.uid());

create policy saved_meal_items_insert_own
  on public.saved_meal_items
  for insert
  to authenticated
  with check (user_id = auth.uid());

create policy saved_meal_items_update_own
  on public.saved_meal_items
  for update
  to authenticated
  using (user_id = auth.uid())
  with check (user_id = auth.uid());

create policy saved_meal_items_delete_own
  on public.saved_meal_items
  for delete
  to authenticated
  using (user_id = auth.uid());

grant select, insert, delete on public.saved_meal_items to authenticated;

-- -----------------------------------------------------------------------------
-- Column-scoped UPDATE grant (§8.1 verbatim: "mutable = the plan fields
-- (name/description/meal_type; item serving/quantity/order); immutable =
-- id/user_id/saved_meal_id/created_at and the exactly-one food-ref pair").
-- food_id/custom_food_id are intentionally excluded -- swapping which food a
-- planned row refers to is modeled as delete + re-insert (this table DOES
-- support real DELETE, unlike food_log_items), keeping the exactly-one-ref
-- CHECK's intent (a deliberate row identity) clean -- mirrors
-- workout_template_exercises' identical column-exclusion reasoning.
--
--   MUTABLE   (client UPDATE granted): serving_label, serving_g_or_ml,
--     quantity, sort_order.
--   IMMUTABLE (excluded): id, saved_meal_id, user_id, food_id,
--     custom_food_id.
-- -----------------------------------------------------------------------------
grant update (serving_label, serving_g_or_ml, quantity, sort_order)
  on public.saved_meal_items to authenticated;

-- CORRECTED GUIDANCE, LIVE-PROVEN (see
-- 20260722999999_revert_custom_foods_diagnostic_grant.sql for the full
-- account): restricting an .upsert() payload to mutable columns is
-- NECESSARY but NOT SUFFICIENT -- PostgREST's .upsert() always includes the
-- conflict-target column (id) in its SET list, which has no UPDATE grant
-- here. Editing an existing row MUST use a plain
-- .update({...mutableCols}).eq('id', x) -- never .upsert(). (This table
-- also supports a real DELETE, so a client that wants to change which food
-- an item refers to can additionally delete + re-insert, per this table's
-- own migration header.)
