#!/usr/bin/env node
/**
 * Live verification script for Phase 3 Module B (Nutrition & Food Logging)
 * schema: supabase/migrations/20260722100000_create_foods.sql through
 * 20260722110100_create_food_search_index_and_rpcs.sql.
 *
 * Standalone, manually-run script (not part of `npm test` / CI) — talks to a
 * REAL Supabase project, not a mock, and mutates real data in disposable
 * test accounts it creates and deletes itself. Mirrors the existing
 * scripts/verify-save-workout-session.mjs convention:
 *   - service_role is used ONLY to bootstrap (create disposable users) and
 *     clean up (delete them) — every read/write under test goes through an
 *     ANON client signed in as that user, under RLS, exactly as the mobile
 *     app would.
 *
 * What this proves, live (not just asserted from reading the migrations):
 *   1. foods/food_nutrients/food_servings have NO client bulk-select path
 *      (permission denied on a direct .select()) — the max_rows=1000 guard.
 *   2. search_foods_v1 / resolve_barcode_v1 work, are bounded/paginated, and
 *      reject bad input.
 *   3. Cross-user isolation on every owner-scoped table: user B cannot read
 *      user A's custom_foods / food_log_entries / food_log_items /
 *      water_intake_logs / manual_calorie_burn_logs / saved_meals /
 *      saved_meal_items, and anon can read none of it either.
 *   4. The seam-integrity triggers actually fire: a food_log_item cannot
 *      reference another user's custom_food_id; the exactly-one-food-ref
 *      CHECK rejects both-set and neither-set payloads.
 *   5. The manual_calorie_burn_logs conditional health-consent gate: an
 *      `estimated` energy_source is rejected without an active health
 *      consent row and accepted once one exists; `user_entered` is never
 *      gated.
 *   6. The §8.1 column-scoped UPDATE grants are real: a targeted update of a
 *      mutable column succeeds; a naive whole-row upsert that includes an
 *      IMMUTABLE column (even with an unchanged value) is REJECTED at plan
 *      time with a permission error — the exact recurring bug class this
 *      project has hit three times before, proven fixed here a fourth time.
 *   7. saved_meal_items supports a real client DELETE (the deliberate
 *      exception); saved_meals does not (no DELETE grant/policy).
 *
 * Required environment variables (never hardcoded, never committed):
 *   SUPABASE_URL, SUPABASE_ANON_KEY, SUPABASE_SERVICE_ROLE_KEY
 */

import { createClient } from '@supabase/supabase-js';
import { randomUUID } from 'node:crypto';

const SUPABASE_URL = process.env.SUPABASE_URL;
const SUPABASE_ANON_KEY = process.env.SUPABASE_ANON_KEY;
const SUPABASE_SERVICE_ROLE_KEY = process.env.SUPABASE_SERVICE_ROLE_KEY;

if (!SUPABASE_URL || !SUPABASE_ANON_KEY || !SUPABASE_SERVICE_ROLE_KEY) {
  console.error(
    'FAIL: SUPABASE_URL, SUPABASE_ANON_KEY, and SUPABASE_SERVICE_ROLE_KEY must all be set ' +
      'in the environment. Refusing to guess/hardcode credentials.'
  );
  process.exit(1);
}

const stamp = Date.now();
const USER_A_EMAIL = `nutrition-verify-a-${stamp}@example.invalid`;
const USER_B_EMAIL = `nutrition-verify-b-${stamp}@example.invalid`;
const PASSWORD = randomUUID() + 'Aa1!';

// Seeded reference-food ids/barcodes from 20260722100300_seed_reference_foods.sql.
const CHICKEN_BREAST_ID = 'a0000000-0000-4000-8000-000000000001';
const PEANUT_BUTTER_BARCODE = '0850012345671';

let failures = 0;
function check(label, cond, detail) {
  if (cond) {
    console.log(`  PASS  ${label}`);
  } else {
    failures += 1;
    console.log(`  FAIL  ${label}${detail !== undefined ? ` — ${JSON.stringify(detail)}` : ''}`);
  }
}

