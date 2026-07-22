-- =============================================================================
-- Phase 3 — Module B: illustrative starter seed for foods/food_servings/food_nutrients
-- Design ref: docs/architecture/phase-3-module-b.md §1.1, §2.1
--
-- A small ILLUSTRATIVE starter seed (a couple dozen common foods across both
-- source bases + a few with barcodes) so RLS/grants/search/barcode behavior
-- verify end-to-end before the real FDC+OFF ingestion pipeline lands --
-- exactly the precedent set by 20260721100000_create_exercises.sql's starter
-- seed. This is explicitly NOT the merged-source ingestion (§2.1) --
-- backend-builder's ingestion job supersedes these rows in place (same
-- (source, source_ref) dedup key) once it ships. `source_ref` values below
-- are fabricated placeholders (`SEED-FDC-*` / `SEED-OFF-*`), not real FDC
-- fdcId / OFF product codes.
--
-- Fixed/literal UUIDs are used throughout (rather than gen_random_uuid())
-- so this migration can insert matching food_servings/food_nutrients child
-- rows in the same script and remain idempotent/safely re-runnable via
-- ON CONFLICT (id) DO NOTHING.
--
-- ROLLBACK: see supabase/migrations/rollbacks/20260722100300_seed_reference_foods.sql
-- =============================================================================

insert into public.foods
  (id, source, source_ref, barcode, name, brand, category, basis,
   energy_kcal, protein_g, carb_g, fat_g, data_quality, attribution, is_active)
values
  ('a0000000-0000-4000-8000-000000000001', 'usda_fdc', 'SEED-FDC-0001', null, 'Chicken Breast, Cooked, Skinless', null, 'Poultry',        'per_100g', 165, 31.0, 0.0,  3.6,  'high',   'USDA FoodData Central', true),
  ('a0000000-0000-4000-8000-000000000002', 'usda_fdc', 'SEED-FDC-0002', null, 'Brown Rice, Cooked',              null, 'Grains',         'per_100g', 123, 2.7,  25.6, 1.0,  'high',   'USDA FoodData Central', true),
  ('a0000000-0000-4000-8000-000000000003', 'usda_fdc', 'SEED-FDC-0003', null, 'Broccoli, Raw',                   null, 'Vegetables',     'per_100g', 34,  2.8,  6.6,  0.4,  'high',   'USDA FoodData Central', true),
  ('a0000000-0000-4000-8000-000000000004', 'usda_fdc', 'SEED-FDC-0004', null, 'Banana, Raw',                     null, 'Fruits',         'per_100g', 89,  1.1,  22.8, 0.3,  'high',   'USDA FoodData Central', true),
  ('a0000000-0000-4000-8000-000000000005', 'usda_fdc', 'SEED-FDC-0005', null, 'Egg, Whole, Large',               null, 'Dairy & Eggs',   'per_100g', 143, 12.6, 0.7,  9.5,  'high',   'USDA FoodData Central', true),
  ('a0000000-0000-4000-8000-000000000006', 'usda_fdc', 'SEED-FDC-0006', null, 'Whole Milk',                      null, 'Dairy & Eggs',   'per_100ml',61,  3.2,  4.8,  3.3,  'high',   'USDA FoodData Central', true),
  ('a0000000-0000-4000-8000-000000000007', 'usda_fdc', 'SEED-FDC-0007', null, 'Rolled Oats, Dry',                null, 'Grains',         'per_100g', 379, 13.2, 67.7, 6.5,  'high',   'USDA FoodData Central', true),
  ('a0000000-0000-4000-8000-000000000008', 'usda_fdc', 'SEED-FDC-0008', null, 'Almonds, Raw',                    null, 'Nuts & Seeds',   'per_100g', 579, 21.2, 21.6, 49.9, 'high',   'USDA FoodData Central', true),
  ('a0000000-0000-4000-8000-000000000009', 'usda_fdc', 'SEED-FDC-0009', null, 'Salmon, Atlantic, Cooked',        null, 'Fish & Seafood', 'per_100g', 206, 22.1, 0.0,  12.4, 'high',   'USDA FoodData Central', true),
  ('a0000000-0000-4000-8000-000000000010', 'usda_fdc', 'SEED-FDC-0010', null, 'Sweet Potato, Baked',             null, 'Vegetables',     'per_100g', 90,  2.0,  20.7, 0.2,  'high',   'USDA FoodData Central', true),
  ('a0000000-0000-4000-8000-000000000011', 'open_food_facts', 'SEED-OFF-0001', '0850012345671', 'Creamy Peanut Butter',  'NutButter Co', 'Spreads',      'per_100g', 588, 25.1, 20.0, 50.0, 'medium', 'Open Food Facts contributors, ODbL', true),
  ('a0000000-0000-4000-8000-000000000012', 'open_food_facts', 'SEED-OFF-0002', '0850012345688', 'Plain Greek Yogurt',    'DairyPure',    'Dairy & Eggs', 'per_100g', 59,  10.2, 3.6,  0.4,  'medium', 'Open Food Facts contributors, ODbL', true),
  ('a0000000-0000-4000-8000-000000000013', 'open_food_facts', 'SEED-OFF-0003', '0850012345695', 'Chocolate Protein Bar', 'FitFuel',      'Snacks',       'per_100g', 375, 30.0, 40.0, 12.0, 'low',    'Open Food Facts contributors, ODbL', true),
  ('a0000000-0000-4000-8000-000000000014', 'open_food_facts', 'SEED-OFF-0004', '0850012345701', 'Cola, Regular',         'FizzCo',       'Beverages',    'per_100ml',42,  0.0,  10.6, 0.0,  'medium', 'Open Food Facts contributors, ODbL', true)
