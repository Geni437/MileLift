-- =============================================================================
-- Phase 3 — Module B: foods search index + search_foods_v1 / resolve_barcode_v1
-- Design ref: docs/architecture/phase-3-module-b.md §2.2, §5, §8, §13
--
-- SCOPE NOTE (resolves an ambiguity flagged in the task report): §13's
-- implementation routing lists "the foods search index with the search RPC"
-- under db-engineer, but then separately lists `search_foods_v1` by name
-- under backend-builder's RPC list. Read together with the task's explicit
-- instruction ("RPC implementation can be a straightforward wrapper for now
-- if backend-builder is meant to build out the real ranking/matching
-- logic"), this migration resolves the ambiguity as: db-engineer ships a
-- CORRECT, PRODUCTION-SAFE, but INTENTIONALLY STRAIGHTFORWARD ranking
-- implementation (exact/prefix match + a data_quality/source tie-break,
-- backed by the trigram index below) so the §2.2 access-pattern contract is
-- live and testable immediately -- never a stub returning mock data
-- (production-standards forbids that regardless of "who owns polish").
-- backend-builder may later ship richer fuzzy-matching/ranking (better
-- typo-tolerance, phrase weighting, etc.) as `search_foods_v2` per
-- supabase-standards' versioning-without-URL-versions rule -- v1 must keep
-- working for app versions already in the field.
--
-- ACCESS-PATTERN NOTE (§2.2): both RPCs are SECURITY DEFINER, not the
-- project's usual SECURITY INVOKER default. This is a deliberate, justified
-- exception per supabase-standards ("only use SECURITY DEFINER when the
-- operation genuinely needs to act with elevated privilege, and ... validate
-- authorization explicitly inside the function body since RLS won't do it
-- for you there"): `foods`/`food_servings` carry NO client GRANT at all
-- (20260722100000_create_foods.sql / 20260722100200_create_food_servings.sql)
-- by design, so a SECURITY INVOKER function running as `authenticated` could
-- not read them regardless of RLS. Both functions authenticate the caller
-- explicitly (`auth.uid() is not null`) and filter `is_active` explicitly in
-- every query -- RLS is not relied on for these reads.
--
-- ROLLBACK: see supabase/migrations/rollbacks/20260722110100_create_food_search_index_and_rpcs.sql
-- =============================================================================

-- -----------------------------------------------------------------------------
-- search_foods_v1's supporting index -- added WITH the RPC, not
-- speculatively, per db-schema-standards ("tied to an actual query pattern
-- you can name"). Trigram GIN index supports both the ILIKE substring match
-- and the `%` similarity operator used by the ranking query below. Partial
-- on is_active: a hidden/superseded food should never surface in a fresh
-- search.
-- -----------------------------------------------------------------------------
create index idx_foods_active_name_trgm
  on public.foods using gin (name extensions.gin_trgm_ops)
  where is_active;

comment on index public.idx_foods_active_name_trgm is
  'Backs search_foods_v1''s ranked name search (§2.2 item 1) -- both the '
  '`ilike ''%...%''` substring match and the pg_trgm `%` similarity operator '
  'can use a trigram GIN index.';

-- =============================================================================
-- public.search_foods_v1(p_query, p_cursor, p_limit) — §2.2 item 1, §5
--
-- SECURITY DEFINER (see migration header). Bounded, ranked, cursor-paginated
-- -- NEVER an unranged select, guarding the max_rows = 1000 silent-
-- truncation hazard (§2.2). Page size is a NAMED CONSTANT well under 1000
-- (production-standards: no bare magic numbers).
--
-- Ranking (§2.2 item 1: "exact/prefix name match + data_quality +
-- FDC-over-OFF tie-break"):
--   exact case-insensitive name match       -> 100
--   case-insensitive name PREFIX match      -> 80
--   name contains the query (substring)     -> 60
--   otherwise, pg_trgm similarity score     -> 0..50
--   + a small data_quality boost (high=3, medium=2, low=1)
--   + a small source tie-break (usda_fdc=0.5, milelift_authored=0.25, off=0)
-- The two "+" boosts are deliberately small relative to the match-tier gaps
-- above so they only break ties among otherwise-similar name matches, never
-- override a genuinely better name match with a lower-quality source.
--
-- Cursor: keyset pagination on (rank_score DESC, id ASC) -- a stable total
-- order since id is unique. p_cursor is null on the first page; each
-- response's data.next_cursor (null when exhausted) is passed back verbatim
-- on the next call. Never OFFSET-based (Phase 0 §3.6: cursor-based, never
-- offset).
-- =============================================================================
create or replace function public.search_foods_v1(
  p_query   text,
  p_cursor  jsonb default null,
  p_limit   integer default null
)
returns jsonb
language plpgsql
security definer
set search_path = public, extensions, pg_temp
as $$
declare
  v_default_limit     constant integer := 20;
  v_max_limit          constant integer := 50; -- well under supabase/config.toml's max_rows = 1000
  v_max_query_length    constant integer := 200;
  v_limit                integer;
  v_cursor_score          numeric;
  v_cursor_id              uuid;
  v_row                     record;
  v_items                    jsonb := '[]'::jsonb;
  v_count                     integer := 0;
  v_has_more                   boolean := false;
  v_next_cursor                  jsonb;
  v_last_score                     numeric;
  v_last_id                         uuid;
begin
  if auth.uid() is null then
    return jsonb_build_object('error', jsonb_build_object(
      'code', 'UNAUTHENTICATED', 'message', 'No authenticated user context.', 'field', null));
  end if;

  if p_query is null or length(trim(p_query)) = 0 then
    return jsonb_build_object('error', jsonb_build_object(
      'code', 'VALIDATION_ERROR', 'message', 'query is required.', 'field', 'query'));
  end if;

  if length(p_query) > v_max_query_length then
    return jsonb_build_object('error', jsonb_build_object(
      'code', 'VALIDATION_ERROR', 'message', format('query must be <= %s characters.', v_max_query_length), 'field', 'query'));
  end if;

  v_limit := coalesce(p_limit, v_default_limit);
  if v_limit < 1 or v_limit > v_max_limit then
    return jsonb_build_object('error', jsonb_build_object(
      'code', 'VALIDATION_ERROR', 'message', format('limit must be between 1 and %s.', v_max_limit), 'field', 'limit'));
  end if;

  if p_cursor is not null then
    if not (p_cursor ? 'rank_score' and p_cursor ? 'id') then
      return jsonb_build_object('error', jsonb_build_object(
        'code', 'VALIDATION_ERROR', 'message', 'cursor must contain rank_score and id.', 'field', 'cursor'));
    end if;
    begin
      v_cursor_score := (p_cursor ->> 'rank_score')::numeric;
      v_cursor_id := (p_cursor ->> 'id')::uuid;
    exception when others then
      return jsonb_build_object('error', jsonb_build_object(
        'code', 'VALIDATION_ERROR', 'message', 'cursor.rank_score must be numeric and cursor.id must be a uuid.', 'field', 'cursor'));
    end;
  end if;

  -- Fetch one extra row past the page size to know whether a next page
  -- exists, without a separate COUNT(*) query.
  for v_row in
    select s.id, s.source, s.name, s.brand, s.barcode, s.basis,
           s.energy_kcal, s.protein_g, s.carb_g, s.fat_g, s.data_quality, s.attribution,
           s.rank_score, fs.id as serving_id, fs.label as serving_label, fs.gram_or_ml_weight as serving_weight
    from (
      select f.id, f.source, f.name, f.brand, f.barcode, f.basis,
             f.energy_kcal, f.protein_g, f.carb_g, f.fat_g, f.data_quality, f.attribution,
             (
               (
                 case
                   when lower(f.name) = lower(p_query) then 100
                   when lower(f.name) like lower(p_query) || '%' then 80
                   when f.name ilike '%' || p_query || '%' then 60
                   else round((similarity(f.name, p_query) * 50)::numeric, 4)
                 end
               )
               + (case f.data_quality when 'high' then 3 when 'medium' then 2 else 1 end)
               + (case f.source when 'usda_fdc' then 0.5 when 'milelift_authored' then 0.25 else 0 end)
             )::numeric as rank_score
      from public.foods f
      where f.is_active
        and (f.name ilike '%' || p_query || '%' or f.name % p_query)
    ) s
    left join lateral (
      select fsi.id, fsi.label, fsi.gram_or_ml_weight
      from public.food_servings fsi
      where fsi.food_id = s.id
      order by fsi.is_default desc, fsi.sort_order asc
      limit 1
    ) fs on true
    where v_cursor_score is null
       or s.rank_score < v_cursor_score
       or (s.rank_score = v_cursor_score and s.id > v_cursor_id)
    order by s.rank_score desc, s.id asc
    limit v_limit + 1
  loop
    v_count := v_count + 1;
    if v_count > v_limit then
      v_has_more := true;
      exit;
    end if;

    v_items := v_items || jsonb_build_object(
      'food_id', v_row.id,
      'source', v_row.source,
      'name', v_row.name,
      'brand', v_row.brand,
      'barcode', v_row.barcode,
      'basis', v_row.basis,
      'energy_kcal', v_row.energy_kcal,
      'protein_g', v_row.protein_g,
      'carb_g', v_row.carb_g,
      'fat_g', v_row.fat_g,
      'data_quality', v_row.data_quality,
      'attribution', v_row.attribution,
      'default_serving', case
        when v_row.serving_id is null then null
        else jsonb_build_object('id', v_row.serving_id, 'label', v_row.serving_label, 'gram_or_ml_weight', v_row.serving_weight)
      end
    );
    v_last_score := v_row.rank_score;
    v_last_id := v_row.id;
  end loop;

  v_next_cursor := case when v_has_more then jsonb_build_object('rank_score', v_last_score, 'id', v_last_id) else null end;

  return jsonb_build_object('data', jsonb_build_object('items', v_items, 'next_cursor', v_next_cursor));

exception when others then
  return jsonb_build_object('error', jsonb_build_object('code', 'SEARCH_FAILED', 'message', sqlerrm, 'field', null));
end;
$$;

comment on function public.search_foods_v1(text, jsonb, integer) is
  'CORE-06/07 bounded, ranked, cursor-paginated food search (§2.2 item 1, '
  '§5). SECURITY DEFINER -- foods/food_servings carry no client GRANT (see '
  'migration header); this function is the ONLY text-search read path. '
  'Never an unranged select -- guards the max_rows=1000 silent-truncation '
  'hazard. db-engineer''s straightforward ranking implementation; '
  'backend-builder may ship richer matching as search_foods_v2 later '
  '(supabase-standards versioning) without breaking this contract.';

revoke execute on function public.search_foods_v1(text, jsonb, integer) from public, anon;
grant execute on function public.search_foods_v1(text, jsonb, integer) to authenticated;

-- =============================================================================
-- public.resolve_barcode_v1(p_barcode) — §2.2 item 2, §2.4, §5
--
-- SECURITY DEFINER (see migration header). Exact point lookup on the
-- indexed barcode column -- never a scan. Returns the food + its servings on
-- a hit, or a structured BARCODE_NOT_FOUND error the client routes to
-- custom-food creation (§2.4 step 3) -- never a silent empty result
-- (production-standards' unhappy-path rule).
--
-- When multiple active foods share a barcode (a genuine, expected
-- possibility before the ingestion job's deterministic merge resolves it,
-- §2.1), this picks the highest-precedence source (FDC > MileLift-authored
-- > OFF) then the most recently updated -- a reasonable, documented
-- tie-break, not a silent arbitrary pick.
-- =============================================================================
create or replace function public.resolve_barcode_v1(p_barcode text)
returns jsonb
language plpgsql
security definer
set search_path = public, extensions, pg_temp
as $$
declare
  v_food      record;
  v_servings  jsonb;
begin
  if auth.uid() is null then
    return jsonb_build_object('error', jsonb_build_object(
      'code', 'UNAUTHENTICATED', 'message', 'No authenticated user context.', 'field', null));
  end if;

  if p_barcode is null or length(trim(p_barcode)) = 0 then
    return jsonb_build_object('error', jsonb_build_object(
      'code', 'VALIDATION_ERROR', 'message', 'barcode is required.', 'field', 'barcode'));
  end if;

  select f.id, f.source, f.name, f.brand, f.barcode, f.basis,
         f.energy_kcal, f.protein_g, f.carb_g, f.fat_g, f.data_quality, f.attribution
    into v_food
  from public.foods f
  where f.barcode = p_barcode and f.is_active
  order by
    case f.source when 'usda_fdc' then 0 when 'milelift_authored' then 1 else 2 end,
    f.updated_at desc
  limit 1;

  if not found then
    return jsonb_build_object('error', jsonb_build_object(
      'code', 'BARCODE_NOT_FOUND', 'message', 'No active food matches this barcode in the reference catalog.', 'field', 'barcode'));
  end if;

  select coalesce(
      jsonb_agg(
        jsonb_build_object('id', fs.id, 'label', fs.label, 'gram_or_ml_weight', fs.gram_or_ml_weight, 'is_default', fs.is_default)
        order by fs.sort_order
      ),
      '[]'::jsonb
    )
    into v_servings
  from public.food_servings fs
  where fs.food_id = v_food.id;

  return jsonb_build_object('data', jsonb_build_object(
    'food_id', v_food.id,
    'source', v_food.source,
    'name', v_food.name,
    'brand', v_food.brand,
    'barcode', v_food.barcode,
    'basis', v_food.basis,
    'energy_kcal', v_food.energy_kcal,
    'protein_g', v_food.protein_g,
    'carb_g', v_food.carb_g,
    'fat_g', v_food.fat_g,
    'data_quality', v_food.data_quality,
    'attribution', v_food.attribution,
    'servings', v_servings
  ));

exception when others then
  return jsonb_build_object('error', jsonb_build_object('code', 'BARCODE_LOOKUP_FAILED', 'message', sqlerrm, 'field', null));
end;
$$;

comment on function public.resolve_barcode_v1(text) is
  'CORE-07 exact barcode point lookup (§2.2 item 2, §2.4). SECURITY '
  'DEFINER -- see migration header. Returns {"data": {food + servings}} on '
  'a hit or {"error": {"code": "BARCODE_NOT_FOUND", ...}} on a miss, never '
  'a silent empty result -- the client routes a miss to custom-food '
  'creation (§2.4 step 3).';

revoke execute on function public.resolve_barcode_v1(text) from public, anon;
grant execute on function public.resolve_barcode_v1(text) to authenticated;
