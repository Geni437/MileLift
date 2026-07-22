-- =============================================================================
-- Phase 3 — Module B: log_saved_meal_v1 RPC (CORE-10)
-- Design ref: docs/architecture/phase-3-module-b.md §1.10, §3, §5
--
-- "Logging a saved meal -> log_saved_meal_v1(saved_meal_id, occurred_at, ...)
-- ... snapshots current food macros into new food_log_items (§3) ...
-- recommend the RPC so the snapshot resolution is server-authoritative and
-- transactional" (§5). Expands a live saved_meals/saved_meal_items plan
-- (20260722100900_create_saved_meals.sql / 20260722101000_create_saved_meal_items.sql)
-- into a BRAND-NEW food_log_entries + food_log_items event, resolving each
-- planned food's CURRENT macros at log time -- editing/correcting the
-- underlying food improves future logs from a saved meal without touching
-- past logs (§1.10's "live plan" posture, identical to workout_templates).
--
-- SECURITY DEFINER — a deliberate, justified exception to this project's
-- SECURITY INVOKER default (supabase-standards: "only use SECURITY DEFINER
-- when the operation genuinely needs to act with elevated privilege, and ...
-- validate authorization explicitly inside the function body since RLS
-- won't do it for you there"). This RPC must resolve each item's CURRENT
-- macros from `public.foods`, which carries NO client GRANT of any kind (see
-- 20260722100000_create_foods.sql's header) — a SECURITY INVOKER function
-- running as `authenticated` could not read it at all, exactly the same
-- justification search_foods_v1/resolve_barcode_v1 already establish
-- (20260722110100_create_food_search_index_and_rpcs.sql). Because SECURITY
-- DEFINER + table-owner exemption means RLS does not filter for this
-- function on ANY table it touches (not just `foods`), every read/write
-- below explicitly filters by `v_user_id := auth.uid()` rather than relying
-- on RLS -- saved_meals/saved_meal_items ownership, custom_foods ownership,
-- and every write to timeline_events/food_log_entries/food_log_items.
--
-- IDEMPOTENCY (a judgment call distinct from save_food_log_entry_v1's
-- two-grain model, flagged here): this RPC is a single-shot, ONLINE-ONLY
-- "expand and log" action (unlike per-item offline food logging, a saved
-- meal can only be expanded when the device can read the CURRENT food
-- catalog, i.e. is online) -- there is no multi-step offline sync of
-- individual items to make idempotent at the item grain. p_id (the NEW
-- food_log_entry's client-generated id) is the sole idempotency key: if a
-- timeline_events row with this id already exists for the caller with
-- event_type = 'food_log_entry', this call is treated as an idempotent
-- retry and returns the ALREADY-LOGGED meal's current data without
-- re-expanding the saved meal a second time (which would otherwise create
-- duplicate food_log_items on every retry, since item ids are freshly
-- generated server-side on first expansion). If p_id already exists but
-- belongs to a different user or a different event_type, that is a genuine
-- ID_CONFLICT, not a replay.
--
-- ROLLBACK: see supabase/migrations/rollbacks/20260722200100_create_log_saved_meal_rpc.sql
-- =============================================================================
create or replace function public.log_saved_meal_v1(
  p_id                 uuid,
  p_saved_meal_id      uuid,
  p_occurred_at        timestamptz,
  p_local_date         date,
  p_event_timezone     text,
  p_meal_type          public.meal_type default null,
  p_source             public.timeline_source default 'manual',
  p_visibility         public.timeline_visibility default 'private',
  p_title              text default null,
  p_notes              text default null,
  p_client_created_at  timestamptz default null
)
returns jsonb
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  v_user_id                  uuid;
  v_saved_meal                record;
  v_meal_type                  public.meal_type;
  v_title                        text;
  v_existing_event_user_id         uuid;
  v_existing_event_type             public.timeline_event_type;
  v_item_row                          record;
  v_food                                record;
  v_custom_food                          record;
  v_food_name_snapshot                     text;
  v_brand_snapshot                           text;
  v_grams_or_ml                                numeric;
  v_item_energy_kcal                             numeric;
  v_item_protein_g                                 numeric;
  v_item_carb_g                                      numeric;
  v_item_fat_g                                         numeric;
  v_item_count                                           integer := 0;
  v_total_energy_kcal                                      numeric := 0;
  v_total_protein_g                                          numeric := 0;
  v_total_carb_g                                               numeric := 0;
  v_total_fat_g                                                  numeric := 0;
  v_clock_skew_tolerance constant interval := interval '24 hours';
begin
  v_user_id := auth.uid();
  if v_user_id is null then
    return jsonb_build_object('error', jsonb_build_object(
      'code', 'UNAUTHENTICATED', 'message', 'No authenticated user context.', 'field', null));
  end if;

  if p_id is null then
    return jsonb_build_object('error', jsonb_build_object('code', 'VALIDATION_ERROR', 'message', 'id is required.', 'field', 'id'));
  end if;
  if p_saved_meal_id is null then
    return jsonb_build_object('error', jsonb_build_object('code', 'VALIDATION_ERROR', 'message', 'saved_meal_id is required.', 'field', 'saved_meal_id'));
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
  if p_source not in ('manual', 'import') then
    return jsonb_build_object('error', jsonb_build_object(
      'code', 'INVALID_SOURCE', 'message', 'source must be one of manual, import.', 'field', 'source'));
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

  -- Idempotent-replay check (see migration header) -- explicit, since
  -- SECURITY DEFINER bypasses RLS.
  select user_id, event_type into v_existing_event_user_id, v_existing_event_type
  from public.timeline_events
  where id = p_id;

  if found then
    if v_existing_event_user_id <> v_user_id or v_existing_event_type <> 'food_log_entry' then
      return jsonb_build_object('error', jsonb_build_object(
        'code', 'ID_CONFLICT', 'message', 'The provided id is already in use by a different record.', 'field', 'id'));
    end if;

    -- Idempotent replay: return the already-logged meal's current data,
    -- never re-expand the saved meal a second time.
    select total_energy_kcal, total_protein_g, total_carb_g, total_fat_g, meal_type
      into v_total_energy_kcal, v_total_protein_g, v_total_carb_g, v_total_fat_g, v_meal_type
    from public.food_log_entries
    where timeline_event_id = p_id;

    select count(*) into v_item_count
    from public.food_log_items
    where timeline_event_id = p_id and deleted_at is null;

    return jsonb_build_object('data', jsonb_build_object(
      'id', p_id,
      'source_saved_meal_id', p_saved_meal_id,
      'meal_type', v_meal_type,
      'total_energy_kcal', v_total_energy_kcal,
      'total_protein_g', v_total_protein_g,
      'total_carb_g', v_total_carb_g,
      'total_fat_g', v_total_fat_g,
      'item_count', v_item_count,
      'replayed', true
    ));
  end if;

  -- Explicit ownership check (RLS does not filter this SECURITY DEFINER
  -- function's reads).
  select id, user_id, name, meal_type into v_saved_meal
  from public.saved_meals
  where id = p_saved_meal_id and user_id = v_user_id and deleted_at is null;

  if not found then
    return jsonb_build_object('error', jsonb_build_object(
      'code', 'SAVED_MEAL_NOT_FOUND', 'message', 'saved_meal_id does not exist, is not owned by the caller, or has been deleted.', 'field', 'saved_meal_id'));
  end if;

  v_meal_type := coalesce(p_meal_type, v_saved_meal.meal_type, 'other');
  v_title := coalesce(p_title, v_saved_meal.name);

  if not exists (select 1 from public.saved_meal_items where saved_meal_id = p_saved_meal_id and user_id = v_user_id) then
    return jsonb_build_object('error', jsonb_build_object(
      'code', 'SAVED_MEAL_EMPTY', 'message', 'This saved meal has no items to log.', 'field', 'saved_meal_id'));
  end if;

  begin
    insert into public.timeline_events (
      id, user_id, source_module, event_type, occurred_at, local_date, event_timezone,
      energy_kcal, source, visibility, client_created_at
    ) values (
      p_id, v_user_id, 'nutrition', 'food_log_entry', p_occurred_at, p_local_date, p_event_timezone,
      0, p_source, p_visibility, p_client_created_at
    );

    insert into public.food_log_entries (
      timeline_event_id, user_id, meal_type, title, notes, total_energy_kcal
    ) values (
      p_id, v_user_id, v_meal_type, v_title, p_notes, 0
    );

    for v_item_row in
      select id, food_id, custom_food_id, serving_label, serving_g_or_ml, quantity, sort_order
      from public.saved_meal_items
      where saved_meal_id = p_saved_meal_id and user_id = v_user_id
      order by sort_order
    loop
      v_food_name_snapshot := null;
      v_brand_snapshot := null;
      v_item_energy_kcal := null;
      v_item_protein_g := null;
      v_item_carb_g := null;
      v_item_fat_g := null;

      if v_item_row.food_id is not null then
        select id, name, brand, energy_kcal, protein_g, carb_g, fat_g
          into v_food
        from public.foods
        where id = v_item_row.food_id and is_active;

        if not found then
          return jsonb_build_object('error', jsonb_build_object(
            'code', 'FOOD_UNAVAILABLE',
            'message', format('A food referenced by saved meal item %s is no longer active in the catalog.', v_item_row.id),
            'field', 'saved_meal_id'));
        end if;

        v_food_name_snapshot := v_food.name;
        v_brand_snapshot := v_food.brand;
        v_grams_or_ml := v_item_row.quantity * v_item_row.serving_g_or_ml;
        v_item_energy_kcal := round(v_grams_or_ml / 100.0 * v_food.energy_kcal, 4);
        if v_food.protein_g is not null then v_item_protein_g := round(v_grams_or_ml / 100.0 * v_food.protein_g, 4); end if;
        if v_food.carb_g is not null then v_item_carb_g := round(v_grams_or_ml / 100.0 * v_food.carb_g, 4); end if;
        if v_food.fat_g is not null then v_item_fat_g := round(v_grams_or_ml / 100.0 * v_food.fat_g, 4); end if;
      else
        select id, name, brand, energy_kcal, protein_g, carb_g, fat_g
          into v_custom_food
        from public.custom_foods
        where id = v_item_row.custom_food_id and user_id = v_user_id and deleted_at is null;

        if not found then
          return jsonb_build_object('error', jsonb_build_object(
            'code', 'CUSTOM_FOOD_UNAVAILABLE',
            'message', format('A custom food referenced by saved meal item %s is no longer available.', v_item_row.id),
            'field', 'saved_meal_id'));
        end if;

        v_food_name_snapshot := v_custom_food.name;
        v_brand_snapshot := v_custom_food.brand;
        v_grams_or_ml := v_item_row.quantity * v_item_row.serving_g_or_ml;
        v_item_energy_kcal := round(v_grams_or_ml / 100.0 * v_custom_food.energy_kcal, 4);
        if v_custom_food.protein_g is not null then v_item_protein_g := round(v_grams_or_ml / 100.0 * v_custom_food.protein_g, 4); end if;
        if v_custom_food.carb_g is not null then v_item_carb_g := round(v_grams_or_ml / 100.0 * v_custom_food.carb_g, 4); end if;
        if v_custom_food.fat_g is not null then v_item_fat_g := round(v_grams_or_ml / 100.0 * v_custom_food.fat_g, 4); end if;
      end if;

      insert into public.food_log_items (
        id, timeline_event_id, user_id, food_id, custom_food_id,
        food_name_snapshot, brand_snapshot, serving_label_snapshot, quantity,
        serving_g_or_ml_snapshot, energy_kcal, protein_g, carb_g, fat_g,
        sort_order
      ) values (
        gen_random_uuid(), p_id, v_user_id, v_item_row.food_id, v_item_row.custom_food_id,
        v_food_name_snapshot, v_brand_snapshot, v_item_row.serving_label, v_item_row.quantity,
        v_item_row.serving_g_or_ml, v_item_energy_kcal, v_item_protein_g, v_item_carb_g, v_item_fat_g,
        v_item_row.sort_order
      );

      v_item_count := v_item_count + 1;
      v_total_energy_kcal := v_total_energy_kcal + coalesce(v_item_energy_kcal, 0);
      v_total_protein_g := coalesce(v_total_protein_g, 0) + coalesce(v_item_protein_g, 0);
      v_total_carb_g := coalesce(v_total_carb_g, 0) + coalesce(v_item_carb_g, 0);
      v_total_fat_g := coalesce(v_total_fat_g, 0) + coalesce(v_item_fat_g, 0);
    end loop;

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
          else 'WRITE_FAILED'
        end,
      'message', sqlerrm,
      'field', null
    ));
  end;

  return jsonb_build_object('data', jsonb_build_object(
    'id', p_id,
    'source_saved_meal_id', p_saved_meal_id,
    'occurred_at', p_occurred_at,
    'local_date', p_local_date,
    'meal_type', v_meal_type,
    'total_energy_kcal', v_total_energy_kcal,
    'total_protein_g', v_total_protein_g,
    'total_carb_g', v_total_carb_g,
    'total_fat_g', v_total_fat_g,
    'item_count', v_item_count,
    'replayed', false
  ));
end;
$$;

comment on function public.log_saved_meal_v1(
  uuid, uuid, timestamptz, date, text, public.meal_type,
  public.timeline_source, public.timeline_visibility, text, text, timestamptz
) is
  'Phase 3 Module B CORE-10 RPC (§1.10/§5): expands a saved_meals plan into a '
  'BRAND-NEW food_log_entry, resolving each item''s CURRENT macros at log '
  'time (§3). SECURITY DEFINER (justified -- see migration header: needs to '
  'read public.foods, which has no client GRANT at all). p_id is the sole '
  'idempotency key -- a retry with the same p_id returns the already-logged '
  'meal''s data rather than re-expanding a second time.';

revoke execute on function public.log_saved_meal_v1(
  uuid, uuid, timestamptz, date, text, public.meal_type,
  public.timeline_source, public.timeline_visibility, text, text, timestamptz
) from public, anon;

grant execute on function public.log_saved_meal_v1(
  uuid, uuid, timestamptz, date, text, public.meal_type,
  public.timeline_source, public.timeline_visibility, text, text, timestamptz
) to authenticated;
