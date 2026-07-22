-- =============================================================================
-- Phase 3 — Module B: save_food_log_entry_v1 RPC
-- Design ref: docs/architecture/phase-3-module-b.md §1.5, §1.6, §1.9, §3, §5,
-- §8.1, §9
--
-- Builds against the REAL, already-applied tables from db-engineer's Phase 3
-- migrations (verified by reading them directly, not assumed):
--   20260722100500_create_food_log_entries.sql (food_log_entries, meal_type enum,
--                                                mutable-column grant: meal_type,
--                                                title, notes, total_energy_kcal,
--                                                total_protein_g, total_carb_g,
--                                                total_fat_g)
--   20260722100600_create_food_log_items.sql    (food_log_items, mutable-column
--                                                grant: food_name_snapshot,
--                                                brand_snapshot,
--                                                serving_label_snapshot, quantity,
--                                                serving_g_or_ml_snapshot,
--                                                energy_kcal, protein_g, carb_g,
--                                                fat_g, data_quality_snapshot,
--                                                sort_order, deleted_at)
--   20260722100400_create_custom_foods.sql      (custom_foods, owner-scoped)
-- plus the Phase 0 spine (timeline_events) and the direct precedent this
-- migration mirrors, save_workout_session_v1
-- (20260721110000_create_workout_save_and_pr_rpcs.sql) — same envelope,
-- idempotency model, and transactional-multi-row-upsert pattern; only the
-- differences are called out below.
--
-- SECURITY INVOKER (the supabase-standards default, per §5: "the right layer
-- ... because a meal save is transactional across timeline_events +
-- food_log_entries + N food_log_items ... which a bare multi-row PostgREST
-- upsert can't do atomically" — this is a multi-table-transaction argument,
-- not an elevated-privilege argument). RLS on every underlying table still
-- applies; user_id is always auth.uid(), never a parameter.
--
-- DESIGN DECISION — item macro snapshots are CLIENT-SUPPLIED, not
-- server-recomputed from a live `foods` lookup (flagged, mirrors
-- save_workout_session_v1's identical divergence for
-- exercise_name_snapshot/primary_muscle_snapshot, see that migration's own
-- header note (a)): `public.foods` carries NO client GRANT of any kind, not
-- even to a SECURITY INVOKER function running as `authenticated` (see
-- 20260722100000_create_foods.sql's header) — so this RPC could not
-- recompute against live food data even if it wanted to. More fundamentally,
-- the snapshot's entire purpose (§3) is to freeze what the user saw AT THE
-- MOMENT OF LOGGING (possibly computed fully offline against the mobile
-- client's own cached search-result/barcode-lookup response or its local
-- custom_foods row), which may be hours/days before this RPC executes on
-- reconnect — re-deriving server-side would silently leak a later food-DB
-- edit into "historical" data, exactly what §3 forbids. This RPC validates
-- every snapshot is present/non-blank and every numeric snapshot is in
-- range (>= 0), and that the referenced food_id/custom_food_id genuinely
-- exists (custom_food_id ownership is checked explicitly here + by the
-- enforce_food_log_items_integrity trigger; food_id existence is enforced by
-- the table's own FK constraint, which Postgres validates with elevated
-- internal privilege independent of the caller's own SELECT grant) — it does
-- NOT verify the snapshot numbers are numerically consistent with the
-- referenced row's CURRENT macros, by design.
--
-- Idempotency (§9), two grains, identical structure to
-- save_workout_session_v1: p_id is the meal's client-generated idempotency
-- key (= timeline_events.id); every element of p_items carries its OWN
-- client-generated id (a second grain below the meal). Every write is
-- INSERT ... ON CONFLICT (id) DO UPDATE scoped to the same ownership WHERE
-- clause. An item is REMOVED by resending it with deleted_at set — never by
-- omitting it from the array (§9: "upsert-present, never delete-omitted").
--
-- ROLLBACK: see supabase/migrations/rollbacks/20260722200000_create_save_food_log_entry_rpc.sql
-- =============================================================================

-- =============================================================================
-- public.save_food_log_entry_v1(...) — §5
--
-- p_items shape (jsonb array), one element per food in the meal:
--   {
--     "id": uuid,                                  -- required, client-generated
--     "food_id": uuid | null,                        -- exactly one of these two
--     "custom_food_id": uuid | null,
--     "food_name_snapshot": text,                       -- required
--     "brand_snapshot": text | null,
--     "serving_label_snapshot": text,                      -- required
--     "quantity": numeric,                                  -- required, > 0
--     "serving_g_or_ml_snapshot": numeric,                    -- required, > 0
--     "energy_kcal": numeric,                                   -- required, >= 0
--     "protein_g": numeric | null,                               -- >= 0
--     "carb_g": numeric | null,                                    -- >= 0
--     "fat_g": numeric | null,                                       -- >= 0
--     "data_quality_snapshot": "high"|"medium"|"low" | null,
--     "sort_order": integer,                                            -- >= 0
--     "deleted_at": timestamptz | null                                    -- explicit tombstone
--   }
--
-- total_energy_kcal/total_protein_g/total_carb_g/total_fat_g on
-- food_log_entries (and timeline_events.energy_kcal) are ALWAYS
-- server-recomputed from the full current committed state of this meal's
-- items after this call's writes land (not just the items in this call's own
-- payload) — mirrors save_workout_session_v1's total_volume_kg/total_sets
-- recompute, so a partial/incremental sync payload always leaves the meal's
-- totals correct.
-- =============================================================================
create or replace function public.save_food_log_entry_v1(
  p_id                 uuid,
  p_occurred_at        timestamptz,
  p_local_date         date,
  p_event_timezone     text,
  p_meal_type          public.meal_type,
  p_items              jsonb default '[]'::jsonb,
  p_source             public.timeline_source default 'manual',
  p_visibility         public.timeline_visibility default 'private',
  p_title              text default null,
  p_notes              text default null,
  p_client_created_at  timestamptz default null
)
returns jsonb
language plpgsql
security invoker
set search_path = public, pg_temp
as $$
declare
  v_user_id                  uuid;
  v_idx                       integer;
  v_item                       jsonb;
  v_item_count                  integer;
  v_item_id                      uuid;
  v_food_id                       uuid;
  v_custom_food_id                 uuid;
  v_food_name_snapshot               text;
  v_brand_snapshot                     text;
  v_serving_label_snapshot              text;
  v_quantity                              numeric;
  v_serving_weight_snapshot                 numeric;
  v_energy_kcal                               numeric;
  v_protein_g                                  numeric;
  v_carb_g                                       numeric;
  v_fat_g                                          numeric;
  v_data_quality_snapshot                          text;
  v_sort_order                                       integer;
  v_deleted_at                                        timestamptz;
  v_rows_affected                                       integer;
  v_total_energy_kcal                                     numeric;
  v_total_protein_g                                         numeric;
  v_total_carb_g                                              numeric;
  v_total_fat_g                                                 numeric;
  v_clock_skew_tolerance constant interval := interval '24 hours'; -- mirrors trg_timeline_events_clock_skew
begin
  v_user_id := auth.uid();
  if v_user_id is null then
    return jsonb_build_object('error', jsonb_build_object(
      'code', 'UNAUTHENTICATED', 'message', 'No authenticated user context.', 'field', null));
  end if;

  -- ---------------------------------------------------------------------
  -- Pass 1: top-level required-field / business-invariant validation
  -- (production-standards: validate at the boundary, never trust client
  -- input).
  -- ---------------------------------------------------------------------
  if p_id is null then
    return jsonb_build_object('error', jsonb_build_object('code', 'VALIDATION_ERROR', 'message', 'id is required.', 'field', 'id'));
  end if;
  if p_occurred_at is null then
    return jsonb_build_object('error', jsonb_build_object('code', 'VALIDATION_ERROR', 'message', 'occurred_at is required.', 'field', 'occurred_at'));
  end if;
  if p_local_date is null then
    return jsonb_build_object('error', jsonb_build_object('code', 'VALIDATION_ERROR', 'message', 'local_date is required.', 'field', 'local_date'));
  end if;
  if p_event_timezone is null or length(trim(p_event_timezone)) = 0 then
    return jsonb_build_object('error', jsonb_build_object('code', 'VALIDATION_ERROR', 'message', 'event_timezone is required.', 'field', 'event_timezone'));
  end if;
  if p_meal_type is null then
    return jsonb_build_object('error', jsonb_build_object('code', 'VALIDATION_ERROR', 'message', 'meal_type is required.', 'field', 'meal_type'));
  end if;
  if p_items is null or jsonb_typeof(p_items) <> 'array' then
    return jsonb_build_object('error', jsonb_build_object('code', 'VALIDATION_ERROR', 'message', 'items must be a JSON array (may be empty).', 'field', 'items'));
  end if;

  if p_source not in ('manual', 'import') then
    return jsonb_build_object('error', jsonb_build_object(
      'code', 'INVALID_SOURCE', 'message', 'source must be one of manual, import for a food log entry.', 'field', 'source'));
  end if;

  if p_occurred_at > now() + v_clock_skew_tolerance then
    return jsonb_build_object('error', jsonb_build_object(
      'code', 'OCCURRED_AT_TOO_FUTURE', 'message', format('occurred_at is further in the future than the %s clock-skew tolerance.', v_clock_skew_tolerance), 'field', 'occurred_at'));
  end if;

  if p_local_date not between (p_occurred_at at time zone 'UTC')::date - 1
                          and (p_occurred_at at time zone 'UTC')::date + 1 then
    return jsonb_build_object('error', jsonb_build_object(
      'code', 'LOCAL_DATE_OUT_OF_BOUNDS', 'message', 'local_date must be within one day of occurred_at (UTC).', 'field', 'local_date'));
  end if;

  -- ---------------------------------------------------------------------
  -- Pass 2: validate every item BEFORE writing anything, so an invalid item
  -- anywhere in the payload never results in a partial write.
  -- ---------------------------------------------------------------------
  v_item_count := jsonb_array_length(p_items);

  for v_idx in 0 .. v_item_count - 1 loop
    v_item := p_items -> v_idx;

    if v_item ->> 'id' is null then
      return jsonb_build_object('error', jsonb_build_object('code', 'VALIDATION_ERROR', 'message', 'id is required.', 'field', format('items[%s].id', v_idx)));
    end if;
    begin
      v_item_id := (v_item ->> 'id')::uuid;
    exception when others then
      return jsonb_build_object('error', jsonb_build_object('code', 'VALIDATION_ERROR', 'message', 'id must be a valid uuid.', 'field', format('items[%s].id', v_idx)));
    end;

    begin
      v_food_id := nullif(v_item ->> 'food_id', '')::uuid;
      v_custom_food_id := nullif(v_item ->> 'custom_food_id', '')::uuid;
    exception when others then
      return jsonb_build_object('error', jsonb_build_object('code', 'VALIDATION_ERROR', 'message', 'food_id/custom_food_id must be valid uuids.', 'field', format('items[%s].food_id', v_idx)));
    end;

    if (v_food_id is not null)::int + (v_custom_food_id is not null)::int <> 1 then
      return jsonb_build_object('error', jsonb_build_object(
        'code', 'INVALID_FOOD_REF', 'message', 'Exactly one of food_id or custom_food_id is required.', 'field', format('items[%s].food_id', v_idx)));
    end if;

    -- food_id existence is enforced by the table's own FK constraint at
    -- write time (see migration header) -- not checkable here, since
    -- `foods` carries no client SELECT grant even to this SECURITY INVOKER
    -- function.
    if v_custom_food_id is not null and not exists (
      select 1 from public.custom_foods where id = v_custom_food_id and user_id = v_user_id and deleted_at is null
    ) then
      return jsonb_build_object('error', jsonb_build_object(
        'code', 'FOOD_NOT_FOUND', 'message', 'custom_food_id does not exist, is not owned by the caller, or has been deleted.', 'field', format('items[%s].custom_food_id', v_idx)));
    end if;

    v_food_name_snapshot := v_item ->> 'food_name_snapshot';
    if v_food_name_snapshot is null or length(trim(v_food_name_snapshot)) = 0 then
      return jsonb_build_object('error', jsonb_build_object('code', 'VALIDATION_ERROR', 'message', 'food_name_snapshot is required.', 'field', format('items[%s].food_name_snapshot', v_idx)));
    end if;

    v_serving_label_snapshot := v_item ->> 'serving_label_snapshot';
    if v_serving_label_snapshot is null or length(trim(v_serving_label_snapshot)) = 0 then
      return jsonb_build_object('error', jsonb_build_object('code', 'VALIDATION_ERROR', 'message', 'serving_label_snapshot is required.', 'field', format('items[%s].serving_label_snapshot', v_idx)));
    end if;

    if v_item ->> 'quantity' is null then
      return jsonb_build_object('error', jsonb_build_object('code', 'VALIDATION_ERROR', 'message', 'quantity is required.', 'field', format('items[%s].quantity', v_idx)));
    end if;
    begin
      v_quantity := (v_item ->> 'quantity')::numeric;
    exception when others then
      return jsonb_build_object('error', jsonb_build_object('code', 'VALIDATION_ERROR', 'message', 'quantity must be numeric.', 'field', format('items[%s].quantity', v_idx)));
    end;
    if v_quantity <= 0 then
      return jsonb_build_object('error', jsonb_build_object('code', 'NEGATIVE_QUANTITY', 'message', 'quantity must be > 0.', 'field', format('items[%s].quantity', v_idx)));
    end if;

    if v_item ->> 'serving_g_or_ml_snapshot' is null then
      return jsonb_build_object('error', jsonb_build_object('code', 'VALIDATION_ERROR', 'message', 'serving_g_or_ml_snapshot is required.', 'field', format('items[%s].serving_g_or_ml_snapshot', v_idx)));
    end if;
    begin
      v_serving_weight_snapshot := (v_item ->> 'serving_g_or_ml_snapshot')::numeric;
    exception when others then
      return jsonb_build_object('error', jsonb_build_object('code', 'VALIDATION_ERROR', 'message', 'serving_g_or_ml_snapshot must be numeric.', 'field', format('items[%s].serving_g_or_ml_snapshot', v_idx)));
    end;
    if v_serving_weight_snapshot <= 0 then
      return jsonb_build_object('error', jsonb_build_object('code', 'NEGATIVE_QUANTITY', 'message', 'serving_g_or_ml_snapshot must be > 0.', 'field', format('items[%s].serving_g_or_ml_snapshot', v_idx)));
    end if;

    if v_item ->> 'energy_kcal' is null then
      return jsonb_build_object('error', jsonb_build_object('code', 'VALIDATION_ERROR', 'message', 'energy_kcal is required.', 'field', format('items[%s].energy_kcal', v_idx)));
    end if;
    begin
      v_energy_kcal := (v_item ->> 'energy_kcal')::numeric;
    exception when others then
      return jsonb_build_object('error', jsonb_build_object('code', 'VALIDATION_ERROR', 'message', 'energy_kcal must be numeric.', 'field', format('items[%s].energy_kcal', v_idx)));
    end;
    if v_energy_kcal < 0 then
      return jsonb_build_object('error', jsonb_build_object('code', 'NEGATIVE_MEASUREMENT', 'message', 'energy_kcal must be >= 0.', 'field', format('items[%s].energy_kcal', v_idx)));
    end if;

    begin
      v_protein_g := nullif(v_item ->> 'protein_g', '')::numeric;
      v_carb_g := nullif(v_item ->> 'carb_g', '')::numeric;
      v_fat_g := nullif(v_item ->> 'fat_g', '')::numeric;
    exception when others then
      return jsonb_build_object('error', jsonb_build_object('code', 'VALIDATION_ERROR', 'message', 'protein_g/carb_g/fat_g must be numeric.', 'field', format('items[%s]', v_idx)));
    end;
    if (v_protein_g is not null and v_protein_g < 0)
       or (v_carb_g is not null and v_carb_g < 0)
       or (v_fat_g is not null and v_fat_g < 0) then
      return jsonb_build_object('error', jsonb_build_object('code', 'NEGATIVE_MEASUREMENT', 'message', 'protein_g/carb_g/fat_g must be >= 0.', 'field', format('items[%s]', v_idx)));
    end if;

    v_data_quality_snapshot := v_item ->> 'data_quality_snapshot';
    if v_data_quality_snapshot is not null then
      begin
        perform v_data_quality_snapshot::public.food_data_quality;
      exception when others then
        return jsonb_build_object('error', jsonb_build_object('code', 'VALIDATION_ERROR', 'message', 'data_quality_snapshot is not a valid value.', 'field', format('items[%s].data_quality_snapshot', v_idx)));
      end;
    end if;

    if v_item ->> 'sort_order' is null then
      return jsonb_build_object('error', jsonb_build_object('code', 'VALIDATION_ERROR', 'message', 'sort_order is required.', 'field', format('items[%s].sort_order', v_idx)));
    end if;
    v_sort_order := (v_item ->> 'sort_order')::integer;
    if v_sort_order < 0 then
      return jsonb_build_object('error', jsonb_build_object('code', 'NEGATIVE_MEASUREMENT', 'message', 'sort_order must be >= 0.', 'field', format('items[%s].sort_order', v_idx)));
    end if;
  end loop;

  -- ---------------------------------------------------------------------
  -- Transactional writes. Any exception from here rolls back everything
  -- already written in this call (implicit savepoint) and returns the error
  -- envelope instead of a partial write or a raw Postgres error.
  -- ---------------------------------------------------------------------
  begin
    with upsert as (
      insert into public.timeline_events (
        id, user_id, source_module, event_type, occurred_at, local_date, event_timezone,
        energy_kcal, source, visibility, client_created_at
      )
      values (
        p_id, v_user_id, 'nutrition', 'food_log_entry', p_occurred_at, p_local_date, p_event_timezone,
        0, p_source, p_visibility, p_client_created_at
      )
      on conflict (id) do update set
        occurred_at    = excluded.occurred_at,
        local_date     = excluded.local_date,
        event_timezone = excluded.event_timezone,
        visibility     = excluded.visibility
      where timeline_events.user_id = v_user_id
      returning id
    )
    select count(*) into v_rows_affected from upsert;

    if v_rows_affected = 0 then
      return jsonb_build_object('error', jsonb_build_object(
        'code', 'ID_CONFLICT', 'message', 'The provided id is already in use by a different record.', 'field', 'id'));
    end if;

    with upsert as (
      insert into public.food_log_entries (
        timeline_event_id, user_id, meal_type, title, notes, total_energy_kcal
      )
      values (
        p_id, v_user_id, p_meal_type, p_title, p_notes, 0
      )
      on conflict (timeline_event_id) do update set
        meal_type = excluded.meal_type,
        title     = excluded.title,
        notes     = excluded.notes
      where food_log_entries.user_id = v_user_id
      returning timeline_event_id
    )
    select count(*) into v_rows_affected from upsert;

    if v_rows_affected = 0 then
      return jsonb_build_object('error', jsonb_build_object(
        'code', 'ID_CONFLICT', 'message', 'The meal detail row could not be written (ownership conflict).', 'field', 'id'));
    end if;

    -- Pass 3: upsert every item (re-parsing the already-validated payload;
    -- cheap at this bounded per-meal scale).
    for v_idx in 0 .. v_item_count - 1 loop
      v_item := p_items -> v_idx;

      v_item_id := (v_item ->> 'id')::uuid;
      v_food_id := nullif(v_item ->> 'food_id', '')::uuid;
      v_custom_food_id := nullif(v_item ->> 'custom_food_id', '')::uuid;
      v_food_name_snapshot := v_item ->> 'food_name_snapshot';
      v_brand_snapshot := v_item ->> 'brand_snapshot';
      v_serving_label_snapshot := v_item ->> 'serving_label_snapshot';
      v_quantity := (v_item ->> 'quantity')::numeric;
      v_serving_weight_snapshot := (v_item ->> 'serving_g_or_ml_snapshot')::numeric;
      v_energy_kcal := (v_item ->> 'energy_kcal')::numeric;
      v_protein_g := nullif(v_item ->> 'protein_g', '')::numeric;
      v_carb_g := nullif(v_item ->> 'carb_g', '')::numeric;
      v_fat_g := nullif(v_item ->> 'fat_g', '')::numeric;
      v_data_quality_snapshot := v_item ->> 'data_quality_snapshot';
      v_sort_order := (v_item ->> 'sort_order')::integer;
      v_deleted_at := nullif(v_item ->> 'deleted_at', '')::timestamptz;

      with upsert as (
        insert into public.food_log_items (
          id, timeline_event_id, user_id, food_id, custom_food_id,
          food_name_snapshot, brand_snapshot, serving_label_snapshot, quantity,
          serving_g_or_ml_snapshot, energy_kcal, protein_g, carb_g, fat_g,
          data_quality_snapshot, sort_order, deleted_at
        )
        values (
          v_item_id, p_id, v_user_id, v_food_id, v_custom_food_id,
          v_food_name_snapshot, v_brand_snapshot, v_serving_label_snapshot, v_quantity,
          v_serving_weight_snapshot, v_energy_kcal, v_protein_g, v_carb_g, v_fat_g,
          v_data_quality_snapshot::public.food_data_quality, v_sort_order, v_deleted_at
        )
        on conflict (id) do update set
          food_name_snapshot       = excluded.food_name_snapshot,
          brand_snapshot           = excluded.brand_snapshot,
          serving_label_snapshot   = excluded.serving_label_snapshot,
          quantity                 = excluded.quantity,
          serving_g_or_ml_snapshot = excluded.serving_g_or_ml_snapshot,
          energy_kcal              = excluded.energy_kcal,
          protein_g                = excluded.protein_g,
          carb_g                   = excluded.carb_g,
          fat_g                    = excluded.fat_g,
          data_quality_snapshot    = excluded.data_quality_snapshot,
          sort_order               = excluded.sort_order,
          deleted_at               = excluded.deleted_at
        where food_log_items.user_id = v_user_id
          and food_log_items.timeline_event_id = p_id
        returning id
      )
      select count(*) into v_rows_affected from upsert;

      if v_rows_affected = 0 then
        return jsonb_build_object('error', jsonb_build_object(
          'code', 'ID_CONFLICT', 'message', 'An item id is already in use by a different meal or user.', 'field', format('items[%s].id', v_idx)));
      end if;
    end loop;

    -- Recompute + persist meal-level snapshots (§1.5) over the CURRENT full
    -- committed state of this meal's items -- not just the items included in
    -- this call's payload, so a partial/incremental sync payload still
    -- leaves the meal's totals correct. Also mirrored onto the spine's
    -- energy_kcal (§4) so cross-module reads never touch this detail table.
    select coalesce(sum(energy_kcal), 0), sum(protein_g), sum(carb_g), sum(fat_g)
      into v_total_energy_kcal, v_total_protein_g, v_total_carb_g, v_total_fat_g
    from public.food_log_items
    where timeline_event_id = p_id
      and deleted_at is null;

    update public.food_log_entries
      set total_energy_kcal = v_total_energy_kcal,
          total_protein_g   = v_total_protein_g,
          total_carb_g      = v_total_carb_g,
          total_fat_g       = v_total_fat_g
      where timeline_event_id = p_id;

    update public.timeline_events
      set energy_kcal = v_total_energy_kcal
      where id = p_id;

  exception when others then
    return jsonb_build_object('error', jsonb_build_object(
      'code',
        case sqlstate
          when '23505' then 'ID_CONFLICT'
          when '23503' then 'FOOD_NOT_FOUND'
          when '23514' then 'VALIDATION_ERROR'
          when '22P02' then 'VALIDATION_ERROR'
          else 'WRITE_FAILED'
        end,
      'message', sqlerrm,
      'field', null
    ));
  end;

  return jsonb_build_object('data', jsonb_build_object(
    'id', p_id,
    'occurred_at', p_occurred_at,
    'local_date', p_local_date,
    'meal_type', p_meal_type,
    'total_energy_kcal', v_total_energy_kcal,
    'total_protein_g', v_total_protein_g,
    'total_carb_g', v_total_carb_g,
    'total_fat_g', v_total_fat_g,
    'item_count', v_item_count
  ));
end;
$$;

comment on function public.save_food_log_entry_v1(
  uuid, timestamptz, date, text, public.meal_type, jsonb,
  public.timeline_source, public.timeline_visibility, text, text, timestamptz
) is
  'Phase 3 Module B save/finish/edit RPC (§5). SECURITY INVOKER, transactional '
  'across timeline_events + food_log_entries + food_log_items. Two idempotency '
  'grains (§9): the meal id (p_id) and each item''s own id inside p_items. '
  'Returns {"data": {...}} on success or {"error": {"code","message","field"}} '
  'on a business-rule violation -- see docs/api/save-food-log-entry-v1.md. '
  'Version-suffixed per supabase-standards: a breaking contract change ships '
  'as save_food_log_entry_v2, never a mutation of this function''s behavior '
  'out from under app versions already in the field.';

revoke execute on function public.save_food_log_entry_v1(
  uuid, timestamptz, date, text, public.meal_type, jsonb,
  public.timeline_source, public.timeline_visibility, text, text, timestamptz
) from public, anon;

grant execute on function public.save_food_log_entry_v1(
  uuid, timestamptz, date, text, public.meal_type, jsonb,
  public.timeline_source, public.timeline_visibility, text, text, timestamptz
) to authenticated;