async function main() {
  const admin = createClient(SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY, {
    auth: { autoRefreshToken: false, persistSession: false },
  });

  console.log(`Bootstrapping disposable test users...`);
  const { data: createdA, error: createErrA } = await admin.auth.admin.createUser({
    email: USER_A_EMAIL,
    password: PASSWORD,
    email_confirm: true,
  });
  const { data: createdB, error: createErrB } = await admin.auth.admin.createUser({
    email: USER_B_EMAIL,
    password: PASSWORD,
    email_confirm: true,
  });
  if (createErrA || createErrB) {
    console.error('FAIL: could not create disposable test users:', createErrA?.message, createErrB?.message);
    process.exit(1);
  }
  const userAId = createdA.user.id;
  const userBId = createdB.user.id;

  const clientA = createClient(SUPABASE_URL, SUPABASE_ANON_KEY, { auth: { autoRefreshToken: false, persistSession: false } });
  const clientB = createClient(SUPABASE_URL, SUPABASE_ANON_KEY, { auth: { autoRefreshToken: false, persistSession: false } });
  const anonClient = createClient(SUPABASE_URL, SUPABASE_ANON_KEY, { auth: { autoRefreshToken: false, persistSession: false } });

  try {
    const { error: signInErrA } = await clientA.auth.signInWithPassword({ email: USER_A_EMAIL, password: PASSWORD });
    const { error: signInErrB } = await clientB.auth.signInWithPassword({ email: USER_B_EMAIL, password: PASSWORD });
    if (signInErrA || signInErrB) throw new Error(`sign-in failed: ${signInErrA?.message} / ${signInErrB?.message}`);

    // =========================================================================
    console.log('\n--- Case 1: foods/food_nutrients/food_servings have NO bulk-select path (§2.2 hazard) ---');
    // =========================================================================
    const foodsSelect = await clientA.from('foods').select('id').limit(1);
    check('direct .select() on foods is permission-denied (no GRANT exists)', !!foodsSelect.error, foodsSelect);

    const nutrientsSelect = await clientA.from('food_nutrients').select('id').limit(1);
    check('direct .select() on food_nutrients is permission-denied', !!nutrientsSelect.error, nutrientsSelect);

    const servingsSelect = await clientA.from('food_servings').select('id').limit(1);
    check('direct .select() on food_servings is permission-denied', !!servingsSelect.error, servingsSelect);

    // =========================================================================
    console.log('\n--- Case 2: search_foods_v1 (bounded, ranked, cursor-paginated) ---');
    // =========================================================================
    const searchBad = await clientA.rpc('search_foods_v1', { p_query: '' });
    check('search_foods_v1: blank query -> VALIDATION_ERROR', searchBad.data?.error?.code === 'VALIDATION_ERROR', searchBad.data);

    const search1 = await clientA.rpc('search_foods_v1', { p_query: 'chicken', p_limit: 5 });
    check('search_foods_v1: no transport error', !search1.error, search1.error?.message);
    check('search_foods_v1: no business error', search1.data && !search1.data.error, search1.data);
    const items1 = search1.data?.data?.items ?? [];
    check('search_foods_v1: returns at least one result for "chicken"', items1.length > 0, items1);
    check(
      'search_foods_v1: top result is the exact-match seeded Chicken Breast row',
      items1[0]?.food_id === CHICKEN_BREAST_ID,
      items1[0]
    );
    check('search_foods_v1: top result carries a default_serving', !!items1[0]?.default_serving, items1[0]);

    const searchPage1 = await clientA.rpc('search_foods_v1', { p_query: 'a', p_limit: 1 });
    const nextCursor = searchPage1.data?.data?.next_cursor;
    check('search_foods_v1: a broad query + limit=1 yields a next_cursor', !!nextCursor, searchPage1.data);
    if (nextCursor) {
      const searchPage2 = await clientA.rpc('search_foods_v1', { p_query: 'a', p_limit: 1, p_cursor: nextCursor });
      const page1Id = searchPage1.data?.data?.items?.[0]?.food_id;
      const page2Id = searchPage2.data?.data?.items?.[0]?.food_id;
      check('search_foods_v1: page 2 (via cursor) returns a DIFFERENT food than page 1', page1Id && page2Id && page1Id !== page2Id, { page1Id, page2Id });
    }

    // =========================================================================
    console.log('\n--- Case 3: resolve_barcode_v1 (exact point lookup) ---');
    // =========================================================================
    const barcodeHit = await clientA.rpc('resolve_barcode_v1', { p_barcode: PEANUT_BUTTER_BARCODE });
    check('resolve_barcode_v1: hit returns data, no error', barcodeHit.data && !barcodeHit.data.error, barcodeHit.data);
    check('resolve_barcode_v1: hit returns the right food', barcodeHit.data?.data?.name === 'Creamy Peanut Butter', barcodeHit.data);
    check('resolve_barcode_v1: hit returns >= 2 servings', (barcodeHit.data?.data?.servings ?? []).length >= 2, barcodeHit.data?.data?.servings);

    const barcodeMiss = await clientA.rpc('resolve_barcode_v1', { p_barcode: '0000000000000-does-not-exist' });
    check('resolve_barcode_v1: miss returns BARCODE_NOT_FOUND, not a silent empty result', barcodeMiss.data?.error?.code === 'BARCODE_NOT_FOUND', barcodeMiss.data);

    // =========================================================================
    console.log('\n--- Case 4: custom_foods owner isolation + column-scoped UPDATE grant ---');
    // =========================================================================
    const customFoodId = randomUUID();
    const insCustom = await clientA.from('custom_foods').insert({
      id: customFoodId,
      user_id: userAId,
      barcode: 'USERBC-VERIFY-001',
      name: 'My Homemade Chili',
      basis: 'per_100g',
      energy_kcal: 180,
      protein_g: 12,
      carb_g: 15,
      fat_g: 7,
      default_serving_g_or_ml: 250,
    });
    check('custom_foods: owner insert succeeds', !insCustom.error, insCustom.error?.message);

    const readOwnCustom = await clientA.from('custom_foods').select('id, name').eq('id', customFoodId);
    check('custom_foods: owner can read own row', readOwnCustom.data?.length === 1, readOwnCustom);

    const readOtherCustom = await clientB.from('custom_foods').select('id').eq('id', customFoodId);
    check("custom_foods: user B CANNOT see user A's custom food (RLS)", (readOtherCustom.data ?? []).length === 0, readOtherCustom.data);

    const readAnonCustom = await anonClient.from('custom_foods').select('id').eq('id', customFoodId);
    check('custom_foods: anon CANNOT see it either', !!readAnonCustom.error || (readAnonCustom.data ?? []).length === 0, readAnonCustom);

    const targetedUpdate = await clientA.from('custom_foods').update({ name: 'My Homemade Chili (v2)' }).eq('id', customFoodId);
    check('custom_foods: targeted update of a MUTABLE column succeeds', !targetedUpdate.error, targetedUpdate.error?.message);

    // THE RECURRING BUG, PROVEN FIXED: a naive whole-row upsert that includes
    // an IMMUTABLE column (user_id, even unchanged) must be rejected at plan
    // time, not silently accepted or silently dropped.
    const naiveUpsert = await clientA.from('custom_foods').upsert({
      id: customFoodId,
      user_id: userAId, // immutable column present in payload -> must fail
      name: 'My Homemade Chili (naive upsert)',
    });
    check(
      'custom_foods: NAIVE WHOLE-ROW .upsert() INCLUDING user_id is REJECTED at plan time (the recurring bug, proven fixed)',
      !!naiveUpsert.error,
      naiveUpsert
    );

    // CORRECTED UNDERSTANDING (found live during this task, see
    // 20260722999999_revert_custom_foods_diagnostic_grant.sql for the full
    // account): restricting the upsert payload to mutable columns is NOT
    // sufficient on its own -- .upsert() always includes the conflict-target
    // column (id) in its ON CONFLICT DO UPDATE SET list because id must be
    // present in the payload to target this existing row, and id has no
    // UPDATE grant (correctly). So even a "safe", mutable-columns-only-looking
    // upsert against an EXISTING row is expected to fail here.
    const mutableOnlyUpsertOnExistingRow = await clientA.from('custom_foods').upsert({ id: customFoodId, notes: 'looks safe but is not' });
    check(
      'custom_foods: even a MUTABLE-COLUMNS-ONLY .upsert() against an EXISTING row is REJECTED (id is always an implicit SET target)',
      !!mutableOnlyUpsertOnExistingRow.error,
      mutableOnlyUpsertOnExistingRow
    );

    // The only client-safe edit path: a plain .update(), never .upsert().
    const safeUpdate = await clientA.from('custom_foods').update({ notes: 'safe plain update' }).eq('id', customFoodId);
    check('custom_foods: a plain .update() (not .upsert()) of a MUTABLE column succeeds', !safeUpdate.error, safeUpdate.error?.message);

    // The two-step client pattern for true insert-or-update sync semantics:
    // .insert() a brand-new id succeeds outright (no conflict).
    const brandNewId = randomUUID();
    const freshInsert = await clientA.from('custom_foods').insert({
      id: brandNewId,
      user_id: userAId,
      name: 'Fresh Row For Two-Step Pattern',
      basis: 'per_100g',
      energy_kcal: 50,
    });
    check('custom_foods: .insert() of a BRAND-NEW row succeeds (no conflict)', !freshInsert.error, freshInsert.error?.message);
    // Retrying the SAME insert (the offline-retry case) correctly fails with
    // a conflict, which the client catches and falls back to .update() for.
    const retryInsert = await clientA.from('custom_foods').insert({
      id: brandNewId,
      user_id: userAId,
      name: 'Fresh Row For Two-Step Pattern (retry)',
      basis: 'per_100g',
      energy_kcal: 50,
    });
    check('custom_foods: retrying the SAME .insert() (offline retry) correctly conflicts (23505)', retryInsert.error?.code === '23505', retryInsert.error);
    const fallbackUpdate = await clientA.from('custom_foods').update({ notes: 'resolved via fallback update' }).eq('id', brandNewId);
    check('custom_foods: falling back to .update() after the insert conflict succeeds', !fallbackUpdate.error, fallbackUpdate.error?.message);

    // =========================================================================
    console.log('\n--- Case 5: food_log_entries + food_log_items (meal + firehose) ---');
    // =========================================================================
    const mealId = randomUUID();
    const nowIso = new Date().toISOString();
    const localDate = nowIso.slice(0, 10);

    const insMealSpine = await clientA.from('timeline_events').insert({
      id: mealId,
      user_id: userAId,
      source_module: 'nutrition',
      event_type: 'food_log_entry',
      occurred_at: nowIso,
      local_date: localDate,
      event_timezone: 'UTC',
      energy_kcal: 247.5,
      source: 'manual',
    });
    check('food_log_entries: spine row insert succeeds', !insMealSpine.error, insMealSpine.error?.message);

    const insMealDetail = await clientA.from('food_log_entries').insert({
      timeline_event_id: mealId,
      user_id: userAId,
      meal_type: 'lunch',
      title: 'Verification Lunch',
      total_energy_kcal: 247.5,
      total_protein_g: 46.5,
      total_carb_g: 0,
      total_fat_g: 5.4,
    });
    check('food_log_entries: detail row insert succeeds', !insMealDetail.error, insMealDetail.error?.message);

    const itemId = randomUUID();
    const insItem = await clientA.from('food_log_items').insert({
      id: itemId,
      timeline_event_id: mealId,
      user_id: userAId,
      food_id: CHICKEN_BREAST_ID,
      food_name_snapshot: 'Chicken Breast, Cooked, Skinless',
      serving_label_snapshot: '100 g',
      quantity: 1.5,
      serving_g_or_ml_snapshot: 100,
      energy_kcal: 247.5,
      protein_g: 46.5,
      carb_g: 0,
      fat_g: 5.4,
      data_quality_snapshot: 'high',
      sort_order: 0,
    });
    check('food_log_items: item insert (food_id ref) succeeds', !insItem.error, insItem.error?.message);

    // Exactly-one-food-ref CHECK: both set -> reject.
    const bothRefs = await clientA.from('food_log_items').insert({
      id: randomUUID(),
      timeline_event_id: mealId,
      user_id: userAId,
      food_id: CHICKEN_BREAST_ID,
      custom_food_id: customFoodId,
      food_name_snapshot: 'x',
      serving_label_snapshot: 'x',
      quantity: 1,
      serving_g_or_ml_snapshot: 100,
      energy_kcal: 1,
      sort_order: 1,
    });
    check('food_log_items: BOTH food_id and custom_food_id set -> rejected (CHECK)', !!bothRefs.error, bothRefs.error?.message);

    // Neither set -> reject.
    const noRefs = await clientA.from('food_log_items').insert({
      id: randomUUID(),
      timeline_event_id: mealId,
      user_id: userAId,
      food_name_snapshot: 'x',
      serving_label_snapshot: 'x',
      quantity: 1,
      serving_g_or_ml_snapshot: 100,
      energy_kcal: 1,
      sort_order: 2,
    });
    check('food_log_items: NEITHER food_id nor custom_food_id set -> rejected (CHECK)', !!noRefs.error, noRefs.error?.message);

    // Seam trigger: a custom_food_id belonging to ANOTHER user must be rejected.
    const otherCustomFoodId = randomUUID();
    await clientB.from('custom_foods').insert({
      id: otherCustomFoodId,
      user_id: userBId,
      name: "User B's Custom Food",
      basis: 'per_100g',
      energy_kcal: 100,
    });
    const crossUserCustomFoodRef = await clientA.from('food_log_items').insert({
      id: randomUUID(),
      timeline_event_id: mealId,
      user_id: userAId,
      custom_food_id: otherCustomFoodId, // owned by user B, not the caller
      food_name_snapshot: 'x',
      serving_label_snapshot: 'x',
      quantity: 1,
      serving_g_or_ml_snapshot: 100,
      energy_kcal: 1,
      sort_order: 3,
    });
    check(
      "food_log_items: referencing ANOTHER user's custom_food_id is rejected (seam-integrity trigger)",
      !!crossUserCustomFoodRef.error,
      crossUserCustomFoodRef.error?.message
    );

    // Cross-user isolation on the meal + item.
    const bReadMeal = await clientB.from('food_log_entries').select('timeline_event_id').eq('timeline_event_id', mealId);
    check("food_log_entries: user B cannot see user A's meal", (bReadMeal.data ?? []).length === 0, bReadMeal.data);
    const bReadItem = await clientB.from('food_log_items').select('id').eq('id', itemId);
    check("food_log_items: user B cannot see user A's item", (bReadItem.data ?? []).length === 0, bReadItem.data);
    const anonReadItem = await anonClient.from('food_log_items').select('id').eq('id', itemId);
    check('food_log_items: anon cannot see it either', !!anonReadItem.error || (anonReadItem.data ?? []).length === 0, anonReadItem);

    // Targeted (mutable-column-only) update succeeds.
    const itemTargetedUpdate = await clientA.from('food_log_items').update({ quantity: 2 }).eq('id', itemId);
    check('food_log_items: targeted update of MUTABLE column (quantity) succeeds', !itemTargetedUpdate.error, itemTargetedUpdate.error?.message);

    // Naive whole-row upsert including an IMMUTABLE column (food_id) -> rejected.
    const itemNaiveUpsert = await clientA.from('food_log_items').upsert({
      id: itemId,
      timeline_event_id: mealId,
      user_id: userAId,
      food_id: CHICKEN_BREAST_ID, // immutable column present, even unchanged -> must fail
      food_name_snapshot: 'Chicken Breast, Cooked, Skinless',
      serving_label_snapshot: '100 g',
      quantity: 2,
      serving_g_or_ml_snapshot: 100,
      energy_kcal: 330,
      sort_order: 0,
    });
    check(
      'food_log_items: NAIVE WHOLE-ROW .upsert() INCLUDING food_id/user_id/timeline_event_id is REJECTED (the recurring bug, proven fixed)',
      !!itemNaiveUpsert.error,
      itemNaiveUpsert
    );

    // =========================================================================
    console.log('\n--- Case 6: water_intake_logs ---');
    // =========================================================================
    const waterId = randomUUID();
    await clientA.from('timeline_events').insert({
      id: waterId,
      user_id: userAId,
      source_module: 'nutrition',
      event_type: 'water_intake',
      occurred_at: nowIso,
      local_date: localDate,
      event_timezone: 'UTC',
      source: 'manual',
    });
    const insWater = await clientA.from('water_intake_logs').insert({
      timeline_event_id: waterId,
      user_id: userAId,
      volume_ml: 500,
      unit_volume_snapshot: 'ml',
    });
    check('water_intake_logs: insert succeeds', !insWater.error, insWater.error?.message);

    const bReadWater = await clientB.from('water_intake_logs').select('timeline_event_id').eq('timeline_event_id', waterId);
    check("water_intake_logs: user B cannot see user A's water log", (bReadWater.data ?? []).length === 0, bReadWater.data);

    const waterTargetedUpdate = await clientA.from('water_intake_logs').update({ volume_ml: 750 }).eq('timeline_event_id', waterId);
    check('water_intake_logs: targeted update of MUTABLE column succeeds', !waterTargetedUpdate.error, waterTargetedUpdate.error?.message);

    const waterNaiveUpsert = await clientA.from('water_intake_logs').upsert({
      timeline_event_id: waterId,
      user_id: userAId, // immutable
      volume_ml: 900,
      unit_volume_snapshot: 'ml',
    });
    check('water_intake_logs: naive upsert including user_id is REJECTED', !!waterNaiveUpsert.error, waterNaiveUpsert);

    // =========================================================================
    console.log('\n--- Case 7: manual_calorie_burn_logs — conditional health-consent gate ---');
    // =========================================================================
    const burnEstimatedId = randomUUID();
    await clientA.from('timeline_events').insert({
      id: burnEstimatedId,
      user_id: userAId,
      source_module: 'nutrition',
      event_type: 'manual_calorie_burn',
      occurred_at: nowIso,
      local_date: localDate,
      event_timezone: 'UTC',
      energy_kcal: -300,
      source: 'manual',
    });
    const burnEstimatedNoConsent = await clientA.from('manual_calorie_burn_logs').insert({
      timeline_event_id: burnEstimatedId,
      user_id: userAId,
      label: 'Yoga',
      energy_source: 'estimated',
    });
    check(
      'manual_calorie_burn_logs: energy_source=estimated WITHOUT active health consent is REJECTED (CONSENT_REQUIRED_HEALTH)',
      !!burnEstimatedNoConsent.error,
      burnEstimatedNoConsent.error?.message
    );

    const grantConsent = await clientA.from('user_consents').insert({
      user_id: userAId,
      category: 'health',
      purpose_version: 'verify-nutrition-schema-v1',
    });
    check('user_consents: granting health consent succeeds', !grantConsent.error, grantConsent.error?.message);

    const burnEstimatedWithConsent = await clientA.from('manual_calorie_burn_logs').insert({
      timeline_event_id: burnEstimatedId,
      user_id: userAId,
      label: 'Yoga',
      energy_source: 'estimated',
    });
    check('manual_calorie_burn_logs: energy_source=estimated WITH active health consent succeeds', !burnEstimatedWithConsent.error, burnEstimatedWithConsent.error?.message);

    // user_entered on user B, who has NO health consent at all -> must succeed (never gated).
    const burnUserEnteredId = randomUUID();
    await clientB.from('timeline_events').insert({
      id: burnUserEnteredId,
      user_id: userBId,
      source_module: 'nutrition',
      event_type: 'manual_calorie_burn',
      occurred_at: nowIso,
      local_date: localDate,
      event_timezone: 'UTC',
      energy_kcal: -180,
      source: 'manual',
    });
    const burnUserEntered = await clientB.from('manual_calorie_burn_logs').insert({
      timeline_event_id: burnUserEnteredId,
      user_id: userBId,
      label: 'Tennis',
      energy_source: 'user_entered',
    });
    check('manual_calorie_burn_logs: energy_source=user_entered is NEVER gated (no consent needed)', !burnUserEntered.error, burnUserEntered.error?.message);

    const aReadBBurn = await clientA.from('manual_calorie_burn_logs').select('timeline_event_id').eq('timeline_event_id', burnUserEnteredId);
    check("manual_calorie_burn_logs: user A cannot see user B's manual burn", (aReadBBurn.data ?? []).length === 0, aReadBBurn.data);

    // =========================================================================
    console.log('\n--- Case 8: saved_meals + saved_meal_items (real DELETE on items, not on meals) ---');
    // =========================================================================
    const savedMealId = randomUUID();
    const insSavedMeal = await clientA.from('saved_meals').insert({
      id: savedMealId,
      user_id: userAId,
      name: 'Verification Breakfast',
      meal_type: 'breakfast',
    });
    check('saved_meals: insert succeeds', !insSavedMeal.error, insSavedMeal.error?.message);

    const savedItemId = randomUUID();
    const insSavedItem = await clientA.from('saved_meal_items').insert({
      id: savedItemId,
      saved_meal_id: savedMealId,
      user_id: userAId,
      food_id: CHICKEN_BREAST_ID,
      serving_label: '100 g',
      serving_g_or_ml: 100,
      quantity: 1,
      sort_order: 0,
    });
    check('saved_meal_items: insert succeeds', !insSavedItem.error, insSavedItem.error?.message);

    const bReadSavedMeal = await clientB.from('saved_meals').select('id').eq('id', savedMealId);
    check("saved_meals: user B cannot see user A's saved meal", (bReadSavedMeal.data ?? []).length === 0, bReadSavedMeal.data);

    const deleteSavedItem = await clientA.from('saved_meal_items').delete().eq('id', savedItemId);
    check('saved_meal_items: real client DELETE succeeds (the deliberate exception)', !deleteSavedItem.error, deleteSavedItem.error?.message);
    const verifyItemGone = await clientA.from('saved_meal_items').select('id').eq('id', savedItemId);
    check('saved_meal_items: item is actually gone after DELETE', (verifyItemGone.data ?? []).length === 0, verifyItemGone.data);

    const deleteSavedMeal = await clientA.from('saved_meals').delete().eq('id', savedMealId);
    check('saved_meals: client DELETE is REJECTED (no DELETE grant/policy -- soft-delete only)', !!deleteSavedMeal.error, deleteSavedMeal);
  } finally {
    console.log('\nCleaning up disposable test users...');
    await admin.auth.admin.deleteUser(userAId);
    await admin.auth.admin.deleteUser(userBId);
  }

  console.log(`\n${failures === 0 ? 'ALL CHECKS PASSED' : `${failures} CHECK(S) FAILED`}`);
  process.exit(failures === 0 ? 0 : 1);
}

main().catch((err) => {
  console.error('FAIL: uncaught error:', err);
  process.exit(1);
});