on conflict (source, source_ref) do nothing;

-- Every seeded food gets the synthetic 100 g/100 ml default serving (§1.1:
-- "every food gets at least a synthetic 100 g/100 ml default serving at
-- ingest so a food is always loggable"), plus a couple of named servings on
-- foods where a natural portion exists.
insert into public.food_servings (id, food_id, label, gram_or_ml_weight, is_default, sort_order)
values
  ('b0000000-0000-4000-8000-000000000001', 'a0000000-0000-4000-8000-000000000001', '100 g',                 100, true,  0),
  ('b0000000-0000-4000-8000-000000000002', 'a0000000-0000-4000-8000-000000000002', '100 g',                 100, true,  0),
  ('b0000000-0000-4000-8000-000000000003', 'a0000000-0000-4000-8000-000000000003', '100 g',                 100, true,  0),
  ('b0000000-0000-4000-8000-000000000004', 'a0000000-0000-4000-8000-000000000004', '100 g',                 100, true,  0),
  ('b0000000-0000-4000-8000-000000000005', 'a0000000-0000-4000-8000-000000000004', '1 medium banana (118 g)', 118, false, 1),
  ('b0000000-0000-4000-8000-000000000006', 'a0000000-0000-4000-8000-000000000005', '100 g',                 100, true,  0),
  ('b0000000-0000-4000-8000-000000000007', 'a0000000-0000-4000-8000-000000000005', '1 large egg (50 g)',    50,  false, 1),
  ('b0000000-0000-4000-8000-000000000008', 'a0000000-0000-4000-8000-000000000006', '100 ml',                100, true,  0),
  ('b0000000-0000-4000-8000-000000000009', 'a0000000-0000-4000-8000-000000000006', '1 cup (240 ml)',        240, false, 1),
  ('b0000000-0000-4000-8000-000000000010', 'a0000000-0000-4000-8000-000000000007', '100 g',                 100, true,  0),
  ('b0000000-0000-4000-8000-000000000011', 'a0000000-0000-4000-8000-000000000008', '100 g',                 100, true,  0),
  ('b0000000-0000-4000-8000-000000000012', 'a0000000-0000-4000-8000-000000000009', '100 g',                 100, true,  0),
  ('b0000000-0000-4000-8000-000000000013', 'a0000000-0000-4000-8000-000000000010', '100 g',                 100, true,  0),
  ('b0000000-0000-4000-8000-000000000014', 'a0000000-0000-4000-8000-000000000011', '100 g',                 100, true,  0),
  ('b0000000-0000-4000-8000-000000000015', 'a0000000-0000-4000-8000-000000000011', '2 tbsp (32 g)',         32,  false, 1),
  ('b0000000-0000-4000-8000-000000000016', 'a0000000-0000-4000-8000-000000000012', '100 g',                 100, true,  0),
  ('b0000000-0000-4000-8000-000000000017', 'a0000000-0000-4000-8000-000000000012', '1 container (170 g)',   170, false, 1),
  ('b0000000-0000-4000-8000-000000000018', 'a0000000-0000-4000-8000-000000000013', '100 g',                 100, true,  0),
  ('b0000000-0000-4000-8000-000000000019', 'a0000000-0000-4000-8000-000000000013', '1 bar (60 g)',          60,  false, 1),
  ('b0000000-0000-4000-8000-000000000020', 'a0000000-0000-4000-8000-000000000014', '100 ml',                100, true,  0),
  ('b0000000-0000-4000-8000-000000000021', 'a0000000-0000-4000-8000-000000000014', '1 can (355 ml)',        355, false, 1)
on conflict (id) do nothing;

-- A handful of food_nutrients rows so the EAV child path verifies end-to-end
-- too (not every seeded food needs one -- illustrative, not exhaustive).
insert into public.food_nutrients (id, food_id, nutrient_kind, amount, unit)
values
  ('c0000000-0000-4000-8000-000000000001', 'a0000000-0000-4000-8000-000000000003', 'fiber_g',   2.6,  'g'),
  ('c0000000-0000-4000-8000-000000000002', 'a0000000-0000-4000-8000-000000000007', 'fiber_g',   10.1, 'g'),
  ('c0000000-0000-4000-8000-000000000003', 'a0000000-0000-4000-8000-000000000014', 'sugar_g',   10.6, 'g'),
  ('c0000000-0000-4000-8000-000000000004', 'a0000000-0000-4000-8000-000000000013', 'sugar_g',   20.0, 'g'),
  ('c0000000-0000-4000-8000-000000000005', 'a0000000-0000-4000-8000-000000000013', 'sodium_mg', 220,  'mg'),
  ('c0000000-0000-4000-8000-000000000006', 'a0000000-0000-4000-8000-000000000011', 'sodium_mg', 17,   'mg')
on conflict (id) do nothing;
